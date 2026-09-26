import type { ReleaseBriefCheck } from "./verify-release-brief";

export function applyRevisionContract(
  check: ReleaseBriefCheck,
  baseHashes: Record<string, string> | null,
): ReleaseBriefCheck {
  if (!check.passed) return check;
  if (
    !baseHashes ||
    check.artifactHashes["release-brief.html"] === baseHashes["release-brief.html"]
  ) {
    return {
      ...check,
      passed: false,
      errors: [...check.errors, "The release brief has not changed since the revision request"],
    };
  }
  return check;
}
