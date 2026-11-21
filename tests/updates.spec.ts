import { test, expect, _electron as electron } from "@playwright/test";
import { webcrypto, generateKeyPairSync, sign, createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import {
  X509CertificateGenerator,
  cryptoProvider,
  BasicConstraintsExtension,
  SubjectAlternativeNameExtension,
} from "@peculiar/x509";
test("应用内更新：HTTPS、签名拒绝、下载校验、取消与重试", async () => {
  test.setTimeout(60000);
  const data = await mkdtemp(path.join(process.cwd(), "work/update-e2e-"));
  cryptoProvider.set(webcrypto as unknown as Crypto);
  const tlsKeys = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const cert = await X509CertificateGenerator.createSelfSigned({
    name: "CN=localhost",
    serialNumber: "01",
    notBefore: new Date(Date.now() - 60000),
    notAfter: new Date(Date.now() + 86400000),
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    keys: tlsKeys as any,
    extensions: [
      new BasicConstraintsExtension(true, undefined, true),
      new SubjectAlternativeNameExtension([
        { type: "dns", value: "localhost" },
      ]),
    ],
  });
  const der = Buffer.from(
    await webcrypto.subtle.exportKey("pkcs8", tlsKeys.privateKey),
  );
  const key = `-----BEGIN PRIVATE KEY-----\n${der
    .toString("base64")
    .match(/.{1,64}/g)!
    .join("\n")}\n-----END PRIVATE KEY-----\n`;
  const publisher = generateKeyPairSync("ed25519");
  const publisherKey = publisher.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const fixture = Buffer.alloc(64 * 1024, 73);
  let mode = "invalid-signature",
    port = 0;
  const server = https.createServer(
    { key, cert: cert.toString("pem") },
    (req, res) => {
      if (req.url === "/manifest.json") {
        const payload = Buffer.from(
          JSON.stringify({
            version: "9.9.9",
            notes: "更新测试（隔离进程）",
            artifacts: {
              [`${process.platform}-${process.arch}`]: {
                url: `https://localhost:${port}/fixture.zip`,
                size: fixture.length,
                sha256: createHash("sha256").update(fixture).digest("hex"),
                format: "zip",
              },
            },
          }),
        );
        const signature =
          mode === "invalid-signature"
            ? Buffer.alloc(64)
            : sign(null, payload, publisher.privateKey);
        res.end(
          JSON.stringify({
            payload: payload.toString("base64"),
            signature: signature.toString("base64"),
          }),
        );
        return;
      }
      if (req.url === "/fixture.zip") {
        const bytes =
          mode === "corrupt-artifact" ? Buffer.alloc(fixture.length) : fixture;
        let offset = 0;
        const timer = setInterval(() => {
          if (offset >= bytes.length) {
            clearInterval(timer);
            res.end();
          } else {
            res.write(bytes.subarray(offset, offset + 2048));
            offset += 2048;
          }
        }, 10);
        res.on("close", () => clearInterval(timer));
        return;
      }
      res.writeHead(404);
      res.end();
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as import("node:net").AddressInfo).port;
  const app = await electron.launch({
    executablePath: process.env.NEARLINK_ELECTRON_EXECUTABLE,
    args: [process.cwd(), "--background"],
    env: { ...process.env, NEARLINK_USER_DATA: data },
    timeout: 30000,
  });
  const errors: string[] = [];
  app.on("window", (p) => p.on("pageerror", (e) => errors.push(e.message)));
  try {
    await app.evaluate(
      (_electron, p) => {
        // Test-only TLS CA and publisher key. Production accepts the shipped key
        // and normal certificate authorities, with no such override interface.
        (process.getBuiltinModule("node:https") as any).globalAgent.options.ca = p.cert;
        const fs = (process.getBuiltinModule("node:fs/promises") as any),
          original = fs.readFile;
        fs.readFile = (filename: any, ...args: any[]) =>
          /[\\/]update-public\.pem$/.test(String(filename))
            ? Promise.resolve(p.publisherKey)
            : original(filename, ...args);
      },
      { cert: cert.toString("pem"), publisherKey },
    );
    let page;
    for (let i = 0; i < 100; i++) {
      page = app.windows().find((p) => p.url().includes("window=home"));
      if (page) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(page).toBeTruthy();
    const home = page!;
    await home.getByRole("button", { name: "设置", exact: true }).click();
    await home.getByRole("button", { name: "更新源设置", exact: true }).click();
    await home
      .getByLabel("更新清单地址（HTTPS）")
      .fill(`https://localhost:${port}/manifest.json`);
    await home.getByRole("button", { name: "保存更新源", exact: true }).click();
    await home.getByRole("button", { name: "检查更新", exact: true }).click();
    await expect
      .poll(() =>
        home.evaluate(() =>
          window.nearlink.invoke("updates.state").then((s) => s.message),
        ),
      )
      .toContain("签名不匹配");
    mode = "corrupt-artifact";
    await home.getByRole("button", { name: "检查更新", exact: true }).click();
    await expect(
      home.getByRole("button", { name: "下载更新", exact: true }),
    ).toBeVisible();
    await home.getByRole("button", { name: "下载更新", exact: true }).click();
    await expect
      .poll(() =>
        home.evaluate(() =>
          window.nearlink.invoke("updates.state").then((s) => s.message),
        ),
      )
      .toContain("完整性校验失败");
    mode = "valid";
    await home.getByRole("button", { name: "下载更新", exact: true }).click();
    await home.getByRole("button", { name: "取消", exact: true }).click();
    await expect
      .poll(() =>
        home.evaluate(() =>
          window.nearlink.invoke("updates.state").then((s) => s.phase),
        ),
      )
      .toBe("available");
    await home.getByRole("button", { name: "下载更新", exact: true }).click();
    await expect(
      home.getByRole("button", { name: "安装并重新打开", exact: true }),
    ).toBeVisible();
    const actual = await readFile(
      path.join(data, "updates", `NearLink-9.9.9-${process.arch}.zip`),
    );
    expect(actual.equals(fixture)).toBe(true);
    await expect
      .poll(
        async () =>
          (await readdir(path.join(data, "updates"))).filter((n) =>
            n.endsWith(".part"),
          ).length,
      )
      .toBe(0);
    await home.screenshot({ path: "outputs/update-actual.png" });
    await writeFile(
      "outputs/update-validation.json",
      JSON.stringify(
        {
          at: new Date().toISOString(),
          status: "passed",
          checks: [
            "HTTPS with test-only trusted CA",
            "invalid publisher signature rejected",
            "corrupt download rejected",
            "cancel and retry",
            "verified complete bytes and no partial leftovers",
            "install button ready",
          ],
          installation:
            "not executed; fixture download only, Windows installer replacement requires real-machine validation",
          errors,
        },
        null,
        2,
      ),
    );
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
