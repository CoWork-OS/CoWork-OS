import fs from "fs";
import os from "os";
import path from "path";

export interface PruneTempSandboxProfilesOptions {
  tmpDir?: string;
  nowMs?: number;
  maxAgeMs?: number;
}

export interface PruneTempSandboxProfilesResult {
  scanned: number;
  removed: number;
  kept: number;
}

const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const SANDBOX_PROFILE_FILE_PATTERNS = [
  /^cowork_sandbox_\d+\.sb$/i, // Legacy SandboxRunner profile naming
  /^cowork_[a-f0-9]{32}\.sb$/i, // Security utils temp profile naming
];

const isSandboxProfileFile = (fileName: string): boolean =>
  SANDBOX_PROFILE_FILE_PATTERNS.some((pattern) => pattern.test(fileName));

export function pruneTempSandboxProfiles(
  options: PruneTempSandboxProfilesOptions = {},
): PruneTempSandboxProfilesResult {
  const tmpDir = path.resolve(options.tmpDir ?? os.tmpdir());
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = Math.max(0, options.maxAgeMs ?? DEFAULT_MAX_AGE_MS);

  if (!fs.existsSync(tmpDir)) {
    return { scanned: 0, removed: 0, kept: 0 };
  }

  let scanned = 0;
  let removed = 0;
  let kept = 0;

  const entries = fs.readdirSync(tmpDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!isSandboxProfileFile(entry.name)) continue;

    scanned += 1;

    const fullPath = path.resolve(path.join(tmpDir, entry.name));
    if (!fullPath.startsWith(`${tmpDir}${path.sep}`)) {
      kept += 1;
      continue;
    }

    try {
      const stat = fs.statSync(fullPath);
      const ageMs = nowMs - (Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : stat.ctimeMs);
      if (ageMs > maxAgeMs) {
        fs.unlinkSync(fullPath);
        removed += 1;
      } else {
        kept += 1;
      }
    } catch {
      kept += 1;
    }
  }

  return { scanned, removed, kept };
}
