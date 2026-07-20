/**
 * EventTriggerService — condition-based automation engine.
 *
 * Listens to events from the channel gateway, cron service, and webhooks.
 * Evaluates registered triggers' conditions and fires actions (create_task,
 * send_message, wake_agent) when conditions match.
 */

import { randomUUID } from "crypto";
import { EventTrigger, TriggerEvent, TriggerHistoryEntry, EventTriggerServiceDeps } from "./types";
import { evaluateConditions, substituteEventVariables } from "./condition-evaluator";

const DEFAULT_COOLDOWN_MS = 60_000; // 1 minute
const MAX_HISTORY_PER_TRIGGER = 50;

function isMailboxEventSource(source: string): boolean {
  return source === "mailbox_event";
}

function triggerMatchesEventSource(triggerSource: string, eventSource: string): boolean {
  if (triggerSource === eventSource) return true;
  if (triggerSource === "email" && eventSource === "mailbox_event") return true;
  if (triggerSource === "mailbox_event" && eventSource === "email") return true;
  return false;
}

export class EventTriggerService {
  private triggers: Map<string, EventTrigger> = new Map();
  private history: Map<string, TriggerHistoryEntry[]> = new Map(); // triggerId → entries
  private running = false;
  private deps: EventTriggerServiceDeps;
  private db: Any; // better-sqlite3 database instance
  private queueTimer: NodeJS.Timeout | null = null;
  private drainingQueue = false;
  private fireInterceptor:
    | ((trigger: EventTrigger, event: TriggerEvent) => Promise<{ handled: boolean; actionResult?: string }>)
    | null = null;

  constructor(deps: EventTriggerServiceDeps, db?: Any) {
    this.deps = deps;
    this.db = db;
    this.ensureSchema();
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loadFromDB();
    if (this.db) {
      this.db
        .prepare(
          `UPDATE event_trigger_queue
           SET status = 'pending', available_at = ?,
               error = COALESCE(error, 'Recovered after application restart.'), updated_at = ?
           WHERE status = 'processing'`,
        )
        .run(Date.now(), Date.now());
      this.queueTimer = setInterval(() => void this.drainQueuedEvents(), 1_000);
      void this.drainQueuedEvents();
    }
    this.log("[EventTriggerService] Started with", this.triggers.size, "triggers");
  }

  stop(): void {
    this.running = false;
    if (this.queueTimer) clearInterval(this.queueTimer);
    this.queueTimer = null;
    this.log("[EventTriggerService] Stopped");
  }

  setFireInterceptor(
    interceptor:
      | ((trigger: EventTrigger, event: TriggerEvent) => Promise<{ handled: boolean; actionResult?: string }>)
      | null,
  ): void {
    this.fireInterceptor = interceptor;
  }

  async drainPendingEvents(): Promise<void> {
    await this.drainQueuedEvents();
  }

  // ── CRUD ────────────────────────────────────────────────────────

