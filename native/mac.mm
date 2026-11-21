#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#include <map>
#include <mutex>
#include <cstring>
#include <unistd.h>
#include "common.h"
static std::set<int> heldKeys;
static std::set<int> heldButtons;
static double lastX=0,lastY=0;
static CGEventFlags heldFlags=0;
static const std::map<std::string,int> keyMap={
 {"KeyA",0},{"KeyS",1},{"KeyD",2},{"KeyF",3},{"KeyH",4},{"KeyG",5},{"KeyZ",6},{"KeyX",7},{"KeyC",8},{"KeyV",9},{"KeyB",11},{"KeyQ",12},{"KeyW",13},{"KeyE",14},{"KeyR",15},{"KeyY",16},{"KeyT",17},
 {"Digit1",18},{"Digit2",19},{"Digit3",20},{"Digit4",21},{"Digit6",22},{"Digit5",23},{"Equal",24},{"Digit9",25},{"Digit7",26},{"Minus",27},{"Digit8",28},{"Digit0",29},{"BracketRight",30},{"KeyO",31},{"KeyU",32},{"BracketLeft",33},{"KeyI",34},{"KeyP",35},{"Enter",36},{"KeyL",37},{"KeyJ",38},{"Quote",39},{"KeyK",40},{"Semicolon",41},{"Backslash",42},{"Comma",43},{"Slash",44},{"KeyN",45},{"KeyM",46},{"Period",47},{"Tab",48},{"Space",49},{"Backquote",50},{"Backspace",51},{"Escape",53},
 {"MetaLeft",55},{"MetaRight",54},{"ShiftLeft",56},{"CapsLock",57},{"AltLeft",58},{"ControlLeft",59},{"ShiftRight",60},{"AltRight",61},{"ControlRight",62},
 {"F1",122},{"F2",120},{"F3",99},{"F4",118},{"F5",96},{"F6",97},{"F7",98},{"F8",100},{"F9",101},{"F10",109},{"F11",103},{"F12",111},{"ArrowLeft",123},{"ArrowRight",124},{"ArrowDown",125},{"ArrowUp",126},{"Delete",117},{"Home",115},{"End",119},{"PageUp",116},{"PageDown",121},
 {"Numpad0",82},{"Numpad1",83},{"Numpad2",84},{"Numpad3",85},{"Numpad4",86},{"Numpad5",87},{"Numpad6",88},{"Numpad7",89},{"Numpad8",91},{"Numpad9",92},{"NumpadEnter",76},{"NumpadAdd",69},{"NumpadSubtract",78},{"NumpadMultiply",67},{"NumpadDivide",75},{"NumpadDecimal",65}
};
static CGEventFlags flagFor(int k){switch(k){case 55:case 54:return kCGEventFlagMaskCommand;case 56:case 60:return kCGEventFlagMaskShift;case 58:case 61:return kCGEventFlagMaskAlternate;case 59:case 62:return kCGEventFlagMaskControl;default:return 0;}}
static void key(int k,bool down){if(down)heldKeys.insert(k);else heldKeys.erase(k);heldFlags=0;for(int v:heldKeys)heldFlags|=flagFor(v);auto e=CGEventCreateKeyboardEvent(nullptr,k,down);if(e){CGEventSetFlags(e,heldFlags);CGEventPost(kCGHIDEventTap,e);CFRelease(e);}}
static void button(int b,bool down,double x,double y){if(down)heldButtons.insert(b);else heldButtons.erase(b);const CGMouseButton mb=b==2?kCGMouseButtonRight:b==1?kCGMouseButtonCenter:kCGMouseButtonLeft;const CGEventType type=b==0?(down?kCGEventLeftMouseDown:kCGEventLeftMouseUp):b==2?(down?kCGEventRightMouseDown:kCGEventRightMouseUp):(down?kCGEventOtherMouseDown:kCGEventOtherMouseUp);auto e=CGEventCreateMouseEvent(nullptr,type,CGPointMake(x,y),mb);if(e){CGEventSetFlags(e,heldFlags);CGEventPost(kCGHIDEventTap,e);CFRelease(e);}}
static void release(){auto keys=heldKeys;for(int k:keys)key(k,false);auto buttons=heldButtons;for(int b:buttons)button(b,false,lastX,lastY);heldFlags=0;}
static napi_value Input(napi_env env,napi_callback_info info){size_t argc=1;napi_value a[1];napi_get_cb_info(env,info,&argc,a,nullptr,nullptr);if(!argc)return JSBool(env,false);if(!AXIsProcessTrusted())return JSBool(env,false);auto v=a[0];auto t=Str(env,v,"type");
 if(t=="release"){release();return JSBool(env,true);}
 if(t=="move"||t=="button"){lastX=Num(env,v,"screenX");lastY=Num(env,v,"screenY");}
 if(t=="move"){int b=heldButtons.count(0)?0:heldButtons.count(2)?2:heldButtons.count(1)?1:-1;CGEventType type=b==0?kCGEventLeftMouseDragged:b==2?kCGEventRightMouseDragged:b==1?kCGEventOtherMouseDragged:kCGEventMouseMoved;auto e=CGEventCreateMouseEvent(nullptr,type,CGPointMake(lastX,lastY),b==2?kCGMouseButtonRight:b==1?kCGMouseButtonCenter:kCGMouseButtonLeft);if(e){CGEventSetFlags(e,heldFlags);CGEventPost(kCGHIDEventTap,e);CFRelease(e);}}
 else if(t=="button")button((int)Num(env,v,"button"),Bool(env,v,"down"),lastX,lastY);
 else if(t=="wheel"){auto e=CGEventCreateScrollWheelEvent(nullptr,kCGScrollEventUnitPixel,2,(int)-Num(env,v,"dy"),(int)-Num(env,v,"dx"));if(e){CGEventSetFlags(e,heldFlags);CGEventPost(kCGHIDEventTap,e);CFRelease(e);}}
 else if(t=="key"){auto k=keyMap.find(Str(env,v,"code"));if(k==keyMap.end())return JSBool(env,false);key(k->second,Bool(env,v,"down"));}
 else if(t=="text"){@autoreleasepool{auto text=Str(env,v,"text");NSString*s=[[NSString alloc]initWithBytes:text.data() length:text.size() encoding:NSUTF8StringEncoding];for(NSUInteger i=0;i<s.length;i+=20){NSUInteger n=MIN((NSUInteger)20,s.length-i);UniChar chars[20];[s getCharacters:chars range:NSMakeRange(i,n)];for(bool down:{true,false}){auto e=CGEventCreateKeyboardEvent(nullptr,0,down);if(e){CGEventSetFlags(e,0);CGEventKeyboardSetUnicodeString(e,n,chars);CGEventPost(kCGHIDEventTap,e);CFRelease(e);}}}}}
 else if(t=="paste"){release();key(55,true);key(9,true);key(9,false);key(55,false);}
 else return JSBool(env,false);
 return JSBool(env,true);
}
struct AudioPacket{std::vector<float> samples;double rate;int channels;};
static AudioObjectID tapID=kAudioObjectUnknown,aggregateID=kAudioObjectUnknown;
static AudioDeviceIOProcID audioProc=nullptr;static napi_threadsafe_function audioTSFN=nullptr;static AudioStreamBasicDescription audioFormat={};
static void AudioToJS(napi_env env,napi_value callback,void*,void*data){auto p=(AudioPacket*)data;if(env&&callback){napi_value o,buf;napi_create_object(env,&o);napi_create_buffer_copy(env,p->samples.size()*sizeof(float),p->samples.data(),nullptr,&buf);napi_set_named_property(env,o,"pcm",buf);SetNum(env,o,"sampleRate",p->rate);SetNum(env,o,"channels",p->channels);napi_value result;napi_call_function(env,Undefined(env),callback,1,&o,&result);}delete p;}
static OSStatus AudioCallback(AudioObjectID,const AudioTimeStamp*,const AudioBufferList*input,const AudioTimeStamp*,AudioBufferList*,const AudioTimeStamp*,void*){
 if(!audioTSFN||!input||!input->mNumberBuffers)return noErr;
 if(!(audioFormat.mFormatFlags&kAudioFormatFlagIsFloat)||audioFormat.mBitsPerChannel!=32)return noErr;
 const auto&first=input->mBuffers[0];if(!first.mData||!first.mNumberChannels)return noErr;
 size_t frames=first.mDataByteSize/(sizeof(float)*first.mNumberChannels);int channels=MIN((UInt32)2,audioFormat.mChannelsPerFrame);if(!frames||frames>8192||channels<1)return noErr;
 auto packet=new AudioPacket();packet->rate=audioFormat.mSampleRate;packet->channels=channels;packet->samples.resize(frames*channels);
 for(size_t i=0;i<frames;i++)for(int c=0;c<channels;c++){if(input->mNumberBuffers==1)packet->samples[i*channels+c]=((float*)first.mData)[i*first.mNumberChannels+c];else{const auto&b=input->mBuffers[MIN((UInt32)c,input->mNumberBuffers-1)];packet->samples[i*channels+c]=b.mData?((float*)b.mData)[i*b.mNumberChannels]:0;}}
 if(napi_call_threadsafe_function(audioTSFN,packet,napi_tsfn_nonblocking)!=napi_ok)delete packet;
 return noErr;
}
static void stopAudio(){if(audioProc&&aggregateID!=kAudioObjectUnknown){AudioDeviceStop(aggregateID,audioProc);AudioDeviceDestroyIOProcID(aggregateID,audioProc);}audioProc=nullptr;if(aggregateID!=kAudioObjectUnknown)AudioHardwareDestroyAggregateDevice(aggregateID);aggregateID=kAudioObjectUnknown;if(tapID!=kAudioObjectUnknown)AudioHardwareDestroyProcessTap(tapID);tapID=kAudioObjectUnknown;if(audioTSFN){napi_release_threadsafe_function(audioTSFN,napi_tsfn_abort);audioTSFN=nullptr;}}
static napi_value StopAudio(napi_env env,napi_callback_info){stopAudio();return Undefined(env);}
static napi_value StartAudio(napi_env env,napi_callback_info info){stopAudio();size_t argc=1;napi_value args[1];napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);if(!argc){napi_throw_error(env,nullptr,"需要音频回调");return nullptr;}
 @autoreleasepool{NSMutableArray<NSNumber*>*exclude=[NSMutableArray array];pid_t pid=getpid();AudioObjectID processObject=0;UInt32 psize=sizeof(processObject);AudioObjectPropertyAddress pa={kAudioHardwarePropertyTranslatePIDToProcessObject,kAudioObjectPropertyScopeGlobal,kAudioObjectPropertyElementMain};if(AudioObjectGetPropertyData(kAudioObjectSystemObject,&pa,sizeof(pid),&pid,&psize,&processObject)==noErr&&processObject)[exclude addObject:@(processObject)];
 CATapDescription*desc=[[CATapDescription alloc]initStereoGlobalTapButExcludeProcesses:exclude];desc.name=@"NearLink System Audio";desc.UUID=[NSUUID UUID];[desc setPrivate:YES];desc.muteBehavior=CATapUnmuted;
 OSStatus status=AudioHardwareCreateProcessTap(desc,&tapID);if(status!=noErr){napi_throw_error(env,nullptr,"无法创建系统声音采集，请检查音频录制权限");return nullptr;}
 NSDictionary*props=@{@kAudioAggregateDeviceNameKey:@"NearLink Audio",@kAudioAggregateDeviceUIDKey:[[NSUUID UUID]UUIDString],@kAudioAggregateDeviceIsPrivateKey:@YES,@kAudioAggregateDeviceTapAutoStartKey:@YES,@kAudioAggregateDeviceTapListKey:@[@{@kAudioSubTapUIDKey:desc.UUID.UUIDString,@kAudioSubTapDriftCompensationKey:@YES}]};
 status=AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)props,&aggregateID);if(status!=noErr){stopAudio();napi_throw_error(env,nullptr,"无法初始化系统声音采集设备");return nullptr;}
 AudioObjectPropertyAddress fmt={kAudioTapPropertyFormat,kAudioObjectPropertyScopeGlobal,kAudioObjectPropertyElementMain};UInt32 size=sizeof(audioFormat);status=AudioObjectGetPropertyData(tapID,&fmt,0,nullptr,&size,&audioFormat);
 if(status!=noErr||!(audioFormat.mFormatFlags&kAudioFormatFlagIsFloat)||audioFormat.mBitsPerChannel!=32){stopAudio();napi_throw_error(env,nullptr,"系统音频格式暂不受支持");return nullptr;}
 napi_value name;napi_create_string_utf8(env,"NearLinkAudio",NAPI_AUTO_LENGTH,&name);napi_create_threadsafe_function(env,args[0],nullptr,name,8,1,nullptr,nullptr,nullptr,AudioToJS,&audioTSFN);napi_unref_threadsafe_function(env,audioTSFN);
 status=AudioDeviceCreateIOProcID(aggregateID,AudioCallback,nullptr,&audioProc);if(status==noErr)status=AudioDeviceStart(aggregateID,audioProc);if(status!=noErr){stopAudio();napi_throw_error(env,nullptr,"系统声音录制未启动，请在系统设置允许 NearLink 录制声音");return nullptr;}
 napi_value format;napi_create_object(env,&format);SetNum(env,format,"sampleRate",audioFormat.mSampleRate);SetNum(env,format,"channels",MIN((UInt32)2,audioFormat.mChannelsPerFrame));return format;}
}
static void Cleanup(void*){stopAudio();release();}
static napi_value LocalButtons(napi_env env, napi_callback_info) {
  const auto state = kCGEventSourceStateCombinedSessionState;
  unsigned mask = 0;
  if (CGEventSourceButtonState(state, kCGMouseButtonLeft)) mask |= 1;
  if (CGEventSourceButtonState(state, kCGMouseButtonRight)) mask |= 2;
  if (CGEventSourceButtonState(state, kCGMouseButtonCenter)) mask |= 4;
  napi_value result;
  napi_create_uint32(env, mask, &result);
  return result;
}
static napi_value Init(napi_env env,napi_value exports){napi_property_descriptor props[]={{"input",0,Input,0,0,0,napi_default,0},{"startAudio",0,StartAudio,0,0,0,napi_default,0},{"stopAudio",0,StopAudio,0,0,0,napi_default,0},{"localButtons",0,LocalButtons,0,0,0,napi_default,0}};napi_define_properties(env,exports,sizeof(props)/sizeof(props[0]),props);napi_add_env_cleanup_hook(env,Cleanup,nullptr);return exports;}
NAPI_MODULE(NODE_GYP_MODULE_NAME,Init)
