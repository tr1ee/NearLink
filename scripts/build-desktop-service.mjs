import { spawnSync } from "node:child_process";
import { mkdirSync, copyFileSync } from "node:fs";
if (process.platform !== "win32" || process.arch !== "x64")
  throw Error("Windows x64 MSVC is required.");
mkdirSync("work/service-build", { recursive: true });
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
    "native/windows-desktop-service.cc",
    "/Fowork/service-build/service.obj",
    "/link",
    "/SUBSYSTEM:WINDOWS",
    "/DYNAMICBASE",
    "/NXCOMPAT",
    "/DEPENDENTLOADFLAG:0x800",
    "/MANIFESTUAC:level='asInvoker' uiAccess='false'",
    "user32.lib",
    "gdi32.lib",
    "advapi32.lib",
    "bcrypt.lib",
    "crypt32.lib",
    "shell32.lib",
    "ole32.lib",
    "wtsapi32.lib",
    "userenv.lib",
    "/OUT:work/service-build/NearLinkService.exe",
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status === 0)
  copyFileSync(
    "work/service-build/NearLinkService.exe",
    "resources/NearLinkService.exe",
  );
process.exit(result.status ?? 1);
