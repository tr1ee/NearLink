import { test, expect, _electron as electron } from "@playwright/test";
import { build } from "esbuild";
import {
  mkdtemp,
  writeFile,
  readFile,
  mkdir,
  copyFile,
} from "node:fs/promises";
import * as asar from "@electron/asar";
import path from "node:path";
test("UI主线程停止调度时，生产预加载直连真实Utility进程仍执行鼠标抬起", async () => {
  test.setTimeout(45000);
  const root = await mkdtemp(path.resolve("work/input-worker-"));
  const workerPackage = path.join(root, "worker-source");
  await mkdir(workerPackage);
  await copyFile(
    "dist-electron/input-worker.cjs",
    path.join(workerPackage, "input-worker.cjs"),
  );
  const events = path.join(root, "injected.jsonl"),
    native = path.join(root, "fake-native.cjs"),
    moduleFile = path.join(root, "service.cjs");
  const gesture = {
    gesture: 1,
    step: "click-submit",
    target: "overflow-xaml",
    heldMs: 100,
    dx: 2,
    dy: 1,
    thresholdX: 4,
    thresholdY: 4,
    requested: 3,
    queued: 3,
    leftHeld: false,
  };
  await writeFile(
    native,
    `const fs = require('fs');
    let samples = [];
    exports.input = input => {
      fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({ at: Date.now(), type: input.type, down: input.down }) + '\\n');
      if (input.type === 'button' && !input.down) samples.push(${JSON.stringify(gesture)});
      return true;
    };
    exports.takeMouseDiagnostics = () => samples.splice(0);`,
  );
  await copyFile(native, path.join(workerPackage, "fake-native.cjs"));
  await asar.createPackageFromFiles(
    workerPackage,
    path.join(root, "input-app.asar"),
    [
      path.join(workerPackage, "input-worker.cjs"),
      path.join(workerPackage, "fake-native.cjs"),
    ],
  );
  const unpacked = path.join(root, "input-app.asar.unpacked");
  await mkdir(unpacked);
  await copyFile(
    path.join(workerPackage, "input-worker.cjs"),
    path.join(unpacked, "input-worker.cjs"),
  );
  await copyFile(native, path.join(unpacked, "fake-native.cjs"));
  await build({
    entryPoints: ["electron/windows-input.ts"],
    outfile: moduleFile,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
  });
  const app = await electron.launch({
    executablePath: process.env.NEARLINK_ELECTRON_EXECUTABLE,
    args: [process.cwd(), "--background"],
    env: { ...process.env, NEARLINK_USER_DATA: path.join(root, "profile") },
  });
  try {
    await expect
      .poll(() => app.windows().some((p) => p.url().includes("window=host")))
      .toBe(true);
    const host = app.windows().find((p) => p.url().includes("window=host"))!;
    await expect
      .poll(() => host.evaluate(() => typeof window.nearlink?.invoke))
      .toBe("function");
    await app.evaluate(
      async ({ BrowserWindow }, options) => {
        const { WindowsInputService } = (process as any).mainModule.require(
          options.moduleFile,
        );
        (globalThis as any).inputTestGestureReports = [];
        const service = ((globalThis as any).inputTestService =
          new WindowsInputService(
            options.native,
            (event: string, sample: unknown) => {
              if (event === "mouse-gesture")
                (globalThis as any).inputTestGestureReports.push(sample);
            },
            options.worker,
          ));
        await service.start();
        service.configure({
          sessionId: "fixture",
          allowed: true,
          display: { x: 0, y: 0, width: 1920, height: 1080 },
        });
        service.attach(
          BrowserWindow.getAllWindows().find((w) =>
            w.webContents.getURL().includes("window=host"),
          )!.webContents,
        );
      },
      {
        native: path.join(root, "input-app.asar", "fake-native.cjs"),
        moduleFile,
        worker: path.join(root, "input-app.asar", "input-worker.cjs"),
      },
    );
    await expect
      .poll(() =>
        host.evaluate(() =>
          window.nearlink.invoke("media.input", "fixture", { type: "release" }),
        ),
      )
      .toBe(true);
    await writeFile(events, "");
    await host.evaluate(() => {
      const w = window as any;
      w.directResults = [];
      setTimeout(async () => {
        w.directResults.push(
          await window.nearlink.invoke("media.input", "fixture", {
            type: "button",
            button: 0,
            down: true,
            x: 0.2,
            y: 0.2,
          }),
        );
        setTimeout(
          async () =>
            w.directResults.push(
              await window.nearlink.invoke("media.input", "fixture", {
                type: "button",
                button: 0,
                down: false,
                x: 0.2,
                y: 0.2,
              }),
            ),
          100,
        );
      }, 100);
    });
    // Analogue of Windows' native non-client tracking loop: Node/IPC callbacks
    // cannot run until an independently executed button-up arrives.
    const result = await app.evaluate((_e, filename) => {
      const fs = process.getBuiltinModule("node:fs")!;
      const started = Date.now(),
        sleep = new Int32Array(new SharedArrayBuffer(4));
      while (Date.now() - started < 4000) {
        if (fs.readFileSync(filename, "utf8").includes('"down":false'))
          return { released: true, milliseconds: Date.now() - started };
        Atomics.wait(sleep, 0, 0, 10);
      }
      return { released: false, milliseconds: Date.now() - started };
    }, events);
    expect(result.released).toBe(true);
    expect(result.milliseconds).toBeLessThan(1500);
    await expect
      .poll(() => host.evaluate(() => (window as any).directResults))
      .toEqual([true, true]);
    await expect
      .poll(() =>
        app.evaluate(() => (globalThis as any).inputTestGestureReports),
      )
      .toEqual([gesture]);
    expect(
      await host.evaluate(() =>
        window.nearlink.invoke("media.input", "old-session", {
          type: "key",
          code: "KeyA",
          down: true,
        }),
      ),
    ).toBe(false);
    await host.evaluate(() =>
      window.nearlink.invoke("media.input.stop", "fixture"),
    );
    expect(
      await host.evaluate(() =>
        window.nearlink.invoke("media.input", "fixture", {
          type: "key",
          code: "KeyA",
          down: true,
        }),
      ),
    ).toBe(false);
    const records = (await readFile(events, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(
      records.filter((e) => e.type === "button").map((e) => e.down),
    ).toEqual([true, false]);
    expect(records.some((e) => e.type === "key")).toBe(false);
    await app.evaluate(async () => (globalThis as any).inputTestService.stop());
    await writeFile(
      "outputs/input-worker-validation.json",
      JSON.stringify(
        {
          at: new Date().toISOString(),
          status: "passed",
          scope:
            "Production preload, WindowsInputService, actual utilityProcess and input-worker; synthetic native adapter records events, excludes Windows SendInput and real WM_NCLBUTTONDOWN",
          mainThreadBlockedUntilButtonUp: result,
          directEvents: records,
          staleSessionRejected: true,
          stopRevokesInput: true,
          nativeDiagnosticForwarded: true,
          systemInputInjected: false,
        },
        null,
        2,
      ),
    );
  } finally {
    // Windows keeps an unapproved normal quit in the tray. This isolated test
    // must terminate its instance even when an assertion fails before cleanup.
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close();
  }
});

test("等待本机授权时不阻塞撤权，不执行排队输入或恢复过期会话", async () => {
  const root = await mkdtemp(path.resolve("work/input-approval-"));
  const native = path.join(root, "native.cjs");
  const events = path.join(root, "events.jsonl");
  const approved = path.join(root, "approved");
  const moduleFile = path.join(root, "service.cjs");
  await writeFile(
    native,
    `const fs=require('fs');
    const record=event=>fs.appendFileSync(${JSON.stringify(events)},JSON.stringify(event)+'\\n');
    exports.input=input=>{record({type:input.type});return true};
    exports.startInputHelper=async()=>{record({type:'approval-start'});while(!fs.existsSync(${JSON.stringify(approved)}))await new Promise(r=>setTimeout(r,10));return true};
    exports.cancelInputHelper=()=>record({type:'approval-cancel'});
    exports.stopInputHelper=()=>{record({type:'helper-stop'});return true};
    exports.configureInputHelper=scope=>{record({type:'helper-configure',allowed:scope.allowed});return true};
    exports.heartbeatInputHelper=()=>true;exports.inputHelperPid=()=>1234;`,
  );
  await build({
    entryPoints: ["electron/windows-input.ts"],
    outfile: moduleFile,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
  });
  const app = await electron.launch({
    args: [process.cwd(), "--background"],
    env: {
      ...process.env,
      NEARLINK_USER_DATA: path.join(root, "profile"),
      NEARLINK_DEV_ADMIN_INPUT: "0",
      NEARLINK_DEV_LAN: "0",
    },
  });
  const records = async () =>
    (await readFile(events, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  try {
    await expect
      .poll(() => app.windows().some((p) => p.url().includes("window=host")))
      .toBe(true);
    const host = app.windows().find((p) => p.url().includes("window=host"))!;
    await expect
      .poll(() => host.evaluate(() => typeof window.nearlink?.invoke))
      .toBe("function");
    await app.evaluate(
      async ({ BrowserWindow }, options) => {
        const { WindowsInputService } = (process as any).mainModule.require(
          options.moduleFile,
        );
        const service = ((globalThis as any).approvalTestService =
          new WindowsInputService(options.native, () => {}, options.worker, {
            path: "synthetic",
            sha256: "0".repeat(64),
          }));
        await service.start();
        service.attach(
          BrowserWindow.getAllWindows().find((w) =>
            w.webContents.getURL().includes("window=host"),
          )!.webContents,
        );
        service.configure({
          sessionId: "approval-fixture",
          authority: "fixture-authority",
          allowed: true,
          display: { x: 0, y: 0, width: 1920, height: 1080 },
        });
      },
      {
        native,
        moduleFile,
        worker: path.resolve("dist-electron/input-worker.cjs"),
      },
    );
    await expect
      .poll(async () =>
        (await records()).some((r) => r.type === "approval-start"),
      )
      .toBe(true);
    expect(
      await host.evaluate(() =>
        window.nearlink.invoke("media.input", "approval-fixture", {
          type: "key",
          code: "KeyA",
          down: true,
        }),
      ),
    ).toBe(false);
    await app.evaluate(() =>
      (globalThis as any).approvalTestService.configure(null),
    );
    await expect
      .poll(async () =>
        (await records()).some((r) => r.type === "approval-cancel"),
      )
      .toBe(true);
    await writeFile(approved, "synthetic local approval");
    await expect
      .poll(async () => (await records()).some((r) => r.type === "helper-stop"))
      .toBe(true);
    expect(
      (await records()).some((r) => r.type === "key" || r.allowed === true),
    ).toBe(false);
    expect(
      await host.evaluate(() =>
        window.nearlink.invoke("media.input", "approval-fixture", {
          type: "key",
          code: "KeyA",
          down: true,
        }),
      ),
    ).toBe(false);
    await app.evaluate(async () =>
      (globalThis as any).approvalTestService.stop(),
    );
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close();
  }
});
