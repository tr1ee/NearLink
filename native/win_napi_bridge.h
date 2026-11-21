#pragma once
// Resolve the stable Node-API from the running executable. Electron renames
// node.exe to Electron.exe / NearLink.exe, so a regular node.lib import would
// leave the addon dependent on a nonexistent node.exe. This also works in Node.
#define NAPI_EXTERN
#include <node_api.h>
#include <windows.h>
#define NL_NAPI(name, signature, arguments) \
  napi_status name signature { \
    using Function = decltype(&name); \
    static auto function = reinterpret_cast<Function>( \
      GetProcAddress(GetModuleHandleW(nullptr), #name)); \
    return function ? function arguments : napi_generic_failure; \
  }
NL_NAPI(napi_get_named_property,(napi_env e,napi_value o,const char*k,napi_value*r),(e,o,k,r))
NL_NAPI(napi_get_value_double,(napi_env e,napi_value v,double*r),(e,v,r))
NL_NAPI(napi_get_value_bool,(napi_env e,napi_value v,bool*r),(e,v,r))
NL_NAPI(napi_get_value_string_utf8,(napi_env e,napi_value v,char*b,size_t n,size_t*r),(e,v,b,n,r))
NL_NAPI(napi_create_string_utf8,(napi_env e,const char*s,size_t n,napi_value*r),(e,s,n,r))
NL_NAPI(napi_get_undefined,(napi_env e,napi_value*r),(e,r))
NL_NAPI(napi_create_arraybuffer,(napi_env e,size_t n,void**p,napi_value*r),(e,n,p,r))
NL_NAPI(napi_throw_error,(napi_env e,const char*c,const char*m),(e,c,m))
NL_NAPI(napi_get_boolean,(napi_env e,bool v,napi_value*r),(e,v,r))
NL_NAPI(napi_create_double,(napi_env e,double v,napi_value*r),(e,v,r))
NL_NAPI(napi_create_array_with_length,(napi_env e,size_t n,napi_value*r),(e,n,r))
NL_NAPI(napi_create_object,(napi_env e,napi_value*r),(e,r))
NL_NAPI(napi_set_element,(napi_env e,napi_value o,uint32_t i,napi_value v),(e,o,i,v))
NL_NAPI(napi_set_named_property,(napi_env e,napi_value o,const char*k,napi_value v),(e,o,k,v))
NL_NAPI(napi_get_cb_info,(napi_env e,napi_callback_info i,size_t*c,napi_value*a,napi_value*t,void**d),(e,i,c,a,t,d))
NL_NAPI(napi_define_properties,(napi_env e,napi_value o,size_t c,const napi_property_descriptor*p),(e,o,c,p))
NL_NAPI(napi_add_env_cleanup_hook,(napi_env e,napi_cleanup_hook h,void*d),(e,h,d))
NL_NAPI(napi_create_promise,(napi_env e,napi_deferred*d,napi_value*p),(e,d,p))
NL_NAPI(napi_create_async_work,(napi_env e,napi_value r,napi_value n,napi_async_execute_callback x,napi_async_complete_callback c,void*d,napi_async_work*w),(e,r,n,x,c,d,w))
NL_NAPI(napi_queue_async_work,(napi_env e,napi_async_work w),(e,w))
NL_NAPI(napi_delete_async_work,(napi_env e,napi_async_work w),(e,w))
NL_NAPI(napi_resolve_deferred,(napi_env e,napi_deferred d,napi_value v),(e,d,v))
#undef NL_NAPI
