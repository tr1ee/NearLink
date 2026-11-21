import type { Metrics, Quality } from "../shared/protocol";
export class AdaptiveQuality {
  height: number;
  fps: number;
  bitrate: number;
  private bad = 0;
  private good = 0;
  private changed = 0;
  private baselineRtt = Infinity;
  private baselineInputRtt = Infinity;
  constructor(
    public requested: Quality,
    private source?: { pixels: number; fps: number },
  ) {
    this.height = requested.height;
    this.fps = requested.fps;
    this.bitrate = this.ceiling() * (requested.auto ? 0.65 : 1);
  }
  ceiling() {
    const pixels = Math.min(
      this.source?.pixels ?? Infinity,
      this.height === 2160
        ? 3840 * 2160
        : this.height === 1440
          ? 2560 * 1440
          : this.height === 1080
            ? 1920 * 1080
            : 1280 * 720,
    );
    const rate =
      pixels > 2560 * 1440
        ? 45_000_000
        : pixels > 1920 * 1080
          ? 25_000_000
          : pixels > 1280 * 720
            ? 14_000_000
            : 7_000_000;
    return rate * Math.min(1, (this.source?.fps ?? this.fps) / 60);
  }
  sample(m: Metrics, now = Date.now()) {
    if (!this.requested.auto) return null;
    if (m.rttMs > 0) this.baselineRtt = Math.min(this.baselineRtt, m.rttMs);
    // A stable Wi-Fi RTT and the receiver's playout buffer are not evidence
    // of congestion. React to persistent queue growth or actual packet loss.
    if ((m.inputRttMs ?? 0) > 0)
      this.baselineInputRtt = Math.min(this.baselineInputRtt, m.inputRttMs!);
    const growingQueue =
      m.rttMs > Math.max(35, this.baselineRtt + 25) ||
      (m.sendQueueMs ?? 0) > 30 ||
      (m.inputRttMs ?? 0) > Math.max(50, this.baselineInputRtt + 30);
    const encodingPressure =
      (m.qualityReason === "cpu" && m.captureFps >= this.fps * 0.5) ||
      (m.captureFps >= this.fps * 0.8 &&
        m.encodeFps < this.fps * 0.9 &&
        m.encodeMs > (1000 / this.fps) * 0.9);
    const pressured = growingQueue || m.loss > 0.025 || encodingPressure;
    this.bad = pressured ? this.bad + 1 : Math.max(0, this.bad - 1);
    this.good = pressured ? 0 : this.good + 1;
    if (now - this.changed < 2500) return null;
    if (this.bad >= 3) {
      this.bad = 0;
      this.changed = now;
      if (encodingPressure && this.height > 720) {
        // Bitrate reductions alone do not relieve an encoder that cannot
        // process the pixels in time. Reduce pixel load before frame rate.
        const previousRate = this.bitrate;
        this.height =
          this.height > 1440 ? 1440 : this.height > 1080 ? 1080 : 720;
        this.bitrate = Math.min(previousRate, this.ceiling() * 0.65);
      } else if (this.bitrate > this.ceiling() * 0.35)
        this.bitrate = Math.max(
          this.ceiling() * 0.3,
          Math.round(this.bitrate * 0.75),
        );
      else if (this.height > 720) {
        const previousRate = this.bitrate;
        this.height =
          this.height > 1440 ? 1440 : this.height > 1080 ? 1080 : 720;
        this.bitrate = Math.min(previousRate * 0.8, this.ceiling() * 0.7);
      } else if (this.fps > 30) this.fps = this.fps > 60 ? 60 : 30;
      else return null;
      return this.current();
    }
    if (this.good >= 15) {
      this.good = 0;
      this.changed = now;
      if (this.fps < this.requested.fps) this.fps = this.fps === 30 ? 60 : 120;
      else if (this.height < this.requested.height) {
        this.height =
          this.height === 720 ? 1080 : this.height === 1080 ? 1440 : 2160;
        this.bitrate = this.ceiling() * 0.6;
      } else if (this.bitrate < this.ceiling())
        this.bitrate = Math.min(
          this.ceiling(),
          Math.round(this.bitrate * 1.15),
        );
      else return null;
      return this.current();
    }
    return null;
  }
  current() {
    return { height: this.height, fps: this.fps, bitrate: this.bitrate };
  }
}
