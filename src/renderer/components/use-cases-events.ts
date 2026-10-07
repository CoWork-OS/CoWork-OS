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
