import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
if (process.platform !== "win32" || process.arch !== "x64")
  throw Error("Temporary input helper requires Windows x64 MSVC.");
mkdirSync("native/prebuilds/win32-x64", { recursive: true });
mkdirSync("work/input-helper-build", { recursive: true });
const result = spawnSync(
  "cl",
  [
    "/nologo",
    "/std:c++17",
    "/EHsc",
    "/O2",
    "/MT",
    "/utf-8",
    "/DUNICODE",
    "/D_UNICODE",
    "native/windows-input-helper.cc",
    "/Fowork/input-helper-build/helper.obj",
    "/link",
    "/SUBSYSTEM:WINDOWS",
    "/DYNAMICBASE",
    "/NXCOMPAT",
    "/DEPENDENTLOADFLAG:0x800",
    "/MANIFESTUAC:level='requireAdministrator' uiAccess='false'",
    "user32.lib",
    "advapi32.lib",
    "bcrypt.lib",
    "shell32.lib",
    "ole32.lib",
    "wtsapi32.lib",
    "/OUT:native/prebuilds/win32-x64/NearLinkInput.exe",
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
