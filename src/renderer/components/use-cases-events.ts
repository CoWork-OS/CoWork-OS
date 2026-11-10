/** Fired by the sidebar notice to open the use-cases gallery over the visible composer. */
export const OPEN_USE_CASES_EVENT = "cowork:open-use-cases";

/**
 * Asks a mounted composer surface (welcome screen, Build) to open its gallery.
 * Returns true when one handled it (listeners call `preventDefault()`).
 */
export function requestUseCasesGallery(): boolean {
  const event = new Event(OPEN_USE_CASES_EVENT, { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

/**
 * `requestUseCasesGallery`, retried while a surface mounts: right after a new session opens,
 * its welcome screen starts listening a moment later. Resolves false if none did in time.
 */
export function requestUseCasesGalleryWhenReady(
  timeoutMs = 1500,
  intervalMs = 50,
): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      if (requestUseCasesGallery()) resolve(true);
      else if (Date.now() >= deadline) resolve(false);
      else setTimeout(attempt, intervalMs);
    };
    setTimeout(attempt, intervalMs);
  });
}
