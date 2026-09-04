import Database from "better-sqlite3";
import type { Task, TaskEvent } from "../../shared/types";
import { normalizeLlmProviderType } from "../../shared/llmProviderDisplay";
import { usageLocalDateKey } from "../../shared/usageInsightsDates";
import { createLogger } from "../utils/logger";

const logger = createLogger("UsageInsightsProjector");

const SCHEMA_VERSION_KEY = "schema_version";
const BACKFILL_COMPLETE_KEY = "backfill_complete";
const TASK_WATERMARK_KEY = "task_watermark_ms";
const EVENT_WATERMARK_KEY = "event_watermark_ms";
const LLM_WATERMARK_KEY = "llm_watermark_ms";
const USAGE_INSIGHTS_SCHEMA_VERSION = "1";

const RELEVANT_EVENT_TYPES = new Set([
  "skill_used",
  "tool_call",
  "tool_result",
  "tool_error",
  "tool_blocked",
  "tool_warning",
  "user_feedback",
]);

function parseJsonObject(value?: string | null): Record<string, unknown> | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function getProviderTypeFromRoutingPayload(routingPayload?: string | null): string | null {
  const payload = parseJsonObject(routingPayload);
  const activeProvider =
    typeof payload?.activeProvider === "string"
      ? payload.activeProvider
      : typeof payload?.currentProvider === "string"
        ? payload.currentProvider
        : null;
  const normalized = normalizeLlmProviderType(activeProvider);
  return normalized && normalized !== "unknown" ? normalized : null;
}

function getProviderTypeFromAgentConfig(agentConfig?: string | null): string | null {
  const payload = parseJsonObject(agentConfig);
  const providerType = typeof payload?.providerType === "string" ? payload.providerType : null;
  const normalized = normalizeLlmProviderType(providerType);
  return normalized && normalized !== "unknown" ? normalized : null;
}

function getProviderTypeFromLogPayload(logPayload?: string | null): string | null {
  const payload = parseJsonObject(logPayload);
  const message = typeof payload?.message === "string" ? payload.message : null;
  if (!message) return null;
  const match = message.match(/\bprovider=([a-z0-9._-]+)/i);
  const normalized = normalizeLlmProviderType(match?.[1]?.toLowerCase() || null);
  return normalized && normalized !== "unknown" ? normalized : null;
}

function resolveProviderType(entry: {
  providerType?: string | null;
  routingPayload?: string | null;
  providerLogPayload?: string | null;
  agentConfig?: string | null;
}): string {
  const direct = normalizeLlmProviderType(entry.providerType);
  if (direct && direct !== "unknown") return direct;

  const routed = getProviderTypeFromRoutingPayload(entry.routingPayload);
  if (routed) return routed;

  const logged = getProviderTypeFromLogPayload(entry.providerLogPayload);
  if (logged) return logged;

  const taskConfig = getProviderTypeFromAgentConfig(entry.agentConfig);
  if (taskConfig) return taskConfig;

  return "unknown";
}

function getEffectiveEventType(event: {
  type?: string | null;
  legacyType?: string | null;
  legacy_type?: string | null;
}): string {
  if (typeof event.type === "string" && event.type) return event.type;
  if (typeof event.legacyType === "string" && event.legacyType) return event.legacyType;
  if (typeof event.legacy_type === "string" && event.legacy_type) return event.legacy_type;
  return "";
}

function dayBoundsForDateKey(dateKey: string): { start: number; endExclusive: number } {
  const [year, month, day] = dateKey.split("-").map(Number);
  const start = new Date(year, month - 1, day).getTime();
  const endExclusive = new Date(year, month - 1, day + 1).getTime();
  return { start, endExclusive };
}

type CacheEntry<T> = {
  version: number;
  value: T;
};

export class UsageInsightsProjector {
  private static instance: UsageInsightsProjector | null = null;

  static initialize(db: Database.Database): UsageInsightsProjector {
    if (!UsageInsightsProjector.instance) {
      UsageInsightsProjector.instance = new UsageInsightsProjector(db);
    }
    return UsageInsightsProjector.instance;
  }

  static getIfInitialized(): UsageInsightsProjector | null {
    return UsageInsightsProjector.instance;
  }

  /**
   * The projector is process-global, but its rollups and cache are tied to the
   * database connection it was initialized with. Callers that own another
   * connection must not accidentally consume this singleton's state.
   */
  isForDatabase(db: unknown): boolean {
    return this.db === db;
  }

  private cache = new Map<string, CacheEntry<unknown>>();
  private version = 0;
  private pendingRefreshes = new Set<string>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private backfillPromise: Promise<void> | null = null;
  private backfillCompleteKnown = false;
  private backfillComplete = false;

  private constructor(private db: Database.Database) {}

