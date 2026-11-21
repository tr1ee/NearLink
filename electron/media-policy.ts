// Electron 45.4.1 / Chromium 156: this receiver-side WebRTC trial is present
// in the bundled engine. Unlike jitterBufferTarget=0 (a minimum-delay hint),
// min=max=0 asks the native video receiver to decode frames as they arrive.
// Revalidate this internal API and the burst-arrival regression on upgrades.
export const VIDEO_PLAYOUT_TRIAL = "WebRTC-ForcePlayoutDelay";
export const VIDEO_PLAYOUT_GROUP = "min_ms:0,max_ms:0";

export function interactiveVideoTrials(existing: string) {
  const parts = existing.split("/");
  const trials: string[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2)
    if (parts[i] && parts[i] !== VIDEO_PLAYOUT_TRIAL)
      trials.push(parts[i], parts[i + 1]);
  return [...trials, VIDEO_PLAYOUT_TRIAL, VIDEO_PLAYOUT_GROUP, ""].join("/");
}
