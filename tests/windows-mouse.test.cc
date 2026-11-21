#include "../native/windows-mouse.h"
#include <cassert>
#include <deque>
#include <string_view>
#include <vector>

using Action = MouseAction;
using Result = MouseResult;

struct Recorder {
  std::vector<std::vector<MouseStroke>> batches;
  std::deque<std::size_t> accepted;

  std::size_t operator()(std::initializer_list<MouseStroke> strokes) {
    batches.emplace_back(strokes);
    if (accepted.empty()) return strokes.size();
    const auto count = accepted.front();
    accepted.pop_front();
    return count;
  }
};

constexpr MousePoint anchor{-192, 480};
constexpr MousePoint threshold{4, 6};
constexpr MousePoint jump{-161, 510};

void expectBatch(const std::vector<MouseStroke>& batch,
                 std::initializer_list<MouseStroke> expected) {
  assert(batch.size() == expected.size());
  std::size_t i = 0;
  for (const auto& stroke : expected) {
    const auto& actual = batch[i++];
    assert(actual.action == stroke.action && actual.button == stroke.button);
    if (stroke.action == Action::move)
      assert(actual.point.x == stroke.point.x && actual.point.y == stroke.point.y);
  }
}

void shortDoubleClick() {
  WindowsMouse mouse;
  Recorder send;
  assert(mouse.button(0, true, anchor, true, threshold, 10, send) == Result::deferredPress);
  assert(mouse.move({-188, 486}, 15, send) == Result::suppressedMove);
  assert(send.batches.empty());
  assert(mouse.button(0, false, jump, false, {}, 25, send) == Result::trayClick);
  assert(mouse.button(0, true, anchor, true, threshold, 80, send) == Result::deferredPress);
  assert(mouse.button(0, false, jump, false, {}, 92, send) == Result::trayClick);
  assert(send.batches.size() == 2);
  for (const auto& batch : send.batches)
    expectBatch(batch, {{Action::move, anchor}, {Action::down}, {Action::up}});
  assert(mouse.release(send) && send.batches.size() == 2);
}

void intentionalDrags() {
  WindowsMouse mouse;
  Recorder send;
  assert(mouse.button(0, true, anchor, true, threshold, 10, send) == Result::deferredPress);
  assert(mouse.move({-192, 487}, 15, send) == Result::trayDragStart);
  expectBatch(send.batches[0], {{Action::move, anchor}, {Action::down}, {Action::move, {-192, 487}}});
  assert(mouse.move(anchor, 25, send) == Result::applied);
  assert(mouse.button(0, true, jump, false, {}, 27, send) == Result::deferredPress);
  assert(mouse.button(0, false, jump, false, {}, 30, send) == Result::applied);
  assert(send.batches.size() == 3);
  expectBatch(send.batches[1], {{Action::move, anchor}});
  expectBatch(send.batches[2], {{Action::move, jump}, {Action::up}});

  assert(mouse.button(0, true, anchor, false, {}, 40, send) == Result::applied);
  expectBatch(send.batches[3], {{Action::move, anchor}, {Action::down}});
  assert(mouse.move(jump, 45, send) == Result::applied);
  expectBatch(send.batches[4], {{Action::move, jump}});
  assert(mouse.button(0, false, jump, true, {}, 50, send) == Result::applied);
  expectBatch(send.batches[5], {{Action::up}});
}

void cancelAndExpire() {
  WindowsMouse mouse;
  Recorder send;
  assert(mouse.button(0, true, anchor, true, threshold, 10, send) == Result::deferredPress);
  assert(mouse.button(0, true, jump, false, {}, 20, send) == Result::deferredPress);
  assert(mouse.button(0, false, jump, false, {}, 30, send) == Result::trayClick);
  expectBatch(send.batches[0], {{Action::move, anchor}, {Action::down}, {Action::up}});

  assert(mouse.button(0, true, anchor, true, threshold, 40, send) == Result::deferredPress);
  assert(mouse.release(send));
  assert(mouse.button(0, false, jump, false, {}, 50, send) == Result::alreadyUp);
  assert(mouse.button(0, true, anchor, true, threshold, 60, send) == Result::deferredPress);
  const auto deadline = 60 + WindowsMouse::pendingTimeoutMs;
  assert(mouse.button(0, true, jump, false, {}, deadline - 1, send) == Result::deferredPress);
  assert(mouse.button(0, false, jump, false, {}, deadline, send) == Result::alreadyUp);
  assert(send.batches.size() == 1);
  assert(mouse.button(0, true, anchor, true, threshold, deadline + 1, send) == Result::deferredPress);
  assert(mouse.move(jump, deadline + 2, send) == Result::trayDragStart);
  assert(mouse.release(send));
  expectBatch(send.batches[2], {{Action::up}});
}

