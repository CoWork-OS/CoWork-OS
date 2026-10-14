import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { ApplicationNotDispatchedError } from "./ApplicationAdapterCatalog";

const execFileAsync = promisify(execFile);
export function isNativeDesktopAvailable(sessionState: string): boolean {
  try {
    const state = JSON.parse(sessionState);
    return state?.onConsole === true && state?.locked === false;
  } catch {
    return false;
  }
}
export async function requireNativeDesktopSession(signal?: AbortSignal): Promise<void> {
  if (process.platform !== "darwin")
    throw new ApplicationNotDispatchedError("Native application pilots require macOS");
  const probe = path
    .join(__dirname, "native-session-probe")
    .replace(/([/\\])app\.asar([/\\])/, "$1app.asar.unpacked$2");
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(probe, [], {
      timeout: 5_000,
      maxBuffer: 1024,
      signal,
    }));
  } catch {
    throw new ApplicationNotDispatchedError(
      "Native desktop session probe unavailable; rebuild the runtime",
    );
  }
  if (!isNativeDesktopAvailable(stdout))
    throw new ApplicationNotDispatchedError(
      "The native desktop session is locked or unavailable. Unlock the Mac before starting this operation.",
    );
}
