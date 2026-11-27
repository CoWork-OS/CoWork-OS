// Effects in the task view re-run after every composer keystroke. A setState that leaves the
// value unchanged (including a functional updater that returns `prev`) still queues a render,
// and in a running session those renders stacked until React aborted with "Maximum update
// depth exceeded" and dropped the typed key. These helpers decide up front whether an
// update is needed at all.

/** True when a row that had a measured-height signature changed or left the feed. */
export function feedRowSignaturesChanged(
  previous: ReadonlyMap<string, string>,
  active: ReadonlyMap<string, string>,
): boolean {
  for (const [key, signature] of previous) {
    if (active.get(key) !== signature) return true;
  }
  return false;
}

type MentionSpanLike = { start: number; end: number; mention: { label: string } };

/** Drops spans whose text no longer reads `@label`; returns `spans` itself when all hold. */
export function pruneStaleMentionSpans<T extends MentionSpanLike>(value: string, spans: T[]): T[] {
  const next = spans.filter(
    (span) =>
      span.end <= value.length && value.slice(span.start, span.end) === `@${span.mention.label}`,
  );
  return next.length === spans.length ? spans : next;
}
