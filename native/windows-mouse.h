#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <functional>
#include <initializer_list>
#include <optional>
#include <utility>

struct MousePoint {
  long x;
  long y;
};

enum class MouseAction { move, down, up };
struct MouseStroke {
  MouseAction action;
  MousePoint point{};
  int button = 0;
};

enum class MouseResult {
  applied, rejected, alreadyUp, deferredPress, suppressedMove, trayClick, trayDragStart,
};

struct MouseDiagnostic {
  uint64_t gesture;
  const char* step;
  uint64_t atMs;
  uint64_t heldMs;
  MousePoint delta;
  std::optional<MousePoint> threshold;
  std::size_t suppressedMoves;
  std::size_t requested;
  std::size_t queued;
  bool leftHeld;
};

class WindowsMouse {
 public:
  using Observe = std::function<void(const MouseDiagnostic&)>;
  explicit WindowsMouse(Observe observe = {}) : observe_(std::move(observe)) {}

  // Match the input lease. An expired, uncommitted press cannot become a click.
  static constexpr uint64_t pendingTimeoutMs = 4000;

  template <typename Send>
  MouseResult move(MousePoint point, uint64_t now, Send&& send) {
    expire(now, point);
    if (gesture_) gesture_->last = point;
    if (!pending_) return result(submit(send, {{MouseAction::move, point}}));
    const auto press = *pending_;
    if (std::abs(point.x - press.anchor.x) <= press.threshold.x &&
        std::abs(point.y - press.anchor.y) <= press.threshold.y) {
      if (gesture_) gesture_->suppressedMoves++;
      return MouseResult::suppressedMove;
    }

    pending_.reset();
    const bool completed = submit(send, {
      {MouseAction::move, press.anchor}, {MouseAction::down}, {MouseAction::move, point},
    }, "drag-start", now, point);
    trayLeftHeld_ = held_[0];
    if (!held_[0]) gesture_.reset();
    return completed ? MouseResult::trayDragStart : MouseResult::rejected;
  }

  template <typename Send>
  MouseResult button(int button, bool down, MousePoint point, bool atPoint,
                     std::optional<MousePoint> trayThreshold, uint64_t now, Send&& send) {
    expire(now, point);
    if (button == 0 && pending_) {
      if (down) {
        note("duplicate-pending-down", now, point);
        return MouseResult::deferredPress;
      }
      const auto anchor = pending_->anchor;
      pending_.reset();
      // Always include the anchor. An earlier SendInput move can still be queued.
      if (submit(send, {{MouseAction::move, anchor}, {MouseAction::down}, {MouseAction::up}},
                 "click-submit", now, point)) {
        gesture_.reset();
        return MouseResult::trayClick;
      }
      if (held_[0]) {
        trayLeftHeld_ = true;
        submit(send, {{MouseAction::up}}, "click-cleanup", now, point);
      }
      if (!held_[0]) gesture_.reset();
      return MouseResult::rejected;
    }
    if (button == 0 && down) {
      if (trayLeftHeld_) {
        note("duplicate-held-down", now, point);
        return MouseResult::deferredPress;
      }
      if (observe_ && !gesture_) gesture_ = Gesture{++nextGesture_, point, trayThreshold, now};
      if (trayThreshold && !held_[0] && !held_[1] && !held_[2]) {
        pending_ = PendingPress{point, *trayThreshold, now};
        note("press-deferred", now, point);
        return MouseResult::deferredPress;
      }
    } else if (down) {
      if (pending_) {
        note("pending-cancel-other-button", now, point);
        gesture_.reset();
      }
      pending_.reset();
    }

    if (!down && !held_[button]) return MouseResult::alreadyUp;
    const MouseStroke stroke{down ? MouseAction::down : MouseAction::up, {}, button};
    const char* step = nullptr;
    if (button == 0) {
      if (down && held_[0]) step = "duplicate-fallback-down";
      else if (down) step = trayThreshold ? "press-fallback-chord" : "press-fallback-miss";
      else if (trayLeftHeld_) step = atPoint ? "tray-up" : "tray-move-up";
      else step = "fallback-up";
    }
    const bool completed = atPoint ? submit(send, {stroke}, step, now, point) :
        submit(send, {{MouseAction::move, point}, stroke}, step, now, point);
    if (!completed && button == 0 && !down && trayLeftHeld_)
      submit(send, {{MouseAction::up}}, "tray-up-cleanup", now, point);
    if (button == 0 && !held_[0]) gesture_.reset();
    return result(completed);
  }

  template <typename Send>
  bool release(Send&& send, uint64_t now = 0) {
    const auto point = gesture_ ? gesture_->last : MousePoint{};
    if (gesture_ && !now) now = gesture_->startedAt;
    if (pending_) note("pending-cancel-release", now, point);
    pending_.reset();
    for (int button = 0; button < static_cast<int>(held_.size()); ++button)
      if (held_[button]) submit(send, {{MouseAction::up, {}, button}},
                                button == 0 ? "release-cleanup" : nullptr, now, point);
    if (!held_[0]) gesture_.reset();
    return !held_[0] && !held_[1] && !held_[2];
  }

 private:
  struct PendingPress {
    MousePoint anchor;
    MousePoint threshold;
    uint64_t startedAt;
  };

  struct Gesture {
    uint64_t id;
    MousePoint anchor;
    std::optional<MousePoint> threshold;
    uint64_t startedAt;
    MousePoint last = anchor;
    std::size_t suppressedMoves = 0;
  };

  void note(const char* step, uint64_t now, MousePoint point,
            std::size_t requested = 0, std::size_t queued = 0) {
    if (!step || !gesture_) return;
    auto& gesture = *gesture_;
    gesture.last = point;
    observe_({gesture.id, step, now, now >= gesture.startedAt ? now - gesture.startedAt : 0,
              {point.x - gesture.anchor.x, point.y - gesture.anchor.y}, gesture.threshold,
              gesture.suppressedMoves, requested, queued, held_[0]});
  }

  void expire(uint64_t now, MousePoint point) {
    if (pending_ && now - pending_->startedAt >= pendingTimeoutMs) {
      note("pending-timeout", now, point);
      pending_.reset();
      gesture_.reset();
    }
  }

  template <typename Send>
  bool submit(Send& send, std::initializer_list<MouseStroke> strokes,
              const char* step = nullptr, uint64_t now = 0, MousePoint point = {}) {
    const std::size_t accepted = send(strokes);
    // A partially queued batch may have pressed a button. Track only the prefix
    // the OS accepted so the input worker can retry a release during cleanup.
    std::size_t queued = 0;
    for (const auto& stroke : strokes) {
      if (queued++ == accepted) break;
      if (stroke.action == MouseAction::move) continue;
      const bool down = stroke.action == MouseAction::down;
      held_[stroke.button] = down;
      if (stroke.button == 0 && !down) trayLeftHeld_ = false;
    }
    note(step, now, point, strokes.size(), accepted);
    return accepted == strokes.size();
  }

  static MouseResult result(bool ok) {
    return ok ? MouseResult::applied : MouseResult::rejected;
  }

  std::optional<PendingPress> pending_;
  std::array<bool, 3> held_{};
  bool trayLeftHeld_ = false;
  Observe observe_;
  uint64_t nextGesture_ = 0;
  std::optional<Gesture> gesture_;
};
