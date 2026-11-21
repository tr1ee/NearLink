import type { ChromiumMediaEngine } from "./engine";
import type { BenchmarkViewport } from "../shared/protocol";
export type LatencyResult = {
  samplesMs: number[];
  p50: number;
  p95: number;
  method: "native-input-to-rendered-response";
  at: string;
};
export function percentile(values: number[], p: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}
function readMarker(
  video: HTMLVideoElement,
  ctx: CanvasRenderingContext2D,
  viewport: BenchmarkViewport,
) {
  let magic = 0,
    id = 0;
  for (let i = 0; i < 32; i++) {
    const x = Math.round(
        video.videoWidth *
          (viewport.x + (0.01 + (i + 0.5) * 0.008) * viewport.width),
      ),
      y = Math.round(video.videoHeight * (viewport.y + 0.02 * viewport.height));
    ctx.drawImage(video, x, y, 1, 1, i, 0, 1, 1);
  }
  const pixels = ctx.getImageData(0, 0, 32, 1).data;
  for (let i = 0; i < 32; i++) {
    const bit =
      pixels[i * 4] + pixels[i * 4 + 1] + pixels[i * 4 + 2] > 380 ? 1 : 0;
    if (i < 16) magic = (magic << 1) | bit;
    else id = (id << 1) | bit;
  }
  return { magic, id };
}
export async function measureLatency(
  video: HTMLVideoElement,
  engine: ChromiumMediaEngine,
  signal: AbortSignal,
  onProgress: (n: number) => void,
  viewport: BenchmarkViewport,
): Promise<LatencyResult> {
  if (!video.videoWidth) throw new Error("尚未收到画面");
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const samples: number[] = [];
  for (let i = 0; i < 30; i++) {
    signal.throwIfAborted();
    const before = readMarker(video, ctx, viewport);
    if (before.magic !== 0x4e4c)
      throw new Error("请先打开对端性能测试画面，并确保它位于当前显示器。");
    const expected = (before.id + 1) & 65535;
    const start = performance.now();
    const x = viewport.x + viewport.width / 2,
      y = viewport.y + viewport.height / 2;
    engine.input({ type: "button", button: 0, down: true, x, y });
    engine.input({ type: "button", button: 0, down: false, x, y });
    const elapsed = await new Promise<number>((resolve, reject) => {
      let frame = 0;
      const cleanup = () => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", aborted);
        if (frame) video.cancelVideoFrameCallback(frame);
      };
      const aborted = () => {
        cleanup();
        reject(new Error("测试已取消"));
      };
      signal.addEventListener("abort", aborted, { once: true });
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("未收到对应输入的响应帧，测试已停止。"));
      }, 2500);
      const check = () => {
        if (signal.aborted) {
          aborted();
          return;
        }
        const marker = readMarker(video, ctx, viewport);
        if (marker.magic !== 0x4e4c) {
          cleanup();
          reject(new Error("对端测试画面已切走，停止发送测试输入。"));
          return;
        }
        if (marker.id === expected) {
          const elapsed = performance.now() - start;
          cleanup();
          resolve(elapsed);
        } else frame = video.requestVideoFrameCallback(check);
      };
      frame = video.requestVideoFrameCallback(check);
    });
    samples.push(elapsed);
    onProgress(i + 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return {
    samplesMs: samples,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    method: "native-input-to-rendered-response",
    at: new Date().toISOString(),
  };
}
