import * as nodeFs from "node:fs";
import path from "node:path";
import { compareVersions } from "./update-core";

// Electron's patched fs treats app.asar as a directory. Recursive removal of
// an extracted bundle then leaves app.asar behind and fails with ENOTEMPTY.
// Keep this local to physical update files; do not change process.noAsar.
export const updateDisk: typeof nodeFs.promises = process.versions.electron
  ? require("original-fs").promises
  : nodeFs.promises;

const removeOptions = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 100,
};
export async function removeUpdateTree(filename: string) {
  await updateDisk.rm(filename, removeOptions);
}
export async function createUpdateStage(directory: string) {
  const parent = path.join(directory, "staging.noindex");
  await updateDisk.mkdir(parent, { recursive: true, mode: 0o700 });
  return updateDisk.mkdtemp(path.join(parent, "install-"));
}
export async function pruneUpdateCache(
  directory: string,
  currentVersion: string,
  cleanStages = true,
) {
  const removed: string[] = [],
    failures: { name: string; code: string }[] = [];
  const remove = async (filename: string) => {
    try {
      await removeUpdateTree(filename);
      removed.push(path.relative(directory, filename));
    } catch (error: any) {
      failures.push({
        name: path.relative(directory, filename),
        code: String(error.code ?? "UNKNOWN"),
      });
    }
  };
  const entries = await updateDisk.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const launcher = /^launcher-([a-f0-9-]{36})\.exe$/.exec(entry.name);
    if (entry.isFile() && launcher) {
      // Only our UUID-named helpers with a matching request/version belong to
      // this updater. Preserve future or unidentifiable failed update files.
      const requestFile = path.join(directory, `request-${launcher[1]}.json`);
      try {
        const stat = await updateDisk.lstat(requestFile);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 65536) {
          const request = JSON.parse(
            await updateDisk.readFile(requestFile, "utf8"),
          );
          if (
            request.token === launcher[1] &&
            /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(request.version) &&
            compareVersions(request.version, currentVersion) <= 0
          )
            await remove(path.join(directory, entry.name));
        }
      } catch {
        /* Missing or malformed ownership metadata is preserved. */
      }
    }
    const match =
      /^NearLink-(\d{1,6}\.\d{1,6}\.\d{1,6})-(?:arm64|x64)\.(?:zip|exe)(?:\.(?:[a-f0-9-]{36}\.)?part)?$/.exec(
        entry.name,
      );
    if (
      entry.isFile() &&
      match &&
      compareVersions(match[1], currentVersion) <= 0
    )
      await remove(path.join(directory, entry.name));
  }
  if (cleanStages) {
    const legacy = entries.find((e) => e.name === "unpacked");
    if (legacy?.isDirectory()) await remove(path.join(directory, legacy.name));
    const stageRoot = path.join(directory, "staging.noindex");
    for (const entry of await updateDisk
      .lstat(stageRoot)
      .then((s) =>
        s.isDirectory()
          ? updateDisk.readdir(stageRoot, { withFileTypes: true })
          : [],
      )
      .catch(() => []))
      if (entry.isDirectory() && /^install-[a-zA-Z0-9-]+$/.test(entry.name))
        await remove(path.join(stageRoot, entry.name));
  }
  const report = {
    at: new Date().toISOString(),
    currentVersion,
    removed,
    failures,
  };
  await updateDisk.writeFile(
    path.join(directory, "cache-cleanup.json"),
    JSON.stringify(report),
    { mode: 0o600 },
  );
  return report;
}
