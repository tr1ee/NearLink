import { test } from "node:test";
import assert from "node:assert/strict";
import { FrameTimings, InputFeedback } from "../src/media/feedback";
import { BoundedInputReceiver } from "../src/media/input";
const frame = (props: Partial<VideoFrameCallbackMetadata>) => ({
  expectedDisplayTime: 1000,
  presentationTime: 990,
  presentedFrames: 1,
  width: 1920,
  height: 1080,
  mediaTime: 1,
  ...props,
});
test("画面时间来自浏览器帧元数据，缺失或无效的估计不伪造为零", () => {
  const timing = new FrameTimings();
  timing.add(1000, frame({}));
  assert.deepEqual(timing.read(1000), {
    videoAgeMs: undefined,
    videoAgeP95Ms: undefined,
    receiveToPresentMs: undefined,
    receiveToSubmitMs: undefined,
    submitToDisplayMs: 10,
  });
  for (let i = 1; i <= 20; i++)
    timing.add(1000, frame({ captureTime: 1000 - i * 10, receiveTime: 970 }));
  timing.add(1000, frame({ captureTime: 1100, receiveTime: NaN }));
  assert.deepEqual(timing.read(1000), {
    videoAgeMs: 100,
    videoAgeP95Ms: 190,
    receiveToPresentMs: 30,
    receiveToSubmitMs: 20,
    submitToDisplayMs: 10,
  });
  assert.equal(timing.read(3001).videoAgeMs, undefined);
  for (let i = 0; i < 1000; i++)
    timing.add(4000, frame({ captureTime: i < 760 ? 1 : 990 }));
  assert.equal(timing.read(4000).videoAgeP95Ms, 10);
  timing.clear();
  assert.equal(timing.read(4000).videoAgeMs, undefined);
});
test("输入执行回执必须对应真正发送过的序号，缓存有界，断线/静止不显示陈旧低延迟", () => {
  const feedback = new InputFeedback();
  feedback.ack(1, 100);
  assert.equal(feedback.read(100), undefined);
  for (let i = 1; i <= 300; i++) feedback.remember(i, 100);
  feedback.ack(1, 200);
  assert.equal(feedback.read(200), undefined);
  feedback.ack(300, 225);
  assert.equal(feedback.read(225), 125);
  assert.equal(feedback.read(2226), undefined);
  feedback.clear();
  feedback.ack(299, 250);
  assert.equal(feedback.read(250), undefined);
});
test("执行反馈等待原生调用完成，被合并的移动与拒绝的输入不回执", async () => {
  const ack: number[] = [];
  let finish: (ok: boolean) => void = () => {};
  const q = new BoundedInputReceiver(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    (e) => {
      throw e;
    },
    () => 0,
    (event) => {
      if ("seq" in event) ack.push(event.seq!);
    },
  );
  for (let seq = 1; seq <= 3; seq++)
    q.push({ type: "move", x: 0.5, y: 0.5, seq });
  assert.deepEqual(ack, []);
  finish(true);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(ack, [1]);
  finish(false);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(ack, [1]);
  q.stop();
});
