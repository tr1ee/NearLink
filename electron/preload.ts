import { contextBridge, ipcRenderer } from "electron";
import type { InputResult } from "../src/shared/protocol";
const query = new URLSearchParams(globalThis.location.search);
let inputPort: MessagePort | undefined;
let inputId = 0;
let dxgi:
  | {
      token: string;
      port?: MessagePort;
      framePending?: boolean;
      ready: (port: MessagePort) => void;
    }
  | undefined;
const pendingInput = new Map<
  number,
  {
    resolve: (v: boolean | InputResult) => void;
    detailed: boolean;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
const clearInput = () => {
  for (const item of pendingInput.values()) {
    clearTimeout(item.timer);
    item.reject(Error("输入通道已关闭"));
  }
  pendingInput.clear();
};
if (query.get("window") === "host") {
  ipcRenderer.on("nearlink:dxgi-port", (event, token) => {
    const port = event.ports[0];
    const capture = dxgi;
    if (!capture || capture.token !== token) {
      port.close();
      return;
    }
    capture.port = port;
    port.start();
    capture.ready(port);
  });
  ipcRenderer.on("nearlink:input-port", (event) => {
    inputPort?.close();
    clearInput();
    const port = (inputPort = event.ports[0]);
    port.onmessage = ({ data }) => {
      const item = pendingInput.get(data?.id);
      if (!item) return;
      pendingInput.delete(data.id);
      clearTimeout(item.timer);
      if (data.error) item.reject(Error(data.error));
      else
        item.resolve(
          item.detailed
            ? data.result
            : [
                "applied",
                "suppressed-move",
                "already-up",
                "deferred-press",
                "tray-click",
                "tray-drag-start",
              ].includes(data.result),
        );
    };
    port.addEventListener("close", () => {
      if (inputPort === port) {
        inputPort = undefined;
        clearInput();
      }
    });
    port.start();
  });
}
function invoke(method: string, ...args: any[]) {
  if (query.get("window") === "host" && method === "capture.dxgi.open") {
    const [sessionId, token] = args;
    dxgi?.port?.close();
    let ready!: (port: MessagePort) => void;
    const port = new Promise<MessagePort>((resolve) => {
      ready = resolve;
    });
    dxgi = { token, ready };
    return ipcRenderer
      .invoke("nearlink:invoke", method, sessionId, token)
      .then(() => {
        return new Promise<boolean>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(Error("DXGI 通道尚未就绪")),
            1000,
          );
          void port.then(() => {
            clearTimeout(timer);
            resolve(true);
          });
        });
      });
  }
  if (query.get("window") === "host" && method === "capture.dxgi.close") {
    if (dxgi?.token === args[0]) {
      dxgi?.port?.close();
      dxgi = undefined;
    }
    return Promise.resolve();
  }
  if (query.get("window") === "host" && method === "capture.dxgi.frame") {
    const capture = dxgi;
    if (!capture?.port || capture.token !== args[0] || capture.framePending)
      return Promise.reject(Error("DXGI 通道不可用"));
    const port = capture.port;
    capture.framePending = true;
    return new Promise<ArrayBuffer | undefined>((resolve, reject) => {
      const fail = () => {
        clearTimeout(timer);
        port.onmessage = null;
        capture.framePending = false;
        reject(Error("DXGI 采集未返回画面"));
      };
      const timer = setTimeout(fail, 1500);
      port.onmessage = ({ data }) => {
        clearTimeout(timer);
        port.onmessage = null;
        capture.framePending = false;
        if (data.error) reject(Error("DXGI 采集已中断"));
        else resolve(data.frame);
      };
      port.postMessage("frame");
    });
  }
  if (
    query.get("window") === "host" &&
    ["media.input", "media.input.heartbeat", "media.input.stop"].includes(
      method,
    )
  ) {
    if (inputPort) {
      if (method !== "media.input") {
        inputPort.postMessage({
          type: method.endsWith("heartbeat") ? "heartbeat" : "stop",
          sessionId: args[0],
        });
        return Promise.resolve(true);
      }
      if (pendingInput.size >= 128)
        return Promise.reject(Error("输入通道繁忙"));
      const id = ++inputId;
      return new Promise<boolean | InputResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingInput.delete(id);
          reject(Error("输入进程响应超时"));
        }, 4000);
        pendingInput.set(id, {
          resolve,
          reject,
          timer,
          detailed: args[2] === true,
        });
        inputPort!.postMessage({
          type: "input",
          id,
          sessionId: args[0],
          input: args[1],
        });
      });
    }
    if (process.platform === "win32")
      return Promise.reject(Error("Windows输入后台通道尚未就绪"));
    if (method !== "media.input") return Promise.resolve(false);
  }
  return ipcRenderer.invoke("nearlink:invoke", method, ...args);
}
const topics = new Set([
  "state",
  "media",
  "metrics",
  "pcm",
  "release",
  "lock",
  "fullscreen",
  "visibility",
  "updates",
]);
contextBridge.exposeInMainWorld("nearlink", {
  windowKind: query.get("window") ?? "home",
  peerId: query.get("peer") ?? "",
  invoke,
  on: (topic: string, callback: (payload: any) => void) => {
    if (!topics.has(topic)) throw new Error("不支持的事件");
    const handler = (_event: any, payload: any) => callback(payload);
    ipcRenderer.on("nearlink:" + topic, handler);
    return () => ipcRenderer.removeListener("nearlink:" + topic, handler);
  },
});