  addTrigger(
    input: Omit<EventTrigger, "id" | "fireCount" | "createdAt" | "updatedAt">,
  ): EventTrigger {
    const now = Date.now();
    const trigger: EventTrigger = {
      ...input,
      id: randomUUID(),
      fireCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.triggers.set(trigger.id, trigger);
    this.saveToDB(trigger);
    return trigger;
  }

  updateTrigger(id: string, updates: Partial<EventTrigger>): EventTrigger | null {
    const existing = this.triggers.get(id);
    if (!existing) return null;
    const updated: EventTrigger = {
      ...existing,
      ...updates,
      id: existing.id, // immutable
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
    };
    this.triggers.set(id, updated);
    this.saveToDB(updated);
    return updated;
  }

  removeTrigger(id: string): boolean {
    const deleted = this.triggers.delete(id);
    if (deleted) this.deleteFromDB(id);
    return deleted;
  }

  listTriggers(workspaceId?: string): EventTrigger[] {
    const all = Array.from(this.triggers.values());
    if (!workspaceId) return all;
    return all.filter((t) => t.workspaceId === workspaceId);
  }

  getTrigger(id: string): EventTrigger | undefined {
    return this.triggers.get(id);
  }

  getHistory(triggerId: string, limit = 20): TriggerHistoryEntry[] {
    const entries = this.history.get(triggerId) || [];
    return entries.slice(0, limit);
  }

  // ── Event evaluation ────────────────────────────────────────────

  /**
   * Called by the gateway router, cron service, or webhook handler
   * whenever a relevant event occurs.  Evaluates all enabled triggers
   * whose source matches the event source.
   */
  async evaluateEvent(event: TriggerEvent): Promise<void> {
    if (!this.running) return;

    const activeCount = this.deps.getActiveTaskCount?.() ?? 0;
    if (activeCount >= 4 && this.db) {
      this.enqueueEvent(event);
      return;
    }

    await this.evaluateEventNow(event);
  }

  private async evaluateEventNow(event: TriggerEvent): Promise<void> {

    for (const trigger of this.triggers.values()) {
      if (!trigger.enabled) continue;
      if (!triggerMatchesEventSource(trigger.source, event.source)) continue;

      // Cooldown check
      const cooldown = trigger.cooldownMs ?? DEFAULT_COOLDOWN_MS;
      if (trigger.lastFiredAt && Date.now() - trigger.lastFiredAt < cooldown) continue;

      let matched = false;
      try {
        matched = evaluateConditions(event, trigger.conditions, trigger.conditionLogic || "all");
      } catch (err) {
        this.deps.log?.(`Trigger "${trigger.name}" condition evaluation failed:`, err);
        continue;
      }

      if (matched) {
        await this.fireTrigger(trigger, event);
      }
    }
  }

  // ── Action execution ────────────────────────────────────────────

  private async fireTrigger(trigger: EventTrigger, event: TriggerEvent): Promise<void> {
    const now = Date.now();
    trigger.lastFiredAt = now;
    trigger.fireCount += 1;
    this.saveToDB(trigger);

    const historyEntry: TriggerHistoryEntry = {
      id: randomUUID(),
      triggerId: trigger.id,
      firedAt: now,
      eventData: event.fields as Record<string, unknown>,
      sourceLabel: isMailboxEventSource(trigger.source) ? "Inbox automation" : trigger.source,
    };

    try {
      const intercepted = await this.fireInterceptor?.(trigger, event);
      if (intercepted?.handled) {
        historyEntry.actionResult = intercepted.actionResult || "workflow_queued";
        this.recordHistory(trigger, event, historyEntry);
        return;
      }
      const action = trigger.action;
      const cfg = action.config;

      switch (action.type) {
        case "create_task": {
          const prompt = substituteEventVariables(cfg.prompt || "", event);
          const title = substituteEventVariables(cfg.title || `Trigger: ${trigger.name}`, event);
          if (cfg.runMode === "thread_follow_up") {
            if (!cfg.targetTaskId) {
              throw new Error("Thread follow-up trigger is missing a target task");
            }
            if (!this.deps.sendTaskMessage) {
              throw new Error("Thread follow-up execution is not available in this runtime");
            }
            await this.deps.sendTaskMessage({
              taskId: cfg.targetTaskId,
              message: prompt,
              agentConfig: cfg.agentConfig,
            });
            historyEntry.taskId = cfg.targetTaskId;
            historyEntry.actionResult = "thread_follow_up_sent";
          } else {
            const result = await this.deps.createTask({
              title,
              prompt,
              workspaceId:
                cfg.workspaceId || trigger.workspaceId || this.deps.getDefaultWorkspaceId(),
              agentConfig: cfg.agentConfig,
            });
            historyEntry.taskId = result.id;
            historyEntry.actionResult = "task_created";
          }
          break;
        }

        case "send_message": {
          if (this.deps.deliverToChannel && cfg.channelType && cfg.channelId) {
            const text = substituteEventVariables(cfg.message || "", event);
            await this.deps.deliverToChannel({
              channelType: cfg.channelType,
              channelId: cfg.channelId,
              text,
            });
            historyEntry.actionResult = "message_sent";
          }
          break;
        }

        case "wake_agent": {
          if (this.deps.wakeAgent && cfg.agentRoleId) {
            const prompt = substituteEventVariables(cfg.prompt || "", event);
            this.deps.wakeAgent(cfg.agentRoleId, prompt);
            historyEntry.actionResult = "agent_woken";
          }
          break;
        }
      }
    } catch (error) {
      historyEntry.actionResult = `error: ${error instanceof Error ? error.message : String(error)}`;
    }

    this.recordHistory(trigger, event, historyEntry);
  }

  private recordHistory(
    trigger: EventTrigger,
    event: TriggerEvent,
    historyEntry: TriggerHistoryEntry,
  ): void {
    if (!this.history.has(trigger.id)) {
      this.history.set(trigger.id, []);
    }
    const entries = this.history.get(trigger.id)!;
    entries.unshift(historyEntry);
    if (entries.length > MAX_HISTORY_PER_TRIGGER) {
      entries.length = MAX_HISTORY_PER_TRIGGER;
    }
    this.saveHistoryToDB(historyEntry);
    try {
      this.deps.onTriggerFired?.({ trigger, event, historyEntry });
    } catch (error) {
      this.deps.log?.(`Trigger "${trigger.name}" post-fire hook failed:`, error);
    }
  }

  private enqueueEvent(event: TriggerEvent): void {
    if (!this.db) return;
    const id = randomUUID();
    const dedupeKey = `${event.source}:${event.timestamp}:${stableStringify(event.fields)}`;
    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO event_trigger_queue
           (id, dedupe_key, event_json, status, attempt_count, available_at, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`,
        )
        .run(id, dedupeKey, JSON.stringify(event), Date.now(), Date.now(), Date.now());
    } catch (error) {
      this.log("[EventTriggerService] Failed to queue event:", error);
    }
  }

  private async drainQueuedEvents(): Promise<void> {
    if (!this.running || !this.db || this.drainingQueue) return;
    if ((this.deps.getActiveTaskCount?.() ?? 0) >= 4) return;
    this.drainingQueue = true;
    try {
      while ((this.deps.getActiveTaskCount?.() ?? 0) < 4) {
        const now = Date.now();
        const row = this.db
          .prepare(
            `SELECT * FROM event_trigger_queue
             WHERE status = 'pending' AND available_at <= ?
             ORDER BY created_at ASC LIMIT 1`,
          )
          .get(now) as Any | undefined;
        if (!row) return;
        this.db
          .prepare("UPDATE event_trigger_queue SET status = 'processing', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?")
          .run(now, row.id);
        try {
          const event = JSON.parse(String(row.event_json)) as TriggerEvent;
          await this.evaluateEventNow(event);
          this.db.prepare("DELETE FROM event_trigger_queue WHERE id = ?").run(row.id);
        } catch (error) {
          const attemptCount = Number(row.attempt_count || 0) + 1;
          const message = error instanceof Error ? error.message : String(error);
          if (attemptCount >= 5) {
            this.db
              .prepare("UPDATE event_trigger_queue SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
              .run(message, Date.now(), row.id);
          } else {
            this.db
              .prepare("UPDATE event_trigger_queue SET status = 'pending', error = ?, available_at = ?, updated_at = ? WHERE id = ?")
              .run(message, Date.now() + Math.min(60_000, 1_000 * 2 ** attemptCount), Date.now(), row.id);
          }
        }
      }
    } finally {
      this.drainingQueue = false;
    }
  }

  // ── Database persistence ────────────────────────────────────────

  private ensureSchema(): void {
    if (!this.db) return;
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS event_triggers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          enabled INTEGER DEFAULT 1,
          source TEXT NOT NULL,
          conditions TEXT NOT NULL,
          condition_logic TEXT DEFAULT 'all',
          action TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          cooldown_ms INTEGER DEFAULT ${DEFAULT_COOLDOWN_MS},
          last_fired_at INTEGER,
          fire_count INTEGER DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_triggers_workspace ON event_triggers(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_triggers_enabled ON event_triggers(enabled);

        CREATE TABLE IF NOT EXISTS event_trigger_history (
          id TEXT PRIMARY KEY,
          trigger_id TEXT NOT NULL,
          fired_at INTEGER NOT NULL,
          event_data TEXT NOT NULL,
          action_result TEXT,
          task_id TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_trigger_history_trigger ON event_trigger_history(trigger_id, fired_at DESC);

        CREATE TABLE IF NOT EXISTS event_trigger_queue (
          id TEXT PRIMARY KEY,
          dedupe_key TEXT NOT NULL UNIQUE,
          event_json TEXT NOT NULL,
          status TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          available_at INTEGER NOT NULL,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_event_trigger_queue_pending
        ON event_trigger_queue(status, available_at, created_at);
      `);
    } catch {
      // Tables already exist
    }
  }

