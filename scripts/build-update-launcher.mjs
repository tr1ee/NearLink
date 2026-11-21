import { spawnSync } from "node:child_process";
import path from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
const output = path.resolve("resources/update-launcher-win-x64.exe");
const source = "native/update-launcher-win.c";
mkdirSync("work/launcher-build", { recursive: true });
const windows = process.platform === "win32";
const command = windows ? "cl" : process.env.NEARLINK_ZIG || "zig";
const args = windows
  ? [
      "/nologo",
      "/W4",
      "/O2",
      source,
      "/Fowork/launcher-build/launcher.obj",
      "/link",
      "/SUBSYSTEM:WINDOWS",
      "shell32.lib",
      `/OUT:${output}`,
    ]
  : [
      "cc",
      "-target",
      "x86_64-windows-gnu",
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-O2",
      "-s",
      "-Wl,--subsystem,windows",
      source,
      "-lshell32",
      "-o",
      output,
    ];
const result = spawnSync(command, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    ZIG_GLOBAL_CACHE_DIR: path.resolve("work/launcher-build/global"),
    ZIG_LOCAL_CACHE_DIR: path.resolve("work/launcher-build/local"),
  },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const binary = readFileSync(output);
const pe = binary.readUInt32LE(0x3c);
if (
  binary.toString("ascii", pe, pe + 4) !== "PE\0\0" ||
  binary.readUInt16LE(pe + 4) !== 0x8664 ||
  binary.readUInt16LE(pe + 24) !== 0x20b ||
  binary.readUInt16LE(pe + 24 + 68) !== 2
)
  throw new Error("更新启动器必须为 x64 Windows GUI 可执行文件");
console.log(`Windows GUI update launcher verified (${binary.length} bytes).`);
