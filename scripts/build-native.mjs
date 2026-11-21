import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
const headers = path.resolve("node_modules/node-api-headers/include");
const arches = process.argv.includes("--all-mac")
  ? ["arm64", "x64"]
  : [process.arch];
for (const arch of arches) {
  const dir = `native/prebuilds/${process.platform}-${arch}`;
  mkdirSync(dir, { recursive: true });
  let command, args;
  if (process.platform === "darwin") {
    command = "clang++";
    args = [
      "-std=c++17",
      "-fobjc-arc",
      "-shared",
      "-fPIC",
      "-O2",
      "-arch",
      arch === "x64" ? "x86_64" : arch,
      "-mmacosx-version-min=14.2",
      "-DNAPI_VERSION=8",
      "-DNODE_GYP_MODULE_NAME=nearlink",
      `-I${headers}`,
      "-undefined",
      "dynamic_lookup",
      "native/mac.mm",
      "-framework",
      "Foundation",
      "-framework",
      "ApplicationServices",
      "-framework",
      "CoreAudio",
      "-o",
      `${dir}/nearlink.node`,
    ];
  } else if (process.platform === "win32") {
    command = "cl";
    args = [
      "/nologo",
      "/std:c++17",
      "/EHsc",
      "/O2",
      "/LD",
      "/DNAPI_VERSION=8",
      "/DNODE_GYP_MODULE_NAME=nearlink",
      `/I${headers}`,
      "native/windows.cc",
      "/link",
      "user32.lib",
      "advapi32.lib",
      "bcrypt.lib",
      "shell32.lib",
      "ole32.lib",
      "wtsapi32.lib",
      `/OUT:${dir}/nearlink.node`,
    ];
  } else throw new Error("仅支持 Windows 和 macOS");
  const r = spawnSync(command, args, { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
  if (process.platform === "win32") {
    const capture = spawnSync(
      command,
      [
        ...args.slice(0, args.indexOf("native/windows.cc")),
        "native/dxgi-capture.cc",
        "/link",
        "d3d11.lib",
        "dxgi.lib",
        "gdi32.lib",
        "user32.lib",
        `/OUT:${dir}/nearlink-capture.node`,
      ],
      { stdio: "inherit" },
    );
    if (capture.status !== 0) process.exit(capture.status ?? 1);
  }
  if (process.platform === "darwin") {
    const s = spawnSync(
      "codesign",
      ["--force", "--sign", "-", `${dir}/nearlink.node`],
      { stdio: "inherit" },
    );
    if (s.status !== 0) process.exit(s.status ?? 1);
  }
}
