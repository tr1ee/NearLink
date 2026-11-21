#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cwchar>
#include <map>
#include <string_view>
#include "win_napi_bridge.h"
#include "common.h"
#include "windows-mouse.h"
static std::set<WORD> heldKeys;
static std::map<std::string,WORD> keyMap={{"Enter",VK_RETURN},{"Tab",VK_TAB},{"Space",VK_SPACE},{"Backspace",VK_BACK},{"Escape",VK_ESCAPE},{"Delete",VK_DELETE},{"Insert",VK_INSERT},{"Home",VK_HOME},{"End",VK_END},{"PageUp",VK_PRIOR},{"PageDown",VK_NEXT},{"ArrowLeft",VK_LEFT},{"ArrowRight",VK_RIGHT},{"ArrowUp",VK_UP},{"ArrowDown",VK_DOWN},{"ControlLeft",VK_LCONTROL},{"ControlRight",VK_RCONTROL},{"ShiftLeft",VK_LSHIFT},{"ShiftRight",VK_RSHIFT},{"AltLeft",VK_LMENU},{"AltRight",VK_RMENU},{"MetaLeft",VK_LWIN},{"MetaRight",VK_RWIN},{"CapsLock",VK_CAPITAL},{"Minus",VK_OEM_MINUS},{"Equal",VK_OEM_PLUS},{"BracketLeft",VK_OEM_4},{"BracketRight",VK_OEM_6},{"Backslash",VK_OEM_5},{"Semicolon",VK_OEM_1},{"Quote",VK_OEM_7},{"Backquote",VK_OEM_3},{"Comma",VK_OEM_COMMA},{"Period",VK_OEM_PERIOD},{"Slash",VK_OEM_2},{"NumpadEnter",VK_RETURN},{"NumpadAdd",VK_ADD},{"NumpadSubtract",VK_SUBTRACT},{"NumpadMultiply",VK_MULTIPLY},{"NumpadDivide",VK_DIVIDE},{"NumpadDecimal",VK_DECIMAL}};
static bool send(INPUT&i){return SendInput(1,&i,sizeof(i))==1;}
static napi_value inputOutcome(napi_env env, const char* result) {
  napi_value value;
  if (napi_create_string_utf8(env, result, NAPI_AUTO_LENGTH, &value) != napi_ok)
    return JSBool(env, false);
  return value;
}
enum class MouseTargetKind { unavailable, other, primary, secondary, overflow, xamlOverflow };

static MouseTargetKind classifyRoot(HWND root) {
  wchar_t name[128]{};
  if (!root || !GetClassNameW(root, name, ARRAYSIZE(name))) return MouseTargetKind::unavailable;
  if (std::wcscmp(name, L"Shell_TrayWnd") == 0) return MouseTargetKind::primary;
  if (std::wcscmp(name, L"Shell_SecondaryTrayWnd") == 0) return MouseTargetKind::secondary;
  if (std::wcscmp(name, L"NotifyIconOverflowWindow") == 0) return MouseTargetKind::overflow;
  if (std::wcscmp(name, L"TopLevelWindowForOverflowXamlIsland") == 0) return MouseTargetKind::xamlOverflow;
  return MouseTargetKind::other;
}

static bool isTray(MouseTargetKind target) {
  return target != MouseTargetKind::unavailable && target != MouseTargetKind::other;
}

static const char* targetLabel(MouseTargetKind target) {
  switch (target) {
    case MouseTargetKind::primary: return "primary-taskbar";
    case MouseTargetKind::secondary: return "secondary-taskbar";
    case MouseTargetKind::overflow: return "overflow-legacy";
    case MouseTargetKind::xamlOverflow: return "overflow-xaml";
    case MouseTargetKind::other: return "other-root";
    default: return "unavailable";
  }
}

struct MouseTarget {
  MouseTargetKind kind;
  DWORD threadId;
  DWORD processId;
};

