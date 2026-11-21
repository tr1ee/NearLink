import { test } from "node:test";
import assert from "node:assert/strict";
import { captureTask } from "../src/media/capture-task";
import { DiscoveryLeases } from "../electron/discovery-leases";
import { runtimeNetworkOptions } from "../electron/network-options";
import { isMediaStage } from "../src/shared/media-diagnostics";

test("媒体阶段诊断只接受固定标签，不接受地址、SDP 或任意对象", () => {
  assert.equal(isMediaStage("source-ready"), true);
  assert.equal(isMediaStage("connection-connected"), true);
  for (const payload of [
    null,
    { stage: "source-ready", sdp: "synthetic private payload" },
    "source-ready 192.0.2.1",
    "offer-received\nv=0",
    "",
    1,
  ])
    assert.equal(isMediaStage(payload), false);
});
test("开发测试身份只监听回环且不广播，正式应用仍发现局域网", () => {
  assert.deepEqual(runtimeNetworkOptions("/test", false, true), {
    stateDirectory: "/test",
    discovery: false,
    listenHost: "127.0.0.1",
  });
  assert.equal(runtimeNetworkOptions("/formal", true, true).discovery, true);
  assert.equal(
    runtimeNetworkOptions("/formal", true, true).listenHost,
    "0.0.0.0",
  );
});
test("显式局域网调试保留独立身份目录，并开启监听与发现", () => {
  assert.deepEqual(runtimeNetworkOptions("/dev-profile", false, true, true), {
    stateDirectory: "/dev-profile",
    discovery: true,
    listenHost: "0.0.0.0",
  });
  assert.deepEqual(
    runtimeNetworkOptions("/test", false, true, false),
    runtimeNetworkOptions("/test", false, true),
  );
  assert.deepEqual(
    runtimeNetworkOptions("/formal", true, true, true),
    runtimeNetworkOptions("/formal", true, true),
  );
});

test("重复且未变更的DNS响应续租，离线身份到期移除而不按名字合并", () => {
  const l = new DiscoveryLeases();
  l.record("a", { fqdn: "same-a.local", ttl: 2 }, 0);
  l.record("b", { fqdn: "same-b.local", ttl: 2 }, 0);
  l.observe({ answers: [{ type: "TXT", name: "same-a.local", ttl: 2 }] }, 1500);
  assert.deepEqual(l.expired(2500), ["b"]);
  assert.deepEqual(l.expired(3600), ["a"]);
});
test("旧实例的离线广播不会取消新实例同一公钥的租约", () => {
  const l = new DiscoveryLeases();
  l.record("id", { fqdn: "old.local", ttl: 2 }, 0);
  l.record("id", { fqdn: "new.local", ttl: 2 }, 100);
  l.observe({ answers: [{ type: "PTR", data: "old.local", ttl: 0 }] }, 200);
  assert.deepEqual(l.expired(300), []);
  l.observe({ answers: [{ type: "PTR", data: "new.local", ttl: 0 }] }, 400);
  assert.deepEqual(l.expired(400), ["id"]);
});
test("取消不等待卡住的采集，晚到的流被立即释放", async () => {
  let resolve!: (s: { id: number }) => void;
  let disposed = 0;
  const controller = new AbortController();
  const operation = new Promise<{ id: number }>((r) => (resolve = r));
  const task = captureTask(operation, controller.signal, 500, () => disposed++);
  controller.abort();
  await assert.rejects(task, { name: "AbortError" });
  resolve({ id: 1 });
  await new Promise((r) => setImmediate(r));
  assert.equal(disposed, 1);
});
test("采集超时有界，超时后返回的资源也被释放", async () => {
  let resolve!: (s: number) => void,
    disposed = 0;
  const task = captureTask(
    new Promise<number>((r) => (resolve = r)),
    new AbortController().signal,
    10,
    () => disposed++,
  );
  await assert.rejects(task, { name: "TimeoutError" });
  resolve(1);
  await new Promise((r) => setImmediate(r));
  assert.equal(disposed, 1);
});
test("正常采集返回的资源所有权转交会话，不重复释放", async () => {
  let disposed = 0;
  const c = new AbortController();
  assert.equal(
    await captureTask(Promise.resolve(42), c.signal, 50, () => disposed++),
    42,
  );
  c.abort();
  assert.equal(disposed, 0);
});
