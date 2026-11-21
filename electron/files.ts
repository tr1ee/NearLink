import fs, { createReadStream, createWriteStream } from "node:fs";
import {
  stat,
  lstat,
  readdir,
  mkdir,
  open,
  unlink,
  link,
  copyFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import https from "node:https";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { z } from "zod";
import type { PeerNetwork } from "./network";
import type {
  Listing,
  TransferTask,
  FileLocation,
} from "../src/shared/protocol";
const pathSchema = z
  .string()
  .max(4096)
  .refine((v) => !v.includes("\0"), "路径包含无效字符");
export function safeName(name: string, platform = process.platform) {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    /[\x00-\x1f]/.test(name)
  )
    throw new Error("文件名不合法");
  if (
    platform === "win32" &&
    (/[<>:"|?*]/.test(name) ||
      /[. ]$/.test(name) ||
      /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name))
  )
    throw new Error(`Windows 不支持此文件名：${name}`);
  return name;
}
export async function listing(input: string): Promise<Listing> {
  pathSchema.parse(input);
  const directory = path.resolve(input || os.homedir());
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const e of entries) {
    if (
      e.name.startsWith(".nearlink-") ||
      e.isSymbolicLink() ||
      (!e.isFile() && !e.isDirectory())
    )
      continue;
    try {
      const p = path.join(directory, e.name),
        s = await stat(p);
      result.push({
        name: e.name,
        path: p,
        directory: e.isDirectory(),
        size: s.size,
        modified: s.mtimeMs,
      });
    } catch {}
  }
  result.sort(
    (a, b) =>
      Number(b.directory) - Number(a.directory) ||
      a.name.localeCompare(b.name, "zh-CN"),
  );
  return { path: directory, parent: path.dirname(directory), entries: result };
}
export async function fileLocations(
  known: Record<string, string> = {},
): Promise<FileLocation[]> {
  const home = os.homedir();
  const candidates: FileLocation[] = [
    { name: "个人文件夹", path: home, kind: "folder" },
    {
      name: "桌面",
      path: known.desktop ?? path.join(home, "Desktop"),
      kind: "folder",
    },
    {
      name: "文稿",
      path: known.documents ?? path.join(home, "Documents"),
      kind: "folder",
    },
    {
      name: "下载",
      path: known.downloads ?? path.join(home, "Downloads"),
      kind: "folder",
    },
  ];
  if (process.platform === "win32") {
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ")
      candidates.push({
        name: `${letter}: 本地磁盘`,
        path: `${letter}:\\`,
        kind: "disk",
      });
  } else {
    candidates.push({ name: "系统磁盘", path: "/", kind: "disk" });
    try {
      for (const volume of await readdir("/Volumes"))
        candidates.push({
          name: volume,
          path: path.join("/Volumes", volume),
          kind: "disk",
        });
    } catch {}
  }
  const available = await Promise.all(
    candidates.map(async (location) => {
      try {
        return (await stat(location.path)).isDirectory() ? location : null;
      } catch {
        return null;
      }
    }),
  );
  return available.filter((p): p is FileLocation => !!p);
}
export async function digestFile(filename: string) {
  const s = await lstat(filename);
  if (!s.isFile() || s.isSymbolicLink()) throw new Error("仅支持普通文件");
  const h = createHash("sha256");
  for await (const b of createReadStream(filename)) h.update(b);
  return { size: s.size, hash: h.digest("hex") };
}
export async function finalizeFile(
  temp: string,
  directory: string,
  name: string,
) {
  safeName(name);
  const ext = path.extname(name),
    base = name.slice(0, name.length - ext.length);
  for (let i = 0; i < 10000; i++) {
    const target = path.join(directory, i ? `${base} (${i})${ext}` : name);
    try {
      try {
        await link(temp, target);
      } catch (e: any) {
        if (["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV"].includes(e.code))
          await copyFile(temp, target, fs.constants.COPYFILE_EXCL);
        else throw e;
      }
      await unlink(temp);
      return target;
    } catch (e: any) {
      if (e.code === "EEXIST") continue;
      throw e;
    }
  }
  throw new Error("同名文件过多，请更换接收目录");
}
export class FileService extends EventEmitter {
  tasks: TransferTask[] = [];
  private aborts = new Map<string, AbortController>();
  private tail = Promise.resolve();
  rate = 8 * 1024 * 1024;
  constructor(
    private network: PeerNetwork,
    private knownPaths: Record<string, string> = {},
  ) {
    super();
  }
  locations() {
    return fileLocations(this.knownPaths);
  }
  async rpc(method: string, args: any) {
    if (method === "files.locations") return this.locations();
    if (method === "files.list")
      return listing(pathSchema.parse(args.path ?? ""));
    if (method === "files.info") {
      const filename = pathSchema.parse(args.path);
      return { ...(await digestFile(filename)), name: path.basename(filename) };
    }
    if (method === "files.manifest") {
      const filename = pathSchema.parse(args.path);
      const entries = await this.manifest(filename);
      return {
        name: path.basename(filename),
        directory: (await lstat(filename)).isDirectory(),
        entries,
      };
    }
    if (method === "files.mkdir") {
      const a = z
        .object({
          directory: pathSchema,
          name: z.string().max(255),
          unique: z.boolean().optional(),
        })
        .parse(args);
      safeName(a.name);
      if (a.unique) {
        for (let i = 0; i < 10000; i++) {
          const target = path.join(
            a.directory,
            i ? `${a.name} (${i})` : a.name,
          );
          try {
            await mkdir(target);
            return target;
          } catch (e: any) {
            if (e.code !== "EEXIST") throw e;
          }
        }
        throw new Error("同名目录过多");
      }
      const target = path.join(a.directory, a.name);
      await mkdir(target, { recursive: true });
      return target;
    }
    throw new Error("未知文件操作");
  }
  async manifest(
    source: string,
    relative = "",
  ): Promise<{ relative: string; directory: boolean; size: number }[]> {
    const s = await lstat(source);
    if (s.isSymbolicLink()) throw new Error("为避免越界复制，不传输符号链接");
    if (s.isFile()) return [{ relative, directory: false, size: s.size }];
    if (!s.isDirectory()) throw new Error("不支持此文件类型");
    const rows = [{ relative, directory: true, size: 0 }];
    for (const e of await readdir(source)) {
      if (e.startsWith(".nearlink-")) continue;
      const p = path.join(source, e);
      if ((await lstat(p)).isSymbolicLink()) continue;
      rows.push(...(await this.manifest(p, relative ? relative + "/" + e : e)));
      if (rows.length > 100000) throw new Error("文件夹条目过多，请分批传输");
    }
    return rows;
  }
  async serve(
    _peer: string,
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) {
    const url = new URL(req.url ?? "/", "https://nearlink.local");
    if (url.pathname !== "/file") {
      res.writeHead(404).end();
      return;
    }
    if (req.method === "GET") {
      const filename = pathSchema.parse(url.searchParams.get("path"));
      const s = await lstat(filename);
      if (!s.isFile() || s.isSymbolicLink()) throw new Error("文件不可读取");
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": s.size,
      });
      const limiter = this.limiter();
      await pipeline(createReadStream(filename), limiter, res);
      return;
    }
    if (req.method === "POST") {
      const directory = pathSchema.parse(url.searchParams.get("directory")),
        name = safeName(String(url.searchParams.get("name") ?? ""));
      const length = Number(req.headers["content-length"]);
      const expected = String(req.headers["x-content-sha256"] ?? "");
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        !/^[a-f0-9]{64}$/.test(expected)
      )
        throw new Error("文件长度或校验值无效");
      if (!(await stat(directory)).isDirectory())
        throw new Error("接收位置不是目录");
      const temp = path.join(directory, `.nearlink-${randomUUID()}.part`);
      const h = createHash("sha256");
      let bytes = 0;
      const counter = new Transform({
        transform(b, _enc, cb) {
          bytes += b.length;
          if (bytes > length) {
            cb(new Error("文件长度不匹配"));
            return;
          }
          h.update(b);
          cb(null, b);
        },
      });
      try {
        await pipeline(
          req,
          counter,
          createWriteStream(temp, { flags: "wx", mode: 0o600 }),
        );
        if (bytes !== length || h.digest("hex") !== expected)
          throw new Error("文件校验失败，请重试");
        const destination = await finalizeFile(temp, directory, name);
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ path: destination, size: bytes }));
      } catch (e) {
        await unlink(temp).catch(() => {});
        throw e;
      }
      return;
    }
    res.writeHead(405).end();
  }
  limiter(progress?: (n: number) => void) {
    let next = Date.now();
    const service = this;
    return new Transform({
      highWaterMark: 128 * 1024,
      transform(chunk, _encoding, cb) {
        const now = Date.now(),
          wait = Math.max(0, next - now);
        next =
          Math.max(now, next) +
          (chunk.length / Math.max(64 * 1024, service.rate)) * 1000;
        setTimeout(
          () => {
            progress?.(chunk.length);
            cb(null, chunk);
          },
          Math.min(wait, 2000),
        );
      },
    });
  }
  queue(
    peerId: string,
    direction: "upload" | "download",
    source: string,
    destination: string,
  ) {
    pathSchema.parse(source);
    pathSchema.parse(destination);
    if (
      this.tasks.filter((t) => t.state === "queued" || t.state === "running")
        .length >= 100
    )
      throw new Error("传输队列已满");
    const t: TransferTask = {
      id: randomUUID(),
      peerId,
      direction,
      name: source.split(/[\\/]/).pop() || "文件",
      source,
      destination,
      size: 0,
      done: 0,
      state: "queued",
      startedAt: Date.now(),
    };
    this.tasks.push(t);
    this.emit("changed");
    this.tail = this.tail.catch(() => {}).then(() => this.run(t));
    return t.id;
  }
  cancel(id: string) {
    const t = this.tasks.find((t) => t.id === id);
    if (t && ["queued", "running"].includes(t.state)) {
      t.state = "cancelled";
      this.aborts.get(id)?.abort();
      this.emit("changed");
    }
  }
  retry(id: string) {
    const t = this.tasks.find((t) => t.id === id);
    if (!t || !["failed", "cancelled"].includes(t.state))
      throw new Error("此任务无需重试");
    return this.queue(t.peerId, t.direction, t.source, t.destination);
  }
  private async run(t: TransferTask) {
    if (t.state === "cancelled") return;
    const abort = new AbortController();
    this.aborts.set(t.id, abort);
    t.state = "running";
    let emitAt = 0;
    const progress = (n: number) => {
      t.done += n;
      if (Date.now() - emitAt > 120) {
        emitAt = Date.now();
        this.emit("changed");
      }
    };
    try {
      await this.network.ensure(t.peerId);
      if (t.direction === "upload")
        await this.uploadTree(t, abort.signal, progress);
      else await this.downloadTree(t, abort.signal, progress);
      if ((t.state as string) !== "cancelled") t.state = "completed";
    } catch (e: any) {
      if ((t.state as string) !== "cancelled") {
        t.state = "failed";
        t.error = String(e.message ?? e).slice(0, 300);
      }
    } finally {
      this.aborts.delete(t.id);
      this.emit("changed");
    }
  }
  private async uploadTree(
    t: TransferTask,
    signal: AbortSignal,
    progress: (n: number) => void,
  ) {
    const manifest = await this.manifest(t.source);
    t.size = manifest.reduce((s, e) => s + e.size, 0);
    let root = t.destination;
    if (manifest[0].directory)
      root = await this.network.rpc(t.peerId, "files.mkdir", {
        directory: root,
        name: t.name,
        unique: true,
      });
    const dirs = new Map([["", root]]);
    for (const e of manifest) {
      signal.throwIfAborted();
      if (e.directory) {
        if (e.relative) {
          const parts = e.relative.split("/"),
            name = parts.pop()!,
            parent = parts.join("/");
          dirs.set(
            e.relative,
            await this.network.rpc(t.peerId, "files.mkdir", {
              directory: dirs.get(parent),
              name,
            }),
          );
        }
        continue;
      }
      const parts = e.relative.split("/"),
        name = e.relative ? parts.pop()! : t.name;
      const directory = dirs.get(e.relative ? parts.join("/") : "")!;
      const file = e.relative
        ? path.join(t.source, ...e.relative.split("/"))
        : t.source;
      await this.upload(t.peerId, file, directory, name, signal, progress);
    }
  }
  private async downloadTree(
    t: TransferTask,
    signal: AbortSignal,
    progress: (n: number) => void,
  ) {
    const m = await this.network.rpc(t.peerId, "files.manifest", {
      path: t.source,
    });
    const schema = z.object({
      name: z.string(),
      directory: z.boolean(),
      entries: z
        .array(
          z.object({
            relative: z.string().max(4096),
            directory: z.boolean(),
            size: z.number().nonnegative(),
          }),
        )
        .max(100000),
    });
    const manifest = schema.parse(m);
    t.size = manifest.entries.reduce((s, e) => s + e.size, 0);
    let root = t.destination;
    if (manifest.directory) {
      safeName(manifest.name);
      root = path.join(root, manifest.name);
      try {
        await mkdir(root);
      } catch (e: any) {
        if (e.code !== "EEXIST") throw e;
        let i = 1;
        while (true) {
          try {
            root = path.join(t.destination, `${manifest.name} (${i++})`);
            await mkdir(root);
            break;
          } catch (e: any) {
            if (e.code !== "EEXIST") throw e;
          }
        }
      }
    }
    const remotePlatform = this.network.devices.get(t.peerId)?.platform;
    const remotePath = remotePlatform === "win32" ? path.win32 : path.posix;
    for (const e of manifest.entries) {
      signal.throwIfAborted();
      const parts = e.relative
        ? e.relative.split("/").map((n) => safeName(n))
        : [];
      const target = path.join(root, ...parts);
      if (e.directory) {
        await mkdir(target, { recursive: true });
        continue;
      }
      const remote = e.relative
        ? remotePath.join(t.source, ...parts)
        : t.source;
      const dest = e.relative ? path.dirname(target) : root;
      await mkdir(dest, { recursive: true });
      await this.download(
        t.peerId,
        remote,
        dest,
        e.relative ? parts.at(-1)! : manifest.name,
        signal,
        progress,
      );
    }
  }
  private async upload(
    peer: string,
    source: string,
    directory: string,
    name: string,
    signal: AbortSignal,
    progress: (n: number) => void,
  ) {
    const d = this.network.devices.get(peer)!;
    const info = await digestFile(source);
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const req = https.request(
        {
          host: d.host,
          port: d.port,
          path: "/file?" + new URLSearchParams({ directory, name }),
          method: "POST",
          agent: this.network.agent(peer),
          signal,
          headers: {
            "content-length": info.size,
            "x-content-sha256": info.hash,
            "content-type": "application/octet-stream",
          },
        },
        (res) => {
          let body = "";
          res.on("data", (b) => {
            body += b;
            if (body.length > 65536) req.destroy(new Error("响应过大"));
          });
          res.on("end", () =>
            res.statusCode === 200
              ? resolve()
              : reject(new Error(this.responseError(body, "上传失败"))),
          );
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      void pipeline(createReadStream(source), this.limiter(progress), req, {
        signal,
      }).catch(reject);
    });
  }
  private async download(
    peer: string,
    source: string,
    directory: string,
    name: string,
    signal: AbortSignal,
    progress: (n: number) => void,
  ) {
    safeName(name);
    const meta = z
      .object({
        size: z.number().nonnegative(),
        hash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .parse(
        await this.network.rpc(peer, "files.info", { path: source }, 120000),
      );
    const d = this.network.devices.get(peer)!;
    const temp = path.join(directory, `.nearlink-${randomUUID()}.part`);
    try {
      await new Promise<void>((resolve, reject) => {
        const req = https.get(
          {
            host: d.host,
            port: d.port,
            path: "/file?" + new URLSearchParams({ path: source }),
            agent: this.network.agent(peer),
            signal,
          },
          (res) => {
            if (res.statusCode !== 200) {
              res.resume();
              reject(new Error("下载失败：对端拒绝读取文件"));
              return;
            }
            const h = createHash("sha256");
            let bytes = 0;
            const counter = new Transform({
              transform(b, _e, cb) {
                bytes += b.length;
                if (bytes > meta.size) {
                  cb(new Error("文件长度不匹配"));
                  return;
                }
                h.update(b);
                progress(b.length);
                cb(null, b);
              },
            });
            void pipeline(
              res,
              counter,
              createWriteStream(temp, { flags: "wx", mode: 0o600 }),
              { signal },
            )
              .then(() => {
                if (bytes !== meta.size || h.digest("hex") !== meta.hash)
                  throw new Error("文件校验失败，请重试");
                resolve();
              })
              .catch(reject);
          },
        );
        req.on("error", reject);
      });
      await finalizeFile(temp, directory, name);
    } catch (e) {
      await unlink(temp).catch(() => {});
      throw e;
    }
  }
  private responseError(body: string, fallback: string) {
    try {
      return String(JSON.parse(body).error ?? fallback);
    } catch {
      return fallback;
    }
  }
  cancelAll() {
    for (const t of this.tasks) this.cancel(t.id);
  }
}