static MouseTarget targetAt(MousePoint point) {
  const HWND hit = WindowFromPoint({point.x, point.y});
  const HWND root = GetAncestor(hit, GA_ROOT);
  MouseTarget target{classifyRoot(root), 0, 0};
  if (root || hit) target.threadId = GetWindowThreadProcessId(root ? root : hit, &target.processId);
  return target;
}

struct MouseLogEntry {
  MouseDiagnostic sample;
  MouseTargetKind target;
};

struct CaptureProbe {
  uint64_t gesture;
  MouseTarget target;
  uint64_t submittedAt;
};

static MouseTarget pressTarget{};
static MouseTarget gestureTarget{};
static uint64_t currentGesture = 0;
static std::array<MouseLogEntry, 64> mouseLog{};
static std::size_t mouseLogSize = 0;
static std::size_t mouseLogDropped = 0;
static std::optional<CaptureProbe> captureProbe;

static void recordMouseDiagnostic(const MouseDiagnostic& sample) {
  if (sample.gesture != currentGesture) {
    currentGesture = sample.gesture;
    gestureTarget = pressTarget;
    captureProbe.reset();
  }
  if (mouseLogSize < mouseLog.size())
    mouseLog[mouseLogSize++] = {sample, gestureTarget.kind};
  else
    ++mouseLogDropped;
  // Sample the queues later. SendInput returning does not mean the target
  // thread has processed its posted input.
  const std::string_view step(sample.step);
  if (step == "click-submit" || step == "drag-start" || step == "tray-up" ||
      step == "tray-move-up" || step == "fallback-up" || step == "click-cleanup" ||
      step == "tray-up-cleanup" || step == "release-cleanup") {
    captureProbe = CaptureProbe{sample.gesture, gestureTarget, GetTickCount64()};
  }
}

static WindowsMouse mouse(recordMouseDiagnostic);

static const char* captureStatus(DWORD thread, const MouseTarget& target) {
  GUITHREADINFO info{};
  info.cbSize = sizeof(info);
  if (!GetGUIThreadInfo(thread, &info)) return "unavailable";
  if (!info.hwndCapture) return "none-observed";
  if (isTray(classifyRoot(GetAncestor(info.hwndCapture, GA_ROOT)))) return "tray-window";
  DWORD process = 0;
  GetWindowThreadProcessId(info.hwndCapture, &process);
  if (isTray(target.kind) && process && process == target.processId) return "tray-process";
  return "other-window";
}

static void setString(napi_env env, napi_value object, const char* key, const char* text) {
  napi_value value;
  if (napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &value) == napi_ok)
    napi_set_named_property(env, object, key, value);
}

