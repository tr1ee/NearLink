#pragma once
#include "windows-service-wire.h"
#include <thread>
#include <atomic>
#include <mutex>
#include "windows-desktop-epoch.h"

namespace desktopservice {
struct AgentState {
  std::atomic<bool> stopped{false},granted{false},control{false};
  std::atomic<uint64_t> heartbeat{0};
  DesktopEpoch epoch;
  std::mutex layoutMutex;
  RECT layout{};
  FrameHeader* frame=nullptr;
};
inline bool activeSession(DWORD session) {
  if(session!=WTSGetActiveConsoleSessionId())return false;
  LPWSTR data=nullptr;DWORD size=0;
  if(!WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE,session,WTSConnectState,&data,&size))return false;
  bool ok=size>=sizeof(WTS_CONNECTSTATE_CLASS)&&*reinterpret_cast<WTS_CONNECTSTATE_CLASS*>(data)==WTSActive;
  WTSFreeMemory(data);return ok;
}
inline bool displayRectangle(const RECT& r) {
  if(r.right<=r.left||r.bottom<=r.top||uint64_t(r.right-r.left)*(r.bottom-r.top)>maxPixels)return false;
  struct Check {RECT r;bool found=false;} check{r};
  EnumDisplayMonitors(nullptr,nullptr,[](HMONITOR,HDC,LPRECT rect,LPARAM p)->BOOL {
    auto& check=*reinterpret_cast<Check*>(p);
    if(EqualRect(rect,&check.r))check.found=true;return TRUE;
  },reinterpret_cast<LPARAM>(&check));return check.found;
}
// Each desktop gets a fresh capture thread. GDI resources never migrate between
// desktops, and the input thread never waits on a screen readback.
inline void captureDesktop(AgentState& state,const std::wstring& desktop,DWORD session) {
  HDESK originalDesktop=GetThreadDesktop(GetCurrentThreadId());
  HDESK target=OpenDesktopW(desktop.c_str(),0,FALSE,DESKTOP_READOBJECTS|DESKTOP_WRITEOBJECTS);
  if(!target)return;
  if(!SetThreadDesktop(target)){CloseDesktop(target);return;}
  HDC screen=nullptr,canvas=nullptr;HBITMAP bitmap=nullptr;HGDIOBJ original=nullptr;void* pixels=nullptr;
  RECT selected{};bool initialized=false;
  auto clear=[&]{if(original&&canvas)SelectObject(canvas,original);if(bitmap)DeleteObject(bitmap);if(canvas)DeleteDC(canvas);if(screen)ReleaseDC(nullptr,screen);screen=canvas=nullptr;bitmap=nullptr;original=nullptr;pixels=nullptr;};
  const uint32_t epoch=state.epoch.observe(desktop);
  while(!state.stopped&&state.granted&&state.epoch.matches(epoch)&&activeSession(session)&&activeDesktop()==desktop&&
        GetTickCount64()-state.heartbeat.load()<=inputwire::leaseMs) {
    RECT layout;{std::lock_guard<std::mutex> guard(state.layoutMutex);layout=state.layout;}
    if(!displayRectangle(layout)){Sleep(20);continue;}
    if(!initialized||!EqualRect(&layout,&selected)) {
      if(initialized)break; // Recreate with a new epoch, invalidating queued input.
      selected=layout;screen=GetDC(nullptr);canvas=CreateCompatibleDC(screen);
      BITMAPINFO info{};info.bmiHeader.biSize=sizeof(BITMAPINFOHEADER);
      info.bmiHeader.biWidth=layout.right-layout.left;info.bmiHeader.biHeight=layout.top-layout.bottom;
      info.bmiHeader.biPlanes=1;info.bmiHeader.biBitCount=32;info.bmiHeader.biCompression=BI_RGB;
      bitmap=CreateDIBSection(canvas,&info,DIB_RGB_COLORS,&pixels,nullptr,0);
      if(!screen||!canvas||!bitmap)break;original=SelectObject(canvas,bitmap);initialized=true;
    }
    const int width=selected.right-selected.left,height=selected.bottom-selected.top;
    if(BitBlt(canvas,0,0,width,height,screen,selected.left,selected.top,SRCCOPY|CAPTUREBLT)) {
      CURSORINFO cursor{sizeof(cursor)};
      if(GetCursorInfo(&cursor)&&(cursor.flags&CURSOR_SHOWING)) {
        ICONINFO shape{};if(GetIconInfo(cursor.hCursor,&shape)) {
          DrawIconEx(canvas,cursor.ptScreenPos.x-selected.left-LONG(shape.xHotspot),
            cursor.ptScreenPos.y-selected.top-LONG(shape.yHotspot),cursor.hCursor,0,0,0,nullptr,DI_NORMAL);
          if(shape.hbmMask)DeleteObject(shape.hbmMask);if(shape.hbmColor)DeleteObject(shape.hbmColor);
        }
      }
      GdiFlush();auto header=state.frame;
      InterlockedIncrement(&header->generation);
      header->signature=magic;header->width=width;header->height=height;header->bytes=width*height*4;
      header->desktopEpoch=epoch;header->timestamp=GetTickCount64();header->secure=_wcsicmp(desktop.c_str(),L"Winlogon")==0;
      memcpy(reinterpret_cast<BYTE*>(header)+sizeof(FrameHeader),pixels,header->bytes);
      MemoryBarrier();InterlockedIncrement(&header->generation);
    }
    Sleep(16);
  }
  clear();SetThreadDesktop(originalDesktop);CloseDesktop(target);
}
inline int runAgent(const std::wstring& pipeName,DWORD servicePid,uint64_t created,
                    const std::string& nonce,const std::wstring& mappingName) {
  if(!isSystem(GetCurrentProcess())||!inputsecurity::hexDigest(nonce))return 20;
  DWORD session=0;ProcessIdToSessionId(GetCurrentProcessId(),&session);
  if(!session||!activeSession(session))return 21;
  inputsecurity::Handle owner(OpenProcess(SYNCHRONIZE|PROCESS_QUERY_LIMITED_INFORMATION,FALSE,servicePid));
  if(!owner||!isSystem(owner.value)||inputsecurity::creationTime(owner.value)!=created)return 22;
  inputsecurity::Handle pipe(CreateFileW(pipeName.c_str(),GENERIC_READ|GENERIC_WRITE,0,nullptr,OPEN_EXISTING,
    FILE_FLAG_OVERLAPPED|SECURITY_SQOS_PRESENT|SECURITY_IDENTIFICATION,nullptr));
  ULONG server=0;DWORD mode=PIPE_READMODE_MESSAGE;
  if(!pipe||!GetNamedPipeServerProcessId(pipe.value,&server)||server!=servicePid||
    !SetNamedPipeHandleState(pipe.value,&mode,nullptr,nullptr))return 23;
  inputsecurity::Handle mapping(OpenFileMappingW(FILE_MAP_WRITE,FALSE,mappingName.c_str()));
  AgentState state;state.frame=mapping?static_cast<FrameHeader*>(MapViewOfFile(mapping.value,FILE_MAP_WRITE,0,0,mappingBytes)):nullptr;
  if(!state.frame)return 24;
  std::thread capture([&]{while(!state.stopped){const auto desktop=activeDesktop();if(state.granted&&!desktop.empty()){std::thread worker([&]{captureDesktop(state,desktop,session);});worker.join();}else Sleep(20);}});
  initKeys();uint64_t sequence=0;std::string authority;std::wstring inputDesktop;
  HDESK inputHandle=nullptr;bool closed=false;
  while(!closed&&WaitForSingleObject(owner.value,0)==WAIT_TIMEOUT) {
    if(state.granted&&(!activeSession(session)||GetTickCount64()-state.heartbeat.load()>inputwire::leaseMs)) {
      state.control=false;state.granted=false;release();
    }
    Request request;DWORD count=0;
    if(!inputwire::io(pipe.value,false,&request,sizeof(request),count,100)) {
      if(GetLastError()==WAIT_TIMEOUT)continue;break;
    }
    if(count!=sizeof(request)||!valid(request,sequence))break;
    sequence=request.sequence;Response reply;reply.sequence=sequence;
    if(authority.empty())authority=request.authority;
    if(authority!=request.authority)break;
    const auto desktop=activeDesktop();state.epoch.observe(desktop);
    if(!desktop.empty()&&desktop!=inputDesktop) {
      HDESK next=OpenDesktopW(desktop.c_str(),0,FALSE,DESKTOP_READOBJECTS|DESKTOP_WRITEOBJECTS);
      if(next&&SetThreadDesktop(next)){release();if(inputHandle)CloseDesktop(inputHandle);inputHandle=next;inputDesktop=desktop;}
      else if(next)CloseDesktop(next);
    }
    const bool active=!desktop.empty()&&desktop==inputDesktop&&activeSession(session);
    if(request.operation==Operation::configure) {
      const int64_t right=int64_t(request.left)+request.width,bottom=int64_t(request.top)+request.height;
      RECT rectangle{request.left,request.top,LONG(right),LONG(bottom)};
      if(request.width>0&&request.height>0&&request.width<=8192&&request.height<=8192&&
        right<=LONG_MAX&&right>=LONG_MIN&&bottom<=LONG_MAX&&bottom>=LONG_MIN&&displayRectangle(rectangle)) {
        {std::lock_guard<std::mutex> guard(state.layoutMutex);if(!EqualRect(&state.layout,&rectangle))state.epoch.layoutChanged();state.layout=rectangle;}
        state.granted=true;state.control=request.enabled!=0;state.heartbeat=GetTickCount64();
        reply.result=NativeInputOutcome::applied;
      }
    } else if(request.operation==Operation::heartbeat&&state.granted) {
      state.heartbeat=GetTickCount64();reply.result=NativeInputOutcome::applied;
    } else if(request.operation==Operation::release||request.operation==Operation::shutdown) {
      if(active&&release())reply.result=NativeInputOutcome::applied;
      if(request.operation==Operation::shutdown){state.control=false;state.granted=false;closed=true;}
    } else if(request.operation==Operation::input&&state.granted&&state.control&&active&&
              state.epoch.matches(request.desktopEpoch)) {
      NativeInputCommand command;const auto& p=request.input;
      const bool validInput=inputwire::validPacket(p,inputwire::headerBytes+p.textBytes,p.sequence-1);
      if(validInput&&inputwire::decode(p,command)) {
        RECT layout;{std::lock_guard<std::mutex> guard(state.layoutMutex);layout=state.layout;}
        const bool point=command.type=="move"||command.type=="button";
        if(!point||PtInRect(&layout,{command.screenX,command.screenY}))reply.result=applyNativeInput(command);
      }
    }
    reply.desktopEpoch=state.epoch.current();reply.agentPid=GetCurrentProcessId();
    if(!inputwire::io(pipe.value,true,&reply,sizeof(reply),count)||count!=sizeof(reply))break;
    mouseLogSize=mouseLogDropped=0;
  }
  state.stopped=true;state.control=false;state.granted=false;
  bool released=release();for(int retry=0;!released&&retry<10;++retry){Sleep(20);released=release();}
  capture.join();InterlockedIncrement(&state.frame->generation);state.frame->width=state.frame->height=state.frame->bytes=0;
  MemoryBarrier();InterlockedIncrement(&state.frame->generation);
  UnmapViewOfFile(state.frame);if(inputHandle)CloseDesktop(inputHandle);return released?0:27;
}
}
