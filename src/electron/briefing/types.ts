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
  | "channel_digest";

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
    channel_digest: false,
  },
  enabled: false,
};

export interface DailyBriefingServiceDeps {
  /** Query tasks from the last N hours */
  getRecentTasks: (workspaceId: string, sinceMs: number) => any[];
  /** Search memory for recent items */
  searchMemory: (workspaceId: string, query: string, limit: number) => any[];
  /** Get active suggestions */
  getActiveSuggestions: (workspaceId: string) => any[];
  /** Get priorities from .cowork/PRIORITIES.md */
  getPriorities: (workspaceId: string) => string | null;
  /** Get upcoming cron jobs */
  getUpcomingJobs: (limit: number) => any[];
  /** Get open loops from daily log */
  getOpenLoops: (workspaceId: string) => string[];
  /** Deliver to channel */
  deliverToChannel?: (params: {
    channelType: string;
    channelId: string;
    text: string;
  }) => Promise<void>;
  log?: (...args: unknown[]) => void;
}
