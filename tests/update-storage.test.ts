import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  access,
  rm,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createUpdateStage,
  pruneUpdateCache,
} from "../electron/update-storage";

test("每次更新使用独立解包目录，失败遗留不阻塞下一次准备", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nearlink-update-stage-"));
  try {
    const first = await createUpdateStage(root),
      next = await createUpdateStage(root);
    assert.notEqual(first, next);
    await writeFile(path.join(first, "partial"), "old");
    await access(next);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("启动成功只清理本更新目录内当前及旧版缓存，保留新版下载、配置、日志和外部文件", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nearlink-update-cache-"));
  try {
    for (const name of [
      "NearLink-0.1.2-x64.exe",
      "NearLink-0.1.5-arm64.zip",
      "NearLink-0.1.3-x64.exe.part",
      "NearLink-0.1.3-x64.exe.11111111-1111-1111-1111-111111111111.part",
      "NearLink-0.1.6-x64.exe",
      "NearLink-0.1.6-x64.exe.part",
      "config.json",
      "install.log",
      "install-result.json",
      "user-file.exe",
    ])
      await writeFile(path.join(root, name), name);
    await mkdir(path.join(root, "unpacked/NearLink.app/Contents/Resources"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, "unpacked/NearLink.app/Contents/Resources/app.asar"),
      "archive",
    );
    const outside = path.join(root, "keep-outside");
    await writeFile(outside, "keep");
    await symlink(outside, path.join(root, "NearLink-0.1.1-arm64.zip"));
    const report = await pruneUpdateCache(root, "0.1.5");
    assert.equal(report.failures.length, 0);
    for (const name of [
      "NearLink-0.1.2-x64.exe",
      "NearLink-0.1.5-arm64.zip",
      "NearLink-0.1.3-x64.exe.part",
      "NearLink-0.1.3-x64.exe.11111111-1111-1111-1111-111111111111.part",
      "unpacked",
    ])
      await assert.rejects(access(path.join(root, name)), { code: "ENOENT" });
    for (const name of [
      "NearLink-0.1.6-x64.exe",
      "NearLink-0.1.6-x64.exe.part",
      "config.json",
      "install.log",
      "install-result.json",
      "user-file.exe",
      "keep-outside",
      "NearLink-0.1.1-arm64.zip",
    ])
      await access(path.join(root, name));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("尚未完成的新版本安装保留解包现场，清理可重复执行", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "nearlink-update-pending-"),
  );
  try {
    const stage = await createUpdateStage(root);
    await pruneUpdateCache(root, "0.1.5", false);
    await access(stage);
    await pruneUpdateCache(root, "0.1.5");
    await assert.rejects(access(stage), { code: "ENOENT" });
    assert.deepEqual((await pruneUpdateCache(root, "0.1.5")).failures, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("更新启动器只在对应版本成功运行后清理，不删除未来版本或无法确认归属的 exe", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "nearlink-launcher-cache-"),
  );
  try {
    const names = [];
    for (let i = 0; i < 4; i++) {
      const token = String(i).repeat(8) + "-1111-1111-1111-111111111111";
      names.push(`launcher-${token}.exe`);
      await writeFile(path.join(root, names[i]), "fixture");
      if (i < 3)
        await writeFile(
          path.join(root, `request-${token}.json`),
          JSON.stringify({
            token: i === 2 ? "wrong" : token,
            version: i === 1 ? "0.1.9" : "0.1.6",
          }),
        );
    }
    await pruneUpdateCache(root, "0.1.6");
    await assert.rejects(access(path.join(root, names[0])), { code: "ENOENT" });
    for (const name of names.slice(1)) await access(path.join(root, name));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
