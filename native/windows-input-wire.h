#pragma once
#include <array>
#include <cstddef>
#include <cstdint>
#include <cmath>
#include <cstring>
#include <atomic>
#include <algorithm>
#include "windows-input-command.h"

namespace inputwire {
constexpr uint32_t magic = 0x31494c4e;
constexpr uint64_t leaseMs = 4000;
enum class Op : uint32_t { hello = 1, configure, heartbeat, input, release, shutdown };
enum class Kind : uint32_t { move = 1, button, wheel, key, text, paste };
struct Packet {
  uint32_t signature = magic, version = 1;
  uint64_t sequence = 0;
  Op op{};
  Kind kind{};
  int32_t x = 0, y = 0, button = 0;
  uint32_t down = 0, enabled = 0;
  double dx = 0, dy = 0;
  char authority[193]{}, nonce[65]{}, code[41]{};
  uint32_t textBytes = 0;
  char text[16384]{};
};
constexpr DWORD headerBytes = static_cast<DWORD>(offsetof(Packet, text));
struct Reply {
  uint32_t signature = magic, version = 1;
  uint64_t sequence = 0;
  NativeInputOutcome result = NativeInputOutcome::rejected;
  uint32_t diagnostic = 0;
};
inline bool validPacket(const Packet& p, size_t bytes, uint64_t previous) {
  return bytes >= headerBytes && bytes <= sizeof(Packet) &&
    p.signature == magic && p.version == 1 && p.sequence == previous + 1 &&
    p.textBytes <= sizeof(p.text) && bytes == headerBytes + p.textBytes &&
    std::memchr(p.authority, 0, sizeof(p.authority)) &&
    std::memchr(p.nonce, 0, sizeof(p.nonce)) &&
    std::memchr(p.code, 0, sizeof(p.code)) &&
    std::isfinite(p.dx) && std::isfinite(p.dy) &&
    std::abs(p.dx) <= 2000 && std::abs(p.dy) <= 2000 &&
    p.down <= 1 && p.enabled <= 1 && p.button >= 0 && p.button <= 2 &&
    p.op >= Op::hello && p.op <= Op::shutdown;
}
inline bool decode(const Packet& p, NativeInputCommand& command) {
  switch(p.kind) {
    case Kind::move: command.type="move"; break;
    case Kind::button: command.type="button"; break;
    case Kind::wheel: command.type="wheel"; break;
    case Kind::key: command.type="key"; break;
    case Kind::text: command.type="text"; break;
    case Kind::paste: command.type="paste"; break;
    default: return false;
  }
  command.screenX=p.x; command.screenY=p.y; command.button=p.button;
  command.down=p.down!=0; command.dx=p.dx; command.dy=p.dy;
  command.code=p.code; command.text.assign(p.text,p.textBytes);
  return true;
}
// Both peers use bounded overlapped I/O. A stopped broker cannot keep the
// elevated component waiting inside a blocking read past its input lease.
inline bool dispatchMessages() {
  MSG message{};
  for(unsigned i=0;i<64&&PeekMessageW(&message,nullptr,0,0,PM_REMOVE);++i) {
    if(message.message==WM_QUIT)return false;
    TranslateMessage(&message);DispatchMessageW(&message);
  }
  return true;
}
inline bool io(HANDLE pipe, bool writing, void* data, DWORD bytes,
               DWORD& transferred, DWORD timeout = 250, const std::atomic<bool>* cancel=nullptr,
               bool pumpMessages=false) {
  OVERLAPPED overlap{};
  overlap.hEvent=CreateEventW(nullptr,TRUE,FALSE,nullptr);
  if(!overlap.hEvent) return false;
  BOOL ok=writing ? WriteFile(pipe,data,bytes,&transferred,&overlap) :
                    ReadFile(pipe,data,bytes,&transferred,&overlap);
  DWORD error=ok ? ERROR_SUCCESS : GetLastError();
  if(ok){ok=GetOverlappedResult(pipe,&overlap,&transferred,FALSE);error=ok?0:GetLastError();}
  if(!ok && error==ERROR_IO_PENDING) {
    const auto deadline=GetTickCount64()+timeout;DWORD wait=WAIT_TIMEOUT;
    do {
      if(cancel&&cancel->load()){wait=WAIT_FAILED;break;}
      const DWORD slice=DWORD(std::min<uint64_t>(100,deadline>GetTickCount64()?deadline-GetTickCount64():0));
      wait=pumpMessages?MsgWaitForMultipleObjectsEx(1,&overlap.hEvent,slice,QS_ALLINPUT,MWMO_INPUTAVAILABLE):
        WaitForSingleObject(overlap.hEvent,slice);
      if(pumpMessages&&wait==WAIT_OBJECT_0+1) {
        // The elevated component displayed local consent on this thread. Keep
        // its queue responsive even while no remote packets are arriving.
        wait=dispatchMessages()?WAIT_TIMEOUT:WAIT_FAILED;
      }
    }while(wait==WAIT_TIMEOUT&&GetTickCount64()<deadline);
    if(wait==WAIT_OBJECT_0) {ok=GetOverlappedResult(pipe,&overlap,&transferred,FALSE);error=ok?0:GetLastError();}
    else {
      CancelIoEx(pipe,&overlap);
      // Completion can win the cancellation race. Those bytes have already
      // left the pipe: reporting a timeout here would silently discard a packet.
      ok=GetOverlappedResult(pipe,&overlap,&transferred,TRUE);
      error=ok?ERROR_SUCCESS:(wait==WAIT_TIMEOUT?WAIT_TIMEOUT:ERROR_OPERATION_ABORTED);
    }
  }
  CloseHandle(overlap.hEvent); SetLastError(error); return ok!=FALSE;
}
}
