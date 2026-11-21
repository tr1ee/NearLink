import { spawnSync, execFileSync } from "node:child_process";
import {
  readFileSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { createHash } from "node:crypto";
import * as asar from "@electron/asar";
import path from "node:path";
import { cleanupTemporaryApps } from "./temporary-apps.mjs";
const settings = JSON.parse(readFileSync("package.json", "utf8"));
const output = settings.build.directories.output;
if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim())
  throw Error("Commit source changes before creating release artifacts.");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
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
if (platform === "mac") {
  const bundles = readdirSync(output, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) =>
      path.join(output, entry.name, "NearLink.app/Contents/Resources/app.asar"),
    )
    .filter(existsSync);
  if (bundles.length < 2)
    throw Error("Expected both packaged Mac architectures.");
  for (const archive of bundles) {
    const built = JSON.parse(
      asar.extractFile(archive, "package.json").toString(),
    );
    if (built.version !== settings.version)
      throw Error("Packaged Mac version differs from source.");
  }
  const hashes = {};
  for (const arch of ["arm64", "x64"])
    for (const ext of ["zip", "dmg"]) {
      const filename = `NearLink-${settings.version}-mac-${arch}.${ext}`;
      hashes[filename] = createHash("sha256")
        .update(readFileSync(path.join("outputs/installers", filename)))
        .digest("hex");
    }
  writeFileSync(
    `outputs/mac-build-validation-${settings.version}.json`,
    JSON.stringify(
      { status: "passed", version: settings.version, sourceCommit, hashes },
      null,
      2,
    ) + "\n",
  );
  console.log("Temporary app cleanup:", await cleanupTemporaryApps(output));
}
