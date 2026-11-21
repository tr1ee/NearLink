#pragma once
#include <node_api.h>
#include <string>
#include <vector>
#include <set>
inline napi_value Prop(napi_env e,napi_value v,const char*k){napi_value o;napi_get_named_property(e,v,k,&o);return o;}
inline double Num(napi_env e,napi_value v,const char*k){double x=0;napi_get_value_double(e,Prop(e,v,k),&x);return x;}
inline bool Bool(napi_env e,napi_value v,const char*k){bool x=false;napi_get_value_bool(e,Prop(e,v,k),&x);return x;}
inline std::string Str(napi_env e,napi_value v,const char*k){auto a=Prop(e,v,k);size_t n=0;napi_get_value_string_utf8(e,a,nullptr,0,&n);std::string s(n+1,'\0');napi_get_value_string_utf8(e,a,s.data(),n+1,&n);s.resize(n);return s;}
inline napi_value Undefined(napi_env e){napi_value v;napi_get_undefined(e,&v);return v;}
inline napi_value JSBool(napi_env e,bool b){napi_value v;napi_get_boolean(e,b,&v);return v;}
inline void SetNum(napi_env e,napi_value o,const char*k,double x){napi_value v;napi_create_double(e,x,&v);napi_set_named_property(e,o,k,v);}
