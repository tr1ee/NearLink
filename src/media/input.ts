import type { InputButtonStats, InputEvent } from "../shared/protocol";
type Move = Extract<InputEvent, { type: "move" }>;
type Clock = {
  now(): number;
  later(fn: () => void, ms: number): any;
  cancel(id: any): void;
};
const clock: Clock = {
  now: () => performance.now(),
  later: (fn, ms) => setTimeout(fn, ms),
  cancel: clearTimeout,
};
/** One latest position, independent of video presentation / requestAnimationFrame. */
export class LatestMotionSender {
  private pending?: Move;
  private timer: any;
  private last = -Infinity;
  constructor(
    private send: (event: Move) => boolean,
    private time: Clock = clock,
  ) {}
  push(event: Move) {
    this.pending = event;
    this.flush();
  }
  flush() {
    if (!this.pending || this.timer !== undefined) return;
    const delay = Math.max(0, 4 - (this.time.now() - this.last));
    if (delay) {
      this.timer = this.time.later(() => {
        this.timer = undefined;
        this.flush();
      }, delay);
      return;
    }
    if (this.send(this.pending)) {
      this.pending = undefined;
      this.last = this.time.now();
    } else
      this.timer = this.time.later(() => {
        this.timer = undefined;
        this.flush();
      }, 4);
  }
  clear() {
    if (this.timer !== undefined) this.time.cancel(this.timer);
    this.timer = undefined;
    this.pending = undefined;
  }
}
/** Bound renderer -> native IPC to one in flight, keeping only the newest move. */
export class BoundedInputReceiver {
  private move?: Move;
  private commands: InputEvent[] = [];
  private busy = false;
  private stopped = false;
  private watermark = -1;
  private buttonReceived = 0;
  private buttonExecuted = 0;
  coalesced = 0;
  applyMs = 0;
  readonly buttons: Required<InputButtonStats> = {
    down: 0,
    up: 0,
    appliedDown: 0,
    appliedUp: 0,
    nativeRejected: 0,
    unavailable: 0,
    unauthorized: 0,
    alreadyUp: 0,
    trayClicks: 0,
    deferredDowns: 0,
  };
  constructor(
    private apply: (event: InputEvent) => Promise<unknown>,
    private onError: (error: unknown) => void,
    private now = () => performance.now(),
    private onApplied?: (event: InputEvent) => void,
  ) {}
  push(event: InputEvent) {
    if (this.stopped) return;
    if (event.type === "move") {
      if (
        event.seq <= this.watermark ||
        (event.afterButton !== undefined &&
          (event.afterButton < this.buttonReceived ||
            event.afterButton >= event.seq))
      ) {
        this.coalesced++;
        return;
      }
      this.watermark = event.seq;
      if (this.move) this.coalesced++;
      this.move = event;
    } else {
      if (event.type === "button") this.buttons[event.down ? "down" : "up"]++;
      // Reliable button/release events must still execute when a later motion
      // overtakes them on the unordered channel. Only stale motion is dropped.
      if (
        (event.type === "button" || event.type === "release") &&
        event.seq !== undefined
      ) {
        this.buttonReceived = Math.max(this.buttonReceived, event.seq);
        this.watermark = Math.max(this.watermark, event.seq);
        if (
          this.move &&
          (this.move.seq <= event.seq ||
            (this.move.afterButton !== undefined &&
              this.move.afterButton < event.seq))
        )
          this.move = undefined;
      }
      if (event.type === "release" || this.commands.length >= 128) {
        this.commands = [{ type: "release", seq: this.buttonReceived }];
        if (this.move?.afterButton === undefined) this.move = undefined;
        if (event.type !== "release")
          this.onError(new Error("输入队列繁忙，已释放按键，请重试操作。"));
      } else this.commands.push(event);
    }
    void this.drain();
  }
  private async drain() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      while (!this.stopped) {
        let next = this.commands.shift();
        if (
          !next &&
          this.move &&
          (this.move.afterButton ?? 0) <= this.buttonExecuted
        ) {
          next = this.move;
          this.move = undefined;
        }
        if (!next) break;
        const at = this.now();
        let result: unknown;
        try {
          result = await this.apply(next);
        } catch (error) {
          result = "unavailable";
          this.onError(error);
        }
        this.applyMs = this.now() - at;
        if (this.stopped) break;
        if (
          (next.type === "button" || next.type === "release") &&
          next.seq !== undefined
        )
          this.buttonExecuted = Math.max(this.buttonExecuted, next.seq);
        const applied =
          result === true ||
          result === undefined ||
          result === "applied" ||
          result === "tray-click" ||
          result === "tray-drag-start";
        if (result === "tray-drag-start") this.buttons.appliedDown++;
        if (next.type === "button") {
          if (result === "tray-click") {
            this.buttons.trayClicks++;
            this.buttons.appliedDown++;
          }
          if (applied) this.buttons[next.down ? "appliedDown" : "appliedUp"]++;
          else if (result === "deferred-press") this.buttons.deferredDowns++;
          else if (result === "native-rejected") this.buttons.nativeRejected++;
          else if (result === "unauthorized") this.buttons.unauthorized++;
          else if (result === "already-up") this.buttons.alreadyUp++;
          else this.buttons.unavailable++;
        }
        if (applied) this.onApplied?.(next);
      }
    } finally {
      this.busy = false;
    }
  }
  stop() {
    this.stopped = true;
    this.commands = [];
    this.move = undefined;
  }
}
