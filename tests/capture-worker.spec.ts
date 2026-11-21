import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";

test("真实采集 worker 按启动配置读取服务帧或 DXGI 帧", async () => {
  const root = await mkdtemp(path.resolve("work/capture-worker-"));
  const native = path.join(root, "native.cjs");
  await writeFile(
    native,
    `let mode;
    exports.openService=({mapping})=>{mode='service';return mapping==='synthetic-mapping'};
    exports.open=()=>{mode='dxgi';return true};
    exports.readService=()=>{if(mode!=='service')throw Error('wrong backend');return {frame:new Uint8Array([1,2,3,4]).buffer,width:1,height:1,epoch:7,secure:true}};
    exports.read=()=>{if(mode!=='dxgi')throw Error('wrong backend');return new Uint8Array([5,6,7,8]).buffer};`,
  );
  const app = await electron.launch({
    args: [process.cwd(), "--background"],
    env: {
      ...process.env,
      NEARLINK_USER_DATA: path.join(root, "profile"),
      NEARLINK_DEV_ADMIN_INPUT: "0",
      NEARLINK_INSTALLED_SERVICE: "0",
      NEARLINK_DEV_LAN: "0",
    },
  });
  try {
    for (const service of [true, false]) {
      const result = await app.evaluate(
        async ({ utilityProcess, MessageChannelMain }, options) => {
          const worker = utilityProcess.fork(options.worker, [], {
            stdio: "pipe",
          });
          const { port1, port2 } = new MessageChannelMain();
          try {
            const startup = new Promise((resolve, reject) => {
              worker.once("message", resolve);
              worker.once("exit", () =>
                reject(Error("worker exited before ready")),
              );
            });
            worker.once("spawn", () =>
              worker.postMessage(
                {
                  nativePath: options.native,
                  mapping: options.service ? "synthetic-mapping" : undefined,
                  center: { x: 0, y: 0 },
                },
                [port2],
              ),
            );
            if ((await startup) !== "ready")
              throw Error("capture failed to open");
            const frames = [];
            port1.start();
            for (let i = 0; i < 2; i++) {
              const received = new Promise<any>((resolve) =>
                port1.once("message", (event) => resolve(event.data)),
              );
              port1.postMessage("frame");
              const message = await received;
              if (message.error) throw Error("wrong frame reader selected");
              const frame = message.frame;
              frames.push(
                options.service
                  ? {
                      pixels: [...new Uint8Array(frame.frame)],
                      width: frame.width,
                      height: frame.height,
                      epoch: frame.epoch,
                      secure: frame.secure,
                    }
                  : [...new Uint8Array(frame)],
              );
            }
            return frames;
          } finally {
            port1.close();
            worker.kill();
          }
        },
        {
          native,
          worker: path.resolve("dist-electron/capture-worker.cjs"),
          service,
        },
      );
      expect(result).toEqual(
        service
          ? Array(2).fill({
              pixels: [1, 2, 3, 4],
              width: 1,
              height: 1,
              epoch: 7,
              secure: true,
            })
          : [
              [5, 6, 7, 8],
              [5, 6, 7, 8],
            ],
      );
    }
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close();
  }
});
