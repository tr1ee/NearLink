// Exercise the actual update helper against tiny, isolated background apps.
// Never replaces or launches the user's installed NearLink.
import { mkdtemp, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { cleanupTemporaryApps } from "./temporary-apps.mjs";
const run = promisify(execFile);
if (process.platform !== "darwin")
  throw Error("This helper test requires macOS");
const staging = path.resolve("work/update-tests.noindex");
await mkdir(staging, { recursive: true });
const directory = await mkdtemp(path.join(staging, "update-install-"));
const marker = path.join(directory, "launched.txt");
async function bundle(folder, label, sign = true) {
  const app = path.join(directory, folder, "NearLink.app");
  await mkdir(path.join(app, "Contents/MacOS"), { recursive: true });
  const code = `#include <stdio.h>\nint main(){FILE*f=fopen(${JSON.stringify(marker)},"w");if(f){fputs("${label}",f);fclose(f);}return 0;}\n`;
  const source = path.join(directory, `${label}.c`);
  await writeFile(source, code);
  await run("/usr/bin/clang", [
    source,
    "-o",
    path.join(app, "Contents/MacOS/NearLink"),
  ]);
  await writeFile(
    path.join(app, "Contents/Info.plist"),
    `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>app.nearlink.update-smoke</string><key>CFBundleExecutable</key><string>NearLink</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>2</string><key>LSBackgroundOnly</key><true/><key>LSUIElement</key><true/></dict></plist>`,
  );
  if (sign)
    await run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", app]);
  return app;
}
try {
  const target = await bundle("Applications", "old");
  const source = await bundle("new", "new");
  const parent = spawn("/bin/sleep", ["0.3"]);
  await run("/bin/sh", [
    path.resolve("resources/install-update-mac.sh"),
    source,
    target,
    String(parent.pid),
    path.join(directory, "install.log"),
  ]);
  assert((await stat(`${target}.previous-${parent.pid}`)).isDirectory());
  assert(
    (await readFile(path.join(target, "Contents/MacOS/NearLink"))).equals(
      await readFile(path.join(source, "Contents/MacOS/NearLink")),
    ),
  );
  for (let i = 0; i < 50; i++) {
    if ((await readFile(marker, "utf8").catch(() => "")) === "new") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(await readFile(marker, "utf8"), "new");
  const bad = path.join(directory, "invalid/NearLink.app");
  await mkdir(bad, { recursive: true });
  await writeFile(path.join(bad, "unsigned.txt"), "not an application");
  const installed = await readFile(
    path.join(target, "Contents/MacOS/NearLink"),
  );
  await assert.rejects(
    run("/bin/sh", [
      path.resolve("resources/install-update-mac.sh"),
      bad,
      target,
      "999999",
      path.join(directory, "rejected.log"),
    ]),
  );
  assert(
    (await readFile(path.join(target, "Contents/MacOS/NearLink"))).equals(
      installed,
    ),
  );
  const report = {
    at: new Date().toISOString(),
    status: "passed",
    scope: "macOS actual installer helper; isolated test bundles only",
    checks: [
      "wait for old process",
      "verify signature",
      "replace bundle",
      "preserve backup",
      "launch updated background application",
      "reject invalid app and preserve installed version",
    ],
    windows: "not executed on Windows",
  };
  await writeFile(
    "outputs/install-validation.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  await new Promise((resolve) => setTimeout(resolve, 200));
  console.log("Temporary app cleanup:", await cleanupTemporaryApps(directory));
}
