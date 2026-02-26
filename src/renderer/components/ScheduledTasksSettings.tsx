import { useState, useEffect, useCallback } from "react";
import { useAgentContext } from "../hooks/useAgentContext";

// Types from preload (duplicated for renderer use)
type CronSchedule =
  | { kind: "at"; atMs: number }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string };

interface CronDeliveryConfig {
  enabled: boolean;
  channelType?: string;
  channelDbId?: string;
  channelId?: string;
  deliverOnSuccess?: boolean;
  deliverOnError?: boolean;
  summaryOnly?: boolean;
  deliverOnlyIfResult?: boolean;
}

interface CronJobState {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: "ok" | "error" | "skipped" | "timeout";
  lastError?: string;
  lastDurationMs?: number;
  lastTaskId?: string;
  totalRuns?: number;
}

interface CronJob {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: CronSchedule;
  workspaceId: string;
  taskPrompt: string;
  taskTitle?: string;
  delivery?: CronDeliveryConfig;
  state: CronJobState;
}

interface CronStatusSummary {
  enabled: boolean;
  storePath: string;
  jobCount: number;
  enabledJobCount: number;
  nextWakeAtMs: number | null;
}

// Minimal Workspace type for the UI
interface Workspace {
  id: string;
  name: string;
  path: string;
}

// Schedule presets
const SCHEDULE_PRESETS = [
  { label: "Every 5 minutes", schedule: { kind: "every" as const, everyMs: 5 * 60 * 1000 } },
  { label: "Every 15 minutes", schedule: { kind: "every" as const, everyMs: 15 * 60 * 1000 } },
  { label: "Every 30 minutes", schedule: { kind: "every" as const, everyMs: 30 * 60 * 1000 } },
  { label: "Every hour", schedule: { kind: "every" as const, everyMs: 60 * 60 * 1000 } },
  { label: "Every 2 hours", schedule: { kind: "every" as const, everyMs: 2 * 60 * 60 * 1000 } },
  { label: "Every 6 hours", schedule: { kind: "every" as const, everyMs: 6 * 60 * 60 * 1000 } },
  { label: "Every 12 hours", schedule: { kind: "every" as const, everyMs: 12 * 60 * 60 * 1000 } },
  { label: "Daily", schedule: { kind: "every" as const, everyMs: 24 * 60 * 60 * 1000 } },
];

const CRON_PRESETS = [
  { label: "Every minute", value: "* * * * *", desc: "Runs every minute" },
  { label: "Every 5 minutes", value: "*/5 * * * *", desc: "At minutes 0, 5, 10..." },
  { label: "Every 15 minutes", value: "*/15 * * * *", desc: "At :00, :15, :30, :45" },
  { label: "Every hour", value: "0 * * * *", desc: "At the start of each hour" },
  { label: "Daily at midnight", value: "0 0 * * *", desc: "12:00 AM every day" },
  { label: "Daily at 9:00 AM", value: "0 9 * * *", desc: "9:00 AM every day" },
  { label: "Daily at 6:00 PM", value: "0 18 * * *", desc: "6:00 PM every day" },
  { label: "Weekdays at 9:00 AM", value: "0 9 * * 1-5", desc: "Mon-Fri at 9:00 AM" },
  { label: "Weekly on Monday", value: "0 0 * * 1", desc: "Every Monday at midnight" },
  { label: "Monthly on the 1st", value: "0 0 1 * *", desc: "1st day of month at midnight" },
];

// Icons as inline SVGs
const Icons = {
  clock: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  ),
  play: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  ),
  pause: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </svg>
  ),
  edit: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  ),
  trash: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  ),
  plus: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ),
  check: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
  x: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
  calendar: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  ),
  repeat: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="17 1 21 5 17 9" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 23 3 19 7 15" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  ),
  chevronDown: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  ),
  zap: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  ),
  activity: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  ),
  send: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  ),
};

function describeSchedule(schedule: CronSchedule): string {
  switch (schedule.kind) {
    case "at": {
      const date = new Date(schedule.atMs);
      return `Once at ${date.toLocaleString()}`;
    }
    case "every": {
      const ms = schedule.everyMs;
      if (ms >= 86400000) {
        const days = Math.round(ms / 86400000);
        return `Every ${days} day${days > 1 ? "s" : ""}`;
      }
      if (ms >= 3600000) {
        const hours = Math.round(ms / 3600000);
        return `Every ${hours} hour${hours > 1 ? "s" : ""}`;
      }
      if (ms >= 60000) {
        const minutes = Math.round(ms / 60000);
        return `Every ${minutes} minute${minutes > 1 ? "s" : ""}`;
      }
      return `Every ${Math.round(ms / 1000)} seconds`;
    }
    case "cron": {
      // Try to find a matching preset for friendly name
      const preset = CRON_PRESETS.find((p) => p.value === schedule.expr);
      return preset ? preset.label : schedule.expr;
    }
  }
}

function getScheduleIcon(schedule: CronSchedule) {
  if (schedule.kind === "at") return Icons.calendar;
  return Icons.repeat;
}

