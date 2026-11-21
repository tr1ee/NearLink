import { InputState, type InputScope } from "./input-state";
// No Electron UI APIs here: this process owns native input independently of
// the browser process and Windows' nested non-client mouse tracking loop.
const parent = process.parentPort!;
let state: InputState | undefined;
let port: Electron.MessagePortMain | undefined;
let takeMouseDiagnostics: (() => unknown) | undefined;

function flushMouseDiagnostics() {
  try {
    const samples = takeMouseDiagnostics?.();
    if (Array.isArray(samples) && samples.length)
      parent.postMessage({ type: "mouse-diagnostics", samples });
  } catch {
    // Diagnostics must not interrupt the input lease or native releases.
  }
}

parent.on("message", (event: any) => {
  const m = event.data;
  if (m?.type === "init") {
    try {
      const native = require(m.nativePath);
      state = new InputState((input) => native.input(input));
      takeMouseDiagnostics =
        typeof native.takeMouseDiagnostics === "function"
          ? native.takeMouseDiagnostics
          : undefined;
      parent.postMessage({ type: "ready", pid: process.pid });
    } catch (error: any) {
      parent.postMessage({
        type: "failed",
        message: String(error.message).slice(0, 400),
      });
    }
  } else if (m?.type === "configure")
    state?.configure(m.scope as InputScope | null);
  else if (m?.type === "release") state?.release();
  else if (m?.type === "attach") {
    const previous = port;
    port = event.ports[0];
    previous?.close();
    state?.release();
    const current = port!;
    current.on("message", (e: any) => {
      if (port !== current || !state) return;
      const message = e.data;
      try {
        if (message?.type === "heartbeat") {
          state.heartbeat(message.sessionId);
          return;
        }
        if (message?.type === "stop") {
          state.stop(message.sessionId);
          return;
        }
        if (message?.type !== "input" || !Number.isSafeInteger(message.id))
          return;
        const result = state.applyResult(message.sessionId, message.input);
        current.postMessage({ id: message.id, result });
      } catch {
        current.postMessage({
          id: message?.id,
          error: "输入参数无效或系统拒绝注入",
        });
      }
    });
    current.on("close", () => {
      if (port === current) {
        state?.configure(null);
        port = undefined;
      }
    });
    current.start();
  } else if (m?.type === "shutdown") {
    state?.configure(null);
    flushMouseDiagnostics();
    process.exit(0);
  }
});
const timer = setInterval(() => {
  state?.expire();
  flushMouseDiagnostics();
}, 500);
timer.unref();
process.on("exit", () => state?.release());
