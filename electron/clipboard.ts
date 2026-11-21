import { clipboard, ClipboardItem } from "electron";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { PeerNetwork } from "./network";
import { MAX_CLIPBOARD, type ClipboardPayload } from "../src/shared/protocol";
const schema = z.object({
  origin: z.string().regex(/^[a-f0-9]{64}$/),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  text: z
    .string()
    .max(2 * 1024 * 1024)
    .optional(),
  png: z
    .string()
    .max(MAX_CLIPBOARD * 1.4)
    .optional(),
});
export function clipHash(text: string | undefined, png: Buffer | undefined) {
  return createHash("sha256")
    .update(text ?? "")
    .update("\0")
    .update(png ?? Buffer.alloc(0))
    .digest("hex");
}
export class ClipboardSync {
  private timer?: ReturnType<typeof setInterval>;
  private last = "";
  private busy = false;
  private writeTail = Promise.resolve();
  private peer: string | null = null;
  private flushQueue = Promise.resolve();
  constructor(private network: PeerNetwork) {}
  start(peer: string) {
    this.stop();
    this.peer = peer;
    this.last = "";
    this.timer = setInterval(() => {
      if (!this.busy) void this.flush().catch(() => {});
    }, 300);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.peer = null;
    this.last = "";
  }
  flush() {
    this.busy = true;
    const next = this.flushQueue.catch(() => {}).then(() => this.readAndSend());
    this.flushQueue = next;
    return next.finally(() => {
      if (this.flushQueue === next) this.busy = false;
    });
  }
  private async readAndSend() {
    const peer = this.peer;
    if (!peer) return;
    await this.writeTail;
    const items = await clipboard.read();
    let text: string | undefined, png: Buffer | undefined;
    for (const item of items) {
      if (text === undefined && item.types.includes("text/plain")) {
        const b = await item.getType("text/plain");
        if (b.size <= 2 * 1024 * 1024) text = await b.text();
      }
      if (!png && item.types.includes("image/png")) {
        const b = await item.getType("image/png");
        if (b.size <= MAX_CLIPBOARD) png = Buffer.from(await b.arrayBuffer());
      }
    }
    if (text === undefined && !png) return;
    const hash = clipHash(text, png);
    if (hash === this.last || this.peer !== peer) return;
    const payload: ClipboardPayload = {
      origin: this.network.store.identity.id,
      hash,
      text,
      png: png?.toString("base64"),
    };
    await this.network.rpc(peer, "clipboard.apply", payload);
    if (this.peer === peer) this.last = hash;
  }
  async apply(peer: string, data: unknown) {
    if (peer !== this.peer) throw new Error("当前没有启用剪贴板的远控会话");
    const p = schema.parse(data);
    if (p.origin !== peer) throw new Error("剪贴板来源无效");
    const png = p.png ? Buffer.from(p.png, "base64") : undefined;
    if (png && png.length > MAX_CLIPBOARD) throw new Error("截图过大");
    if (clipHash(p.text, png) !== p.hash) throw new Error("剪贴板校验失败");
    this.writeTail = this.writeTail
      .catch(() => {})
      .then(async () => {
        if (this.peer !== peer) throw new Error("会话已结束");
        if (this.last === p.hash) return;
        const item: Record<string, Blob> = {};
        if (p.text !== undefined)
          item["text/plain"] = new Blob([p.text], { type: "text/plain" });
        if (png)
          item["image/png"] = new Blob([new Uint8Array(png)], {
            type: "image/png",
          });
        if (!Object.keys(item).length) return;
        await clipboard.write([new ClipboardItem(item)]);
        this.last = p.hash;
      });
    await this.writeTail;
    return { hash: p.hash };
  }
}
