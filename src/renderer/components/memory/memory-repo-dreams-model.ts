/**
 * Dreams over the memory folder as the Memory Hub shows them (docs/memory-repo-phase2-design.md
 * §7): the preload methods, and the text of the card's last-dream line, the cost notice and
 * the "Dream now" result. Pure functions, tested directly.
 */
import type {
  MemoryRepoDreamActionResult,
  MemoryRepoDreamNowResult,
  MemoryRepoDreamPart,
  MemoryRepoDreamSummary,
  MemoryRepoDreamsReport,
} from "../../../shared/memory-repo-types";
import { formatRelative } from "./memory-knowledge-model";

/** The preload methods of the dream review surface (injected in tests). */
export type MemoryRepoDreamsApi = {
  getMemoryRepoDreams: () => Promise<MemoryRepoDreamsReport>;
  getMemoryRepoDreamDiff: (id: string, part: MemoryRepoDreamPart) => Promise<string>;
  acceptMemoryRepoDream: (id: string) => Promise<MemoryRepoDreamActionResult>;
  rejectMemoryRepoDream: (id: string) => Promise<MemoryRepoDreamActionResult>;
  undoMemoryRepoDream: (id: string) => Promise<MemoryRepoDreamActionResult>;
};

export const MEMORY_REPO_DREAM_METHODS = [
  "getMemoryRepoDreams",
  "getMemoryRepoDreamDiff",
  "acceptMemoryRepoDream",
  "rejectMemoryRepoDream",
  "undoMemoryRepoDream",
] as const;

const SKIP_REASONS: Record<string, string> = {
  budget: "skipped, today's token budget is used up",
  unavailable: "the memory folder is not available",
  no_git: "git was not found",
  disabled: "dreaming is off",
  not_due: "not due yet",
  nothing_new: "nothing new since the last dream",
  busy: "another dream is running",
  failed: "failed",
};

export function dreamSkipReason(reason: string | undefined): string {
  return (reason && SKIP_REASONS[reason]) || reason || "skipped";
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The cost notice of the Dreaming subsection. */
export function dreamCostNotice(dailyBudget: number): string {
  return `Dreaming uses your model provider and costs tokens (up to ${dailyBudget.toLocaleString("en-US")} tokens/day). It runs about once a day and when you press Dream now.`;
}

/** What one dream did, after its time: applied and waiting counts, or why it did nothing. */
export function dreamOutcomeText(dream: MemoryRepoDreamSummary): string {
  if (dream.status === "failed") return `failed: ${dream.error || "unknown error"}`;
  if (dream.status === "skipped") return dreamSkipReason(dream.skipReason);
  const parts = [`${dream.autoCount} applied`];
  if (dream.reviewStatus === "pending") parts.push(`${dream.reviewCount} waiting for review`);
  else if (dream.reviewCount > 0 && dream.reviewStatus) {
    parts.push(
      `${dream.reviewCount} ${dream.reviewStatus === "stale" ? "out of date" : dream.reviewStatus}`,
    );
  }
  if (dream.undone) parts.push("undone");
  return parts.join(", ");
}

/** "Last dream 2h ago: 3 applied, 2 waiting for review", or that none ran yet. */
export function dreamLastLine(report: MemoryRepoDreamsReport | null): string {
  const last = report?.dreams[0];
  if (!last) return "No dream yet.";
  return `Last dream ${formatRelative(last.startedAt)}: ${dreamOutcomeText(last)}.`;
}

export function dreamTokensLine(report: MemoryRepoDreamsReport): string {
  return `${report.tokensUsedToday.toLocaleString("en-US")} of ${report.dailyBudget.toLocaleString("en-US")} tokens used in the last 24 hours.`;
}

/** The message after "Dream now". */
export function dreamNowMessage(result: MemoryRepoDreamNowResult): {
  tone: "success" | "error";
  text: string;
} {
  if (result.ran && result.dream) {
    const dream = result.dream;
    const text =
      dream.autoCount === 0 && dream.reviewCount === 0
        ? "Dream finished: nothing to change."
        : `Dream finished: ${plural(dream.autoCount, "change", "changes")} applied, ${dream.reviewCount} waiting for review in the Review tab.`;
    return { tone: "success", text };
  }
  if (result.reason === "failed") {
    return {
      tone: "error",
      text: `Dream failed: ${result.error || result.dream?.error || "unknown error"}`,
    };
  }
  return { tone: "error", text: `No dream ran: ${dreamSkipReason(result.reason)}.` };
}

/** The CSS modifier of one diff line. */
export function dreamDiffLineKind(line: string): "add" | "del" | "meta" | "context" {
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("@@")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

/** Pending review proposals and automatic changes, as the Review tab lists them. */
export function splitDreams(report: MemoryRepoDreamsReport | null): {
  pending: MemoryRepoDreamSummary[];
  automatic: MemoryRepoDreamSummary[];
} {
  const dreams = report?.dreams ?? [];
  return {
    pending: dreams.filter((dream) => dream.reviewStatus === "pending"),
    automatic: dreams.filter((dream) => dream.autoCount > 0).slice(0, 10),
  };
}

/** The message of an error from main, without Electron's "Error invoking remote method" prefix. */
export function dreamErrorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const cleaned = raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, "").trim();
  return cleaned || fallback;
}
