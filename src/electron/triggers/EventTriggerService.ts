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

export class EventTriggerService {
  private triggers: Map<string, EventTrigger> = new Map();
  private history: Map<string, TriggerHistoryEntry[]> = new Map(); // triggerId → entries
  private running = false;
  private deps: EventTriggerServiceDeps;
  private db: any; // better-sqlite3 database instance

  constructor(deps: EventTriggerServiceDeps, db?: any) {
    this.deps = deps;
    this.db = db;
    this.ensureSchema();
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loadFromDB();
    this.log("[EventTriggerService] Started with", this.triggers.size, "triggers");
  }

  stop(): void {
    this.running = false;
    this.log("[EventTriggerService] Stopped");
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

    for (const trigger of this.triggers.values()) {
      if (!trigger.enabled) continue;
      if (trigger.source !== event.source) continue;

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
    };

    try {
      const action = trigger.action;
      const cfg = action.config;

      switch (action.type) {
        case "create_task": {
          const prompt = substituteEventVariables(cfg.prompt || "", event);
          const title = substituteEventVariables(cfg.title || `Trigger: ${trigger.name}`, event);
          const result = await this.deps.createTask({
            title,
            prompt,
            workspaceId:
              cfg.workspaceId || trigger.workspaceId || this.deps.getDefaultWorkspaceId(),
          });
          historyEntry.taskId = result.id;
          historyEntry.actionResult = "task_created";
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

    // Record history
    if (!this.history.has(trigger.id)) {
      this.history.set(trigger.id, []);
    }
    const entries = this.history.get(trigger.id)!;
    entries.unshift(historyEntry);
    if (entries.length > MAX_HISTORY_PER_TRIGGER) {
      entries.length = MAX_HISTORY_PER_TRIGGER;
    }
    this.saveHistoryToDB(historyEntry);
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
      `);
    } catch {
      // Tables already exist
    }
  }

  private loadFromDB(): void {
    if (!this.db) return;
    try {
      const rows = this.db.prepare("SELECT * FROM event_triggers").all() as any[];
      for (const row of rows) {
        let conditions: any[];
        let action: any;
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
