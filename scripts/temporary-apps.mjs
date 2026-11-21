import { readdir, rm, realpath, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
const run = promisify(execFile);
const register =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

// Only call with a generated build/test staging directory, never an install
// directory. Unregister before removing so macOS does not retain launcher icons.
export async function cleanupTemporaryApps(directory) {
  const root = path.resolve(directory);
  const rootReal = await realpath(root).catch(() => null);
  if (!rootReal) return { removed: [], keptRunning: [] };
  if (!rootReal.split(path.sep).includes("work"))
    throw Error("Cleanup is restricted to generated work directories");
  const protectedApps = await Promise.all(
    [
      "/Applications/NearLink.app",
      path.join(os.homedir(), "Applications/NearLink.app"),
    ].map((p) => stat(p).catch(() => null)),
  );
  const apps = [];
  async function visit(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(
      () => [],
    )) {
      if (!entry.isDirectory()) continue;
      const filename = path.join(folder, entry.name);
      if (
        entry.name === "NearLink.app" ||
        /^NearLink\.app\.previous-\d+$/.test(entry.name)
      )
        apps.push(filename);
      else if (!entry.name.endsWith(".app")) await visit(filename);
    }
  }
  await visit(root);
  const removed = [],
    keptRunning = [];
  for (const app of apps) {
    const relative = path.relative(root, app);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      throw Error("Invalid temporary application path");
    const appReal = await realpath(app);
    if (!appReal.startsWith(rootReal + path.sep))
      throw Error("Temporary app resolves outside staging directory");
    const candidate = await stat(app);
    if (
      protectedApps.some(
        (p) => p && p.dev === candidate.dev && p.ino === candidate.ino,
      )
    ) {
      keptRunning.push(app);
      continue;
    }
    if (process.platform === "darwin") {
      // Fail safely if the process list cannot be read. Never delete an app
      // that the user has launched from the staging directory.
      let processes;
      try {
        processes = (await run("/bin/ps", ["-axo", "comm="])).stdout
          .split("\n")
          .map((v) => v.trim());
      } catch {
        keptRunning.push(app);
        continue;
      }
      if (processes.some((p) => p.startsWith(app + path.sep))) {
        keptRunning.push(app);
        continue;
      }
      await run(register, ["-u", app]).catch(() => {});
    }
    await rm(app, { recursive: true, force: true });
    removed.push(app);
  }
  return { removed, keptRunning };
}
