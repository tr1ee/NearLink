import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  mkdir,
  symlink,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mapPoint, videoPoint, captureSize } from "../src/shared/geometry";
test("4K为原生上限，1080p不放大，超宽和竖屏保持比例", () => {
  const d = {
    id: "1",
    name: "test",
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    scale: 1,
    rotation: 0,
    refreshRate: 240,
  };
  assert.deepEqual(captureSize(d, 2160), { width: 1920, height: 1080 });
  assert.deepEqual(captureSize({ ...d, width: 3840, height: 2160 }, 2160), {
    width: 3840,
    height: 2160,
  });
  assert.deepEqual(captureSize({ ...d, width: 5120, height: 1440 }, 2160), {
    width: 3840,
    height: 1080,
  });
  assert.deepEqual(captureSize({ ...d, width: 2160, height: 3840 }, 2160), {
    width: 2160,
    height: 3840,
  });
});
import {
  safeName,
  digestFile,
  finalizeFile,
  FileService,
  listing,
  fileLocations,
} from "../electron/files";
import { AdaptiveQuality } from "../src/media/adaptive";
import type { Metrics } from "../src/shared/protocol";
test("坐标映射尊重负坐标显示器边界和DPI逻辑坐标", () => {
  const d = {
    id: "1",
    name: "屏幕",
    x: -1920,
    y: 100,
    width: 1920,
    height: 1080,
    scale: 2,
    rotation: 0,
    refreshRate: 60,
  };
  assert.deepEqual(mapPoint(0, 0, d), { x: -1920, y: 100 });
  assert.deepEqual(mapPoint(1, 1, d), { x: -1, y: 1179 });
  assert.deepEqual(mapPoint(-1, 2, d), { x: -1920, y: 1179 });
});
test("只把实际视频区域映射到远端，拒绝上下黑边", () => {
  const r = { left: 0, top: 0, width: 1000, height: 1000 };
  assert.equal(videoPoint(500, 10, r, 1920, 1080), null);
  assert.deepEqual(videoPoint(500, 500, r, 1920, 1080), { x: 0.5, y: 0.5 });
  assert.equal(videoPoint(1, 1, r, 0, 0), null);
});
test("拒绝路径穿越、分隔符、Windows保留名和尾点", () => {
  for (const s of ["..", "a/b", "a\\b", "a\0b", ""])
    assert.throws(() => safeName(s));
  for (const s of ["CON", "aux.txt", "a:stream", "bad.", "bad "])
    assert.throws(() => safeName(s, "win32"));
  assert.equal(safeName("论文资料.zip", "win32"), "论文资料.zip");
});
test("同名文件保留原件并自动改名，完整性校验读取真实内容", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nearlink-file-"));
  try {
    await writeFile(path.join(dir, "report.txt"), "original");
    await writeFile(path.join(dir, ".part"), "received");
    const target = await finalizeFile(
      path.join(dir, ".part"),
      dir,
      "report.txt",
    );
    assert.equal(path.basename(target), "report (1).txt");
    assert.equal(
      await readFile(path.join(dir, "report.txt"), "utf8"),
      "original",
    );
    assert.equal(await readFile(target, "utf8"), "received");
    assert.equal(
      (await digestFile(target)).hash,
      "318c5ad51e9b36ff5924ae323dd59031245413a3e0f2aa3e03cc42902e9e7acc",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("目录清单保留空目录、忽略链接和未完成传输文件", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nearlink-tree-"));
  try {
    await mkdir(path.join(dir, "empty"));
    await writeFile(path.join(dir, "hello.txt"), "hi");
    await writeFile(path.join(dir, ".nearlink-hidden.part"), "partial");
    await symlink(path.join(dir, "hello.txt"), path.join(dir, "alias"));
    const service = new FileService({} as any);
    const manifest = await service.manifest(dir);
    assert(manifest.some((e) => e.relative === "empty" && e.directory));
    assert(manifest.some((e) => e.relative === "hello.txt" && e.size === 2));
    assert(
      !manifest.some(
        (e) => e.relative === "alias" || e.relative.includes("nearlink-hidden"),
      ),
    );
    const l = await listing(dir);
    assert(
      !l.entries.some(
        (e) => e.name === "alias" || e.name.includes("nearlink-hidden"),
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("拥塞先降码率，再降分辨率，恢复存在滞后", () => {
  const q = new AdaptiveQuality({ height: 2160, fps: 60, auto: true });
  const m = {
    rttMs: 80,
    loss: 0.1,
    jitterMs: 60,
    encodeMs: 3,
    encodeFps: 60,
  } as Metrics;
  let last: any;
  for (let i = 1; i <= 18; i++) {
    const previousRate = q.bitrate;
    last = q.sample(m, i * 3000) ?? last;
    assert(q.bitrate <= previousRate, "拥塞降档不能提高码率");
  }
  assert(q.bitrate < 45e6);
  assert(q.height < 2160);
  assert.equal(q.fps, 60);
  const h = q.height;
  q.sample({ ...m, rttMs: 2, loss: 0, jitterMs: 1 }, 100000);
  assert.equal(q.height, h);
  assert.equal(
    new AdaptiveQuality({ height: 2160, fps: 60, auto: false }).sample(
      m,
      10000,
    ),
    null,
  );
});
test("静态桌面的低帧率不会被误判为编码拥塞", () => {
  const q = new AdaptiveQuality({ height: 2160, fps: 60, auto: true });
  const m = {
    rttMs: 2,
    loss: 0,
    jitterMs: 1,
    encodeMs: 90,
    encodeFps: 2,
    captureFps: 2,
  } as Metrics;
  for (let i = 1; i < 20; i++) q.sample(m, i * 3000);
  assert.equal(q.height, 2160);
  assert(q.bitrate >= 45_000_000 * 0.65 && q.bitrate <= 45_000_000);
});
test("稳定Wi-Fi延迟与播放缓冲不会触发分辨率下降，持续丢包仍会降档", () => {
  const q = new AdaptiveQuality({ height: 2160, fps: 60, auto: true });
  const m = {
    rttMs: 55,
    loss: 0,
    jitterMs: 3,
    jitterBufferMs: 120,
    encodeMs: 4,
    encodeFps: 60,
    captureFps: 60,
  } as Metrics;
  for (let i = 1; i < 35; i++) q.sample(m, i * 3000);
  assert.equal(q.height, 2160);
  assert(q.bitrate >= 45e6 * 0.65 && q.bitrate <= 45e6);
  for (let i = 35; i < 60; i++) q.sample({ ...m, loss: 0.08 }, i * 3000);
  assert(q.height < 2160);
});
test("文件夹快捷位置使用系统传入的真实目录并排除不存在的位置", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nearlink-locations-"));
  try {
    const desktop = path.join(dir, "OneDrive", "桌面");
    await mkdir(desktop, { recursive: true });
    const locations = await fileLocations({
      desktop,
      documents: path.join(dir, "missing"),
      downloads: dir,
    });
    assert(locations.some((p) => p.name === "桌面" && p.path === desktop));
    assert(!locations.some((p) => p.name === "文稿"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
