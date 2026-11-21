import {
  inputSchema,
  type InputEvent,
  type InputResult,
} from "../src/shared/protocol";
export type InputScope = {
  sessionId: string;
  allowed: boolean;
  authority?: string;
  display: { x: number; y: number; width: number; height: number };
};
export class InputState {
  private scope: InputScope | null = null;
  private seq = -1;
  private refreshedAt = 0;
  private needsRelease = false;
  constructor(
    private inject: (
      event: InputEvent & { screenX?: number; screenY?: number },
    ) =>
      | boolean
      | "suppressed-move"
      | "already-up"
      | "deferred-press"
      | "tray-click"
      | "tray-drag-start",
  ) {}
  configure(scope: InputScope | null) {
    if (JSON.stringify(scope) !== JSON.stringify(this.scope)) {
      this.release();
      this.seq = -1;
    }
    this.scope = scope;
    this.refreshedAt = Date.now();
  }
  heartbeat(sessionId: string, now = Date.now()) {
    if (this.scope?.sessionId === sessionId && this.scope.allowed) {
      this.refreshedAt = now;
      return true;
    }
    return false;
  }
  expire(now = Date.now()) {
    if (this.scope && this.refreshedAt && now - this.refreshedAt > 4000) {
      this.refreshedAt = 0;
      this.release();
    } else if (this.needsRelease) this.release();
  }
  release() {
    this.needsRelease = this.inject({ type: "release" }) !== true;
    return !this.needsRelease;
  }
  stop(sessionId: string) {
    if (this.scope?.sessionId !== sessionId) return false;
    this.configure(null);
    return true;
  }
  apply(sessionId: string, data: unknown) {
    const result = this.applyResult(sessionId, data);
    return (
      result === "applied" ||
      result === "suppressed-move" ||
      result === "already-up" ||
      result === "deferred-press" ||
      result === "tray-click" ||
      result === "tray-drag-start"
    );
  }
  applyResult(sessionId: string, data: unknown): InputResult {
    const scope = this.scope;
    if (!scope?.allowed || scope.sessionId !== sessionId || !this.refreshedAt)
      return "unauthorized";
    const event = inputSchema.parse(data);
    if ("seq" in event && event.seq !== undefined) {
      if (event.type === "move" && event.seq <= this.seq) return "stale";
      this.seq = Math.max(this.seq, event.seq);
    }
    this.refreshedAt = Date.now();
    if (event.type === "release")
      return this.release() ? "applied" : "native-rejected";
    if (this.needsRelease && !this.release()) return "native-rejected";
    if (event.type === "move" || event.type === "button") {
      const d = scope.display;
      const applied = this.inject({
        ...event,
        screenX: Math.round(d.x + event.x * (d.width - 1)),
        screenY: Math.round(d.y + event.y * (d.height - 1)),
      });
      if (typeof applied === "string") return applied;
      if (!applied && event.type === "button") this.release();
      return applied ? "applied" : "native-rejected";
    }
    const applied = this.inject(event);
    if (!applied && event.type === "key" && !event.down) this.release();
    return applied === true ? "applied" : "native-rejected";
  }
}
