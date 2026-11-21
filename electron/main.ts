import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Tray,
  nativeImage,
  shell,
  dialog,
  session as electronSession,
  screen,
  systemPreferences,
  clipboard,
} from "electron";
import path from "node:path";
import os from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { Runtime } from "./runtime";
import { AppUpdater } from "./updater";
import { listing } from "./files";
import { qualitySchema } from "../src/shared/protocol";
import { QuitIntent } from "./window-lifecycle";
import { SessionLog } from "./session-log";
import { interactiveVideoTrials } from "./media-policy";
import { fitRemoteWindow } from "./remote-window";
import { startWindowsCapture } from "./windows-capture";
import { isMediaStage } from "../src/shared/media-diagnostics";
app.setName("NearLink");
if (process.env.NEARLINK_USER_DATA)
  app.setPath("userData", process.env.NEARLINK_USER_DATA);
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch(
  "force-fieldtrials",
  interactiveVideoTrials(app.commandLine.getSwitchValue("force-fieldtrials")),
);
if (process.platform === "win32") {
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
  const disabled = app.commandLine.getSwitchValue("disable-features");
  app.commandLine.appendSwitch(
    "disable-features",
    [disabled, "CalculateNativeWinOcclusion"].filter(Boolean).join(","),
  );
}
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
let runtime: Runtime;
let updater: AppUpdater;
let home: BrowserWindow | undefined;
let host: BrowserWindow | undefined;
const useDxgi =
  process.platform === "win32" && app.commandLine.hasSwitch("nearlink-dxgi");
let dxgi:
  { sessionId: string; displayId: string; stop: () => void } | undefined;
