import { build } from "esbuild";
import { guardDisabledAdminInput } from "./guard-disabled-admin-input.mjs";
await build({
  entryPoints: [
    "electron/main.ts",
    "electron/preload.ts",
    "electron/input-worker.ts",
    "electron/capture-worker.ts",
  ],
  outdir: "dist-electron",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outExtension: { ".js": ".cjs" },
  external: ["electron", "original-fs", "*.node"],
  plugins: [guardDisabledAdminInput],
  sourcemap: true,
});
