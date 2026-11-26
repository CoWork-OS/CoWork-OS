import type { Task } from "../../../shared/types";

/**
 * The sidebar's "Group by activity" view: sessions that need you first, then the rest by day
 * across every project, each finished session with a line from its last result.
 */

export const ACTIVITY_NEEDS_YOU_GROUP = "Needs you";

/** Longest result line shown under a session, in characters. */
export const SIDEBAR_RESULT_SNIPPET_CHARS = 140;

export interface ActivityGroup<T> {
  label: string;
  nodes: T[];
}

/**
 * Split sessions into "Needs you" and day buckets, keeping the order they come in (the sidebar
 * passes them newest first). Empty groups are left out.
 */
export function groupSessionsByActivity<T extends { task: Task }>(
  nodes: readonly T[],
  options: {
    needsYou: (node: T) => boolean;
    dayBucket: (task: Task) => string;
  },
): ActivityGroup<T>[] {
  const needsYou: T[] = [];
  const buckets = new Map<string, T[]>();
  for (const node of nodes) {
    if (options.needsYou(node)) {
      needsYou.push(node);
      continue;
    }
    const label = options.dayBucket(node.task);
    const bucket = buckets.get(label);
    if (bucket) bucket.push(node);
    else buckets.set(label, [node]);
  }
  return [
    ...(needsYou.length > 0 ? [{ label: ACTIVITY_NEEDS_YOU_GROUP, nodes: needsYou }] : []),
    ...[...buckets].map(([label, grouped]) => ({ label, nodes: grouped })),
  ];
}

const FINISHED_STATUSES: ReadonlySet<Task["status"]> = new Set(["completed", "failed"]);

/**
 * One plain line from a finished session's last result, or null. Markdown marks, links and
 * code fences are reduced to their text; the line is cut at a word near the limit.
 */
export function sidebarResultSnippet(
  task: Pick<Task, "status" | "resultSummary" | "bestKnownOutcome" | "semanticSummary">,
): string | null {
  if (!FINISHED_STATUSES.has(task.status)) return null;
  const source = [task.resultSummary, task.bestKnownOutcome?.resultSummary, task.semanticSummary]
    .map((value) => (typeof value === "string" ? value : ""))
    .find((value) => value.trim().length > 0);
  if (!source) return null;
  const lines = source
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .split(/\r?\n/)
    .map((candidate) => ({
      heading: /^\s{0,3}#{1,6}\s/.test(candidate),
      text: candidate
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, "")
        .replace(/[*_`~]+/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    }))
    .filter((candidate) => candidate.text.length > 0);
  // A heading such as "Summary" says little; prefer the first sentence under it.
  const line = (lines.find((candidate) => !candidate.heading) ?? lines[0])?.text;
  if (!line) return null;
  if (line.length <= SIDEBAR_RESULT_SNIPPET_CHARS) return line;
  const cut = line.slice(0, SIDEBAR_RESULT_SNIPPET_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > SIDEBAR_RESULT_SNIPPET_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
