import {
  app,
  screen,
  desktopCapturer,
  systemPreferences,
  powerMonitor,
  powerSaveBlocker,
} from "electron";
import { EventEmitter } from "node:events";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PeerNetwork } from "./network";
import { runtimeNetworkOptions } from "./network-options";
import { IdentityStore } from "./identity";
import { FileService } from "./files";
import { ClipboardSync } from "./clipboard";
import {
  DEFAULT_QUALITY,
  inputSchema,
  qualitySchema,
  type DisplayInfo,
  type SessionInfo,
  type Snapshot,
  type MediaSignal,
  type Metrics,
  type InputResult,
} from "../src/shared/protocol";
import { mapPoint } from "../src/shared/geometry";
import { WindowsInputService } from "./windows-input";
export class Runtime extends EventEmitter {
  openBenchmark?: (
    display: DisplayInfo,
  ) => Promise<import("../src/shared/protocol").BenchmarkViewport>;
  store = new IdentityStore();
  network = new PeerNetwork(
    this.store,
    runtimeNetworkOptions(
      app.getPath("userData"),
      app.isPackaged,
      !!process.env.NEARLINK_USER_DATA,
      process.env.NEARLINK_DEV_LAN === "1",
    ),
  );
  files = new FileService(this.network);
  clipboard = new ClipboardSync(this.network);
  session: SessionInfo | null = null;
  native: any;
  inputService?: WindowsInputService;
  warning = "";
  locked = false;
  private blocker: number | null = null;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectStarted = 0;
  private stopping = false;
  private seq = -1;
  private audioOwner: string | null = null;
  private lastInputWarning = 0;
  metrics: Metrics | null = null;
  private statsLast = 0;
  private lastPreview = "";
  async init() {
    try {
      const nativePath = path.join(
        app.getAppPath(),
        "native",
        "prebuilds",
        `${process.platform}-${process.arch}`,
        "nearlink.node",
      );
      if (process.platform === "win32") {
        this.inputService = new WindowsInputService(
          nativePath,
          (event, details) => this.emit("input-worker", event, details),
        );
        await this.inputService.start();
      } else this.native = require(nativePath);
    } catch (e: any) {
      this.warning = "原生控制模块未加载：请先运行 npm run native。";
    }
    await this.store.load();
    this.network = new PeerNetwork(
      this.store,
      runtimeNetworkOptions(
        app.getPath("userData"),
        app.isPackaged,
        !!process.env.NEARLINK_USER_DATA,
        process.env.NEARLINK_DEV_LAN === "1",
      ),
    );
    this.files = new FileService(this.network, {
      desktop: app.getPath("desktop"),
      documents: app.getPath("documents"),
      downloads: app.getPath("downloads"),
    });
    this.clipboard = new ClipboardSync(this.network);
    this.network.on("devices", () => this.changed());
    this.files.on("changed", () => this.changed());
    this.network.on("warning", (s) => {
      this.warning = s;
      this.changed();
    });
    this.network.on("closed", (id) => this.onClosed(id));
    this.network.on("ready", () => this.changed());
    this.network.rpcHandler = (id, method, args) => this.rpc(id, method, args);
    this.network.httpHandler = (id, req, res) => {
      this.checkPeerBusy(id);
      return this.files.serve(id, req, res);
    };
    this.network.on("message", (id: string, topic: string, payload: any) => {
      try {
        if (topic === "media.failed") {
          if (!this.session || payload?.sessionId !== this.session.id) return;
          this.onClosed(id);
          return;
        }
        if (topic === "media.signal") {
          if (
            this.session?.peerId !== id ||
            payload?.sessionId !== this.session.id
          )
            return;
          if (
            ![
              "offer",
              "answer",
              "candidate",
              "reconfigure",
              "stop",
              "stats",
            ].includes(payload.kind)
          )
            return;
          if (payload.kind === "stop") {
            void this.end(false);
            return;
          }
          if (payload.kind === "reconfigure" && this.session.role === "host") {
            const q = qualitySchema.parse(payload.data.quality);
            this.session.quality = this.checkQuality(
              q,
              this.session.displays.find(
                (d) => d.id === payload.data.displayId,
              ),
            );
            this.session.displayId = String(payload.data.displayId);
            this.seq = -1;
            this.changed();
          }
          if (
            payload.kind === "reconfigure" &&
            this.session.role === "controller" &&
            Array.isArray(payload.data?.displays)
          ) {
            this.session.displays = payload.data.displays;
            this.session.displayId = payload.data.displayId;
            this.changed();
          }
          if (payload.kind === "stats") this.remoteStats(payload.data);
          this.emit(
            "media",
            this.session.role === "host" ? "host" : "remote",
            payload,
          );
        }
      } catch (e: any) {
        this.warning = String(e.message);
        this.changed();
      }
    });
    await this.network.start();
    screen.on("display-removed", () => this.displaysChanged());
    screen.on("display-metrics-changed", () => this.displaysChanged());
    screen.on("display-added", () => this.displaysChanged());
    powerMonitor.on("lock-screen", () => {
      this.locked = true;
      this.release();
      this.clipboard.stop();
      this.emit("lock", true);
      this.changed();
    });
    powerMonitor.on("unlock-screen", () => {
      this.locked = false;
      if (this.session && !this.session.viewOnly)
        this.clipboard.start(this.session.peerId);
      this.emit("lock", false);
      this.displaysChanged();
      this.changed();
    });
    powerMonitor.on("suspend", () => {
      this.release();
      this.emit("lock", true);
    });
    powerMonitor.on("resume", () => {
      this.network.refreshDiscovery(true);
      this.emit("lock", this.locked);
      if (this.session?.state === "reconnecting") this.scheduleReconnect();
      this.changed();
    });
  }
  displays(): DisplayInfo[] {
    return screen.getAllDisplays().map((d, i) => ({
      id: String(d.id),
      name: d.label || `显示器 ${i + 1}`,
      x: d.bounds.x,
      y: d.bounds.y,
      width: d.bounds.width,
      height: d.bounds.height,
      scale: d.scaleFactor,
      rotation: d.rotation,
      refreshRate: d.displayFrequency || 60,
    }));
  }
  permissions() {
    return {
      native:
        process.platform === "win32"
          ? !!this.inputService?.ready
          : !!this.native,
      screen:
        process.platform === "darwin"
          ? systemPreferences.getMediaAccessStatus("screen")
          : "granted",
      accessibility:
        process.platform === "darwin"
          ? systemPreferences.isTrustedAccessibilityClient(false)
          : !!this.inputService?.ready,
      audio:
        process.platform === "darwin" ? "首次连接时由系统请求" : "系统回环采集",
    };
  }
  snapshot(): Snapshot {
    return {
      self: this.network.self(),
      devices: [...this.network.devices.values()].sort(
        (a, b) =>
          Number(b.online) - Number(a.online) || a.name.localeCompare(b.name),
      ),
      permissions: this.permissions(),
      allowRemote: this.store.allowRemote,
      session: this.session,
      transfers: this.files.tasks.slice(-200),
      error: this.warning || undefined,
      platform: process.platform,
    };
  }
  changed() {
    this.configureInput();
    this.emit("state", this.snapshot());
  }
  private configureInput() {
    if (!this.inputService) return;
    const s = this.session,
      display = s?.displays.find((d) => d.id === s.displayId);
    if (!s || s.role !== "host" || !display) {
      this.inputService.configure(null);
      return;
    }
    const first = screen.dipToScreenPoint({ x: display.x, y: display.y });
    const last = screen.dipToScreenPoint({
      x: display.x + display.width - 1,
      y: display.y + display.height - 1,
    });
    this.inputService.configure({
      sessionId: s.id,
      allowed:
        !s.viewOnly &&
        !this.locked &&
        s.state !== "reconnecting" &&
        this.network.authorized(s.peerId),
      display: {
        x: first.x,
        y: first.y,
        width: last.x - first.x + 1,
        height: last.y - first.y + 1,
      },
    });
  }
  checkPeerBusy(id: string) {
    if (this.locked) throw new Error("电脑已锁定，请在本机解锁后重试");
    if (this.session && this.session.peerId !== id)
      throw new Error("电脑正与其他设备远控，请稍后再试");
  }
  checkQuality(q: any, display?: DisplayInfo) {
    const quality = qualitySchema.parse(q);
    if (
      quality.fps === 120 &&
      (!display ||
        display.refreshRate < 119 ||
        !this.store.verified120.has(this.session?.peerId ?? ""))
    )
      throw new Error("120fps 尚未通过两端高刷实测验证");
    return quality;
  }
  private async rpc(id: string, method: string, args: any) {
    this.checkPeerBusy(id);
    if (method === "preview") {
      if (
        process.platform === "darwin" &&
        this.permissions().screen !== "granted"
      )
        throw new Error("被控端尚未授予屏幕录制权限");
      // Older controllers may continue polling while a session is active.
      // Do not start another GPU readback / thumbnail capture alongside media.
      if (this.session && this.session.state !== "disconnected")
        return { image: this.lastPreview, displays: this.displays() };
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 1120, height: 630 },
      });
      this.lastPreview = sources[0]?.thumbnail.toDataURL() ?? "";
      return {
        image: this.lastPreview,
        displays: this.displays(),
      };
    }
    if (method === "device.info")
      return {
        version: app.getVersion(),
        inputWorker: this.inputService?.status(),
        name: this.store.identity.name,
        platform: process.platform,
        displays: this.displays(),
        permissions: this.permissions(),
      };
    if (method === "session.start") {
      const a = z
        .object({
          viewOnly: z.boolean(),
          quality: qualitySchema,
          localRefreshRate: z.number().min(1).max(1000),
          resumeId: z.string().optional(),
        })
        .parse(args);
      if (this.session && this.session.peerId === id) await this.end(false);
      if (this.permissions().screen !== "granted")
        throw new Error("请在被控端允许屏幕录制");
      if (!a.viewOnly && !this.permissions().accessibility)
        throw new Error("请在被控端允许辅助功能并确认原生模块已安装");
      const displays = this.displays();
      this.session = {
        id: randomUUID(),
        peerId: id,
        role: "host",
        viewOnly: a.viewOnly,
        displayId: displays[0].id,
        displays,
        quality: a.quality,
        state: "connecting",
        remotePlatform: this.network.devices.get(id)!.platform,
        localRefreshRate: a.localRefreshRate,
        allow120: this.store.verified120.has(id) && a.localRefreshRate >= 119,
      };
      this.session.quality = this.checkQuality(a.quality, displays[0]);
      this.seq = -1;
      this.startSessionResources();
      this.changed();
      return this.session;
    }
    if (method === "session.end") {
      await this.end(false);
      return true;
    }
    if (method === "input.release") {
      if (
        this.session &&
        this.session.id === args.sessionId &&
        this.session.peerId === id &&
        this.session.role === "host"
      )
        this.release();
      return true;
    }
    if (method === "clipboard.apply") return this.clipboard.apply(id, args);
    if (method.startsWith("files.")) return this.files.rpc(method, args);
    if (method === "benchmark.open") {
      if (this.session?.peerId !== id || this.session.viewOnly)
        throw new Error("需要可控制的远控会话");
      if (this.session.role !== "host" || !this.openBenchmark)
        throw new Error("需要被控端远控会话");
      const display = this.session.displays.find(
        (d) => d.id === this.session!.displayId,
      )!;
      return this.openBenchmark(display);
    }
    throw new Error("不支持此操作");
  }
  async connectSession(id: string, viewOnly = false) {
    if (
      this.session?.peerId === id &&
      this.session.role === "controller" &&
      this.session.state !== "disconnected"
    ) {
      if (this.session.viewOnly === viewOnly) {
        this.emit("show-remote");
        return this.session;
      }
      // Reconnecting from a preview is an explicit request to change mode.
      // Negotiate it on both devices instead of reusing a read-only session.
      await this.end();
    }
    if (this.session) throw new Error("请先断开当前远控会话");
    await this.network.ensure(id);
    const q = DEFAULT_QUALITY;
    const localRefreshRate = screen.getPrimaryDisplay().displayFrequency || 60;
    const host: SessionInfo = await this.network.rpc(id, "session.start", {
      viewOnly,
      quality: q,
      localRefreshRate,
    });
    this.session = {
      ...host,
      role: "controller",
      peerId: id,
      remotePlatform: this.network.devices.get(id)!.platform,
      localRefreshRate,
      allow120: host.allow120 && localRefreshRate >= 119,
    };
    this.reconnectStarted = 0;
    this.startSessionResources();
    this.changed();
    this.emit("show-remote");
    return this.session;
  }
  private startSessionResources() {
    if (this.blocker === null)
      this.blocker = powerSaveBlocker.start("prevent-app-suspension");
    if (this.session && !this.session.viewOnly && !this.locked)
      this.clipboard.start(this.session.peerId);
  }
  async end(notify = true) {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const s = this.session;
    this.release();
    this.stopAudio();
    this.clipboard.stop();
    if (s) {
      this.emit("media", s.role === "host" ? "host" : "remote", {
        kind: "stop",
        sessionId: s.id,
      });
      if (notify)
        try {
          this.network.send(s.peerId, "media.signal", {
            kind: "stop",
            sessionId: s.id,
          });
        } catch {}
    }
    this.session = null;
    this.metrics = null;
    if (this.blocker !== null) {
      powerSaveBlocker.stop(this.blocker);
      this.blocker = null;
    }
    this.emit("session-ended");
    this.changed();
  }
  signal(signal: MediaSignal) {
    if (!this.session || signal.sessionId !== this.session.id)
      throw new Error("会话已结束");
    if (signal.kind === "stats") {
      this.remoteStats(signal.data);
      this.emit("local-metrics", signal.data);
    }
    this.network.send(this.session.peerId, "media.signal", signal);
  }
  mediaFailed(sessionId: string) {
    if (!this.session || this.session.id !== sessionId) return;
    try {
      this.network.send(this.session.peerId, "media.failed", { sessionId });
    } catch {}
    this.onClosed(this.session.peerId);
  }
  mediaConnected(sessionId: string) {
    if (this.session?.id === sessionId) {
      this.session.state = "connected";
      this.session.reason = undefined;
      this.reconnectStarted = 0;
      this.changed();
    }
  }
  mediaError(message: string) {
    if (this.session) {
      this.session.reason = message;
      this.warning = message;
      this.changed();
    }
  }
  input(data: any): InputResult {
    // Windows inputs must use the direct renderer -> utility MessagePort.
    // Reintroducing native SendInput on the UI thread can deadlock button-up.
    if (process.platform === "win32")
      throw new Error("Windows输入必须经过独立后台通道");
    const s = this.session;
    if (
      !s ||
      s.role !== "host" ||
      s.viewOnly ||
      this.locked ||
      s.state === "reconnecting" ||
      !this.network.authorized(s.peerId)
    )
      return "unauthorized";
    const event = inputSchema.parse(data);
    if ("seq" in event && event.seq !== undefined) {
      if (event.type === "move" && event.seq <= this.seq) return "stale";
      this.seq = Math.max(this.seq, event.seq);
    }
    const display = s.displays.find((d) => d.id === s.displayId);
    if (!display) return "unauthorized";
    let eventData: any = event;
    if (event.type === "move" || event.type === "button") {
      const p = mapPoint(event.x, event.y, display);
      eventData = { ...event, screenX: p.x, screenY: p.y };
    }
    const success = this.native?.input(eventData);
    if (!success && Date.now() - this.lastInputWarning > 10000) {
      this.lastInputWarning = Date.now();
      this.warning = "系统阻止了输入，请检查辅助功能权限或目标窗口的权限等级。";
      this.changed();
    }
    return success ? "applied" : "native-rejected";
  }
  release() {
    this.inputService?.release();
    try {
      this.native?.input({ type: "release" });
    } catch {}
  }
  async source() {
    const current = this.session;
    if (!current || current.role !== "host" || this.locked)
      throw new Error("没有可采集的会话");
    const displayId = current.displayId;
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 0, height: 0 },
    });
    if (
      this.session?.id !== current.id ||
      this.session.displayId !== displayId ||
      this.locked
    )
      throw new Error("会话或显示器已变更");
    const s = sources.find((s) => s.display_id === displayId);
    if (!s) throw new Error("显示器已断开");
    return {
      sourceId: s.id,
      session: current,
      platform: process.platform,
    };
  }
  async reconfigure(q: unknown, displayId: string) {
    if (!this.session || this.session.role !== "controller")
      throw new Error("没有远控会话");
    const display = this.session.displays.find((d) => d.id === displayId);
    if (!display) throw new Error("显示器不存在");
    const quality = this.checkQuality(q, display);
    if (quality.fps > this.session.localRefreshRate)
      throw new Error("本机显示器刷新率不足");
    this.session.quality = quality;
    this.session.displayId = displayId;
    this.network.send(this.session.peerId, "media.signal", {
      sessionId: this.session.id,
      kind: "reconfigure",
      data: { quality, displayId },
    });
    this.changed();
  }
  startAudio(owner: string, callback: (data: any) => void) {
    if (!this.session || this.session.role !== "host" || this.locked)
      throw new Error("音频采集不可用");
    if (process.platform !== "darwin")
      throw new Error("Windows 音频由系统回环采集");
    this.stopAudio();
    this.audioOwner = owner;
    return this.native.startAudio(callback);
  }
  stopAudio() {
    this.audioOwner = null;
    try {
      this.native?.stopAudio?.();
    } catch {}
  }
  remoteStats(data: any) {
    if (!data || typeof data.rttMs !== "number") return;
    const now = Date.now();
    if (now - this.statsLast < 500) return;
    this.statsLast = now;
    this.metrics = data;
    if (data.rttMs > 30 || data.loss > 0.02 || data.jitterMs > 40)
      this.files.rate = Math.max(64 * 1024, this.files.rate * 0.6);
    else
      this.files.rate = Math.min(
        32 * 1024 * 1024,
        this.files.rate + 512 * 1024,
      );
    this.emit("metrics", data);
  }
  private onClosed(id: string) {
    if (
      this.session?.peerId !== id ||
      this.stopping ||
      this.session.state === "reconnecting"
    )
      return;
    this.release();
    this.stopAudio();
    this.clipboard.stop();
    this.session.state = "reconnecting";
    this.session.reason = "连接中断，正在尝试恢复";
    this.emit("media", this.session.role === "host" ? "host" : "remote", {
      kind: "stop",
      sessionId: this.session.id,
    });
    this.changed();
    if (this.session.role === "controller") {
      this.reconnectStarted = Date.now();
      this.scheduleReconnect();
    }
  }
  private scheduleReconnect() {
    if (
      this.stopping ||
      this.reconnectTimer ||
      this.session?.role !== "controller"
    )
      return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      const old = this.session;
      if (!old || old.role !== "controller" || this.stopping) return;
      try {
        await this.network.ensure(old.peerId);
        if (this.session !== old || this.stopping) return;
        const next = await this.network.rpc(old.peerId, "session.start", {
          viewOnly: old.viewOnly,
          quality: old.quality,
          localRefreshRate: old.localRefreshRate,
          resumeId: old.id,
        });
        if (this.session !== old || this.stopping) return;
        this.session = {
          ...next,
          role: "controller",
          peerId: old.peerId,
          remotePlatform: old.remotePlatform,
          localRefreshRate: old.localRefreshRate,
        };
        this.startSessionResources();
        this.changed();
        this.emit("restart-remote");
      } catch {
        if (this.session === old && !this.stopping) this.scheduleReconnect();
      }
    }, 1500);
  }
  private displaysChanged() {
    if (!this.session) return;
    if (this.session.role === "host") {
      const displays = this.displays();
      if (!displays.length) {
        this.mediaError("没有可用显示器");
        return;
      }
      this.session.displays = displays;
      if (!displays.some((d) => d.id === this.session!.displayId))
        this.session.displayId = displays[0].id;
      try {
        this.network.send(this.session.peerId, "media.signal", {
          kind: "reconfigure",
          sessionId: this.session.id,
          data: {
            quality: this.session.quality,
            displayId: this.session.displayId,
            displays,
          },
        });
      } catch {}
      this.emit("media", "host", {
        kind: "reconfigure",
        sessionId: this.session.id,
        data: {
          quality: this.session.quality,
          displayId: this.session.displayId,
        },
      });
    }
    this.changed();
  }
  async toggleRemote(allow: boolean) {
    this.store.allowRemote = allow;
    await this.store.save();
    if (!allow) {
      this.files.cancelAll();
      this.network.closeIncoming();
      await this.end();
      for (const l of this.network.links.values()) l.ws.close();
    }
    this.changed();
  }
  async stop() {
    this.stopping = true;
    this.files.cancelAll();
    await this.end();
    await this.network.stop();
    await this.inputService?.stop();
  }
}