  private loadFromDB(): void {
    if (!this.db) return;
    try {
      const rows = this.db.prepare("SELECT * FROM event_triggers").all() as Any[];
      for (const row of rows) {
        let conditions: Any[];
        let action: Any;
        try {
          conditions = JSON.parse(row.conditions || "[]");
        } catch {
          this.deps.log?.(`Trigger ${row.id}: corrupt conditions JSON, skipping`);
          continue;
        }
        try {
          action = JSON.parse(row.action || "{}");
        } catch {
          this.deps.log?.(`Trigger ${row.id}: corrupt action JSON, skipping`);
          continue;
        }
        const trigger: EventTrigger = {
          id: row.id,
          name: row.name,
          description: row.description || undefined,
          enabled: !!row.enabled,
          source: row.source,
          conditions,
          conditionLogic: row.condition_logic || "all",
          action,
          workspaceId: row.workspace_id,
          cooldownMs: row.cooldown_ms,
          lastFiredAt: row.last_fired_at || undefined,
          fireCount: row.fire_count || 0,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
        this.triggers.set(trigger.id, trigger);
      }
    } catch (err) {
      this.log("[EventTriggerService] Failed to load triggers:", err);
    }
  }

  private saveToDB(trigger: EventTrigger): void {
    if (!this.db) return;
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO event_triggers
           (id, name, description, enabled, source, conditions, condition_logic, action,
            workspace_id, cooldown_ms, last_fired_at, fire_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          trigger.id,
          trigger.name,
          trigger.description || null,
          trigger.enabled ? 1 : 0,
          trigger.source,
          JSON.stringify(trigger.conditions),
          trigger.conditionLogic || "all",
          JSON.stringify(trigger.action),
          trigger.workspaceId,
          trigger.cooldownMs ?? DEFAULT_COOLDOWN_MS,
          trigger.lastFiredAt || null,
          trigger.fireCount,
          trigger.createdAt,
          trigger.updatedAt,
        );
    } catch (err) {
      this.log("[EventTriggerService] Failed to save trigger:", err);
    }
  }

  private deleteFromDB(id: string): void {
    if (!this.db) return;
    try {
      this.db.prepare("DELETE FROM event_triggers WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM event_trigger_history WHERE trigger_id = ?").run(id);
    } catch (err) {
      this.log("[EventTriggerService] Failed to delete trigger:", err);
    }
  }

  private saveHistoryToDB(entry: TriggerHistoryEntry): void {
    if (!this.db) return;
    try {
      this.db
        .prepare(
          `INSERT INTO event_trigger_history (id, trigger_id, fired_at, event_data, action_result, task_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.id,
          entry.triggerId,
          entry.firedAt,
          JSON.stringify(entry.eventData),
          entry.actionResult || null,
          entry.taskId || null,
        );
    } catch (err) {
      this.log("[EventTriggerService] Failed to save history:", err);
    }
  }

  private log(...args: unknown[]): void {
    if (this.deps.log) this.deps.log(...args);
    else console.log(...args);
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
