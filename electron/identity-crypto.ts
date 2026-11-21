import { X509Certificate, createHash } from "node:crypto";
export function fingerprint(raw: Buffer | string) {
  const cert = new X509Certificate(raw);
  return createHash("sha256")
    .update(cert.publicKey.export({ format: "der", type: "spki" }))
    .digest("hex");
}
export function prettyFingerprint(value: string) {
  return (
    value
      .toUpperCase()
      .match(/.{1,4}/g)
      ?.join(" ") ?? value
  );
}
