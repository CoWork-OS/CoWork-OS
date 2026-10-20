/** Two animation frames leave a paint between installing a replacement and hiding a native view. */
export function afterBrowserPaint(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
  });
}

/** Keep the live page visible until its replacement image has loaded and painted. */
export async function captureBrowserTabFreeze(options: {
  capture: () => Promise<string | null | undefined>;
  displayImage: (src: string) => Promise<boolean>;
  isCurrent: () => boolean;
  hide: () => void;
  afterPaint?: () => Promise<void>;
}): Promise<void> {
  try {
    const image = await options.capture();
    if (!image || !options.isCurrent()) return;
    if (!(await options.displayImage(image)) || !options.isCurrent()) return;
    await (options.afterPaint ?? afterBrowserPaint)();
    if (options.isCurrent()) options.hide();
  } catch {
    // A failed capture leaves the live page intact instead of exposing a blank frame.
  }
}