static napi_value TakeMouseDiagnostics(napi_env env, napi_callback_info) {
  const auto now = GetTickCount64();
  const bool captureReady = captureProbe && now - captureProbe->submittedAt >= 120;
  napi_value array;
  if (napi_create_array_with_length(env, mouseLogSize + captureReady + (mouseLogDropped != 0),
                                    &array) != napi_ok) return Undefined(env);
  uint32_t index = 0;
  for (std::size_t i = 0; i < mouseLogSize; ++i) {
    const auto& entry = mouseLog[i];
    const auto& d = entry.sample;
    napi_value object;
    if (napi_create_object(env, &object) != napi_ok) break;
    SetNum(env, object, "gesture", d.gesture);
    setString(env, object, "step", d.step);
    setString(env, object, "target", targetLabel(entry.target));
    SetNum(env, object, "atMs", d.atMs);
    SetNum(env, object, "heldMs", d.heldMs);
    SetNum(env, object, "dx", d.delta.x);
    SetNum(env, object, "dy", d.delta.y);
    if (d.threshold) {
      SetNum(env, object, "thresholdX", d.threshold->x);
      SetNum(env, object, "thresholdY", d.threshold->y);
    }
    SetNum(env, object, "suppressedMoves", d.suppressedMoves);
    SetNum(env, object, "requested", d.requested);
    SetNum(env, object, "queued", d.queued);
    napi_set_named_property(env, object, "leftHeld", JSBool(env, d.leftHeld));
    napi_set_element(env, array, index++, object);
  }
  mouseLogSize = 0;
  if (captureReady) {
    const auto probe = *captureProbe;
    captureProbe.reset();
    napi_value object;
    if (napi_create_object(env, &object) == napi_ok) {
      SetNum(env, object, "gesture", probe.gesture);
      setString(env, object, "step", "capture-sample");
      setString(env, object, "target", targetLabel(probe.target.kind));
      SetNum(env, object, "afterMs", now - probe.submittedAt);
      setString(env, object, "targetCapture", probe.target.threadId ?
          captureStatus(probe.target.threadId, probe.target) : "unavailable");
      setString(env, object, "foregroundCapture", captureStatus(0, probe.target));
      napi_set_element(env, array, index++, object);
    }
  }
  if (mouseLogDropped) {
    napi_value object;
    if (napi_create_object(env, &object) == napi_ok) {
      setString(env, object, "step", "buffer-overflow");
      SetNum(env, object, "dropped", mouseLogDropped);
      napi_set_element(env, array, index, object);
    }
    mouseLogDropped = 0;
  }
  return array;
}
static bool key(WORD k, bool down) {
  INPUT input{};
  input.type = INPUT_KEYBOARD;
  input.ki.wVk = k;
  bool extended = k == VK_RCONTROL || k == VK_RMENU || k == VK_LEFT ||
    k == VK_RIGHT || k == VK_UP || k == VK_DOWN || k == VK_HOME ||
    k == VK_END || k == VK_INSERT || k == VK_DELETE || k == VK_LWIN || k == VK_RWIN;
  input.ki.dwFlags = (down ? 0 : KEYEVENTF_KEYUP) | (extended ? KEYEVENTF_EXTENDEDKEY : 0);
  if (!send(input)) return false;
  if (down) heldKeys.insert(k);
  else heldKeys.erase(k);
  return true;
}
static std::size_t sendMouse(std::initializer_list<MouseStroke> strokes) {
  static const DWORD press[] = {MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_RIGHTDOWN};
  static const DWORD lift[] = {MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_RIGHTUP};
  std::array<INPUT, 3> batch{};
  if (strokes.size() > batch.size()) return 0;
  std::size_t index = 0;
  int width = 0, height = 0, left = 0, top = 0;
  for (const auto& stroke : strokes) {
    auto& input = batch[index++];
    input.type = INPUT_MOUSE;
    if (stroke.action == MouseAction::move) {
      if (!width) {
        width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        if (width < 2 || height < 2) return 0;
        left = GetSystemMetrics(SM_XVIRTUALSCREEN);
        top = GetSystemMetrics(SM_YVIRTUALSCREEN);
      }
      input.mi.dx = LONG((double(stroke.point.x) - left) * 65535 / (width - 1));
      input.mi.dy = LONG((double(stroke.point.y) - top) * 65535 / (height - 1));
      input.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
    } else {
      input.mi.dwFlags = stroke.action == MouseAction::down ? press[stroke.button] : lift[stroke.button];
    }
  }
  return SendInput(static_cast<UINT>(index), batch.data(), sizeof(INPUT));
}
static bool release() {
  auto keys = heldKeys;
  for (auto k : keys) key(k, false);
  const bool mouseReleased = mouse.release(sendMouse, GetTickCount64());
  return heldKeys.empty() && mouseReleased;
}
static napi_value Input(napi_env env,napi_callback_info info){size_t argc=1;napi_value a[1];napi_get_cb_info(env,info,&argc,a,nullptr,nullptr);if(!argc)return JSBool(env,false);auto v=a[0];auto t=Str(env,v,"type");bool ok=true;
 if(t=="release")ok=release();
 else if(t=="move"||t=="button"){
   const MousePoint point{LONG(Num(env, v, "screenX")), LONG(Num(env, v, "screenY"))};
   const auto now = GetTickCount64();
   MouseResult result;
   if (t == "move") {
     result = mouse.move(point, now, sendMouse);
   } else {
     const int b = int(Num(env, v, "button"));
     if (b < 0 || b > 2) return JSBool(env, false);
     const bool down = Bool(env, v, "down");
     POINT cursor{};
     const bool atPoint = GetCursorPos(&cursor) && cursor.x == point.x && cursor.y == point.y;
     std::optional<MousePoint> threshold;
     if (b == 0 && down) {
       pressTarget = targetAt(point);
       if (isTray(pressTarget.kind))
         threshold = MousePoint{std::abs(GetSystemMetrics(SM_CXDRAG)), std::abs(GetSystemMetrics(SM_CYDRAG))};
     }
     result = mouse.button(b, down, point, atPoint, threshold, now, sendMouse);
   }
   switch (result) {
     case MouseResult::applied: return JSBool(env, true);
     case MouseResult::rejected: return JSBool(env, false);
     case MouseResult::alreadyUp: return inputOutcome(env, "already-up");
     case MouseResult::deferredPress: return inputOutcome(env, "deferred-press");
     case MouseResult::suppressedMove: return inputOutcome(env, "suppressed-move");
     case MouseResult::trayClick: return inputOutcome(env, "tray-click");
     case MouseResult::trayDragStart: return inputOutcome(env, "tray-drag-start");
   }
 }
 else if(t=="wheel"){for(auto axis:{std::pair<const char*,DWORD>{"dy",MOUSEEVENTF_WHEEL},{"dx",MOUSEEVENTF_HWHEEL}}){double d=Num(env,v,axis.first);if(d){INPUT i={};i.type=INPUT_MOUSE;i.mi.dwFlags=axis.second;i.mi.mouseData=(DWORD)(LONG)(axis.second==MOUSEEVENTF_WHEEL?-d:d);ok=send(i)&&ok;}}}
 else if(t=="key"){auto code=Str(env,v,"code");auto it=keyMap.find(code);if(it==keyMap.end())return JSBool(env,false);ok=key(it->second,Bool(env,v,"down"));}
 else if(t=="text"){auto text=Str(env,v,"text");int n=MultiByteToWideChar(CP_UTF8,0,text.data(),(int)text.size(),nullptr,0);std::vector<WCHAR>w(n);MultiByteToWideChar(CP_UTF8,0,text.data(),(int)text.size(),w.data(),n);for(WCHAR c:w)for(bool down:{true,false}){INPUT i={};i.type=INPUT_KEYBOARD;i.ki.wScan=c;i.ki.dwFlags=KEYEVENTF_UNICODE|(down?0:KEYEVENTF_KEYUP);ok=send(i)&&ok;}}
 else if(t=="paste"){release();ok=key(VK_CONTROL,true)&&key('V',true);key('V',false);key(VK_CONTROL,false);}
 else return JSBool(env,false);return JSBool(env,ok);
}
static void Cleanup(void*){release();}
static napi_value Init(napi_env env, napi_value exports) {
  for (char c = 'A'; c <= 'Z'; ++c) keyMap[std::string("Key") + c] = c;
  for (char c = '0'; c <= '9'; ++c) {
    keyMap[std::string("Digit") + c] = c;
    keyMap[std::string("Numpad") + c] = VK_NUMPAD0 + c - '0';
  }
  for (int f = 1; f <= 12; ++f) keyMap["F" + std::to_string(f)] = VK_F1 + f - 1;
  const napi_property_descriptor properties[] = {
    {"input", 0, Input, 0, 0, 0, napi_default, 0},
    {"takeMouseDiagnostics", 0, TakeMouseDiagnostics, 0, 0, 0, napi_default, 0},
  };
  napi_define_properties(env, exports, ARRAYSIZE(properties), properties);
  napi_add_env_cleanup_hook(env, Cleanup, nullptr);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,Init)
