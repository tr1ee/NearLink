import { spawn } from "node:child_process";
import { build } from "esbuild";
import { createServer } from "vite";
await build({
  entryPoints: [
    "electron/main.ts",
    "electron/preload.ts",
    "electron/input-worker.ts",
  ],
  outdir: "dist-electron",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outExtension: { ".js": ".cjs" },
  external: ["electron", "*.node"],
  sourcemap: true,
});
const server = await createServer();
await server.listen();
const { default: electron } = await import("electron");
const child = spawn(electron, ["."], {
  stdio: "inherit",
  env: { ...process.env, NEARLINK_DEV_URL: "http://127.0.0.1:5173" },
});
child.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
process.on("SIGINT", () => child.kill("SIGINT"));
