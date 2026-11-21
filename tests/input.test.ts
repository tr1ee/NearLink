import { test } from "node:test";
import assert from "node:assert/strict";
import { LatestMotionSender, BoundedInputReceiver } from "../src/media/input";
import { AdaptiveQuality } from "../src/media/adaptive";
import type { InputEvent, Metrics } from "../src/shared/protocol";
const move = (seq: number): InputEvent & { type: "move" } => ({
  type: "move",
  seq,
  x: seq / 1000,
  y: 0.5,
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function fakeClock() {
  let now = 0;
  const timers = new Map<number, { fn: () => void; at: number }>();
  let id = 0;
  return {
    now: () => now,
    later(fn: () => void, ms: number) {
      timers.set(++id, { fn, at: now + ms });
      return id;
    },
    cancel(id: number) {
      timers.delete(id);
    },
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers])
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
    },
    timers,
  };
}
test("鼠标首包立即发送，后续4ms合并最新位置，不等待视频刷新", () => {
  const c = fakeClock(),
    sent: number[] = [];
  const sender = new LatestMotionSender((e) => {
    sent.push(e.seq);
    return true;
  }, c);
  sender.push(move(1));
  assert.deepEqual(sent, [1]);
  for (let i = 2; i <= 200; i++) sender.push(move(i));
  assert.equal(c.timers.size, 1);
  c.advance(4);
  assert.deepEqual(sent, [1, 200]);
  assert.equal(c.timers.size, 0);
});
test("发送端背压只保留最后位置，恢复后补发，点击清除旧移动", () => {
  const c = fakeClock(),
    sent: number[] = [];
  let available = false;
  const sender = new LatestMotionSender((e) => {
    if (!available) return false;
    sent.push(e.seq);
    return true;
  }, c);
  for (let i = 1; i <= 300; i++) sender.push(move(i));
  assert.equal(c.timers.size, 1);
  available = true;
  c.advance(4);
  assert.deepEqual(sent, [300]);
  sender.push(move(301));
  sender.clear();
  c.advance(4);
  assert.deepEqual(sent, [300]);
});
test("被控端忙碌时只允许一次原生IPC及一个最新移动，最终位置不丢失", async () => {
  const applied: InputEvent[] = [];
  let done: () => void = () => {};
  let active = 0,
    peak = 0;
  const q = new BoundedInputReceiver(
    (e) => {
      applied.push(e);
      active++;
      peak = Math.max(peak, active);
      return new Promise<void>((resolve) => {
        done = () => {
          active--;
          resolve();
        };
      });
    },
    (e) => {
      throw e;
    },
  );
  q.push(move(1));
  for (let i = 2; i <= 500; i++) q.push(move(i));
  assert.equal(applied.length, 1);
  assert.equal(q.coalesced, 498);
  done();
  await tick();
  assert.deepEqual(
    applied.map((e) => ("seq" in e ? e.seq : 0)),
    [1, 500],
  );
  assert.equal(peak, 1);
  q.stop();
  done();
  await tick();
});
test("点击优先于旧移动，跨通道迟到的旧移动不回弹", async () => {
  const applied: InputEvent[] = [];
  let done: () => void = () => {};
  const q = new BoundedInputReceiver(
    (e) => {
      applied.push(e);
      return new Promise<void>((r) => (done = r));
    },
    (e) => {
      throw e;
    },
  );
  q.push(move(1));
  q.push(move(2));
  q.push({ type: "button", seq: 3, button: 0, down: true, x: 0.5, y: 0.5 });
  q.push(move(2));
  done();
  await tick();
  assert.equal(applied[1].type, "button");
  done();
  await tick();
  assert.equal(applied.length, 2);
  q.stop();
});
test("较新移动抢先到达仍必须执行可靠按下和抬起，保留拖拽终点", async () => {
  const applied: InputEvent[] = [];
  let done: () => void = () => {};
  const q = new BoundedInputReceiver(
    (e) => {
      applied.push(e);
      return new Promise<void>((r) => (done = r));
    },
    (e) => {
      throw e;
    },
  );
  q.push(move(1));
  q.push(move(4));
  q.push({ type: "button", seq: 2, button: 0, down: true, x: 0.2, y: 0.5 });
  q.push({ type: "button", seq: 3, button: 0, down: false, x: 0.3, y: 0.5 });
  for (let i = 0; i < 4; i++) {
    done();
    await tick();
  }
  assert.deepEqual(
    applied.map((e) => ("seq" in e ? e.seq : 0)),
    [1, 2, 3, 4],
  );
  q.stop();
});
test("输入过载与失焦优先释放按键，停止后不执行积压", async () => {
  const applied: InputEvent[] = [];
  let done: () => void = () => {};
  let errors = 0;
  const q = new BoundedInputReceiver(
    (e) => {
      applied.push(e);
      return new Promise<void>((r) => (done = r));
    },
    () => errors++,
  );
  q.push(move(1));
  for (let i = 0; i < 130; i++)
    q.push({ type: "key", code: "KeyA", down: true });
  q.push({ type: "release", seq: 200 });
  done();
  await tick();
  assert.equal(errors, 1);
  assert.equal(applied[1].type, "release");
  q.stop();
  q.push(move(201));
  done();
  await tick();
  assert.equal(applied.length, 2);
});
test("松键后的移动先到达时，必须等到松键实际执行", async () => {
  const applied: InputEvent[] = [];
  let finishUp!: (result: string) => void;
  const receiver = new BoundedInputReceiver(
    async (event) => {
      applied.push(event);
      if (event.type === "button" && !event.down)
        return new Promise<string>((resolve) => {
          finishUp = resolve;
        });
      return "applied";
    },
    (error) => {
      throw error;
    },
  );
  receiver.push({
    type: "button",
    button: 0,
    down: true,
    x: 0.5,
    y: 0.5,
    seq: 1,
  });
  await tick();
  receiver.push({ ...move(4), afterButton: 3 });
  assert.deepEqual(
    applied.map((event) => event.type),
    ["button"],
  );
  receiver.push({
    type: "button",
    button: 0,
    down: false,
    x: 0.5,
    y: 0.5,
    seq: 3,
  });
  receiver.push({ ...move(5), afterButton: 1 });
  assert.deepEqual(
    applied.map((event) => event.type),
    ["button", "button"],
  );
  finishUp("applied");
  await tick();
  assert.equal(applied.length, 3);
  assert.deepEqual(applied.at(-1), { ...move(4), afterButton: 3 });
  assert.equal(receiver.buttons.appliedUp, 1);
});
test("区分系统拒绝和输入进程不可用，失败后仍执行释放", async () => {
  const applied: string[] = [];
  let failures = 0;
  const receiver = new BoundedInputReceiver(
    async (event) => {
      applied.push(event.type);
      if (event.type === "button" && event.down) return "native-rejected";
      if (event.type === "button") throw Error("worker exited");
      return "applied";
    },
    () => failures++,
  );
  const click = { type: "button", button: 0, x: 0.5, y: 0.5 } as const;
  receiver.push({ ...click, down: true, seq: 1 });
  receiver.push({ ...click, down: false, seq: 2 });
  await tick();
  receiver.push({ type: "release", seq: 3 });
  await tick();
  assert.deepEqual(applied, ["button", "button", "release"]);
  assert.equal(receiver.buttons.down, 1);
  assert.equal(receiver.buttons.up, 1);
  assert.equal(receiver.buttons.nativeRejected, 1);
  assert.equal(receiver.buttons.unavailable, 1);
  assert.equal(failures, 1);
});
test("托盘按下暂存不回执行回执，成对点击和提交拖拽才计已执行按下", async () => {
  const acknowledged: InputEvent[] = [];
  const receiver = new BoundedInputReceiver(
    async (event) => {
      if (event.type === "move")
        return event.seq === 6 ? "tray-drag-start" : "suppressed-move";
      if (event.type === "button" && event.down) return "deferred-press";
      return event.type === "button" && event.seq === 4
        ? "tray-click"
        : "already-up";
    },
    (error) => {
      throw error;
    },
    undefined,
    (event) => acknowledged.push(event),
  );
  receiver.push({
    type: "button",
    button: 0,
    down: false,
    x: 0.5,
    y: 0.5,
    seq: 1,
  });
  const press = {
    type: "button",
    button: 0,
    down: true,
    x: 0.5,
    y: 0.5,
  } as const;
  receiver.push({ ...press, seq: 2 });
  receiver.push({ ...move(3), afterButton: 2 });
  await tick();
  assert.equal(receiver.buttons.appliedDown, 0);
  assert.deepEqual(acknowledged, []);
  const click = {
    type: "button",
    button: 0,
    down: false,
    x: 0.5,
    y: 0.5,
    seq: 4,
  } as const;
  receiver.push(click);
  await tick();
  assert.equal(receiver.buttons.up, 2);
  assert.equal(receiver.buttons.alreadyUp, 1);
  assert.equal(receiver.buttons.appliedDown, 1);
  assert.equal(receiver.buttons.appliedUp, 1);
  assert.equal(receiver.buttons.trayClicks, 1);
  assert.equal(receiver.buttons.unavailable, 0);
  assert.deepEqual(acknowledged, [click]);
  receiver.push({ ...press, seq: 5 });
  const drag = { ...move(6), afterButton: 5 };
  receiver.push(drag);
  await tick();
  assert.equal(receiver.buttons.appliedDown, 2);
  assert.equal(receiver.buttons.deferredDowns, 2);
  assert.deepEqual(acknowledged, [click, drag]);
});
const metrics = {
  rttMs: 5,
  loss: 0,
  jitterMs: 1,
  captureFps: 60,
  encodeFps: 60,
  encodeMs: 2,
} as Metrics;
test("低抖动也响应持续RTT增长，稳定高RTT不会触发降档", () => {
  const q = new AdaptiveQuality({ height: 2160, fps: 60, auto: true });
  q.sample(metrics, 10000);
  const initial = q.bitrate;
  for (let i = 1; i <= 4; i++)
    q.sample({ ...metrics, rttMs: 90 }, 10000 + i * 3000);
  assert(q.bitrate < initial);
  assert.equal(q.height, 2160);
  const stable = new AdaptiveQuality({ height: 2160, fps: 60, auto: true });
  for (let i = 0; i < 20; i++)
    stable.sample({ ...metrics, rttMs: 90 }, 10000 + i * 3000);
  assert.equal(stable.height, 2160);
  assert(stable.bitrate >= initial);
});
test("1080p源不使用4K码率预算，发送排队持续增加时先降码率", () => {
  const q = new AdaptiveQuality(
    { height: 2160, fps: 60, auto: true },
    { pixels: 1920 * 1080, fps: 60 },
  );
  assert.equal(q.ceiling(), 14e6);
  assert.equal(q.bitrate, 9.1e6);
  for (let i = 0; i < 3; i++)
    q.sample({ ...metrics, sendQueueMs: 70 }, 10000 + i * 3000);
  assert(q.bitrate < 9.1e6);
  assert.equal(q.height, 2160);
});
test("编码过载直接减轻像素负担，不等待多轮无效降码率", () => {
  const q = new AdaptiveQuality({ height: 2160, fps: 60, auto: true });
  for (let i = 0; i < 3; i++)
    q.sample(
      { ...metrics, encodeFps: 25, encodeMs: 30, qualityReason: "cpu" },
      10000 + i * 3000,
    );
  assert.equal(q.height, 1440);
  assert.equal(q.fps, 60);
  assert(q.bitrate <= q.ceiling());
});
