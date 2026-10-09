/**
 * Page zoom for the in-app browser, remembered per site and browser profile
 * (like Chrome's per-origin zoom). Levels are Chromium zoom levels: 0 is 100%,
 * each step is a factor of 1.2.
 */

const STORAGE_PREFIX = "cowork.browserWorkbench.zoom.v1";
/** Chrome's zoom steps, as percentages. */
const ZOOM_PERCENTS = [
  25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500,
];

export function zoomLevelToPercent(level: number): number {
  return Math.round(Math.pow(1.2, level) * 100);
}

export function percentToZoomLevel(percent: number): number {
  return Math.log(percent / 100) / Math.log(1.2);
}

/** Next zoom level in Chrome's step list. */
export function stepZoomLevel(level: number, direction: 1 | -1): number {
  const current = zoomLevelToPercent(level);
  const steps = direction > 0 ? ZOOM_PERCENTS : [...ZOOM_PERCENTS].reverse();
  const next = steps.find((percent) => (direction > 0 ? percent > current : percent < current));
  return next === undefined ? level : percentToZoomLevel(next);
}

export function zoomOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

function storageKey(partition: string): string {
  return `${STORAGE_PREFIX}:${partition}`;
}

function readMap(partition: string): Record<string, number> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey(partition)) || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export function readZoomLevel(partition: string, url: string): number {
  const origin = zoomOrigin(url);
  if (!origin) return 0;
  const level = Number(readMap(partition)[origin]);
  return Number.isFinite(level) ? level : 0;
}

export function writeZoomLevel(partition: string, url: string, level: number): void {
  const origin = zoomOrigin(url);
  if (!origin) return;
  const map = readMap(partition);
  if (Math.abs(level) < 0.001) delete map[origin];
  else map[origin] = level;
  try {
    window.localStorage.setItem(storageKey(partition), JSON.stringify(map));
  } catch {
    // Zoom still applies to the open page when storage is unavailable.
  }
}
