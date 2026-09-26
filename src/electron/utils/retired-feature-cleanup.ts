import fs from "fs";
import os from "os";
import path from "path";

const LEGACY_HEALTH_BRIDGE_TEMP_DIR = /^cowork-healthkit-[A-Za-z0-9]{6}$/;
const LEGACY_HEALTH_BRIDGE_FILES = new Set(["request.json", "response.json"]);

/**
 * Remove request/response files left by older HealthKit bridge launches.
 * Only folders that contain nothing but the bridge's own files are removed.
 */
export function removeLegacyHealthBridgeTempDirs(
  tempRoot: string = os.tmpdir(),
  platform: NodeJS.Platform = process.platform,
): number {
  if (platform !== "darwin") return 0;

  let removed = 0;
  for (const entry of fs.readdirSync(tempRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !LEGACY_HEALTH_BRIDGE_TEMP_DIR.test(entry.name)) continue;

    const tempDir = path.join(tempRoot, entry.name);
    try {
      const children = fs.readdirSync(tempDir, { withFileTypes: true });
      if (
        !children.every((child) => child.isFile() && LEGACY_HEALTH_BRIDGE_FILES.has(child.name))
      ) {
        continue;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
      removed += 1;
    } catch {
      // One unreadable folder must not stop cleanup of the others; retry next launch.
    }
  }
  return removed;
}
