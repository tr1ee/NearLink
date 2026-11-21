import https from "node:https";
import { createHash, verify, randomUUID } from "node:crypto";
import { createWriteStream, createReadStream } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";

export function updateUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("更新下载必须使用不含账号密码的 HTTPS 地址");
  return url;
}
export function compareVersions(a: string, b: string) {
  const parse = (v: string) => {
    if (!/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(v))
      throw new Error("版本号格式无效");
    return v.split(".").map(Number);
  };
  const x = parse(a),
    y = parse(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return Math.sign(x[i] - y[i]);
  return 0;
}
const artifactSchema = z.object({
  url: z.string().max(4096),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z
    .number()
    .int()
    .positive()
    .max(2 * 1024 ** 3),
  format: z.enum(["zip", "nsis"]),
});
export const releaseSchema = z.object({
  version: z.string().max(32),
  notes: z.string().max(16000),
  artifacts: z.record(z.string(), artifactSchema),
});
export type UpdateArtifact = z.infer<typeof artifactSchema>;
export type UpdateRelease = z.infer<typeof releaseSchema>;
export function verifiedRelease(
  bytes: Buffer,
  publicKey: string,
): UpdateRelease {
  if (bytes.length > 512 * 1024) throw new Error("更新清单过大");
  const envelope = z
    .object({ payload: z.string().max(680000), signature: z.string().max(128) })
    .parse(JSON.parse(bytes.toString("utf8")));
  const payload = Buffer.from(envelope.payload, "base64");
  if (
    !verify(null, payload, publicKey, Buffer.from(envelope.signature, "base64"))
  )
    throw new Error("更新签名不匹配，已拒绝更新");
  const release = releaseSchema.parse(JSON.parse(payload.toString("utf8")));
  compareVersions(release.version, "0.0.0");
  for (const artifact of Object.values(release.artifacts))
    updateUrl(artifact.url);
  return release;
}
async function response(
  url: string,
  signal: AbortSignal,
  redirects = 0,
): Promise<import("node:http").IncomingMessage> {
  if (redirects > 5) throw new Error("更新下载重定向过多");
  const res = await new Promise<import("node:http").IncomingMessage>(
    (resolve, reject) => {
      const req = https.get(
        updateUrl(url),
        {
          signal,
          headers: {
            "User-Agent": "NearLink-Updater",
            Accept: "application/octet-stream, application/json",
          },
        },
        resolve,
      );
      req.setTimeout(20000, () => req.destroy(new Error("更新服务器响应超时")));
      req.on("error", reject);
    },
  );
  if (
    [301, 302, 303, 307, 308].includes(res.statusCode ?? 0) &&
    res.headers.location
  ) {
    res.resume();
    return response(
      new URL(res.headers.location, url).toString(),
      signal,
      redirects + 1,
    );
  }
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`更新服务器返回 HTTP ${res.statusCode}`);
  }
  return res;
}
export async function fetchManifest(url: string, signal: AbortSignal) {
  const res = await response(url, signal);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const bytes of res) {
    size += bytes.length;
    if (size > 512 * 1024) {
      res.destroy();
      throw new Error("更新清单过大");
    }
    chunks.push(Buffer.from(bytes));
  }
  return Buffer.concat(chunks);
}
export async function verifyArtifact(
  filename: string,
  artifact: UpdateArtifact,
) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const bytes of createReadStream(filename)) {
    hash.update(bytes);
    size += bytes.length;
  }
  if (size !== artifact.size || hash.digest("hex") !== artifact.sha256)
    throw new Error("安装包完整性校验失败");
}
export async function downloadArtifact(
  artifact: UpdateArtifact,
  filename: string,
  signal: AbortSignal,
  onProgress: (n: number) => void,
  rate: () => number = () => Infinity,
) {
  const partial = filename + "." + randomUUID() + ".part";
  try {
    const res = await response(artifact.url, signal);
    let bytes = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > artifact.size)
          return callback(new Error("安装包超过清单声明的大小"));
        onProgress(bytes);
        const delay = Number.isFinite(rate())
          ? (chunk.length / Math.max(1, rate())) * 1000
          : 0;
        if (delay > 1) setTimeout(() => callback(null, chunk), delay);
        else callback(null, chunk);
      },
    });
    await pipeline(res, meter, createWriteStream(partial, { mode: 0o600 }), {
      signal,
    });
    await verifyArtifact(partial, artifact);
    signal.throwIfAborted();
    await rename(partial, filename);
  } finally {
    await unlink(partial).catch(() => {});
  }
}
