#pragma once
#include <cstdint>
#include <string>

struct NativeInputCommand {
  std::string type, code, text;
  int32_t screenX = 0, screenY = 0, button = 0;
  double dx = 0, dy = 0;
  bool down = false;
};
enum class NativeInputOutcome : uint32_t {
  rejected, applied, alreadyUp, deferredPress, suppressedMove, trayClick, trayDragStart,
};
