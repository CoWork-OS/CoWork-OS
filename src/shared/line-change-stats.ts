export interface LineChangeStats {
  added: number;
  removed: number;
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.replace(/\r?\n$/, "").split(/\r?\n/);
}

/**
 * Approximate "+added −removed" line counts between two versions of a text.
 * Lines are matched as a multiset, so moved lines count as unchanged; that keeps it linear
 * and close to a real diff for the feed's file rows without a full diff algorithm.
 */
export function countLineChanges(before: string, after: string): LineChangeStats {
  const remaining = new Map<string, number>();
  for (const line of splitLines(before)) {
    remaining.set(line, (remaining.get(line) ?? 0) + 1);
  }
  let added = 0;
  for (const line of splitLines(after)) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) {
      remaining.set(line, count - 1);
    } else {
      added += 1;
    }
  }
  let removed = 0;
  for (const count of remaining.values()) removed += count;
  return { added, removed };
}
