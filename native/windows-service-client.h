#pragma once
#include "windows-service-wire.h"

class DesktopServiceClient {
  inputsecurity::Handle pipe_;
  std::string authority_;
  uint64_t sequence_=0;
  desktopservice::Response last_;
  bool engaged_=false;
  desktopservice::Request packet(desktopservice::Operation op) {
    desktopservice::Request p;p.operation=op;memcpy(p.authority,authority_.data(),authority_.size());return p;
  }
  bool request(desktopservice::Request& p) {
    p.sequence=++sequence_;DWORD bytes=0;desktopservice::Response reply;
    if(!pipe_||!inputwire::io(pipe_.value,true,&p,sizeof(p),bytes,1000)||bytes!=sizeof(p)||
      !inputwire::io(pipe_.value,false,&reply,sizeof(reply),bytes,2000)||bytes!=sizeof(reply)||
      reply.signature!=desktopservice::magic||reply.protocol!=desktopservice::version||reply.sequence!=p.sequence||
      !memchr(reply.challenge,0,sizeof(reply.challenge))||!wmemchr(reply.mapping,0,ARRAYSIZE(reply.mapping))||
      reply.result>NativeInputOutcome::trayDragStart)return false;
    last_=reply;return true;
  }
 public:
  bool engaged() const{return engaged_;}
  DWORD pid() const{return engaged_?last_.agentPid:0;}
  const wchar_t* mapping() const{return engaged_?last_.mapping:L"";}
  std::string begin(const std::string& authority,bool control) {
    if(!inputsecurity::authorityValid(authority)||engaged_)return {};
    pipe_.reset(CreateFileW(desktopservice::pipeName,GENERIC_READ|GENERIC_WRITE,0,nullptr,OPEN_EXISTING,
      FILE_FLAG_OVERLAPPED|SECURITY_SQOS_PRESENT|SECURITY_IDENTIFICATION,nullptr));
    DWORD mode=PIPE_READMODE_MESSAGE;ULONG pid=0;
    if(!pipe_||!SetNamedPipeHandleState(pipe_.value,&mode,nullptr,nullptr)||!GetNamedPipeServerProcessId(pipe_.value,&pid))return {};
    inputsecurity::Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,pid));
    wchar_t self[32768]{},server[32768]{};DWORD size=ARRAYSIZE(server);
    if(!process||!desktopservice::isSystem(process.value)||!GetModuleFileNameW(nullptr,self,ARRAYSIZE(self))||
      !QueryFullProcessImageNameW(process.value,0,server,&size))return {};
    std::wstring directory=self;directory=directory.substr(0,directory.find_last_of(L'\\'));
    directory=directory.substr(0,directory.find_last_of(L'\\'));
    const auto expected=directory+L"\\NearLinkService.exe";
    if(_wcsicmp(expected.c_str(),server)||!inputsecurity::protectedObject(directory)||!inputsecurity::protectedObject(expected))return {};
    authority_=authority;sequence_=0;auto hello=packet(desktopservice::Operation::hello);
    hello.enabled=control;if(!request(hello)||last_.result!=NativeInputOutcome::applied)return {};
    return last_.challenge;
  }
  bool authenticate(const std::string& certificate,const std::string& proof) {
    if(certificate.size()>8192||proof.size()!=128)return false;
    auto p=packet(desktopservice::Operation::authenticate);memcpy(p.certificate,certificate.data(),certificate.size());memcpy(p.proof,proof.data(),proof.size());
    engaged_=request(p)&&last_.result==NativeInputOutcome::applied&&last_.agentPid&&wcslen(last_.mapping)>20;
    if(!engaged_)pipe_.reset();return engaged_;
  }
  bool configure(bool enabled,int x,int y,int width,int height) {
    auto p=packet(desktopservice::Operation::configure);p.enabled=enabled;p.left=x;p.top=y;p.width=width;p.height=height;
    return engaged_&&request(p)&&last_.result==NativeInputOutcome::applied;
  }
  bool heartbeat() {auto p=packet(desktopservice::Operation::heartbeat);return engaged_&&request(p)&&last_.result==NativeInputOutcome::applied;}
  NativeInputOutcome input(const NativeInputCommand& command) {
    auto p=packet(command.type=="release"?desktopservice::Operation::release:desktopservice::Operation::input);
    auto& input=p.input;input.sequence=1;input.op=inputwire::Op::input;
    memcpy(input.authority,authority_.data(),authority_.size());
    if(command.type=="move")input.kind=inputwire::Kind::move;
    else if(command.type=="button")input.kind=inputwire::Kind::button;
    else if(command.type=="wheel")input.kind=inputwire::Kind::wheel;
    else if(command.type=="key")input.kind=inputwire::Kind::key;
    else if(command.type=="text")input.kind=inputwire::Kind::text;
    else if(command.type=="paste")input.kind=inputwire::Kind::paste;
    else if(command.type!="release")return NativeInputOutcome::rejected;
    if(command.code.size()>=sizeof(input.code)||command.text.size()>sizeof(input.text))return NativeInputOutcome::rejected;
    input.x=command.screenX;input.y=command.screenY;input.button=command.button;input.down=command.down;
    input.dx=command.dx;input.dy=command.dy;memcpy(input.code,command.code.data(),command.code.size());
    input.textBytes=DWORD(command.text.size());memcpy(input.text,command.text.data(),input.textBytes);
    p.desktopEpoch=command.desktopEpoch;
    return engaged_&&request(p)?last_.result:NativeInputOutcome::rejected;
  }
  bool stop() {
    bool ok=true;
    if(engaged_){auto p=packet(desktopservice::Operation::shutdown);ok=request(p)&&last_.result==NativeInputOutcome::applied;}
    pipe_.reset();if(!ok)return false;
    engaged_=false;authority_.clear();last_={};return true;
  }
};
static DesktopServiceClient desktopServiceClient;
static napi_value BeginDesktopService(napi_env env,napi_callback_info info) {
  size_t count=1;napi_value args[1];napi_get_cb_info(env,info,&count,args,nullptr,nullptr);
  if(!count||!release())return Undefined(env);
  const auto challenge=desktopServiceClient.begin(Str(env,args[0],"authority"),Bool(env,args[0],"allowed"));
  if(challenge.empty())return Undefined(env);napi_value result;napi_create_string_utf8(env,challenge.c_str(),challenge.size(),&result);return result;
}
static napi_value AuthenticateDesktopService(napi_env env,napi_callback_info info) {
  size_t count=1;napi_value args[1];napi_get_cb_info(env,info,&count,args,nullptr,nullptr);
  return JSBool(env,count&&desktopServiceClient.authenticate(Str(env,args[0],"certificate"),Str(env,args[0],"proof")));
}
static napi_value ConfigureDesktopService(napi_env env,napi_callback_info info) {
  size_t count=1;napi_value args[1];napi_get_cb_info(env,info,&count,args,nullptr,nullptr);if(!count)return JSBool(env,false);
  const auto v=args[0];return JSBool(env,desktopServiceClient.configure(Bool(env,v,"allowed"),int(Num(env,v,"x")),int(Num(env,v,"y")),int(Num(env,v,"width")),int(Num(env,v,"height"))));
}
static napi_value HeartbeatDesktopService(napi_env env,napi_callback_info) {return JSBool(env,desktopServiceClient.heartbeat());}
static napi_value StopDesktopService(napi_env env,napi_callback_info) {return JSBool(env,desktopServiceClient.stop());}
static napi_value DesktopServiceStatus(napi_env env,napi_callback_info) {
  napi_value result,mapping;napi_create_object(env,&result);
  SetNum(env,result,"pid",desktopServiceClient.pid());
  napi_create_string_utf16(env,reinterpret_cast<const char16_t*>(desktopServiceClient.mapping()),NAPI_AUTO_LENGTH,&mapping);
  napi_set_named_property(env,result,"mapping",mapping);return result;
}
