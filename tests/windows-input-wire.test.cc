#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include "../native/windows-input-security.h"
#include "../native/windows-input-wire.h"
#include <cassert>
#include <limits>
#include <cstdio>
#include <thread>

static std::atomic<HWND> waitingWindow{nullptr};
static std::atomic<unsigned> handledMessages{0};
static LRESULT CALLBACK testWindow(HWND window,UINT message,WPARAM w,LPARAM l) {
  if(message==WM_APP+1){++handledMessages;return 123;}
  return DefWindowProcW(window,message,w,l);
}

static void overlappedRoundTrips() {
  const auto name=L"\\\\.\\pipe\\NearLinkWireTest-"+inputsecurity::widen(inputsecurity::randomHex());
  inputsecurity::Handle server(CreateNamedPipeW(name.c_str(),PIPE_ACCESS_DUPLEX|FILE_FLAG_OVERLAPPED|FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_TYPE_MESSAGE|PIPE_READMODE_MESSAGE|PIPE_REJECT_REMOTE_CLIENTS,1,65536,65536,0,nullptr));
  assert(server);
  std::thread client([&]{
    WNDCLASSW windowClass{};windowClass.lpfnWndProc=testWindow;
    windowClass.hInstance=GetModuleHandleW(nullptr);windowClass.lpszClassName=L"NearLinkWireWaitTest";
    assert(RegisterClassW(&windowClass));
    const auto window=CreateWindowExW(0,windowClass.lpszClassName,L"",0,0,0,0,0,HWND_MESSAGE,nullptr,windowClass.hInstance,nullptr);
    assert(window);waitingWindow=window;
    inputsecurity::Handle pipe(CreateFileW(name.c_str(),GENERIC_READ|GENERIC_WRITE,0,nullptr,OPEN_EXISTING,FILE_FLAG_OVERLAPPED|SECURITY_SQOS_PRESENT|SECURITY_IDENTIFICATION,nullptr));
    assert(pipe);DWORD mode=PIPE_READMODE_MESSAGE;assert(SetNamedPipeHandleState(pipe.value,&mode,nullptr,nullptr));
    for(uint64_t i=1;i<=512;++i){
      inputwire::Packet p;DWORD count=0;
      bool received=false;
      do { received=inputwire::io(pipe.value,false,&p,sizeof(p),count,2,nullptr,true); }
      while(!received&&GetLastError()==WAIT_TIMEOUT);
      assert(received);
      assert(inputwire::validPacket(p,count,i-1));
      if(i%2)Sleep(2);
      inputwire::Reply reply;reply.sequence=i;reply.result=NativeInputOutcome::applied;
      assert(inputwire::io(pipe.value,true,&reply,sizeof(reply),count,2000));assert(count==sizeof(reply));
    }
    DestroyWindow(window);
  });
  OVERLAPPED connect{};connect.hEvent=CreateEventW(nullptr,TRUE,FALSE,nullptr);
  if(!ConnectNamedPipe(server.value,&connect)){
    const auto error=GetLastError();assert(error==ERROR_IO_PENDING||error==ERROR_PIPE_CONNECTED);
    if(error==ERROR_IO_PENDING){assert(WaitForSingleObject(connect.hEvent,2000)==WAIT_OBJECT_0);DWORD count=0;assert(GetOverlappedResult(server.value,&connect,&count,FALSE));}
  }
  CloseHandle(connect.hEvent);
  while(!waitingWindow.load())Sleep(1);
  DWORD_PTR result=0;
  assert(SendMessageTimeoutW(waitingWindow,WM_APP+1,0,0,SMTO_ABORTIFHUNG,1000,&result));
  assert(result==123&&handledMessages==1); // Dispatch while a pipe read is pending.
  for(uint64_t i=1;i<=512;++i){
    Sleep(DWORD(i%3+1));
    inputwire::Packet p;p.op=inputwire::Op::heartbeat;p.sequence=i;DWORD count=0;
    assert(inputwire::io(server.value,true,&p,inputwire::headerBytes,count,2000));assert(count==inputwire::headerBytes);
    inputwire::Reply reply;assert(inputwire::io(server.value,false,&reply,sizeof(reply),count,2000));
    assert(count==sizeof(reply)&&reply.sequence==i&&reply.result==NativeInputOutcome::applied);
  }
  client.join();
}

int wmain(int argc,wchar_t** argv) {
  overlappedRoundTrips();
  using namespace inputwire;
  Packet valid;valid.sequence=1;valid.op=Op::input;valid.kind=Kind::move;
  assert(validPacket(valid,headerBytes,0));
  assert(!validPacket(valid,headerBytes,1)); // replay
  assert(!validPacket(valid,headerBytes-1,0));
  assert(!validPacket(valid,sizeof(valid)+1,0));
  auto changed=valid;changed.textBytes=sizeof(changed.text)+1;
  assert(!validPacket(changed,sizeof(changed),0));
  changed=valid;changed.down=2;assert(!validPacket(changed,headerBytes,0));
  changed=valid;changed.button=-1;assert(!validPacket(changed,headerBytes,0));
  changed=valid;changed.dx=std::numeric_limits<double>::quiet_NaN();assert(!validPacket(changed,headerBytes,0));
  changed=valid;changed.dy=2001;assert(!validPacket(changed,headerBytes,0));
  changed=valid;changed.op=static_cast<Op>(99);assert(!validPacket(changed,headerBytes,0));
  changed=valid;memset(changed.authority,'a',sizeof(changed.authority));assert(!validPacket(changed,headerBytes,0));
  changed=valid;memset(changed.code,'a',sizeof(changed.code));assert(!validPacket(changed,headerBytes,0));
  changed=valid;changed.kind=static_cast<Kind>(99);NativeInputCommand command;assert(!decode(changed,command));
  assert(!inputsecurity::authorityValid(""));
  assert(!inputsecurity::authorityValid("a:b\ncommand"));
  assert(!inputsecurity::hexDigest(std::string(64,'z')));
  if(argc==2) {
    assert(inputsecurity::protectedObject(argv[1]));
    inputsecurity::Handle image(CreateFileW(argv[1],GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,0,nullptr));
    assert(image&&inputsecurity::sha256(image.value).size()==64);
  }
  std::puts("Input protocol rejection, protected-image and digest checks passed; no input injected.");
}
