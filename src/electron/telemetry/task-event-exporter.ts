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

const SENSITIVE_KEY_RE =
  /(token|api[_-]?key|secret|password|authorization|cookie|private[_-]?key)/i;
const SENSITIVE_VALUE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi, replacement: "Bearer [REDACTED]" },
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replacement: "[REDACTED_OPENAI_KEY]" },
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, replacement: "[REDACTED_ANTHROPIC_KEY]" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g, replacement: "[REDACTED_GITHUB_TOKEN]" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[REDACTED_AWS_ACCESS_KEY]" },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: "[REDACTED_JWT]",
  },
  {
    pattern:
      /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)? PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
];

function redactString(value: string): string {
  let out = value;
  for (const { pattern, replacement } of SENSITIVE_VALUE_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out.length > 512 ? `${out.slice(0, 512)}[TRUNCATED]` : out;
}

function redactPayload(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object") return value;
  if (seen.has(value as object)) return "[CIRCULAR]";
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => redactPayload(item, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY_RE.test(key) ? "[REDACTED]" : redactPayload(child, depth + 1, seen);
  }
  return out;
}

function stableHexId(input: string, bytes: number): string {
  return createHash("sha256")
    .update(input)
    .digest("hex")
    .slice(0, bytes * 2);
}

function payloadKeys(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  return Object.keys(payload as Record<string, unknown>)
    .map((key) => (SENSITIVE_KEY_RE.test(key) ? "[REDACTED_KEY]" : redactString(key)))
    .slice(0, 32)
    .join(",");
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

  const payload = redactPayload(event.payload);
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
                  "cowork.task_id": event.taskId,
                  "cowork.event_id": event.id,
                  "cowork.event_type": String(event.type),
                  "cowork.payload_keys": payloadKeys(payload),
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
