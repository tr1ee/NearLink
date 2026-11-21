import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto, createPrivateKey, createHash, verify } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { X509CertificateGenerator, cryptoProvider } from "@peculiar/x509";
import { desktopServiceProof } from "../electron/service-proof";
import { fingerprint } from "../electron/identity-crypto";
import type { Identity } from "../electron/identity";
import type { SessionInfo } from "../src/shared/protocol";

test("服务证明绑定实际控制端会话、主机及权限，输出 Windows 可验证的 P-256 签名", async () => {
  cryptoProvider.set(webcrypto as unknown as Crypto);
  const keys = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const certificate = await X509CertificateGenerator.createSelfSigned({
    name: "CN=NearLink Service Test",
    serialNumber: "01",
    notBefore: new Date(Date.now() - 1000),
    notAfter: new Date(Date.now() + 86400000),
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    keys: keys as any,
  });
  const cert = certificate.toString("pem");
  const key = createPrivateKey({
    key: Buffer.from(
      await webcrypto.subtle.exportKey("pkcs8", keys.privateKey),
    ),
    format: "der",
    type: "pkcs8",
  })
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  const fp = fingerprint(cert);
  assert.notEqual(
    fp,
    createHash("sha256").update(Buffer.from(certificate.rawData)).digest("hex"),
    "设备指纹必须使用既有 SPKI 定义，不能误用整张证书摘要",
  );
  const identity = {
    id: fp,
    fingerprint: fp,
    key,
    cert,
    name: "synthetic",
  } satisfies Identity;
  const host = "a".repeat(64),
    sessionId = "11111111-1111-4111-8111-111111111111",
    connection = "22222222-2222-4222-8222-222222222222";
  const challenge = `NearLink desktop service v1\n${host}\n${sessionId}:${fp}:${connection}\n1\n${"b".repeat(64)}\ncontrol\n`;
  const session = {
    id: sessionId,
    peerId: host,
    role: "controller",
    state: "connected",
    viewOnly: false,
  } as SessionInfo;
  const result = desktopServiceProof(identity, host, session, challenge);
  assert.equal(result.proof.length, 128);
  assert(
    verify(
      "sha256",
      Buffer.from(challenge),
      { key: cert, dsaEncoding: "ieee-p1363" },
      Buffer.from(result.proof, "hex"),
    ),
  );
  for (const [id, s, text] of [
    ["c".repeat(64), session, challenge],
    [host, null, challenge],
    [host, { ...session, role: "host" }, challenge],
    [host, { ...session, state: "reconnecting" }, challenge],
    [host, { ...session, viewOnly: true }, challenge],
    [host, session, challenge.replace(fp, "d".repeat(64))],
    [host, session, challenge + "extra"],
  ] as const)
    assert.throws(() =>
      desktopServiceProof(identity, id, s as SessionInfo, text),
    );
  assert(
    desktopServiceProof(
      identity,
      host,
      { ...session, viewOnly: true },
      challenge.replace("control\n", "view\n"),
    ),
  );
  await mkdir("work", { recursive: true });
  await writeFile(
    "work/service-proof-fixture.txt",
    `${result.certificate}\n${result.proof}\n${fp}\n${challenge}`,
  );
});
