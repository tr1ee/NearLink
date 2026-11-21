import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { X509CertificateGenerator, cryptoProvider } from "@peculiar/x509";
import {
  PeerNetwork,
  subscribeDiscovery,
  discoveryAddress,
} from "../electron/network";
import { fingerprint } from "../electron/identity-crypto";
import type { IdentityStore } from "../electron/identity";
import type { Device } from "../src/shared/protocol";

async function store() {
  cryptoProvider.set(webcrypto as unknown as Crypto);
  const keys = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const certificate = await X509CertificateGenerator.createSelfSigned({
    name: "CN=NearLink Network Test",
    serialNumber: randomUUID().replaceAll("-", ""),
    notBefore: new Date(Date.now() - 60000),
    notAfter: new Date(Date.now() + 86400000),
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    keys: keys as any,
  });
  const cert = certificate.toString("pem"),
    id = fingerprint(cert),
    der = Buffer.from(
      await webcrypto.subtle.exportKey("pkcs8", keys.privateKey),
    );
  const key = `-----BEGIN PRIVATE KEY-----\n${der
    .toString("base64")
    .match(/.{1,64}/g)!
    .join("\n")}\n-----END PRIVATE KEY-----\n`;
  const trusted = new Map<string, Device>();
  return {
    identity: { id, name: "network-test", fingerprint: id, key, cert },
    trusted,
    allowRemote: true,
    trust: async (d: Device) => {
      trusted.set(d.id, { ...d, trusted: true });
    },
    revoke: async (id: string) => {
      trusted.delete(id);
    },
  } as unknown as IdentityStore;
}
async function eventually(
  condition: () => boolean,
  label: string,
  timeout = 4000,
) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(label);
}
function service(peer: PeerNetwork, instance: string) {
  return {
    fqdn: `NearLink-${instance}._nearlink._tcp.local`,
    name: `NearLink-${instance}`,
    txt: {
      v: "1",
      id: peer.store.identity.id,
      name: peer.store.identity.name,
      platform: process.platform,
      instance,
    },
    addresses: ["127.0.0.1"],
    port: peer.port,
  };
}
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nearlink-network-"));
  const instances = new Set<PeerNetwork>();
  const create = async (
    identity: IdentityStore | undefined = undefined,
    name: string = randomUUID(),
    port: number | undefined = 0,
  ) => {
    const options = {
      stateDirectory: path.join(directory, name),
      port: port === -1 ? undefined : port,
      discovery: false,
      listenHost: "127.0.0.1",
      probeIntervalMs: 0,
      approvePair: async () => true,
    };
    const peer = new PeerNetwork(identity ?? (await store()), options);
    instances.add(peer);
    peer.rpcHandler = async (_id, method, args) => ({ method, args });
    await peer.start();
    return peer;
  };
  return {
    directory,
    create,
    cleanup: async () => {
      await Promise.all([...instances].map((peer) => peer.stop()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
async function paired(f: Awaited<ReturnType<typeof fixture>>) {
  const a = await f.create(),
    b = await f.create();
  await a.connect(`127.0.0.1:${b.port}`, true);
  await eventually(
    () => b.links.get(a.store.identity.id)?.ready === true,
    "both peers paired",
  );
  return { a, b };
}
test("多网卡公告优先使用实际局域网发送地址，避免选中VPN虚拟网卡", () => {
  assert.equal(
    discoveryAddress({
      addresses: ["172.20.10.1", "10.128.2.10"],
      referer: { address: "10.128.2.10" },
    }),
    "10.128.2.10",
  );
  assert.equal(
    discoveryAddress({
      addresses: ["10.128.2.10"],
      referer: { address: "10.128.2.1" },
    }),
    "10.128.2.10",
  );
});

test("传输监听端口重启后复用，端口被占用时分配并保存可用端口", async () => {
  const f = await fixture();
  let blocker: net.Server | undefined;
  try {
    const identity: IdentityStore | undefined = undefined,
      a = await f.create(identity, "stable", 0),
      port = a.port;
    await a.stop();
    const b = await f.create(identity, "stable", -1);
    assert.equal(b.port, port);
    await b.stop();
    blocker = net.createServer();
    await new Promise<void>((resolve) =>
      blocker!.listen(port, "127.0.0.1", resolve),
    );
    const c = await f.create(identity, "stable", -1);
    assert.notEqual(c.port, port);
    assert.equal(
      JSON.parse(
        await readFile(path.join(f.directory, "stable/transport.json"), "utf8"),
      ).port,
      c.port,
    );
    const recovered = c.port;
    await c.stop();
    const d = await f.create(identity, "stable", -1);
    assert.equal(d.port, recovered);
  } finally {
    if (blocker)
      await new Promise<void>((resolve) => blocker!.close(() => resolve()));
    await f.cleanup();
  }
});
test("订阅SRV/TXT变更，旧实例离线公告不覆盖新实例在线状态", async () => {
  const f = await fixture();
  try {
    const a = await f.create(),
      b = await f.create(),
      browser = new EventEmitter();
    subscribeDiscovery(
      browser,
      (s) => a.discovered(s),
      (s) => a.discoveryDown(s),
    );
    const old = service(b, "old"),
      fresh = { ...service(b, "new"), port: b.port + 1 };
    browser.emit("up", old);
    browser.emit("srv-update", fresh, old);
    assert.equal(a.devices.get(b.store.identity.id)?.port, fresh.port);
    browser.emit("down", old);
    assert.equal(a.devices.get(b.store.identity.id)?.online, true);
    browser.emit(
      "txt-update",
      { ...fresh, txt: { ...fresh.txt, name: "renamed" } },
      fresh,
    );
    assert.equal(a.devices.get(b.store.identity.id)?.name, "renamed");
    browser.emit("down", fresh);
    assert.equal(a.devices.has(b.store.identity.id), false);
  } finally {
    await f.cleanup();
  }
});
test("保持控制端运行，对端换端口重启后仍保留新地址并恢复真实TLS RPC", async () => {
  const f = await fixture();
  try {
    const { a, b } = await paired(f),
      id = b.store.identity.id;
    assert.equal((await a.rpc(id, "before", {})).method, "before");
    const restarted = await f.create(b.store, "replacement", 0),
      fresh = service(restarted, "replacement");
    a.discovered(fresh);
    await b.stop();
    await eventually(() => !a.links.has(id), "old transport closed");
    assert.equal(
      a.devices.get(id)?.port,
      restarted.port,
      "closing old socket must not put the old port back",
    );
    await a.ensure(id);
    assert.equal((await a.rpc(id, "after", { ok: true })).args.ok, true);
    assert.equal(a.devices.get(id)?.online, true);
    assert.equal(restarted.devices.get(a.store.identity.id)?.online, true);
  } finally {
    await f.cleanup();
  }
});
test("mDNS不可用时仍主动验证已配对设备，把保存的离线状态恢复为在线", async () => {
  const f = await fixture();
  try {
    const { a, b } = await paired(f);
    await a.stop();
    await eventually(
      () => !b.links.has(a.store.identity.id),
      "old controller closed",
    );
    const restarted = await f.create(a.store, "controller-restart", 0),
      id = b.store.identity.id;
    assert.equal(restarted.devices.get(id)?.online, false);
    await restarted.probeTrusted();
    assert.equal(restarted.devices.get(id)?.online, true);
    assert.equal((await restarted.rpc(id, "verified", {})).method, "verified");
  } finally {
    await f.cleanup();
  }
});
test("连接旧端口失败后等待新发现地址，并在同一次连接请求中重试成功", async () => {
  const f = await fixture();
  try {
    const { a, b } = await paired(f),
      id = b.store.identity.id;
    await b.stop();
    await eventually(() => !a.links.has(id), "old connection closed");
    const restarted = await f.create(b.store, "new-port", 0);
    const announced = setTimeout(
      () => a.discovered(service(restarted, "new-boot")),
      25,
    );
    try {
      await a.ensure(id);
    } finally {
      clearTimeout(announced);
    }
    assert.equal(a.devices.get(id)?.port, restarted.port);
    assert.equal((await a.rpc(id, "retry", {})).method, "retry");
    assert.equal(a.listenerCount("ready"), 0);
    assert.equal(a.listenerCount("rejected"), 0);
  } finally {
    await f.cleanup();
  }
});
test("两端同时重连选择同一条可信连接，不互相关闭重试", async () => {
  const f = await fixture();
  try {
    const { a, b } = await paired(f);
    for (let cycle = 0; cycle < 6; cycle++) {
      a.links.get(b.store.identity.id)!.ws.terminate();
      await eventually(
        () => !a.links.size && !b.links.size,
        "both links closed",
      );
      await Promise.all(
        cycle % 2
          ? [b.ensure(a.store.identity.id), a.ensure(b.store.identity.id)]
          : [a.ensure(b.store.identity.id), b.ensure(a.store.identity.id)],
      );
      assert.equal(
        (await a.rpc(b.store.identity.id, "a-to-b", {})).method,
        "a-to-b",
      );
      assert.equal(
        (await b.rpc(a.store.identity.id, "b-to-a", {})).method,
        "b-to-a",
      );
      assert.equal(a.listenerCount("ready"), 0);
      assert.equal(b.listenerCount("ready"), 0);
    }
  } finally {
    await f.cleanup();
  }
});
test("地址被另一设备占用时仍拒绝公钥不匹配，不自动改变配对信任", async () => {
  const f = await fixture();
  try {
    const { a, b } = await paired(f),
      id = b.store.identity.id;
    await b.stop();
    await eventually(() => !a.links.has(id), "old peer closed");
    const stranger = await f.create();
    a.devices.set(id, { ...a.devices.get(id)!, port: stranger.port });
    await assert.rejects(a.ensure(id), /身份与记录不符/);
    assert.equal(a.store.trusted.has(stranger.store.identity.id), false);
    assert.equal(a.authorized(stranger.store.identity.id), false);
    assert.equal(a.store.trusted.get(id)?.fingerprint, id);
  } finally {
    await f.cleanup();
  }
});
test("未完成hello的临时TLS连接断开后不产生连接中或未配对条目", async () => {
  const f = await fixture();
  let socket: WebSocket | undefined;
  try {
    const host = await f.create(),
      stranger = await store();
    socket = new WebSocket(`wss://127.0.0.1:${host.port}/link`, {
      key: stranger.identity.key,
      cert: stranger.identity.cert,
      rejectUnauthorized: false,
    });
    await new Promise<void>((resolve, reject) => {
      socket!.once("open", resolve);
      socket!.once("error", reject);
    });
    await eventually(
      () => host.links.has(stranger.identity.id),
      "TLS attached",
    );
    socket.terminate();
    await eventually(() => !host.links.has(stranger.identity.id), "TLS closed");
    assert.equal(host.devices.has(stranger.identity.id), false);
    assert.equal(host.store.trusted.has(stranger.identity.id), false);
  } finally {
    socket?.terminate();
    await f.cleanup();
  }
});
test("发现租约过期清除未配对身份，已配对身份和指纹保留", async () => {
  const f = await fixture();
  try {
    const { a, b } = await paired(f),
      stranger = await f.create();
    a.discovered(service(b, "trusted"));
    a.discovered(service(stranger, "nearby"));
    a.expireDiscovery(Date.now() + 130000);
    assert.equal(a.devices.has(stranger.store.identity.id), false);
    assert.equal(a.devices.get(b.store.identity.id)?.trusted, true);
    assert.equal(
      a.store.trusted.get(b.store.identity.id)?.fingerprint,
      b.store.identity.id,
    );
  } finally {
    await f.cleanup();
  }
});
