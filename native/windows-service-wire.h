#pragma once
#include "windows-input-security.h"
#include "windows-input-wire.h"
#include <algorithm>

namespace desktopservice {
constexpr uint32_t magic=0x32534c4e, version=1;
constexpr wchar_t pipeName[]=L"\\\\.\\pipe\\NearLinkDesktopService-v1";
constexpr wchar_t serviceName[]=L"NearLinkDesktopService";
constexpr uint32_t maxPixels=16*1024*1024;
constexpr size_t mappingBytes=64+size_t(maxPixels)*4;
enum class Operation:uint32_t {hello=1,authenticate,configure,heartbeat,input,release,shutdown};
struct Request {
  uint32_t signature=magic,protocol=version;
  uint64_t sequence=0;
  Operation operation{};
  uint32_t desktopEpoch=0;
  int32_t left=0,top=0,width=0,height=0;
  uint32_t enabled=0;
  char authority[193]{},certificate[8193]{},proof[129]{};
  inputwire::Packet input;
};
struct Response {
  uint32_t signature=magic,protocol=version;
  uint64_t sequence=0;
  NativeInputOutcome result=NativeInputOutcome::rejected;
  uint32_t desktopEpoch=0,agentPid=0;
  char challenge[512]{};
  wchar_t mapping[128]{};
};
struct alignas(8) FrameHeader {
  volatile LONG generation=0;
  uint32_t signature=magic,width=0,height=0,bytes=0,desktopEpoch=0;
  uint64_t timestamp=0;
  uint32_t secure=0,reserved[7]{};
};
static_assert(sizeof(FrameHeader)==64);
inline bool valid(const Request& r,uint64_t previous) {
  return r.signature==magic&&r.protocol==version&&r.sequence==previous+1&&
    r.operation>=Operation::hello&&r.operation<=Operation::shutdown&&r.enabled<=1&&
    memchr(r.authority,0,sizeof(r.authority))&&memchr(r.certificate,0,sizeof(r.certificate))&&
    memchr(r.proof,0,sizeof(r.proof))&&inputsecurity::authorityValid(r.authority);
}
inline bool frameValid(const FrameHeader& h) {
  return h.signature==magic&&h.width>0&&h.height>0&&h.width<=8192&&h.height<=8192&&
    uint64_t(h.width)*h.height<=maxPixels&&h.bytes==uint64_t(h.width)*h.height*4&&h.desktopEpoch>0;
}
inline std::vector<BYTE> unhex(const std::string& s,size_t max) {
  if(s.empty()||s.size()%2||s.size()>max*2)return {};
  auto nibble=[](char c)->int{return c>='0'&&c<='9'?c-'0':c>='a'&&c<='f'?c-'a'+10:-1;};
  std::vector<BYTE> bytes(s.size()/2);
  for(size_t i=0;i<bytes.size();++i){int a=nibble(s[i*2]),b=nibble(s[i*2+1]);if(a<0||b<0)return {};bytes[i]=BYTE((a<<4)|b);}
  return bytes;
}
inline bool isSystem(HANDLE process) {return inputsecurity::userSid(process)==L"S-1-5-18";}
inline std::wstring activeDesktop() {
  HDESK desktop=OpenInputDesktop(0,FALSE,DESKTOP_READOBJECTS|DESKTOP_WRITEOBJECTS);
  if(!desktop)return {};
  wchar_t name[128]{};DWORD needed=0;
  bool ok=GetUserObjectInformationW(desktop,UOI_NAME,name,sizeof(name),&needed)!=FALSE;
  CloseDesktop(desktop);
  if(!ok||(_wcsicmp(name,L"Default")&&_wcsicmp(name,L"Winlogon")))return {};
  return name;
}
}
