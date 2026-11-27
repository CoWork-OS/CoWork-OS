/**
 * The files open in the side panel, as tabs. One file shows at a time; the tabs let you go back
 * to the others without finding them in the conversation again.
 */

export type ArtifactTabKind = "spreadsheet" | "document" | "presentation" | "webpage";

export interface ArtifactTab {
  kind: ArtifactTabKind;
  path: string;
}

/** Opening more drops the least recently opened tab that isn't showing. */
export const MAX_ARTIFACT_TABS = 8;

/** Open a file: its tab if it has one, else a new tab at the end. */
export function addArtifactTab(
  tabs: readonly ArtifactTab[],
  tab: ArtifactTab,
  activePath?: string | null,
): ArtifactTab[] {
  if (tabs.some((existing) => existing.path === tab.path)) {
    return tabs.map((existing) => (existing.path === tab.path ? tab : existing));
  }
  const next = [...tabs, tab];
  while (next.length > MAX_ARTIFACT_TABS) {
    const dropAt = next.findIndex((entry) => entry.path !== activePath && entry !== tab);
    if (dropAt < 0) break;
    next.splice(dropAt, 1);
  }
  return next;
}

/** Close a tab; `neighbor` is the tab to show instead (the one to its right, else its left). */
export function removeArtifactTab(
  tabs: readonly ArtifactTab[],
  path: string,
): { tabs: ArtifactTab[]; neighbor: ArtifactTab | null } {
  const index = tabs.findIndex((tab) => tab.path === path);
  if (index < 0) return { tabs: [...tabs], neighbor: null };
  const next = tabs.filter((_, position) => position !== index);
  return { tabs: next, neighbor: next[index] ?? next[index - 1] ?? null };
}

function splitPath(filePath: string): string[] {
  return filePath.split(/[\\/]/).filter(Boolean);
}

/**
 * Each tab's label: the file name, with as much of its folder as it takes to tell two files
 * with the same name apart ("a/notes.md", "b/notes.md").
 */
export function artifactTabLabels(tabs: readonly ArtifactTab[]): Map<string, string> {
  const labels = new Map<string, string>();
  const parts = tabs.map((tab) => splitPath(tab.path));
  tabs.forEach((tab, index) => {
    const own = parts[index];
    let depth = 1;
    const sameTail = (other: string[], count: number) =>
      other.slice(-count).join("/") === own.slice(-count).join("/");
    while (
      depth < own.length &&
      parts.some((other, otherIndex) => otherIndex !== index && sameTail(other, depth))
    ) {
      depth += 1;
    }
    labels.set(tab.path, own.slice(-depth).join("/") || tab.path);
  });
  return labels;
}

/** Asks before leaving a file with unsaved changes; true when it's fine to leave. */
export function confirmLeaveArtifact(filePath: string, hasUnsavedChanges: boolean): boolean {
  if (!hasUnsavedChanges) return true;
  const name = splitPath(filePath).at(-1) || filePath;
  return window.confirm(
    `Discard unsaved changes to "${name}"?\nCancel keeps it open so you can save your changes.`,
  );
}
