type WritableVideoTrack = MediaStreamTrack & {
  writable: WritableStream<VideoFrame>;
};

/** A readback prototype for comparing 1080p capture with identical WebRTC encoding. */
export async function dxgiTrack(
  sessionId: string,
  fps: number,
  signal: AbortSignal,
  onFailure: (track: MediaStreamTrack) => void,
) {
  const Generator = (
    window as Window & {
      MediaStreamTrackGenerator?: new (options: {
        kind: "video";
      }) => WritableVideoTrack;
    }
  ).MediaStreamTrackGenerator;
  if (!Generator) throw Error("当前 Chromium 无法接入 DXGI 视频帧");
  const token = crypto.randomUUID();
  const closePort = () =>
    void window.nearlink.invoke("capture.dxgi.close", token).catch(() => {});
  let track: WritableVideoTrack;
  signal.addEventListener("abort", closePort, { once: true });
  try {
    await window.nearlink.invoke("capture.dxgi.open", sessionId, token);
    signal.throwIfAborted();
    track = new Generator({ kind: "video" });
  } catch (error) {
    closePort();
    throw error;
  } finally {
    signal.removeEventListener("abort", closePort);
  }
  const writer = track.writable.getWriter();
  const period = 1000 / fps;
  let due = performance.now();
  const read = async () => {
    if (track.readyState === "ended") {
      closePort();
      await writer.abort().catch(() => {});
      return;
    }
    try {
      const bytes = await window.nearlink.invoke<ArrayBuffer | undefined>(
        "capture.dxgi.frame",
        token,
      );
      if (bytes && !isEnded(track)) {
        const frame = new VideoFrame(bytes, {
          format: "BGRX",
          codedWidth: 1920,
          codedHeight: 1080,
          timestamp: Math.round(performance.now() * 1000),
        });
        try {
          await writer.write(frame);
        } finally {
          frame.close();
        }
        due = Math.max(due + period, performance.now() - period);
      }
      setTimeout(read, bytes ? Math.max(0, due - performance.now() - 4) : 2);
    } catch {
      const active = !isEnded(track);
      closePort();
      track.stop();
      await writer.abort().catch(() => {});
      if (active) onFailure(track);
    }
  };
  setTimeout(read, 0);
  return track;
}

function isEnded(track: MediaStreamTrack) {
  return track.readyState === "ended";
}
