import type {
  DisplayInfo,
  InputEvent,
  MediaSignal,
  Metrics,
  Quality,
  SessionInfo,
  Snapshot,
} from "../shared/protocol";
import { AdaptiveQuality } from "./adaptive";
import { LatestMotionSender, BoundedInputReceiver } from "./input";
import { inputSchema } from "../shared/protocol";
import { FrameTimings, InputFeedback } from "./feedback";
import { captureSize } from "../shared/geometry";
import { captureTask } from "./capture-task";
import { dxgiTrack } from "./dxgi";
import type { MediaStage } from "../shared/media-diagnostics";
import workletUrl from "./pcm-worklet.js?url";
export type Capabilities = {
  backend: "chromium-webrtc";
  codecs: string[];
  maxWidth: number;
  maxHeight: number;
  requestedFps: number;
  hardware: "measured-at-runtime";
};
export interface MediaEngine {
  capabilities(): Capabilities;
  start(session: SessionInfo): Promise<void>;
  reconfigure(quality: Quality, displayId: string): Promise<void>;
  stop(): void;
  stats(): Metrics | null;
}
const emptyMetrics = (): Metrics => ({
  at: Date.now(),
  seconds: 0,
  width: 0,
  height: 0,
  captureFps: 0,
  encodeFps: 0,
  decodeFps: 0,
  renderFps: 0,
  bitrate: 0,
  rttMs: 0,
  loss: 0,
  encodeMs: 0,
  decodeMs: 0,
  jitterMs: 0,
  freezes: 0,
  freezeSeconds: 0,
  frames: 0,
  encoder: "待测量",
  decoder: "待测量",
  hardwareEncode: null,
  hardwareDecode: null,
  qualityReason: "none",
  bytes: 0,
});
export class ChromiumMediaEngine implements MediaEngine {
  private pc: RTCPeerConnection | null = null;
  private stream: MediaStream | null = null;
  private captureModes = new WeakMap<
    MediaStreamTrack,
    { backend: "chromium" | "dxgi" | "service"; fps: number; fallback: boolean }
  >();
  private dxgiFailed = false;
  private desktopEpoch = 0;
  private announcedDesktopEpoch = 0;
  private hostLocked = false;
  private received = new MediaStream();
  private receivedAudio = new MediaStream();
  private audioPlayer?: HTMLAudioElement;
  private volume = 1;
  private inputReceiver?: BoundedInputReceiver;
  private inputRtt?: number;
  private inputProbe?: { id: number; at: number };
  private probeId = 0;
  private inputProbesSupported = false;
  private appliedFeedbackSupported = false;
  private buttonOrderingSupported = false;
  private lastButtonSeq = 0;
  private inputFeedback = new InputFeedback();
  private frameTimings = new FrameTimings();
  private info: SessionInfo | null = null;
  private control: RTCDataChannel | null = null;
  private motion: RTCDataChannel | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private off: (() => void)[] = [];
  private interval?: ReturnType<typeof setInterval>;
  private failureTimer?: ReturnType<typeof setTimeout>;
  private latest: Metrics | null = null;
  private previous: any = {};
  private remoteMetrics: Metrics | null = null;
  private adaptive?: AdaptiveQuality;
  private videoSender?: RTCRtpSender;
  private audioContext?: AudioContext;
  private worklet?: AudioWorkletNode;
  private audioOff?: () => void;
  private audioDest?: MediaStreamAudioDestinationNode;
  private renderFrames = 0;
  private renderAt = 0;
  private renderCallback = 0;
  private started = 0;
  private generation = 0;
  private signalEpoch = 0;
  private captureAbort?: AbortController;
  private capturingStreams = new Set<MediaStream>();
  private motionSender = new LatestMotionSender((event) => {
    if (this.motion?.readyState !== "open" || this.motion.bufferedAmount > 512)
      return false;
    this.motion.send(JSON.stringify(event));
    if (this.appliedFeedbackSupported)
      this.inputFeedback.remember(event.seq, performance.now());
    return true;
  });
  private seq = 0;
  private collecting = false;
  private releasePending = false;
  private commandQueue = Promise.resolve();
  private nextCaptureId: string | null = null;
  onStats?: (metrics: Metrics) => void;
  onState?: (state: string) => void;
  constructor(private video?: HTMLVideoElement) {
    this.off.push(
      window.nearlink.on("media", (m) => {
        if (m.kind === "stats") {
          if (this.info?.id === m.sessionId) this.remoteMetrics = m.data;
          return;
        }
        if (m.kind === "stop") {
          if (!this.info || this.info.id === m.sessionId) {
            this.signalEpoch++;
            this.commandQueue = Promise.resolve();
            this.stop();
          }
          return;
        }
        if (m.kind === "restart") {
          this.signalEpoch++;
          this.commandQueue = Promise.resolve();
          this.stop();
        }
        const epoch = this.signalEpoch;
        this.commandQueue = this.commandQueue
          .catch(() => {})
          .then(() => {
            if (epoch === this.signalEpoch) return this.handle(m, epoch);
          })
          .catch((e) => {
            if (epoch === this.signalEpoch && e?.name !== "AbortError") {
              this.trace("signal-failed");
              this.error(e);
              if (e?.name === "TimeoutError" && this.info)
                void window.nearlink
                  .invoke("media.failed", this.info.id)
                  .catch(() => {});
            }
          });
      }),
    );
    this.off.push(
      window.nearlink.on("lock", (v) => {
        if (v) this.release();
        this.hostLocked = v;
        for (const track of this.stream?.getTracks() ?? []) track.enabled = !v;
        const track = this.stream?.getVideoTracks()[0];
        if (
          !v &&
          track?.readyState === "ended" &&
          this.captureModes.get(track)?.backend === "dxgi"
        )
          this.recoverDxgi(track);
      }),
    );
    this.off.push(window.nearlink.on("release", () => this.release()));
    this.off.push(
      window.nearlink.on("visibility", (visible) => {
        if (visible) {
          void this.video?.play().catch(() => {});
          void this.audioPlayer?.play().catch(() => {});
        }
      }),
    );
    void window.nearlink.invoke("media.ready").catch(() => {});
  }
  capabilities(): Capabilities {
    return {
      backend: "chromium-webrtc",
      codecs: [
        ...new Set(
          RTCRtpSender.getCapabilities("video")?.codecs.map(
            (c) => c.mimeType,
          ) ?? [],
        ),
      ],
      maxWidth: 3840,
      maxHeight: 2160,
      requestedFps: 120,
      hardware: "measured-at-runtime",
    };
  }
  setVolume(volume: number) {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.audioPlayer) this.audioPlayer.volume = this.volume;
  }
  private createAdaptive(info: SessionInfo) {
    const display = info.displays.find((d) => d.id === info.displayId)!;
    const size = captureSize(display, info.quality.height);
    return new AdaptiveQuality(info.quality, {
      pixels: size.width * size.height,
      fps: Math.min(
        info.quality.fps,
        display.refreshRate || 60,
        info.localRefreshRate,
      ),
    });
  }
  stats() {
    return this.latest;
  }
  private send(kind: MediaSignal["kind"], data: any) {
    if (this.info)
      void window.nearlink
        .invoke("media.signal", { kind, sessionId: this.info.id, data })
        .catch((e) => this.error(e));
  }
  private error(e: any) {
    const message = String(e?.message ?? e).slice(0, 300);
    this.onState?.(message);
    void window.nearlink.invoke("media.error", message).catch(() => {});
  }
  private trace(stage: MediaStage) {
    if (this.info)
      void window.nearlink
        .invoke("diagnostics.media-stage", this.info.id, stage)
        .catch(() => {});
  }
  async start(info: SessionInfo) {
    if (
      this.info?.id === info.id &&
      this.pc &&
      !["closed", "failed"].includes(this.pc.connectionState)
    )
      return;
    this.stop();
    this.info = info;
    this.trace("engine-start");
    this.started = performance.now();
    this.adaptive = this.createAdaptive(info);
    const pc = (this.pc = new RTCPeerConnection({
      iceServers: [],
      bundlePolicy: "max-bundle",
      iceCandidatePoolSize: 0,
    }));
    pc.onicecandidate = (e) => {
      if (e.candidate) this.send("candidate", e.candidate.toJSON());
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      this.trace(`connection-${pc.connectionState}`);
      this.onState?.(pc.connectionState);
      if (pc.connectionState === "connected") {
        if (this.failureTimer) clearTimeout(this.failureTimer);
        void window.nearlink.invoke("media.connected", info.id);
      }
      if (
        pc.connectionState === "failed" ||
        pc.connectionState === "disconnected"
      ) {
        if (info.role === "controller") this.release();
        if (info.role === "host")
          void window.nearlink
            .invoke("media.input.stop", info.id)
            .catch(() => {});
        if (this.failureTimer) clearTimeout(this.failureTimer);
        this.failureTimer = setTimeout(() => {
          if (this.pc === pc && pc.connectionState !== "connected")
            void window.nearlink.invoke("media.failed", info.id);
        }, 2500);
      }
    };
    if (info.role === "controller") {
      this.control = pc.createDataChannel("control", { ordered: true });
      this.motion = pc.createDataChannel("motion", {
        ordered: false,
        maxRetransmits: 0,
      });
      this.control.bufferedAmountLowThreshold = 16 * 1024;
      this.motion.bufferedAmountLowThreshold = 256;
      this.motion.onbufferedamountlow = () => this.motionSender.flush();
      this.control.onmessage = (event) => {
        try {
          const m = JSON.parse(event.data);
          if (
            m.type === "desktop-epoch" &&
            Number.isSafeInteger(m.epoch) &&
            m.epoch > 0 &&
            m.epoch <= 0xffffffff
          ) {
            if (this.desktopEpoch !== m.epoch) {
              this.motionSender.clear();
              this.desktopEpoch = m.epoch;
            }
          }
          if (m.type === "input-capabilities" && m.v === 1) {
            this.inputProbesSupported = true;
            this.appliedFeedbackSupported = m.applied === true;
            this.buttonOrderingSupported = m.buttonOrdering === true;
          }
          if (m.type === "input-applied" && Number.isSafeInteger(m.seq))
            this.inputFeedback.ack(m.seq, performance.now());
          if (
            m.type === "input-ack" &&
            this.inputProbe &&
            m.id === this.inputProbe.id
          ) {
            this.inputRtt = performance.now() - this.inputProbe.at;
            this.inputProbe = undefined;
          }
        } catch {}
      };
      pc.addTransceiver("video", { direction: "recvonly" });
      pc.addTransceiver("audio", { direction: "recvonly" });
      pc.ontrack = (e) => {
        if (e.track.kind === "audio") {
          this.receivedAudio.addTrack(e.track);
          this.audioPlayer ??= new Audio();
          this.audioPlayer.srcObject = this.receivedAudio;
          this.audioPlayer.volume = this.volume;
          void this.audioPlayer.play().catch(() => {});
          return;
        }
        this.received.addTrack(e.track);
        if (this.video && this.video.srcObject !== this.received) {
          this.video.srcObject = this.received;
          this.video.muted = true;
          void this.video.play().catch(() => {});
        }
        try {
          if ("jitterBufferTarget" in e.receiver)
            (e.receiver as any).jitterBufferTarget = 0;
          // Chromium also exposes this minimum-delay API when the newer
          // jitterBufferTarget is not enabled in the bundled browser.
          if ("playoutDelayHint" in e.receiver)
            (e.receiver as any).playoutDelayHint = 0;
        } catch {}
      };
      await this.preferCodecs(pc, info);
      if (this.pc !== pc) return;
      await pc.setLocalDescription(await pc.createOffer());
      this.send("offer", pc.localDescription?.toJSON());
      this.observeFrames();
    } else {
      let lastFeedbackAt = -Infinity;
      let feedbackChannel: RTCDataChannel | undefined;
      this.inputReceiver = new BoundedInputReceiver(
        (input) => window.nearlink.invoke("media.input", info.id, input, true),
        (error) => this.error(error),
        () => performance.now(),
        (input) => {
          const now = performance.now();
          if (
            !("seq" in input) ||
            input.seq === undefined ||
            now - lastFeedbackAt < 100
          )
            return;
          if (
            feedbackChannel?.readyState === "open" &&
            feedbackChannel.bufferedAmount < 1024
          ) {
            feedbackChannel.send(
              JSON.stringify({ type: "input-applied", seq: input.seq }),
            );
            lastFeedbackAt = now;
          }
        },
      );
      pc.ondatachannel = (e) => {
        if (!["control", "motion"].includes(e.channel.label)) {
          e.channel.close();
          return;
        }
        if (e.channel.label === "control") {
          feedbackChannel = e.channel;
          const advertise = () =>
            e.channel.send(
              JSON.stringify({
                type: "input-capabilities",
                v: 1,
                applied: true,
                buttonOrdering: true,
              }),
            );
          if (e.channel.readyState === "open") advertise();
          else e.channel.onopen = advertise;
          e.channel.onclose = () => {
            if (this.pc !== pc || feedbackChannel !== e.channel) return;
            this.inputReceiver?.stop();
            void window.nearlink
              .invoke("media.input.stop", info.id)
              .catch(() => {});
            if (pc.connectionState === "connected")
              void window.nearlink
                .invoke("media.failed", info.id)
                .catch(() => {});
          };
        }
        e.channel.onmessage = (message) => {
          if (this.pc !== pc || this.info?.id !== info.id) return;
          try {
            if (typeof message.data !== "string" || message.data.length > 65536)
              return;
            const input = JSON.parse(message.data);
            if (
              input.type === "input-probe" &&
              Number.isSafeInteger(input.id)
            ) {
              if (
                e.channel.readyState === "open" &&
                e.channel.bufferedAmount < 1024
              )
                e.channel.send(
                  JSON.stringify({ type: "input-ack", id: input.id }),
                );
              return;
            }
            if (info.viewOnly) return;
            const checked = inputSchema.safeParse(input);
            if (
              checked.success &&
              (checked.data.type === "move") === (e.channel.label === "motion")
            )
              this.inputReceiver?.push(checked.data);
          } catch {}
        };
      };
    }
    this.interval = setInterval(() => {
      if (
        this.info?.role === "host" &&
        this.pc?.connectionState === "connected"
      )
        void window.nearlink
          .invoke("media.input.heartbeat", this.info.id)
          .catch(() => {});
      void this.collect();
    }, 1000);
  }
  private async preferCodecs(pc: RTCPeerConnection, info: SessionInfo) {
    const receiverCodecs =
      RTCRtpReceiver.getCapabilities("video")?.codecs ?? [];
    const isHevc = (codec: RTCRtpCodec) =>
      codec.mimeType.toUpperCase() === "VIDEO/H265";
    const hevcExperiment = await window.nearlink
      .invoke("media.codec-experiment")
      .catch(() => null);
    let hevc = false;
    let codecs = receiverCodecs;
    if (hevcExperiment === "hevc" && info.quality.height === 1080) {
      if (info.role === "host")
        codecs =
          RTCRtpSender.getCapabilities("video")?.codecs ?? receiverCodecs;
      if (codecs.some(isHevc)) {
        const mediaCaps = navigator.mediaCapabilities;
        const config = {
          type: "webrtc" as const,
          video: {
            contentType: "video/H265",
            width: 1920,
            height: 1080,
            bitrate: 9_100_000,
            framerate: info.quality.fps,
          },
        };
        const support = await (
          info.role === "host"
            ? mediaCaps.encodingInfo(config)
            : mediaCaps.decodingInfo(config)
        ).catch(() => null);
        hevc = !!(support?.supported && support.powerEfficient);
      }
    }
    if (this.pc !== pc) return;
    const preferred = hevc
      ? isHevc
      : (codec: RTCRtpCodec) => codec.mimeType === "video/H264";
    const allowed = hevc ? codecs : codecs.filter((codec) => !isHevc(codec));
    const ordered = [
      ...allowed.filter(preferred),
      ...allowed.filter((c) => !preferred(c)),
    ];
    for (const t of pc.getTransceivers())
      if (t.receiver.track.kind === "video" && ordered.length)
        t.setCodecPreferences(ordered);
  }
  private async handle(signal: any, epoch = this.signalEpoch) {
    if (epoch !== this.signalEpoch) return;
    if (signal.kind === "restart") {
      const state: Snapshot = await window.nearlink.invoke("state");
      if (epoch !== this.signalEpoch) return;
      if (state.session?.role === "controller") await this.start(state.session);
      return;
    }
    if (signal.kind === "stop") {
      this.stop();
      return;
    }
    if (signal.kind === "stats") {
      this.remoteMetrics = signal.data;
      return;
    }
    if (
      window.nearlink.windowKind === "host" &&
      ["offer", "candidate"].includes(signal.kind)
    ) {
      const state: Snapshot = await window.nearlink.invoke("state");
      if (epoch !== this.signalEpoch) return;
      if (!state.session || state.session.id !== signal.sessionId) return;
      if (this.info?.id !== state.session.id) await this.start(state.session);
    }
    if (!this.info || signal.sessionId !== this.info.id || !this.pc) return;
    const pc = this.pc;
    if (signal.kind === "candidate") {
      if (pc.remoteDescription) await pc.addIceCandidate(signal.data);
      else if (this.pendingCandidates.length < 128)
        this.pendingCandidates.push(signal.data);
      return;
    }
    if (signal.kind === "offer") {
      this.trace("offer-received");
      if (
        pc.remoteDescription?.sdp === signal.data.sdp &&
        pc.localDescription?.type === "answer"
      ) {
        this.send("answer", pc.localDescription.toJSON());
        return;
      }
      await pc.setRemoteDescription(signal.data);
      if (this.pc !== pc) return;
      this.trace("offer-description-ready");
      // UAC temporarily switches away from the capture desktop. Starting WGC
      // during local input approval would time out and revoke that same grant.
      await window.nearlink.invoke("media.input-ready", this.info.id);
      if (this.pc !== pc) return;
      const captured = await this.capture();
      if (this.pc !== pc) {
        for (const track of captured.getTracks()) track.stop();
        return;
      }
      this.capturingStreams.delete(captured);
      this.trace("capture-ready");
      this.stream = captured;
      for (const t of captured.getTracks()) {
        // Separate sync groups: remote interaction must not wait for an
        // audio jitter-buffer expansion before presenting a fresh video frame.
        const sender = pc.addTrack(
          t,
          t.kind === "audio" ? new MediaStream([t]) : captured,
        );
        if (t.kind === "video") this.videoSender = sender;
      }
      await this.preferCodecs(pc, this.info);
      if (this.pc !== pc) return;
      await pc.setLocalDescription(await pc.createAnswer());
      if (this.pc !== pc) return;
      this.trace("answer-ready");
      this.send("answer", pc.localDescription?.toJSON());
      await this.applyEncoding();
      await this.flushCandidates();
      return;
    }
    if (signal.kind === "answer") {
      this.trace("answer-received");
      await pc.setRemoteDescription(signal.data);
      this.trace("answer-description-ready");
      await this.flushCandidates();
      return;
    }
    if (signal.kind === "reconfigure") {
      if (this.info.role === "host") {
        const state: Snapshot = await window.nearlink.invoke("state");
        if (epoch !== this.signalEpoch) return;
        if (!state.session) return;
        this.info = state.session;
        this.adaptive = this.createAdaptive(this.info);
        await this.replaceCapture();
      } else if (signal.data.displays) {
        this.info.displays = signal.data.displays;
        this.info.displayId = signal.data.displayId;
        this.onState?.("display-changed");
      }
    }
  }
  private async flushCandidates() {
    for (const c of this.pendingCandidates) await this.pc?.addIceCandidate(c);
    this.pendingCandidates = [];
  }
  private async capture(): Promise<MediaStream> {
    const generation = this.generation;
    this.captureAbort?.abort();
    const abort = (this.captureAbort = new AbortController());
    this.trace("source-requested");
    const source = await captureTask(
      window.nearlink.invoke("source"),
      abort.signal,
      3000,
      () => {},
    );
    if (generation !== this.generation)
      throw new DOMException("采集已取消", "AbortError");
    this.trace("source-ready");
    const info: SessionInfo = source.session;
    const display = info.displays.find((d) => d.id === info.displayId)!;
    const q = this.adaptive?.current() ?? {
      height: info.quality.height,
      fps: info.quality.fps,
    };
    const { width, height } = captureSize(display, q.height);
    const fps = Math.min(
      q.fps,
      display.refreshRate || 60,
      info.localRefreshRate,
    );
    const video = {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: source.sourceId,
        maxWidth: width,
        maxHeight: height,
        minFrameRate: fps,
        maxFrameRate: fps,
      },
    };
    const acquire = (constraints: MediaStreamConstraints) =>
      captureTask(
        navigator.mediaDevices.getUserMedia(constraints),
        abort.signal,
        5000,
        (stream) => {
          for (const track of stream.getTracks()) track.stop();
        },
      );
    let stream: MediaStream;
    if (source.captureBackend === "service") {
      const nativeTrack = await dxgiTrack(
        info.id,
        fps,
        abort.signal,
        (track) => this.recoverDxgi(track),
        (epoch) => {
          if (
            this.control?.readyState === "open" &&
            this.announcedDesktopEpoch !== epoch
          ) {
            this.control.send(JSON.stringify({ type: "desktop-epoch", epoch }));
            this.announcedDesktopEpoch = epoch;
          }
        },
      );
      nativeTrack.contentHint = "motion";
      this.captureModes.set(nativeTrack, {
        backend: "service",
        fps,
        fallback: false,
      });
      stream = new MediaStream([nativeTrack]);
      // Keep system loopback when Chromium can acquire it. Its video is never
      // used; a secure-desktop capture failure cannot prevent service video.
      try {
        const audio = await captureTask(
          navigator.mediaDevices.getUserMedia({
            video: video as any,
            audio: { mandatory: { chromeMediaSource: "desktop" } } as any,
          }),
          abort.signal,
          1500,
          (late) => {
            for (const track of late.getTracks()) track.stop();
          },
        );
        for (const track of audio.getVideoTracks()) track.stop();
        for (const track of audio.getAudioTracks()) stream.addTrack(track);
      } catch {}
      this.capturingStreams.add(stream);
      this.trace("capture-ready");
      return stream;
    }
    this.trace("capture-requested");
    try {
      stream = await acquire({
        video: video as any,
        audio:
          source.platform === "win32"
            ? ({ mandatory: { chromeMediaSource: "desktop" } } as any)
            : false,
      });
    } catch (e: any) {
      if (e?.name === "AbortError" || e?.name === "TimeoutError") throw e;
      if (source.platform === "win32") {
        this.trace("capture-audio-fallback");
        stream = await acquire({
          video: video as any,
          audio: false,
        });
        this.error("系统声音采集失败，画面连接仍可继续。");
      } else throw e;
    }
    if (generation !== this.generation) {
      for (const track of stream.getTracks()) track.stop();
      throw new DOMException("采集已取消", "AbortError");
    }
    this.capturingStreams.add(stream);
    const wantsDxgi =
      source.captureBackend === "dxgi" &&
      !info.quality.auto &&
      info.quality.height === 1080 &&
      width === 1920 &&
      height === 1080 &&
      display.rotation === 0;
    if (wantsDxgi && !this.dxgiFailed) {
      try {
        const nativeTrack = await dxgiTrack(
          info.id,
          fps,
          abort.signal,
          (track) => this.recoverDxgi(track),
        );
        for (const chromiumTrack of stream.getVideoTracks()) {
          chromiumTrack.stop();
          stream.removeTrack(chromiumTrack);
        }
        nativeTrack.contentHint = "motion";
        this.captureModes.set(nativeTrack, {
          backend: "dxgi",
          fps,
          fallback: false,
        });
        stream.addTrack(nativeTrack);
        return stream;
      } catch (error) {
        abort.signal.throwIfAborted();
        this.dxgiFailed = true;
      }
    }
    for (const track of stream.getVideoTracks()) {
      this.captureModes.set(track, {
        backend: "chromium",
        fps,
        fallback: wantsDxgi,
      });
      // Fluid content overrides WebRTC's presentation/screencast mode. Keep
      // motion responsive; explicit sender parameters still own aligned size.
      track.contentHint = "motion";
      await captureTask(
        track.applyConstraints({
          width: { exact: width },
          height: { exact: height },
          frameRate: { min: fps, ideal: fps, max: fps },
        }),
        abort.signal,
        3000,
        () => {},
      ).catch((error) => {
        if (error?.name === "AbortError") throw error;
        this.error(
          "系统采集器未接受目标参数，请在性能诊断中查看实际分辨率与帧率。",
        );
      });
      track.onended = () => {
        if (this.stream === stream)
          this.error("屏幕采集已停止，请检查权限或显示器连接");
      };
    }
    if (source.platform === "darwin" && !this.audioDest) {
      try {
        const audioTrack = await this.nativeAudio();
        if (audioTrack) stream.addTrack(audioTrack);
      } catch (e) {
        this.error(e);
      }
    }
    if (generation !== this.generation) {
      for (const track of stream.getTracks()) track.stop();
      throw new DOMException("采集已取消", "AbortError");
    }
    return stream;
  }
  private recoverDxgi(track: MediaStreamTrack) {
    if (this.stream?.getVideoTracks()[0] !== track || this.hostLocked) return;
    this.dxgiFailed = true;
    const generation = this.generation;
    this.commandQueue = this.commandQueue
      .catch(() => {})
      .then(async () => {
        if (
          generation === this.generation &&
          this.stream?.getVideoTracks()[0] === track &&
          !this.hostLocked
        )
          await this.replaceCapture();
      })
      .catch((error) => {
        if (generation === this.generation && !this.hostLocked)
          this.error(error);
      });
  }
  private async nativeAudio(): Promise<MediaStreamTrack | undefined> {
    const generation = this.generation;
    let initialized = false;
    let pending: { samples: Float32Array; channels: number }[] = [];
    this.audioOff = window.nearlink.on("pcm", (packet) => {
      if (generation !== this.generation) return;
      const bytes =
        packet.pcm instanceof Uint8Array
          ? packet.pcm
          : new Uint8Array(packet.pcm);
      const samples = new Float32Array(bytes.slice().buffer);
      const payload = { samples, channels: packet.channels };
      if (!initialized) {
        if (pending.length < 8) pending.push(payload);
        return;
      }
      this.worklet?.port.postMessage(payload, [samples.buffer]);
    });
    let context: AudioContext | undefined;
    try {
      const format = await window.nearlink.invoke("audio.start");
      if (generation !== this.generation) return undefined;
      context = new AudioContext({
        sampleRate: format.sampleRate,
        latencyHint: "interactive",
      });
      this.audioContext = context;
      await context.audioWorklet.addModule(workletUrl);
      if (generation !== this.generation) {
        await context.close();
        return undefined;
      }
      this.worklet = new AudioWorkletNode(context, "nearlink-pcm", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      this.audioDest = context.createMediaStreamDestination();
      this.worklet.connect(this.audioDest);
      await context.resume();
      initialized = true;
      for (const packet of pending)
        this.worklet.port.postMessage(packet, [packet.samples.buffer]);
      pending = [];
      // A silent source still has a clocked audio track; first audio can arrive
      // minutes later without having to restart or renegotiate the session.
      return this.audioDest.stream.getAudioTracks()[0];
    } catch (error) {
      if (generation === this.generation) {
        this.audioOff?.();
        this.audioOff = undefined;
        await window.nearlink.invoke("audio.stop").catch(() => {});
      }
      await context?.close().catch(() => {});
      throw error;
    }
  }
  async reconfigure(quality: Quality, displayId: string) {
    await window.nearlink.invoke("session.quality", quality, displayId);
  }
  private async replaceCapture() {
    if (!this.videoSender) return;
    const next = await this.capture();
    const video = next.getVideoTracks()[0];
    try {
      await this.videoSender.replaceTrack(video);
    } catch (error) {
      for (const track of next.getTracks()) track.stop();
      throw error;
    } finally {
      this.capturingStreams.delete(next);
    }
    for (const t of this.stream?.getVideoTracks() ?? []) t.stop();
    for (const t of next.getAudioTracks())
      if (t !== this.audioDest?.stream.getAudioTracks()[0]) t.stop();
    if (this.stream) {
      for (const t of this.stream.getVideoTracks()) this.stream.removeTrack(t);
      this.stream.addTrack(video);
    } else this.stream = next;
    await this.applyEncoding();
  }
  private async applyEncoding() {
    if (!this.videoSender || !this.adaptive) return;
    const p = this.videoSender.getParameters();
    if (!p.encodings?.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = this.adaptive.bitrate;
    p.encodings[0].maxFramerate = this.adaptive.fps;
    p.encodings[0].scaleResolutionDownBy = 1;
    // Chromium's autonomous 3/4 scaling can produce odd dimensions on Retina
    // sources, which hardware H.264 rejects. Our aligned, bounded adaptation
    // owns resolution changes; the transport must preserve those dimensions.
    (p as any).degradationPreference = "maintain-resolution";
    try {
      await this.videoSender.setParameters(p);
    } catch (e) {
      this.error(e);
    }
  }
  input(event: InputEvent) {
    if (!this.info || this.info.viewOnly) return;
    if (this.desktopEpoch)
      event = { ...event, desktopEpoch: this.desktopEpoch };
    if (event.type === "move") {
      if (this.control?.readyState !== "open") return;
      this.motionSender.push({
        ...event,
        seq: ++this.seq,
        afterButton: this.buttonOrderingSupported
          ? this.lastButtonSeq
          : undefined,
      });
      return;
    }
    if (event.type === "button" || event.type === "release") {
      this.motionSender.clear();
      event = { ...event, seq: ++this.seq };
    }
    const mustRelease =
      event.type === "release" ||
      ((event.type === "button" || event.type === "key") && !event.down);
    // Reserve space on the ordered lane for the up events that end a drag.
    if (
      this.control?.readyState === "open" &&
      this.control.bufferedAmount < (mustRelease ? 128 : 64) * 1024
    ) {
      this.control.send(JSON.stringify(event));
      if (
        (event.type === "button" || event.type === "release") &&
        event.seq !== undefined
      )
        this.lastButtonSeq = event.seq;
      if (
        this.appliedFeedbackSupported &&
        "seq" in event &&
        event.seq !== undefined
      )
        this.inputFeedback.remember(event.seq, performance.now());
    } else if (mustRelease || event.type === "button") {
      if (!this.releasePending) {
        this.releasePending = true;
        void window.nearlink
          .invoke("session.release", this.info.id)
          .catch(() => {})
          .finally(() => {
            this.releasePending = false;
          });
      }
    }
  }
  release() {
    this.input({ type: "release" });
  }
  private observeFrames() {
    if (!this.video) return;
    const video = this.video;
    const callback = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      this.renderFrames = metadata.presentedFrames;
      this.frameTimings.add(_now, metadata);
      this.renderCallback = video.requestVideoFrameCallback(callback);
    };
    this.renderCallback = video.requestVideoFrameCallback(callback);
  }
  private async collect() {
    if (!this.pc || !this.info || this.collecting) return;
    this.collecting = true;
    try {
      const pc = this.pc;
      const report = await pc.getStats();
      if (this.pc !== pc) return;
      if (
        this.info.role === "controller" &&
        this.inputProbesSupported &&
        this.control?.readyState === "open" &&
        this.control.bufferedAmount < 1024 &&
        (!this.inputProbe || performance.now() - this.inputProbe.at > 3000)
      ) {
        this.inputProbe = { id: ++this.probeId, at: performance.now() };
        this.control.send(
          JSON.stringify({ type: "input-probe", id: this.inputProbe.id }),
        );
      }
      const m = emptyMetrics(),
        now = performance.now();
      let videoRtp: any;
      const delta = Math.max(
        0.1,
        (now - (this.previous.at ?? now - 1000)) / 1000,
      );
      m.seconds = (now - this.started) / 1000;
      m.targetFps = this.info.quality.fps;
      const captureTrack = this.stream?.getVideoTracks()[0];
      const captureMode = captureTrack && this.captureModes.get(captureTrack);
      m.captureBackend = captureMode?.backend;
      m.captureFallback = captureMode?.fallback;
      m.configuredFps =
        captureMode?.backend === "dxgi"
          ? captureMode.fps
          : captureTrack?.getSettings().frameRate;
      report.forEach((s: any) => {
        if (s.type === "media-source" && s.kind === "video")
          m.captureFps = s.framesPerSecond ?? 0;
        if (
          s.type === "candidate-pair" &&
          s.state === "succeeded" &&
          s.nominated
        )
          m.rttMs = (s.currentRoundTripTime ?? 0) * 1000;
        if (s.type === "outbound-rtp" && s.kind === "video") {
          videoRtp = s;
          m.width = s.frameWidth ?? 0;
          m.height = s.frameHeight ?? 0;
          m.encodeFps =
            s.framesPerSecond ??
            Math.max(
              0,
              (s.framesEncoded - (this.previous.encoded ?? 0)) / delta,
            );
          const frames = s.framesEncoded - (this.previous.encoded ?? 0);
          m.encodeMs =
            frames > 0
              ? ((s.totalEncodeTime - (this.previous.encodeTime ?? 0)) /
                  frames) *
                1000
              : 0;
          m.bitrate = Math.max(
            0,
            ((s.bytesSent - (this.previous.sent ?? s.bytesSent)) * 8) / delta,
          );
          m.encoder = s.encoderImplementation ?? "未报告";
          m.hardwareEncode = s.powerEfficientEncoder ?? null;
          m.qualityReason = s.qualityLimitationReason ?? "none";
          m.frames = s.framesEncoded ?? 0;
          m.bytes = s.bytesSent;
          const packets =
            s.packetsSent - (this.previous.packetsSent ?? s.packetsSent);
          m.sendQueueMs =
            typeof s.totalPacketSendDelay !== "number"
              ? undefined
              : packets > 0
                ? Math.max(
                    0,
                    ((s.totalPacketSendDelay -
                      (this.previous.packetDelay ?? s.totalPacketSendDelay)) *
                      1000) /
                      packets,
                  )
                : 0;
          this.previous.packetsSent = s.packetsSent;
          this.previous.packetDelay = s.totalPacketSendDelay;
          this.previous.encoded = s.framesEncoded;
          this.previous.encodeTime = s.totalEncodeTime;
          this.previous.sent = s.bytesSent;
        }
        if (s.type === "remote-inbound-rtp" && s.kind === "video") {
          m.rttMs = Math.max(m.rttMs, (s.roundTripTime ?? 0) * 1000);
          m.loss = s.fractionLost ?? 0;
        }
        if (s.type === "inbound-rtp" && s.kind === "video") {
          videoRtp = s;
          m.width = s.frameWidth ?? 0;
          m.height = s.frameHeight ?? 0;
          m.decodeFps =
            s.framesPerSecond ??
            Math.max(
              0,
              (s.framesDecoded - (this.previous.decoded ?? 0)) / delta,
            );
          const frames = s.framesDecoded - (this.previous.decoded ?? 0);
          m.decodeMs =
            frames > 0
              ? ((s.totalDecodeTime - (this.previous.decodeTime ?? 0)) /
                  frames) *
                1000
              : 0;
          m.decoder = s.decoderImplementation ?? "未报告";
          m.hardwareDecode = s.powerEfficientDecoder ?? null;
          const received =
              s.packetsReceived - (this.previous.received ?? s.packetsReceived),
            lost = s.packetsLost - (this.previous.lost ?? s.packetsLost);
          m.loss =
            received + lost > 0 ? Math.max(0, lost / (received + lost)) : 0;
          const emitted =
            s.jitterBufferEmittedCount - (this.previous.emitted ?? 0);
          m.jitterMs = (s.jitter ?? 0) * 1000;
          m.jitterBufferMs =
            emitted > 0
              ? ((s.jitterBufferDelay - (this.previous.jitterDelay ?? 0)) /
                  emitted) *
                1000
              : undefined;
          const bufferDelay = (field: string, previous: string) => {
            const value = s[field];
            const result =
              emitted > 0 && typeof value === "number"
                ? Math.max(
                    0,
                    ((value - (this.previous[previous] ?? 0)) / emitted) * 1000,
                  )
                : undefined;
            this.previous[previous] = value;
            return result;
          };
          m.jitterBufferTargetMs = bufferDelay(
            "jitterBufferTargetDelay",
            "jitterTarget",
          );
          m.jitterBufferMinimumMs = bufferDelay(
            "jitterBufferMinimumDelay",
            "jitterMinimum",
          );
          m.freezes = s.freezeCount ?? 0;
          m.freezeSeconds = s.totalFreezesDuration ?? 0;
          m.frames = s.framesRendered ?? s.framesDecoded ?? 0;
          m.bytes = s.bytesReceived;
          m.bitrate = Math.max(
            0,
            ((s.bytesReceived - (this.previous.bytes ?? s.bytesReceived)) * 8) /
              delta,
          );
          this.previous.bytes = s.bytesReceived;
          this.previous.decoded = s.framesDecoded;
          this.previous.decodeTime = s.totalDecodeTime;
          this.previous.received = s.packetsReceived;
          this.previous.lost = s.packetsLost;
          m.frameDrops = Math.max(
            0,
            (s.framesDropped ?? 0) -
              (this.previous.dropped ?? s.framesDropped ?? 0),
          );
          this.previous.dropped = s.framesDropped ?? 0;
          this.previous.emitted = s.jitterBufferEmittedCount;
          this.previous.jitterDelay = s.jitterBufferDelay;
        }
      });
      if (videoRtp) {
        const codec = report.get(videoRtp.codecId);
        m.videoCodec = codec?.mimeType?.replace(/^video\//i, "");
        m.videoCodecParameters = codec?.sdpFmtpLine;
        const transport = report.get(videoRtp.transportId);
        const pair = transport && report.get(transport.selectedCandidatePairId);
        const local = pair && report.get(pair.localCandidateId);
        const remote = pair && report.get(pair.remoteCandidateId);
        if (local?.protocol)
          m.mediaTransport = `${local.protocol.toUpperCase()} · ${local.candidateType ?? "?"} ↔ ${remote?.candidateType ?? "?"}`;
        if (typeof pair?.currentRoundTripTime === "number")
          m.rttMs = pair.currentRoundTripTime * 1000;
      }
      if (this.info.role === "controller") {
        m.inputRttMs = this.inputRtt;
        m.inputAppliedRttMs = this.inputFeedback.read(now);
        Object.assign(m, this.frameTimings.read(now));
        if (this.remoteMetrics) {
          m.inputQueueMs = this.remoteMetrics.inputQueueMs;
          m.inputCoalesced = this.remoteMetrics.inputCoalesced;
          m.inputButtons = this.remoteMetrics.inputButtons;
          m.sendQueueMs = this.remoteMetrics.sendQueueMs;
        }
        m.renderFps = Math.max(0, (this.renderFrames - this.renderAt) / delta);
        this.renderAt = this.renderFrames;
        if (this.remoteMetrics) {
          m.targetFps = this.remoteMetrics.targetFps;
          m.configuredFps = this.remoteMetrics.configuredFps;
          m.captureFps = this.remoteMetrics.captureFps;
          m.captureBackend = this.remoteMetrics.captureBackend;
          m.captureFallback = this.remoteMetrics.captureFallback;
          m.encodeFps = this.remoteMetrics.encodeFps;
          m.encodeMs = this.remoteMetrics.encodeMs;
          m.encoder = this.remoteMetrics.encoder;
          m.hardwareEncode = this.remoteMetrics.hardwareEncode;
          m.qualityReason = this.remoteMetrics.qualityReason;
        }
      } else if (this.remoteMetrics) {
        m.loss = this.remoteMetrics.loss;
        m.rttMs = this.remoteMetrics.rttMs;
        m.jitterMs = this.remoteMetrics.jitterMs;
        m.inputRttMs = this.remoteMetrics.inputRttMs;
        m.inputQueueMs = this.inputReceiver?.applyMs;
        m.inputCoalesced = this.inputReceiver?.coalesced;
        const previousQuality = this.adaptive?.current();
        const change = this.adaptive?.sample(m);
        if (change) {
          const track = this.stream?.getVideoTracks()[0];
          if (track) {
            const display = this.info.displays.find(
              (d) => d.id === this.info!.displayId,
            )!;
            const size = captureSize(display, change.height);
            const fps = Math.min(
              change.fps,
              display.refreshRate || 60,
              this.info.localRefreshRate,
            );
            const abort = this.captureAbort;
            if (!abort) return;
            // Changing only the bitrate must not reconfigure desktop capture.
            // Re-applying identical constraints can interrupt its frame clock.
            if (
              change.height !== previousQuality?.height ||
              change.fps !== previousQuality?.fps
            )
              await captureTask(
                track.applyConstraints({
                  width: {
                    exact: size.width,
                  },
                  height: { exact: size.height },
                  frameRate: {
                    min: fps,
                    ideal: fps,
                    max: fps,
                  },
                }),
                abort.signal,
                3000,
                () => {},
              ).catch((e) => {
                if (e?.name !== "AbortError") this.error(e);
              });
            if (abort.signal.aborted) return;
            await this.applyEncoding();
          }
        }
      }
      if (this.info.role === "host" && this.inputReceiver)
        m.inputButtons = { ...this.inputReceiver.buttons };
      this.previous.at = now;
      this.latest = m;
      this.onStats?.(m);
      this.send("stats", m);
    } catch (e) {
      this.error(e);
    } finally {
      this.collecting = false;
    }
  }
  stop() {
    if (this.info?.role === "host")
      void window.nearlink
        .invoke("media.input.stop", this.info.id)
        .catch(() => {});
    this.generation++;
    this.captureAbort?.abort();
    this.captureAbort = undefined;
    for (const stream of this.capturingStreams)
      for (const track of stream.getTracks()) track.stop();
    this.capturingStreams.clear();
    if (this.interval) clearInterval(this.interval);
    if (this.failureTimer) clearTimeout(this.failureTimer);
    this.motionSender.clear();
    this.inputReceiver?.stop();
    this.inputReceiver = undefined;
    this.inputProbe = undefined;
    this.inputRtt = undefined;
    this.inputProbesSupported = false;
    this.appliedFeedbackSupported = false;
    this.buttonOrderingSupported = false;
    this.lastButtonSeq = 0;
    this.inputFeedback.clear();
    this.frameTimings.clear();
    this.control?.close();
    this.motion?.close();
    this.pc?.close();
    this.pc = null;
    this.control = null;
    this.motion = null;
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    this.received = new MediaStream();
    this.receivedAudio = new MediaStream();
    if (this.audioPlayer) {
      this.audioPlayer.pause();
      this.audioPlayer.srcObject = null;
      this.audioPlayer = undefined;
    }
    if (this.video) {
      this.video.srcObject = null;
      if (this.renderCallback)
        this.video.cancelVideoFrameCallback(this.renderCallback);
    }
    this.audioOff?.();
    this.audioOff = undefined;
    this.worklet?.disconnect();
    this.worklet = undefined;
    void this.audioContext?.close().catch(() => {});
    this.audioContext = undefined;
    this.audioDest = undefined;
    if (this.info?.role === "host")
      void window.nearlink.invoke("audio.stop").catch(() => {});
    this.info = null;
    this.pendingCandidates = [];
    this.videoSender = undefined;
    this.previous = {};
    this.latest = null;
    this.remoteMetrics = null;
    this.dxgiFailed = false;
    this.desktopEpoch = 0;
    this.announcedDesktopEpoch = 0;
    this.hostLocked = false;
    this.renderFrames = 0;
    this.renderAt = 0;
    this.collecting = false;
  }
  dispose() {
    this.signalEpoch++;
    this.commandQueue = Promise.resolve();
    this.stop();
    this.off.forEach((f) => f());
    this.off = [];
  }
}
