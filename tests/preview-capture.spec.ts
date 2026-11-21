import { test, expect, _electron as electron } from "@playwright/test";
import { build } from "esbuild";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";

test("活跃会话复用首页预览，旧控制端轮询不会再启动额外桌面采集", async () => {
  const root = await mkdtemp(path.resolve("work/preview-capture-"));
  const moduleFile = path.join(root, "runtime.cjs");
  await build({
    entryPoints: ["electron/runtime.ts"],
    outfile: moduleFile,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron", "original-fs", "*.node"],
  });
  const app = await electron.launch({
    executablePath: process.env.NEARLINK_ELECTRON_EXECUTABLE,
    args: [process.cwd(), "--background"],
    env: { ...process.env, NEARLINK_USER_DATA: path.join(root, "profile") },
  });
  try {
    const result = await app.evaluate(
      async ({ desktopCapturer }, moduleFile) => {
        const load = process
          .getBuiltinModule("node:module")!
          .createRequire(moduleFile);
        const { Runtime } = load(moduleFile);
        const runtime = new Runtime();
        let captures = 0;
        let permission = "granted";
        runtime.permissions = () => ({ screen: permission });
        runtime.displays = () => [];
        desktopCapturer.getSources = async () => {
          captures++;
          return [
            { thumbnail: { toDataURL: () => `synthetic-${captures}` } },
          ] as any;
        };
        const idle = await runtime.rpc("paired", "preview");
        runtime.session = {
          id: "fixture",
          peerId: "paired",
          state: "connected",
          role: "host",
        };
        const images = [];
        for (let i = 0; i < 60; i++)
          images.push((await runtime.rpc("paired", "preview")).image);
        const liveCaptures = captures;
        permission = "denied";
        let denied = false;
        try {
          await runtime.rpc("paired", "preview");
        } catch {
          denied = true;
        }
        permission = "granted";
        runtime.session = null;
        const after = await runtime.rpc("paired", "preview");
        return {
          idle: idle.image,
          images,
          liveCaptures,
          after: after.image,
          captures,
          permissionCheckedBeforeCache: denied || process.platform !== "darwin",
        };
      },
      moduleFile,
    );
    expect(result.liveCaptures).toBe(1);
    expect(result.images.every((image) => image === result.idle)).toBe(true);
    expect(result.captures).toBe(2);
    expect(result.after).not.toBe(result.idle);
    expect(result.permissionCheckedBeforeCache).toBe(true);
  } finally {
    await app.close();
  }
});
