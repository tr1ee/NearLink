export {};
const parent = process.parentPort!;
parent.once("message", ({ data, ports }) => {
  const port = ports[0];
  const service = typeof data.mapping === "string" && !!data.mapping;
  try {
    const capture = require(data.nativePath) as {
      open(center: { x: number; y: number }): boolean;
      read(): ArrayBuffer | undefined;
      openService(mapping: { mapping: string }): boolean;
      readService(): unknown;
    };
    if (
      !(service
        ? capture.openService({ mapping: data.mapping })
        : capture.open(data.center))
    )
      throw Error("无法开启当前显示器的 DXGI 采集");
    port.on("message", ({ data }) => {
      if (data !== "frame") return;
      try {
        port.postMessage({
          frame: service ? capture.readService() : capture.read(),
        });
      } catch {
        port.postMessage({ error: true });
        port.close();
      }
    });
    port.on("close", () => process.exit(0));
    port.start();
    parent.postMessage("ready");
  } catch {
    parent.postMessage("unavailable");
    port.close();
  }
});
