#pragma once
#include <atomic>
#include <mutex>
#include <string>
#include <cstdint>
// Capture and input observe desktop switches independently. They must advance
// one shared epoch exactly once, including when input notices the switch first.
class DesktopEpoch {
  std::atomic<uint32_t> value_{0};
  std::mutex mutex_;
  std::wstring desktop_;
  void advance(){if(++value_==0)++value_;}
 public:
  uint32_t observe(const std::wstring& desktop) {
    std::lock_guard<std::mutex> guard(mutex_);
    if(desktop_!=desktop){desktop_=desktop;advance();}
    return value_;
  }
  void layoutChanged(){std::lock_guard<std::mutex> guard(mutex_);advance();}
  uint32_t current() const{return value_;}
  bool matches(uint32_t expected) const{return expected&&expected==value_.load();}
};