function formatRelativeTime(ms: number): string {
  const now = Date.now();
  const diff = ms - now;
  const absDiff = Math.abs(diff);
  const isPast = diff < 0;

  if (absDiff < 60000) {
    return isPast ? "just now" : "in < 1 min";
  }
  if (absDiff < 3600000) {
    const minutes = Math.round(absDiff / 60000);
    return isPast ? `${minutes}m ago` : `in ${minutes}m`;
  }
  if (absDiff < 86400000) {
    const hours = Math.round(absDiff / 3600000);
    return isPast ? `${hours}h ago` : `in ${hours}h`;
  }
  const days = Math.round(absDiff / 86400000);
  return isPast ? `${days}d ago` : `in ${days}d`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

// Styles
const styles = {
  container: {
    padding: 0,
    maxWidth: "100%",
    width: "100%",
  } as React.CSSProperties,
  statsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
    gap: "12px",
    marginBottom: "24px",
  } as React.CSSProperties,
  statCard: {
    backgroundColor: "var(--color-bg-glass)",
    border: "1px solid var(--color-border-subtle)",
    borderRadius: "var(--radius-md)",
    padding: "16px",
    display: "flex",
    flexDirection: "column" as const,
    gap: "4px",
  } as React.CSSProperties,
  statLabel: {
    fontSize: "12px",
    color: "var(--color-text-muted)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.5px",
  } as React.CSSProperties,
  statValue: {
    fontSize: "24px",
    fontWeight: 600,
    color: "var(--color-text-primary)",
  } as React.CSSProperties,
  jobCard: {
    backgroundColor: "var(--color-bg-glass)",
    border: "1px solid var(--color-border-subtle)",
    borderRadius: "var(--radius-md)",
    marginBottom: "12px",
    overflow: "hidden",
    transition: "all 0.2s ease",
  } as React.CSSProperties,
  jobHeader: {
    display: "flex",
    alignItems: "center",
    padding: "16px",
    gap: "12px",
    cursor: "pointer",
  } as React.CSSProperties,
  statusDot: {
    width: "10px",
    height: "10px",
    borderRadius: "50%",
    flexShrink: 0,
  } as React.CSSProperties,
  jobInfo: {
    flex: 1,
    minWidth: 0,
  } as React.CSSProperties,
  jobName: {
    fontSize: "15px",
    fontWeight: 500,
    color: "var(--color-text-primary)",
    marginBottom: "4px",
    display: "flex",
    alignItems: "center",
    gap: "8px",
  } as React.CSSProperties,
  jobMeta: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    fontSize: "13px",
    color: "var(--color-text-muted)",
  } as React.CSSProperties,
  scheduleTag: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    padding: "2px 8px",
    backgroundColor: "var(--color-bg-secondary)",
    borderRadius: "4px",
    fontSize: "12px",
  } as React.CSSProperties,
  nextRun: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "6px 12px",
    backgroundColor: "var(--color-accent-subtle)",
    color: "var(--color-accent)",
    borderRadius: "6px",
    fontSize: "13px",
    fontWeight: 500,
  } as React.CSSProperties,
  actions: {
    display: "flex",
    gap: "4px",
  } as React.CSSProperties,
  actionBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "32px",
    height: "32px",
    padding: 0,
    backgroundColor: "transparent",
    border: "1px solid var(--color-border-subtle)",
    borderRadius: "6px",
    color: "var(--color-text-secondary)",
    cursor: "pointer",
    transition: "all 0.15s ease",
  } as React.CSSProperties,
  expandedContent: {
    borderTop: "1px solid var(--color-border-subtle)",
    padding: "16px",
    backgroundColor: "var(--color-bg-darker)",
  } as React.CSSProperties,
  detailGrid: {
    display: "grid",
    gridTemplateColumns: "120px 1fr",
    gap: "8px 16px",
    fontSize: "13px",
  } as React.CSSProperties,
  detailLabel: {
    color: "var(--color-text-muted)",
  } as React.CSSProperties,
  detailValue: {
    color: "var(--color-text-primary)",
    wordBreak: "break-word" as const,
  } as React.CSSProperties,
  emptyState: {
    textAlign: "center" as const,
    padding: "60px 20px",
    color: "var(--color-text-muted)",
  } as React.CSSProperties,
  emptyIcon: {
    width: "64px",
    height: "64px",
    margin: "0 auto 16px",
    opacity: 0.3,
  } as React.CSSProperties,
  emptyTitle: {
    fontSize: "18px",
    fontWeight: 500,
    color: "var(--color-text-secondary)",
    marginBottom: "8px",
  } as React.CSSProperties,
  emptyDesc: {
    fontSize: "14px",
    maxWidth: "400px",
    margin: "0 auto",
  } as React.CSSProperties,
  errorBanner: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "12px 16px",
    backgroundColor: "var(--color-error-subtle)",
    border: "1px solid var(--color-error)",
    borderRadius: "var(--radius-md)",
    marginBottom: "16px",
    color: "var(--color-error)",
    fontSize: "14px",
  } as React.CSSProperties,
  lastRunBadge: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    padding: "2px 6px",
    borderRadius: "4px",
    fontSize: "11px",
    fontWeight: 500,
  } as React.CSSProperties,
};

