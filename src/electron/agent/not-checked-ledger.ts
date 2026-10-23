import type { ToolCoverage } from "../../shared/types";

/** One search, list or query that did not cover everything it was asked to check. */
export interface NotCheckedEntry {
  tool: string;
  scope?: string;
  reason: string;
}

const MAX_ENTRIES = 20;
const MAX_LISTED = 6;

function textField(input: unknown, keys: readonly string[]): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 120);
  }
  return undefined;
}

/** "for "invoice" in src/" from the call's query or pattern and its path. */
function describeScope(input: unknown): string | undefined {
  const query = textField(input, ["query", "pattern", "q", "search"]);
  const where = textField(input, ["path", "directory", "dir", "cwd", "folder"]);
  const parts = [query ? `for "${query}"` : "", where ? `in ${where}` : ""].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/**
 * The checks a task could not complete, for the fixed "Not checked" block of its summary. A later
 * complete result for the same tool and scope settles an earlier partial one.
 */
export class NotCheckedLedger {
  private readonly entries = new Map<string, NotCheckedEntry>();

  /** Record a result's coverage: `partial` adds an entry, `complete` settles the same scope. */
  recordCoverage(tool: string, input: unknown, coverage: ToolCoverage | undefined): void {
    if (!coverage) return;
    const scope = describeScope(input);
    const key = `${tool}\n${scope ?? ""}`;
    if (coverage.status === "complete") {
      this.entries.delete(key);
      return;
    }
    if (coverage.status !== "partial") return;
    this.add(key, { tool, ...(scope ? { scope } : {}), reason: coverage.reason || "partial" });
  }

  /** A check the runtime refused to run (for example an exhausted search budget). */
  recordBlocked(tool: string, input: unknown, reason: string): void {
    const scope = describeScope(input);
    this.add(`${tool}\n${scope ?? ""}\nblocked`, {
      tool,
      ...(scope ? { scope } : {}),
      reason: `not run: ${reason.slice(0, 200)}`,
    });
  }

  list(): NotCheckedEntry[] {
    return [...this.entries.values()];
  }

  /** The summary block, or "" when every check covered its scope. */
  render(): string {
    const entries = this.list();
    if (entries.length === 0) return "";
    const lines = entries
      .slice(0, MAX_LISTED)
      .map((entry) => `- ${entry.tool}${entry.scope ? ` ${entry.scope}` : ""}: ${entry.reason}`);
    if (entries.length > MAX_LISTED) lines.push(`- and ${entries.length - MAX_LISTED} more`);
    return [
      "Not checked:",
      ...lines,
      "A missing result from these checks does not mean the thing is absent.",
    ].join("\n");
  }

  private add(key: string, entry: NotCheckedEntry): void {
    if (this.entries.has(key)) return;
    if (this.entries.size >= MAX_ENTRIES) return;
    this.entries.set(key, entry);
  }
}
