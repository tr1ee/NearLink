import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import path from "node:path";
import { cleanupTemporaryApps } from "./temporary-apps.mjs";
const settings = JSON.parse(readFileSync("package.json", "utf8"));
const output = settings.build.directories.output;
const platform = process.argv[2];
if (!["mac", "win"].includes(platform)) throw new Error("Specify mac or win");
const pkg = JSON.parse(
  readFileSync("node_modules/electron-builder/package.json", "utf8"),
);
const cli = path.resolve(
  "node_modules/electron-builder",
  pkg.bin["electron-builder"],
);
const args =
  platform === "mac" ? ["--mac", "--arm64", "--x64"] : ["--win", "--x64"];
const result = spawnSync(
  process.execPath,
  [cli, ...args, "--publish", "never"],
  { stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status ?? 1);
mkdirSync("outputs/installers", { recursive: true });
for (const file of readdirSync(output))
  if (/^NearLink-.*\.(dmg|zip|exe)$/.test(file))
    copyFileSync(
      path.join(output, file),
      path.join("outputs/installers", file),
    );
// The distributable ZIP/DMG files now contain the application; retaining extra
// unpacked bundles causes duplicate macOS launcher/search entries.
if (platform === "mac")
  console.log("Temporary app cleanup:", await cleanupTemporaryApps(output));
