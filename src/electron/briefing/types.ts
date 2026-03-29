/**
 * Daily Briefing types — unified morning summary composing
 * task summaries, memory highlights, suggestions, and priorities.
 */

export type BriefingSectionType =
  | "task_summary"
  | "memory_highlights"
  | "active_suggestions"
  | "priority_review"
  | "upcoming_jobs"
  | "open_loops"
  | "awareness_digest"
  | "mailbox_summary"
  | "evolution_metrics";

export interface BriefingItem {
  label: string;
  detail?: string;
  status?: "completed" | "failed" | "pending" | "running" | "info";
  link?: { taskId?: string; url?: string };
}

export interface BriefingSection {
  type: BriefingSectionType;
  title: string;
  items: BriefingItem[];
  enabled: boolean;
}

export interface Briefing {
  id: string;
  workspaceId: string;
  generatedAt: number;
  sections: BriefingSection[];
  delivered: boolean;
}

export interface BriefingConfig {
  /** Cron-style time to generate briefing (HH:MM, 24h format) */
  scheduleTime: string;
  /** Which sections to include */
  enabledSections: Record<BriefingSectionType, boolean>;
  /** Optional channel to deliver to */
  deliveryChannelType?: string;
  deliveryChannelId?: string;
  /** Master enable/disable */
  enabled: boolean;
}

export const DEFAULT_BRIEFING_CONFIG: BriefingConfig = {
  scheduleTime: "08:00",
  enabledSections: {
    task_summary: true,
    memory_highlights: true,
    active_suggestions: true,
    priority_review: true,
    upcoming_jobs: true,
  open_loops: true,
  awareness_digest: true,
  mailbox_summary: true,
  evolution_metrics: true,
  },
  enabled: false,
};

export interface DailyBriefingServiceDeps {
  /** Query tasks from the last N hours */
  getRecentTasks: (workspaceId: string, sinceMs: number) => Any[];
  /** Search memory for recent items */
  searchMemory: (workspaceId: string, query: string, limit: number) => Any[];
  /** Get active suggestions */
  getActiveSuggestions: (workspaceId: string) => Any[];
  /** Get priorities from .cowork/PRIORITIES.md */
  getPriorities: (workspaceId: string) => string | null;
  /** Get upcoming cron jobs */
  getUpcomingJobs: (workspaceId: string, limit: number) => Any[] | Promise<Any[]>;
  /** Get open loops from daily log */
  getOpenLoops: (workspaceId: string) => string[];
  /** Awareness summary for digest generation */
  getAwarenessSummary?: (workspaceId: string) => Any | Promise<Any | null>;
  /** Mailbox digest for inbox summary generation */
  getMailboxDigest?: (workspaceId: string) => Any | Promise<Any | null>;
  /** Chief-of-staff world model */
  getAutonomyState?: (workspaceId: string) => Any | Promise<Any | null>;
  /** Pending chief-of-staff interventions */
  getAutonomyDecisions?: (workspaceId: string) => Any[] | Promise<Any[]>;
  /** Best-effort suggestion refresh before briefing generation */
  refreshSuggestions?: (workspaceId: string) => Promise<void>;
  /** Deliver to channel */
  deliverToChannel?: (params: {
    channelType: string;
    channelId: string;
    text: string;
  }) => Promise<void>;
  log?: (...args: unknown[]) => void;
}
