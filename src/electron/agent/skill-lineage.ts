/**
 * Bundled skill lineage: recognises managed skills that are unmodified copies of a bundled
 * skill version CoWork shipped earlier.
 *
 * Older app versions wrote bundled skills into the managed skills folder (the first-run
 * sample skills, edits and toggles saved through the loader, SkillHub installs of an id that
 * is also bundled). Those copies carry no user changes, but because managed skills outrank
 * bundled ones they hide every later bundled update of the same id. The lineage index lists
 * a digest of each shipped version, built by scripts/qa/build-bundled-skill-lineage.mjs.
 */

import { createHash } from "crypto";
import type { CustomSkill } from "../../shared/types";
import lineageIndex from "./bundled-skill-lineage.json";

/** Fields the app adds or a toggle changes; they are not part of a skill's content. */
const IGNORED_FIELDS = new Set(["filePath", "source", "enabled"]);
const DIGEST_LENGTH = 16;

const shippedDigests: Record<string, readonly string[]> =
  (lineageIndex as { skills?: Record<string, string[]> }).skills || {};

function canonicalize(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, depth + 1));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (depth === 0 && IGNORED_FIELDS.has(key)) continue;
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) continue;
      output[key] = canonicalize(entry, depth + 1);
    }
    return output;
  }
  return value;
}

/** Content digest of a skill manifest; must match the lineage build script. */
export function computeSkillManifestDigest(manifest: object): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(manifest)))
    .digest("hex")
    .slice(0, DIGEST_LENGTH);
}

/**
 * True when `managed` is an unmodified copy of the bundled skill `bundled`: either its
 * current version or one recorded in the lineage index. A managed skill with any other
 * content is treated as the user's own and keeps overriding the bundled one.
 */
export function isStaleBundledSnapshot(managed: CustomSkill, bundled: CustomSkill): boolean {
  if (managed.id !== bundled.id) return false;
  const digest = computeSkillManifestDigest(managed);
  if (digest === computeSkillManifestDigest(bundled)) return true;
  return (shippedDigests[bundled.id] || []).includes(digest);
}
