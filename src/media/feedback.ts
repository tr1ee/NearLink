// Store timing metadata only; never copy video pixels to JavaScript.
export class FrameTimings {
  private samples: {
    at: number;
    age?: number;
    local?: number;
    receiveToSubmit?: number;
    submitToDisplay?: number;
  }[] = [];
  add(now: number, frame: VideoFrameCallbackMetadata) {
    const delay = (end?: number, start?: number) => {
      const value = (end ?? NaN) - (start ?? NaN);
      return Number.isFinite(value) && value >= 0 && value <= 60000
        ? value
        : undefined;
    };
    this.samples.push({
      at: now,
      age: delay(frame.expectedDisplayTime, frame.captureTime),
      local: delay(frame.expectedDisplayTime, frame.receiveTime),
      receiveToSubmit: delay(frame.presentationTime, frame.receiveTime),
      submitToDisplay: delay(frame.expectedDisplayTime, frame.presentationTime),
    });
    // A bounded two-second window covers short bursts without accumulating
    // samples over an eight-hour session. Missing clock estimates stay absent.
    if (this.samples.length > 240) this.samples.shift();
  }
  read(now: number) {
    this.samples = this.samples.filter((s) => now - s.at <= 2000);
    const values = (
      key: "age" | "local" | "receiveToSubmit" | "submitToDisplay",
    ) =>
      this.samples
        .flatMap((s) => (s[key] === undefined ? [] : [s[key]!]))
        .sort((a, b) => a - b);
    const age = values("age"),
      local = values("local");
    const percentile = (a: number[], p: number) =>
      a.length ? a[Math.ceil(a.length * p) - 1] : undefined;
    return {
      videoAgeMs: percentile(age, 0.5),
      videoAgeP95Ms: percentile(age, 0.95),
      receiveToPresentMs: percentile(local, 0.5),
      receiveToSubmitMs: percentile(values("receiveToSubmit"), 0.5),
      submitToDisplayMs: percentile(values("submitToDisplay"), 0.5),
    };
  }
  clear() {
    this.samples = [];
  }
}

// Feedback is sent only after the host's native input call completes. The
// transport-only probe cannot detect an input executor that has stalled.
export class InputFeedback {
  private sent = new Map<number, number>();
  private latest?: { at: number; ms: number };
  remember(seq: number, now: number) {
    this.sent.set(seq, now);
    while (this.sent.size > 256)
      this.sent.delete(this.sent.keys().next().value!);
  }
  ack(seq: number, now: number) {
    const sent = this.sent.get(seq);
    if (sent === undefined) return;
    this.sent.delete(seq);
    const ms = now - sent;
    if (ms >= 0 && ms <= 5000) this.latest = { at: now, ms };
  }
  read(now: number) {
    return this.latest && now - this.latest.at <= 2000
      ? this.latest.ms
      : undefined;
  }
  clear() {
    this.sent.clear();
    this.latest = undefined;
  }
}
