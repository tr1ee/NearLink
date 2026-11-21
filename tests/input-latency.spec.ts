import {
  test,
  expect,
  _electron as electron,
  type Page,
} from "@playwright/test";
import { build } from "esbuild";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
test("隐藏窗口真实WebRTC：输入反馈、原生分辨率、独立音画与有界鼠标队列", async () => {
  // Used only by the isolated A/B control experiment, never by the app.
  const bufferControl = process.env.NEARLINK_TEST_BUFFER_CONTROL === "1";
  test.setTimeout(90000);
  const root = await mkdtemp(path.join(process.cwd(), "work/input-e2e-"));
  const bundle = await build({
    entryPoints: ["src/media/engine.ts"],
    bundle: true,
    format: "iife",
    globalName: "TestMedia",
    write: false,
    plugins: [
      {
        name: "worklet",
        setup(b) {
          b.onResolve({ filter: /pcm-worklet\.js\?url$/ }, () => ({
            path: "test",
            namespace: "worklet",
          }));
          b.onLoad({ filter: /.*/, namespace: "worklet" }, () => ({
            contents: 'export default ""',
            loader: "js",
          }));
        },
      },
    ],
  });
  const filename = path.join(root, "media.html");
  await writeFile(
    filename,
    '<!doctype html><title>NearLink 隔离媒体测试</title><style>body{margin:0;background:#101216;color:white;font:16px system-ui}video{width:960px;height:540px}canvas{display:none}</style><video autoplay playsinline muted></video><canvas width="1920" height="1080"></canvas>',
  );
  const app = await electron.launch({
    executablePath: process.env.NEARLINK_ELECTRON_EXECUTABLE,
    args: [
      process.cwd(),
      "--background",
      ...(process.env.NEARLINK_TEST_COMPOSITOR_IMMEDIATE
        ? ["--disable-rtc-smoothness-algorithm"]
        : []),
    ],
    env: { ...process.env, NEARLINK_USER_DATA: path.join(root, "profile") },
    timeout: 30000,
  });
  const errors: string[] = [];
  try {
    const ids = await app.evaluate(async ({ BrowserWindow }, filename) => {
      const ids: number[] = [];
      for (let i = 0; i < 2; i++) {
        const w = new BrowserWindow({
          show: false,
          width: 1000,
          height: 650,
          webPreferences: {
            backgroundThrottling: false,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
          },
        });
        await w.loadFile(filename);
        ids.push(w.webContents.id);
      }
      return ids;
    }, filename);
    const pages = await Promise.all(
      ids.map(async (id) => {
        let selected: Page | undefined;
        await expect
          .poll(
            async () => {
              for (const p of app.windows()) {
                if (p.url() !== pathToFileURL(filename).href) continue;
                const w = await app.browserWindow(p);
                if ((await w.evaluate((w) => w.webContents.id)) === id) {
                  selected = p;
                  return true;
                }
              }
              return false;
            },
            { timeout: 10000 },
          )
          .toBe(true);
        return selected!;
      }),
    );
    const [host, controller] = pages;
    for (const [index, page] of pages.entries()) {
      page.on("pageerror", (e) => errors.push(e.message));
      await page.exposeFunction("forwardSignal", async (signal: any) => {
        await pages[index === 0 ? 1 : 0].evaluate((signal) => {
          for (const fn of (window as any).listeners.get("media") ?? [])
            fn(signal);
        }, signal);
      });
      await page.evaluate(
        ({ role }) => {
          const w = window as any;
          w.listeners = new Map();
          w.applied = [];
          w.delay = 0;
          w.marker = 0;
          w.info = {
            id: "latency-fixture",
            role,
            peerId: "isolated-peer",
            viewOnly: false,
            state: "connected",
            remotePlatform: "test",
            localRefreshRate: 60,
            allow120: false,
            displayId: "test",
            displays: [
              {
                id: "test",
                name: "Synthetic1080",
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
                scale: 1,
                rotation: 0,
                refreshRate: 60,
              },
            ],
            quality: { height: 2160, fps: 60, auto: true },
          };
          w.nearlink = {
            windowKind: role === "host" ? "host" : "remote",
            peerId: "isolated-peer",
            on(topic: string, fn: any) {
              if (!w.listeners.has(topic)) w.listeners.set(topic, new Set());
              w.listeners.get(topic).add(fn);
              return () => w.listeners.get(topic).delete(fn);
            },
            async invoke(method: string, ...args: any[]) {
              if (method === "media.signal") return w.forwardSignal(args[0]);
              if (method === "state") return { session: w.info };
              if (method === "source")
                return {
                  session: w.info,
                  sourceId: "canvas",
                  platform: "test",
                };
              if (method === "media.error") {
                w.failures ??= [];
                w.failures.push(args[0]);
                return;
              }
              if (method === "media.input") {
                if (w.delay) await new Promise((r) => setTimeout(r, w.delay));
                w.applied.push(args[1]);
                if (args[1].x !== undefined) w.marker = args[1].x;
                return true;
              }
              return true;
            },
          };
          if (role === "host") {
            const c = document.querySelector("canvas")!,
              ctx = c.getContext("2d")!;
            let frame = 0;
            w.paint = setInterval(() => {
              ctx.fillStyle = "#243247";
              ctx.fillRect(0, 0, c.width, c.height);
              ctx.fillStyle = "#2a7bce";
              ctx.fillRect((frame++ * 12) % 1800, 300, 120, 200);
              ctx.fillStyle = w.marker > 0.5 ? "white" : "black";
              ctx.fillRect(0, 0, 300, 300);
            }, 1000 / 60);
            w.captureConstraints = 0;
            w.audioContext = new AudioContext({ latencyHint: "interactive" });
            const oscillator = w.audioContext.createOscillator(),
              gain = w.audioContext.createGain();
            gain.gain.value = 0;
            oscillator.connect(gain);
            oscillator.start();
            Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
              value: async () => {
                const stream = c.captureStream(60);
                const track = stream.getVideoTracks()[0];
                const apply = track.applyConstraints.bind(track);
                track.applyConstraints = (constraints) => {
                  w.captureConstraints++;
                  return apply(constraints);
                };
                const out = w.audioContext.createMediaStreamDestination();
                gain.connect(out);
                stream.addTrack(out.stream.getAudioTracks()[0]);
                return stream;
              },
            });
          }
        },
        { role: index === 0 ? "host" : "controller" },
      );
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
    }
    await host.evaluate(async () => {
      const w = window as any;
      w.engine = new w.TestMedia.ChromiumMediaEngine();
      await w.engine.start(w.info);
    });
    await controller.evaluate(async () => {
      const w = window as any;
      w.engine = new w.TestMedia.ChromiumMediaEngine(
        document.querySelector("video"),
      );
      w.metricSamples = [];
      w.engine.onStats = (m: any) => w.metricSamples.push(m);
      await w.engine.start(w.info);
    });
    await expect
      .poll(
        () =>
          controller.evaluate(() => {
            const w = window as any;
            return (
              document.querySelector("video")!.videoWidth === 1920 &&
              w.engine.control?.readyState === "open"
            );
          }),
        { timeout: 20000 },
      )
      .toBe(true);
    // Service input must carry the epoch delivered over the host's actual
    // accepted channel. A separate feedbackChannel reference alone left the
    // production epoch announcer without a channel and all input was rejected.
    await host.evaluate(() => {
      const engine = (window as any).engine;
      if (engine.control?.readyState !== "open")
        throw Error("host control channel was not retained");
      engine.announceDesktop(7);
    });
    await expect
      .poll(() =>
        controller.evaluate(() => (window as any).engine.desktopEpoch),
      )
      .toBe(7);
    await controller.evaluate(() =>
      (window as any).engine.input({ type: "key", code: "KeyA", down: false }),
    );
    await expect
      .poll(() =>
        host.evaluate(() => (window as any).applied.at(-1)?.desktopEpoch),
      )
      .toBe(7);
    await expect
      .poll(
        () =>
          controller.evaluate(
            () => (window as any).engine.stats()?.inputRttMs !== undefined,
          ),
        { timeout: 10000 },
      )
      .toBe(true);
    await expect
      .poll(
        () =>
          controller.evaluate(
            () =>
              (window as any).metricSamples?.filter((m: any) => m.seconds > 3)
                .length ?? 0,
          ),
        { timeout: 15000 },
      )
      .toBeGreaterThanOrEqual(4);
    const samples = await controller.evaluate(async () => {
      const w = window as any,
        v = document.querySelector("video")!,
        c = document.createElement("canvas");
      c.width = c.height = 1;
      const ctx = c.getContext("2d", { willReadFrequently: true })!;
      const samples: number[] = [];
      for (let i = 0; i < 14; i++) {
        const white = i % 2 === 0,
          start = performance.now();
        w.engine.input({ type: "move", x: white ? 0.8 : 0.2, y: 0.5, seq: 0 });
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(Error("Input feedback timeout")),
            2500,
          );
          const next = () => {
            ctx.drawImage(v, 100, 100, 1, 1, 0, 0, 1, 1);
            const value = ctx.getImageData(0, 0, 1, 1).data[0];
            if (white ? value > 220 : value < 30) {
              clearTimeout(timeout);
              resolve();
            } else v.requestVideoFrameCallback(next);
          };
          v.requestVideoFrameCallback(next);
        });
        if (i >= 2) samples.push(performance.now() - start);
      }
      return samples;
    });
    const presentation = await controller.evaluate(() => {
      const w = window as any;
      w.engine.setVolume(0.35);
      const v = document.querySelector("video")!;
      return {
        videoAudioTracks: (v.srcObject as MediaStream).getAudioTracks().length,
        audioTracks: (
          w.engine.audioPlayer?.srcObject as MediaStream
        )?.getAudioTracks().length,
        volume: w.engine.audioPlayer?.volume,
        metrics: w.engine.stats(),
        dynamicSamples: w.metricSamples.filter((m: any) => m.seconds > 3),
        width: v.videoWidth,
        height: v.videoHeight,
      };
    });
    expect(presentation.videoAudioTracks).toBe(0);
    expect(presentation.audioTracks).toBe(1);
    expect(presentation.volume).toBe(0.35);
    expect(presentation.metrics.videoCodec).toBe("H264");
    expect(presentation.metrics.mediaTransport).toMatch(/^UDP/);

    // A zero API hint alone cannot cap native playout. Deliberately request
    // 160ms on the receiver: production's native max=0 must still win. Without
    // the startup policy this test reproduces a ~160ms video buffer.
    const playoutPolicy = await app.evaluate(({ app }) =>
      app.commandLine.getSwitchValue("force-fieldtrials"),
    );
    if (bufferControl)
      expect(playoutPolicy).not.toContain("WebRTC-ForcePlayoutDelay");
    else
      expect(playoutPolicy).toContain(
        "WebRTC-ForcePlayoutDelay/min_ms:0,max_ms:0/",
      );
    const forcedPlayout = await controller.evaluate(async () => {
      const w = window as any;
      const receiver = w.engine.pc
        .getReceivers()
        .find((r: RTCRtpReceiver) => r.track.kind === "video");
      receiver.jitterBufferTarget = 160;
      const read = async () => {
        const report = await receiver.getStats();
        let video: any;
        report.forEach((s: any) => {
          if (s.type === "inbound-rtp" && s.kind === "video") video = s;
        });
        return video;
      };
      await new Promise((r) => setTimeout(r, 1500));
      const before = await read();
      await new Promise((r) => setTimeout(r, 2500));
      const after = await read();
      const count =
        after.jitterBufferEmittedCount - before.jitterBufferEmittedCount;
      receiver.jitterBufferTarget = 0;
      return {
        requestedMs: 160,
        emitted: count,
        actualBufferMs:
          (1000 * (after.jitterBufferDelay - before.jitterBufferDelay)) / count,
        targetMs:
          (1000 *
            (after.jitterBufferTargetDelay - before.jitterBufferTargetDelay)) /
          count,
      };
    });
    expect(forcedPlayout.emitted).toBeGreaterThan(30);
    if (bufferControl)
      expect(forcedPlayout.actualBufferMs).toBeGreaterThan(100);
    else {
      expect(forcedPlayout.actualBufferMs).toBeLessThan(25);
      expect(forcedPlayout.targetMs).toBeLessThan(25);
    }

    const bitrateOnly = await host.evaluate(async () => {
      const w = window as any;
      const constraints = w.captureConstraints;
      const before = w.engine.adaptive.bitrate;
      w.engine.remoteMetrics.loss = 0.08;
      for (let i = 0; i < 3; i++) await w.engine.collect();
      w.engine.remoteMetrics.loss = 0;
      return {
        before,
        after: w.engine.adaptive.bitrate,
        constraintsBefore: constraints,
        constraintsAfter: w.captureConstraints,
      };
    });
    expect(bitrateOnly.after).toBeLessThan(bitrateOnly.before);
    expect(bitrateOnly.constraintsAfter).toBe(bitrateOnly.constraintsBefore);
    await host.evaluate(() => {
      const w = window as any;
      w.delay = 25;
      w.applied = [];
    });
    await controller.evaluate(async () => {
      const w = window as any;
      for (let i = 1; i <= 200; i++) {
        w.engine.input({ type: "move", x: i / 201, y: 0.5, seq: 0 });
        await new Promise((r) => setTimeout(r, 1));
      }
      w.engine.input({ type: "button", button: 0, down: true, x: 0.9, y: 0.5 });
      w.engine.input({ type: "button", button: 0, down: false, x: 1, y: 0.5 });
    });
    await expect
      .poll(() => host.evaluate(() => (window as any).applied.at(-1)?.x), {
        timeout: 5000,
      })
      .toBe(1);
    const applied = await host.evaluate(() => (window as any).applied);
    expect(
      applied.filter((e: any) => e.type === "button").map((e: any) => e.down),
    ).toEqual([true, false]);
    expect(applied.length).toBeLessThan(100);
    await expect
      .poll(() =>
        controller.evaluate(
          () => (window as any).engine.stats()?.inputAppliedRttMs ?? 0,
        ),
      )
      .toBeGreaterThanOrEqual(25);
    const appliedFeedbackMs = await controller.evaluate(
      () => (window as any).engine.stats().inputAppliedRttMs,
    );
    const sorted = [...samples].sort((a, b) => a - b),
      p50 = sorted[Math.floor(sorted.length * 0.5)],
      p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
    expect(p95).toBeLessThan(250);
    expect(errors).toEqual([]);
    for (const page of pages)
      expect(await page.evaluate(() => (window as any).failures ?? [])).toEqual(
        [],
      );
    const syncGroups = await host.evaluate(() => [
      ...new Set(
        [
          ...(
            (window as any).engine.pc.localDescription.sdp as string
          ).matchAll(/a=msid:([^ ]+)/g),
        ].map((m) => m[1]),
      ),
    ]);
    expect(syncGroups.length).toBe(2);
    await host.evaluate(() => {
      const w = window as any;
      w.engine.dispose();
      w.delay = 0;
      w.applied = [];
      w.engine = new w.TestMedia.ChromiumMediaEngine();
    });
    await controller.evaluate(() => {
      const w = window as any;
      w.engine.dispose();
      w.info.remotePlatform = "win32";
      w.uiInput = [];
      w.uiInvokes = [];
      const invoke = w.nearlink.invoke;
      w.nearlink.invoke = (method: string, ...args: any[]) => {
        w.uiInvokes.push(method);
        if (method === "input.local-buttons")
          return Promise.resolve(w.localButtons ?? null);
        if (method === "clipboard.flush" && w.holdPaste)
          return new Promise((resolve) => {
            w.completePaste = resolve;
          });
        return method === "state"
          ? Promise.resolve({
              session: w.info,
              devices: [
                { id: "isolated-peer", name: "模拟被控电脑", online: true },
              ],
              platform: "darwin",
            })
          : invoke(method, ...args);
      };
      document.body.innerHTML = '<div id="root"></div>';
      document.title = "NearLink 远控诊断界面测试";
    });
    const ui = await build({
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      stdin: {
        contents:
          'import {createRoot} from "react-dom/client"; import Session from "./src/Session"; import {ChromiumMediaEngine} from "./src/media/engine"; const input=ChromiumMediaEngine.prototype.input; ChromiumMediaEngine.prototype.input=function(e){window.uiInput.push(e); return input.call(this,e)}; createRoot(document.getElementById("root")).render(<Session/>);',
        resolveDir: process.cwd(),
        loader: "tsx",
      },
      bundle: true,
      format: "iife",
      write: false,
      plugins: [
        {
          name: "worklet",
          setup(b) {
            b.onResolve({ filter: /pcm-worklet\.js\?url$/ }, () => ({
              path: "test",
              namespace: "worklet",
            }));
            b.onLoad({ filter: /.*/, namespace: "worklet" }, () => ({
              contents: 'export default ""',
              loader: "js",
            }));
          },
        },
      ],
    });
    await controller.addStyleTag({ path: "src/styles.css" });
    // This fixture deliberately keeps BrowserWindows hidden. Their compositor
    // need not advance CSS transitions, so exclude animation from input/media
    // assertions instead of forcing clicks on the offscreen toolbar.
    await controller.addStyleTag({
      content: "* { transition: none !important; animation: none !important; }",
    });
    await controller.addScriptTag({ content: ui.outputFiles[0].text });
    await expect
      .poll(() => controller.locator(".session-shell").count(), {
        message: "Session renders without page error",
      })
      .toBe(1);
    expect(errors).toEqual([]);
    await expect(
      controller.getByText("模拟被控电脑", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        controller
          .locator("video")
          .evaluate((v: HTMLVideoElement) => v.videoWidth),
      )
      .toBe(1920);
    const pointer = await controller.evaluate(() => {
      const w = window as any;
      const v = document.querySelector("video")!;
      const box = v.getBoundingClientRect();
      const event = {
        bubbles: true,
        pointerType: "mouse",
        clientX: box.left + box.width / 2,
        clientY: box.top + box.height / 2,
      };
      const raw = "onpointerrawupdate" in v;
      if (raw) v.dispatchEvent(new PointerEvent("pointerrawupdate", event));
      const afterRaw = w.uiInput.filter(
        (value: any) => value.type === "move",
      ).length;
      v.dispatchEvent(new PointerEvent("pointermove", event));
      const moves = w.uiInput.filter(
        (value: any) => value.type === "move",
      ).length;
      // Chromium exposed the raw API, but this physical update only arrived
      // as a pointermove. It must still reach the host.
      v.dispatchEvent(
        new PointerEvent("pointermove", {
          ...event,
          clientX: event.clientX + 20,
        }),
      );
      return {
        raw,
        afterRaw,
        moves,
        afterFallback: w.uiInput.filter((value: any) => value.type === "move")
          .length,
      };
    });
    expect(pointer.afterRaw).toBe(pointer.raw ? 1 : 0);
    expect(pointer.moves).toBe(1);
    expect(pointer.afterFallback).toBe(2);
    await expect(controller.locator(".remote-video")).toHaveCSS(
      "cursor",
      "none",
    );
    await expect
      .poll(() =>
        host.evaluate(() =>
          (window as any).applied.some((e: any) => e.type === "move"),
        ),
      )
      .toBe(true);
    await controller
      .getByRole("button", { name: "性能诊断", exact: true })
      .focus();
    const videoBox = (await controller.locator("video").boundingBox())!;
    await controller.mouse.click(
      videoBox.x + videoBox.width / 2,
      videoBox.y + videoBox.height / 2,
    );
    const keyboard = controller.getByRole("textbox", { name: "远程键盘输入" });
    await expect(keyboard).toBeFocused();
    await controller.keyboard.type("a");
    await expect
      .poll(() =>
        host.evaluate(() =>
          (window as any).applied
            .filter((e: any) => e.type === "button" || e.type === "text")
            .map((e: any) => (e.type === "button" ? e.down : e.text)),
        ),
      )
      .toEqual([true, false, "a"]);
    await keyboard.dispatchEvent("keydown", {
      code: "MetaLeft",
      key: "Meta",
      metaKey: true,
    });
    await keyboard.dispatchEvent("keydown", {
      code: "KeyR",
      key: "r",
      metaKey: true,
    });
    // macOS can omit R keyup while Command is held.
    await keyboard.dispatchEvent("keyup", {
      code: "MetaLeft",
      key: "Meta",
      metaKey: false,
    });
    await keyboard.dispatchEvent("keydown", {
      code: "AltLeft",
      key: "Alt",
      altKey: true,
    });
    await keyboard.dispatchEvent("keydown", {
      code: "Tab",
      key: "Tab",
      altKey: true,
    });
    await keyboard.dispatchEvent("keyup", {
      code: "Tab",
      key: "Tab",
      altKey: true,
    });
    await keyboard.dispatchEvent("keyup", {
      code: "AltLeft",
      key: "Alt",
      altKey: false,
    });
    const mappedInput = await controller.evaluate(() =>
      (window as any).uiInput.filter((e: any) => e.type === "key"),
    );
    expect(mappedInput.map((e: any) => [e.code, e.down])).toEqual([
      ["MetaLeft", true],
      ["KeyR", true],
      ["KeyR", false],
      ["MetaLeft", false],
      ["AltLeft", true],
      ["Tab", true],
      ["Tab", false],
      ["AltLeft", false],
    ]);
    await keyboard.dispatchEvent("keydown", {
      code: "KeyV",
      key: "v",
      metaKey: true,
    });
    expect(
      await controller.evaluate(() =>
        (window as any).uiInvokes.includes("clipboard.flush"),
      ),
    ).toBe(false);
    await keyboard.dispatchEvent("keyup", {
      code: "KeyV",
      key: "v",
      metaKey: true,
    });
    await keyboard.dispatchEvent("keydown", {
      code: "ControlLeft",
      key: "Control",
      ctrlKey: true,
    });
    await keyboard.dispatchEvent("keydown", {
      code: "KeyV",
      key: "v",
      ctrlKey: true,
    });
    await expect
      .poll(() =>
        controller.evaluate(
          () =>
            (window as any).uiInput.filter((e: any) => e.type === "paste")
              .length,
        ),
      )
      .toBe(1);
    const pasteTail = await controller.evaluate(() =>
      (window as any).uiInput.slice(-2),
    );
    expect(pasteTail).toEqual([
      { type: "paste" },
      { type: "key", code: "ControlLeft", down: true },
    ]);
    await keyboard.dispatchEvent("keyup", {
      code: "ControlLeft",
      key: "Control",
    });
    await controller.evaluate(() => {
      (window as any).holdPaste = true;
    });
    await keyboard.dispatchEvent("keydown", {
      code: "KeyV",
      key: "v",
      ctrlKey: true,
    });
    await expect
      .poll(() =>
        controller.evaluate(() => typeof (window as any).completePaste),
      )
      .toBe("function");
    await keyboard.dispatchEvent("focusout");
    await controller.evaluate(async () => {
      (window as any).completePaste(true);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(
      await controller.evaluate(
        () =>
          (window as any).uiInput.filter((e: any) => e.type === "paste").length,
      ),
    ).toBe(1);
    await keyboard.dispatchEvent("keydown", {
      code: "KeyQ",
      key: "Q",
      metaKey: true,
      shiftKey: true,
    });
    expect(
      await controller.evaluate(() =>
        (window as any).uiInvokes.includes("quit"),
      ),
    ).toBe(false);
    await keyboard.dispatchEvent("keyup", {
      code: "KeyQ",
      key: "Q",
      metaKey: true,
      shiftKey: true,
    });
    const buttonsBefore = await host.evaluate(
      () =>
        (window as any).applied.filter((event: any) => event.type === "button")
          .length,
    );
    const midX = videoBox.x + videoBox.width / 2;
    await controller.mouse.move(midX, videoBox.y + videoBox.height / 2);
    await controller.mouse.down();
    // The bottom letterbox is outside the control surface but still in the window.
    await controller.mouse.move(midX, videoBox.y + videoBox.height - 2);
    await controller.mouse.up();
    await expect(controller.locator(".remote-video")).not.toHaveCSS(
      "cursor",
      "none",
    );
    await expect
      .poll(() =>
        host.evaluate(
          (offset) =>
            (window as any).applied
              .filter((event: any) => event.type === "button")
              .slice(offset)
              .map((event: any) => event.down),
          buttonsBefore,
        ),
      )
      .toEqual([true, false]);
    const buttonState = (offset: number) =>
      host.evaluate(
        (index) =>
          (window as any).applied
            .filter((event: any) => event.type === "button")
            .slice(index)
            .map((event: any) => event.down),
        offset,
      );
    await controller.mouse.move(midX, videoBox.y + videoBox.height / 2);
    await controller.evaluate(() => {
      (window as any).localButtons = 1;
    });
    await controller.mouse.down();
    const recoveredFrom = buttonsBefore + 2;
    await expect.poll(() => buttonState(recoveredFrom)).toEqual([true]);
    await controller.waitForTimeout(90);
    expect(await buttonState(recoveredFrom)).toEqual([true]);
    // The OS reports release even if neither pointerup nor mouseup reaches Chromium.
    await controller.evaluate(() => {
      (window as any).localButtons = 0;
    });
    await expect.poll(() => buttonState(recoveredFrom)).toEqual([true, false]);
    await controller.mouse.up();
    await controller.evaluate(() => {
      (window as any).localButtons = null;
    });
    await controller.mouse.click(midX, videoBox.y + videoBox.height / 2);
    await expect
      .poll(() => buttonState(recoveredFrom))
      .toEqual([true, false, true, false]);
    await controller.locator(".toolbar-reveal").hover();
    await controller
      .getByRole("button", { name: "性能诊断", exact: true })
      .click();
    for (const label of [
      "输入通道 RTT",
      "被控输入执行",
      "视频发送排队",
      "视频缓冲 / 每秒丢帧",
      "目标 / 采集配置 fps",
      "输入执行往返",
      "采集到呈现 · 中位 / P95（估计）",
      "本机接收到呈现",
      "接收到提交 / 提交到预计显示",
      "采集帧间隔（平均）",
      "视频编码格式",
      "媒体传输路径",
      "缓冲目标 / 网络最低缓冲",
      "视频采集",
      "已执行 / 已收到松开",
    ])
      await expect(controller.getByText(label, { exact: true })).toBeVisible();
    await controller.getByRole("button", { name: "关闭面板" }).click();
    await expect(
      controller.getByRole("heading", { name: "性能诊断" }),
    ).toBeHidden();
    await controller
      .getByRole("button", { name: "性能诊断", exact: true })
      .click();
    const screenshot = path.join(root, "nearlink-input-feedback.png");
    await controller.screenshot({ path: screenshot });
    const report = {
      at: new Date().toISOString(),
      status: "passed",
      method:
        "Synthetic 1080p60 canvas -> production MediaEngine WebRTC -> decoded video frame callback; input uses real RTCDataChannel and simulated native apply, excludes actual OS capture/injection and physical display/network",
      hiddenWindows: true,
      samplesMs: samples,
      p50,
      p95,
      slowReceiver: {
        applyDelayMs: 25,
        generatedMotion: 200,
        applied: applied.length,
        finalPosition: 1,
        reliableButtonsPreserved: true,
        appliedFeedbackMs,
      },
      presentation,
      syncGroupsIndependent: true,
      nativePlayout: { policy: playoutPolicy, ...forcedPlayout },
      bitrateOnly,
      diagnosticsUi:
        "actual Session component; open, metrics labels, close/reopen verified; Browser plugin not available, used Playwright Electron",
      screenshot,
      errors,
      keyboard: {
        physicalMetaAndAlt: true,
        macCommandKeyupRepair: true,
        pasteMatchesRemotePlatform: true,
        remoteShortcutsDoNotQuitLocalApp: true,
        heldModifiersRestoredAfterPaste: true,
        blurCancelsPendingPaste: true,
      },
    };
    await writeFile(
      bufferControl
        ? "/private/tmp/nearlink-buffer-control.json"
        : "outputs/input-validation.json",
      JSON.stringify(report, null, 2),
    );
    console.log(
      JSON.stringify({
        p50,
        p95,
        coalescedApplied: applied.length,
        metrics: presentation.metrics,
      }),
    );
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close();
  }
});
