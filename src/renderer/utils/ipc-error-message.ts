/**
 * The message of an error thrown by a main-process handler, without the
 * "Error invoking remote method '<channel>': Error:" prefix Electron adds to it.
 */
export function ipcErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  return (
    raw.replace(/^Error invoking remote method '[^']+':\s*(?:\w*Error:\s*)?/, "").trim() || raw
  );
}
