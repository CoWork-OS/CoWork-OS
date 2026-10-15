import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/** Screenshot existence is artifact evidence only, never evidence of a remote business outcome. */
export function verifiedPhoneScreenshotPath(
  tool: string,
  input: Any,
  result: Any,
  taskId: string | undefined,
  workspacePath: string,
): string | null {
  if (
    !(
      tool === "android_phone_observe" ||
      (tool === "application_operation" && ["execute", "reconcile"].includes(input?.action))
    ) ||
    !taskId ||
    result?.screenshot?.taskId !== taskId ||
    result?.path !== result?.screenshot?.path ||
    !/^[a-f0-9]{64}$/.test(result?.screenshot?.sha256 || "") ||
    !/^[a-f0-9-]{36}$/.test(result?.captureId || "")
  )
    return null;
  const filename = result.path;
  let fd: number | undefined;
  try {
    if (
      path.basename(filename) !== `android-screen-${result.captureId}.png` ||
      fs.realpathSync(path.dirname(filename)) !== fs.realpathSync(workspacePath)
    )
      return null;
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size < 8 ||
      stat.size > 12 * 1024 * 1024 ||
      stat.size !== result.screenshot.size
    )
      return null;
    const bytes = fs.readFileSync(fd);
    return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      createHash("sha256").update(bytes).digest("hex") === result.screenshot.sha256
      ? filename
      : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
