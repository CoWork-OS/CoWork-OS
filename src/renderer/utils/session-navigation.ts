/**
 * Keyboard navigation between sessions: the next session that wants the user, and the
 * session at a position in the sidebar list. The sidebar decides the order (pins, project
 * groups, day groups) and reports it, so the order is not rebuilt here.
 */

/** The parts of a sidebar list row that say which session it shows. */
export interface SidebarOrderRow {
  kind: string;
  section?: "user" | "automated";
  row?: { depth: number; node: { synthetic?: boolean; task: { id: string } } };
}

/**
 * Sessions in the sidebar's session list, top to bottom, as the sidebar lays them out
 * (including rows a long, virtualized list has not drawn). Sub-agent rows, group rows and
 * the automated-sessions drawer are skipped.
 */
export function sessionOrderFromSidebarRows(rows: readonly SidebarOrderRow[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of rows) {
    if (entry.kind !== "task" || !entry.row || entry.section === "automated") continue;
    if (entry.row.depth !== 0 || entry.row.node.synthetic) continue;
    const id = entry.row.node.task.id;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * The session to open for "next session that needs you": the first waiting session below the
 * current one in sidebar order, wrapping to the top. Waiting sessions the sidebar does not show
 * (collapsed group, filtered out, not loaded) come after the shown ones, in the order given.
 * Null when nothing is waiting, or when the only waiting session is the current one.
 */
export function nextAttentionSessionId(
  sidebarOrder: readonly string[],
  waiting: readonly string[],
  currentId: string | null | undefined,
): string | null {
  const waitingSet = new Set(waiting);
  const shown = sidebarOrder.filter((id) => waitingSet.has(id));
  const shownSet = new Set(shown);
  const candidates = [...shown, ...waiting.filter((id) => !shownSet.has(id))];
  const unique = [...new Set(candidates)];
  if (unique.length === 0) return null;
  const currentIndex = currentId ? unique.indexOf(currentId) : -1;
  if (currentIndex === -1) {
    // Not on a waiting session: take the first one below the current row, else the first.
    const currentRow = currentId ? sidebarOrder.indexOf(currentId) : -1;
    if (currentRow !== -1) {
      const below = shown.find((id) => sidebarOrder.indexOf(id) > currentRow);
      if (below) return below;
    }
    return unique[0];
  }
  if (unique.length === 1) return null;
  return unique[(currentIndex + 1) % unique.length];
}

/** The session at a 1-based position in the sidebar list, or null past the end. */
export function sessionIdAtPosition(
  sidebarOrder: readonly string[],
  position: number,
): string | null {
  if (!Number.isInteger(position) || position < 1) return null;
  return sidebarOrder[position - 1] ?? null;
}
