import { z } from "zod";
export const VERSION = 1;
export const MAX_CLIPBOARD = 12 * 1024 * 1024;
export type Device = {
  id: string;
  name: string;
  platform: string;
  host: string;
  port: number;
  fingerprint: string;
  online: boolean;
  trusted: boolean;
  lastSeen: number;
};
export type DisplayInfo = {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  rotation: number;
  refreshRate: number;
};
export type PermissionState = {
  screen: string;
  accessibility: boolean;
  native: boolean;
  audio: string;
};
export type Quality = {
  height: 2160 | 1440 | 1080 | 720;
  fps: 30 | 60 | 120;
  auto: boolean;
};
export const DEFAULT_QUALITY: Quality = { height: 2160, fps: 60, auto: true };
export type BenchmarkViewport = {
  displayId: string;
  x: number;
  y: number;
  width: number;
  height: number;
};
export const qualitySchema = z.object({
  height: z.union([
    z.literal(2160),
    z.literal(1440),
    z.literal(1080),
    z.literal(720),
  ]),
  fps: z.union([z.literal(30), z.literal(60), z.literal(120)]),
  auto: z.boolean(),
});
export type SessionInfo = {
  id: string;
  peerId: string;
  role: "host" | "controller";
  viewOnly: boolean;
  displayId: string;
  displays: DisplayInfo[];
  quality: Quality;
  state: "connecting" | "connected" | "reconnecting" | "disconnected";
  reason?: string;
  remotePlatform: string;
  localRefreshRate: number;
  allow120: boolean;
};
export type FileEntry = {
  name: string;
  path: string;
  directory: boolean;
  size: number;
  modified: number;
};
export type Listing = { path: string; parent: string; entries: FileEntry[] };
export type FileLocation = {
  name: string;
  path: string;
  kind: "folder" | "disk";
};
export type TransferTask = {
  id: string;
  peerId: string;
  direction: "upload" | "download";
  name: string;
  source: string;
  destination: string;
  size: number;
  done: number;
  state: "queued" | "running" | "completed" | "failed" | "cancelled";
  error?: string;
  startedAt: number;
};
export type Metrics = {
  at: number;
  seconds: number;
  width: number;
  height: number;
  captureFps: number;
  captureBackend?: "chromium" | "dxgi" | "service";
  captureFallback?: boolean;
  targetFps?: number;
  configuredFps?: number;
  encodeFps: number;
  decodeFps: number;
  renderFps: number;
  bitrate: number;
  rttMs: number;
  loss: number;
  encodeMs: number;
  decodeMs: number;
  jitterMs: number;
  jitterBufferMs?: number;
  jitterBufferTargetMs?: number;
  jitterBufferMinimumMs?: number;
  videoCodec?: string;
  videoCodecParameters?: string;
  mediaTransport?: string;
  inputRttMs?: number;
  inputAppliedRttMs?: number;
  videoAgeMs?: number;
  videoAgeP95Ms?: number;
  receiveToPresentMs?: number;
  receiveToSubmitMs?: number;
  submitToDisplayMs?: number;
  inputQueueMs?: number;
  inputCoalesced?: number;
  inputButtons?: InputButtonStats;
  sendQueueMs?: number;
  frameDrops?: number;
  freezes: number;
  freezeSeconds: number;
  frames: number;
  encoder: string;
  decoder: string;
  hardwareEncode: boolean | null;
  hardwareDecode: boolean | null;
  qualityReason: string;
  bytes: number;
  audioLevel?: number;
};
export type Snapshot = {
  self: Device;
  devices: Device[];
  permissions: PermissionState;
  allowRemote: boolean;
  session: SessionInfo | null;
  transfers: TransferTask[];
  error?: string;
  platform: string;
};
export type ClipboardPayload = {
  origin: string;
  hash: string;
  text?: string;
  png?: string;
};
export type InputResult =
  | "applied"
  | "native-rejected"
  | "unauthorized"
  | "stale"
  | "unavailable"
  | "suppressed-move"
  | "already-up"
  | "deferred-press"
  | "tray-click"
  | "tray-drag-start";
export type InputButtonStats = {
  down: number;
  up: number;
  appliedDown: number;
  appliedUp: number;
  nativeRejected: number;
  unavailable: number;
  unauthorized: number;
  alreadyUp?: number;
  trayClicks?: number;
  deferredDowns?: number;
};
export const inputSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("move"),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      seq: z.number().int().nonnegative(),
      afterButton: z.number().int().nonnegative().optional(),
    }),
    z.object({
      type: z.literal("button"),
      seq: z.number().int().nonnegative().optional(),
      button: z.number().int().min(0).max(2),
      down: z.boolean(),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
    }),
    z.object({
      type: z.literal("wheel"),
      dx: z.number().min(-2000).max(2000),
      dy: z.number().min(-2000).max(2000),
    }),
    z.object({
      type: z.literal("key"),
      code: z.string().max(40),
      down: z.boolean(),
    }),
    z.object({ type: z.literal("text"), text: z.string().max(4096) }),
    z.object({ type: z.literal("paste") }),
    z.object({
      type: z.literal("release"),
      seq: z.number().int().nonnegative().optional(),
    }),
  ])
  .and(
    z.object({
      desktopEpoch: z.number().int().min(1).max(0xffffffff).optional(),
    }),
  );
export type InputEvent = z.infer<typeof inputSchema>;
export type MediaSignal = {
  kind: "offer" | "answer" | "candidate" | "reconfigure" | "stop" | "stats";
  sessionId: string;
  data: any;
};
export interface NearLinkAPI {
  invoke<T = any>(method: string, ...args: any[]): Promise<T>;
  on(topic: string, listener: (payload: any) => void): () => void;
  windowKind: string;
  peerId: string;
}
declare global {
  interface Window {
    nearlink: NearLinkAPI;
  }
}
