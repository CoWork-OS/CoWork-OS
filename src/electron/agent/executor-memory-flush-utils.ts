/**
 * Parsing helpers for the pre-compaction memory flush, which copies the
 * "Decisions", "Open Loops" and "Next Actions" bullets of a flush summary into
 * the kit daily log.
 */

const FLUSH_SECTION_LABEL =
  /^(decisions|open loops|next actions|goals|key findings|key facts)\s*:/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Bullets ("- ...") listed under `label:` in `summary`, up to the next section
 * label or the first blank line after a bullet.
 */
export function parseFlushSectionBullets(summary: string, label: string): string[] {
  const lines = String(summary || "").split("\n");
  const headerRe = new RegExp(`^\\s*${escapeRegExp(label)}\\s*:\\s*$`, "i");
  const startIdx = lines.findIndex((line) => headerRe.test(line));
  if (startIdx === -1) return [];

  const out: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      // Stop at a blank line once something was captured.
      if (out.length > 0) break;
      continue;
    }
    // Stop at the next section label.
    if (FLUSH_SECTION_LABEL.test(trimmed)) break;
    if (trimmed.startsWith("-")) out.push(trimmed);
  }
  return out;
}

/** `- [flush HH:MM] text` lines; empty bullets are dropped. */
export function formatFlushBullets(bullets: string[], hhmm: string): string[] {
  return bullets
    .map((bullet) => bullet.replace(/^[-\s]+/, "").trim())
    .filter(Boolean)
    .map((text) => `- [flush ${hhmm}] ${text}`);
}
