#pragma once
#include <shellapi.h>
#include "windows-input-security.h"
#include "windows-input-wire.h"

class InputHelperBridge {
  inputsecurity::Handle pipe_, process_, image_;
  std::string authority_;
  uint64_t sequence_=0;
  uint32_t diagnostic_=0;
  bool engaged_=false;
  std::string failure_;
  std::atomic<bool> cancelled_{false};
  inputwire::Packet packet(inputwire::Op op) {
    inputwire::Packet p;p.op=op;
    memcpy(p.authority,authority_.data(),authority_.size());return p;
  }
  NativeInputOutcome request(inputwire::Packet& p,DWORD timeout=250) {
    if(!pipe_||!process_||WaitForSingleObject(process_.value,0)!=WAIT_TIMEOUT)return NativeInputOutcome::rejected;
    p.sequence=++sequence_;DWORD count=0;
    if(!inputwire::io(pipe_.value,true,&p,inputwire::headerBytes+p.textBytes,count,timeout)||count!=inputwire::headerBytes+p.textBytes){failure_="pipe-write-"+std::to_string(GetLastError());pipe_.reset();return NativeInputOutcome::rejected;}
    inputwire::Reply response;
    if(!inputwire::io(pipe_.value,false,&response,sizeof(response),count,timeout,timeout>1000?&cancelled_:nullptr)||count!=sizeof(response)||
       response.signature!=inputwire::magic||response.version!=1||response.sequence!=p.sequence||
       response.result>NativeInputOutcome::trayDragStart){failure_="pipe-reply-"+std::to_string(GetLastError());pipe_.reset();return NativeInputOutcome::rejected;}
    diagnostic_=response.diagnostic;return response.result;
  }
 public:
  bool engaged() const{return engaged_;}
  void cancel(){cancelled_=true;}
  void prepare(){cancelled_=false;}
  DWORD pid() const{return process_&&WaitForSingleObject(process_.value,0)==WAIT_TIMEOUT?GetProcessId(process_.value):0;}
  const std::string& failure() const{return failure_;}
  uint32_t diagnostic() const{return diagnostic_;}
  bool start(const std::wstring& path,const std::string& digest,const std::string& authority) {
    failure_="protected-image-check";
    if(engaged_||!inputsecurity::hexDigest(digest)||!inputsecurity::authorityValid(authority))return false;
    PWSTR programFiles=nullptr;
    if(FAILED(SHGetKnownFolderPath(FOLDERID_ProgramFiles,0,nullptr,&programFiles)))return false;
    std::wstring root(programFiles);CoTaskMemFree(programFiles);
    const auto debug=root+L"\\NearLink-Input-Debug";
    const auto directory=debug+L"\\"+inputsecurity::widen(digest);
    const auto expected=directory+L"\\NearLinkInput.exe";
    if(_wcsicmp(path.c_str(),expected.c_str())||!inputsecurity::protectedObject(root)||
       !inputsecurity::protectedObject(debug)||
       !inputsecurity::protectedObject(directory)||!inputsecurity::protectedObject(path))return false;
    image_.reset(CreateFileW(path.c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
    if(!image_||inputsecurity::sha256(image_.value)!=digest){image_.reset();return false;}
    const auto sid=inputsecurity::userSid();const auto nonce=inputsecurity::randomHex();
    if(sid.empty()||nonce.empty()){image_.reset();return false;}
    const std::wstring name=L"\\\\.\\pipe\\NearLinkInput-"+inputsecurity::widen(nonce);
    const auto sddl=L"D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;"+sid+L")";
    PSECURITY_DESCRIPTOR descriptor=nullptr;
    if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(),SDDL_REVISION_1,&descriptor,nullptr))return false;
    SECURITY_ATTRIBUTES security{sizeof(security),descriptor,FALSE};
    pipe_.reset(CreateNamedPipeW(name.c_str(),PIPE_ACCESS_DUPLEX|FILE_FLAG_OVERLAPPED|FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_MESSAGE|PIPE_READMODE_MESSAGE|PIPE_WAIT|PIPE_REJECT_REMOTE_CLIENTS,1,sizeof(inputwire::Packet),sizeof(inputwire::Packet),0,&security));
    LocalFree(descriptor);if(!pipe_){image_.reset();return false;}
    failure_="local-uac-launch";
    const uint64_t created=inputsecurity::creationTime(GetCurrentProcess());
    const auto arguments=L"\""+name+L"\" "+std::to_wstring(GetCurrentProcessId())+L" "+std::to_wstring(created)+
      L" "+inputsecurity::widen(nonce)+L" "+inputsecurity::widen(authority);
    SHELLEXECUTEINFOW launch{sizeof(launch)};
    launch.fMask=SEE_MASK_NOCLOSEPROCESS|SEE_MASK_NOASYNC|SEE_MASK_FLAG_NO_UI;
    launch.lpVerb=L"runas";launch.lpFile=path.c_str();launch.lpParameters=arguments.c_str();
    launch.lpDirectory=directory.c_str();launch.nShow=SW_HIDE;
    if(!ShellExecuteExW(&launch)||!launch.hProcess){pipe_.reset();image_.reset();return false;}
    process_.reset(launch.hProcess);
    if(cancelled_){pipe_.reset();process_.reset();image_.reset();return false;}
    OVERLAPPED connect{};connect.hEvent=CreateEventW(nullptr,TRUE,FALSE,nullptr);
    const BOOL connected=ConnectNamedPipe(pipe_.value,&connect);
    const DWORD error=connected?0:GetLastError();bool ready=connected||error==ERROR_PIPE_CONNECTED;
    if(!ready&&error==ERROR_IO_PENDING){HANDLE waits[]={connect.hEvent,process_.value};const auto deadline=GetTickCount64()+30000;while(!cancelled_&&GetTickCount64()<deadline){const auto wait=WaitForMultipleObjects(2,waits,FALSE,100);if(wait!=WAIT_TIMEOUT){ready=wait==WAIT_OBJECT_0;break;}}}
    if(!ready){CancelIoEx(pipe_.value,&connect);DWORD ignored=0;GetOverlappedResult(pipe_.value,&connect,&ignored,TRUE);}
    CloseHandle(connect.hEvent);
    failure_="peer-process-check";
    ULONG client=0;ULONG session=0;DWORD ownSession=0;
    ready=ready&&GetNamedPipeClientProcessId(pipe_.value,&client)&&client==GetProcessId(process_.value)&&
      GetNamedPipeClientSessionId(pipe_.value,&session)&&ProcessIdToSessionId(GetCurrentProcessId(),&ownSession)&&session==ownSession;
    if(!ready){DWORD code=STILL_ACTIVE;GetExitCodeProcess(process_.value,&code);failure_="peer-process-check-"+std::to_string(code);pipe_.reset();process_.reset();image_.reset();return false;}
    authority_=authority;sequence_=0;
    auto hello=packet(inputwire::Op::hello);memcpy(hello.nonce,nonce.data(),nonce.size());
    if(request(hello,120000)!=NativeInputOutcome::applied){DWORD code=STILL_ACTIVE;GetExitCodeProcess(process_.value,&code);failure_="local-approval-"+std::to_string(code);pipe_.reset();process_.reset();image_.reset();authority_.clear();return false;}
    failure_.clear();engaged_=true;return true;
  }
  bool configure(bool allowed,const std::string& authority) {
    if(!engaged_)return !allowed;
    auto p=packet(inputwire::Op::configure);p.enabled=allowed&&authority==authority_;
    return request(p)==NativeInputOutcome::applied;
  }
  bool heartbeat() {if(!engaged_)return true;auto p=packet(inputwire::Op::heartbeat);return request(p)==NativeInputOutcome::applied;}
  NativeInputOutcome input(const NativeInputCommand& command) {
    if(command.type=="release"&&process_&&WaitForSingleObject(process_.value,0)==WAIT_OBJECT_0&&stop())return NativeInputOutcome::applied;
    auto p=packet(command.type=="release"?inputwire::Op::release:inputwire::Op::input);
    if(command.type=="move")p.kind=inputwire::Kind::move;
    else if(command.type=="button")p.kind=inputwire::Kind::button;
    else if(command.type=="wheel")p.kind=inputwire::Kind::wheel;
    else if(command.type=="key")p.kind=inputwire::Kind::key;
    else if(command.type=="text")p.kind=inputwire::Kind::text;
    else if(command.type=="paste")p.kind=inputwire::Kind::paste;
    else if(command.type!="release")return NativeInputOutcome::rejected;
    if(command.code.size()>=sizeof(p.code)||command.text.size()>sizeof(p.text))return NativeInputOutcome::rejected;
    p.x=command.screenX;p.y=command.screenY;p.button=command.button;p.down=command.down;
    p.dx=command.dx;p.dy=command.dy;memcpy(p.code,command.code.data(),command.code.size());
    p.textBytes=static_cast<uint32_t>(command.text.size());memcpy(p.text,command.text.data(),p.textBytes);
    return request(p);
  }
  bool stop() {
    if(!engaged_){pipe_.reset();process_.reset();image_.reset();return true;}
    if(process_&&WaitForSingleObject(process_.value,0)==WAIT_OBJECT_0){DWORD code=1;if(GetExitCodeProcess(process_.value,&code)&&code==0){engaged_=false;pipe_.reset();process_.reset();image_.reset();authority_.clear();return true;}}
    auto p=packet(inputwire::Op::shutdown);
    // Do not fall back to Medium if the helper has not confirmed key cleanup.
    if(request(p)!=NativeInputOutcome::applied)return false;
    engaged_=false;pipe_.reset();process_.reset();image_.reset();authority_.clear();return true;
  }
};
// An in-progress UAC call runs on a Node async worker. Process exit closes all
// handles in the OS; no static destructor races that worker during teardown.
static auto& helperBridge=*new InputHelperBridge();
static std::atomic<bool> helperStarting{false};
static inputsecurity::Handle inputOwner;
struct HelperStartTask {napi_async_work work{};napi_deferred deferred{};std::wstring path;std::string digest,authority;bool ready=false;};
static napi_value StartInputHelper(napi_env env,napi_callback_info info) {
  size_t argc=1;napi_value args[1];napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);
  if(!argc||!release())return JSBool(env,false);
  const auto path=Str(env,args[0],"path"),digest=Str(env,args[0],"sha256"),authority=Str(env,args[0],"authority");
  const int size=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,path.data(),int(path.size()),nullptr,0);
  if(!size)return JSBool(env,false);std::wstring wide(size,L'\0');MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,path.data(),int(path.size()),wide.data(),size);
  if(helperStarting.exchange(true))return JSBool(env,false);
  helperBridge.prepare();auto task=new HelperStartTask();task->path=wide;task->digest=digest;task->authority=authority;
  napi_value promise,name;napi_create_promise(env,&task->deferred,&promise);
  napi_create_string_utf8(env,"NearLink local input approval",NAPI_AUTO_LENGTH,&name);
  auto execute=[](napi_env,void* data){auto task=static_cast<HelperStartTask*>(data);try{task->ready=helperBridge.start(task->path,task->digest,task->authority);}catch(...){task->ready=false;}};
  auto complete=[](napi_env env,napi_status,void* data){auto task=static_cast<HelperStartTask*>(data);helperStarting=false;napi_resolve_deferred(env,task->deferred,JSBool(env,task->ready));napi_delete_async_work(env,task->work);delete task;};
  if(napi_create_async_work(env,nullptr,name,execute,complete,task,&task->work)!=napi_ok||napi_queue_async_work(env,task->work)!=napi_ok){helperStarting=false;delete task;return JSBool(env,false);}
  return promise;
}
static napi_value ConfigureInputHelper(napi_env env,napi_callback_info info) {
  size_t argc=1;napi_value args[1];napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);
  return JSBool(env,argc&&helperBridge.configure(Bool(env,args[0],"allowed"),Str(env,args[0],"authority")));
}
static napi_value HeartbeatInputHelper(napi_env env,napi_callback_info) {return JSBool(env,helperBridge.heartbeat());}
static napi_value StopInputHelper(napi_env env,napi_callback_info) {return JSBool(env,helperBridge.stop());}
static napi_value CancelInputHelper(napi_env env,napi_callback_info) {helperBridge.cancel();return Undefined(env);}
static napi_value InputHelperPid(napi_env env,napi_callback_info) {napi_value value;napi_create_double(env,helperBridge.pid(),&value);return value;}
static napi_value InputHelperFailure(napi_env env,napi_callback_info) {napi_value value;const auto& failure=helperBridge.failure();napi_create_string_utf8(env,failure.c_str(),failure.size(),&value);return value;}
static napi_value WatchInputOwner(napi_env env,napi_callback_info info) {
  size_t argc=1;napi_value args[1];napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);double pid=0;
  if(!argc||napi_get_value_double(env,args[0],&pid)!=napi_ok||pid<=0||pid>0xffffffff)return JSBool(env,false);
  inputOwner.reset(OpenProcess(SYNCHRONIZE|PROCESS_QUERY_LIMITED_INFORMATION,FALSE,DWORD(pid)));
  return JSBool(env,bool(inputOwner));
}
static napi_value InputOwnerAlive(napi_env env,napi_callback_info) {return JSBool(env,inputOwner&&WaitForSingleObject(inputOwner.value,0)==WAIT_TIMEOUT);}
static napi_value InputHelperDiagnostics(napi_env env,napi_callback_info) {
  const auto d=helperBridge.diagnostic();napi_value value;napi_create_object(env,&value);
  SetNum(env,value,"flags",d&255);SetNum(env,value,"requested",(d>>8)&15);
  SetNum(env,value,"queued",(d>>12)&15);SetNum(env,value,"systemError",d>>16);return value;
}
