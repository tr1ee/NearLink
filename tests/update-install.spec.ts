import { test, expect, _electron as electron } from "@playwright/test";
import { build } from "esbuild";
import { mkdtemp, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import path from "node:path";
import * as asar from "@electron/asar";
import { cleanupTemporaryApps } from "../scripts/temporary-apps.mjs";
const run = promisify(execFile);

test("Electron真实更新安装：遗留ASAR不阻塞、失败可重试、拒绝重复安装、重启后清理缓存", async () => {
  test.skip(process.platform !== "darwin");
  test.setTimeout(90000);
  const root = await mkdtemp(path.resolve("work/update-install.noindex-"));
  const updates = path.join(root, "updates"),
    marker = path.join(root, "started.txt");
  const fixtureVersion = "9.9.9";
  await mkdir(updates);
  const moduleFile = path.join(root, "updater.cjs");
  await build({
    entryPoints: ["electron/updater.ts"],
    outfile: moduleFile,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron", "original-fs"],
  });
  const sourceDir = path.join(root, "asar-source");
  await mkdir(sourceDir);
  await writeFile(
    path.join(sourceDir, "package.json"),
    JSON.stringify({ name: "nearlink", version: fixtureVersion }),
  );
  const archive = path.join(root, "fixture.asar");
  await asar.createPackage(sourceDir, archive);
  async function bundle(parent: string, label: string) {
    const target = path.join(root, parent, "NearLink.app");
    await mkdir(path.join(target, "Contents/MacOS"), { recursive: true });
    await mkdir(path.join(target, "Contents/Resources"));
    const c = path.join(root, `${label}.c`);
    await writeFile(
      c,
      `#include <stdio.h>\nint main(){FILE*f=fopen(${JSON.stringify(marker)},"w");if(f){fputs("${label}",f);fclose(f);}return 0;}\n`,
    );
    await run("/usr/bin/clang", [
      c,
      "-o",
      path.join(target, "Contents/MacOS/NearLink"),
    ]);
    await writeFile(
      path.join(target, "Contents/Info.plist"),
      `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>app.nearlink.desktop</string><key>CFBundleShortVersionString</key><string>${fixtureVersion}</string><key>CFBundleVersion</key><string>9999</string><key>CFBundleExecutable</key><string>NearLink</string><key>CFBundlePackageType</key><string>APPL</string><key>LSBackgroundOnly</key><true/></dict></plist>`,
    );
    await writeFile(
      path.join(target, "Contents/Resources/app.asar"),
      await readFile(archive),
    );
    await run("/usr/bin/codesign", [
      "--force",
      "--deep",
      "--sign",
      "-",
      target,
    ]);
    return target;
  }
  const target = await bundle("Applications", "old"),
    source = await bundle("new", "new");
  const installer = path.join(updates, `NearLink-${fixtureVersion}-arm64.zip`);
  await run("/usr/bin/ditto", ["-ck", "--keepParent", source, installer]);
  const bytes = await readFile(installer);
  const legacy = path.join(updates, "unpacked/NearLink.app/Contents/Resources");
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, "app.asar"), await readFile(archive));
  const malformed = path.join(updates, "malformed.zip");
  await writeFile(malformed, "broken zip for retry test");
  await writeFile(
    path.join(updates, "NearLink-0.1.2-arm64.zip"),
    "old cached download",
  );
  await writeFile(
    path.join(updates, "NearLink-10.0.0-arm64.zip"),
    "future update remains",
  );
  await writeFile(path.join(updates, "config.json"), "{}");
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  const launch = async () => {
    const instance = await electron.launch({
      executablePath: process.env.NEARLINK_ELECTRON_EXECUTABLE,
      args: [process.cwd(), "--background"],
      env: { ...process.env, NEARLINK_USER_DATA: path.join(root, "profile") },
    });
    await expect
      .poll(() =>
        instance.windows().some((p) => p.url().includes("window=home")),
      )
      .toBe(true);
    await instance
      .windows()
      .find((p) => p.url().includes("window=home"))!
      .getByRole("button", { name: "设置", exact: true })
      .waitFor();
    await instance.evaluate(
      ({ app, dialog }, options) => {
        Object.defineProperty(app, "isPackaged", {
          value: true,
          configurable: true,
        });
        app.getVersion = () => options.version;
        Object.defineProperty(process, "execPath", {
          value: options.target + "/Contents/MacOS/NearLink",
          configurable: true,
        });
        const { AppUpdater } = (process as any).mainModule.require(
          options.moduleFile,
        );
        const w = globalThis as any;
        w.fixtureUpdater = new AppUpdater(undefined, () => {
          w.fixtureQuit = true;
        });
        w.fixtureUpdater.directory = options.updates;
        dialog.showMessageBox = async () => ({
          response: 1,
          checkboxChecked: false,
        });
      },
      { target, updates, moduleFile, version: fixtureVersion },
    );
    return instance;
  };
  try {
    app = await launch();
    const failed = await app.evaluate(
      async (_e, options) => {
        const w = globalThis as any,
          u = w.fixtureUpdater;
        u.filename = options.malformed;
        u.artifact = {
          size: options.badSize,
          sha256: options.badHash,
          format: "zip",
        };
        u.state.phase = "ready";
        u.state.nextVersion = options.version;
        let error = "";
        try {
          await u.install(false);
        } catch (e: any) {
          error = e.message;
        }
        return {
          error,
          quit: !!w.fixtureQuit,
          phase: u.snapshot().phase,
          stages: await (process as any).mainModule
            .require("original-fs")
            .promises.readdir(options.updates + "/staging.noindex"),
        };
      },
      {
        malformed,
        badSize: (await readFile(malformed)).length,
        badHash: createHash("sha256")
          .update(await readFile(malformed))
          .digest("hex"),
        version: fixtureVersion,
        updates,
      },
    );
    expect(failed.error).not.toBe("");
    expect(failed.quit).toBe(false);
    expect(failed.phase).toBe("error");
    expect(failed.stages).toEqual([]);
    await app.evaluate(
      ({ dialog }, options) => {
        const w = globalThis as any,
          u = w.fixtureUpdater;
        u.filename = options.installer;
        u.artifact = {
          size: options.size,
          sha256: options.hash,
          format: "zip",
        };
        u.state.phase = "ready";
        w.modalCount = 0;
        dialog.showMessageBox = () => {
          w.modalCount++;
          return new Promise((resolve) => {
            w.resolveModal = resolve;
          });
        };
        w.firstInstall = u.install(false);
      },
      {
        installer,
        size: bytes.length,
        hash: createHash("sha256").update(bytes).digest("hex"),
      },
    );
    expect(
      await app.evaluate(async () =>
        (globalThis as any).fixtureUpdater.install(false),
      ),
    ).toBe(false);
    const prepared = await app.evaluate(async () => {
      const w = globalThis as any;
      w.resolveModal({ response: 1 });
      return {
        result: await w.firstInstall,
        modalCount: w.modalCount,
        quit: w.fixtureQuit,
      };
    });
    expect(prepared).toEqual({ result: true, modalCount: 1, quit: true });
    const pending = JSON.parse(
      await readFile(path.join(updates, "pending.json"), "utf8"),
    );
    expect(pending.stage).toContain("staging.noindex/install-");
    await access(path.join(legacy, "app.asar")); // old directory never blocks preparation
    await app.close();
    app = undefined; // actual helper waits, replaces and launches background-only tiny app
    await expect
      .poll(() => readFile(marker, "utf8").catch(() => ""), { timeout: 15000 })
      .toBe("new");
    await access(pending.backup);
    app = await launch();
    await app.evaluate(async () =>
      (globalThis as any).fixtureUpdater.cleanPreviousAfterReady(),
    );
    for (const file of [
      pending.backup,
      pending.stage,
      path.join(updates, "unpacked"),
      installer,
      path.join(updates, "NearLink-0.1.2-arm64.zip"),
      path.join(updates, "pending.json"),
    ])
      await expect
        .poll(() =>
          access(file)
            .then(() => true)
            .catch(() => false),
        )
        .toBe(false);
    await access(path.join(updates, "NearLink-10.0.0-arm64.zip"));
    await access(path.join(updates, "config.json"));
    const cleanup = JSON.parse(
      await readFile(path.join(updates, "cache-cleanup.json"), "utf8"),
    );
    expect(cleanup.failures).toEqual([]);
    await writeFile(
      "outputs/update-install-validation.json",
      JSON.stringify(
        {
          at: new Date().toISOString(),
          status: "passed",
          scope:
            "Actual AppUpdater running under Electron plus real macOS helper and signed tiny background app in an isolated work directory; no installed application modified",
          checks: [
            "legacy ASAR remains without blocking unique staging",
            "bad archive fails before quit and stage is cleaned",
            "retry verifies valid signed app",
            "duplicate install opens one dialog and starts one helper",
            "actual helper waits for Electron exit, replaces and launches",
            "successful startup removes old backup, legacy ASAR, stage and completed downloads",
            "future download and configuration preserved",
          ],
          cleanup,
        },
        null,
        2,
      ),
    );
  } finally {
    await app?.close().catch(() => {});
    await cleanupTemporaryApps(root);
  }
});