function stopDxgi() {
  dxgi?.stop();
  dxgi = undefined;
}
let remote: BrowserWindow | undefined;
let remoteGeometry = "";
let remoteVideoRatio: number | undefined;
let benchmark: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
let healthTimer: ReturnType<typeof setInterval> | undefined;
const sessionLog = new SessionLog(
  path.join(app.getPath("userData"), "logs", "session.jsonl"),
);
const quitIntent = new QuitIntent();
function requestQuit() {
  quitIntent.request();
  mediaEvent("application", "quit-requested");
  app.quit();
}
const windows = new Map<number, { kind: string; peer: string }>();
const filesWindows = new Map<string, BrowserWindow>();
const mediaReady = new Set<number>();
const pendingMedia = new Map<number, any[]>();
const mediaEvents: {
  at: string;
  kind: string;
  event: string;
  reason?: string;
  exitCode?: number;
}[] = [];
function mediaEvent(kind: string, event: string, details: any = {}) {
  mediaEvents.push({ at: new Date().toISOString(), kind, event, ...details });
  sessionLog.record(mediaEvents.at(-1));
  if (mediaEvents.length > 200) mediaEvents.shift();
}
const devURL = process.env.NEARLINK_DEV_URL;
function createWindow(
  kind: string,
  peer = "",
  extra: Electron.BrowserWindowConstructorOptions = {},
) {
  const win = new BrowserWindow({
    width: 1240,
    height: 850,
    minWidth: 940,
    minHeight: 640,
    show: kind !== "host",
    title:
      kind === "home"
        ? "近控 NearLink"
        : kind === "files"
          ? "文件传输 · NearLink"
          : "NearLink",
    ...(kind === "home" && process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const }
      : {}),
    backgroundColor: kind === "remote" ? "#101216" : "#ffffff",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      ...(kind === "host"
        ? { partition: "nearlink-capture" }
        : kind === "remote"
          ? { partition: "nearlink-controller" }
          : {}),
    },
    ...extra,
  });
  const contentId = win.webContents.id;
  windows.set(contentId, { kind, peer });
  if (kind === "remote") win.webContents.setIgnoreMenuShortcuts(true);
  if (["host", "remote"].includes(kind)) {
    let reloadTimer: ReturnType<typeof setTimeout> | undefined;
    let unresponsiveTimer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let resetAt = Date.now();
    const recover = () => {
      if (quitting || win.isDestroyed()) return;
      mediaReady.delete(contentId);
      pendingMedia.delete(contentId);
      if (Date.now() - resetAt > 60000) {
        failures = 0;
        resetAt = Date.now();
      }
      const delay = Math.min(5000, 250 * 2 ** Math.min(failures++, 4));
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        if (!quitting && !win.isDestroyed()) {
          mediaEvent(kind, "reload");
          win.webContents.reload();
        }
      }, delay);
      if (runtime?.session?.role === (kind === "host" ? "host" : "controller"))
        runtime.mediaFailed(runtime.session.id);
    };
    win.webContents.on("render-process-gone", (_event, details) => {
      mediaEvent(kind, "render-process-gone", {
        reason: details.reason,
        exitCode: details.exitCode,
      });
      recover();
    });
    win.webContents.on("unresponsive", () => {
      mediaEvent(kind, "unresponsive");
      if (unresponsiveTimer) clearTimeout(unresponsiveTimer);
      unresponsiveTimer = setTimeout(() => {
        if (!quitting && !win.isDestroyed())
          win.webContents.forcefullyCrashRenderer();
      }, 5000);
    });
    win.webContents.on("responsive", () => {
      if (unresponsiveTimer) clearTimeout(unresponsiveTimer);
    });
    win.on("closed", () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      if (unresponsiveTimer) clearTimeout(unresponsiveTimer);
    });
    for (const event of ["hide", "show", "minimize", "restore"] as const)
      win.on(event as "hide", () => {
        if (!win.isDestroyed()) win.webContents.setBackgroundThrottling(false);
        mediaEvent(kind, event);
        send(win, "visibility", event === "show" || event === "restore");
      });
  }
  win.on("enter-full-screen", () => send(win, "fullscreen", true));
  win.on("leave-full-screen", () => send(win, "fullscreen", false));
  const query = { window: kind, peer };
  if (devURL) {
    const url = new URL(devURL);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    void win.loadURL(url.toString());
  } else
    void win.loadFile(path.join(__dirname, "../dist/index.html"), { query });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.on("close", (e) => {
    if (!quitting && kind !== "benchmark") {
      e.preventDefault();
      mediaEvent(kind, "close-to-background");
      // Hide immediately, including while Windows is leaving fullscreen.
      win.hide();
      if (kind === "remote" && isFullscreen(win)) {
        win.once("leave-full-screen", () => {
          if (!win.isDestroyed() && !quitting) win.hide();
        });
        setFullscreen(win, false);
      }
      if (kind === "remote") send(host, "release", null);
    }
  });
  if (kind === "remote") {
    win.on("focus", () => mediaEvent(kind, "focus"));
    win.on("blur", () => {
      mediaEvent(kind, "blur");
      send(win, "release", null);
    });
  }
  win.on("hide", () => {
    if (kind === "remote") {
      send(win, "release", null);
      runtime?.release();
    }
  });
  win.on("query-session-end", () => {
    quitIntent.request();
    mediaEvent("application", "system-session-end");
  });
  win.on("session-end", () => quitIntent.request());
  win.on("closed", () => {
    windows.delete(contentId);
    mediaReady.delete(contentId);
    pendingMedia.delete(contentId);
  });
  return win;
}
function send(win: BrowserWindow | undefined, topic: string, data: any) {
  if (!win || win.isDestroyed()) return;
  if (topic === "media" && !mediaReady.has(win.webContents.id)) {
    if (data.kind === "stats") return;
    const id = win.webContents.id;
    let pending = pendingMedia.get(id) ?? [];
    if (data.kind === "stop") pending = [];
    if (data.kind === "offer")
      pending = pending.filter(
        (m) => m.sessionId === data.sessionId && m.kind === "candidate",
      );
    if (pending.length < 128) pending.push(data);
    pendingMedia.set(id, pending);
    return;
  }
  if (win.webContents.isDestroyed() || win.webContents.isCrashed()) return;
  try {
    win.webContents.send("nearlink:" + topic, data);
  } catch {
    mediaEvent(
      windows.get(win.webContents.id)?.kind ?? "unknown",
      "delivery-unavailable",
    );
  }
}
function broadcast(topic: string, data: any) {
  for (const w of BrowserWindow.getAllWindows()) send(w, topic, data);
}
function isFullscreen(win: BrowserWindow) {
  return (
    win.isFullScreen() ||
    (process.platform === "darwin" && win.isSimpleFullScreen())
  );
}
function setFullscreen(win: BrowserWindow, on: boolean) {
  if (on) {
    if (win === remote) win.setAspectRatio(0);
    win.show();
  }
  if (process.platform === "darwin") {
    win.setSimpleFullScreen(on);
    send(win, "fullscreen", on);
    if (!on && win === remote) fitControllerWindow(win, true);
  } else win.setFullScreen(on);
  // Changing the window style can move focus on macOS. Focus the renderer
  // after the transition so typed input goes to the viewer.
  if (win.isVisible() && (on || win === remote)) {
    if (on) app.focus({ steal: true });
    win.focus();
    if (win === remote) win.webContents.focus();
  }
}
function fitControllerWindow(win: BrowserWindow, force = false) {
  const session = runtime?.session;
  if (session?.role !== "controller" || win.isDestroyed()) return;
  const source = session.displays.find(
    (display) => display.id === session.displayId,
  );
  if (!source || !(source.width > 0 && source.height > 0 && source.scale > 0))
    return;
  const key = `${session.id}:${source.id}:${source.width}x${source.height}@${source.scale}`;
  const changed = key !== remoteGeometry;
  if (changed) {
    remoteGeometry = key;
    remoteVideoRatio = undefined;
  }
  if ((changed || force) && !isFullscreen(win) && !win.isMinimized())
    fitRemoteWindow(win, source, remoteVideoRatio);
}
function showHome() {
  if (!home || home.isDestroyed()) home = createWindow("home");
  home.show();
  home.focus();
}
function showRemote() {
  if (!runtime.session || runtime.session.role !== "controller") return;
  if (!remote || remote.isDestroyed()) {
    remote = createWindow("remote", runtime.session.peerId, {
      show: false,
      // Native window chrome supplies dragging and resize borders in windowed
      // mode; fullscreen hides it without replacing the media window.
      frame: true,
      acceptFirstMouse: true,
      resizable: true,
      movable: true,
      title: "远程桌面 · NearLink",
      minWidth: 1,
      minHeight: 1,
    });
    if (process.platform === "win32") remote.removeMenu();
    const win = remote;
    remoteGeometry = "";
    remoteVideoRatio = undefined;
    fitControllerWindow(win);
    win.on("leave-full-screen", () => fitControllerWindow(win, true));
    win.on("restore", () => fitControllerWindow(win, true));
    win.once("ready-to-show", () => {
      setFullscreen(win, true);
    });
  } else {
    setFullscreen(remote, true);
    send(remote, "state", runtime.snapshot());
  }
}
function showFiles(peer: string) {
  if (!runtime.store.trusted.has(peer)) throw new Error("请先配对设备");
  let win = filesWindows.get(peer);
  if (!win || win.isDestroyed()) {
    win = createWindow("files", peer, { width: 1240, height: 800 });
    filesWindows.set(peer, win);
  }
  win.show();
  win.focus();
}
function updateTray() {
  if (!tray || !runtime) return;
  tray.setToolTip(
    `近控 NearLink · ${runtime.session ? "远控会话进行中" : runtime.store.allowRemote ? "等待连接" : "已暂停访问"}`,
  );
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开近控", click: showHome },
      {
        label: "恢复远控窗口",
        enabled: runtime.session?.role === "controller",
        click: showRemote,
      },
      { type: "separator" },
      {
        label: "允许远程连接",
        type: "checkbox",
        checked: runtime.store.allowRemote,
        click: (item) => void runtime.toggleRemote(item.checked),
      },
      {
        label: "断开当前远控",
        enabled: !!runtime.session,
        click: () => void runtime.end(),
      },
      { type: "separator" },
      { label: "完全退出", click: requestQuit },
    ]),
  );
}
async function initialize() {
  mediaEvent("application", "start", { reason: app.getVersion() });
  runtime = new Runtime();
  runtime.on("input-worker", (event, details) =>
    mediaEvent("input-worker", event, details),
  );
  runtime.on("media-signal-received", (signalKind: "offer" | "answer") =>
    mediaEvent("network", "media-signal-received", { signalKind }),
  );
  await runtime.init();
  runtime.network.on("ready", () => mediaEvent("network", "authenticated"));
  runtime.network.on("closed", () =>
    mediaEvent("network", "connection-closed"),
  );
  let healthAt = Date.now();
  healthTimer = setInterval(() => {
    const now = Date.now(),
      delayMs = Math.max(0, now - healthAt - 5000);
    healthAt = now;
    if (runtime.session || delayMs > 1500)
      sessionLog.record({
        at: new Date(now).toISOString(),
        kind: "application",
        event: "background-health",
        eventLoopDelayMs: delayMs,
        sessionState: runtime.session?.state,
        role: runtime.session?.role,
        authenticatedPeers: [...runtime.network.links.values()].filter(
          (l) => l.ready,
        ).length,
        inputWorker: runtime.inputService?.status(),
        windows: BrowserWindow.getAllWindows().map((w) => ({
          kind: windows.get(w.webContents.id)?.kind,
          visible: w.isVisible(),
          minimized: w.isMinimized(),
          focused: w.isFocused(),
        })),
      });
  }, 5000);
  updater = new AppUpdater(
    () =>
      runtime.session
        ? runtime.metrics &&
          (runtime.metrics.loss > 0.02 || runtime.metrics.rttMs > 35)
          ? 256 * 1024
          : 2 * 1024 * 1024
        : Infinity,
    requestQuit,
  );
  await updater.init();
  updater.on("state", (state) => broadcast("updates", state));
  runtime.on("state", (s) => {
    if (
      dxgi &&
      (s.session?.id !== dxgi.sessionId ||
        s.session.displayId !== dxgi.displayId ||
        s.session.state === "reconnecting" ||
        !runtime.network.authorized(s.session.peerId))
    )
      stopDxgi();
    broadcast("state", s);
    if (remote) fitControllerWindow(remote);
    updateTray();
  });
  let metricLoggedAt = 0;
  runtime.on("local-metrics", (m) => {
    if (Date.now() - metricLoggedAt >= 5000) {
      metricLoggedAt = Date.now();
      sessionLog.record({
        at: new Date().toISOString(),
        kind: runtime.session?.role,
        event: "media-health",
        source: "local",
        width: m.width,
        height: m.height,
        targetFps: m.targetFps,
        configuredFps: m.configuredFps,
        captureFps: m.captureFps,
        captureBackend: m.captureBackend,
        captureFallback: m.captureFallback,
        encodeFps: m.encodeFps,
        decodeFps: m.decodeFps,
        renderFps: m.renderFps,
        frames: m.frames,
        rttMs: m.rttMs,
        inputRttMs: m.inputRttMs,
        inputAppliedRttMs: m.inputAppliedRttMs,
        inputQueueMs: m.inputQueueMs,
        inputButtons: m.inputButtons,
        videoAgeMs: m.videoAgeMs,
        videoAgeP95Ms: m.videoAgeP95Ms,
        receiveToPresentMs: m.receiveToPresentMs,
        receiveToSubmitMs: m.receiveToSubmitMs,
        submitToDisplayMs: m.submitToDisplayMs,
        encodeMs: m.encodeMs,
        decodeMs: m.decodeMs,
        bufferMs: m.jitterBufferMs,
        bufferTargetMs: m.jitterBufferTargetMs,
        bufferMinimumMs: m.jitterBufferMinimumMs,
        videoCodec: m.videoCodec,
        mediaTransport: m.mediaTransport,
        encoder: String(m.encoder ?? "").slice(0, 160),
      });
    }
  });
  runtime.on("metrics", (m) => {
    send(remote, "metrics", m);
    send(home, "metrics", m);
  });
  runtime.on("show-remote", showRemote);
  runtime.on("restart-remote", () => {
    send(remote, "state", runtime.snapshot());
    send(remote, "media", { kind: "restart" });
  });
  runtime.on("media", (kind, data) =>
    send(kind === "host" ? host : remote, "media", data),
  );
  runtime.on("session-ended", () => {
    const previous = remote;
    remote = undefined;
    if (previous && !previous.isDestroyed()) {
      let retired = false;
      const retire = () => {
        if (retired) return;
        retired = true;
        if (!previous.isDestroyed()) {
          previous.hide();
          setTimeout(() => {
            if (!previous.isDestroyed()) previous.destroy();
          }, 200);
        }
      };
      if (process.platform === "darwin" && previous.isSimpleFullScreen()) {
        previous.setSimpleFullScreen(false);
        retire();
      } else if (previous.isFullScreen()) {
        previous.once("leave-full-screen", retire);
        previous.setFullScreen(false);
        setTimeout(retire, 2000);
      } else retire();
    }
    updateTray();
  });
  runtime.on("lock", (v) => {
    if (v) stopDxgi();
    broadcast("lock", v);
  });
  runtime.openBenchmark = async (display) => {
    if (benchmark && !benchmark.isDestroyed()) {
      setFullscreen(benchmark, false);
      benchmark.destroy();
    }
    const win = (benchmark = createWindow("benchmark", "", {
      x: display.x,
      y: display.y,
      width: display.width,
      height: display.height,
      show: false,
      frame: false,
    }));
    if (win.webContents.isLoading())
      await new Promise<void>((resolve) =>
        win.webContents.once("did-finish-load", () => resolve()),
      );
    if (process.platform === "darwin") {
      // The source may be in another application's full-screen Space.
      // A focused window on the ordinary desktop is not visible there.
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      win.setAlwaysOnTop(true, "screen-saver");
      app.focus({ steal: true });
      win.show();
      win.focus();
      win.moveTop();
    } else setFullscreen(win, true);
    const canvas = await win.webContents.executeJavaScript(
      `new Promise(resolve=>{const deadline=performance.now()+5000;const check=()=>{const c=document.querySelector('canvas');if(c&&c.width&&c.height){const r=c.getBoundingClientRect();resolve({x:r.x,y:r.y,width:r.width,height:r.height});return;}if(performance.now()>deadline){resolve(null);return;}requestAnimationFrame(check);};requestAnimationFrame(check);})`,
    );
    if (!canvas) throw new Error("测试画面尚未就绪，请稍后重试");
    const bounds = win.getContentBounds();
    return {
      displayId: display.id,
      x: (bounds.x + canvas.x - display.x) / display.width,
      y: (bounds.y + canvas.y - display.y) / display.height,
      width: canvas.width / display.width,
      height: canvas.height / display.height,
    };
  };
  electronSession.defaultSession.setPermissionRequestHandler(
    (_w, _p, callback) => callback(false),
  );
  electronSession.defaultSession.setPermissionCheckHandler(() => false);
  const controllerSession = electronSession.fromPartition(
    "nearlink-controller",
  );
  controllerSession.setPermissionRequestHandler((_w, _p, callback) =>
    callback(false),
  );
  controllerSession.setPermissionCheckHandler(() => false);
  host = createWindow("host", "", { show: false, width: 640, height: 360 });
  host.webContents.session.setPermissionRequestHandler(
    (webContents, permission, callback) =>
      callback(
        webContents.id === host?.webContents.id &&
          ["media", "display-capture"].includes(permission),
      ),
  );
  host.webContents.session.setPermissionCheckHandler(
    (webContents, permission) =>
      !!webContents &&
      webContents.id === host?.webContents.id &&
      ["media", "display-capture"].includes(permission),
  );
  host.webContents.session.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        if (request.frame?.top !== host?.webContents.mainFrame) {
          callback({});
          return;
        }
        const source = await runtime.source();
        callback({
          video: { id: source.sourceId, name: "NearLink Desktop" },
          ...(process.platform === "win32" ? { audio: "loopback" } : {}),
        });
      } catch {
        callback({});
      }
    },
  );
  const icon = nativeImage.createFromPath(
    path.join(app.getAppPath(), "resources", "tray.png"),
  );
  if (!icon.isEmpty()) {
    icon.setTemplateImage(process.platform === "darwin");
    tray = new Tray(icon);
    tray.on("click", showHome);
    updateTray();
  }
  if (!tray) {
    const fallback = nativeImage.createFromDataURL(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
    );
    tray = new Tray(fallback);
    updateTray();
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "NearLink",
        submenu: [
          { label: "打开主窗口", click: showHome },
          { label: "恢复远控窗口", click: showRemote },
          { type: "separator" },
          {
            label: "完全退出 NearLink",
            accelerator: "CmdOrCtrl+Q",
            click: requestQuit,
          },
        ],
      },
      {
        label: "编辑",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "窗口",
        submenu: [
          { role: "minimize" },
          {
            label: "退出全屏",
            accelerator: "CommandOrControl+Shift+F",
            click: () => {
              if (remote) setFullscreen(remote, false);
            },
          },
          { label: "打开主窗口", click: showHome },
        ],
      },
    ]),
  );
  ipcMain.handle("nearlink:invoke", async (event, method, ...args) => {
    const meta = windows.get(event.sender.id);
    if (!meta) throw new Error("无效窗口");
    const privilegedMedia = meta.kind === "host" || meta.kind === "remote";
    switch (method) {
      case "state":
        return runtime.snapshot();
      case "updates.state":
        return updater.snapshot();
      case "updates.configure":
        if (meta.kind !== "home") throw new Error("无效入口");
        return updater.configure(String(args[0]).trim(), !!args[1]);
      case "updates.check":
        if (meta.kind !== "home") throw new Error("无效入口");
        return updater.check();
      case "updates.download":
        if (meta.kind !== "home") throw new Error("无效入口");
        return updater.download();
      case "updates.cancel":
        if (meta.kind !== "home") throw new Error("无效入口");
        return updater.cancel();
      case "updates.install":
        if (meta.kind !== "home") throw new Error("无效入口");
        return updater.install(
          !!runtime.session ||
            runtime.files.tasks.some(
              (t) => t.state === "running" || t.state === "queued",
            ),
        );
      case "copy.address":
        await clipboard.writeText(
          `${runtime.network.self().host}:${runtime.network.port}`,
        );
        return true;
      case "pair":
        if (meta.kind !== "home") throw new Error("无效入口");
        return runtime.network.connect(String(args[0]), true);
      case "connect":
        if (meta.kind !== "home") throw new Error("无效入口");
        return runtime.connectSession(String(args[0]), !!args[1]);
      case "preview":
        if (
          meta.kind === "home" &&
          !BrowserWindow.fromWebContents(event.sender)?.isVisible()
        )
          return { image: "" };
        await runtime.network.ensure(String(args[0]));
        return runtime.network.rpc(String(args[0]), "preview");
      case "device.info":
        await runtime.network.ensure(String(args[0]));
        return runtime.network.rpc(String(args[0]), "device.info");
      case "revoke":
        if (meta.kind !== "home") throw new Error("无效入口");
        if (runtime.session?.peerId === args[0]) await runtime.end();
        return runtime.network.revoke(String(args[0]));
      case "allowRemote":
        if (meta.kind !== "home") throw new Error("无效入口");
        return runtime.toggleRemote(!!args[0]);
      case "refresh":
        runtime.network.refreshDiscovery(true);
        void runtime.network.probeTrusted();
        runtime.changed();
        return runtime.snapshot();
      case "files.open":
        showFiles(String(args[0] ?? runtime.session?.peerId));
        return true;
      case "files.list":
        return args[0] === "local"
          ? listing(String(args[1] ?? ""))
          : (await runtime.network.ensure(meta.peer),
            runtime.network.rpc(meta.peer, "files.list", {
              path: String(args[1] ?? ""),
            }));
      case "files.locations":
        if (meta.kind !== "files") throw new Error("无效入口");
        return args[0] === "local"
          ? runtime.files.locations()
          : (await runtime.network.ensure(meta.peer),
            runtime.network.rpc(meta.peer, "files.locations"));
      case "files.transfer":
        if (meta.kind !== "files") throw new Error("无效入口");
        if (!["upload", "download"].includes(args[0]))
          throw new Error("无效方向");
        return runtime.files.queue(
          meta.peer,
          args[0],
          String(args[1]),
          String(args[2]),
        );
      case "files.cancel":
        runtime.files.cancel(String(args[0]));
        return true;
      case "files.retry":
        return runtime.files.retry(String(args[0]));
      case "files.reveal": {
        const t = runtime.files.tasks.find((t) => t.id === args[0]);
        if (t?.direction === "download") shell.showItemInFolder(t.destination);
        return true;
      }
      case "source":
        if (meta.kind !== "host") throw new Error("无效采集入口");
        return {
          ...(await runtime.source()),
          captureBackend: useDxgi ? "dxgi" : "chromium",
        };
      case "media.input-ready":
        if (meta.kind !== "host" || runtime.session?.id !== args[0])
          throw Error("远控会话已结束");
        await runtime.inputService?.waitForAuthorization(String(args[0]));
        if (runtime.session?.id !== args[0]) throw Error("远控会话已结束");
        return true;
      case "capture.dxgi.open": {
        const current = runtime.session;
        if (
          !useDxgi ||
          meta.kind !== "host" ||
          current?.role !== "host" ||
          current.id !== args[0] ||
          current.state === "reconnecting" ||
          runtime.locked ||
          current.quality.auto ||
          current.quality.height !== 1080 ||
          !runtime.network.authorized(current.peerId) ||
          typeof args[1] !== "string" ||
          args[1].length > 64
        )
          throw Error("当前会话无法使用 DXGI 采集");
        const display = current.displays.find(
          (d) => d.id === current.displayId,
        );
        if (
          !display ||
          display.rotation !== 0 ||
          Math.round(display.width * display.scale) !== 1920 ||
          Math.round(display.height * display.scale) !== 1080
        )
          throw Error("DXGI 对照需要标准方向的 1920 × 1080 显示器");
        const center = screen.dipToScreenPoint({
          x: Math.floor(display.x + display.width / 2),
          y: Math.floor(display.y + display.height / 2),
        });
        stopDxgi();
        const capture = startWindowsCapture(event.sender, args[1], center);
        dxgi = {
          sessionId: current.id,
          displayId: current.displayId,
          stop: capture.stop,
        };
        await capture.ready;
        return true;
      }
      case "media.ready": {
        if (!privilegedMedia) throw new Error("无效媒体入口");
        mediaReady.add(event.sender.id);
        if (meta.kind === "host" && runtime.inputService?.ready)
          runtime.inputService.attach(event.sender);
        if (meta.kind === "remote" && remote)
          send(remote, "fullscreen", isFullscreen(remote));
        const queued = pendingMedia.get(event.sender.id) ?? [];
        pendingMedia.delete(event.sender.id);
        for (const signal of queued)
          if (
            signal.kind === "restart" ||
            signal.sessionId === runtime.session?.id
          )
            event.sender.send("nearlink:media", signal);
        mediaEvent(meta.kind, "ready");
        return true;
      }
      case "media.signal":
        if (!privilegedMedia) throw new Error("无效媒体入口");
        runtime.signal(args[0]);
        if (args[0]?.kind === "offer" || args[0]?.kind === "answer")
          mediaEvent(meta.kind, "media-signal-sent", {
            signalKind: args[0].kind,
          });
        return;
      case "media.codec-experiment":
        if (!privilegedMedia) throw Error("无效媒体入口");
        return app.commandLine.hasSwitch("nearlink-hevc") ? "hevc" : null;
      case "media.connected":
        if (!privilegedMedia) throw new Error("无效媒体入口");
        runtime.mediaConnected(String(args[0]));
        return true;
      case "media.failed":
        if (!privilegedMedia) throw new Error("无效媒体入口");
        runtime.mediaFailed(String(args[0]));
        return true;
      case "media.error":
        if (!privilegedMedia) throw new Error("无效媒体入口");
        runtime.mediaError(String(args[0]).slice(0, 500));
        return true;
      case "diagnostics.media-stage":
        if (
          !privilegedMedia ||
          !runtime.session ||
          runtime.session.id !== args[0] ||
          !isMediaStage(args[1])
        )
          return false;
        mediaEvent(meta.kind, "media-stage", { stage: args[1] });
        return true;
      case "media.input": {
        if (meta.kind !== "host") throw new Error("无效输入入口");
        const result =
          runtime.session?.id === args[0]
            ? runtime.input(args[1])
            : "unauthorized";
        return args[2] === true ? result : result === "applied";
      }
      case "input.local-buttons":
        if (
          process.platform !== "darwin" ||
          meta.kind !== "remote" ||
          remote?.webContents !== event.sender ||
          !remote.isFocused() ||
          runtime.locked ||
          runtime.session?.role !== "controller" ||
          runtime.session.state !== "connected" ||
          runtime.session.viewOnly
        )
          return null;
        return runtime.native?.localButtons?.() ?? null;
      case "diagnostics.button-recovery":
        if (
          meta.kind === "remote" &&
          remote?.webContents === event.sender &&
          ["pointer-move", "mac-button-state", "next-press"].includes(args[0])
        )
          mediaEvent("remote", "button-release-reconciled", {
            reason: args[0],
          });
        return true;
      case "media.release":
        if (meta.kind === "host") runtime.release();
        return true;
      case "audio.start":
        if (meta.kind !== "host") throw new Error("无效采集入口");
        return runtime.startAudio(String(event.sender.id), (data) =>
          send(host, "pcm", data),
        );
      case "audio.stop":
        if (meta.kind !== "host") throw new Error("无效采集入口");
        runtime.stopAudio();
        return true;
      case "clipboard.flush":
        if (meta.kind !== "remote") throw new Error("无效入口");
        await runtime.clipboard.flush();
        return true;
      case "session.disconnect":
        await runtime.end();
        showHome();
        return true;
      case "session.release": {
        const current = runtime.session;
        if (
          meta.kind !== "remote" ||
          !current ||
          current.id !== args[0] ||
          current.role !== "controller"
        )
          return false;
        return runtime.network.rpc(current.peerId, "input.release", {
          sessionId: current.id,
        });
      }
      case "session.quality":
        return runtime.reconfigure(
          qualitySchema.parse(args[0]),
          String(args[1]),
        );
      case "window.fullscreen": {
        const win = BrowserWindow.fromWebContents(event.sender);
        const full =
          typeof args[0] === "boolean" ? args[0] : !(win && isFullscreen(win));
        if (win) setFullscreen(win, full);
        return full;
      }
      case "window.remote-video-size": {
        const session = runtime.session;
        if (
          !remote ||
          event.sender !== remote.webContents ||
          session?.role !== "controller"
        )
          return false;
        const [sessionId, displayId, width, height] = args;
        if (
          sessionId !== session.id ||
          displayId !== session.displayId ||
          !Number.isInteger(width) ||
          !Number.isInteger(height) ||
          width < 2 ||
          height < 2 ||
          width > 8192 ||
          height > 8192
        )
          return false;
        const source = session.displays.find((d) => d.id === displayId);
        if (!source) return false;
        const ratio = width / height;
        // Ignore an in-flight frame from the display we just switched away from.
        if (Math.abs(ratio / (source.width / source.height) - 1) > 0.02)
          return false;
        const previous = remoteVideoRatio ?? source.width / source.height;
        remoteVideoRatio = ratio;
        if (Math.abs(ratio - previous) > 0.002)
          fitControllerWindow(remote, true);
        return true;
      }
      case "window.hide":
        BrowserWindow.fromWebContents(event.sender)?.close();
        return true;
      case "window.home":
        showHome();
        return true;
      case "quit":
        requestQuit();
        return true;
      case "permissions":
        if (args[0] === "accessibility")
          systemPreferences.isTrustedAccessibilityClient(true);
        else if (args[0] === "screen")
          await shell.openExternal(
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
          );
        return runtime.permissions();
      case "diagnostics.media":
        return {
          videoPlayout: {
            policy: "immediate",
            chromium: process.versions.chrome,
            fieldTrials: app.commandLine.getSwitchValue("force-fieldtrials"),
          },
          inputWorker: runtime.inputService?.status(),
          events: mediaEvents,
          renderers: BrowserWindow.getAllWindows().map((w) => ({
            kind: windows.get(w.webContents.id)?.kind,
            pid: w.webContents.getOSProcessId(),
            crashed: w.webContents.isCrashed(),
            ready: mediaReady.has(w.webContents.id),
            loading: w.webContents.isLoading(),
          })),
        };
      case "benchmark.open":
        if (!runtime.session) throw new Error("没有远控会话");
        return runtime.network.rpc(runtime.session.peerId, "benchmark.open");
      case "diagnostics.export": {
        const result = await dialog.showSaveDialog({
          title: "导出性能记录",
          defaultPath: "NearLink-diagnostics.json",
          filters: [{ name: "JSON", extensions: ["json"] }],
        });
        if (result.canceled || !result.filePath) return null;
        await writeFile(
          result.filePath,
          JSON.stringify(
            {
              version: 1,
              generatedAt: new Date().toISOString(),
              appVersion: app.getVersion(),
              videoPlayout: {
                policy: "immediate",
                chromium: process.versions.chrome,
                fieldTrials:
                  app.commandLine.getSwitchValue("force-fieldtrials"),
              },
              inputWorker: runtime.inputService?.status(),
              os: process.platform,
              arch: process.arch,
              hardware: {
                cpu: os.cpus()[0]?.model,
                memoryGB: Math.round(os.totalmem() / 1024 ** 3),
                displays: runtime.displays(),
                gpu: await app.getGPUInfo("complete").catch(() => null),
              },
              session: runtime.session,
              latest: runtime.metrics,
              samples: args[0],
              applicationVersion: app.getVersion(),
              recentSessionLog: await sessionLog.recent(),
              mediaEvents,
              renderers: BrowserWindow.getAllWindows()
                .filter((w) =>
                  ["host", "remote"].includes(
                    windows.get(w.webContents.id)?.kind ?? "",
                  ),
                )
                .map((w) => ({
                  kind: windows.get(w.webContents.id)?.kind,
                  processId: w.webContents.getOSProcessId(),
                  visible: w.isVisible(),
                  minimized: w.isMinimized(),
                })),
              acceptance: {
                fourK60: "需要合格硬件与真实动态场景验证",
                eightHour: "未自动完成",
              },
            },
            null,
            2,
          ),
        );
        return result.filePath;
      }
      default:
        throw new Error("不支持的操作");
    }
  });
  if (process.argv.includes("--background"))
    home = createWindow("home", "", { show: false });
  else showHome();
  runtime.changed();
  void updater.cleanPreviousAfterReady();
}
app.on("second-instance", showHome);
app.on("activate", () => {
  if (!runtime || BrowserWindow.getFocusedWindow()?.isVisible()) return;
  if (remote?.isVisible() && !remote.isMinimized()) {
    remote.focus();
    remote.webContents.focus();
  } else showHome();
});
app.on("window-all-closed", () => {});
app.on("before-quit", (event) => {
  if (!lock) return;
  if (quitIntent.shouldKeepRunning(process.platform, lock)) {
    event.preventDefault();
    for (const win of BrowserWindow.getAllWindows())
      if (!win.isDestroyed()) win.hide();
    return;
  }
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  stopDxgi();
  if (healthTimer) clearInterval(healthTimer);
  updater?.stop();
  void runtime
    ?.stop()
    .catch((error) => console.error("NearLink shutdown:", error))
    .finally(async () => {
      await sessionLog.flush();
      tray?.destroy();
      app.quit();
    });
});
app
  .whenReady()
  .then(() => {
    if (lock) return initialize();
  })
  .catch(async (error) => {
    console.error(error);
    await dialog.showMessageBox({
      type: "error",
      title: "NearLink 启动失败",
      message: "启动失败",
      detail: String(error?.message ?? error),
    });
    quitting = true;
    requestQuit();
  });
