import { test } from "node:test";
import assert from "node:assert/strict";
import { interactiveVideoTrials } from "../electron/media-policy";

test("即时视频策略保留其他trial，只替换接收播放策略且不重复", () => {
  const policy = "WebRTC-ForcePlayoutDelay/min_ms:0,max_ms:0/";
  assert.equal(interactiveVideoTrials(""), policy);
  const existing =
    "WebRTC-Other/Enabled/WebRTC-ForcePlayoutDelay/min_ms:70,max_ms:90/";
  assert.equal(
    interactiveVideoTrials(existing),
    `WebRTC-Other/Enabled/${policy}`,
  );
  assert.equal(
    interactiveVideoTrials(interactiveVideoTrials(existing)),
    `WebRTC-Other/Enabled/${policy}`,
  );
});
