import { app, safeStorage } from "electron";
import { webcrypto, createHash } from "node:crypto";
import { fingerprint } from "./identity-crypto";
export { fingerprint, prettyFingerprint } from "./identity-crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { X509CertificateGenerator, cryptoProvider } from "@peculiar/x509";
import type { Device } from "../src/shared/protocol";
export type Identity = {
  id: string;
  name: string;
  key: string;
  cert: string;
  fingerprint: string;
};
type State = {
  version: 1;
  identity: { cert: string; encryptedKey: string; name: string };
  trusted: Device[];
  allowRemote: boolean;
  verified120: string[];
};
export class IdentityStore {
  identity!: Identity;
  trusted = new Map<string, Device>();
  allowRemote = true;
  verified120 = new Set<string>();
  private state!: State;
  private write = Promise.resolve();
  get filename() {
    return path.join(app.getPath("userData"), "identity.json");
  }
  async load() {
    if (!(await safeStorage.isAsyncEncryptionAvailable()))
      throw new Error("系统安全存储不可用，无法安全保存设备身份。");
    try {
      this.state = JSON.parse(await readFile(this.filename, "utf8"));
      if (this.state.version !== 1) throw new Error("身份文件版本不受支持");
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
      cryptoProvider.set(webcrypto as unknown as Crypto);
      const keys = await webcrypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"],
      );
      const cert = await X509CertificateGenerator.createSelfSigned({
        serialNumber: createHash("sha256")
          .update(webcrypto.getRandomValues(new Uint8Array(32)))
          .digest("hex")
          .slice(0, 32),
        name: "CN=NearLink Device",
        notBefore: new Date(Date.now() - 86400000),
        notAfter: new Date(Date.now() + 10 * 365 * 86400000),
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        keys: keys as any,
      });
      const der = Buffer.from(
        await webcrypto.subtle.exportKey("pkcs8", keys.privateKey),
      );
      const pem = `-----BEGIN PRIVATE KEY-----\n${der
        .toString("base64")
        .match(/.{1,64}/g)!
        .join("\n")}\n-----END PRIVATE KEY-----\n`;
      this.state = {
        version: 1,
        identity: {
          cert: cert.toString("pem"),
          encryptedKey: (await safeStorage.encryptStringAsync(pem)).toString(
            "base64",
          ),
          name: os.hostname().replace(/\.local$/, ""),
        },
        trusted: [],
        allowRemote: true,
        verified120: [],
      };
    }
    const fp = fingerprint(this.state.identity.cert);
    this.identity = {
      id: fp,
      name: this.state.identity.name,
      key: (
        await safeStorage.decryptStringAsync(
          Buffer.from(this.state.identity.encryptedKey, "base64"),
        )
      ).result,
      cert: this.state.identity.cert,
      fingerprint: fp,
    };
    for (const d of this.state.trusted)
      this.trusted.set(d.id, { ...d, online: false, trusted: true });
    this.allowRemote = this.state.allowRemote;
    this.verified120 = new Set(this.state.verified120 ?? []);
    await this.save();
  }
  async save() {
    const state: State = {
      ...this.state,
      trusted: [...this.trusted.values()],
      allowRemote: this.allowRemote,
      verified120: [...this.verified120],
    };
    this.write = this.write
      .catch(() => {})
      .then(async () => {
        await mkdir(path.dirname(this.filename), { recursive: true });
        const tmp = this.filename + ".tmp";
        await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
        await rename(tmp, this.filename);
      });
    return this.write;
  }
  async trust(d: Device) {
    this.trusted.set(d.id, { ...d, trusted: true });
    await this.save();
  }
  async revoke(id: string) {
    this.trusted.delete(id);
    this.verified120.delete(id);
    await this.save();
  }
}
