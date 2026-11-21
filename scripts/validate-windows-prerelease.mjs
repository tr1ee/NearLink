import { _electron as electron } from "@playwright/test";
import { readFile, mkdir, access, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import assert from "node:assert/strict";
import * as asar from "@electron/asar";
if (
  process.platform !== "win32" ||
  process.env.GITHUB_ACTIONS !== "true" ||
  !process.env.RUNNER_TEMP
)
  throw Error(
    "Real NSIS validation runs only in a disposable GitHub Windows runner.",
  );
const run = promisify(execFile),
  { version } = JSON.parse(await readFile("package.json", "utf8"));
const root = path.resolve(
  process.env.RUNNER_TEMP,
  "NearLink-install-validation",
  version,
);
const target = path.join(root, "installed"),
  profile = path.join(root, "profile");
await mkdir(root, { recursive: true });
const installer = path.resolve(
  `outputs/installers/NearLink-${version}-win-x64.exe`,
);
const installerSha256 = createHash("sha256")
  .update(await readFile(installer))
  .digest("hex");
await run(installer, ["/S", `/D=${target}`], {
  windowsHide: true,
  timeout: 180000,
});
const executable = path.join(target, "NearLink.exe");
await access(executable);
const metadata = JSON.parse(
  asar
    .extractFile(path.join(target, "resources/app.asar"), "package.json")
    .toString(),
);
assert.equal(metadata.version, version);
const app = await electron.launch({
  executablePath: executable,
  args: ["--background"],
  env: {
    ...process.env,
    NEARLINK_USER_DATA: profile,
    NEARLINK_DEV_LAN: "0",
    NEARLINK_DEV_ADMIN_INPUT: "0",
    NEARLINK_INSTALLED_SERVICE: "0",
  },
  timeout: 30000,
});
try {
  let page;
  for (let i = 0; i < 100 && !page; i++) {
    page = app.windows().find((p) => p.url().includes("window=home"));
    if (!page) await new Promise((r) => setTimeout(r, 100));
  }
  assert(page);
  await page
    .getByRole("button", { name: "设置", exact: true })
    .waitFor({ timeout: 30000 });
  const info = await app.evaluate(({ app }) => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
  }));
  assert.equal(info.version, version);
  assert.equal(info.packaged, true);
  const unpacked = path.join(target, "resources/app.asar.unpacked");
  const hashes = {};
  for (const [name, filename] of Object.entries({
    input: "native/prebuilds/win32-x64/nearlink.node",
    capture: "native/prebuilds/win32-x64/nearlink-capture.node",
    service: "resources/NearLinkService.exe",
  }))
    hashes[name] = createHash("sha256")
      .update(await readFile(path.join(unpacked, filename)))
      .digest("hex");
  await access(path.join(unpacked, "resources/install-desktop-service.ps1"));
  const state = await page.evaluate(() => window.nearlink.invoke("state"));
  assert.equal(state.permissions.accessibility, true);
  const report = {
    at: new Date().toISOString(),
    status: "passed",
    version,
    sourceCommit: process.env.GITHUB_SHA,
    installerSha256,
    scope:
      "Actual NSIS installation, packaged application startup and native module availability; excludes SCM install, secure desktop capture and real input acceptance.",
    hashes,
  };
  await mkdir("outputs", { recursive: true });
  await writeFile(
    `outputs/windows-real-install-validation-${version}.json`,
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    `Actual NSIS ${version} installation and packaged native startup validated.`,
  );
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close();
}
