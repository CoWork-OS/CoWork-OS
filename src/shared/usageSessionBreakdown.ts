/**
 * Usage split by the kind of work it paid for, and the sessions that used the most, for the
 * Usage Insights panel. Built in the main process from `llm_call_events`; see
 * `src/electron/reports/usage-session-breakdown.ts`.
 */

export type UsageSessionCategory =
  | "yours"
  | "subagents"
  | "automated"
  | "bots"
  | "integrations"
  | "background"
  | "deleted";

export const USAGE_SESSION_CATEGORY_LABELS: Record<UsageSessionCategory, string> = {
  yours: "Your sessions",
  subagents: "Sub-agents",
  automated: "Scheduled and automated",
  bots: "Bots",
  integrations: "API and hooks",
  background: "Background work",
  deleted: "Deleted sessions",
};

/** What each category holds, for a tooltip. */
export const USAGE_SESSION_CATEGORY_HINTS: Record<UsageSessionCategory, string> = {
  yours: "Sessions you started, including from a suggestion or a side chat.",
  subagents: "Helper agents a session started.",
  automated: "Scheduled tasks, heartbeats and other work CoWork started on its own.",
  bots: "Conversations with bots and work given to a bot.",
  integrations: "Sessions started through the API or a hook.",
  background: "Model calls outside any session, such as inbox replies and memory summaries.",
  deleted: "Usage from sessions that have since been deleted.",
};

export interface UsageSessionCategoryRow {
  category: UsageSessionCategory;
  cost: number;
  /** Input plus output tokens. */
  tokens: number;
  calls: number;
  /** Sessions with usage in the period; 0 for background work. */
  sessions: number;
}

export interface UsageTopSessionRow {
  taskId: string;
  title: string;
  status: string | null;
  category: UsageSessionCategory;
  /** The session's own usage plus that of every sub-agent under it. */
  cost: number;
  tokens: number;
  calls: number;
  subagentCount: number;
}

export interface UsageSessionBreakdown {
  /** Categories with usage, most expensive first (most tokens when nothing was priced). */
  byCategory: UsageSessionCategoryRow[];
  /** Top-level sessions by cost, then tokens. */
  topSessions: UsageTopSessionRow[];
}

export const USAGE_TOP_SESSIONS_LIMIT = 5;
