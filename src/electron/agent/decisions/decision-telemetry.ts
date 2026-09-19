import { createHash } from "node:crypto";
import type { JevUsage } from "./types";

export type DecisionTelemetryStatus =
  | "success"
  | "unavailable"
  | "cancelled"
  | "budget_exhausted"
  | "circuit_open";

export interface DecisionTelemetryEvent {
  purpose: string;
  status: DecisionTelemetryStatus;
  latencyMs: number;
  stateDigest: string;
  stateBytes: number;
  questionCount: number;
  model?: string;
  requestId?: string;
  usage?: JevUsage;
  fromCache?: boolean;
  reason?: string;
  at: number;
}

export interface DecisionTelemetrySnapshot {
  total: number;
  byStatus: Record<DecisionTelemetryStatus, number>;
  byPurpose: Record<string, number>;
  totalLatencyMs: number;
  last?: DecisionTelemetryEvent;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Return a short stable digest without retaining the supplied decision state. */
export function digestDecisionState(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export class DecisionTelemetry {
  private readonly events: DecisionTelemetryEvent[] = [];

  constructor(private readonly maxEvents = 500) {}

  record(event: DecisionTelemetryEvent): void {
    this.events.push({
      ...event,
      purpose: String(event.purpose || "unknown").slice(0, 80),
      stateDigest: String(event.stateDigest || "").slice(0, 128),
      model: event.model ? String(event.model).slice(0, 200) : undefined,
      requestId: event.requestId ? String(event.requestId).slice(0, 200) : undefined,
      stateBytes: Math.max(0, Math.min(1_000_000, Math.round(event.stateBytes || 0))),
      questionCount: Math.max(0, Math.min(100, Math.round(event.questionCount || 0))),
      latencyMs: Math.max(0, Math.round(event.latencyMs || 0)),
      at: Number.isFinite(event.at) ? event.at : Date.now(),
    });
    while (this.events.length > this.maxEvents) this.events.shift();
  }

  snapshot(): DecisionTelemetrySnapshot {
    const byStatus: Record<DecisionTelemetryStatus, number> = {
      success: 0,
      unavailable: 0,
      cancelled: 0,
      budget_exhausted: 0,
      circuit_open: 0,
    };
    const byPurpose: Record<string, number> = {};
    let totalLatencyMs = 0;
    for (const event of this.events) {
      byStatus[event.status] += 1;
      byPurpose[event.purpose] = (byPurpose[event.purpose] || 0) + 1;
      totalLatencyMs += event.latencyMs;
    }
    const last = this.events[this.events.length - 1];
    return {
      total: this.events.length,
      byStatus,
      byPurpose,
      totalLatencyMs,
      ...(last ? { last: { ...last, usage: last.usage ? { ...last.usage } : undefined } } : {}),
    };
  }

  clear(): void {
    this.events.length = 0;
  }
}
