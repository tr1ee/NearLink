import { test } from "node:test";
import assert from "node:assert/strict";
import { InputState, type InputScope } from "../electron/input-state";
const scope: InputScope = {
  sessionId: "session",
  allowed: true,
  display: { x: -3840, y: 100, width: 3840, height: 2160 },
};
test("独立输入进程只执行当前授权会话，撤权/换会话释放按键", () => {
  const events: any[] = [],
    s = new InputState((e) => {
      events.push(e);
      return true;
    });
  assert.equal(
    s.apply("session", { type: "key", code: "KeyA", down: true }),
    false,
  );
  s.configure(scope);
  events.length = 0;
  assert.equal(
    s.apply("wrong", { type: "key", code: "KeyA", down: true }),
    false,
  );
  s.apply("session", { type: "key", code: "KeyA", down: true });
  s.configure({ ...scope, allowed: false });
  assert.deepEqual(
    events.map((e) => e.type),
    ["key", "release"],
  );
  assert.equal(
    s.apply("session", { type: "key", code: "KeyA", down: true }),
    false,
  );
});
test("物理坐标涵盖负坐标/DPI屏幕边界，迟到移动不能吞掉按钮抬起", () => {
  const events: any[] = [],
    s = new InputState((e) => {
      events.push(e);
      return true;
    });
  s.configure(scope);
  events.length = 0;
  s.apply("session", { type: "move", seq: 10, x: 1, y: 1 });
  assert.equal(events[0].screenX, -1);
  assert.equal(events[0].screenY, 2259);
  assert.equal(s.apply("session", { type: "move", seq: 9, x: 0, y: 0 }), false);
  assert.equal(
    s.apply("session", {
      type: "button",
      seq: 8,
      x: 0,
      y: 0,
      button: 0,
      down: false,
    }),
    true,
  );
  assert.equal(events.at(-1).screenX, -3840);
  assert.equal(events.at(-1).screenY, 100);
});
test("渲染器直连心跳维持授权，失去心跳或停止会话后自动释放并拒绝输入", () => {
  const events: any[] = [],
    s = new InputState((e) => {
      events.push(e);
      return true;
    });
  s.configure(scope);
  const now = Date.now();
  s.heartbeat("session", now + 3000);
  s.expire(now + 5000);
  assert.equal(s.apply("session", { type: "release" }), true);
  s.expire(Date.now() + 5000);
  assert.equal(events.at(-1).type, "release");
  assert.equal(s.apply("session", { type: "release" }), false);
  s.heartbeat("old-session");
  assert.equal(s.apply("session", { type: "release" }), false);
  s.heartbeat("session");
  assert.equal(s.apply("session", { type: "release" }), true);
  s.configure(scope);
  s.stop("old-session");
  assert.equal(s.apply("session", { type: "release" }), true);
  s.stop("session");
  s.heartbeat("session");
  assert.equal(s.apply("session", { type: "release" }), false);
});
test("Windows 拒绝松键后保留清理状态，允许时重试安全释放", () => {
  let blocked = false;
  const events: string[] = [];
  const state = new InputState((event) => {
    events.push(event.type);
    return !blocked;
  });
  state.configure(scope);
  const button = { type: "button", button: 0, x: 0.5, y: 0.5 };
  assert.equal(
    state.applyResult("session", { ...button, down: true }),
    "applied",
  );
  blocked = true;
  assert.equal(
    state.applyResult("session", { ...button, down: false }),
    "native-rejected",
  );
  assert.equal(
    state.applyResult("session", { type: "move", x: 0, y: 0, seq: 1 }),
    "native-rejected",
  );
  blocked = false;
  state.expire();
  assert.deepEqual(events.slice(-3), ["release", "release", "release"]);
  assert.equal(
    state.applyResult("session", { type: "move", x: 0, y: 0, seq: 2 }),
    "applied",
  );
});
test("原生结果区分过滤的移动和无需注入的重复松键", () => {
  const received: string[] = [];
  const state = new InputState((event) => {
    received.push(event.type);
    if (event.type === "move") return "suppressed-move";
    if (event.type === "button" && !event.down) return "already-up";
    return true;
  });
  state.configure(scope);
  received.length = 0;
  assert.equal(
    state.applyResult("session", { type: "move", seq: 1, x: 0.5, y: 0.5 }),
    "suppressed-move",
  );
  assert.equal(
    state.applyResult("session", {
      type: "button",
      button: 0,
      seq: 2,
      down: false,
      x: 0.5,
      y: 0.5,
    }),
    "already-up",
  );
  assert.deepEqual(received, ["move", "button"]);
});
