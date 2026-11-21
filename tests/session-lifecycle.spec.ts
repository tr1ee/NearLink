import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
test("真实会话：取消卡住采集、隐藏两端窗口、两端媒体进程崩溃后无需重启恢复", async () => {
  test.setTimeout(120000);
  const root = await mkdtemp(path.join(process.cwd(), "work/session-life-"));
  const apps: ElectronApplication[] = [];
  const checks: string[] = [];
  async function launch(name: string) {
    const app = await electron.launch({
      executablePath: process.env.NEARLINK_ELECTRON_EXECUTABLE,
      args: [process.cwd(), "--background"],
      env: { ...process.env, NEARLINK_USER_DATA: path.join(root, name) },
      timeout: 30000,
    });
    apps.push(app);
    let home: Page | undefined;
    await expect
      .poll(
        () => {
          home = app.windows().find((p) => p.url().includes("window=home"));
          return !!home;
        },
        { timeout: 15000 },
      )
      .toBe(true);
    const selectedHome = home!;
    await selectedHome
      .getByRole("button", { name: "设置", exact: true })
      .waitFor();
    await app.evaluate(
      ({
        BrowserWindow,
        app,
        screen,
        desktopCapturer,
        dialog,
        clipboard,
        nativeImage,
      }) => {
        (globalThis as any).__originalPlatform = process.platform;
        Object.defineProperty(process, "platform", {
          value: "win32",
          configurable: true,
        });
        // Presentation is suppressed only in this test process. Production capture,
        // session RPC, IPC, signaling and WebRTC remain the actual implementation.
        BrowserWindow.prototype.show = function () {};
        BrowserWindow.prototype.focus = function () {};
        BrowserWindow.prototype.setFullScreen = function () {};
        BrowserWindow.prototype.setSimpleFullScreen = function () {};
        app.focus = () => {};
        const display = {
          id: 42,
          label: "Synthetic",
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          scaleFactor: 1,
          rotation: 0,
          displayFrequency: 60,
        };
        screen.getAllDisplays = () => [display as any];
        screen.getPrimaryDisplay = () => display as any;
        desktopCapturer.getSources = async () => [
          {
            id: "screen:42:0",
            name: "Synthetic",
            display_id: "42",
            thumbnail: nativeImage.createEmpty(),
            appIcon: nativeImage.createEmpty(),
          },
        ];
        dialog.showErrorBox = (title, detail) =>
          console.error("TEST_UNCAUGHT", title, detail);
        dialog.showMessageBox = async () => ({
          response: 1,
          checkboxChecked: false,
        });
        clipboard.read = async () => [];
      },
    );
    const host = app.windows().find((p) => p.url().includes("window=host"))!;
    const init = () => {
      const w = window as any;
      w.__samples = [];
      w.nearlink.on("metrics", (m: any) => w.__samples.push(m));
      const stream = () => {
        const c = document.createElement("canvas");
        c.width = 1920;
        c.height = 1080;
        const ctx = c.getContext("2d")!;
        let frame = 0;
        w.__draw = setInterval(() => {
          ctx.fillStyle = "#263147";
          ctx.fillRect(0, 0, 1920, 1080);
          ctx.fillStyle = "#1a7be8";
          ctx.fillRect((frame++ * 17) % 1800, 250, 120, 200);
        }, 1000 / 60);
        const media = c.captureStream(60);
        const ac = new AudioContext();
        const osc = ac.createOscillator(),
          gain = ac.createGain(),
          dest = ac.createMediaStreamDestination();
        gain.gain.value = 0;
        osc.connect(gain).connect(dest);
        osc.start();
        media.addTrack(dest.stream.getAudioTracks()[0]);
        return media;
      };
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        value: async (options: any) => {
          w.__requested = options;
          if (w.__stallOnce) {
            w.__stallOnce = false;
            return new Promise(
              (resolve) =>
                (w.__resolveStall = () => {
                  w.__late = stream();
                  resolve(w.__late);
                }),
            );
          }
          return stream();
        },
      });
    };
    await host.addInitScript(init);
    await host.evaluate(init);
    await app.evaluate(({ BrowserWindow }, source) => {
      const wc = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().includes("window=host"),
      )!.webContents;
      wc.on("did-finish-load", () => {
        void wc.executeJavaScript(`(${source})()`).catch(() => {});
      });
    }, init.toString());
    const state = await selectedHome.evaluate(() =>
      window.nearlink.invoke("state"),
    );
    expect(state.self.host).toBe("127.0.0.1");
    return { app, home: selectedHome, host, state };
  }
  async function remotePage(app: ElectronApplication) {
    let page: Page | undefined;
    await expect
      .poll(() => {
        page = app
          .windows()
          .filter((p) => p.url().includes("window=remote"))
          .at(-1);
        return !!page;
      })
      .toBe(true);
    return page!;
  }
  async function connected(home: Page, app: ElectronApplication) {
    await expect
      .poll(
        () =>
          home.evaluate(() =>
            window.nearlink.invoke("state").then((s) => s.session?.state),
          ),
        { timeout: 20000 },
      )
      .toBe("connected");
    await expect
      .poll(
        () =>
          app
            .evaluate(({ BrowserWindow }) =>
              BrowserWindow.getAllWindows()
                .find((w) => w.webContents.getURL().includes("window=remote"))!
                .webContents.executeJavaScript(
                  'document.querySelector("video")?.videoWidth',
                ),
            )
            .catch(() => 0),
        { timeout: 15000 },
      )
      .toBe(1920);
  }
  const frameRates: number[] = [];
  async function framesContinue(app: ElectronApplication) {
    const fps = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().includes("window=remote"),
      )!.webContents.executeJavaScript(`new Promise((resolve,reject) => {
        const v=document.querySelector("video");
        let frames=0; const start=performance.now();
        const timer=setTimeout(()=>reject(Error("Video stopped while hidden")),6500);
        const step=()=>{ frames++; const elapsed=performance.now()-start;
          if(elapsed>=4000){clearTimeout(timer);resolve(frames*1000/elapsed);}
          else v.requestVideoFrameCallback(step);
        };v.requestVideoFrameCallback(step);
      })`),
    );
    frameRates.push(fps);
    return fps;
  }
  try {
    const a = await launch("controller"),
      b = await launch("host");
    await a.home.evaluate(
      (address) => window.nearlink.invoke("pair", address),
      `127.0.0.1:${b.state.self.port}`,
    );
    const id = b.state.self.id;
    console.log("session fixtures paired on loopback");
    await b.host.evaluate(() => {
      (window as any).__stallOnce = true;
    });
    await a.home.evaluate(
      (id) => window.nearlink.invoke("connect", id, true),
      id,
    );
    await expect
      .poll(() => b.host.evaluate(() => typeof (window as any).__resolveStall))
      .toBe("function");
    await a.home.evaluate(() => window.nearlink.invoke("session.disconnect"));
    await expect
      .poll(
        () =>
          a.app.windows().filter((p) => p.url().includes("window=remote"))
            .length,
      )
      .toBe(0);
    await a.home.evaluate(
      (id) => window.nearlink.invoke("connect", id, true),
      id,
    );
    const remote = await remotePage(a.app);
    await connected(a.home, a.app);
    console.log("real media connected");
    const activationRaisedHome = await a.app.evaluate(
      ({ BrowserWindow, app }) => {
        const viewer = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().includes("window=remote"),
        )!;
        const home = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().includes("window=home"),
        )!;
        const getFocusedWindow = BrowserWindow.getFocusedWindow;
        let raised = false;
        home.show = () => {
          raised = true;
        };
        BrowserWindow.getFocusedWindow = () => viewer;
        viewer.isVisible = () => true;
        try {
          app.emit("activate", {}, true);
        } finally {
          BrowserWindow.getFocusedWindow = getFocusedWindow;
          delete (home as any).show;
          delete (viewer as any).isVisible;
        }
        return raised;
      },
    );
    expect(activationRaisedHome).toBe(false);
    // The fixture suppresses fullscreen presentation. Check the real native
    // client bounds and rendered video, independent of the title-bar height.
    const geometry = await a.app.evaluate(({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().includes("window=remote"),
      )!;
      const outer = win.getBounds();
      const content = win.getContentBounds();
      const display = screen.getDisplayMatching(outer);
      return {
        outer,
        content,
        area: display.workArea,
        scale: display.scaleFactor,
      };
    });
    const { outer, content, area, scale } = geometry;
    expect(
      Math.abs(content.width - (content.height * 16) / 9),
    ).toBeLessThanOrEqual(1);
    const expectedHeight = Math.floor(
      Math.min(
        1080 / scale,
        area.height - (outer.height - content.height),
        ((area.width - (outer.width - content.width)) * 9) / 16,
      ),
    );
    expect(Math.abs(content.height - expectedHeight)).toBeLessThanOrEqual(1);
    expect(outer.y).toBeGreaterThanOrEqual(area.y);
    expect(outer.y + outer.height).toBeLessThanOrEqual(area.y + area.height);
    const videoBounds = await remote.locator("video").boundingBox();
    expect(videoBounds?.width).toBe(content.width);
    expect(videoBounds?.height).toBe(content.height);
    checks.push(
      "windowed client area matches the remote screen aspect ratio and local work area",
    );
    await b.host.evaluate(() => {
      (window as any).__resolveStall();
    });
    await expect
      .poll(() =>
        b.host.evaluate(() =>
          (window as any).__late
            .getTracks()
            .every((t: MediaStreamTrack) => t.readyState === "ended"),
        ),
      )
      .toBe(true);
    checks.push(
      "blocked capture cancelled; late tracks stopped; next session connects without waiting for timeout",
    );
    await a.home.evaluate(() => {
      (window as any).__samples = [];
      window.nearlink.on("metrics", (m: any) =>
        (window as any).__samples.push(m),
      );
    });
    await expect
      .poll(
        () =>
          a.home.evaluate(
            () =>
              (window as any).__samples.filter((m: any) => m.renderFps >= 30)
                .length,
          ),
        { timeout: 15000 },
      )
      .toBeGreaterThanOrEqual(3);
    const pids = await b.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => ({
        kind: w.webContents.getURL().split("window=")[1]?.split("&")[0],
        pid: w.webContents.getOSProcessId(),
      })),
    );
    expect(pids.find((w) => w.kind === "host")!.pid).not.toBe(
      pids.find((w) => w.kind === "home")!.pid,
    );
    checks.push(
      "real media capture renderer has a different OS process from home",
    );
    for (const fixture of [a, b])
      await fixture.app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().includes("window=home"),
        )!;
        w.minimize();
        w.close();
        if (w.isDestroyed()) throw Error("Home destroyed");
      });
    await a.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().includes("window=remote"),
      )!;
      w.minimize();
      w.close();
      if (w.isDestroyed()) throw Error("Remote destroyed");
    });
    await expect
      .poll(() => framesContinue(a.app), { timeout: 16000, intervals: [100] })
      .toBeGreaterThanOrEqual(30);
    await a.home.evaluate(
      (id) => window.nearlink.invoke("device.info", id),
      id,
    );
    checks.push(
      "both homes and controller window minimized/closed; video frames and authenticated RPC continue",
    );
    const oldSession = await a.home.evaluate(() =>
      window.nearlink.invoke("state").then((s) => s.session.id),
    );
    const oldPid = await b.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().includes("window=host"),
      )!;
      const pid = w.webContents.getOSProcessId();
      w.webContents.forcefullyCrashRenderer();
      return pid;
    });
    try {
      await expect
        .poll(
          () =>
            b.app
              .evaluate(({ BrowserWindow }) =>
                BrowserWindow.getAllWindows()
                  .find((w) => w.webContents.getURL().includes("window=host"))!
                  .webContents.executeJavaScript("!!window.__nearlinkHost"),
              )
              .catch(() => false),
          { timeout: 12000 },
        )
        .toBe(true);
    } catch (error) {
      console.log(
        JSON.stringify(
          await b.home.evaluate(() =>
            window.nearlink.invoke("diagnostics.media"),
          ),
        ),
      );
      throw error;
    }

    await expect
      .poll(
        () =>
          a.home
            .evaluate(() =>
              window.nearlink.invoke("state").then((s) => s.session?.id),
            )
            .catch(() => oldSession),
        { timeout: 15000 },
      )
      .not.toBe(oldSession);
    await connected(a.home, a.app);
    console.log("real media connected");
    await expect
      .poll(() => framesContinue(a.app), { timeout: 16000, intervals: [100] })
      .toBeGreaterThanOrEqual(30);
    const newPid = await b.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().includes("window=host"))!
        .webContents.getOSProcessId(),
    );
    expect(newPid).not.toBe(oldPid);
    checks.push(
      "capture renderer actually terminated and automatically reloaded; session renegotiates and video returns",
    );
    const beforeControllerCrash = await a.home.evaluate(() =>
      window.nearlink.invoke("state").then((s) => s.session.id),
    );
    await a.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().includes("window=remote"))!
        .webContents.forcefullyCrashRenderer(),
    );
    await expect
      .poll(
        () =>
          a.home.evaluate(() =>
            window.nearlink.invoke("state").then((s) => s.session?.id),
          ),
        { timeout: 15000 },
      )
      .not.toBe(beforeControllerCrash);
    await connected(a.home, a.app);
    await expect
      .poll(() => framesContinue(a.app), { timeout: 16000, intervals: [100] })
      .toBeGreaterThanOrEqual(30);
    expect(await framesContinue(a.app)).toBeGreaterThanOrEqual(30);
    checks.push(
      "controller renderer actually terminated and automatically reloaded; hidden video continues above 30fps after recovery",
    );
    const currentSession = await a.home.evaluate(() =>
      window.nearlink.invoke("state").then((s) => s.session.id),
    );
    await a.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().includes("window=remote"))!
        .webContents.executeJavaScript(
          'window.nearlink.invoke("media.failed", "stale-session")',
        ),
    );
    expect(
      await a.home.evaluate(() =>
        window.nearlink.invoke("state").then((s) => s.session.id),
      ),
    ).toBe(currentSession);
    checks.push("stale media failure cannot tear down the current session");
    const samples = await a.home.evaluate(
      () => (window as any).__samples ?? [],
    );
    await writeFile(
      "outputs/session-lifecycle-validation.json",
      JSON.stringify(
        {
          at: new Date().toISOString(),
          status: "passed",
          scope:
            "Actual Runtime/TLS/WebRTC/IPC, hidden windows and isolated loopback profiles; synthetic canvas/zero audio source and Windows platform branch simulated on macOS, excludes physical screen capture and Windows OS",
          checks,
          fourSecondFrameRatesIncludingWarmup: frameRates,
          samples,
        },
        null,
        2,
      ),
    );
  } finally {
    for (const app of apps) {
      await app
        .evaluate(() =>
          Object.defineProperty(process, "platform", {
            value: (globalThis as any).__originalPlatform ?? "darwin",
            configurable: true,
          }),
        )
        .catch(() => {});
      await app.close().catch(() => {});
    }
  }
});
