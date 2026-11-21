import https from "node:https";
import tls from "node:tls";
import os from "node:os";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { isIP } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { Bonjour } from "bonjour-service";
import { DiscoveryLeases } from "./discovery-leases";
import { z } from "zod";
import type { IdentityStore } from "./identity";
import { fingerprint, prettyFingerprint } from "./identity-crypto";
import { VERSION, type Device } from "../src/shared/protocol";
const helloSchema = z.object({
  v: z.literal(VERSION),
  type: z.literal("hello"),
  name: z.string().min(1).max(80),
  platform: z.string().max(20),
  port: z.number().int().min(1).max(65535),
});
export const DEFAULT_PORT = 51820;
export function discoveryAddress(service: any) {
  const addresses = (service.addresses ?? []).filter(
    (address: unknown) => typeof address === "string" && isIP(address) === 4,
  ) as string[];
  const sender = String(service.referer?.address ?? "").replace(/^::ffff:/, "");
  // Announcements may list VPN/virtual adapters before the Wi-Fi interface.
  // Prefer the address that actually sent the LAN announcement when listed.
  return addresses.includes(sender)
    ? sender
    : (addresses[0] ?? (isIP(sender) === 4 ? sender : service.host));
}
type NetworkOptions = {
  stateDirectory?: string;
  listenHost?: string;
  port?: number;
  discovery?: boolean;
  probeIntervalMs?: number;
  approvePair?: (device: Device) => Promise<boolean>;
};
export function subscribeDiscovery(
  browser: any,
  up: (service: any) => void,
  down: (service: any) => void,
) {
  browser.on("up", up);
  browser.on("srv-update", up);
  browser.on("txt-update", up);
  browser.on("down", down);
}
type Link = {
  ws: WebSocket;
  device: Device;
  localAccept: boolean;
  remoteAccept: boolean;
  ready: boolean;
  alive: boolean;
  pairing: boolean;
  outbound: boolean;
};
type Pending = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  peer: string;
};
export class PeerNetwork extends EventEmitter {
  port = 0;
  devices = new Map<string, Device>();
  links = new Map<string, Link>();
  private pending = new Map<string, Pending>();
  private bonjour?: Bonjour;
  private browser: any;
  private service: any;
  private server?: https.Server;
  private heartbeat?: ReturnType<typeof setInterval>;
  private pairPrompt = false;
  private stopped = false;
  private connecting = new Map<string, Promise<Device>>();
  private httpSockets = new Map<tls.TLSSocket, string>();
  private recentPairs = new Map<string, number>();
  private probeTimer?: ReturnType<typeof setInterval>;
  private discoveryGeneration = 0;
  private serviceInstances = new Map<string, string>();
  private discoveryLeases = new DiscoveryLeases();
  private probing = false;
  private probeCursor = 0;
  private opening = new Set<WebSocket>();
  private bootId = randomUUID().slice(0, 8);
  rpcHandler: (peer: string, method: string, args: any) => Promise<any> =
    async () => {
      throw new Error("服务尚未就绪");
    };
  httpHandler: (
    peer: string,
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => Promise<void> = async (_p, _q, r) => {
    r.writeHead(404).end();
  };
  constructor(
    public store: IdentityStore,
    private options: NetworkOptions = {},
  ) {
    super();
    for (const d of store.trusted.values())
      this.devices.set(d.id, { ...d, online: false });
  }
  self(): Device {
    const i = this.store.identity;
    return {
      id: i.id,
      name: i.name,
      platform: process.platform,
      host: this.localAddress(),
      port: this.port,
      fingerprint: i.fingerprint,
      online: true,
      trusted: true,
      lastSeen: Date.now(),
    };
  }
  localAddress() {
    if (this.options.listenHost === "127.0.0.1") return "127.0.0.1";
    for (const n of Object.values(os.networkInterfaces()))
      for (const a of n ?? [])
        if (a.family === "IPv4" && !a.internal) return a.address;
    return "127.0.0.1";
  }
  async start() {
    this.server = https.createServer(
      {
        key: this.store.identity.key,
        cert: this.store.identity.cert,
        requestCert: true,
        rejectUnauthorized: false,
        minVersion: "TLSv1.3",
        maxHeaderSize: 16 * 1024,
      },
      (req, res) => {
        res.setHeader("Cache-Control", "no-store");
        try {
          const peer = this.socketIdentity(req.socket as tls.TLSSocket);
          if (!this.authorized(peer)) throw new Error("未授权");
          this.httpSockets.set(req.socket as tls.TLSSocket, peer);
          res.once("close", () =>
            this.httpSockets.delete(req.socket as tls.TLSSocket),
          );
          void this.httpHandler(peer, req, res).catch((e) => {
            if (!res.headersSent)
              res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: this.safeError(e) }));
          });
        } catch {
          res.writeHead(403).end("Forbidden");
        }
      },
    );
    this.server.requestTimeout = 30000;
    this.server.headersTimeout = 15000;
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: 20 * 1024 * 1024,
      perMessageDeflate: false,
    });
    this.server.on("upgrade", (req, socket, head) => {
      try {
        this.socketIdentity(req.socket as tls.TLSSocket);
        if (
          req.url !== "/link" ||
          !this.store.allowRemote ||
          this.links.size >= 16
        ) {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) =>
          this.attach(ws, req.socket as tls.TLSSocket),
        );
      } catch {
        socket.destroy();
      }
    });
    let preferred = this.options.port;
    if (preferred === undefined && this.options.stateDirectory) {
      try {
        const saved = JSON.parse(
          await readFile(
            path.join(this.options.stateDirectory, "transport.json"),
            "utf8",
          ),
        );
        if (
          Number.isInteger(saved.port) &&
          saved.port >= 1024 &&
          saved.port <= 65535
        )
          preferred = saved.port;
      } catch {}
    }
    preferred ??= DEFAULT_PORT;
    const listen = (port: number) =>
      new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => {
          this.server!.removeListener("listening", ready);
          reject(error);
        };
        const ready = () => {
          this.server!.removeListener("error", failed);
          resolve();
        };
        this.server!.once("error", failed);
        this.server!.once("listening", ready);
        this.server!.listen(port, this.options.listenHost ?? "0.0.0.0");
      });
    try {
      await listen(preferred);
    } catch (error: any) {
      if (preferred !== 0 && ["EADDRINUSE", "EACCES"].includes(error.code))
        await listen(0);
      else throw error;
    }
    this.port = (this.server.address() as import("node:net").AddressInfo).port;
    if (this.options.stateDirectory) {
      await mkdir(this.options.stateDirectory, { recursive: true });
      const file = path.join(this.options.stateDirectory, "transport.json"),
        temp = file + "." + randomUUID() + ".tmp";
      await writeFile(temp, JSON.stringify({ version: 1, port: this.port }), {
        mode: 0o600,
      });
      await rename(temp, file);
    }
    if (this.options.discovery !== false)
      try {
        const discoveryError = () => {
          if (!this.stopped)
            this.emit("warning", "局域网发现暂不可用，可使用地址连接。");
        };
        this.bonjour = new Bonjour({}, discoveryError);
        // bonjour-service forwards query errors via its callback, but its UDP
        // emitter needs a listener too (e.g. port access denied / adapter removed).
        (this.bonjour as any).server.mdns.on("error", discoveryError);
        this.service = this.bonjour.publish({
          name: `NearLink-${this.store.identity.id.slice(0, 12)}-${this.bootId}`,
          type: "nearlink",
          port: this.port,
          txt: {
            v: "1",
            id: this.store.identity.id,
            name: this.store.identity.name,
            platform: process.platform,
            instance: this.bootId,
          },
        });
        this.service.on("error", (e: Error) =>
          this.emit("warning", "局域网广播不可用，可使用地址连接。"),
        );
        this.startBrowser();
        (this.bonjour as any).server.mdns.on("response", (packet: any) =>
          this.discoveryLeases.observe(packet),
        );
      } catch {
        this.emit("warning", "局域网发现不可用，可使用地址连接。");
      }
    this.heartbeat = setInterval(() => {
      this.expireDiscovery();
      for (const [id, l] of this.links) {
        if (!l.alive) {
          l.ws.terminate();
          continue;
        }
        l.alive = false;
        l.ws.ping();
        if (!l.ready && Date.now() - l.device.lastSeen > 120000) l.ws.close();
      }
      this.emit("devices");
    }, 5000);
    if (this.options.probeIntervalMs !== 0) {
      this.probeTimer = setInterval(() => {
        this.refreshDiscovery();
        void this.probeTrusted();
      }, this.options.probeIntervalMs ?? 5000);
      void this.probeTrusted();
    }
    this.emit("devices");
  }
  private startBrowser() {
    this.browser?.stop();
    this.browser?.removeAllListeners();
    const generation = ++this.discoveryGeneration;
    this.browser = this.bonjour!.find({ type: "nearlink" });
    subscribeDiscovery(
      this.browser,
      (s) => {
        if (generation === this.discoveryGeneration) this.discovered(s);
      },
      (s) => {
        if (generation === this.discoveryGeneration) this.discoveryDown(s);
      },
    );
  }
  private serviceInstance(s: any) {
    return `${s.fqdn ?? s.name ?? ""}:${s.txt?.instance ?? ""}:${s.port}`;
  }
  discoveryDown(s: any) {
    const id = String(s.txt?.id),
      d = this.devices.get(id);
    if (
      !d ||
      this.serviceInstances.get(id) !== this.serviceInstance(s) ||
      this.links.get(id)?.ready
    )
      return;
    if (!this.store.trusted.has(id) && !this.links.has(id)) {
      this.devices.delete(id);
      this.serviceInstances.delete(id);
      this.discoveryLeases.remove(id);
    } else d.online = false;
    this.emit("devices");
  }
  discovered(s: any) {
    if (
      s.txt?.v !== "1" ||
      !s.txt?.id ||
      s.txt.id === this.store.identity.id ||
      !/^[a-f0-9]{64}$/.test(s.txt.id)
    )
      return;
    const host = discoveryAddress(s);
    if (!host) return;
    const id = String(s.txt.id);
    if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) return;
    this.serviceInstances.set(id, this.serviceInstance(s));
    this.discoveryLeases.record(id, s);
    const d: Device = {
      id,
      name: String(s.txt.name ?? "附近的电脑").slice(0, 80),
      platform: String(s.txt.platform ?? "unknown"),
      host,
      port: s.port,
      fingerprint: id,
      // For paired devices, "online" means an authenticated live channel,
      // not merely an mDNS record that may still be cached after a restart.
      online: this.store.trusted.has(id)
        ? this.links.get(id)?.ready === true &&
          this.links.get(id)?.ws.readyState === WebSocket.OPEN
        : true,
      trusted: this.store.trusted.has(id),
      lastSeen: Date.now(),
    };
    this.devices.set(id, d);
    this.emit("devices");
    if (d.trusted && this.options.probeIntervalMs !== 0)
      void this.connect(id).catch(() => {});
  }
  expireDiscovery(now = Date.now()) {
    let changed = false;
    for (const id of this.discoveryLeases.expired(now)) {
      if (this.store.trusted.has(id) || this.links.has(id)) continue;
      this.devices.delete(id);
      this.serviceInstances.delete(id);
      changed = true;
    }
    if (changed) this.emit("devices");
  }
  socketIdentity(socket: tls.TLSSocket) {
    const raw = socket.getPeerCertificate()?.raw;
    if (!raw) throw new Error("缺少设备证书");
    return fingerprint(raw);
  }
  authorized(id: string) {
    return (
      this.store.allowRemote &&
      this.store.trusted.has(id) &&
      this.links.get(id)?.ready === true &&
      this.links.get(id)?.ws.readyState === WebSocket.OPEN
    );
  }
  async connect(idOrAddress: string, pair = false): Promise<Device> {
    const existing = this.connecting.get(idOrAddress);
    if (existing) return existing;
    const promise = this.connectInner(idOrAddress, pair).finally(() =>
      this.connecting.delete(idOrAddress),
    );
    this.connecting.set(idOrAddress, promise);
    return promise;
  }
  private async connectInner(
    idOrAddress: string,
    pair = false,
  ): Promise<Device> {
    if (this.stopped) throw new Error("软件已退出");
    const original = this.devices.get(idOrAddress);
    if (!original) return this.dial(idOrAddress, pair);
    const attempted = new Set<string>();
    const attempt = async (endpoint: Device) => {
      attempted.add(`${endpoint.host}:${endpoint.port}`);
      return this.dial(idOrAddress, pair, {
        host: endpoint.host,
        port: endpoint.port,
      });
    };
    let first: Error;
    try {
      return await attempt(original);
    } catch (error) {
      first = error as Error;
      if (
        !/ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|连接已关闭|连接超时/.test(
          first.message,
        )
      )
        throw first;
    }
    this.refreshDiscovery(true);
    // A trusted peer may have upgraded from a random port to the stable
    // default. The TLS public-key pin is still checked before any RPC.
    if (this.store.trusted.has(original.id)) {
      const latest = this.devices.get(original.id) ?? original;
      const endpoints = [latest, { ...latest, port: DEFAULT_PORT }];
      for (const endpoint of endpoints) {
        if (attempted.has(`${endpoint.host}:${endpoint.port}`)) continue;
        try {
          return await attempt(endpoint);
        } catch {}
      }
    }
    await this.waitForEndpoint(original.id, attempted);
    if (this.stopped) throw new Error("软件已退出");
    const latest = this.devices.get(original.id);
    if (latest && !attempted.has(`${latest.host}:${latest.port}`)) {
      try {
        return await attempt(latest);
      } catch (error) {
        first = error as Error;
      }
    }
    const current = this.devices.get(original.id);
    if (current && !this.links.get(original.id)?.ready) {
      current.online = false;
      this.emit("devices");
    }
    throw new Error(
      `暂时无法连接「${original.name}」，已刷新设备地址。请确认对端软件正在运行，或使用对端设置页的当前地址连接。(${this.safeError(first)})`,
    );
  }
  private waitForEndpoint(id: string, attempted: Set<string>) {
    const fresh = () => {
      const d = this.devices.get(id);
      return (
        (!!d && !attempted.has(`${d.host}:${d.port}`)) ||
        !!this.links.get(id)?.ready
      );
    };
    if (fresh() || this.stopped) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.off("devices", changed);
        resolve();
      };
      const changed = () => {
        if (fresh() || this.stopped) done();
      };
      const timer = setTimeout(
        done,
        this.options.discovery === false ? 200 : 1200,
      );
      this.on("devices", changed);
    });
  }
  private async dial(
    idOrAddress: string,
    pair = false,
    endpoint?: { host: string; port: number },
  ): Promise<Device> {
    if (this.stopped) throw new Error("软件已退出");
    const known = this.devices.get(idOrAddress);
    if (
      known &&
      this.links.get(known.id)?.ready &&
      this.links.get(known.id)?.ws.readyState === WebSocket.OPEN
    )
      return this.links.get(known.id)!.device;
    let host: string, port: number;
    if (known) {
      host = endpoint?.host ?? known.host;
      port = endpoint?.port ?? known.port;
    } else {
      const m = /^(?:https?:\/\/)?([a-zA-Z0-9.\-]+):(\d{1,5})\/?$/.exec(
        idOrAddress.trim(),
      );
      if (!m) throw new Error("请输入电脑显示的 IPv4地址:端口");
      host = m[1];
      port = Number(m[2]);
      if (port < 1 || port > 65535) throw new Error("端口无效");
    }
    if (known?.id === this.store.identity.id)
      throw new Error("请选择另一台电脑");
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://${host}:${port}/link`, {
        key: this.store.identity.key,
        cert: this.store.identity.cert,
        rejectUnauthorized: false,
        minVersion: "TLSv1.3",
        handshakeTimeout: known && !pair ? 2500 : 8000,
        maxPayload: 20 * 1024 * 1024,
        perMessageDeflate: false,
      });
      this.opening.add(ws);
      let actual: string | undefined,
        settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        this.off("ready", ready);
        this.off("rejected", rejected);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(this.safeError(error)));
      };
      const ready = (device: Device) => {
        if (settled || device.id !== actual) return;
        settled = true;
        cleanup();
        resolve(device);
      };
      const rejected = (id: string) => {
        if (id === actual) fail(new Error("配对被拒绝或设备已暂停远程访问"));
      };
      const timer = setTimeout(
        () => {
          fail(new Error(pair ? "配对超时，请在两端确认。" : "设备连接超时"));
          ws.terminate();
        },
        pair ? 120000 : 5000,
      );
      ws.once("error", fail);
      ws.once("close", () => {
        this.opening.delete(ws);
        if (settled) return;
        const alternative = actual ? this.links.get(actual) : undefined;
        if (alternative && alternative.ws !== ws) {
          if (alternative.ready) ready(alternative.device);
          return;
        }
        fail(new Error("连接已关闭"));
      });
      ws.once("open", () => {
        this.opening.delete(ws);
        const socket = (ws as any)._socket as tls.TLSSocket;
        try {
          actual = this.socketIdentity(socket);
          if (actual === this.store.identity.id)
            throw new Error("不能连接本机");
          const expected = known
            ? (this.store.trusted.get(known.id)?.fingerprint ??
              known.fingerprint)
            : undefined;
          if (expected && actual !== expected)
            throw new Error("设备身份与记录不符，请检查地址并重新配对");
        } catch (error) {
          fail(error as Error);
          ws.close();
          return;
        }
        this.on("ready", ready);
        this.on("rejected", rejected);
        this.attach(ws, socket, host, port, pair);
        const established = this.links.get(actual!);
        if (established?.ready) ready(established.device);
      });
    });
  }

  private attach(
    ws: WebSocket,
    socket: tls.TLSSocket,
    host?: string,
    port?: number,
    pair = false,
  ) {
    const id = this.socketIdentity(socket);
    if (id === this.store.identity.id) {
      ws.close();
      return;
    }
    const old = this.links.get(id);
    if (old) {
      if (old.ready && old.ws.readyState === WebSocket.OPEN) {
        ws.close(1000, "duplicate");
        return;
      }
      // During simultaneous trusted reconnects, both ends must choose the
      // same socket instead of repeatedly replacing each other's connection.
      const preferOutbound = this.store.identity.id < id;
      const outbound = host !== undefined;
      if (
        old.ws.readyState === WebSocket.OPEN &&
        (old.outbound === preferOutbound || outbound !== preferOutbound)
      ) {
        ws.close(1000, "duplicate");
        return;
      }
      old.ws.close();
    }
    const link: Link = {
      ws,
      device: {
        ...(this.devices.get(id) ?? this.store.trusted.get(id)),
        id,
        fingerprint: id,
        name:
          this.devices.get(id)?.name ??
          this.store.trusted.get(id)?.name ??
          "连接中",
        platform:
          this.devices.get(id)?.platform ??
          this.store.trusted.get(id)?.platform ??
          "unknown",
        host: host ?? socket.remoteAddress?.replace("::ffff:", "") ?? "",
        port: port ?? 0,
        online: true,
        trusted: this.store.trusted.has(id),
        lastSeen: Date.now(),
      },
      ready: false,
      alive: true,
      localAccept: false,
      remoteAccept: false,
      pairing: pair,
      outbound: host !== undefined,
    };
    this.links.set(id, link);
    ws.on("pong", () => {
      link.alive = true;
      link.device.lastSeen = Date.now();
    });
    ws.on("message", (raw) => {
      void this.receive(link, raw.toString()).catch((e) => {
        this.emit("warning", this.safeError(e));
        if (!link.ready) ws.close();
      });
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      if (this.links.get(id) !== link) return;
      this.links.delete(id);
      const trusted = this.store.trusted.get(id);
      const latest = this.devices.get(id) ?? trusted;
      // A TLS handshake that never completed hello is not a discovered device.
      // In particular, do not persist its temporary "connecting" placeholder.
      if (trusted || (latest && this.serviceInstances.has(id))) {
        this.devices.set(id, {
          ...latest!,
          trusted: !!trusted,
          online: false,
        });
      } else this.devices.delete(id);
      for (const [k, p] of this.pending)
        if (p.peer === id) {
          clearTimeout(p.timer);
          p.reject(new Error("连接中断"));
          this.pending.delete(k);
        }
      this.emit("closed", id);
      this.emit("devices");
    });
    this.sendRaw(link, {
      v: 1,
      type: "hello",
      name: this.store.identity.name,
      platform: process.platform,
      port: this.port,
    });
  }
  private async receive(l: Link, text: string) {
    if (this.links.get(l.device.id) !== l || l.ws.readyState !== WebSocket.OPEN)
      return;
    const m = JSON.parse(text);
    if (m.v !== 1 || typeof m.type !== "string")
      throw new Error("协议版本不兼容");
    if (m.type === "hello") {
      const h = helloSchema.parse(m);
      Object.assign(l.device, {
        name: h.name,
        platform: h.platform,
        port: h.port,
        lastSeen: Date.now(),
      });
      this.devices.set(l.device.id, l.device);
      if (this.store.trusted.has(l.device.id)) {
        l.localAccept = true;
        this.sendRaw(l, { v: 1, type: "pair-confirm" });
      } else if (l.pairing) {
        this.sendRaw(l, { v: 1, type: "pair-request" });
        await this.confirm(l);
      }
      this.emit("devices");
      return;
    }
    if (m.type === "pair-request") {
      await this.confirm(l);
      return;
    }
    if (m.type === "pair-reject") {
      this.emit("rejected", l.device.id);
      l.ws.close();
      return;
    }
    if (m.type === "pair-confirm") {
      l.remoteAccept = true;
      if (this.store.trusted.has(l.device.id)) l.localAccept = true;
      await this.finishPair(l);
      return;
    }
    if (!l.ready || !this.authorized(l.device.id)) {
      l.ws.close(1008, "unauthorized");
      return;
    }
    if (m.type === "rpc") {
      if (
        typeof m.id !== "string" ||
        m.id.length > 64 ||
        typeof m.method !== "string"
      )
        throw new Error("无效请求");
      try {
        const result = await this.rpcHandler(l.device.id, m.method, m.args);
        this.sendRaw(l, { v: 1, type: "result", id: m.id, result });
      } catch (e) {
        this.sendRaw(l, {
          v: 1,
          type: "result",
          id: m.id,
          error: this.safeError(e),
        });
      }
      return;
    }
    if (m.type === "result") {
      const p = this.pending.get(m.id);
      if (p?.peer === l.device.id) {
        clearTimeout(p.timer);
        this.pending.delete(m.id);
        m.error
          ? p.reject(new Error(String(m.error).slice(0, 500)))
          : p.resolve(m.result);
      }
      return;
    }
    if (m.type === "event" && typeof m.topic === "string")
      this.emit("message", l.device.id, m.topic, m.payload);
  }
  private async confirm(l: Link) {
    if (l.localAccept) {
      this.sendRaw(l, { v: 1, type: "pair-confirm" });
      return;
    }
    if (this.pairPrompt) throw new Error("已有配对请求等待确认");
    const last = this.recentPairs.get(l.device.id) ?? 0;
    if (Date.now() - last < 10000) throw new Error("配对请求过于频繁");
    this.recentPairs.set(l.device.id, Date.now());
    this.pairPrompt = true;
    try {
      const approved = this.options.approvePair
        ? await this.options.approvePair(l.device)
        : undefined;
      const result =
        approved !== undefined
          ? { response: approved ? 1 : 0 }
          : await (
              await import("electron")
            ).dialog.showMessageBox({
              type: "question",
              title: "确认设备配对",
              message: `是否信任「${l.device.name}」？`,
              detail: `请在两台电脑核对以下设备指纹。确认后，该设备可远控、同步剪贴板并访问当前用户可读写的文件。\n\n本机指纹：\n${prettyFingerprint(this.store.identity.fingerprint)}\n\n对端指纹：\n${prettyFingerprint(l.device.fingerprint)}\n\n只在两端显示完全一致时确认。`,
              buttons: ["拒绝", "核对一致，信任设备"],
              defaultId: 0,
              cancelId: 0,
              noLink: true,
            });
      if (result.response !== 1) {
        this.sendRaw(l, { v: 1, type: "pair-reject" });
        this.emit("rejected", l.device.id);
        l.ws.close();
        return;
      }
      l.localAccept = true;
      this.sendRaw(l, { v: 1, type: "pair-confirm" });
      await this.finishPair(l);
    } finally {
      this.pairPrompt = false;
    }
  }
  private async finishPair(l: Link) {
    if (
      !l.localAccept ||
      !l.remoteAccept ||
      l.ready ||
      this.stopped ||
      this.links.get(l.device.id) !== l ||
      l.ws.readyState !== WebSocket.OPEN
    )
      return;
    await this.store.trust(l.device);
    if (
      this.stopped ||
      this.links.get(l.device.id) !== l ||
      l.ws.readyState !== WebSocket.OPEN
    )
      return;
    l.device.trusted = true;
    l.ready = true;
    this.devices.set(l.device.id, l.device);
    this.emit("ready", l.device);
    this.emit("devices");
  }
  sendRaw(l: Link, message: unknown) {
    if (l.ws.readyState === WebSocket.OPEN) {
      if (l.ws.bufferedAmount > 24 * 1024 * 1024) {
        l.ws.close(1013, "backpressure");
        return;
      }
      l.ws.send(JSON.stringify(message));
    }
  }
  send(id: string, topic: string, payload: any) {
    const l = this.links.get(id);
    if (!l?.ready) throw new Error("设备未连接");
    this.sendRaw(l, { v: 1, type: "event", topic, payload });
  }
  async rpc(
    id: string,
    method: string,
    args: any = {},
    timeout = 15000,
  ): Promise<any> {
    const l = this.links.get(id);
    if (!l?.ready) throw new Error("设备未连接");
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("请求超时"));
      }, timeout);
      this.pending.set(requestId, { resolve, reject, timer, peer: id });
      this.sendRaw(l, { v: 1, type: "rpc", id: requestId, method, args });
    });
  }
  async ensure(id: string) {
    if (this.links.get(id)?.ready) return this.links.get(id)!.device;
    return this.connect(id);
  }
  refreshDiscovery(force = false) {
    if (this.stopped) return;
    if (force && this.bonjour) this.startBrowser();
    this.browser?.update();
  }
  async probeTrusted() {
    if (this.stopped || this.probing) return;
    this.probing = true;
    try {
      const peers = [...this.devices.values()].filter(
        (d) => this.store.trusted.has(d.id) && !this.links.get(d.id)?.ready,
      );
      const count = Math.min(4, peers.length),
        batch = [];
      for (let i = 0; i < count; i++)
        batch.push(peers[(this.probeCursor + i) % peers.length]);
      this.probeCursor = peers.length
        ? (this.probeCursor + count) % peers.length
        : 0;
      await Promise.allSettled(batch.map((d) => this.connect(d.id)));
    } finally {
      this.probing = false;
    }
  }
  agent(id: string) {
    const d = this.devices.get(id);
    if (!d || !this.store.trusted.has(id)) throw new Error("设备未配对");
    const agent = new https.Agent({ keepAlive: false, maxSockets: 2 });
    (agent as any).createConnection = (options: any, callback: any) => {
      let completed = false;
      const finish = (error: unknown, value?: tls.TLSSocket) => {
        if (completed) return;
        completed = true;
        callback(error, value);
      };
      const socket = tls.connect(
        {
          ...options,
          host: d.host,
          port: d.port,
          cert: this.store.identity.cert,
          key: this.store.identity.key,
          rejectUnauthorized: false,
          minVersion: "TLSv1.3",
        },
        () => {
          try {
            if (this.socketIdentity(socket) !== d.fingerprint)
              throw new Error("设备身份验证失败");
            finish(null, socket);
          } catch (e) {
            socket.destroy();
            finish(e);
          }
        },
      );
      socket.once("error", (e: Error) => finish(e));
    };
    return agent;
  }
  closeIncoming() {
    for (const socket of this.httpSockets.keys()) socket.destroy();
    this.httpSockets.clear();
  }
  async revoke(id: string) {
    await this.store.revoke(id);
    for (const [socket, peer] of this.httpSockets)
      if (peer === id) {
        socket.destroy();
        this.httpSockets.delete(socket);
      }
    this.links.get(id)?.ws.close(1008, "revoked");
    const d = this.devices.get(id);
    if (d) d.trusted = false;
    this.emit("devices");
  }
  async stop() {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.probeTimer) clearInterval(this.probeTimer);
    for (const ws of this.opening) ws.terminate();
    this.opening.clear();
    for (const l of this.links.values()) l.ws.terminate();
    this.links.clear();
    this.browser?.stop();
    const bonjour = this.bonjour;
    this.bonjour = undefined;
    if (bonjour) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500);
        bonjour.unpublishAll(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500);
        bonjour.destroy(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.server?.closeAllConnections();
    this.server?.close();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("软件已退出"));
    }
    this.pending.clear();
    this.emit("devices");
  }
  safeError(e: any) {
    return String(e?.message ?? e).slice(0, 500);
  }
}