export function ScheduledTasksSettings() {
  const [status, setStatus] = useState<CronStatusSummary | null>(null);
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingJob, setEditingJob] = useState<CronJob | null>(null);
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [statusResult, jobsResult, workspacesResult] = await Promise.all([
        window.electronAPI.getCronStatus(),
        window.electronAPI.listCronJobs({ includeDisabled: true }),
        window.electronAPI.listWorkspaces(),
      ]);
      setStatus(statusResult);
      setJobs(jobsResult);
      setWorkspaces(workspacesResult);
    } catch (err: Any) {
      setError(err.message || "Failed to load scheduled tasks");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();

    // Subscribe to cron events
    const unsubscribe = window.electronAPI.onCronEvent((event) => {
      console.log("[ScheduledTasks] Cron event:", event);
      loadData();
    });

    return unsubscribe;
  }, [loadData]);

  const handleToggleJob = async (job: CronJob, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const result = await window.electronAPI.updateCronJob(job.id, { enabled: !job.enabled });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      await loadData();
    } catch (err: Any) {
      setError(err.message);
    }
  };

  const handleDeleteJob = async (job: CronJob, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Delete "${job.name}"?\n\nThis action cannot be undone.`)) return;

    try {
      const result = await window.electronAPI.removeCronJob(job.id);
      if (!result.ok) {
        setError((result as Any).error || "Failed to delete job");
        return;
      }
      await loadData();
    } catch (err: Any) {
      setError(err.message);
    }
  };

  const handleRunNow = async (job: CronJob, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const result = await window.electronAPI.runCronJob(job.id, "force");
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.ran) {
        console.log(`[ScheduledTasks] Created task: ${result.taskId}`);
      }
      await loadData();
    } catch (err: Any) {
      setError(err.message);
    }
  };

  const handleEditJob = (job: CronJob, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingJob(job);
    setShowCreateModal(true);
  };

  if (loading) {
    return <div className="settings-loading">Loading scheduled tasks...</div>;
  }

  const lastRunJob = jobs.reduce<CronJob | null>((latest, job) => {
    if (!job.state.lastRunAtMs) return latest;
    if (!latest || !latest.state.lastRunAtMs) return job;
    return job.state.lastRunAtMs > latest.state.lastRunAtMs ? job : latest;
  }, null);

  return (
    <div style={styles.container}>
      <div className="settings-section">
        <div className="settings-section-header">
          <h3>Scheduled Tasks</h3>
        </div>
        <p className="settings-description">
          Automate tasks to run on a schedule. Results appear in your workspace.
        </p>
      </div>

      {/* Error Banner */}
      {error && (
        <div style={styles.errorBanner}>
          {Icons.x}
          <span style={{ flex: 1 }}>{error}</span>
          <button
            onClick={() => setError(null)}
            style={{
              background: "none",
              border: "none",
              color: "inherit",
              cursor: "pointer",
              padding: "4px",
            }}
          >
            {Icons.x}
          </button>
        </div>
      )}

      {/* Stats Cards */}
      <div style={styles.statsGrid}>
        <div style={styles.statCard}>
          <span style={styles.statLabel}>Total Tasks</span>
          <span style={styles.statValue}>{status?.jobCount || 0}</span>
        </div>
        <div style={styles.statCard}>
          <span style={styles.statLabel}>Active</span>
          <span style={{ ...styles.statValue, color: "var(--color-success)" }}>
            {status?.enabledJobCount || 0}
          </span>
        </div>
        <div style={styles.statCard}>
          <span style={styles.statLabel}>Next Run</span>
          <span style={{ ...styles.statValue, fontSize: "16px" }}>
            {status?.nextWakeAtMs ? formatRelativeTime(status.nextWakeAtMs) : "-"}
          </span>
        </div>
        <div style={styles.statCard}>
          <span style={styles.statLabel}>Last Run</span>
          <span style={{ ...styles.statValue, fontSize: "16px" }}>
            {lastRunJob?.state.lastRunAtMs ? formatRelativeTime(lastRunJob.state.lastRunAtMs) : "-"}
          </span>
        </div>
      </div>

      {/* Add Button */}
      <button
        className="button-primary button-with-icon scheduled-tasks-add"
        onClick={() => {
          setEditingJob(null);
          setShowCreateModal(true);
        }}
      >
        {Icons.plus}
        <span>New Scheduled Task</span>
      </button>

      {/* Jobs List */}
      {jobs.length === 0 ? (
        <div style={styles.emptyState}>
          <div style={styles.emptyIcon}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </div>
          <div style={styles.emptyTitle}>No scheduled tasks yet</div>
          <div style={styles.emptyDesc}>
            Create a scheduled task to automatically run prompts on a schedule. Great for daily
            reports, periodic checks, and automated workflows.
          </div>
        </div>
      ) : (
        <div>
          {jobs.map((job) => {
            const isExpanded = expandedJobId === job.id;
            const workspace = workspaces.find((w) => w.id === job.workspaceId);
            const lastStatus = job.state.lastStatus;

            return (
              <div
                key={job.id}
                style={{
                  ...styles.jobCard,
                  borderColor: job.enabled ? "var(--color-border-subtle)" : "transparent",
                  opacity: job.enabled ? 1 : 0.6,
                }}
              >
                {/* Job Header */}
                <div
                  style={styles.jobHeader}
                  onClick={() => setExpandedJobId(isExpanded ? null : job.id)}
                >
                  {/* Status Indicator */}
                  <div
                    style={{
                      ...styles.statusDot,
                      backgroundColor: !job.enabled
                        ? "var(--color-text-muted)"
                        : job.state.runningAtMs
                          ? "var(--color-warning)"
                          : lastStatus === "error"
                            ? "var(--color-error)"
                            : "var(--color-success)",
                      boxShadow:
                        job.enabled && !job.state.runningAtMs
                          ? `0 0 8px ${lastStatus === "error" ? "var(--color-error)" : "var(--color-success)"}`
                          : "none",
                    }}
                  />

                  {/* Job Info */}
                  <div style={styles.jobInfo}>
                    <div style={styles.jobName}>
                      <span>{job.name}</span>
                      {lastStatus && (
                        <span
                          style={{
                            ...styles.lastRunBadge,
                            backgroundColor:
                              lastStatus === "ok"
                                ? "var(--color-success-subtle)"
                                : "var(--color-error-subtle)",
                            color:
                              lastStatus === "ok" ? "var(--color-success)" : "var(--color-error)",
                          }}
                        >
                          {lastStatus === "ok" ? Icons.check : Icons.x}
                          {lastStatus}
                        </span>
                      )}
                    </div>
                    <div style={styles.jobMeta}>
                      <span style={styles.scheduleTag}>
                        {getScheduleIcon(job.schedule)}
                        {describeSchedule(job.schedule)}
                      </span>
                      {workspace && <span style={{ opacity: 0.7 }}>{workspace.name}</span>}
                    </div>
                  </div>

                  {/* Next Run */}
                  {job.enabled && job.state.nextRunAtMs && (
                    <div style={styles.nextRun}>
                      {Icons.zap}
                      <span>{formatRelativeTime(job.state.nextRunAtMs)}</span>
                    </div>
                  )}

                  {/* Actions */}
                  <div style={styles.actions}>
                    <button
                      style={{
                        ...styles.actionBtn,
                        backgroundColor: job.enabled
                          ? "var(--color-success-subtle)"
                          : "transparent",
                        color: job.enabled ? "var(--color-success)" : "var(--color-text-muted)",
                      }}
                      onClick={(e) => handleToggleJob(job, e)}
                      title={job.enabled ? "Disable" : "Enable"}
                    >
                      {job.enabled ? Icons.pause : Icons.play}
                    </button>
                    <button
                      style={styles.actionBtn}
                      onClick={(e) => handleRunNow(job, e)}
                      title="Run now"
                    >
                      {Icons.play}
                    </button>
                    <button
                      style={styles.actionBtn}
                      onClick={(e) => handleEditJob(job, e)}
                      title="Edit"
                    >
                      {Icons.edit}
                    </button>
                    <button
                      style={{
                        ...styles.actionBtn,
                        color: "var(--color-error)",
                      }}
                      onClick={(e) => handleDeleteJob(job, e)}
                      title="Delete"
                    >
                      {Icons.trash}
                    </button>
                  </div>

                  {/* Expand Arrow */}
                  <span
                    style={{
                      color: "var(--color-text-muted)",
                      transform: isExpanded ? "rotate(180deg)" : "rotate(0)",
                      transition: "transform 0.2s ease",
                    }}
                  >
                    {Icons.chevronDown}
                  </span>
                </div>

                {/* Expanded Content */}
                {isExpanded && (
                  <div style={styles.expandedContent}>
                    {job.description && (
                      <div
                        style={{
                          marginBottom: "16px",
                          padding: "12px",
                          backgroundColor: "var(--color-bg-glass)",
                          borderRadius: "6px",
                          fontSize: "13px",
                          color: "var(--color-text-secondary)",
                        }}
                      >
                        {job.description}
                      </div>
                    )}

                    <div style={styles.detailGrid}>
                      <span style={styles.detailLabel}>Workspace</span>
                      <span style={styles.detailValue}>{workspace?.name || job.workspaceId}</span>

                      <span style={styles.detailLabel}>Prompt</span>
                      <span
                        style={{
                          ...styles.detailValue,
                          fontFamily: "monospace",
                          fontSize: "12px",
                          backgroundColor: "var(--color-bg-glass)",
                          padding: "8px",
                          borderRadius: "4px",
                        }}
                      >
                        {job.taskPrompt}
                      </span>

                      {job.schedule.kind === "cron" && (
                        <>
                          <span style={styles.detailLabel}>Cron Expression</span>
                          <span style={{ ...styles.detailValue, fontFamily: "monospace" }}>
                            {job.schedule.expr}
                          </span>
                        </>
                      )}

                      <span style={styles.detailLabel}>Created</span>
                      <span style={styles.detailValue}>
                        {new Date(job.createdAtMs).toLocaleString()}
                      </span>

                      {job.state.totalRuns !== undefined && job.state.totalRuns > 0 && (
                        <>
                          <span style={styles.detailLabel}>Total Runs</span>
                          <span style={styles.detailValue}>{job.state.totalRuns}</span>
                        </>
                      )}

                      {job.state.lastRunAtMs && (
                        <>
                          <span style={styles.detailLabel}>Last Run</span>
                          <span style={styles.detailValue}>
                            {new Date(job.state.lastRunAtMs).toLocaleString()}
                            {job.state.lastDurationMs && (
                              <span style={{ color: "var(--color-text-muted)", marginLeft: "8px" }}>
                                ({formatDuration(job.state.lastDurationMs)})
                              </span>
                            )}
                          </span>
                        </>
                      )}

                      {job.state.lastError && (
                        <>
                          <span style={styles.detailLabel}>Last Error</span>
                          <span style={{ ...styles.detailValue, color: "var(--color-error)" }}>
                            {job.state.lastError}
                          </span>
                        </>
                      )}

                      {job.delivery?.enabled && (
                        <>
                          <span style={styles.detailLabel}>Delivery</span>
                          <span style={styles.detailValue}>
                            <span
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "4px",
                                padding: "2px 8px",
                                backgroundColor: "var(--color-success-subtle)",
                                color: "var(--color-success)",
                                borderRadius: "4px",
                                fontSize: "12px",
                                fontWeight: 500,
                              }}
                            >
                              {Icons.send}
                              {job.delivery.channelType}
                            </span>
                            <span
                              style={{
                                marginLeft: "8px",
                                fontSize: "12px",
                                color: "var(--color-text-muted)",
                              }}
                            >
                              &rarr; {job.delivery.channelId}
                            </span>
                          </span>
                          <span style={styles.detailLabel}>Deliver When</span>
                          <span style={styles.detailValue}>
                            {[
                              job.delivery.deliverOnSuccess !== false ? "Success" : null,
                              job.delivery.deliverOnError !== false ? "Error" : null,
                            ]
                              .filter(Boolean)
                              .join(", ")}
                            {job.delivery.summaryOnly ? " (summary only)" : ""}
                            {job.delivery.deliverOnlyIfResult ? " (only if result)" : ""}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Create/Edit Modal */}
      {showCreateModal && (
        <JobModal
          job={editingJob}
          workspaces={workspaces}
          onClose={() => {
            setShowCreateModal(false);
            setEditingJob(null);
          }}
          onSave={async () => {
            await loadData();
            setShowCreateModal(false);
            setEditingJob(null);
          }}
        />
      )}
    </div>
  );
}

interface JobModalProps {
  job: CronJob | null;
  workspaces: Workspace[];
  onClose: () => void;
  onSave: () => void;
}

function JobModal({ job, workspaces, onClose, onSave }: JobModalProps) {
  const isEditing = job !== null;
  const agentContext = useAgentContext();

  const [name, setName] = useState(job?.name || "");
  const [description, setDescription] = useState(job?.description || "");
  const [workspaceId, setWorkspaceId] = useState(job?.workspaceId || workspaces[0]?.id || "");
  const [taskPrompt, setTaskPrompt] = useState(job?.taskPrompt || "");
  const [taskTitle, setTaskTitle] = useState(job?.taskTitle || "");
  const [enabled, setEnabled] = useState(job?.enabled ?? true);
  const [deleteAfterRun, setDeleteAfterRun] = useState(job?.deleteAfterRun ?? false);

  // Delivery config
  const [deliveryEnabled, setDeliveryEnabled] = useState(job?.delivery?.enabled ?? false);
  const [deliveryChannelDbId, setDeliveryChannelDbId] = useState(job?.delivery?.channelDbId || "");
  const [deliveryChannelType, setDeliveryChannelType] = useState(job?.delivery?.channelType || "");
  const [deliveryChatId, setDeliveryChatId] = useState(job?.delivery?.channelId || "");
  const [deliverOnSuccess, setDeliverOnSuccess] = useState(job?.delivery?.deliverOnSuccess ?? true);
  const [deliverOnError, setDeliverOnError] = useState(job?.delivery?.deliverOnError ?? true);
  const [summaryOnly, setSummaryOnly] = useState(job?.delivery?.summaryOnly ?? false);
  const [deliverOnlyIfResult, setDeliverOnlyIfResult] = useState(
    job?.delivery?.deliverOnlyIfResult ?? false,
  );
  const [deliveryExpanded, setDeliveryExpanded] = useState(job?.delivery?.enabled ?? false);
  const [connectedChannels, setConnectedChannels] = useState<
    Array<{ id: string; type: string; name: string; enabled: boolean; status: string }>
  >([]);
  const [knownChatIds, setKnownChatIds] = useState<
    Array<{ chatId: string; lastTimestamp: number }>
  >([]);
  const [testingDelivery, setTestingDelivery] = useState(false);
  const [testDeliveryResult, setTestDeliveryResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  useEffect(() => {
    const loadChannels = async () => {
      try {
        const channels = await window.electronAPI.getGatewayChannels();
        // Show all enabled channels (including disconnected ones) so editing works
        // even when a channel is temporarily offline
        setConnectedChannels(channels.filter((c: { enabled: boolean }) => c.enabled));
      } catch (err) {
        console.error("Failed to load gateway channels:", err);
      }
    };
    loadChannels();
  }, []);

  // Load known chat IDs when selected channel changes
  useEffect(() => {
    if (!deliveryChannelDbId) {
      setKnownChatIds([]);
      return;
    }
    const loadChats = async () => {
      try {
        const chats = await window.electronAPI.getGatewayChats(deliveryChannelDbId);
        setKnownChatIds(chats);
      } catch {
        setKnownChatIds([]);
      }
    };
    loadChats();
  }, [deliveryChannelDbId]);

  // Schedule type and values
  const [scheduleType, setScheduleType] = useState<"every" | "cron" | "at">(
    job?.schedule.kind || "every",
  );
  const [everyMs, setEveryMs] = useState(
    job?.schedule.kind === "every" ? job.schedule.everyMs : 60 * 60 * 1000,
  );
  const [cronExpr, setCronExpr] = useState(
    job?.schedule.kind === "cron" ? job.schedule.expr : "0 9 * * *",
  );
  const [atDateTime, setAtDateTime] = useState(
    job?.schedule.kind === "at" ? new Date(job.schedule.atMs).toISOString().slice(0, 16) : "",
  );

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    if (!workspaceId) {
      setError("Workspace is required");
      return;
    }
    if (!taskPrompt.trim()) {
      setError("Task prompt is required");
      return;
    }

    if (deliveryEnabled) {
      if (!deliveryChannelDbId) {
        setError("Please select a channel for delivery");
        return;
      }
      if (!deliveryChatId.trim()) {
        setError("Please enter a Chat ID for delivery");
        return;
      }
    }

    let schedule: CronSchedule;
    if (scheduleType === "every") {
      schedule = { kind: "every", everyMs, anchorMs: Date.now() };
    } else if (scheduleType === "cron") {
      schedule = { kind: "cron", expr: cronExpr };
    } else {
      const atMs = new Date(atDateTime).getTime();
      if (isNaN(atMs) || atMs < Date.now()) {
        setError("Please select a future date and time");
        return;
      }
      schedule = { kind: "at", atMs };
    }

    const delivery = deliveryEnabled
      ? {
          enabled: true as const,
          channelType: (deliveryChannelType || undefined) as Any,
          channelDbId: deliveryChannelDbId || undefined,
          channelId: deliveryChatId.trim() || undefined,
          deliverOnSuccess,
          deliverOnError,
          summaryOnly,
          deliverOnlyIfResult,
        }
      : { enabled: false as const };

    try {
      setSaving(true);
      setError(null);

      if (isEditing && job) {
        const result = await window.electronAPI.updateCronJob(job.id, {
          name: name.trim(),
          description: description.trim() || undefined,
          workspaceId,
          taskPrompt: taskPrompt.trim(),
          taskTitle: taskTitle.trim() || undefined,
          enabled,
          deleteAfterRun,
          schedule,
          delivery,
        });
        if (!result.ok) {
          setError(result.error);
          return;
        }
      } else {
        const result = await window.electronAPI.addCronJob({
          name: name.trim(),
          description: description.trim() || undefined,
          workspaceId,
          taskPrompt: taskPrompt.trim(),
          taskTitle: taskTitle.trim() || undefined,
          enabled,
          deleteAfterRun,
          schedule,
          delivery,
        });
        if (!result.ok) {
          setError(result.error);
          return;
        }
      }

      onSave();
    } catch (err: Any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const modalStyles = {
    overlay: {
      position: "fixed" as const,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: "rgba(0, 0, 0, 0.6)",
      backdropFilter: "blur(4px)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: 1000,
    },
    content: {
      backgroundColor: "var(--color-bg-elevated)",
      border: "1px solid var(--color-border)",
      borderRadius: "var(--radius-lg)",
      padding: "24px",
      width: "560px",
      maxWidth: "90vw",
      maxHeight: "85vh",
      overflow: "auto",
      boxShadow: "var(--shadow-lg)",
    },
    title: {
      fontSize: "20px",
      fontWeight: 600,
      color: "var(--color-text-primary)",
      marginBottom: "20px",
      display: "flex",
      alignItems: "center",
      gap: "10px",
    },
    field: {
      marginBottom: "20px",
    },
    label: {
      display: "block",
      marginBottom: "6px",
      fontSize: "13px",
      fontWeight: 500,
      color: "var(--color-text-secondary)",
    },
    input: {
      width: "100%",
      padding: "10px 12px",
      backgroundColor: "var(--color-bg-input)",
      border: "1px solid var(--color-border)",
      borderRadius: "var(--radius-sm)",
      color: "var(--color-text-primary)",
      fontSize: "14px",
      outline: "none",
      transition: "border-color 0.2s",
    },
    textarea: {
      width: "100%",
      padding: "10px 12px",
      backgroundColor: "var(--color-bg-input)",
      border: "1px solid var(--color-border)",
      borderRadius: "var(--radius-sm)",
      color: "var(--color-text-primary)",
      fontSize: "14px",
      outline: "none",
      resize: "vertical" as const,
      minHeight: "100px",
      fontFamily: "inherit",
    },
    select: {
      width: "100%",
      padding: "10px 12px",
      backgroundColor: "var(--color-bg-input)",
      border: "1px solid var(--color-border)",
      borderRadius: "var(--radius-sm)",
      color: "var(--color-text-primary)",
      fontSize: "14px",
      outline: "none",
    },
    scheduleToggle: {
      display: "flex",
      gap: "8px",
      marginBottom: "12px",
    },
    toggleBtn: (active: boolean) => ({
      flex: 1,
      padding: "10px",
      backgroundColor: active ? "var(--color-accent-subtle)" : "var(--color-bg-glass)",
      border: `1px solid ${active ? "var(--color-accent)" : "var(--color-border-subtle)"}`,
      borderRadius: "var(--radius-sm)",
      color: active ? "var(--color-accent)" : "var(--color-text-secondary)",
      fontSize: "13px",
      fontWeight: 500,
      cursor: "pointer",
      transition: "all 0.15s ease",
    }),
    checkbox: {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      cursor: "pointer",
      fontSize: "14px",
      color: "var(--color-text-secondary)",
    },
    actions: {
      display: "flex",
      gap: "12px",
      justifyContent: "flex-end",
      marginTop: "24px",
      paddingTop: "20px",
      borderTop: "1px solid var(--color-border-subtle)",
    },
    cancelBtn: {
      padding: "10px 20px",
      backgroundColor: "transparent",
      border: "1px solid var(--color-border)",
      borderRadius: "var(--radius-sm)",
      color: "var(--color-text-secondary)",
      fontSize: "14px",
      fontWeight: 500,
      cursor: "pointer",
    },
    saveBtn: {
      padding: "10px 24px",
      backgroundColor: "var(--color-accent)",
      border: "none",
      borderRadius: "var(--radius-sm)",
      color: "#000",
      fontSize: "14px",
      fontWeight: 600,
      cursor: "pointer",
    },
    error: {
      padding: "10px 12px",
      backgroundColor: "var(--color-error-subtle)",
      border: "1px solid var(--color-error)",
      borderRadius: "var(--radius-sm)",
      color: "var(--color-error)",
      fontSize: "13px",
      marginBottom: "16px",
    },
  };

  return (
    <div
      style={modalStyles.overlay}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div style={modalStyles.content}>
        <div style={modalStyles.title}>
          {Icons.clock}
          {isEditing ? "Edit Scheduled Task" : "New Scheduled Task"}
        </div>

        {error && <div style={modalStyles.error}>{error}</div>}

        {/* Name */}
        <div style={modalStyles.field}>
          <label style={modalStyles.label}>Name *</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Daily AI News Report"
            style={modalStyles.input}
          />
        </div>

        {/* Description */}
        <div style={modalStyles.field}>
          <label style={modalStyles.label}>Description</label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional description"
            style={modalStyles.input}
          />
        </div>

        {/* Workspace */}
        <div style={modalStyles.field}>
          <label style={modalStyles.label}>Workspace *</label>
          <select
            value={workspaceId}
            onChange={(e) => setWorkspaceId(e.target.value)}
            style={modalStyles.select}
          >
            {workspaces.length === 0 && (
              <option value="">{agentContext.getUiCopy("scheduledNoWorkspaces")}</option>
            )}
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>

        {/* Task Prompt */}
        <div style={modalStyles.field}>
          <label style={modalStyles.label}>Task Prompt *</label>
          <textarea
            value={taskPrompt}
            onChange={(e) => setTaskPrompt(e.target.value)}
            placeholder="What should the agent do? Be specific about the task..."
            style={modalStyles.textarea}
          />
        </div>

        {/* Task Title */}
        <div style={modalStyles.field}>
          <label style={modalStyles.label}>Task Title (optional)</label>
          <input
            type="text"
            value={taskTitle}
            onChange={(e) => setTaskTitle(e.target.value)}
            placeholder="Custom title for created tasks"
            style={modalStyles.input}
          />
        </div>

        {/* Schedule Type */}
        <div style={modalStyles.field}>
          <label style={modalStyles.label}>Schedule *</label>
          <div style={modalStyles.scheduleToggle}>
            <button
              type="button"
              style={modalStyles.toggleBtn(scheduleType === "every")}
              onClick={() => setScheduleType("every")}
            >
              {Icons.repeat}
              <span style={{ marginLeft: "6px" }}>Interval</span>
            </button>
            <button
              type="button"
              style={modalStyles.toggleBtn(scheduleType === "cron")}
              onClick={() => setScheduleType("cron")}
            >
              {Icons.activity}
              <span style={{ marginLeft: "6px" }}>Cron</span>
            </button>
            <button
              type="button"
              style={modalStyles.toggleBtn(scheduleType === "at")}
              onClick={() => setScheduleType("at")}
            >
              {Icons.calendar}
              <span style={{ marginLeft: "6px" }}>One-time</span>
            </button>
          </div>

          {/* Interval Schedule */}
          {scheduleType === "every" && (
            <select
              value={everyMs}
              onChange={(e) => setEveryMs(Number(e.target.value))}
              style={modalStyles.select}
            >
              {SCHEDULE_PRESETS.map((preset) => (
                <option key={preset.label} value={preset.schedule.everyMs}>
                  {preset.label}
                </option>
              ))}
            </select>
          )}

          {/* Cron Schedule */}
          {scheduleType === "cron" && (
            <div>
              <select
                value={CRON_PRESETS.find((p) => p.value === cronExpr)?.value || "custom"}
                onChange={(e) => {
                  if (e.target.value !== "custom") {
                    setCronExpr(e.target.value);
                  }
                }}
                style={{ ...modalStyles.select, marginBottom: "8px" }}
              >
                {CRON_PRESETS.map((preset) => (
                  <option key={preset.value} value={preset.value}>
                    {preset.label} - {preset.desc}
                  </option>
                ))}
                <option value="custom">Custom expression</option>
              </select>
              <input
                type="text"
                value={cronExpr}
                onChange={(e) => setCronExpr(e.target.value)}
                placeholder="minute hour day month weekday (e.g., 0 9 * * 1-5)"
                style={{ ...modalStyles.input, fontFamily: "monospace" }}
              />
              <div
                style={{
                  marginTop: "6px",
                  fontSize: "12px",
                  color: "var(--color-text-muted)",
                }}
              >
                Format: minute (0-59) hour (0-23) day (1-31) month (1-12) weekday (0-6, 0=Sun)
              </div>
            </div>
          )}

          {/* One-time Schedule */}
          {scheduleType === "at" && (
            <input
              type="datetime-local"
              value={atDateTime}
              onChange={(e) => setAtDateTime(e.target.value)}
              style={modalStyles.input}
            />
          )}
        </div>

        {/* Options */}
        <div style={modalStyles.field}>
          <label style={modalStyles.checkbox}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Enable immediately after saving
          </label>
          {scheduleType === "at" && (
            <label style={{ ...modalStyles.checkbox, marginTop: "8px" }}>
              <input
                type="checkbox"
                checked={deleteAfterRun}
                onChange={(e) => setDeleteAfterRun(e.target.checked)}
              />
              Delete after execution (one-shot)
            </label>
          )}
        </div>

        {/* Delivery Configuration */}
        <div
          style={{
            marginBottom: "20px",
            border: "1px solid var(--color-border-subtle)",
            borderRadius: "var(--radius-sm)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "12px 14px",
              backgroundColor: "var(--color-bg-glass)",
              cursor: "pointer",
              gap: "10px",
            }}
            onClick={() => setDeliveryExpanded(!deliveryExpanded)}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              {Icons.send}
              <span
                style={{
                  fontSize: "14px",
                  fontWeight: 500,
                  color: "var(--color-text-primary)",
                }}
              >
                Delivery
              </span>
              {deliveryEnabled && (
                <span
                  style={{
                    fontSize: "11px",
                    padding: "2px 6px",
                    borderRadius: "4px",
                    backgroundColor: "var(--color-success-subtle)",
                    color: "var(--color-success)",
                    fontWeight: 500,
                  }}
                >
                  ON
                </span>
              )}
            </div>
            <span
              style={{
                color: "var(--color-text-muted)",
                transform: deliveryExpanded ? "rotate(180deg)" : "rotate(0)",
                transition: "transform 0.2s ease",
              }}
            >
              {Icons.chevronDown}
            </span>
          </div>

          {deliveryExpanded && (
            <div style={{ padding: "14px", borderTop: "1px solid var(--color-border-subtle)" }}>
              <label style={modalStyles.checkbox}>
                <input
                  type="checkbox"
                  checked={deliveryEnabled}
                  onChange={(e) => setDeliveryEnabled(e.target.checked)}
                />
                Send results to a messaging channel
              </label>

              {deliveryEnabled && (
                <div
                  style={{
                    marginTop: "14px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "14px",
                  }}
                >
                  {/* Channel dropdown */}
                  <div>
                    <label style={modalStyles.label}>Channel *</label>
                    {connectedChannels.length > 0 ? (
                      <select
                        value={deliveryChannelDbId}
                        onChange={(e) => {
                          const selectedId = e.target.value;
                          setDeliveryChannelDbId(selectedId);
                          const ch = connectedChannels.find((c) => c.id === selectedId);
                          setDeliveryChannelType(ch?.type || "");
                        }}
                        style={modalStyles.select}
                      >
                        <option value="">Select a channel...</option>
                        {connectedChannels.map((ch) => (
                          <option key={ch.id} value={ch.id}>
                            {ch.name} ({ch.type})
                          </option>
                        ))}
                      </select>
                    ) : (
                      <div
                        style={{
                          padding: "10px 12px",
                          backgroundColor: "var(--color-bg-input)",
                          border: "1px solid var(--color-border)",
                          borderRadius: "var(--radius-sm)",
                          fontSize: "13px",
                          color: "var(--color-text-muted)",
                        }}
                      >
                        No channels configured. Add a channel in Settings &rarr; Channels first.
                      </div>
                    )}
                  </div>

                  {/* Chat ID */}
                  <div>
                    <label style={modalStyles.label}>Chat ID / Conversation ID *</label>
                    <input
                      type="text"
                      value={deliveryChatId}
                      onChange={(e) => setDeliveryChatId(e.target.value)}
                      placeholder="e.g., -1001234567890 or 14155551234@s.whatsapp.net"
                      list="delivery-chat-ids"
                      style={modalStyles.input}
                    />
                    {knownChatIds.length > 0 && (
                      <datalist id="delivery-chat-ids">
                        {knownChatIds.map((c) => (
                          <option key={c.chatId} value={c.chatId}>
                            {c.chatId} (last message:{" "}
                            {new Date(c.lastTimestamp).toLocaleDateString()})
                          </option>
                        ))}
                      </datalist>
                    )}
                    <div
                      style={{
                        marginTop: "4px",
                        fontSize: "12px",
                        color: "var(--color-text-muted)",
                      }}
                    >
                      {knownChatIds.length > 0
                        ? "Select from recent conversations or enter a chat ID manually"
                        : "The target chat/conversation ID on the selected channel"}
                    </div>
                  </div>

                  {/* Delivery options */}
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    <label style={modalStyles.checkbox}>
                      <input
                        type="checkbox"
                        checked={deliverOnSuccess}
                        onChange={(e) => setDeliverOnSuccess(e.target.checked)}
                      />
                      Deliver on success
                    </label>
                    <label style={modalStyles.checkbox}>
                      <input
                        type="checkbox"
                        checked={deliverOnError}
                        onChange={(e) => setDeliverOnError(e.target.checked)}
                      />
                      Deliver on error
                    </label>
                    <label style={modalStyles.checkbox}>
                      <input
                        type="checkbox"
                        checked={summaryOnly}
                        onChange={(e) => setSummaryOnly(e.target.checked)}
                      />
                      Summary only (omit full result text)
                    </label>
                    <label style={modalStyles.checkbox}>
                      <input
                        type="checkbox"
                        checked={deliverOnlyIfResult}
                        onChange={(e) => setDeliverOnlyIfResult(e.target.checked)}
                      />
                      Only deliver if result is non-empty
                    </label>
                  </div>

                  {/* Test Delivery */}
                  {deliveryChannelDbId && deliveryChatId.trim() && (
                    <div
                      style={{
                        paddingTop: "10px",
                        borderTop: "1px solid var(--color-border-subtle)",
                      }}
                    >
                      <button
                        style={{
                          padding: "8px 14px",
                          fontSize: "13px",
                          fontWeight: 500,
                          color: testingDelivery
                            ? "var(--color-text-muted)"
                            : "var(--color-text-primary)",
                          backgroundColor: "var(--color-bg-input)",
                          border: "1px solid var(--color-border)",
                          borderRadius: "var(--radius-sm)",
                          cursor: testingDelivery ? "not-allowed" : "pointer",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "6px",
                        }}
                        disabled={testingDelivery}
                        onClick={async () => {
                          setTestingDelivery(true);
                          setTestDeliveryResult(null);
                          try {
                            await window.electronAPI.sendGatewayTestMessage({
                              channelType: deliveryChannelType,
                              channelDbId: deliveryChannelDbId,
                              chatId: deliveryChatId.trim(),
                            });
                            setTestDeliveryResult({
                              ok: true,
                              message: "Test message sent successfully!",
                            });
                          } catch (err: Any) {
                            setTestDeliveryResult({
                              ok: false,
                              message: err.message || "Failed to send test message",
                            });
                          } finally {
                            setTestingDelivery(false);
                          }
                        }}
                      >
                        {Icons.send}
                        {testingDelivery ? "Sending..." : "Send Test Message"}
                      </button>
                      {testDeliveryResult && (
                        <div
                          style={{
                            marginTop: "8px",
                            fontSize: "12px",
                            color: testDeliveryResult.ok
                              ? "var(--color-success)"
                              : "var(--color-error)",
                          }}
                        >
                          {testDeliveryResult.message}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Actions */}
        <div style={modalStyles.actions}>
          <button style={modalStyles.cancelBtn} onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button style={modalStyles.saveBtn} onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : isEditing ? "Save Changes" : "Create Task"}
          </button>
        </div>
      </div>
    </div>
  );
}
