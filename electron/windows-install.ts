import { spawn } from "node:child_process";
import { open, readFile, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
export type WindowsInstallRequest = {
  version: string;
  installer: string;
  sha256: string;
  size: number;
  parentPid: number;
  installDirectory: string;
  logFile: string;
  resultFile: string;
  statusFile: string;
  startupFile: string;
  token: string;
};
export async function prepareWindowsRequest(
  directory: string,
  values: Pick<
    WindowsInstallRequest,
    | "version"
    | "installer"
    | "sha256"
    | "size"
    | "parentPid"
    | "installDirectory"
  >,
) {
  const token = randomUUID();
  const request: WindowsInstallRequest = {
    ...values,
    token,
    logFile: path.join(directory, "install.log"),
    resultFile: path.join(directory, "install-result.json"),
    statusFile: path.join(directory, `install-${token}.json`),
    startupFile: path.join(directory, `started-${token}.json`),
  };
  const file = path.join(directory, `request-${token}.json`);
  await writeFile(file, JSON.stringify(request), { mode: 0o600 });
  return { file, request };
}
/** Spawn is not readiness: keep the application alive until the helper has
 * parsed the request, opened logging and verified the downloaded installer. */
export async function launchWindowsHelper(options: {
  command: string;
  args: string[];
  directory: string;
  request: WindowsInstallRequest;
  timeoutMs?: number;
}) {
  const stderrFile = path.join(options.directory, "install-startup.log");
  const output = await open(stderrFile, "w", 0o600);
  const child = spawn(options.command, options.args, {
    cwd: options.directory,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", output.fd, output.fd],
  });
  let exited = false,
    exitCode: number | null = null,
    spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
    exited = true;
  });
  child.once("exit", (code) => {
    exitCode = code;
    exited = true;
  });
  try {
    const deadline = Date.now() + (options.timeoutMs ?? 15000);
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      try {
        const status = JSON.parse(
          await readFile(options.request.statusFile, "utf8"),
        );
        if (status.token === options.request.token) {
          if (status.stage === "ready") {
            if (exited)
              throw new Error("安装辅助进程确认就绪后已退出，软件保持运行。");
            child.unref();
            return;
          }
          if (status.stage === "failed")
            throw new Error(String(status.message ?? "安装辅助进程验证失败"));
        }
      } catch (error: any) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError))
          throw error;
      }
      if (exited) {
        const detail = (await readFile(stderrFile, "utf8")).trim().slice(-1500);
        throw new Error(
          `安装辅助进程未就绪便退出 (${exitCode ?? "未启动"})。${detail}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      "安装辅助进程启动超时；软件保持运行，请查看 install-startup.log。",
    );
  } catch (error) {
    // It has not been allowed to install: the parent is still running.
    if (!exited) child.kill();
    throw error;
  } finally {
    await output.close();
  }
}

export async function acknowledgeWindowsStartup(
  directory: string,
  version: string,
  executable: string,
  packaged: boolean,
) {
  try {
    const file = path.join(directory, "windows-pending.json");
    const pending = JSON.parse(await readFile(file, "utf8"));
    if (
      !packaged ||
      pending.version !== version ||
      String(pending.executable).toLowerCase() !== executable.toLowerCase() ||
      typeof pending.startupFile !== "string" ||
      path.dirname(pending.startupFile) !== directory ||
      !/^started-[a-f0-9-]+\.json$/.test(path.basename(pending.startupFile))
    )
      return false;
    await writeFile(
      pending.startupFile,
      JSON.stringify({ token: pending.token, version }),
      { mode: 0o600 },
    );
    await rm(file, { force: true });
    return true;
  } catch {
    return false;
  }
}
