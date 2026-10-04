/**
 * Process-wide version counter for "hot" memory: curated entries, the user
 * profile and relationship items. Prompt builders cache the compact L0 block per
 * task and rebuild it when this version changes, so a curated memory edit or a
 * profile edit shows up on the next turn without re-reading memory every turn.
 */
let hotMemoryVersion = 0;

export function getHotMemoryVersion(): number {
  return hotMemoryVersion;
}

export function bumpHotMemoryVersion(): number {
  hotMemoryVersion += 1;
  return hotMemoryVersion;
}
