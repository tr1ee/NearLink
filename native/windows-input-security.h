#pragma once
#include <windows.h>
#include <sddl.h>
#include <aclapi.h>
#include <bcrypt.h>
#include <wtsapi32.h>
#include <shlobj.h>
#include <vector>
#include <string>
#include <array>

namespace inputsecurity {
struct Handle {
  HANDLE value=INVALID_HANDLE_VALUE;
  Handle()=default;
  explicit Handle(HANDLE h):value(h){}
  ~Handle(){reset();}
  Handle(const Handle&)=delete;
  Handle& operator=(const Handle&)=delete;
  void reset(HANDLE h=INVALID_HANDLE_VALUE){if(value && value!=INVALID_HANDLE_VALUE)CloseHandle(value);value=h;}
  explicit operator bool() const{return value && value!=INVALID_HANDLE_VALUE;}
};
inline std::vector<BYTE> tokenInfo(HANDLE process,TOKEN_INFORMATION_CLASS kind) {
  HANDLE raw=nullptr; if(!OpenProcessToken(process,TOKEN_QUERY,&raw))return {};
  Handle token(raw);DWORD bytes=0;
  GetTokenInformation(token.value,kind,nullptr,0,&bytes);
  std::vector<BYTE> result(bytes);
  if(!bytes||!GetTokenInformation(token.value,kind,result.data(),bytes,&bytes))return {};
  return result;
}
inline DWORD integrity(HANDLE process=GetCurrentProcess()) {
  auto info=tokenInfo(process,TokenIntegrityLevel);if(info.empty())return 0;
  auto sid=reinterpret_cast<TOKEN_MANDATORY_LABEL*>(info.data())->Label.Sid;
  const auto count=*GetSidSubAuthorityCount(sid);
  return count?*GetSidSubAuthority(sid,count-1):0;
}
inline std::wstring sidText(PSID sid) {
  LPWSTR value=nullptr;if(!ConvertSidToStringSidW(sid,&value))return {};
  std::wstring result(value);LocalFree(value);return result;
}
inline std::wstring userSid(HANDLE process=GetCurrentProcess()) {
  auto info=tokenInfo(process,TokenUser);if(info.empty())return {};
  return sidText(reinterpret_cast<TOKEN_USER*>(info.data())->User.Sid);
}
inline uint64_t creationTime(HANDLE process) {
  FILETIME created{},exit{},kernel{},user{};
  if(!GetProcessTimes(process,&created,&exit,&kernel,&user))return 0;
  return (uint64_t(created.dwHighDateTime)<<32)|created.dwLowDateTime;
}
inline bool sameInteractivePrincipal(HANDLE broker,DWORD brokerPid) {
  DWORD ownSession=0,otherSession=0;
  if(!ProcessIdToSessionId(GetCurrentProcessId(),&ownSession)||
     !ProcessIdToSessionId(brokerPid,&otherSession)||ownSession!=otherSession||
     ownSession!=WTSGetActiveConsoleSessionId())return false;
  const auto own=userSid(),other=userSid(broker);
  if(own.empty()||own!=other)return false;
  auto a=tokenInfo(GetCurrentProcess(),TokenStatistics),b=tokenInfo(broker,TokenStatistics);
  if(a.empty()||b.empty())return false;
  auto id=reinterpret_cast<TOKEN_STATISTICS*>(b.data())->AuthenticationId;
  auto ownId=reinterpret_cast<TOKEN_STATISTICS*>(a.data())->AuthenticationId;
  if(id.LowPart==ownId.LowPart && id.HighPart==ownId.HighPart)return true;
  // UAC split tokens can have different logon IDs. Only the OS-provided linked
  // token is accepted, never a logon identifier from a protocol message.
  auto linked=tokenInfo(GetCurrentProcess(),TokenLinkedToken);
  if(linked.empty())return false;
  Handle token(reinterpret_cast<TOKEN_LINKED_TOKEN*>(linked.data())->LinkedToken);
  TOKEN_STATISTICS statistics{};DWORD bytes=sizeof(statistics);
  return GetTokenInformation(token.value,TokenStatistics,&statistics,bytes,&bytes)&&
    id.LowPart==statistics.AuthenticationId.LowPart && id.HighPart==statistics.AuthenticationId.HighPart;
}
inline bool desktopAllowed() {
  DWORD session=0;
  if(!ProcessIdToSessionId(GetCurrentProcessId(),&session)||session!=WTSGetActiveConsoleSessionId())return false;
  LPWSTR data=nullptr;DWORD bytes=0;
  if(!WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE,session,WTSConnectState,&data,&bytes))return false;
  const bool connected=bytes>=sizeof(WTS_CONNECTSTATE_CLASS)&&*reinterpret_cast<WTS_CONNECTSTATE_CLASS*>(data)==WTSActive;
  WTSFreeMemory(data);if(!connected)return false;
  HDESK desktop=OpenInputDesktop(0,FALSE,DESKTOP_READOBJECTS);
  if(!desktop)return false;
  wchar_t name[128]{};DWORD needed=0;
  const bool allowed=GetUserObjectInformationW(desktop,UOI_NAME,name,sizeof(name),&needed)&&_wcsicmp(name,L"Default")==0;
  CloseDesktop(desktop);return allowed;
}
inline bool windowAllowed(HWND window) {
  DWORD pid=0,session=0,ownSession=0;
  if(!window||!GetWindowThreadProcessId(window,&pid)||!pid||
     !ProcessIdToSessionId(pid,&session)||!ProcessIdToSessionId(GetCurrentProcessId(),&ownSession)||session!=ownSession)return false;
  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,pid));
  const auto owner=process?userSid(process.value):L"";
  return !owner.empty()&&owner==userSid();
}
inline bool trustedSid(PSID sid) {
  const auto text=sidText(sid);
  return text==L"S-1-5-18"||text==L"S-1-5-32-544"||
    text==L"S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
}
inline bool protectedObject(const std::wstring& path) {
  const DWORD attrs=GetFileAttributesW(path.c_str());
  if(attrs==INVALID_FILE_ATTRIBUTES||(attrs&FILE_ATTRIBUTE_REPARSE_POINT))return false;
  PSECURITY_DESCRIPTOR descriptor=nullptr;PSID owner=nullptr;PACL acl=nullptr;
  if(GetNamedSecurityInfoW(path.c_str(),SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION,
       &owner,nullptr,&acl,nullptr,&descriptor)!=ERROR_SUCCESS)return false;
  bool safe=owner&&trustedSid(owner)&&acl;
  constexpr DWORD writes=GENERIC_ALL|GENERIC_WRITE|WRITE_DAC|WRITE_OWNER|DELETE|
    FILE_WRITE_DATA|FILE_APPEND_DATA|FILE_WRITE_EA|FILE_WRITE_ATTRIBUTES|FILE_DELETE_CHILD;
  if(acl)for(DWORD i=0;i<acl->AceCount&&safe;++i) {
    void* raw=nullptr;if(!GetAce(acl,i,&raw)){safe=false;break;}
    auto header=reinterpret_cast<ACE_HEADER*>(raw);
    if(header->AceFlags&INHERIT_ONLY_ACE)continue;
    if(header->AceType==ACCESS_DENIED_ACE_TYPE)continue;
    if(header->AceType!=ACCESS_ALLOWED_ACE_TYPE){safe=false;break;}
    auto ace=reinterpret_cast<ACCESS_ALLOWED_ACE*>(raw);
    if((ace->Mask&writes)&&!trustedSid(&ace->SidStart))safe=false;
  }
  LocalFree(descriptor);return safe;
}
inline std::string sha256(HANDLE file) {
  BCRYPT_ALG_HANDLE algorithm=nullptr;BCRYPT_HASH_HANDLE hash=nullptr;
  DWORD size=0,received=0;std::string result;
  if(BCryptOpenAlgorithmProvider(&algorithm,BCRYPT_SHA256_ALGORITHM,nullptr,0)<0)return {};
  if(BCryptGetProperty(algorithm,BCRYPT_OBJECT_LENGTH,reinterpret_cast<PUCHAR>(&size),sizeof(size),&received,0)>=0) {
    std::vector<BYTE> object(size);std::array<BYTE,32> digest{};std::array<BYTE,65536> block{};
    if(BCryptCreateHash(algorithm,&hash,object.data(),size,nullptr,0,0)>=0) {
      bool ok=true;LARGE_INTEGER zero{};SetFilePointerEx(file,zero,nullptr,FILE_BEGIN);
      while(ok){DWORD read=0;if(!ReadFile(file,block.data(),DWORD(block.size()),&read,nullptr)){ok=false;break;}if(!read)break;ok=BCryptHashData(hash,block.data(),read,0)>=0;}
      if(ok&&BCryptFinishHash(hash,digest.data(),DWORD(digest.size()),0)>=0) {
        constexpr char hex[]="0123456789abcdef";for(auto b:digest){result+=hex[b>>4];result+=hex[b&15];}
      }
      BCryptDestroyHash(hash);
    }
  }
  BCryptCloseAlgorithmProvider(algorithm,0);return result;
}
inline bool hexDigest(const std::string& value) {
  if(value.size()!=64)return false;
  for(char c:value)if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')))return false;
  return true;
}
inline std::string randomHex() {
  std::array<BYTE,32> data{};
  if(BCryptGenRandom(nullptr,data.data(),DWORD(data.size()),BCRYPT_USE_SYSTEM_PREFERRED_RNG)<0)return {};
  std::string result;constexpr char hex[]="0123456789abcdef";
  for(auto b:data){result+=hex[b>>4];result+=hex[b&15];}return result;
}
inline std::wstring widen(const std::string& value) {return std::wstring(value.begin(),value.end());}
inline bool authorityValid(const std::string& value) {
  if(value.empty()||value.size()>192)return false;
  for(char c:value)if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')||c=='-'||c==':'))return false;
  return true;
}
}
