// Development acceptance component. This native executable has no JavaScript
// engine, network listener, arbitrary command, file-transfer or clipboard API.
#define NEARLINK_STANDALONE_INPUT
#include "windows.cc"
#include "windows-input-security.h"
#include "windows-input-wire.h"
#include <shellapi.h>
#include <atomic>
#include <thread>

int WINAPI wWinMain(HINSTANCE,HINSTANCE,PWSTR,int) {
  SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32);
  SetProcessDPIAware();
  int argc=0;LPWSTR* argv=CommandLineToArgvW(GetCommandLineW(),&argc);
  if(!argv||argc!=6)return 2;
  const std::wstring pipeName=argv[1];
  const DWORD brokerPid=wcstoul(argv[2],nullptr,10);
  const uint64_t created=_wcstoui64(argv[3],nullptr,10);
  const std::wstring nonceWide=argv[4],authorityWide=argv[5];LocalFree(argv);
  std::string nonce,authority;
  for(wchar_t c:nonceWide){if(c>127)return 2;nonce+=static_cast<char>(c);}
  for(wchar_t c:authorityWide){if(c>127)return 2;authority+=static_cast<char>(c);}
  if(!inputsecurity::hexDigest(nonce)||!inputsecurity::authorityValid(authority)||
     pipeName!=L"\\\\.\\pipe\\NearLinkInput-"+nonceWide||inputsecurity::integrity()!=SECURITY_MANDATORY_HIGH_RID)return 3;
  inputsecurity::Handle broker(OpenProcess(SYNCHRONIZE|PROCESS_QUERY_LIMITED_INFORMATION,FALSE,brokerPid));
  if(!broker||!created||inputsecurity::creationTime(broker.value)!=created||
     inputsecurity::integrity(broker.value)!=SECURITY_MANDATORY_MEDIUM_RID||
     !inputsecurity::sameInteractivePrincipal(broker.value,brokerPid)||!inputsecurity::desktopAllowed())return 4;
  inputsecurity::Handle pipe;
  for(int retry=0;retry<100&&!pipe;++retry) {
    pipe.reset(CreateFileW(pipeName.c_str(),GENERIC_READ|GENERIC_WRITE,0,nullptr,OPEN_EXISTING,FILE_FLAG_OVERLAPPED|SECURITY_SQOS_PRESENT|SECURITY_IDENTIFICATION,nullptr));
    if(!pipe)Sleep(20);
  }
  ULONG server=0;DWORD mode=PIPE_READMODE_MESSAGE;
  if(!pipe||!GetNamedPipeServerProcessId(pipe.value,&server)||server!=brokerPid||
     !SetNamedPipeHandleState(pipe.value,&mode,nullptr,nullptr))return 5;
  inputwire::Packet first;DWORD bytes=0;
  if(!inputwire::io(pipe.value,false,&first,sizeof(first),bytes,5000)||
     !inputwire::validPacket(first,bytes,0)||first.op!=inputwire::Op::hello||
     first.authority!=authority||first.nonce!=nonce)return 6;
  // Before the first input, approval runs at High. The Medium input path cannot
  // confirm this dialog. A vanished broker/pipe cancels even while it is open.
  std::atomic<bool> approvalDone{false};
  std::thread watcher([&]{while(!approvalDone){DWORD available=0;if(WaitForSingleObject(broker.value,0)!=WAIT_TIMEOUT||!PeekNamedPipe(pipe.value,nullptr,0,nullptr,&available,nullptr))ExitProcess(7);Sleep(50);}});
  const auto colon=authorityWide.find(L':');
  const auto fingerprint=colon==std::wstring::npos?L"":authorityWide.substr(colon+1,64);
  const auto prompt=L"允许此已配对远控会话控制本机普通及管理员应用？\n\n对端指纹：\n"+fingerprint+
    L"\n\n仅当前用户的普通桌面；断线或结束会话后撤销。安全桌面和登录界面不受控制。";
  const int approval=MessageBoxW(nullptr,prompt.c_str(),L"NearLink · 本机高权限输入授权",MB_YESNO|MB_DEFBUTTON2|MB_ICONWARNING|MB_TOPMOST);
  approvalDone=true;watcher.join();
  inputwire::Reply reply;reply.sequence=1;
  reply.result=approval==IDYES&&inputsecurity::desktopAllowed()?NativeInputOutcome::applied:NativeInputOutcome::rejected;
  DWORD sent=0;if(!inputwire::io(pipe.value,true,&reply,sizeof(reply),sent)||reply.result!=NativeInputOutcome::applied)return 8;
  initKeys();
  uint64_t sequence=1,heartbeat=0;bool enabled=false,pendingCleanup=false,closed=false;
  const auto clean=[&]{if(!inputsecurity::desktopAllowed())return false;return release();};
  int left=0,top=0,width=0,height=0;
  uint32_t diagnostic=0;
  while(true) {
    if(!inputwire::dispatchMessages()){closed=true;enabled=false;pendingCleanup=true;}
    const auto now=GetTickCount64();
    if(WaitForSingleObject(broker.value,0)!=WAIT_TIMEOUT)closed=true;
    if(enabled&&(now-heartbeat>inputwire::leaseMs||!inputsecurity::desktopAllowed()||
       left!=GetSystemMetrics(SM_XVIRTUALSCREEN)||top!=GetSystemMetrics(SM_YVIRTUALSCREEN)||
       width!=GetSystemMetrics(SM_CXVIRTUALSCREEN)||height!=GetSystemMetrics(SM_CYVIRTUALSCREEN))) {
      enabled=false;pendingCleanup=true;
    }
    if(pendingCleanup&&clean())pendingCleanup=false;
    if(closed){if(!pendingCleanup&&clean())break;Sleep(50);continue;}
    inputwire::Packet p;bytes=0;
    if(!inputwire::io(pipe.value,false,&p,sizeof(p),bytes,100,nullptr,true)) {
      if(GetLastError()==WAIT_TIMEOUT)continue;
      closed=true;enabled=false;pendingCleanup=true;continue;
    }
    if(!inputwire::validPacket(p,bytes,sequence)||p.authority!=authority){closed=true;enabled=false;pendingCleanup=true;continue;}
    sequence=p.sequence;reply.sequence=sequence;reply.result=NativeInputOutcome::rejected;
    if(p.op==inputwire::Op::configure) {
      enabled=false;pendingCleanup=!clean();
      if(!pendingCleanup) {
        enabled=p.enabled!=0;heartbeat=GetTickCount64();
        left=GetSystemMetrics(SM_XVIRTUALSCREEN);top=GetSystemMetrics(SM_YVIRTUALSCREEN);
        width=GetSystemMetrics(SM_CXVIRTUALSCREEN);height=GetSystemMetrics(SM_CYVIRTUALSCREEN);
        reply.result=NativeInputOutcome::applied;
      }
    } else if(p.op==inputwire::Op::heartbeat) {
      if(enabled&&!pendingCleanup&&inputsecurity::desktopAllowed()){heartbeat=GetTickCount64();reply.result=NativeInputOutcome::applied;}
    } else if(p.op==inputwire::Op::release||p.op==inputwire::Op::shutdown) {
      pendingCleanup=!clean();if(!pendingCleanup)reply.result=NativeInputOutcome::applied;
      if(p.op==inputwire::Op::shutdown){enabled=false;closed=true;}
    } else if(p.op==inputwire::Op::input&&enabled&&!pendingCleanup&&inputsecurity::desktopAllowed()) {
      diagnostic=1;lastNativeRequested=lastNativeQueued=lastNativeError=0;
      NativeInputCommand command;
      if(inputwire::decode(p,command)) {
        const bool point=command.type=="move"||command.type=="button";
        const bool position=!point||(command.screenX>=left&&command.screenY>=top&&int64_t(command.screenX)<int64_t(left)+width&&int64_t(command.screenY)<int64_t(top)+height);
        const bool foreground=inputsecurity::windowAllowed(GetForegroundWindow());
        const bool pointer=!point||inputsecurity::windowAllowed(WindowFromPoint({command.screenX,command.screenY}));
        const bool target=foreground&&pointer;
        const bool text=command.type!="text"||command.text.empty()||
          (MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,command.text.data(),int(command.text.size()),nullptr,0)>0&&
           MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,command.text.data(),int(command.text.size()),nullptr,0)<=4096);
        diagnostic|=(foreground?2:0)|(pointer?4:0)|(position?8:0)|(text?16:0);
        if(position&&target&&text) {
          diagnostic|=32;
          reply.result=applyNativeInput(command);
        }
      }
      diagnostic|=(lastNativeRequested&15)<<8|(lastNativeQueued&15)<<12|(lastNativeError&65535)<<16;
    }
    reply.diagnostic=diagnostic;
    if(!inputwire::io(pipe.value,true,&reply,sizeof(reply),sent,250,nullptr,true)||sent!=sizeof(reply)){closed=true;enabled=false;pendingCleanup=true;}
    mouseLogSize=mouseLogDropped=0;
  }
  return 0;
}
