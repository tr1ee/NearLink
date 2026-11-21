import type { DisplayInfo } from "./protocol";
export function captureSize(display: DisplayInfo, heightLimit: number) {
  const nativeWidth = Math.round(display.width * display.scale);
  const nativeHeight = Math.round(display.height * display.scale);
  const landscape = nativeWidth >= nativeHeight;
  const longLimit = Math.round((heightLimit * 16) / 9);
  const scale = Math.min(
    1,
    (landscape ? longLimit : heightLimit) / nativeWidth,
    (landscape ? heightLimit : longLimit) / nativeHeight,
  );
  return {
    width: Math.max(2, Math.floor((nativeWidth * scale) / 2) * 2),
    height: Math.max(2, Math.floor((nativeHeight * scale) / 2) * 2),
  };
}
export function mapPoint(x: number, y: number, d: DisplayInfo) {
  return {
    x: Math.round(d.x + Math.max(0, Math.min(1, x)) * (d.width - 1)),
    y: Math.round(d.y + Math.max(0, Math.min(1, y)) * (d.height - 1)),
  };
}
export function videoPoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  width: number,
  height: number,
) {
  if (!width || !height || !rect.width || !rect.height) return null;
  const scale = Math.min(rect.width / width, rect.height / height),
    w = width * scale,
    h = height * scale;
  const x = (clientX - rect.left - (rect.width - w) / 2) / w,
    y = (clientY - rect.top - (rect.height - h) / 2) / h;
  return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x, y };
}
