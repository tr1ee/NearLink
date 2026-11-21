import { app, dialog } from "electron";
import { createHash } from "node:crypto";
import { updateDisk } from "./update-storage";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { IdentityStore } from "./identity";
import { fingerprint } from "./identity-crypto";

const run = promisify(execFile);
const { readdir, lstat, readFile, mkdir, writeFile } = updateDisk;
export async function prepareDesktopServiceInstall(
  store: IdentityStore,
  profile = app.getPath("userData"),
) {
  if (process.platform !== "win32") throw Error("仅支持 Windows");
  const host = fingerprint(store.identity.cert);
  if (host !== store.identity.fingerprint)
    throw Error("本机设备指纹与证书公钥不一致，已取消服务安装。");
  const peers = [...store.trusted.keys()];
  if (!peers.length) throw Error("请先核对指纹并配对需要无人值守的控制端。");
  if (peers.length > 16) throw Error("服务目前最多批准 16 台已配对设备。");
  const files: Array<{ source: string; target: string; sha256: string }> = [];
  const add = async (source: string, target: string) => {
    const info = await lstat(source);
    if (info.isSymbolicLink()) throw Error("安装来源包含链接");
    files.push({
      source,
      target,
      sha256: createHash("sha256")
        .update(await readFile(source))
        .digest("hex"),
    });
  };
  const walk = async (source: string, target: string) => {
    for (const item of await readdir(source, { withFileTypes: true })) {
      if (item.isSymbolicLink()) throw Error("安装来源包含链接");
      const input = path.join(source, item.name),
        output = path.join(target, item.name);
      if (item.isDirectory()) await walk(input, output);
      else if (item.isFile()) await add(input, output);
    }
  };
  const serviceImage = path
    .join(app.getAppPath(), "resources/NearLinkService.exe")
    .replace(/\.asar([\\/])/, ".asar.unpacked$1");
  const installer = path
    .join(app.getAppPath(), "resources/install-desktop-service.ps1")
    .replace(/\.asar([\\/])/, ".asar.unpacked$1");
  await add(serviceImage, "NearLinkService.exe");
  if (app.isPackaged) {
    await walk(path.dirname(process.execPath), "Client");
    const exe = files.find((f) => f.source === process.execPath);
    if (!exe) throw Error("找不到实际主程序");
    exe.target = "Client/electron.exe";
  } else {
    await walk(path.dirname(process.execPath), "Client");
    for (const folder of ["dist", "dist-electron", "resources"])
      await walk(path.join(app.getAppPath(), folder), `Client/app/${folder}`);
    for (const name of ["nearlink.node", "nearlink-capture.node"])
      await add(
        path.join(app.getAppPath(), "native/prebuilds/win32-x64", name),
        `Client/app/native/prebuilds/win32-x64/${name}`,
      );
    await add(
      path.join(app.getAppPath(), "package.json"),
      "Client/app/package.json",
    );
  }
  const who = await run(
    path.join(process.env.SystemRoot || "C:\\Windows", "System32/whoami.exe"),
    ["/user", "/fo", "csv", "/nh"],
    { windowsHide: true },
  );
  const userSid = /S-1-5-[0-9-]+/.exec(who.stdout)?.[0];
  if (!userSid) throw Error("无法核对本机用户");
  const directory = path.join(profile, "service-install");
  await mkdir(directory, { recursive: true });
  const request = path.join(directory, "request.json");
  const bytes = Buffer.from(
    JSON.stringify({
      version: 1,
      userSid,
      host,
      peers,
      profile,
      files,
    }),
  );
  await writeFile(request, bytes);
  return {
    installer,
    request,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
}
export async function installDesktopService(store: IdentityStore) {
  const plan = await prepareDesktopServiceInstall(store);
  const shell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  );
  await run(
    shell,
    [
      "-NoProfile",
      "-File",
      plan.installer,
      "-Request",
      plan.request,
      "-RequestSha256",
      plan.digest,
    ],
    { windowsHide: true, maxBuffer: 1024 * 1024 },
  );
  await dialog.showMessageBox({
    type: "info",
    title: "NearLink",
    message: "无人值守服务已安装",
    detail:
      "请完全退出本实例。服务会自动以普通权限启动已保护的 NearLink，之后已批准设备重连无需再次本机确认。",
  });
}
