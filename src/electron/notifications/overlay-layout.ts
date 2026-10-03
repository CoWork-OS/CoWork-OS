import type { Rectangle } from "electron";
import type { DesktopNotificationStyle } from "../../shared/types";

/** Work-area insets reserve room for a visible Dock; auto-hidden Docks use the bottom edge. */
export function getOverlayLayout(
  display: { bounds: Rectangle; workArea: Rectangle },
  style: DesktopNotificationStyle,
  stackIndex: number,
): Rectangle {
  const { bounds, workArea: area } = display;
  const margin = Math.min(16, area.width / 8, area.height / 8);
  const width = Math.min(style === "near-dock" ? 520 : 370, area.width - margin * 2);
  const height = Math.min(style === "near-dock" ? 116 : 92, area.height - margin * 2);
  const offset = stackIndex * (height + 10);
  const leftDock = area.x - bounds.x > 1;
  const rightDock = bounds.x + bounds.width - area.x - area.width > 1;
  const x =
    style !== "near-dock" || rightDock
      ? area.x + area.width - width - margin
      : leftDock
        ? area.x + margin
        : area.x + (area.width - width) / 2;
  const desiredY =
    style === "near-dock" ? area.y + area.height - height - margin - offset : area.y + 8 + offset;
  const y = Math.max(
    area.y + (style === "near-dock" ? margin : Math.min(8, margin)),
    Math.min(desiredY, area.y + area.height - height - margin),
  );
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}
