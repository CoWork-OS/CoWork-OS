import type { TaskEvent } from "../../shared/types";
import { loadPolicies } from "../admin/policies";
import { createHash } from "crypto";

const EXPORTABLE_EVENT_TYPES = new Set([
  "approval_requested",
  "approval_granted",
  "approval_denied",
  "tool_call",
  "tool_result",
  "tool_error",
  "tool_warning",
  "sandbox_denied",
  "shell_sandbox_bypassed",
  "network_policy_decision",
  "permission_mode_overridden",
]);

function stableHexId(input: string, bytes: number): string {
  return createHash("sha256")
    .update(input)
    .digest("hex")
    .slice(0, bytes * 2);
}

function toHrTime(timestampMs: number): string {
  const ns = BigInt(Math.max(0, Math.floor(timestampMs))) * 1_000_000n;
  return ns.toString();
}

function toAttributes(
  input: Record<string, unknown>,
): Array<{ key: string; value: Record<string, unknown> }> {
  return Object.entries(input).map(([key, value]) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return { key, value: { doubleValue: value } };
    }
    if (typeof value === "boolean") {
      return { key, value: { boolValue: value } };
    }
    return { key, value: { stringValue: String(value ?? "") } };
  });
}

function eventKind(
  type: string,
): "tool" | "approval" | "sandbox" | "network" | "permission" | "other" {
  if (
    type === "tool_call" ||
    type === "tool_result" ||
    type === "tool_error" ||
    type === "tool_warning"
  )
    return "tool";
  if (type.startsWith("approval_")) return "approval";
  if (type === "sandbox_denied" || type === "shell_sandbox_bypassed") return "sandbox";
  if (type === "network_policy_decision") return "network";
  if (type === "permission_mode_overridden") return "permission";
  return "other";
}

export function enqueueTaskEventTelemetry(event: TaskEvent): void {
  if (!EXPORTABLE_EVENT_TYPES.has(String(event.type))) return;

  let policies;
  try {
    policies = loadPolicies();
  } catch {
    return;
  }
  const endpoint = policies.runtime.telemetry.otlpEndpoint?.trim();
  if (policies.runtime.telemetry.enabled !== true || !endpoint) return;

  const body = {
    resourceSpans: [
      {
        resource: {
          attributes: toAttributes({
            "service.name": "cowork-os",
            "cowork.telemetry.kind": "task_event",
          }),
        },
        scopeSpans: [
          {
            scope: { name: "cowork-os.task-events" },
            spans: [
              {
                traceId: stableHexId(event.taskId, 16),
                spanId: stableHexId(`${event.taskId}:${event.id}`, 8),
                name: `task_event.${event.type}`,
                kind: 1,
                startTimeUnixNano: toHrTime(event.timestamp),
                endTimeUnixNano: toHrTime(event.timestamp),
                attributes: toAttributes({
                  "cowork.event_kind": eventKind(String(event.type)),
                }),
              },
            ],
          },
        ],
      },
    ],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  void fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: controller.signal,
  })
    .catch(() => undefined)
    .finally(() => clearTimeout(timer));
}