  warm(): void {
    this.scheduleBackfill();
  }

  isBackfillComplete(): boolean {
    if (!this.backfillCompleteKnown) {
      this.backfillComplete = this.getState(BACKFILL_COMPLETE_KEY) === "1";
      this.backfillCompleteKnown = true;
    }
    return this.backfillComplete;
  }

  getVersion(): number {
    this.flushPendingRefreshes();
    return this.version;
  }

  getWatermarks(): {
    schemaVersion: string | null;
    taskWatermarkMs: number;
    eventWatermarkMs: number;
    llmWatermarkMs: number;
  } {
    const toMs = (value: string | null): number => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    };

    return {
      schemaVersion: this.getState(SCHEMA_VERSION_KEY),
      taskWatermarkMs: toMs(this.getState(TASK_WATERMARK_KEY)),
      eventWatermarkMs: toMs(this.getState(EVENT_WATERMARK_KEY)),
      llmWatermarkMs: toMs(this.getState(LLM_WATERMARK_KEY)),
    };
  }

  getCachedReport<T>(key: string): T | null {
    this.flushPendingRefreshes();
    const entry = this.cache.get(key);
    if (!entry || entry.version !== this.version) return null;
    return entry.value as T;
  }

  setCachedReport<T>(key: string, value: T): void {
    this.cache.set(key, { version: this.version, value });
  }

  invalidate(): void {
    this.version += 1;
    this.cache.clear();
  }

  scheduleBackfill(): void {
    if (this.isBackfillComplete() || this.backfillPromise) {
      return;
    }
    this.backfillPromise = (async () => {
      try {
        await this.backfillAll();
      } catch (error) {
        logger.error("Backfill failed:", error);
      } finally {
        this.backfillPromise = null;
      }
    })();
  }

  enqueueTaskCreate(task: Task): void {
    this.invalidate();
    if (!this.isBackfillComplete()) {
      this.scheduleBackfill();
      return;
    }
    this.enqueueRefresh(task.workspaceId, usageLocalDateKey(task.createdAt));
    if (typeof task.completedAt === "number") {
      this.enqueueRefresh(task.workspaceId, usageLocalDateKey(task.completedAt));
    }
  }

  enqueueTaskUpdate(before: Task | undefined, after: Task | undefined): void {
    this.invalidate();
    if (!this.isBackfillComplete()) {
      this.scheduleBackfill();
      return;
    }
    const pairs = new Set<string>();
    if (before) {
      pairs.add(`${before.workspaceId}|${usageLocalDateKey(before.createdAt)}`);
      if (typeof before.completedAt === "number") {
        pairs.add(`${before.workspaceId}|${usageLocalDateKey(before.completedAt)}`);
      }
    }
    if (after) {
      pairs.add(`${after.workspaceId}|${usageLocalDateKey(after.createdAt)}`);
      if (typeof after.completedAt === "number") {
        pairs.add(`${after.workspaceId}|${usageLocalDateKey(after.completedAt)}`);
      }
    }
    for (const pair of pairs) {
      this.pendingRefreshes.add(pair);
    }
    this.scheduleFlush();
  }

  enqueueTaskEvent(workspaceId: string | null | undefined, event: TaskEvent): void {
    this.invalidate();
    const effectiveType = getEffectiveEventType(event);
    if (!workspaceId || !RELEVANT_EVENT_TYPES.has(effectiveType)) {
      return;
    }
    if (!this.isBackfillComplete()) {
      this.scheduleBackfill();
      return;
    }
    this.enqueueRefresh(workspaceId, usageLocalDateKey(event.timestamp));
  }

  enqueueLlmTelemetry(workspaceId: string | null | undefined, timestampMs: number): void {
    this.invalidate();
    if (!workspaceId) return;
    if (!this.isBackfillComplete()) {
      this.scheduleBackfill();
      return;
    }
    this.enqueueRefresh(workspaceId, usageLocalDateKey(timestampMs));
  }

  flushPendingRefreshes(): void {
    if (!this.isBackfillComplete() || this.pendingRefreshes.size === 0) {
      return;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }

    const pairs = Array.from(this.pendingRefreshes);
    this.pendingRefreshes.clear();
    const tx = this.db.transaction((items: Array<{ workspaceId: string; dateKey: string }>) => {
      for (const item of items) {
        this.rebuildWorkspaceDate(item.workspaceId, item.dateKey);
      }
    });

    try {
      tx(
        pairs.map((pair) => {
          const [workspaceId, dateKey] = pair.split("|");
          return { workspaceId, dateKey };
        }),
      );
    } catch (error) {
      logger.warn("Failed to flush pending usage insight refreshes:", error);
    }
  }

  private enqueueRefresh(workspaceId: string, dateKey: string): void {
    this.pendingRefreshes.add(`${workspaceId}|${dateKey}`);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.flushPendingRefreshes();
    }, 250);
  }

  private getState(key: string): string | null {
    try {
      const row = this.db
        .prepare("SELECT value FROM usage_insights_state WHERE key = ?")
        .get(key) as { value: string } | undefined;
      return row?.value ?? null;
    } catch {
      return null;
    }
  }

  private setState(key: string, value: string): void {
    try {
      this.db
        .prepare(
          `INSERT INTO usage_insights_state (key, value, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(key, value, Date.now());
    } catch (error) {
      logger.warn(`Failed to set usage insights state ${key}:`, error);
    }
  }

  private async backfillAll(): Promise<void> {
    const { schemaVersion, taskWatermarkMs, eventWatermarkMs, llmWatermarkMs } =
      this.getWatermarks();
    const shouldResetRollups =
      schemaVersion !== USAGE_INSIGHTS_SCHEMA_VERSION ||
      (this.getState(BACKFILL_COMPLETE_KEY) !== "1" &&
        taskWatermarkMs <= 0 &&
        eventWatermarkMs <= 0 &&
        llmWatermarkMs <= 0);

    if (shouldResetRollups) {
      this.resetRollups();
      this.setState(TASK_WATERMARK_KEY, "0");
      this.setState(EVENT_WATERMARK_KEY, "0");
      this.setState(LLM_WATERMARK_KEY, "0");
    }

    this.setState(SCHEMA_VERSION_KEY, USAGE_INSIGHTS_SCHEMA_VERSION);
    this.setState(BACKFILL_COMPLETE_KEY, "0");
    this.backfillComplete = false;
    this.backfillCompleteKnown = true;

    await Promise.resolve();
    this.backfillLegacyLlmTelemetry();
    this.setState(LLM_WATERMARK_KEY, String(this.getMaxTimestamp("llm_call_events")));
    await this.rebuildAllRollupsIncremental(
      shouldResetRollups || taskWatermarkMs <= 0 ? null : usageLocalDateKey(taskWatermarkMs),
    );
    this.updateWatermarks();

    this.setState(BACKFILL_COMPLETE_KEY, "1");
    this.backfillComplete = true;
    this.backfillCompleteKnown = true;
    this.invalidate();
  }

  private backfillLegacyLlmTelemetry(): void {
    type SuccessRow = {
      id: string;
      task_id: string;
      workspace_id: string;
      timestamp: number;
      payload: string;
      agent_config: string | null;
      routing_payload: string | null;
      provider_log_payload: string | null;
    };
    type ErrorRow = {
      id: string;
      task_id: string;
      workspace_id: string;
      timestamp: number;
      payload: string;
      agent_config: string | null;
      routing_payload: string | null;
      provider_log_payload: string | null;
    };

    const insertSuccess = this.db.prepare(
      `INSERT OR IGNORE INTO llm_call_events (
        id,
        timestamp,
        workspace_id,
        task_id,
        source_kind,
        source_id,
        provider_type,
        model_key,
        model_id,
        input_tokens,
        output_tokens,
        cached_tokens,
        cost,
        success,
        error_code,
        error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL)`,
    );
    const insertError = this.db.prepare(
      `INSERT OR IGNORE INTO llm_call_events (
        id,
        timestamp,
        workspace_id,
        task_id,
        source_kind,
        source_id,
        provider_type,
        model_key,
        model_id,
        input_tokens,
        output_tokens,
        cached_tokens,
        cost,
        success,
        error_code,
        error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, ?, ?)`,
    );

    const tx = this.db.transaction(() => {
      let successRows: SuccessRow[] = [];
      let errorRows: ErrorRow[] = [];
      try {
        successRows = this.db
          .prepare(
            `SELECT
               te.id,
               te.task_id,
               t.workspace_id,
               te.timestamp,
               te.payload,
               t.agent_config,
               (
                 SELECT te2.payload
                 FROM task_events te2
                 WHERE te2.task_id = te.task_id
                   AND (te2.type = 'llm_routing_changed' OR te2.legacy_type = 'llm_routing_changed')
                   AND te2.timestamp <= te.timestamp
                 ORDER BY te2.timestamp DESC
                 LIMIT 1
               ) as routing_payload,
               (
                 SELECT te3.payload
                 FROM task_events te3
                 WHERE te3.task_id = te.task_id
                   AND (te3.type = 'log' OR te3.legacy_type = 'log')
                   AND te3.timestamp <= te.timestamp
                   AND te3.payload LIKE '%provider=%'
                 ORDER BY te3.timestamp DESC
                 LIMIT 1
               ) as provider_log_payload
             FROM task_events te
             JOIN tasks t ON t.id = te.task_id
             WHERE te.type = 'llm_usage' OR te.legacy_type = 'llm_usage'`,
          )
          .all() as SuccessRow[];
      } catch (error) {
        logger.warn("Unable to load legacy llm_usage rows for backfill:", error);
      }

      for (const row of successRows) {
        try {
          const payload = JSON.parse(row.payload) as {
            providerType?: string;
            modelKey?: string;
            modelId?: string;
            delta?: {
              inputTokens?: number;
              outputTokens?: number;
              cachedTokens?: number;
              cost?: number;
            };
          };
          const delta = payload.delta ?? {};
          insertSuccess.run(
            row.id,
            row.timestamp,
            row.workspace_id,
            row.task_id,
            "task_event",
            row.id,
            resolveProviderType({
              providerType: payload.providerType,
              routingPayload: row.routing_payload,
              providerLogPayload: row.provider_log_payload,
              agentConfig: row.agent_config,
            }),
            payload.modelKey || payload.modelId || null,
            payload.modelId || payload.modelKey || null,
            typeof delta.inputTokens === "number" ? delta.inputTokens : 0,
            typeof delta.outputTokens === "number" ? delta.outputTokens : 0,
            typeof delta.cachedTokens === "number" ? delta.cachedTokens : 0,
            typeof delta.cost === "number" ? delta.cost : 0,
          );
        } catch {
          // Ignore malformed legacy usage rows.
        }
      }

      try {
        errorRows = this.db
          .prepare(
            `SELECT
               te.id,
               te.task_id,
               t.workspace_id,
               te.timestamp,
               te.payload,
               t.agent_config,
               (
                 SELECT te2.payload
                 FROM task_events te2
                 WHERE te2.task_id = te.task_id
                   AND (te2.type = 'llm_routing_changed' OR te2.legacy_type = 'llm_routing_changed')
                   AND te2.timestamp <= te.timestamp
                 ORDER BY te2.timestamp DESC
                 LIMIT 1
               ) as routing_payload,
               (
                 SELECT te3.payload
                 FROM task_events te3
                 WHERE te3.task_id = te.task_id
                   AND (te3.type = 'log' OR te3.legacy_type = 'log')
                   AND te3.timestamp <= te.timestamp
                   AND te3.payload LIKE '%provider=%'
                 ORDER BY te3.timestamp DESC
                 LIMIT 1
               ) as provider_log_payload
             FROM task_events te
             JOIN tasks t ON t.id = te.task_id
             WHERE te.type = 'llm_error' OR te.legacy_type = 'llm_error'`,
          )
          .all() as ErrorRow[];
      } catch (error) {
        logger.warn("Unable to load legacy llm_error rows for backfill:", error);
      }

      for (const row of errorRows) {
        try {
          const payload = JSON.parse(row.payload) as {
            providerType?: string;
            modelKey?: string;
            modelId?: string;
            message?: string;
            details?: string;
          };
          insertError.run(
            row.id,
            row.timestamp,
            row.workspace_id,
            row.task_id,
            "task_event",
            row.id,
            resolveProviderType({
              providerType: payload.providerType,
              routingPayload: row.routing_payload,
              providerLogPayload: row.provider_log_payload,
              agentConfig: row.agent_config,
            }),
            payload.modelKey || payload.modelId || null,
            payload.modelId || payload.modelKey || null,
            "llm_error",
            typeof payload.details === "string"
              ? `${payload.message || "LLM error"} ${payload.details}`.trim().slice(0, 500)
              : String(payload.message || "LLM error").slice(0, 500),
          );
        } catch {
          // Ignore malformed legacy error rows.
        }
      }
    });

    try {
      tx();
    } catch (error) {
      logger.warn("Legacy llm_call_events backfill transaction failed:", error);
    }
  }

  private resetRollups(): void {
    this.db.exec("DELETE FROM usage_insights_day");
    this.db.exec("DELETE FROM usage_insights_hour");
    this.db.exec("DELETE FROM usage_insights_skill_day");
    this.db.exec("DELETE FROM usage_insights_tool_day");
    this.db.exec("DELETE FROM usage_insights_persona_day");
    this.db.exec("DELETE FROM usage_insights_feedback_reason_day");
  }

  private async rebuildAllRollupsIncremental(resumeAfterDateKey: string | null): Promise<void> {
    const pairs = this.collectWorkspaceDatePairs().filter(
      (item) => !resumeAfterDateKey || item.dateKey > resumeAfterDateKey,
    );
    if (pairs.length === 0) {
      return;
    }

    const tx = this.db.transaction((items: Array<{ workspaceId: string; dateKey: string }>) => {
      for (const item of items) {
        this.rebuildWorkspaceDate(item.workspaceId, item.dateKey);
      }
    });

    let currentDateKey: string | null = null;
    let batch: Array<{ workspaceId: string; dateKey: string }> = [];
    for (const item of pairs) {
      if (currentDateKey && item.dateKey !== currentDateKey && batch.length > 0) {
        tx(batch);
        this.setDateWatermarks(currentDateKey);
        this.invalidate();
        batch = [];
        await Promise.resolve();
      }
      currentDateKey = item.dateKey;
      batch.push(item);
    }

    if (currentDateKey && batch.length > 0) {
      tx(batch);
      this.setDateWatermarks(currentDateKey);
      this.invalidate();
    }
  }

  private collectWorkspaceDatePairs(): Array<{ workspaceId: string; dateKey: string }> {
    const pairs = new Set<string>();

    const addPair = (
      workspaceId: string | null | undefined,
      timestamp: number | null | undefined,
    ) => {
      if (!workspaceId || typeof timestamp !== "number" || !Number.isFinite(timestamp)) return;
      pairs.add(`${workspaceId}|${usageLocalDateKey(timestamp)}`);
    };

    try {
      const taskRows = this.db
        .prepare("SELECT workspace_id, created_at, completed_at FROM tasks")
        .all() as Array<{ workspace_id: string; created_at: number; completed_at: number | null }>;
      for (const row of taskRows) {
        addPair(row.workspace_id, row.created_at);
        addPair(row.workspace_id, row.completed_at);
      }
    } catch {
      // Ignore missing/partial task table failures.
    }

    try {
      const eventRows = this.db
        .prepare(
          `SELECT t.workspace_id, te.timestamp
           FROM task_events te
           JOIN tasks t ON t.id = te.task_id
           WHERE te.type IN ('skill_used', 'tool_call', 'tool_result', 'tool_error', 'tool_blocked', 'tool_warning', 'user_feedback')
              OR te.legacy_type IN ('skill_used', 'tool_call', 'tool_result', 'tool_error', 'tool_blocked', 'tool_warning', 'user_feedback')`,
        )
        .all() as Array<{ workspace_id: string; timestamp: number }>;
      for (const row of eventRows) {
        addPair(row.workspace_id, row.timestamp);
      }
    } catch {
      // Ignore missing/partial task_events table failures.
    }

    try {
      const llmRows = this.db
        .prepare(
          "SELECT workspace_id, timestamp FROM llm_call_events WHERE workspace_id IS NOT NULL",
        )
        .all() as Array<{ workspace_id: string; timestamp: number }>;
      for (const row of llmRows) {
        addPair(row.workspace_id, row.timestamp);
      }
    } catch {
      // Ignore missing llm_call_events table failures.
    }

    return Array.from(pairs)
      .map((pair) => {
        const [workspaceId, dateKey] = pair.split("|");
        return { workspaceId, dateKey };
      })
      .sort((a, b) => {
        if (a.dateKey === b.dateKey) return a.workspaceId.localeCompare(b.workspaceId);
        return a.dateKey.localeCompare(b.dateKey);
      });
  }

  private setDateWatermarks(dateKey: string): void {
    const { endExclusive } = dayBoundsForDateKey(dateKey);
    const watermark = String(Math.max(0, endExclusive - 1));
    this.setState(TASK_WATERMARK_KEY, watermark);
    this.setState(EVENT_WATERMARK_KEY, watermark);
  }

  private getMaxTimestamp(tableName: "llm_call_events"): number {
    try {
      const row = this.db.prepare(`SELECT MAX(timestamp) as max_ts FROM ${tableName}`).get() as
        | { max_ts: number | null }
        | undefined;
      return row?.max_ts || 0;
    } catch {
      return 0;
    }
  }

  private rebuildWorkspaceDate(workspaceId: string, dateKey: string): void {
    const { start, endExclusive } = dayBoundsForDateKey(dateKey);

    this.db
      .prepare("DELETE FROM usage_insights_day WHERE workspace_id = ? AND date_key = ?")
      .run(workspaceId, dateKey);
    this.db
      .prepare("DELETE FROM usage_insights_hour WHERE workspace_id = ? AND date_key = ?")
      .run(workspaceId, dateKey);
    this.db
      .prepare("DELETE FROM usage_insights_skill_day WHERE workspace_id = ? AND date_key = ?")
      .run(workspaceId, dateKey);
    this.db
      .prepare("DELETE FROM usage_insights_tool_day WHERE workspace_id = ? AND date_key = ?")
      .run(workspaceId, dateKey);
    this.db
      .prepare("DELETE FROM usage_insights_persona_day WHERE workspace_id = ? AND date_key = ?")
      .run(workspaceId, dateKey);
    this.db
      .prepare(
        "DELETE FROM usage_insights_feedback_reason_day WHERE workspace_id = ? AND date_key = ?",
      )
      .run(workspaceId, dateKey);

    const taskRow = this.db
      .prepare(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
           SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
           SUM(CASE WHEN status = 'completed' AND completed_at IS NOT NULL THEN completed_at - created_at ELSE 0 END) as completion_duration_sum,
           SUM(CASE WHEN status = 'completed' AND completed_at IS NOT NULL THEN 1 ELSE 0 END) as completion_duration_count,
           SUM(CASE WHEN current_attempt IS NOT NULL THEN current_attempt ELSE 0 END) as attempt_sum,
           SUM(CASE WHEN current_attempt IS NOT NULL THEN 1 ELSE 0 END) as attempt_count,
           SUM(CASE WHEN COALESCE(current_attempt, 1) > 1 THEN 1 ELSE 0 END) as retried_tasks,
           MAX(COALESCE(current_attempt, 1)) as max_attempts
         FROM tasks
         WHERE workspace_id = ?
           AND created_at >= ?
           AND created_at < ?`,
      )
      .get(workspaceId, start, endExclusive) as
      | {
          total: number | null;
          completed: number | null;
          failed: number | null;
          cancelled: number | null;
          completion_duration_sum: number | null;
          completion_duration_count: number | null;
          attempt_sum: number | null;
          attempt_count: number | null;
          retried_tasks: number | null;
          max_attempts: number | null;
        }
      | undefined;

    const awuRow = this.db
      .prepare(
        `SELECT COUNT(*) as count
         FROM tasks
         WHERE workspace_id = ?
           AND completed_at >= ?
           AND completed_at < ?
           AND status = 'completed'
           AND (terminal_status IN ('ok', 'partial_success', 'needs_user_action') OR terminal_status IS NULL)`,
      )
      .get(workspaceId, start, endExclusive) as { count: number } | undefined;

    const feedbackRows = this.db
      .prepare(
        `SELECT te.payload
         FROM task_events te
         JOIN tasks t ON t.id = te.task_id
         WHERE t.workspace_id = ?
           AND te.timestamp >= ?
           AND te.timestamp < ?
           AND (te.type = 'user_feedback' OR te.legacy_type = 'user_feedback')`,
      )
      .all(workspaceId, start, endExclusive) as Array<{ payload: string }>;

    let feedbackAccepted = 0;
    let feedbackRejected = 0;
    const rejectionReasons = new Map<string, number>();
    for (const row of feedbackRows) {
      try {
        const payload = JSON.parse(row.payload) as {
          decision?: "accepted" | "rejected";
          rating?: "positive" | "negative";
          reason?: string;
        };
        const accepted = payload.decision === "accepted" || payload.rating === "positive";
        const rejected = payload.decision === "rejected" || payload.rating === "negative";
        if (accepted) feedbackAccepted += 1;
        if (rejected) {
          feedbackRejected += 1;
          if (payload.reason) {
            rejectionReasons.set(payload.reason, (rejectionReasons.get(payload.reason) || 0) + 1);
          }
        }
      } catch {
        // Ignore malformed feedback payloads.
      }
    }

    const feedbackTotal = feedbackAccepted + feedbackRejected;
    if ((taskRow?.total || 0) > 0 || feedbackTotal > 0 || (awuRow?.count || 0) > 0) {
      this.db
        .prepare(
          `INSERT INTO usage_insights_day (
             workspace_id,
             date_key,
             task_created_total,
             task_completed_created,
             task_failed_created,
             task_cancelled_created,
             completed_duration_total_ms_created,
             completed_duration_count_created,
             attempt_sum_created,
             attempt_count_created,
             retried_tasks_created,
             max_attempt_created,
             feedback_total,
             feedback_accepted,
             feedback_rejected,
             awu_completed_ok
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          workspaceId,
          dateKey,
          taskRow?.total || 0,
          taskRow?.completed || 0,
          taskRow?.failed || 0,
          taskRow?.cancelled || 0,
          taskRow?.completion_duration_sum || 0,
          taskRow?.completion_duration_count || 0,
          taskRow?.attempt_sum || 0,
          taskRow?.attempt_count || 0,
          taskRow?.retried_tasks || 0,
          taskRow?.max_attempts || 0,
          feedbackTotal,
          feedbackAccepted,
          feedbackRejected,
          awuRow?.count || 0,
        );
    }

    const hourInsert = this.db.prepare(
      `INSERT INTO usage_insights_hour (
         workspace_id,
         date_key,
         day_of_week,
         hour_of_day,
         task_created_count
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    const createdRows = this.db
      .prepare(
        `SELECT created_at
         FROM tasks
         WHERE workspace_id = ?
           AND created_at >= ?
           AND created_at < ?`,
      )
      .all(workspaceId, start, endExclusive) as Array<{ created_at: number }>;
    const hourly = new Map<string, number>();
    for (const row of createdRows) {
      const dt = new Date(row.created_at);
      const key = `${dt.getDay()}|${dt.getHours()}`;
      hourly.set(key, (hourly.get(key) || 0) + 1);
    }
    for (const [key, count] of hourly.entries()) {
      const [dayOfWeek, hourOfDay] = key.split("|").map(Number);
      hourInsert.run(workspaceId, dateKey, dayOfWeek, hourOfDay, count);
    }

    const skillRows = this.db
      .prepare(
        `SELECT te.payload
         FROM task_events te
         JOIN tasks t ON t.id = te.task_id
         WHERE t.workspace_id = ?
           AND te.timestamp >= ?
           AND te.timestamp < ?
           AND (te.type = 'skill_used' OR te.legacy_type = 'skill_used')`,
      )
      .all(workspaceId, start, endExclusive) as Array<{ payload: string }>;
    const skillCounts = new Map<string, number>();
    for (const row of skillRows) {
      try {
        const payload = JSON.parse(row.payload) as { skillName?: string; name?: string };
        const skill = payload.skillName || payload.name || "unknown";
        skillCounts.set(skill, (skillCounts.get(skill) || 0) + 1);
      } catch {
        // Ignore malformed skill rows.
      }
    }
    const skillInsert = this.db.prepare(
      `INSERT INTO usage_insights_skill_day (workspace_id, date_key, skill, count)
       VALUES (?, ?, ?, ?)`,
    );
    for (const [skill, count] of skillCounts.entries()) {
      skillInsert.run(workspaceId, dateKey, skill, count);
    }

    const toolRows = this.db
      .prepare(
        `SELECT te.type, te.legacy_type, te.payload
         FROM task_events te
         JOIN tasks t ON t.id = te.task_id
         WHERE t.workspace_id = ?
           AND te.timestamp >= ?
           AND te.timestamp < ?
           AND (
             te.type IN ('tool_call', 'tool_result', 'tool_error', 'tool_blocked', 'tool_warning')
             OR te.legacy_type IN ('tool_call', 'tool_result', 'tool_error', 'tool_blocked', 'tool_warning')
           )`,
      )
      .all(workspaceId, start, endExclusive) as Array<{
      type: string | null;
      legacy_type: string | null;
      payload: string;
    }>;
    const toolMap = new Map<
      string,
      { calls: number; results: number; errors: number; blocked: number; warnings: number }
    >();
    for (const row of toolRows) {
      const eventType = getEffectiveEventType(row);
      let toolName = "";
      try {
        const payload = JSON.parse(row.payload) as {
          tool?: string;
          name?: string;
          toolName?: string;
        };
        toolName = payload.tool || payload.name || payload.toolName || "";
      } catch {
        // Ignore malformed tool rows.
      }
      if (!toolName) continue;
      const current = toolMap.get(toolName) ?? {
        calls: 0,
        results: 0,
        errors: 0,
        blocked: 0,
        warnings: 0,
      };
      if (eventType === "tool_call") current.calls += 1;
      else if (eventType === "tool_result") current.results += 1;
      else if (eventType === "tool_error") current.errors += 1;
      else if (eventType === "tool_blocked") current.blocked += 1;
      else if (eventType === "tool_warning") current.warnings += 1;
      toolMap.set(toolName, current);
    }
    const toolInsert = this.db.prepare(
      `INSERT INTO usage_insights_tool_day (
         workspace_id,
         date_key,
         tool,
         calls,
         results,
         errors,
         blocked,
         warnings
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [tool, data] of toolMap.entries()) {
      toolInsert.run(
        workspaceId,
        dateKey,
        tool,
        data.calls,
        data.results,
        data.errors,
        data.blocked,
        data.warnings,
      );
    }

    const personaRows = this.db
      .prepare(
        `SELECT
           COALESCE(t.assigned_agent_role_id, 'unassigned') as persona_id,
           COALESCE(ar.display_name, ar.name, 'Unassigned') as persona_name,
           COUNT(*) as total,
           SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END) as completed,
           SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END) as failed,
           SUM(CASE WHEN t.status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
           SUM(CASE WHEN t.status = 'completed' AND t.completed_at IS NOT NULL THEN t.completed_at - t.created_at ELSE 0 END) as completion_duration_sum,
           SUM(CASE WHEN t.status = 'completed' AND t.completed_at IS NOT NULL THEN 1 ELSE 0 END) as completion_duration_count,
           SUM(CASE WHEN t.current_attempt IS NOT NULL THEN t.current_attempt ELSE 0 END) as attempt_sum,
           SUM(CASE WHEN t.current_attempt IS NOT NULL THEN 1 ELSE 0 END) as attempt_count
         FROM tasks t
         LEFT JOIN agent_roles ar ON ar.id = t.assigned_agent_role_id
         WHERE t.workspace_id = ?
           AND t.created_at >= ?
           AND t.created_at < ?
         GROUP BY COALESCE(t.assigned_agent_role_id, 'unassigned'), COALESCE(ar.display_name, ar.name, 'Unassigned')`,
      )
      .all(workspaceId, start, endExclusive) as Array<{
      persona_id: string;
      persona_name: string;
      total: number;
      completed: number;
      failed: number;
      cancelled: number;
      completion_duration_sum: number | null;
      completion_duration_count: number | null;
      attempt_sum: number | null;
      attempt_count: number | null;
    }>;

    const personaCostRows = this.db
      .prepare(
        `SELECT
           COALESCE(t.assigned_agent_role_id, 'unassigned') as persona_id,
           COALESCE(ar.display_name, ar.name, 'Unassigned') as persona_name,
           SUM(lce.cost) as total_cost
         FROM llm_call_events lce
         LEFT JOIN tasks t ON t.id = lce.task_id
         LEFT JOIN agent_roles ar ON ar.id = t.assigned_agent_role_id
         WHERE lce.workspace_id = ?
           AND lce.success = 1
           AND lce.timestamp >= ?
           AND lce.timestamp < ?
         GROUP BY COALESCE(t.assigned_agent_role_id, 'unassigned'), COALESCE(ar.display_name, ar.name, 'Unassigned')`,
      )
      .all(workspaceId, start, endExclusive) as Array<{
      persona_id: string;
      persona_name: string;
      total_cost: number | null;
    }>;
    const personaCostMap = new Map<string, { personaName: string; totalCost: number }>();
    for (const row of personaCostRows) {
      personaCostMap.set(row.persona_id, {
        personaName: row.persona_name,
        totalCost: row.total_cost || 0,
      });
    }
    const personaInsert = this.db.prepare(
      `INSERT INTO usage_insights_persona_day (
         workspace_id,
         date_key,
         persona_id,
         persona_name,
         total,
         completed,
         failed,
         cancelled,
         completion_duration_total_ms,
         completion_duration_count,
         attempt_sum,
         attempt_count,
         total_cost
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const allPersonaIds = new Set<string>([
      ...personaRows.map((row) => row.persona_id),
      ...personaCostRows.map((row) => row.persona_id),
    ]);
    for (const personaId of allPersonaIds) {
      const metrics = personaRows.find((row) => row.persona_id === personaId);
      const cost = personaCostMap.get(personaId);
      personaInsert.run(
        workspaceId,
        dateKey,
        personaId,
        metrics?.persona_name || cost?.personaName || "Unassigned",
        metrics?.total || 0,
        metrics?.completed || 0,
        metrics?.failed || 0,
        metrics?.cancelled || 0,
        metrics?.completion_duration_sum || 0,
        metrics?.completion_duration_count || 0,
        metrics?.attempt_sum || 0,
        metrics?.attempt_count || 0,
        cost?.totalCost || 0,
      );
    }

    const feedbackReasonInsert = this.db.prepare(
      `INSERT INTO usage_insights_feedback_reason_day (
         workspace_id,
         date_key,
         reason,
         rejected_count
       ) VALUES (?, ?, ?, ?)`,
    );
    for (const [reason, count] of rejectionReasons.entries()) {
      feedbackReasonInsert.run(workspaceId, dateKey, reason, count);
    }
  }

  private updateWatermarks(): void {
    try {
      const taskRow = this.db
        .prepare(
          "SELECT MAX(created_at) as task_max, MAX(completed_at) as completed_max FROM tasks",
        )
        .get() as { task_max: number | null; completed_max: number | null } | undefined;
      const eventRow = this.db
        .prepare(
          `SELECT MAX(timestamp) as event_max
           FROM task_events
           WHERE type IN ('skill_used', 'tool_call', 'tool_result', 'tool_error', 'tool_blocked', 'tool_warning', 'user_feedback', 'llm_usage', 'llm_error')
              OR legacy_type IN ('skill_used', 'tool_call', 'tool_result', 'tool_error', 'tool_blocked', 'tool_warning', 'user_feedback', 'llm_usage', 'llm_error')`,
        )
        .get() as { event_max: number | null } | undefined;
      const llmRow = this.db
        .prepare("SELECT MAX(timestamp) as llm_max FROM llm_call_events")
        .get() as { llm_max: number | null } | undefined;

      const taskMax = Math.max(taskRow?.task_max || 0, taskRow?.completed_max || 0);
      this.setState(TASK_WATERMARK_KEY, String(taskMax));
      this.setState(EVENT_WATERMARK_KEY, String(eventRow?.event_max || 0));
      this.setState(LLM_WATERMARK_KEY, String(llmRow?.llm_max || 0));
    } catch (error) {
      logger.warn("Failed to update usage insight watermarks:", error);
    }
  }
}
