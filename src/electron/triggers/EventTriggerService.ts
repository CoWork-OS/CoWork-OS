/**
 * EventTriggerService — condition-based automation engine.
 *
 * Listens to events from the channel gateway, cron service, and webhooks.
 * Evaluates registered triggers' conditions and fires actions (create_task,
 * send_message, wake_agent) when conditions match.
 */

import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import { serviceStatements, type ServiceStatementPort } from "../database/service-statements";
import {
  EventTrigger,
  TriggerEvent,
  TriggerHistoryEntry,
  EventTriggerServiceDeps,
  type EventTriggerRegistry,
} from "./types";
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

export class EventTriggerService implements EventTriggerRegistry {
  private triggers: Map<string, EventTrigger> = new Map();
  private history: Map<string, TriggerHistoryEntry[]> = new Map(); // triggerId → entries
  private running = false;
  private deps: EventTriggerServiceDeps;
  private db: Any; // better-sqlite3 database instance
  /** Trigger persistence as services-domain units (DB6); null without a database. */
  private sql: ServiceStatementPort | null;
  private ready: Promise<void> = Promise.resolve();
  private queueTimer: NodeJS.Timeout | null = null;
  private drainingQueue = false;
  private drainPromise: Promise<void> | null = null;
  private fireInterceptor:
    | ((
        trigger: EventTrigger,
        event: TriggerEvent,
      ) => Promise<{ handled: boolean; actionResult?: string }>)
    | null = null;

  constructor(deps: EventTriggerServiceDeps, db?: Any) {
    this.deps = deps;
    this.db = db;
    this.sql = db ? serviceStatements(db as Database.Database) : null;
    this.ensureSchema();
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  /** Load the triggers and requeue interrupted events; events wait until this is done. */
  start(): Promise<void> {
    if (this.running) return this.ready;
    this.running = true;
    this.ready = this.startNow();
    return this.ready;
  }

  private async startNow(): Promise<void> {
    await this.loadFromDB();
    if (this.sql) {
      try {
        await this.sql.unit("eventTrigger_recoverProcessing", [Date.now()]);
      } catch (error) {
        this.log("[EventTriggerService] Failed to recover queued events:", error);
      }
      if (!this.running) return;
      this.queueTimer = setInterval(() => void this.drainQueuedEvents(), 1_000);
      void this.drainQueuedEvents();
    }
    this.log("[EventTriggerService] Started with", this.triggers.size, "triggers");
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.queueTimer) clearInterval(this.queueTimer);
    this.queueTimer = null;
    await this.drainPromise;
    this.log("[EventTriggerService] Stopped");
  }

  setFireInterceptor(
    interceptor:
      | ((
          trigger: EventTrigger,
          event: TriggerEvent,
        ) => Promise<{ handled: boolean; actionResult?: string }>)
      | null,
  ): void {
    this.fireInterceptor = interceptor;
  }

  async drainPendingEvents(): Promise<void> {
    const drainPromise = this.drainQueuedEvents();
    await drainPromise;
    if (this.drainPromise === drainPromise) this.drainPromise = null;
    if (this.running) await this.drainQueuedEvents();
  }

  // ── CRUD ────────────────────────────────────────────────────────

  async addTrigger(
    input: Omit<EventTrigger, "id" | "fireCount" | "createdAt" | "updatedAt">,
  ): Promise<EventTrigger> {
    const now = Date.now();
    const trigger: EventTrigger = {
      ...input,
      id: randomUUID(),
      fireCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.triggers.set(trigger.id, trigger);
    await this.saveToDB(trigger);
    return trigger;
  }

  async updateTrigger(id: string, updates: Partial<EventTrigger>): Promise<EventTrigger | null> {
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
    await this.saveToDB(updated);
    return updated;
  }

  async removeTrigger(id: string): Promise<boolean> {
    const deleted = this.triggers.delete(id);
    if (deleted) await this.deleteFromDB(id);
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
    await this.ready;

    const activeCount = this.deps.getActiveTaskCount?.() ?? 0;
    if (activeCount >= 4 && this.sql) {
      await this.enqueueEvent(event);
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
    await this.saveToDB(trigger);

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
    // History is kept in memory as well; its row is written without delaying the hook.
    void this.saveHistoryToDB(historyEntry);
    try {
      this.deps.onTriggerFired?.({ trigger, event, historyEntry });
    } catch (error) {
      this.deps.log?.(`Trigger "${trigger.name}" post-fire hook failed:`, error);
    }
  }

  private async enqueueEvent(event: TriggerEvent): Promise<void> {
    if (!this.sql) return;
    const id = randomUUID();
    const dedupeKey = `${event.source}:${event.timestamp}:${stableStringify(event.fields)}`;
    try {
      await this.sql.unit("eventTrigger_enqueue", [
        id,
        dedupeKey,
        JSON.stringify(event),
        Date.now(),
      ]);
    } catch (error) {
      this.log("[EventTriggerService] Failed to queue event:", error);
    }
  }

  private drainQueuedEvents(): Promise<void> {
    if (!this.running || !this.sql) return Promise.resolve();
    if (this.drainPromise) return this.drainPromise;

    const promise = this.runDrainQueuedEvents().catch((error) => {
      this.log("[EventTriggerService] Failed to drain queued events:", error);
    });
    this.drainPromise = promise;
    void promise.then(
      () => {
        if (this.drainPromise === promise) this.drainPromise = null;
      },
      () => {
        if (this.drainPromise === promise) this.drainPromise = null;
      },
    );
    return promise;
  }

  private async runDrainQueuedEvents(): Promise<void> {
    const sql = this.sql;
    if (!this.running || !sql || this.drainingQueue) return;
    if ((this.deps.getActiveTaskCount?.() ?? 0) >= 4) return;
    this.drainingQueue = true;
    try {
      while (this.running && (this.deps.getActiveTaskCount?.() ?? 0) < 4) {
        const row = (await sql.unit("eventTrigger_claimNext", [Date.now()])) as Any | undefined;
        if (!row) return;
        try {
          const event = JSON.parse(String(row.event_json)) as TriggerEvent;
          await this.evaluateEventNow(event);
          if (!this.running) return;
          await sql.unit("eventTrigger_completeQueued", [row.id]);
        } catch (error) {
          if (!this.running) return;
          // The claim already counted this attempt.
          const attemptCount = Number(row.attempt_count || 0) + 1;
          const message = error instanceof Error ? error.message : String(error);
          await sql.unit("eventTrigger_retryQueued", [row.id, message, attemptCount, Date.now()]);
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

  private async loadFromDB(): Promise<void> {
    if (!this.sql) return;
    try {
      const rows = (await this.sql.unit("eventTrigger_loadTriggerRows", [])) as Any[];
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

  private async saveToDB(trigger: EventTrigger): Promise<void> {
    if (!this.sql) return;
    try {
      await this.sql.unit("eventTrigger_saveTrigger", [trigger]);
    } catch (err) {
      this.log("[EventTriggerService] Failed to save trigger:", err);
    }
  }

  private async deleteFromDB(id: string): Promise<void> {
    if (!this.sql) return;
    try {
      await this.sql.unit("eventTrigger_deleteTrigger", [id]);
    } catch (err) {
      this.log("[EventTriggerService] Failed to delete trigger:", err);
    }
  }

  private async saveHistoryToDB(entry: TriggerHistoryEntry): Promise<void> {
    if (!this.sql) return;
    try {
      await this.sql.unit("eventTrigger_saveHistory", [entry]);
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
