/**
 * `wait_for_event` (agent-first roadmap WP12): park the task until an event arrives, instead of
 * polling or sleeping. The task pauses after the current turn and continues with the event's
 * fields when it arrives, or with a timeout note.
 */
import type { AgentDaemon } from "../daemon";
import type { LLMTool } from "../llm/types";
import type { ConditionOperator, TriggerCondition, TriggerSource } from "../../triggers/types";

const SOURCES: readonly TriggerSource[] = ["file_change", "github_event", "webhook"];
const OPERATORS: readonly ConditionOperator[] = [
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "matches",
  "starts_with",
  "ends_with",
  "gt",
  "lt",
];
const MAX_CONDITIONS = 5;
const DEFAULT_TIMEOUT_MINUTES = 60;
const MAX_TIMEOUT_MINUTES = 7 * 24 * 60;

export class EventWaitTools {
  constructor(
    private readonly daemon: AgentDaemon,
    private readonly taskId: string,
  ) {}

  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: "wait_for_event",
        description:
          "Pause this task until something happens outside it, instead of polling or sleeping. " +
          "Use when the next step depends on an event: a file changing in this workspace " +
          "(file_change, fields path and eventType), a GitHub event (github_event), or an " +
          "incoming webhook (webhook). After calling it, finish your turn with a short note of " +
          "what you are waiting for: the task pauses, then continues with the event's fields " +
          "when it arrives, or tells you it timed out. Use schedule_task for a fixed time instead.",
        input_schema: {
          type: "object",
          properties: {
            source: {
              type: "string",
              enum: [...SOURCES],
              description: "Which kind of event to wait for",
            },
            conditions: {
              type: "array",
              description:
                "All must match; e.g. {field: 'path', operator: 'equals', value: 'report.csv'}",
              items: {
                type: "object",
                properties: {
                  field: { type: "string" },
                  operator: { type: "string", enum: [...OPERATORS] },
                  value: { type: "string" },
                },
                required: ["field", "operator", "value"],
              },
            },
            timeout_minutes: {
              type: "number",
              description: `How long to wait before continuing without it (1-${MAX_TIMEOUT_MINUTES}, default ${DEFAULT_TIMEOUT_MINUTES})`,
            },
            reason: {
              type: "string",
              description: "What you are waiting for, shown to the user",
            },
          },
          required: ["source", "reason"],
        },
      },
    ];
  }

  async waitForEvent(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const source = input?.source as TriggerSource;
    if (!SOURCES.includes(source)) {
      throw new Error(`source must be one of: ${SOURCES.join(", ")}`);
    }
    const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 300) : "";
    if (!reason) throw new Error("reason is required: say what you are waiting for.");
    const rawConditions = Array.isArray(input.conditions) ? input.conditions : [];
    if (rawConditions.length > MAX_CONDITIONS) {
      throw new Error(`At most ${MAX_CONDITIONS} conditions are allowed.`);
    }
    const conditions: TriggerCondition[] = rawConditions.map((raw) => {
      const condition = (raw ?? {}) as Record<string, unknown>;
      const field = typeof condition.field === "string" ? condition.field.trim() : "";
      const operator = condition.operator as ConditionOperator;
      const value =
        typeof condition.value === "string" ? condition.value : String(condition.value ?? "");
      if (!field || field.length > 100 || !OPERATORS.includes(operator) || value.length > 500) {
        throw new Error(
          "Each condition needs a field, a known operator and a value up to 500 characters.",
        );
      }
      return { field, operator, value };
    });
    const minutes = Number(input.timeout_minutes ?? DEFAULT_TIMEOUT_MINUTES);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > MAX_TIMEOUT_MINUTES) {
      throw new Error(`timeout_minutes must be between 1 and ${MAX_TIMEOUT_MINUTES}.`);
    }
    const { triggerId, expiresAt } = await this.daemon.beginEventWait(this.taskId, {
      source,
      conditions,
      timeoutMs: Math.round(minutes * 60_000),
      reason,
    });
    return {
      success: true,
      status: "waiting",
      triggerId,
      expiresAt: new Date(expiresAt).toISOString(),
      message:
        "Waiting is set up. Finish this turn now with a short note of what you are waiting for; " +
        "the task continues when the event arrives or when the wait times out.",
    };
  }
}