void partialClick() {
  for (std::size_t accepted : {0u, 1u, 2u}) {
    WindowsMouse mouse;
    Recorder send;
    send.accepted = {accepted, 1};
    assert(mouse.button(0, true, anchor, true, threshold, 10, send) == Result::deferredPress);
    assert(mouse.button(0, false, jump, false, {}, 20, send) == Result::rejected);
    assert(send.batches.size() == (accepted == 2 ? 2 : 1));
    if (accepted == 2) expectBatch(send.batches[1], {{Action::up}});
    assert(mouse.release(send));
    assert(send.batches.size() == (accepted == 2 ? 2 : 1));
  }
  WindowsMouse mouse;
  Recorder send;
  send.accepted = {2, 0, 0, 1};
  assert(mouse.button(0, true, anchor, true, threshold, 10, send) == Result::deferredPress);
  assert(mouse.button(0, false, jump, false, {}, 20, send) == Result::rejected);
  assert(!mouse.release(send));
  assert(mouse.release(send));
  assert(mouse.release(send));
  assert(send.batches.size() == 4);
  for (std::size_t i = 1; i < send.batches.size(); ++i)
    expectBatch(send.batches[i], {{Action::up}});
}

void partialDrag() {
  WindowsMouse mouse;
  Recorder send;
  send.accepted = {2, 1, 0, 1};
  assert(mouse.button(0, true, anchor, true, threshold, 10, send) == Result::deferredPress);
  assert(mouse.move(jump, 20, send) == Result::rejected); // Down queued, move did not.
  assert(mouse.button(0, false, jump, false, {}, 30, send) == Result::rejected);
  assert(mouse.release(send));
  assert(send.batches.size() == 4);
  expectBatch(send.batches[0], {{Action::move, anchor}, {Action::down}, {Action::move, jump}});
  expectBatch(send.batches[1], {{Action::move, jump}, {Action::up}});
  expectBatch(send.batches[2], {{Action::up}});
  expectBatch(send.batches[3], {{Action::up}});
}

void gestureDiagnostics() {
  std::vector<MouseDiagnostic> events;
  WindowsMouse mouse([&](const MouseDiagnostic& event) { events.push_back(event); });
  Recorder send;
  const auto check = [&](const char* step, uint64_t gesture, std::size_t requested,
                         std::size_t queued, bool held) -> const MouseDiagnostic& {
    const auto& event = events.back();
    assert(std::string_view(event.step) == step && event.gesture == gesture);
    assert(event.requested == requested && event.queued == queued && event.leftHeld == held);
    return event;
  };

  assert(mouse.move(anchor, 1, send) == Result::applied && events.empty());
  assert(mouse.button(0, true, anchor, true, threshold, 10, send) == Result::deferredPress);
  const auto& down = check("press-deferred", 1, 0, 0, false);
  assert(down.atMs == 10 && down.threshold && down.threshold->x == 4 && down.threshold->y == 6);
  for (uint64_t t = 11; t < 20; ++t)
    assert(mouse.move({-188, 486}, t, send) == Result::suppressedMove);
  assert(events.size() == 1);
  assert(mouse.button(0, false, jump, false, {}, 20, send) == Result::trayClick);
  const auto& click = check("click-submit", 1, 3, 3, false);
  assert(click.atMs == 20 && click.heldMs == 10 && click.suppressedMoves == 9);
  assert(click.delta.x == 31 && click.delta.y == 30);
  expectBatch(send.batches.back(), {{Action::move, anchor}, {Action::down}, {Action::up}});

  assert(mouse.button(0, true, anchor, true, threshold, 30, send) == Result::deferredPress);
  assert(mouse.button(0, true, anchor, true, threshold, 31, send) == Result::deferredPress);
  check("duplicate-pending-down", 2, 0, 0, false);
  assert(mouse.move({-192, 487}, 32, send) == Result::trayDragStart);
  const auto& drag = check("drag-start", 2, 3, 3, true);
  assert(drag.heldMs == 2 && drag.delta.x == 0 && drag.delta.y == 7);
  send.accepted = {1, 0, 1};
  assert(mouse.button(0, false, jump, false, {}, 40, send) == Result::rejected);
  assert(std::string_view(events[events.size() - 2].step) == "tray-move-up");
  assert(events[events.size() - 2].queued == 1);
  check("tray-up-cleanup", 2, 1, 0, true);
  assert(mouse.release(send, 52));
  assert(check("release-cleanup", 2, 1, 1, false).heldMs == 22);

  assert(mouse.button(0, true, anchor, true, {}, 60, send) == Result::applied);
  assert(!check("press-fallback-miss", 3, 1, 1, true).threshold);
  assert(mouse.button(0, false, anchor, true, {}, 65, send) == Result::applied);
  check("fallback-up", 3, 1, 1, false);
  assert(mouse.button(0, true, anchor, true, threshold, 70, send) == Result::deferredPress);
  assert(mouse.release(send, 72));
  check("pending-cancel-release", 4, 0, 0, false);
  assert(mouse.button(0, true, anchor, true, threshold, 80, send) == Result::deferredPress);
  assert(mouse.button(0, false, anchor, true, {}, 4080, send) == Result::alreadyUp);
  assert(check("pending-timeout", 5, 0, 0, false).heldMs == WindowsMouse::pendingTimeoutMs);
}

int main() {
  shortDoubleClick();
  intentionalDrags();
  cancelAndExpire();
  partialClick();
  partialDrag();
  gestureDiagnostics();
}
