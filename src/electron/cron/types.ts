/**
 * Cron/Scheduled Task Types for CoWork-OSS
 */

/**
 * Schedule type definitions:
 * - "at": Run once at a specific timestamp
 * - "every": Run at regular intervals
 * - "cron": Use standard cron expression
 */
export type CronSchedule =
  | { kind: 'at'; atMs: number }
  | { kind: 'every'; everyMs: number; anchorMs?: number }
  | { kind: 'cron'; expr: string; tz?: string };

/**
 * Job status after execution
 */
export type CronJobStatus = 'ok' | 'error' | 'skipped' | 'timeout';

/**
 * Single run history entry
 */
export interface CronRunHistoryEntry {
  runAtMs: number;
  durationMs: number;
  status: CronJobStatus;
  error?: string;
  taskId?: string;
}

/**
 * Runtime state of a cron job
 */
export interface CronJobState {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: CronJobStatus;
  lastError?: string;
  lastDurationMs?: number;
  lastTaskId?: string;
  // Run history (most recent first, limited to maxHistoryEntries)
  runHistory?: CronRunHistoryEntry[];
  // Execution stats
  totalRuns?: number;
  successfulRuns?: number;
  failedRuns?: number;
}

/**
 * Channel delivery configuration for cron job results
 */
export interface CronDeliveryConfig {
  enabled: boolean;
  channelType?: 'telegram' | 'discord' | 'slack' | 'whatsapp';
  channelId?: string; // The channel/chat ID to deliver to
  deliverOnSuccess?: boolean;
  deliverOnError?: boolean;
  summaryOnly?: boolean; // Only send a summary, not the full result
}

/**
 * Full cron job definition
 */
export interface CronJob {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean; // For one-shot jobs
  createdAtMs: number;
  updatedAtMs: number;
  schedule: CronSchedule;
  // Task configuration
  workspaceId: string; // Which workspace to run the task in
  taskPrompt: string; // The prompt to send to the agent
  taskTitle?: string; // Optional title for the created task
  // Advanced options
  timeoutMs?: number; // Maximum execution time (default: no timeout)
  modelKey?: string; // Specific model to use (e.g., 'sonnet-3-5', 'opus-3')
  maxHistoryEntries?: number; // Max run history entries to keep (default: 10)
  // Channel delivery
  delivery?: CronDeliveryConfig;
  // Runtime state
  state: CronJobState;
}

/**
 * File format for persisting cron jobs
 */
export interface CronStoreFile {
  version: 1;
  jobs: CronJob[];
}

/**
 * Input for creating a new cron job
 */
export type CronJobCreate = Omit<CronJob, 'id' | 'createdAtMs' | 'updatedAtMs' | 'state'> & {
  state?: Partial<CronJobState>;
};

/**
 * Input for updating an existing cron job
 */
export type CronJobPatch = Partial<Omit<CronJob, 'id' | 'createdAtMs' | 'state'>> & {
  state?: Partial<CronJobState>;
};

/**
 * Event emitted when job status changes
 */
export interface CronEvent {
  jobId: string;
  action: 'added' | 'updated' | 'removed' | 'started' | 'finished';
  runAtMs?: number;
  durationMs?: number;
  status?: CronJobStatus;
  error?: string;
  taskId?: string; // ID of the created task
  nextRunAtMs?: number;
}

/**
 * Dependencies required by the cron service
 */
export interface CronServiceDeps {
  nowMs?: () => number;
  storePath: string;
  cronEnabled: boolean;
  maxConcurrentRuns?: number; // Max jobs that can run at once (default: 1)
  defaultTimeoutMs?: number; // Default job timeout (default: 30 minutes)
  maxHistoryEntries?: number; // Default max history entries per job (default: 10)
  webhook?: CronWebhookConfig; // Webhook server configuration
  createTask: (params: {
    title: string;
    prompt: string;
    workspaceId: string;
    modelKey?: string; // Optional model override
  }) => Promise<{ id: string }>;
  // Channel delivery handler for sending results to messaging platforms
  deliverToChannel?: (params: {
    channelType: 'telegram' | 'discord' | 'slack' | 'whatsapp';
    channelId: string;
    jobName: string;
    status: CronJobStatus;
    taskId?: string;
    error?: string;
    summaryOnly?: boolean;
  }) => Promise<void>;
  onEvent?: (evt: CronEvent) => void;
  log?: {
    debug: (msg: string, data?: unknown) => void;
    info: (msg: string, data?: unknown) => void;
    warn: (msg: string, data?: unknown) => void;
    error: (msg: string, data?: unknown) => void;
  };
}

