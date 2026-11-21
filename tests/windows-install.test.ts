import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  prepareWindowsRequest,
  launchWindowsHelper,
  acknowledgeWindowsStartup,
} from "../electron/windows-install";
import { QuitIntent } from "../electron/window-lifecycle";
async function fixture(script: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nearlink-helper-"));
  const { request, file } = await prepareWindowsRequest(dir, {
    version: "0.1.3",
    installer: path.join(dir, "下载 & installer.exe"),
    sha256: "0".repeat(64),
    size: 3,
    parentPid: process.pid,
    installDirectory: "C:\\Users\\Test User\\NearLink",
  });
  const helper = path.join(dir, "helper.cjs");
  await writeFile(helper, script);
  return {
    dir,
    request,
    file,
    helper,
    run: () =>
      launchWindowsHelper({
        command: process.execPath,
        args: [helper, file],
        directory: dir,
        request,
        timeoutMs: 500,
      }),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
test("安装辅助进程确认令牌和就绪后才允许软件退出，支持空格与中文请求路径", async () => {
  const f = await fixture(
    "const fs=require('fs');const r=JSON.parse(fs.readFileSync(process.argv[2]));fs.writeFileSync(r.statusFile,JSON.stringify({token:r.token,stage:'ready'}));setTimeout(()=>process.exit(),150);",
  );
  try {
    await f.run();
    assert.equal(
      JSON.parse(await readFile(f.file, "utf8")).installDirectory,
      "C:\\Users\\Test User\\NearLink",
    );
  } finally {
    await new Promise((r) => setTimeout(r, 200));
    await f.cleanup();
  }
});
test("辅助进程启动或脚本解析失败保留错误输出，不把spawn当成安装就绪", async () => {
  const f = await fixture(
    "console.error('fixture script parse/start error');process.exit(1);",
  );
  try {
    await assert.rejects(f.run(), /fixture script parse\/start error/);
    assert.match(
      await readFile(path.join(f.dir, "install-startup.log"), "utf8"),
      /parse\/start/,
    );
  } finally {
    await f.cleanup();
  }
});
test("拒绝旧令牌就绪文件及预检失败，不允许应用退出", async () => {
  const f = await fixture(
    "const fs=require('fs');const r=JSON.parse(fs.readFileSync(process.argv[2]));fs.writeFileSync(r.statusFile,JSON.stringify({token:'stale',stage:'ready'}));process.exit(1);",
  );
  try {
    await assert.rejects(f.run(), /未就绪/);
    await writeFile(
      f.helper,
      "const fs=require('fs');const r=JSON.parse(fs.readFileSync(process.argv[2]));fs.writeFileSync(r.statusFile,JSON.stringify({token:r.token,stage:'failed',message:'integrity check failed'}));process.exit(1);",
    );
    await assert.rejects(f.run(), /integrity check failed/);
  } finally {
    await f.cleanup();
  }
});
test("辅助进程未确认就绪时限时终止，软件保持运行", async () => {
  const f = await fixture("setInterval(()=>{},1000);");
  try {
    await assert.rejects(f.run(), /启动超时/);
  } finally {
    await f.cleanup();
  }
});
test("Windows关闭或未授权quit只转后台，托盘退出/更新/系统退出仍可结束进程", () => {
  const intent = new QuitIntent();
  assert.equal(intent.shouldKeepRunning("win32", true), true);
  assert.equal(intent.shouldKeepRunning("darwin", true), false);
  assert.equal(intent.shouldKeepRunning("win32", false), false);
  intent.request();
  assert.equal(intent.shouldKeepRunning("win32", true), false);
});

test("只有目标路径中的正确版本成功启动才确认升级完成", async () => {
  const f = await fixture("process.exit(1)");
  const pending = path.join(f.dir, "windows-pending.json");
  try {
    await writeFile(
      pending,
      JSON.stringify({
        version: f.request.version,
        token: f.request.token,
        startupFile: f.request.startupFile,
        executable: "C:\\Apps\\NearLink.exe",
      }),
    );
    assert.equal(
      await acknowledgeWindowsStartup(
        f.dir,
        "0.1.1",
        "C:\\Apps\\NearLink.exe",
        true,
      ),
      false,
    );
    assert.equal(
      await acknowledgeWindowsStartup(
        f.dir,
        "0.1.3",
        "C:\\Other\\NearLink.exe",
        true,
      ),
      false,
    );
    assert.equal(
      await acknowledgeWindowsStartup(
        f.dir,
        "0.1.3",
        "C:\\Apps\\NearLink.exe",
        true,
      ),
      true,
    );
    assert.deepEqual(
      JSON.parse(await readFile(f.request.startupFile, "utf8")),
      { token: f.request.token, version: "0.1.3" },
    );
  } finally {
    await f.cleanup();
  }
});
