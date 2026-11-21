import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  verifiedRelease,
  verifyArtifact,
  compareVersions,
  updateUrl,
} from "../electron/update-core";
test("更新清单必须由固定发布密钥签名，篡改或换钥立即拒绝", () => {
  const pair = generateKeyPairSync("ed25519");
  const key = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const payload = Buffer.from(
    JSON.stringify({
      version: "0.1.2",
      notes: "修复",
      artifacts: {
        "win32-x64": {
          url: "https://github.com/tr1ee/NearLink/releases/download/v0.1.2/NearLink.exe",
          sha256: "a".repeat(64),
          size: 123,
          format: "nsis",
        },
      },
    }),
  );
  const envelope = {
    payload: payload.toString("base64"),
    signature: sign(null, payload, pair.privateKey).toString("base64"),
  };
  assert.equal(
    verifiedRelease(Buffer.from(JSON.stringify(envelope)), key).version,
    "0.1.2",
  );
  const changed = Buffer.from(payload);
  changed[2] ^= 1;
  assert.throws(
    () =>
      verifiedRelease(
        Buffer.from(
          JSON.stringify({ ...envelope, payload: changed.toString("base64") }),
        ),
        key,
      ),
    /签名/,
  );
  const other = generateKeyPairSync("ed25519")
    .publicKey.export({ type: "spki", format: "pem" })
    .toString();
  assert.throws(
    () => verifiedRelease(Buffer.from(JSON.stringify(envelope)), other),
    /签名/,
  );
});
test("更新拒绝HTTP/文件协议与明文凭据，版本比较拒绝降级和非规范版本", () => {
  for (const url of [
    "http://example.com/update",
    "file:///tmp/update",
    "https://user:password@example.com/update",
  ])
    assert.throws(() => updateUrl(url));
  assert.equal(compareVersions("0.1.10", "0.1.2"), 1);
  assert.equal(compareVersions("0.1.0", "0.1.1"), -1);
  assert.equal(compareVersions("0.1.1", "0.1.1"), 0);
  assert.throws(() => compareVersions("latest", "0.1.1"));
});
test("更新包必须同时匹配签名清单中的长度和SHA-256", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nearlink-update-"));
  try {
    const bytes = Buffer.from("installer fixture"),
      file = path.join(dir, "update.zip");
    await writeFile(file, bytes);
    const artifact = {
      url: "https://example.com/update.zip",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      format: "zip" as const,
    };
    await verifyArtifact(file, artifact);
    await assert.rejects(
      verifyArtifact(file, { ...artifact, size: bytes.length + 1 }),
      /完整性/,
    );
    await writeFile(file, Buffer.alloc(bytes.length));
    await assert.rejects(verifyArtifact(file, artifact), /完整性/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
