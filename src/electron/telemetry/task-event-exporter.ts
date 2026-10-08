import type { TaskEvent } from "../../shared/types";
import { loadPolicies } from "../admin/policies";
import { toLogSafeNetworkPolicyUrl } from "../security/network-policy";
import {
  fetchWithPolicyCheckedRedirects,
  PolicyCheckedFetchError,
  type NetworkPolicyContext,
} from "../security/policy-checked-fetch";
import { createLogger } from "../utils/logger";
import { createHash } from "crypto";

const log = createLogger("TaskEventExporter");

const TELEMETRY_TOOL_NAME = "telemetry_export";
const EXPORT_TIMEOUT_MS = 2500;

// The endpoint comes from admin policy, not from a task, so no workspace permission or access
// profile applies. An empty context still enforces admin `runtime.network.*` rules, the legacy
// domain guardrail and the internal-address boundary (literal hosts in the policy check, DNS
// answers in the pinned connection). Loopback stays reachable for a local collector.
const TELEMETRY_NETWORK_CONTEXT: NetworkPolicyContext = {};

// Messages pinnedFetch and assertResolvedHostAllowed throw when a DNS answer is internal.
const INTERNAL_DESTINATION_REFUSED =
  /Refusing to connect|Internal destination refused|resolves to an internal/i;

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

  void sendTelemetry(endpoint, JSON.stringify(body));
}

let loggedRefusalKey: string | undefined;

function refusalReason(error: unknown): string | undefined {
  if (error instanceof PolicyCheckedFetchError) return error.decision?.reason ?? error.code;
  if (error instanceof Error && INTERNAL_DESTINATION_REFUSED.test(error.message)) {
    return "internal_address_refused";
  }
  return undefined;
}

function logRefusalOnce(endpoint: string, reason: string): void {
  const key = `${endpoint}\n${reason}`;
  if (loggedRefusalKey === key) return;
  loggedRefusalKey = key;
  let safeEndpoint = "<invalid url>";
  try {
    safeEndpoint = toLogSafeNetworkPolicyUrl(new URL(endpoint));
  } catch {
    // Keep the placeholder; the reason already says why it was refused.
  }
  log.warn(
    `Task event telemetry to ${safeEndpoint} refused by network policy (${reason}); events are dropped until the policy or endpoint changes`,
  );
}

async function sendTelemetry(endpoint: string, body: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXPORT_TIMEOUT_MS);
  try {
    // No onDecision: recording a network_policy_decision task event here would re-enter this
    // exporter, since that event type is itself exported.
    const { response } = await fetchWithPolicyCheckedRedirects(
      endpoint,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: controller.signal,
      },
      {
        toolName: TELEMETRY_TOOL_NAME,
        networkContext: TELEMETRY_NETWORK_CONTEXT,
        followRedirects: false,
      },
    );
    loggedRefusalKey = undefined;
    await response.body?.cancel();
  } catch (error) {
    const reason = refusalReason(error);
    if (reason) logRefusalOnce(endpoint, reason);
  } finally {
    clearTimeout(timer);
  }
}
