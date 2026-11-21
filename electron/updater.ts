import { app, dialog } from "electron";
import { EventEmitter } from "node:events";
import path from "node:path";
import {
  readFile,
  mkdir,
  writeFile,
  rm,
  access,
  copyFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createUpdateStage,
  removeUpdateTree,
  pruneUpdateCache,
} from "./update-storage";
import {
  prepareWindowsRequest,
  launchWindowsHelper,
  acknowledgeWindowsStartup,
} from "./windows-install";
import {
  fetchManifest,
  verifiedRelease,
  updateUrl,
  compareVersions,
  downloadArtifact,
  verifyArtifact,
  type UpdateRelease,
  type UpdateArtifact,
} from "./update-core";
import type { UpdateState } from "../src/shared/updates";
const run = promisify(execFile);
export class AppUpdater extends EventEmitter {
  constructor(
    private downloadRate: () => number = () => Infinity,
    private quit: () => void = () => app.quit(),
  ) {
    super();
  }
  private directory = path.join(app.getPath("userData"), "updates");
  private resources = path.join(app.getAppPath(), "resources");
  private release?: UpdateRelease;
  private artifact?: UpdateArtifact;
  private filename?: string;
  private controller?: AbortController;
  private timer?: ReturnType<typeof setInterval>;
  private initial?: ReturnType<typeof setTimeout>;
  private installBusy = false;
  private cleanupTask?: Promise<void>;
  private state: UpdateState = {
    currentVersion: app.getVersion(),
    phase: "idle",
    feedUrl: "",
    message: "",
    downloaded: 0,
    total: 0,
    autoCheck: true,
  };
  snapshot() {
    return { ...this.state };
  }
  private changed(next: Partial<UpdateState>) {
    Object.assign(this.state, next);
    this.emit("state", this.snapshot());
  }
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const defaults = JSON.parse(
      await readFile(path.join(this.resources, "update-config.json"), "utf8"),
    );
    let config: any = {};
    try {
      config = JSON.parse(
        await readFile(path.join(this.directory, "config.json"), "utf8"),
      );
    } catch {}
    this.state.feedUrl =
      typeof config.feedUrl === "string" ? config.feedUrl : defaults.feedUrl;
    this.state.autoCheck = config.autoCheck !== false;
    if (process.platform === "win32") {
      try {
        const result = JSON.parse(
          await readFile(
            path.join(this.directory, "install-result.json"),
            "utf8",
          ),
        );
        if (
          result.stage === "failed" &&
          compareVersions(result.version, app.getVersion()) > 0
        )
          this.changed({
            phase: "error",
            message: `上次更新未完成：${String(result.message).slice(0, 600)}。可查看更新目录中的 install.log 和 install-startup.log。`,
          });
      } catch {}
    }
    if (app.isPackaged) {
      this.initial = setTimeout(() => {
        if (this.state.autoCheck) void this.check().catch(() => {});
      }, 30000);
      this.timer = setInterval(
        () => {
          if (this.state.autoCheck) void this.check().catch(() => {});
        },
        6 * 60 * 60 * 1000,
      );
    }
  }
  async configure(feedUrl: string, autoCheck: boolean) {
    if (
      this.installBusy ||
      ["downloading", "installing"].includes(this.state.phase)
    )
      throw new Error("请先取消当前更新任务");
    if (feedUrl) updateUrl(feedUrl);
    this.controller?.abort();
    this.release = undefined;
    this.artifact = undefined;
    this.filename = undefined;
    await writeFile(
      path.join(this.directory, "config.json"),
      JSON.stringify({ feedUrl, autoCheck }),
      { mode: 0o600 },
    );
    this.changed({
      feedUrl,
      autoCheck,
      phase: "idle",
      nextVersion: undefined,
      downloaded: 0,
      total: 0,
      message: feedUrl ? "更新源已保存" : "尚未配置更新源",
    });
    return this.snapshot();
  }
  async check() {
    if (
      this.installBusy ||
      ["checking", "downloading", "installing"].includes(this.state.phase)
    )
      return this.snapshot();
    if (!this.state.feedUrl) throw new Error("请先配置更新源");
    this.controller?.abort();
    const controller = (this.controller = new AbortController());
    this.changed({ phase: "checking", message: "正在检查更新" });
    try {
      const bytes = await fetchManifest(this.state.feedUrl, controller.signal);
      const release = verifiedRelease(
        bytes,
        await readFile(path.join(this.resources, "update-public.pem"), "utf8"),
      );
      controller.signal.throwIfAborted();
      if (compareVersions(release.version, app.getVersion()) <= 0) {
        this.changed({
          phase: "idle",
          message: "当前已是最新版本",
          nextVersion: undefined,
        });
        return this.snapshot();
      }
      const artifact = release.artifacts[`${process.platform}-${process.arch}`];
      if (
        !artifact ||
        (process.platform === "darwin"
          ? artifact.format !== "zip"
          : artifact.format !== "nsis")
      )
        throw new Error("新版本尚未提供此系统的更新包");
      this.release = release;
      this.artifact = artifact;
      this.filename = undefined;
      this.changed({
        phase: "available",
        nextVersion: release.version,
        notes: release.notes,
        total: artifact.size,
        downloaded: 0,
        message: `发现新版本 ${release.version}`,
      });
    } catch (error) {
      if (controller.signal.aborted) return this.snapshot();
      if (!controller.signal.aborted)
        this.changed({
          phase: "error",
          message: String((error as Error).message),
        });
      throw error;
    }
    return this.snapshot();
  }
  async download() {
    if (this.installBusy || this.state.phase === "installing")
      throw new Error("正在准备安装，请稍候");
    if (!this.release || !this.artifact) throw new Error("请先检查更新");
    if (this.state.phase === "downloading") return this.snapshot();
    this.controller?.abort();
    const controller = (this.controller = new AbortController());
    const file = path.join(
      this.directory,
      `NearLink-${this.release.version}-${process.arch}.${this.artifact.format === "zip" ? "zip" : "exe"}`,
    );
    this.changed({
      phase: "downloading",
      message: "正在下载安装包",
      downloaded: 0,
    });
    let at = 0;
    try {
      await downloadArtifact(
        this.artifact,
        file,
        controller.signal,
        (downloaded) => {
          if (Date.now() - at > 200) {
            at = Date.now();
            this.changed({ downloaded });
          }
        },
        this.downloadRate,
      );
      controller.signal.throwIfAborted();
      this.filename = file;
      this.changed({
        phase: "ready",
        downloaded: this.artifact.size,
        message: "已下载并验证签名，可安装更新",
      });
    } catch (error) {
      if (controller.signal.aborted) return this.snapshot();
      if (!controller.signal.aborted)
        this.changed({ phase: "error", message: (error as Error).message });
      throw error;
    }
    return this.snapshot();
  }
  cancel() {
    if (this.installBusy || this.state.phase === "installing")
      return this.snapshot();
    this.controller?.abort();
    this.changed({
      phase: this.release ? "available" : "idle",
      downloaded: 0,
      message: "已取消更新任务",
    });
    return this.snapshot();
  }
  async install(hasActiveWork: boolean) {
    if (this.installBusy || this.state.phase === "installing") return false;
    this.installBusy = true;
    try {
      return await this.prepareInstall(hasActiveWork);
    } finally {
      this.installBusy = false;
    }
  }
  private async prepareInstall(hasActiveWork: boolean) {
    await this.cleanupTask;
    if (!app.isPackaged)
      throw new Error("开发模式不执行安装，请使用已安装的 NearLink");
    if (this.state.phase !== "ready" || !this.filename || !this.artifact)
      throw new Error("安装包尚未下载完成");
    const result = await dialog.showMessageBox({
      type: "question",
      buttons: ["稍后", "安装并重新打开"],
      defaultId: 0,
      cancelId: 0,
      title: "安装 NearLink 更新",
      message: `安装 ${this.state.nextVersion} 并重新打开 NearLink？`,
      detail: hasActiveWork
        ? "安装会断开当前远控并取消未完成的文件任务。"
        : "安装过程中软件会短暂退出，之后自动重新打开。",
    });
    if (result.response !== 1) return false;
    const log = path.join(this.directory, "install.log");
    let windowsPending: string | undefined;
    let macStage: string | undefined;
    let macPending: string | undefined;
    try {
      this.changed({ phase: "installing", message: "正在准备安装" });
      await verifyArtifact(this.filename, this.artifact);
      if (process.platform === "darwin") {
        const target = path.resolve(path.dirname(process.execPath), "../..");
        if (!target.endsWith(".app") || target.startsWith("/Volumes/"))
          throw new Error("请先把 NearLink 拖到应用程序文件夹，再安装更新");
        await access(path.dirname(target), constants.W_OK);
        const stage = (macStage = await createUpdateStage(this.directory));
        await run("/usr/bin/ditto", ["-xk", this.filename, stage]);
        const source = path.join(stage, "NearLink.app");
        await run("/usr/bin/codesign", [
          "--verify",
          "--deep",
          "--strict",
          source,
        ]);
        const id = await run("/usr/libexec/PlistBuddy", [
          "-c",
          "Print :CFBundleIdentifier",
          path.join(source, "Contents/Info.plist"),
        ]);
        if (id.stdout.trim() !== "app.nearlink.desktop")
          throw new Error("更新包应用标识不一致");
        const version = await run("/usr/libexec/PlistBuddy", [
          "-c",
          "Print :CFBundleShortVersionString",
          path.join(source, "Contents/Info.plist"),
        ]);
        if (version.stdout.trim() !== this.state.nextVersion)
          throw new Error("更新包版本与发布清单不一致");
        const helper = path.join(this.directory, "install-update.sh");
        await copyFile(
          path.join(this.resources, "install-update-mac.sh"),
          helper,
        );
        macPending = path.join(this.directory, "pending.json");
        await writeFile(
          macPending,
          JSON.stringify({
            backup: target + `.previous-${process.pid}`,
            previousPid: process.pid,
            version: this.state.nextVersion,
            stage,
          }),
          { mode: 0o600 },
        );
        await this.detach("/bin/sh", [
          helper,
          source,
          target,
          String(process.pid),
          log,
        ]);
      } else if (process.platform === "win32") {
        const helper = path.join(this.directory, "install-update.ps1");
        const script = await readFile(
          path.join(this.resources, "install-update-win.ps1"),
        );
        if (script.length < 128)
          throw Error("安装辅助脚本不完整，请重新安装应用");
        await writeFile(helper, script, { mode: 0o600 });
        const prepared = await prepareWindowsRequest(this.directory, {
          version: this.state.nextVersion!,
          installer: this.filename,
          sha256: this.artifact.sha256,
          size: this.artifact.size,
          parentPid: process.pid,
          installDirectory: path.dirname(process.execPath),
        });
        windowsPending = path.join(this.directory, "windows-pending.json");
        await writeFile(
          windowsPending,
          JSON.stringify({
            version: prepared.request.version,
            token: prepared.request.token,
            startupFile: prepared.request.startupFile,
            executable: process.execPath,
          }),
          { mode: 0o600 },
        );
        const systemRoot =
          process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
        const launcher = path.join(
          this.directory,
          `launcher-${prepared.request.token}.exe`,
        );
        await writeFile(
          launcher,
          await readFile(
            path.join(this.resources, "update-launcher-win-x64.exe"),
          ),
          { mode: 0o700 },
        );
        await launchWindowsHelper({
          command: launcher,
          args: [
            path.win32.join(
              systemRoot,
              "System32",
              "WindowsPowerShell",
              "v1.0",
              "powershell.exe",
            ),
            helper,
            prepared.file,
            path.join(this.directory, "install-startup.log"),
          ],
          directory: this.directory,
          request: prepared.request,
        });
      } else throw new Error("当前系统不支持应用内安装更新");
      this.quit();
      return true;
    } catch (error) {
      if (windowsPending)
        await rm(windowsPending, { force: true }).catch(() => {});
      if (macStage) await removeUpdateTree(macStage).catch(() => {});
      if (macPending) await rm(macPending, { force: true }).catch(() => {});
      this.changed({ phase: "error", message: (error as Error).message });
      throw error;
    }
  }
  async cleanPreviousAfterReady() {
    this.cleanupTask ??= this.cleanPrevious();
    await this.cleanupTask;
  }
  private async cleanPrevious() {
    if (!app.isPackaged) return;
    if (process.platform === "win32") {
      await acknowledgeWindowsStartup(
        this.directory,
        app.getVersion(),
        process.execPath,
        app.isPackaged,
      );
    }
    let cleanStages = true;
    try {
      const pending = JSON.parse(
        await readFile(path.join(this.directory, "pending.json"), "utf8"),
      );
      const target = path.resolve(path.dirname(process.execPath), "../..");
      if (
        process.platform === "darwin" &&
        compareVersions(pending.version, app.getVersion()) <= 0 &&
        Number.isSafeInteger(pending.previousPid) &&
        pending.previousPid > 0 &&
        pending.backup === target + `.previous-${pending.previousPid}`
      ) {
        await removeUpdateTree(pending.backup);
        await rm(path.join(this.directory, "pending.json"), { force: true });
      } else if (compareVersions(pending.version, app.getVersion()) > 0)
        cleanStages = false;
    } catch (error: any) {
      // A failed backup cleanup must not prevent clearing old download files.
      if (error.code !== "ENOENT") cleanStages = false;
    }
    await pruneUpdateCache(this.directory, app.getVersion(), cleanStages).catch(
      () => {},
    );
  }
  private detach(command: string, args: string[]) {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  }
  stop() {
    this.controller?.abort();
    if (this.initial) clearTimeout(this.initial);
    if (this.timer) clearInterval(this.timer);
  }
}
