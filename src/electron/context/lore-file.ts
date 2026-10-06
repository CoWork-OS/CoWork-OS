/**
 * `.cowork/LORE.md` edits of the `update_lore` tool. Milestones are plain list lines under
 * `## Milestones`, outside any generated block: the old `cowork:auto:lore` block is retired
 * and stripped once (docs/memory-repo-phase5-design.md §1).
 */

export type LoreSection = "milestones" | "references" | "notes";

export const LORE_SECTIONS: readonly LoreSection[] = ["milestones", "references", "notes"];

const SECTION_HEADINGS: Record<LoreSection, string> = {
  milestones: "## Milestones",
  references: "## Inside References",
  notes: "## Notes",
};

export function defaultLoreTemplate(): string {
  return [
    "# Shared Lore",
    "",
    "This file is workspace-local.",
    "It captures the shared history between you and the agent in this workspace.",
    "",
    "## Milestones",
    "- ",
    "",
    "## Inside References",
    "- ",
    "",
    "## Notes",
    "- ",
    "",
  ].join("\n");
}

/**
 * Add one line under the section's heading (a milestone is dated); a missing heading is
 * appended at the end. `entry` must already be a single sanitized line.
 */
export function appendLoreEntry(
  markdown: string,
  section: LoreSection,
  entry: string,
  dateStamp: string,
): string {
  const current = markdown || defaultLoreTemplate();
  const line = section === "milestones" ? `- [${dateStamp}] ${entry}` : `- ${entry}`;
  const heading = SECTION_HEADINGS[section];
  const headingIdx = current.search(new RegExp(`^${heading}$`, "m"));
  if (headingIdx >= 0) {
    const afterHeading = headingIdx + heading.length;
    return `${current.slice(0, afterHeading)}\n${line}${current.slice(afterHeading)}`;
  }
  return `${current.replace(/\n+$/, "")}\n\n${heading}\n${line}\n`;
}