/**
 * Webhook server configuration
 */
export interface CronWebhookConfig {
  enabled: boolean;
  port: number;
  host?: string;
  secret?: string; // Authentication secret for webhook requests
}

/**
 * Status summary returned by the service
 */
export interface CronStatusSummary {
  enabled: boolean;
  storePath: string;
  jobCount: number;
  enabledJobCount: number;
  runningJobCount: number;
  maxConcurrentRuns: number;
  nextWakeAtMs: number | null;
  webhook?: {
    enabled: boolean;
    host: string;
    port: number;
  };
}

/**
 * Run history query result
 */
export interface CronRunHistoryResult {
  jobId: string;
  jobName: string;
  entries: CronRunHistoryEntry[];
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
}

/**
 * Result types for service operations
 */
export type CronRunResult =
  | { ok: true; ran: true; taskId: string }
  | { ok: true; ran: false; reason: 'not-due' | 'disabled' | 'not-found' }
  | { ok: false; error: string };

export type CronRemoveResult = { ok: true; removed: boolean } | { ok: false; removed: false; error: string };

export type CronAddResult = { ok: true; job: CronJob } | { ok: false; error: string };
export type CronUpdateResult = { ok: true; job: CronJob } | { ok: false; error: string };
export type CronListResult = CronJob[];

/**
 * Human-friendly schedule description
 */
export function describeSchedule(schedule: CronSchedule): string {
  switch (schedule.kind) {
    case 'at': {
      const date = new Date(schedule.atMs);
      return `Once at ${date.toLocaleString()}`;
    }
    case 'every': {
      const ms = schedule.everyMs;
      if (ms >= 86400000) {
        const days = Math.round(ms / 86400000);
        return `Every ${days} day${days > 1 ? 's' : ''}`;
      }
      if (ms >= 3600000) {
        const hours = Math.round(ms / 3600000);
        return `Every ${hours} hour${hours > 1 ? 's' : ''}`;
      }
      if (ms >= 60000) {
        const minutes = Math.round(ms / 60000);
        return `Every ${minutes} minute${minutes > 1 ? 's' : ''}`;
      }
      return `Every ${Math.round(ms / 1000)} seconds`;
    }
    case 'cron': {
      // Common cron expressions with friendly names
      const commonPatterns: Record<string, string> = {
        '0 * * * *': 'Every hour',
        '*/15 * * * *': 'Every 15 minutes',
        '*/30 * * * *': 'Every 30 minutes',
        '0 0 * * *': 'Daily at midnight',
        '0 9 * * *': 'Daily at 9:00 AM',
        '0 9 * * 1-5': 'Weekdays at 9:00 AM',
        '0 0 * * 0': 'Weekly on Sunday',
        '0 0 1 * *': 'Monthly on the 1st',
      };
      return commonPatterns[schedule.expr] || `Cron: ${schedule.expr}${schedule.tz ? ` (${schedule.tz})` : ''}`;
    }
  }
}

/**
 * Parse a human-friendly interval string into milliseconds
 * Examples: "5m", "1h", "30s", "1d"
 */
export function parseIntervalToMs(interval: string): number | null {
  const match = interval.trim().match(/^(\d+(?:\.\d+)?)\s*(s|sec|second|seconds|m|min|minute|minutes|h|hr|hour|hours|d|day|days)$/i);
  if (!match) return null;

  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case 's':
    case 'sec':
    case 'second':
    case 'seconds':
      return value * 1000;
    case 'm':
    case 'min':
    case 'minute':
    case 'minutes':
      return value * 60 * 1000;
    case 'h':
    case 'hr':
    case 'hour':
    case 'hours':
      return value * 60 * 60 * 1000;
    case 'd':
    case 'day':
    case 'days':
      return value * 24 * 60 * 60 * 1000;
    default:
      return null;
  }
}
