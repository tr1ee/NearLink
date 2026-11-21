export const mediaStages = [
  "engine-start",
  "offer-received",
  "offer-description-ready",
  "source-requested",
  "source-ready",
  "capture-requested",
  "capture-audio-fallback",
  "capture-ready",
  "answer-ready",
  "answer-received",
  "answer-description-ready",
  "signal-failed",
  "connection-new",
  "connection-connecting",
  "connection-connected",
  "connection-disconnected",
  "connection-failed",
  "connection-closed",
] as const;
export type MediaStage = (typeof mediaStages)[number];
export function isMediaStage(value: unknown): value is MediaStage {
  return typeof value === "string" && mediaStages.includes(value as MediaStage);
}
