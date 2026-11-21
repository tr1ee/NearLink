import { screen, type BrowserWindow } from "electron";
import type { DisplayInfo } from "../src/shared/protocol";

export function fitRemoteWindow(
  win: BrowserWindow,
  source: DisplayInfo,
  ratio = source.width / source.height,
) {
  const frame = win.getBounds();
  const content = win.getContentBounds();
  const target = screen.getDisplayMatching(frame);
  const area = target.workArea;
  const chromeWidth = Math.max(0, frame.width - content.width);
  const chromeHeight = Math.max(0, frame.height - content.height);
  const pixelScale = source.scale / target.scaleFactor;
  const height = Math.max(
    1,
    Math.floor(
      Math.min(
        source.height * pixelScale,
        (source.width * pixelScale) / ratio,
        area.height - chromeHeight,
        (area.width - chromeWidth) / ratio,
      ),
    ),
  );
  const width = Math.max(1, Math.round(height * ratio));
  const leftInset = content.x - frame.x;
  const topInset = content.y - frame.y;
  const x = Math.max(
    area.x,
    Math.min(frame.x, area.x + area.width - width - chromeWidth),
  );
  const y = Math.max(
    area.y,
    Math.min(frame.y, area.y + area.height - height - chromeHeight),
  );

  // Electron constrains the content area on macOS and the outer frame on Windows.
  win.setAspectRatio(0);
  win.setContentBounds({ x: x + leftInset, y: y + topInset, width, height });
  if (process.platform === "darwin") win.setAspectRatio(ratio);
  else win.setAspectRatio((width + chromeWidth) / (height + chromeHeight));
}
