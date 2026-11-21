import { MessageChannelMain, utilityProcess, type WebContents } from "electron";
import path from "node:path";

export function startWindowsCapture(
  contents: WebContents,
  token: string,
  center: { x: number; y: number },
) {
  const unpacked = __dirname.replace(/\.asar([\\/])/, ".asar.unpacked$1");
  const child = utilityProcess.fork(
    path.join(unpacked, "capture-worker.cjs"),
    [],
    {
      serviceName: "NearLink DXGI Capture",
    },
  );
  const { port1, port2 } = new MessageChannelMain();
  let transferred = false;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (!transferred) port2.close();
    child.kill();
  };
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      stop();
      reject(Error("DXGI 采集启动超时"));
    }, 4000);
    child.once("exit", () => {
      clearTimeout(timeout);
      stop();
      reject(Error("DXGI 采集进程已退出"));
    });
    child.once("spawn", () => {
      child.postMessage(
        {
          center,
          nativePath: path.join(
            unpacked,
            "../native/prebuilds/win32-x64/nearlink-capture.node",
          ),
        },
        [port1],
      );
    });
    child.once("message", (message) => {
      clearTimeout(timeout);
      if (stopped || message !== "ready" || contents.isDestroyed()) {
        stop();
        reject(Error("当前显示器无法使用 DXGI 采集"));
        return;
      }
      contents.postMessage("nearlink:dxgi-port", token, [port2]);
      transferred = true;
      resolve();
    });
  });
  return { ready, stop };
}
