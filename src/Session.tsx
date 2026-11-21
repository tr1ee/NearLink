import { useEffect, useRef, useState } from "react";
import {
  Monitor,
  Folder,
  Volume2,
  VolumeX,
  Minimize,
  Maximize,
  SlidersHorizontal,
  Activity,
  ChevronDown,
  ArrowLeft,
  Download,
  X,
  Play,
  Square,
} from "lucide-react";
import { api, useSnapshot, message, bytes } from "./hooks";
import { ChromiumMediaEngine } from "./media/engine";
import type { Metrics, Quality, BenchmarkViewport } from "./shared/protocol";
import { videoPoint } from "./shared/geometry";
import { measureLatency, type LatencyResult } from "./media/benchmark";
import { ErrorNote, StatusDot } from "./components";
import { isModifier, remoteKeyAction } from "./media/keyboard";
const mouseButtonMask = [1, 4, 2]; // DOM order: left, middle, right.
export default function Session() {
  const [isFullscreen, setIsFullscreen] = useState(true);
  const [pixelMode, setPixelMode] = useState(false);
  const [videoSize, setVideoSize] = useState({ width: 0, height: 0 });
  const { state } = useSnapshot();
  const video = useRef<HTMLVideoElement>(null);
  const ime = useRef<HTMLTextAreaElement>(null);
  const engine = useRef<ChromiumMediaEngine | null>(null);
  const samples = useRef<Metrics[]>([]);
  const latency = useRef<LatencyResult | null>(null);
  const benchmarkViewport = useRef<BenchmarkViewport | null>(null);
  const forwarded = useRef(new Map<string, string>());
  const pressedButtons = useRef(new Map<number, number>());
  const buttonCheckPending = useRef(false);
  const buttonPressEpoch = useRef(0);
  const keyboardEpoch = useRef(0);
  const lastPoint = useRef({ x: 0.5, y: 0.5 });
  const lastRawMouse = useRef<{ x: number; y: number; at: number } | null>(
    null,
  );
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [visible, setVisible] = useState(true);
  const [panel, setPanel] = useState<"quality" | "diagnostics" | null>(null);
  const [volume, setVolume] = useState(1);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(0);
  const [probing, setProbing] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const hide = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const session = state?.session;
  const canControl = session?.state === "connected" && !session.viewOnly;
  const inputEnabled = canControl && !panel && !probing;
  const inputAllowed = useRef(false);
  inputAllowed.current = inputEnabled;
  const peer = state?.devices.find((d) => d.id === session?.peerId);
  const focusedPanel = useRef(false);
  focusedPanel.current = !!panel;
  useEffect(() => {
    const e = new ChromiumMediaEngine(video.current!);
    engine.current = e;
    e.onStats = (m) => {
      setMetrics(m);
      samples.current.push(m);
      if (samples.current.length > 28800) samples.current.shift();
    };
    e.onState = (s) => {
      if (
        ![
          "new",
          "connecting",
          "connected",
          "closed",
          "display-changed",
        ].includes(s)
      )
        setError(s === "disconnected" ? "连接中断，正在恢复…" : s);
    };
    void api
      .invoke("state")
      .then((s) => {
        if (
          s.session?.role === "controller" &&
          s.session.state !== "reconnecting"
        )
          return e.start(s.session);
      })
      .catch((err) => setError(message(err)));
    const off = api.on("release", () => {
      clearInput(false);
      abort.current?.abort();
    });
    return () => {
      off();
      clearInput();
      e.dispose();
      abort.current?.abort();
      if (hide.current) clearTimeout(hide.current);
    };
  }, []);
  useEffect(() => {
    engine.current?.setVolume(volume);
  }, [volume]);
  useEffect(() => {
    if (session?.state === "connected") setError("");
  }, [session?.state]);
  function reveal() {
    setVisible(true);
    if (hide.current) clearTimeout(hide.current);
    hide.current = setTimeout(() => {
      if (!focusedPanel.current) setVisible(false);
    }, 2200);
  }
  useEffect(() => {
    reveal();
  }, []);
  useEffect(() => api.on("fullscreen", setIsFullscreen), []);
  useEffect(() => {
    const cancel = () => clearInput();
    const visibility = () => {
      if (document.hidden) cancel();
    };
    const up = (event: MouseEvent) => {
      finishButton(
        event.button,
        point(event) ?? lastPoint.current,
        event.timeStamp,
      );
    };
    const pointerState = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && pressedButtons.current.size)
        reconcileButtons(
          event.buttons,
          point(event) ?? lastPoint.current,
          event.timeStamp,
          event.type === "pointerup" ? "pointerup" : "pointer-move",
        );
    };
    window.addEventListener("blur", cancel);
    window.addEventListener("mouseup", up, true);
    window.addEventListener("pointerup", pointerState, true);
    window.addEventListener("pointermove", pointerState, true);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("blur", cancel);
      window.removeEventListener("mouseup", up, true);
      window.removeEventListener("pointerup", pointerState, true);
      window.removeEventListener("pointermove", pointerState, true);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  useEffect(() => {
    const focus = () => {
      if (!focusedPanel.current) ime.current?.focus({ preventScroll: true });
    };
    window.addEventListener("focus", focus);
    return () => {
      window.removeEventListener("focus", focus);
    };
  }, []);
  useEffect(() => {
    if (!panel && canControl) ime.current?.focus({ preventScroll: true });
  }, [panel, canControl, isFullscreen]);
  useEffect(() => {
    if (!inputEnabled) clearInput();
  }, [inputEnabled, session?.displayId]);
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const move = (event: Event) => {
      if (
        !(event instanceof PointerEvent) ||
        event.pointerType !== "mouse" ||
        !inputAllowed.current
      )
        return;
      const p = videoPoint(
        event.clientX,
        event.clientY,
        v.getBoundingClientRect(),
        v.videoWidth,
        v.videoHeight,
      );
      reconcileButtons(
        event.buttons,
        p ?? lastPoint.current,
        event.timeStamp,
        "pointer-move",
      );
      if (p) {
        lastRawMouse.current = {
          x: event.clientX,
          y: event.clientY,
          at: event.timeStamp,
        };
        lastPoint.current = p;
        engine.current?.input({ type: "move", ...p, seq: 0 });
      }
    };
    if ("onpointerrawupdate" in v)
      v.addEventListener("pointerrawupdate", move, { passive: true });
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (inputAllowed.current && point(e))
        engine.current?.input({
          type: "wheel",
          dx: Math.max(-2000, Math.min(2000, e.deltaX)),
          dy: Math.max(-2000, Math.min(2000, e.deltaY)),
        });
    };
    v.addEventListener("wheel", wheel, { passive: false });
    return () => {
      v.removeEventListener("pointerrawupdate", move);
      v.removeEventListener("wheel", wheel);
    };
  }, []);
  function finishButton(
    button: number,
    position: { x: number; y: number },
    at: number,
  ) {
    const downAt = pressedButtons.current.get(button);
    if (downAt === undefined || downAt > at) return false;
    pressedButtons.current.delete(button);
    buttonPressEpoch.current++;
    engine.current?.input({ type: "button", button, down: false, ...position });
    return true;
  }
  function reconcileButtons(
    buttons: number,
    position: { x: number; y: number },
    at: number,
    source: "pointerup" | "pointer-move" | "mac-button-state",
  ) {
    for (const button of pressedButtons.current.keys()) {
      if (
        !(buttons & mouseButtonMask[button]) &&
        finishButton(button, position, at) &&
        source !== "pointerup"
      )
        noteMissingButtonUp(source);
    }
  }
  function noteMissingButtonUp(
    source: "pointer-move" | "mac-button-state" | "next-press",
  ) {
    void api.invoke("diagnostics.button-recovery", source).catch(() => {});
  }
  function scheduleButtonCheck() {
    if (buttonCheckPending.current || !pressedButtons.current.size) return;
    buttonCheckPending.current = true;
    setTimeout(async () => {
      try {
        if (!pressedButtons.current.size) return;
        const epoch = buttonPressEpoch.current;
        const mask = await api.invoke<number | null>("input.local-buttons");
        if (epoch === buttonPressEpoch.current && typeof mask === "number")
          reconcileButtons(
            mask,
            lastPoint.current,
            Infinity,
            "mac-button-state",
          );
      } catch {
        // Browser events still handle release if local state is unavailable.
      } finally {
        buttonCheckPending.current = false;
        scheduleButtonCheck();
      }
    }, 32);
  }
  function clearInput(send = true) {
    const held = pressedButtons.current.size || forwarded.current.size;
    pressedButtons.current.clear();
    buttonPressEpoch.current++;
    forwarded.current.clear();
    lastRawMouse.current = null;
    keyboardEpoch.current++;
    video.current?.classList.remove("remote-cursor-only");
    if (send && held) engine.current?.release();
  }
  function point(e: { clientX: number; clientY: number }) {
    const v = video.current;
    return v
      ? videoPoint(
          e.clientX,
          e.clientY,
          v.getBoundingClientRect(),
          v.videoWidth,
          v.videoHeight,
        )
      : null;
  }
  function keyDown(e: React.KeyboardEvent) {
    if (!inputAllowed.current) return;
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const action = remoteKeyAction(e, session?.remotePlatform ?? "");
    if (action === "paste") {
      e.preventDefault();
      const epoch = keyboardEpoch.current;
      void api
        .invoke("clipboard.flush")
        .then(() => {
          if (epoch !== keyboardEpoch.current) return;
          engine.current?.input({ type: "paste" });
          // Native paste releases its temporary modifiers. Restore only keys
          // still physically held, so the next Ctrl/Cmd shortcut also works.
          for (const code of forwarded.current.values())
            if (isModifier(code))
              engine.current?.input({ type: "key", code, down: true });
        })
        .catch((err) => setError(message(err)));
      return;
    }
    if (action === "text") return;
    e.preventDefault();
    const code = e.code;
    forwarded.current.set(e.code, code);
    engine.current?.input({ type: "key", code, down: true });
  }
  function keyUp(e: React.KeyboardEvent) {
    // macOS can omit a letter's keyup while Command is held. End those keys
    // when Command is released so Win shortcuts cannot leave repeating keys.
    if (state?.platform === "darwin" && e.code.startsWith("Meta") && !e.metaKey)
      for (const [local, remote] of forwarded.current) {
        if (!isModifier(local)) {
          engine.current?.input({ type: "key", code: remote, down: false });
          forwarded.current.delete(local);
        }
      }
    const code = forwarded.current.get(e.code);
    if (code) {
      e.preventDefault();
      engine.current?.input({ type: "key", code, down: false });
      forwarded.current.delete(e.code);
    }
  }
  function commit(e: React.FormEvent<HTMLTextAreaElement>) {
    if ((e.nativeEvent as InputEvent).isComposing) return;
    const text = e.currentTarget.value;
    if (text && inputAllowed.current) {
      engine.current?.input({ type: "text", text });
    }
    e.currentTarget.value = "";
  }
  async function applyQuality(q: Quality, displayId = session?.displayId) {
    try {
      if (displayId !== session?.displayId) clearInput();
      await engine.current?.reconfigure(q, displayId!);
      setError("");
    } catch (e) {
      setError(message(e));
    }
  }
  async function probe() {
    if (!video.current || !engine.current) return;
    if (
      !benchmarkViewport.current ||
      benchmarkViewport.current.displayId !== session?.displayId
    ) {
      setError("请先在当前显示器打开对端性能测试画面。");
      return;
    }
    setError("");
    setProbing(true);
    setProgress(0);
    const controller = (abort.current = new AbortController());
    try {
      latency.current = await measureLatency(
        video.current,
        engine.current,
        controller.signal,
        setProgress,
        benchmarkViewport.current,
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setProbing(false);
    }
  }
  async function exportReport() {
    try {
      await api.invoke("diagnostics.export", {
        metrics: samples.current,
        latency: latency.current,
        notes:
          "是否满足4K60与8小时稳定性验收，须结合实际测试时长、动态内容、硬件及网络条件判断。",
      });
    } catch (e) {
      setError(message(e));
    }
  }
  return (
    <div className="session-shell" onContextMenu={(e) => e.preventDefault()}>
      <div className={"session-viewport " + (pixelMode ? "pixel-mode" : "")}>
        <div className="video-surface">
          <video
            ref={video}
            autoPlay
            playsInline
            draggable={false}
            className="remote-video"
            style={
              pixelMode && videoSize.width
                ? {
                    width: videoSize.width / devicePixelRatio,
                    height: videoSize.height / devicePixelRatio,
                  }
                : undefined
            }
            onResize={() => {
              const current = video.current;
              if (!current) return;
              const { videoWidth: width, videoHeight: height } = current;
              setVideoSize({ width, height });
              if (width && height && session)
                void api
                  .invoke(
                    "window.remote-video-size",
                    session.id,
                    session.displayId,
                    width,
                    height,
                  )
                  .catch(() => {});
            }}
            onDragStart={(e) => e.preventDefault()}
            onPointerEnter={(e) => {
              e.currentTarget.classList.toggle(
                "remote-cursor-only",
                inputEnabled && !!point(e),
              );
            }}
            onPointerLeave={(e) =>
              e.currentTarget.classList.remove("remote-cursor-only")
            }
            onPointerMove={(e) => {
              if (e.clientY < 70) reveal();
              const p = point(e);
              e.currentTarget.classList.toggle(
                "remote-cursor-only",
                inputEnabled &&
                  !!p &&
                  (!pressedButtons.current.size ||
                    document.elementFromPoint(e.clientX, e.clientY) ===
                      e.currentTarget),
              );
              if (!inputEnabled) return;
              const raw = lastRawMouse.current;
              if (
                raw &&
                e.pointerType === "mouse" &&
                (e.timeStamp < raw.at ||
                  (e.timeStamp - raw.at < 30 &&
                    e.clientX === raw.x &&
                    e.clientY === raw.y))
              )
                return;
              if (p) {
                lastPoint.current = p;
                engine.current?.input({ type: "move", ...p, seq: 0 });
              }
            }}
            onPointerDown={(e) => {
              if (
                inputEnabled &&
                e.pointerType === "mouse" &&
                point(e) &&
                e.button >= 0 &&
                e.button <= 2
              )
                e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onMouseDown={(e) => {
              if (!inputEnabled || e.button < 0 || e.button > 2) return;
              const p = point(e);
              if (p) {
                // Keep the hidden IME field focused. Otherwise the browser's
                // default pointer action focuses the video *after* this handler.
                e.preventDefault();
                if (finishButton(e.button, lastPoint.current, e.timeStamp))
                  noteMissingButtonUp("next-press");
                lastPoint.current = p;
                if (ime.current) {
                  ime.current.style.left = `${e.clientX}px`;
                  ime.current.style.top = `${e.clientY}px`;
                }
                ime.current?.focus({ preventScroll: true });
                buttonPressEpoch.current++;
                pressedButtons.current.set(e.button, e.timeStamp);
                engine.current?.input({
                  type: "button",
                  button: e.button as 0 | 1 | 2,
                  down: true,
                  ...p,
                });
                const capabilities = (
                  e.nativeEvent as MouseEvent & {
                    sourceCapabilities?: { firesTouchEvents: boolean };
                  }
                ).sourceCapabilities;
                if (
                  state?.platform === "darwin" &&
                  !capabilities?.firesTouchEvents
                )
                  scheduleButtonCheck();
              }
            }}
            onPointerCancel={() => clearInput()}
            onLostPointerCapture={() => {
              // The compatibility mouseup can follow pointer capture loss.
              const epoch = buttonPressEpoch.current;
              setTimeout(() => {
                if (
                  buttonPressEpoch.current === epoch &&
                  pressedButtons.current.size
                )
                  clearInput();
              }, 0);
            }}
          />
        </div>
      </div>
      <textarea
        ref={ime}
        disabled={!canControl}
        className="ime-input"
        aria-label="远程键盘输入"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onKeyDown={keyDown}
        onKeyUp={keyUp}
        onInput={commit}
        onCompositionEnd={(e) => {
          if (inputAllowed.current && e.data)
            engine.current?.input({ type: "text", text: e.data });
          e.currentTarget.value = "";
        }}
        onBlur={() => clearInput()}
      />
      <div className="toolbar-reveal" onMouseEnter={reveal} />
      <nav
        className={"session-toolbar " + (visible || panel ? "shown" : "")}
        aria-label="远控工具栏"
        onMouseEnter={() => {
          if (hide.current) clearTimeout(hide.current);
          setVisible(true);
        }}
        onMouseLeave={reveal}
      >
        <span className="session-peer">
          <StatusDot online={session?.state === "connected"} />
          {peer?.name ?? "正在连接"}
          {session?.viewOnly && <small>仅观看</small>}
        </span>
        <i />
        <label className="display-select">
          <Monitor size={18} />
          <select
            aria-label="选择显示器"
            value={session?.displayId ?? ""}
            onChange={(e) =>
              void applyQuality(session!.quality, e.target.value).finally(() =>
                ime.current?.focus({ preventScroll: true }),
              )
            }
          >
            {session?.displays.map((d, i) => (
              <option value={d.id} key={d.id}>{`显示器 ${i + 1}`}</option>
            ))}
          </select>
        </label>
        <button onClick={() => void api.invoke("files.open", session?.peerId)}>
          <Folder size={18} />
          文件
        </button>
        <button
          onClick={() => setPanel(panel === "quality" ? null : "quality")}
          title="分辨率与帧率"
        >
          <SlidersHorizontal size={18} />
          画质
        </button>
        <button
          aria-label={volume ? "静音" : "开启声音"}
          onClick={() => {
            setVolume(volume ? 0 : 1);
            ime.current?.focus({ preventScroll: true });
          }}
        >
          {volume ? <Volume2 size={18} /> : <VolumeX size={18} />}
        </button>
        <button
          onClick={() =>
            void api
              .invoke("window.fullscreen")
              .then(() => ime.current?.focus({ preventScroll: true }))
          }
          title={isFullscreen ? "退出全屏" : "进入全屏"}
        >
          {isFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
        </button>
        <button
          aria-label="性能诊断"
          onClick={() =>
            setPanel(panel === "diagnostics" ? null : "diagnostics")
          }
        >
          <Activity size={18} />
        </button>
        <i />
        <button
          className="danger"
          onClick={() => void api.invoke("session.disconnect")}
        >
          断开
        </button>
      </nav>
      {session?.state !== "connected" ? (
        <div className="connection-overlay">
          <div className="connection-spinner" />
          <h2>
            {session?.state === "reconnecting"
              ? "正在恢复连接"
              : "正在连接远程桌面"}
          </h2>
          <p>{session?.reason ?? "正在建立加密音视频通道"}</p>
          <button onClick={() => void api.invoke("session.disconnect")}>
            取消连接
          </button>
        </div>
      ) : null}
      {panel ? (
        <aside className="session-panel">
          <header>
            <h2>{panel === "quality" ? "画质设置" : "性能诊断"}</h2>
            <button
              className="icon-button"
              aria-label="关闭面板"
              onClick={() => {
                setPanel(null);
                reveal();
              }}
            >
              <X size={18} />
            </button>
          </header>
          {panel === "quality" && session ? (
            <>
              <div className="quality-presets">
                <button
                  onClick={() =>
                    void applyQuality({
                      height: 2160,
                      fps: session.quality.fps,
                      auto: false,
                    })
                  }
                >
                  原生清晰
                </button>
                <button
                  onClick={() =>
                    void applyQuality({
                      height: 2160,
                      fps: session.quality.fps,
                      auto: true,
                    })
                  }
                >
                  自动流畅
                </button>
              </div>
              <label className="setting-field">
                画面显示
                <select
                  value={pixelMode ? "pixel" : "fit"}
                  onChange={(e) => setPixelMode(e.target.value === "pixel")}
                >
                  <option value="fit">适应窗口</option>
                  <option value="pixel">原始像素 · 100%（可滚动）</option>
                </select>
              </label>
              <p className="fine-print">
                当前接收 {videoSize.width || "—"} × {videoSize.height || "—"}
                。原生清晰保持源屏分辨率（最高4K），网络不足时可切回自动流畅。
              </p>
              <label className="setting-field">
                分辨率上限
                <select
                  value={session.quality.height}
                  onChange={(e) =>
                    void applyQuality({
                      ...session.quality,
                      height: Number(e.target.value) as Quality["height"],
                    })
                  }
                >
                  <option value="2160">4K · 3840 × 2160</option>
                  <option value="1440">1440p</option>
                  <option value="1080">1080p</option>
                  <option value="720">720p</option>
                </select>
              </label>
              <label className="setting-field">
                目标帧率
                <select
                  value={session.quality.fps}
                  onChange={(e) =>
                    void applyQuality({
                      ...session.quality,
                      fps: Number(e.target.value) as Quality["fps"],
                    })
                  }
                >
                  <option value="30">30 fps</option>
                  <option value="60">60 fps</option>
                  <option value="120" disabled={!session.allow120}>
                    120 fps{!session.allow120 ? " · 待实测验证" : ""}
                  </option>
                </select>
              </label>
              <div className="setting-row">
                <span>
                  低延迟自动调整<small>网络或性能不足时自动降低画质。</small>
                </span>
                <button
                  className={"toggle " + (session.quality.auto ? "on" : "")}
                  role="switch"
                  aria-label="低延迟自动调整"
                  aria-checked={session.quality.auto}
                  onClick={() =>
                    void applyQuality({
                      ...session.quality,
                      auto: !session.quality.auto,
                    })
                  }
                >
                  <span />
                </button>
              </div>
              <p className="fine-print">
                实际画面以源显示器、两端编解码能力和网络为限。源桌面低于4K时不放大凑分辨率。
              </p>
              <label className="setting-field">
                播放音量
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={volume}
                  onChange={(e) => setVolume(Number(e.target.value))}
                />
              </label>
            </>
          ) : (
            <>
              <div className="metric-grid">
                <Metric
                  label="实际分辨率"
                  value={
                    metrics?.width
                      ? `${metrics.width} × ${metrics.height}`
                      : "等待画面"
                  }
                />
                <Metric
                  label="呈现帧率"
                  value={metrics ? `${metrics.renderFps.toFixed(1)} fps` : "—"}
                />
                <Metric
                  label="采集 / 编码 / 解码 fps"
                  value={
                    metrics
                      ? `${metrics.captureFps.toFixed(1)} / ${metrics.encodeFps.toFixed(1)} / ${metrics.decodeFps.toFixed(1)}`
                      : "—"
                  }
                />
                <Metric
                  label="视频采集"
                  value={
                    metrics?.captureFallback
                      ? "Chromium（DXGI 回退）"
                      : metrics?.captureBackend === "dxgi"
                        ? "DXGI"
                        : metrics?.captureBackend === "chromium"
                          ? "Chromium"
                          : "—"
                  }
                />
                <Metric
                  label="目标 / 采集配置 fps"
                  value={
                    metrics
                      ? `${metrics.targetFps ?? "—"} / ${metrics.configuredFps?.toFixed(1) ?? "—"}`
                      : "—"
                  }
                />
                <Metric
                  label="网络 RTT"
                  value={metrics ? `${metrics.rttMs.toFixed(1)} ms` : "—"}
                />
                <Metric
                  label="输入通道 RTT"
                  value={
                    metrics?.inputRttMs !== undefined
                      ? `${metrics.inputRttMs.toFixed(1)} ms`
                      : "—"
                  }
                />
                <Metric
                  label="输入执行往返"
                  value={
                    metrics?.inputAppliedRttMs !== undefined
                      ? `${metrics.inputAppliedRttMs.toFixed(1)} ms`
                      : "—"
                  }
                />
                <Metric
                  label="采集到呈现 · 中位 / P95（估计）"
                  value={
                    metrics?.videoAgeMs !== undefined
                      ? `${metrics.videoAgeMs.toFixed(1)} / ${metrics.videoAgeP95Ms?.toFixed(1) ?? "—"} ms`
                      : "未报告"
                  }
                />
                <Metric
                  label="采集帧间隔（平均）"
                  value={
                    metrics?.captureFps
                      ? `${(1000 / metrics.captureFps).toFixed(1)} ms`
                      : "—"
                  }
                />
                <Metric
                  label="本机接收到呈现"
                  value={
                    metrics?.receiveToPresentMs !== undefined
                      ? `${metrics.receiveToPresentMs.toFixed(1)} ms`
                      : "未报告"
                  }
                />
                <Metric
                  label="接收到提交 / 提交到预计显示"
                  value={
                    metrics?.receiveToSubmitMs !== undefined &&
                    metrics?.submitToDisplayMs !== undefined
                      ? `${metrics.receiveToSubmitMs.toFixed(1)} / ${metrics.submitToDisplayMs.toFixed(1)} ms`
                      : "未报告"
                  }
                />
                <Metric
                  label="被控输入执行"
                  value={
                    metrics?.inputQueueMs !== undefined
                      ? `${metrics.inputQueueMs.toFixed(1)} ms`
                      : "—"
                  }
                />
                {metrics?.inputButtons && (
                  <>
                    <Metric
                      label="已执行 / 已收到按下"
                      value={`${metrics.inputButtons.appliedDown} / ${metrics.inputButtons.down}`}
                    />
                    <Metric
                      label="已执行 / 已收到松开"
                      value={`${metrics.inputButtons.appliedUp} / ${metrics.inputButtons.up}`}
                    />
                    {!!metrics.inputButtons.alreadyUp && (
                      <Metric
                        label="按键已松开时收到的抬起"
                        value={String(metrics.inputButtons.alreadyUp)}
                      />
                    )}
                    {!!metrics.inputButtons.trayClicks && (
                      <Metric
                        label="按原位完成的托盘点击"
                        value={String(metrics.inputButtons.trayClicks)}
                      />
                    )}
                    <Metric
                      label="系统拒绝 / 进程不可用 / 会话限制"
                      value={`${metrics.inputButtons.nativeRejected} / ${metrics.inputButtons.unavailable} / ${metrics.inputButtons.unauthorized}`}
                    />
                  </>
                )}
                <Metric
                  label="视频发送排队"
                  value={
                    metrics?.sendQueueMs !== undefined
                      ? `${metrics.sendQueueMs.toFixed(1)} ms`
                      : "—"
                  }
                />
                <Metric
                  label="视频缓冲 / 每秒丢帧"
                  value={
                    metrics?.jitterBufferMs !== undefined
                      ? `${metrics.jitterBufferMs.toFixed(1)} ms / ${metrics.frameDrops ?? 0}`
                      : "—"
                  }
                />
                <Metric
                  label="编码 / 解码"
                  value={
                    metrics
                      ? `${metrics.encodeMs.toFixed(1)} / ${metrics.decodeMs.toFixed(1)} ms`
                      : "—"
                  }
                />
                <Metric
                  label="实际码率"
                  value={
                    metrics
                      ? metrics.bitrate >= 1e6
                        ? `${(metrics.bitrate / 1e6).toFixed(1)} Mbps`
                        : `${(metrics.bitrate / 1000).toFixed(0)} kbps`
                      : "—"
                  }
                />
                <Metric
                  label="视频编码格式"
                  value={metrics?.videoCodec ?? "未报告"}
                />
                <Metric
                  label="媒体传输路径"
                  value={metrics?.mediaTransport ?? "未报告"}
                />
                <Metric
                  label="缓冲目标 / 网络最低缓冲"
                  value={
                    metrics?.jitterBufferTargetMs !== undefined
                      ? `${metrics.jitterBufferTargetMs.toFixed(1)} / ${metrics.jitterBufferMinimumMs?.toFixed(1) ?? "—"} ms`
                      : "未报告"
                  }
                />
                <Metric
                  label="丢包"
                  value={metrics ? `${(metrics.loss * 100).toFixed(2)}%` : "—"}
                />
                <Metric
                  label="卡顿次数"
                  value={String(metrics?.freezes ?? 0)}
                />
                <Metric label="编码后端" value={metrics?.encoder ?? "待测量"} />
                <Metric label="解码后端" value={metrics?.decoder ?? "待测量"} />
              </div>
              <p className="fine-print">
                视频采用收到即解码的低延迟播放策略，网络抖动时可能增加丢帧。请以实际缓冲和采集到呈现耗时判断效果。
              </p>
              <p className="fine-print">
                输入执行往返等待被控端原生调用完成；采集到呈现由浏览器时钟估计，未包含输入传输，也不能代替实测操作响应。未报告的数据保留为空。静态桌面会减少发送帧，帧率验收应使用动态画面。
              </p>
              <div className="benchmark-actions">
                <button
                  onClick={() =>
                    void api
                      .invoke("benchmark.open")
                      .then((v) => {
                        benchmarkViewport.current = v;
                      })
                      .catch((e) => setError(message(e)))
                  }
                >
                  <Play size={16} />
                  打开对端性能测试画面
                </button>
                <button
                  disabled={!metrics || probing}
                  onClick={() => void probe()}
                >
                  <Activity size={16} />
                  测量操作响应
                </button>
                {probing ? (
                  <button onClick={() => abort.current?.abort()}>
                    <Square size={14} />
                    停止 · {progress}/30
                  </button>
                ) : null}
                {latency.current ? (
                  <p className="latency-result">
                    输入至响应画面：P50 {latency.current.p50.toFixed(1)} ms /
                    P95 {latency.current.p95.toFixed(1)} ms
                  </p>
                ) : null}
                <button onClick={() => void exportReport()}>
                  <Download size={16} />
                  导出测量记录
                </button>
              </div>
              <p className="fine-print">
                已记录 {samples.current.length}{" "}
                个秒级样本。性能是否达标以真实设备及测试条件为准。
              </p>
            </>
          )}
          <ErrorNote text={error} />
        </aside>
      ) : null}
      {error && !panel ? (
        <button className="session-error" onClick={() => setError("")}>
          {error}
          <X size={14} />
        </button>
      ) : null}
    </div>
  );
}
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <small>{label}</small>
      <strong title={value}>{value}</strong>
    </div>
  );
}
