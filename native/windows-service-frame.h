#pragma once
#include "windows-service-wire.h"
struct ServiceFrameReader {
  inputsecurity::Handle mapping;
  desktopservice::FrameHeader* view=nullptr;
  LONG previous=0;
  ~ServiceFrameReader(){if(view)UnmapViewOfFile(view);}
  bool open(const std::wstring& name) {
    const std::wstring prefix=L"Global\\NearLinkFrame-";
    if(name.size()!=prefix.size()+64||name.substr(0,prefix.size())!=prefix)return false;
    for(auto c:name.substr(prefix.size()))if(!((c>=L'0'&&c<=L'9')||(c>=L'a'&&c<=L'f')))return false;
    mapping.reset(OpenFileMappingW(FILE_MAP_READ,FALSE,name.c_str()));
    if(!mapping)return false;
    view=static_cast<desktopservice::FrameHeader*>(MapViewOfFile(mapping.value,FILE_MAP_READ,0,0,desktopservice::mappingBytes));
    return view!=nullptr;
  }
  napi_value read(napi_env env) {
    if(!view)return Undefined(env);
    for(int retry=0;retry<3;++retry) {
      const LONG generation=view->generation;
      if((generation&1)||!generation||generation==previous)return Undefined(env);
      MemoryBarrier();desktopservice::FrameHeader header;memcpy(&header,view,sizeof(header));
      if(!desktopservice::frameValid(header)||GetTickCount64()-header.timestamp>1500)return Undefined(env);
      napi_value bytes;void* data=nullptr;
      if(napi_create_arraybuffer(env,header.bytes,&data,&bytes)!=napi_ok)return Undefined(env);
      memcpy(data,reinterpret_cast<const BYTE*>(view)+sizeof(header),header.bytes);MemoryBarrier();
      if(generation!=view->generation)continue;
      previous=generation;napi_value result;napi_create_object(env,&result);
      napi_set_named_property(env,result,"frame",bytes);SetNum(env,result,"width",header.width);
      SetNum(env,result,"height",header.height);SetNum(env,result,"epoch",header.desktopEpoch);
      napi_set_named_property(env,result,"secure",JSBool(env,header.secure!=0));return result;
    }
    return Undefined(env);
  }
};
static std::unique_ptr<ServiceFrameReader> serviceFrame;
static napi_value OpenServiceFrame(napi_env env,napi_callback_info info) {
  size_t count=1;napi_value args[1];napi_get_cb_info(env,info,&count,args,nullptr,nullptr);if(!count)return JSBool(env,false);
  const auto name=Str(env,args[0],"mapping");if(name.size()>128)return JSBool(env,false);
  auto next=std::make_unique<ServiceFrameReader>();
  if(!next->open(std::wstring(name.begin(),name.end())))return JSBool(env,false);
  serviceFrame=std::move(next);return JSBool(env,true);
}
static napi_value ReadServiceFrame(napi_env env,napi_callback_info) {return serviceFrame?serviceFrame->read(env):Undefined(env);}
