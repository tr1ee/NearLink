#define NEARLINK_STANDALONE_INPUT
#include "windows.cc"
#include "windows-service-auth.h"
#include "windows-desktop-agent.h"
#include <shellapi.h>
#include <fstream>
#include <sstream>
#include <userenv.h>
#include <tlhelp32.h>

namespace desktopservice {
SERVICE_STATUS_HANDLE statusHandle=nullptr;
SERVICE_STATUS status{};
inputsecurity::Handle stopEvent;
inputsecurity::Handle clientApp;
std::wstring imagePath,root,userSid;
std::wstring profile;
std::string hostFingerprint,clientDigest;
std::vector<std::string> peers;
bool cleanupConfirmed=true;

inline void serviceStatus(DWORD state,DWORD error=0) {
  status.dwServiceType=SERVICE_WIN32_OWN_PROCESS;status.dwCurrentState=state;
  status.dwControlsAccepted=state==SERVICE_RUNNING?SERVICE_ACCEPT_STOP|SERVICE_ACCEPT_SHUTDOWN:0;
  status.dwWin32ExitCode=error;status.dwWaitHint=state==SERVICE_STOP_PENDING?5000:0;
  if(statusHandle)SetServiceStatus(statusHandle,&status);
}
DWORD WINAPI control(DWORD code,DWORD,LPVOID,LPVOID) {
  if(code==SERVICE_CONTROL_STOP||code==SERVICE_CONTROL_SHUTDOWN){serviceStatus(SERVICE_STOP_PENDING);SetEvent(stopEvent.value);}
  return NO_ERROR;
}
bool stopped(){return WaitForSingleObject(stopEvent.value,0)!=WAIT_TIMEOUT;}
bool enablePrivilege(const wchar_t* name) {
  HANDLE raw=nullptr;if(!OpenProcessToken(GetCurrentProcess(),TOKEN_ADJUST_PRIVILEGES|TOKEN_QUERY,&raw))return false;
  inputsecurity::Handle token(raw);TOKEN_PRIVILEGES privilege{};privilege.PrivilegeCount=1;
  if(!LookupPrivilegeValueW(nullptr,name,&privilege.Privileges[0].Luid))return false;
  privilege.Privileges[0].Attributes=SE_PRIVILEGE_ENABLED;SetLastError(0);
  return AdjustTokenPrivileges(token.value,FALSE,&privilege,sizeof(privilege),nullptr,nullptr)&&GetLastError()==ERROR_SUCCESS;
}
bool readConfiguration() {
  wchar_t path[32768]{};if(!GetModuleFileNameW(nullptr,path,ARRAYSIZE(path)))return false;
  imagePath=path;root=imagePath.substr(0,imagePath.find_last_of(L'\\'));
  const auto filename=root+L"\\service-policy.txt";
  if(!inputsecurity::protectedObject(root)||!inputsecurity::protectedObject(imagePath)||
     !inputsecurity::protectedObject(filename))return false;
  std::ifstream file(filename);std::string sid,allowed,profileUtf8;
  if(!std::getline(file,sid)||!std::getline(file,hostFingerprint)||!std::getline(file,clientDigest)||!std::getline(file,allowed)||!std::getline(file,profileUtf8))return false;
  for(auto s:{&sid,&hostFingerprint,&clientDigest,&allowed})if(!s->empty()&&s->back()=='\r')s->pop_back();
  userSid=inputsecurity::widen(sid);
  if(!profileUtf8.empty()&&profileUtf8.back()=='\r')profileUtf8.pop_back();
  const int length=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,profileUtf8.data(),int(profileUtf8.size()),nullptr,0);
  if(length<3||length>30000)return false;profile.resize(length);
  MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,profileUtf8.data(),int(profileUtf8.size()),profile.data(),length);
  if(profile[1]!=L':'||profile.find(L'"')!=std::wstring::npos||profile.find(L'\n')!=std::wstring::npos)return false;
  PSID parsed=nullptr;bool valid=ConvertStringSidToSidW(userSid.c_str(),&parsed)!=FALSE;if(parsed)LocalFree(parsed);
  if(!valid||userSid==L"S-1-5-18"||!inputsecurity::hexDigest(hostFingerprint)||!inputsecurity::hexDigest(clientDigest))return false;
  std::istringstream list(allowed);std::string peer;
  while(std::getline(list,peer,',')){if(!inputsecurity::hexDigest(peer)||peers.size()>=16)return false;peers.push_back(peer);}
  return !peers.empty();
}
HANDLE pipeWithAcl(const std::wstring& name,const std::wstring& acl) {
  PSECURITY_DESCRIPTOR descriptor=nullptr;
  if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(acl.c_str(),SDDL_REVISION_1,&descriptor,nullptr))return INVALID_HANDLE_VALUE;
  SECURITY_ATTRIBUTES security{sizeof(security),descriptor,FALSE};
  HANDLE pipe=CreateNamedPipeW(name.c_str(),PIPE_ACCESS_DUPLEX|FILE_FLAG_OVERLAPPED|FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_TYPE_MESSAGE|PIPE_READMODE_MESSAGE|PIPE_WAIT|PIPE_REJECT_REMOTE_CLIENTS,1,sizeof(Request),sizeof(Request),0,&security);
  LocalFree(descriptor);return pipe;
}
bool accept(HANDLE pipe,HANDLE child=nullptr,DWORD timeout=30000) {
  OVERLAPPED overlap{};overlap.hEvent=CreateEventW(nullptr,TRUE,FALSE,nullptr);if(!overlap.hEvent)return false;
  BOOL connected=ConnectNamedPipe(pipe,&overlap);DWORD error=connected?0:GetLastError();bool ok=connected||error==ERROR_PIPE_CONNECTED;
  if(!ok&&error==ERROR_IO_PENDING) {
    const auto deadline=GetTickCount64()+timeout;
    while(!stopped()&&GetTickCount64()<deadline&&(!child||WaitForSingleObject(child,0)==WAIT_TIMEOUT)) {
      if(WaitForSingleObject(overlap.hEvent,50)==WAIT_OBJECT_0){DWORD bytes=0;ok=GetOverlappedResult(pipe,&overlap,&bytes,FALSE)!=FALSE;break;}
    }
    if(!ok){CancelIoEx(pipe,&overlap);DWORD bytes=0;GetOverlappedResult(pipe,&overlap,&bytes,TRUE);}
  }
  CloseHandle(overlap.hEvent);return ok;
}
bool read(HANDLE pipe,Request& request,uint64_t sequence,DWORD timeout=100) {
  DWORD count=0;if(!inputwire::io(pipe,false,&request,sizeof(request),count,timeout))return false;
  if(count==sizeof(request)&&valid(request,sequence))return true;SetLastError(ERROR_INVALID_DATA);return false;
}
bool write(HANDLE pipe,Response& response) {DWORD count=0;return inputwire::io(pipe,true,&response,sizeof(response),count,500)&&count==sizeof(response);}
struct Agent {
  inputsecurity::Handle pipe,process,job,mapping;
  std::wstring mappingName;
  uint64_t sequence=0;
  std::string authority;
  NativeInputOutcome request(Request request,Response& response) {
    request.sequence=++sequence;DWORD count=0;
    if(!pipe||!inputwire::io(pipe.value,true,&request,sizeof(request),count,500)||count!=sizeof(request)||
      !inputwire::io(pipe.value,false,&response,sizeof(response),count,1000)||count!=sizeof(response)||
      response.signature!=magic||response.protocol!=version||response.sequence!=sequence)return NativeInputOutcome::rejected;
    return response.result;
  }
  bool start(DWORD session,const std::string& grant) {
    authority=grant;const auto nonce=inputsecurity::randomHex();
    const auto name=L"\\\\.\\pipe\\NearLinkAgent-"+inputsecurity::widen(nonce);
    mappingName=L"Global\\NearLinkFrame-"+inputsecurity::widen(nonce);
    pipe.reset(pipeWithAcl(name,L"D:P(A;;GA;;;SY)"));if(!pipe)return false;
    PSECURITY_DESCRIPTOR descriptor=nullptr;
    const auto acl=L"D:P(A;;GA;;;SY)(A;;GR;;;"+userSid+L")";
    if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(acl.c_str(),SDDL_REVISION_1,&descriptor,nullptr))return false;
    SECURITY_ATTRIBUTES security{sizeof(security),descriptor,FALSE};
    mapping.reset(CreateFileMappingW(INVALID_HANDLE_VALUE,&security,PAGE_READWRITE,0,DWORD(mappingBytes),mappingName.c_str()));
    const DWORD mappingError=GetLastError();LocalFree(descriptor);
    if(!mapping||mappingError==ERROR_ALREADY_EXISTS)return false;
    HANDLE raw=nullptr,primary=nullptr;
    if(!OpenProcessToken(GetCurrentProcess(),TOKEN_DUPLICATE|TOKEN_QUERY,&raw))return false;
    inputsecurity::Handle token(raw);
    if(!DuplicateTokenEx(token.value,TOKEN_ALL_ACCESS,nullptr,SecurityImpersonation,TokenPrimary,&primary))return false;
    inputsecurity::Handle sessionToken(primary);
    if(!SetTokenInformation(primary,TokenSessionId,&session,sizeof(session)))return false;
    std::wstring command=L"\""+imagePath+L"\" --agent \""+name+L"\" "+std::to_wstring(GetCurrentProcessId())+L" "+
      std::to_wstring(inputsecurity::creationTime(GetCurrentProcess()))+L" "+inputsecurity::widen(nonce)+L" \""+mappingName+L"\"";
    STARTUPINFOW startup{sizeof(startup)};wchar_t desktop[]=L"WinSta0\\Default";startup.lpDesktop=desktop;
    PROCESS_INFORMATION spawned{};
    const wchar_t environment[]=L"SystemRoot=C:\\Windows\0PATH=C:\\Windows\\System32\0\0";
    if(!CreateProcessAsUserW(primary,imagePath.c_str(),command.data(),nullptr,nullptr,FALSE,
      CREATE_SUSPENDED|CREATE_NO_WINDOW|CREATE_UNICODE_ENVIRONMENT,const_cast<wchar_t*>(environment),root.c_str(),&startup,&spawned))return false;
    process.reset(spawned.hProcess);inputsecurity::Handle thread(spawned.hThread);
    job.reset(CreateJobObjectW(nullptr,nullptr));JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if(!job||!SetInformationJobObject(job.value,JobObjectExtendedLimitInformation,&limits,sizeof(limits))||
      !AssignProcessToJobObject(job.value,process.value)){TerminateProcess(process.value,30);return false;}
    ResumeThread(thread.value);
    if(!accept(pipe.value,process.value,5000))return false;
    ULONG pid=0;return GetNamedPipeClientProcessId(pipe.value,&pid)&&pid==spawned.dwProcessId;
  }
  bool stop() {
    if(!process)return true;
    Request shutdown;shutdown.operation=Operation::shutdown;memcpy(shutdown.authority,authority.data(),authority.size());Response response;
    bool released=request(shutdown,response)==NativeInputOutcome::applied;
    pipe.reset();
    if(WaitForSingleObject(process.value,2000)==WAIT_OBJECT_0){DWORD code=1;GetExitCodeProcess(process.value,&code);released=released||code==0;}
    return released;
  }
};
bool clientAllowed(HANDLE pipe,DWORD& session,inputsecurity::Handle& process) {
  ULONG pid=0;if(!GetNamedPipeClientProcessId(pipe,&pid)||!ProcessIdToSessionId(pid,&session)||
     !session||session!=WTSGetActiveConsoleSessionId())return false;
  process.reset(OpenProcess(SYNCHRONIZE|PROCESS_QUERY_LIMITED_INFORMATION,FALSE,pid));
  if(!process||inputsecurity::userSid(process.value)!=userSid||inputsecurity::integrity(process.value)!=SECURITY_MANDATORY_MEDIUM_RID)return false;
  if(!clientApp||WaitForSingleObject(clientApp.value,0)!=WAIT_TIMEOUT)return false;
  inputsecurity::Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS,0));
  PROCESSENTRY32W entry{sizeof(entry)};bool child=false;
  if(snapshot&&Process32FirstW(snapshot.value,&entry))do{if(entry.th32ProcessID==pid){child=entry.th32ParentProcessID==GetProcessId(clientApp.value);break;}}while(Process32NextW(snapshot.value,&entry));
  if(!child)return false;
  wchar_t filename[32768]{};DWORD size=ARRAYSIZE(filename);
  const auto expected=root+L"\\Client\\electron.exe";
  if(!QueryFullProcessImageNameW(process.value,0,filename,&size)||_wcsicmp(filename,expected.c_str())||
     !inputsecurity::protectedObject(root+L"\\Client")||!inputsecurity::protectedObject(expected))return false;
  inputsecurity::Handle image(CreateFileW(expected.c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
  return image&&inputsecurity::sha256(image.value)==clientDigest;
}
void startClient() {
  if(clientApp&&WaitForSingleObject(clientApp.value,0)==WAIT_TIMEOUT)return;
  const DWORD session=WTSGetActiveConsoleSessionId();if(!session||session==0xffffffff)return;
  HANDLE raw=nullptr;if(!WTSQueryUserToken(session,&raw))return;inputsecurity::Handle token(raw);
  DWORD size=0;GetTokenInformation(raw,TokenUser,nullptr,0,&size);std::vector<BYTE> info(size);
  if(!size||!GetTokenInformation(raw,TokenUser,info.data(),size,&size)||
    inputsecurity::sidText(reinterpret_cast<TOKEN_USER*>(info.data())->User.Sid)!=userSid)return;
  void* environmentRaw=nullptr;if(!CreateEnvironmentBlock(&environmentRaw,raw,FALSE))return;
  std::vector<wchar_t> environment;
  for(auto p=static_cast<const wchar_t*>(environmentRaw);*p;p+=wcslen(p)+1) {
    std::wstring variable=p;auto key=variable.substr(0,variable.find(L'='));
    for(auto& c:key)c=towupper(c);
    const std::vector<std::wstring> allowed={L"SYSTEMROOT",L"WINDIR",L"LOCALAPPDATA",L"APPDATA",L"USERPROFILE",L"TEMP",L"TMP",L"SYSTEMDRIVE",L"USERNAME",L"USERDOMAIN",L"COMPUTERNAME"};
    if(std::find(allowed.begin(),allowed.end(),key)!=allowed.end()){environment.insert(environment.end(),variable.begin(),variable.end());environment.push_back(0);}
  }
  DestroyEnvironmentBlock(environmentRaw);
  for(const auto& value:{L"PATH=C:\\Windows\\System32",L"NEARLINK_INSTALLED_SERVICE=1",L"NEARLINK_DEV_LAN=1",L"NEARLINK_DEV_ADMIN_INPUT=0"}) {
    environment.insert(environment.end(),value,value+wcslen(value));environment.push_back(0);
  }
  const auto data=L"NEARLINK_USER_DATA="+profile;environment.insert(environment.end(),data.begin(),data.end());environment.push_back(0);environment.push_back(0);
  const auto executable=root+L"\\Client\\electron.exe";
  std::wstring command=L"\""+executable+L"\" \""+root+L"\\Client\\app\" --background";
  STARTUPINFOW startup{sizeof(startup)};wchar_t desktop[]=L"WinSta0\\Default";startup.lpDesktop=desktop;
  PROCESS_INFORMATION spawned{};
  if(CreateProcessAsUserW(raw,executable.c_str(),command.data(),nullptr,nullptr,FALSE,
      CREATE_UNICODE_ENVIRONMENT,environment.data(),root.c_str(),&startup,&spawned)) {
    clientApp.reset(spawned.hProcess);CloseHandle(spawned.hThread);
  }
}
void serve(HANDLE pipe) {
  DWORD session=0;inputsecurity::Handle client;
  if(!cleanupConfirmed||!clientAllowed(pipe,session,client))return;
  Request hello;if(!read(pipe,hello,0,5000)||hello.operation!=Operation::hello)return;
  const std::string authority=hello.authority,peer=peerFromAuthority(authority);
  if(std::find(peers.begin(),peers.end(),peer)==peers.end())return;
  const auto challenge=challengeText(hostFingerprint,authority,session,inputsecurity::randomHex(),hello.enabled!=0);
  if(challenge.size()>=sizeof(Response::challenge))return;
  Response response;response.sequence=1;memcpy(response.challenge,challenge.data(),challenge.size());
  response.result=NativeInputOutcome::applied;if(!write(pipe,response))return;
  Request auth;if(!read(pipe,auth,1,15000)||auth.operation!=Operation::authenticate||auth.authority!=authority||
    !verifyProof(auth.certificate,auth.proof,peer,challenge))return;
  Agent agent;if(!agent.start(session,authority))return;
  response.sequence=2;response.agentPid=GetProcessId(agent.process.value);
  wcscpy_s(response.mapping,agent.mappingName.c_str());
  if(write(pipe,response)) {
    uint64_t sequence=2;
    while(!stopped()&&WaitForSingleObject(client.value,0)==WAIT_TIMEOUT&&session==WTSGetActiveConsoleSessionId()) {
      Request request;
      if(!read(pipe,request,sequence)){if(GetLastError()==WAIT_TIMEOUT)continue;break;}
      if(request.authority!=authority||request.operation<Operation::configure)break;
      if(!hello.enabled&&((request.operation==Operation::configure&&request.enabled)||request.operation==Operation::input))break;
      sequence=request.sequence;Response forwarded;agent.request(request,forwarded);
      forwarded.sequence=sequence;wcscpy_s(forwarded.mapping,agent.mappingName.c_str());
      if(!write(pipe,forwarded)||request.operation==Operation::shutdown)break;
    }
  }
  cleanupConfirmed=agent.stop();
}
void WINAPI serviceMain(DWORD,LPWSTR*) {
  stopEvent.reset(CreateEventW(nullptr,TRUE,FALSE,nullptr));
  statusHandle=RegisterServiceCtrlHandlerExW(serviceName,control,nullptr);if(!statusHandle)return;
  serviceStatus(SERVICE_START_PENDING);
  if(!isSystem(GetCurrentProcess())||!readConfiguration()||!enablePrivilege(SE_TCB_NAME)||
    !enablePrivilege(SE_ASSIGNPRIMARYTOKEN_NAME)||!enablePrivilege(SE_INCREASE_QUOTA_NAME)) {serviceStatus(SERVICE_STOPPED,ERROR_ACCESS_DENIED);return;}
  serviceStatus(SERVICE_RUNNING);
  const auto acl=L"D:P(A;;GA;;;SY)(A;;GRGW;;;"+userSid+L")S:(ML;;NW;;;ME)";
  while(!stopped()) {
    startClient();
    inputsecurity::Handle pipe(pipeWithAcl(pipeName,acl));
    if(!pipe){serviceStatus(SERVICE_STOPPED,GetLastError());return;}
    if(accept(pipe.value,nullptr,1000))serve(pipe.value);
    DisconnectNamedPipe(pipe.value);
  }
  serviceStatus(SERVICE_STOPPED);
}
}
int WINAPI wWinMain(HINSTANCE,HINSTANCE,PWSTR,int) {
  SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32);SetProcessDPIAware();
  int argc=0;LPWSTR* argv=CommandLineToArgvW(GetCommandLineW(),&argc);
  if(!argv)return 2;
  if(argc==7&&std::wstring(argv[1])==L"--agent") {
    std::wstring nonceWide=argv[5];std::string nonce;
    for(auto c:nonceWide){if(c>127)return 20;nonce+=static_cast<char>(c);}
    return desktopservice::runAgent(argv[2],wcstoul(argv[3],nullptr,10),_wcstoui64(argv[4],nullptr,10),nonce,argv[6]);
  }
  LocalFree(argv);SERVICE_TABLE_ENTRYW entries[]={{const_cast<LPWSTR>(desktopservice::serviceName),desktopservice::serviceMain},{nullptr,nullptr}};
  return StartServiceCtrlDispatcherW(entries)?0:int(GetLastError());
}
