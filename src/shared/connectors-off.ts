/**
 * Connectors (MCP server ids) the user turned off for one conversation
 * (`agentConfig.connectorsOff`). The list only ever narrows what a task may call.
 */

/** Union of lists, in first-seen order, without blanks or repeats. */
export function mergeConnectorsOff(
  ...lists: ReadonlyArray<readonly string[] | undefined | null>
): string[] {
  const merged: string[] = [];
  for (const list of lists) {
    for (const id of list || []) {
      if (typeof id === "string" && id.trim() && !merged.includes(id)) merged.push(id);
    }
  }
  return merged;
}

/** The list after turning one connector off or back on. */
export function withConnectorOff(
  current: readonly string[] | undefined,
  connectorId: string,
  off: boolean,
): string[] {
  const list = mergeConnectorsOff(current);
  return off ? mergeConnectorsOff(list, [connectorId]) : list.filter((id) => id !== connectorId);
}

/** `{ connectorsOff }` for a config merge: the union of the lists, or nothing when empty. */
export function connectorsOffField(...lists: ReadonlyArray<readonly string[] | undefined | null>): {
  connectorsOff?: string[];
} {
  const merged = mergeConnectorsOff(...lists);
  return merged.length > 0 ? { connectorsOff: merged } : {};
}
