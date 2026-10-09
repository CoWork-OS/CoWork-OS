/**
 * Memory Hub "Sources" and "Health" contract (audit §8.4): aggregate counts of where
 * memory comes from and the health checks of `npm run qa:memory-health`. Counts only;
 * never memory content. Renderer-facing.
 */
import type { MemoryHubSource } from "./memory-hub-types";
import thresholds from "./memory-health-thresholds.json";

/** When a Health check shows WARN. Shared with scripts/qa/memory-health.mjs. */
export const MEMORY_HEALTH_THRESHOLDS: Readonly<typeof thresholds.hub> = thresholds.hub;
/** Age after which a `running` heartbeat run counts as stuck. */
export const MEMORY_HEALTH_STUCK_AFTER_MS: number = thresholds.stuckAfterMs;
/** `maintenance_state` markers of the one-time memory migrations. */
export const MEMORY_HEALTH_MAINTENANCE_KEYS: readonly string[] = thresholds.maintenanceKeys;

/** Active facts by one key, split by where they apply in the Hub's view. */
export interface MemorySourceCount {
  key: string;
  /** Items of the selected workspace (workspace, contact and task scope). */
  workspace: number;
  /** Global items (every workspace sees them). */
  global: number;
  /** Contact items not tied to a workspace. */
  contacts: number;
}

export interface MemorySourcesReport {
  generatedAt: number;
  workspaceId: string;
  facts: {
    total: number;
    /** By `memory_items.source` (user_stated, inferred, import, ...). */
    bySource: Array<MemorySourceCount & { key: MemoryHubSource }>;
    /** By `source_ref.store`, the producer that wrote the fact; `(none)` when unset. */
    byStore: MemorySourceCount[];
  };
  /** The workspace's archive (`memories`): task outcomes, notes, imports, screen context. */
  archive: {
    total: number;
    private: number;
    byType: Array<{ key: string; count: number }>;
    /** By the observation sidecar's capture origin (`unknown` without a sidecar). */
    byOrigin: Array<{ key: string; count: number }>;
  };
  imports: { archiveRows: number; facts: number };
  chronicle: { enabled: boolean; archiveRows: number };
  knowledgeGraph: {
    entities: number;
    edges: number;
    observations: number;
    byType: Array<{ key: string; count: number }>;
  };
}

export type MemoryHealthStatus = "pass" | "warn" | "skip" | "info";

export interface MemoryHealthCheck {
  id: string;
  label: string;
  status: MemoryHealthStatus;
  /** Null when the metric is unavailable (missing table) or informational only. */
  value: number | null;
  /** `<=` or `>=`, with the threshold the value is compared to; absent for info rows. */
  op?: "<=" | ">=";
  threshold?: number;
  /** Plain-language detail: what was counted, or why the check was skipped. */
  detail: string;
  /** `ratio` values are shown as percentages, `mib` and `bytes` as sizes. */
  unit?: "ratio" | "count" | "mib" | "tokens" | "bytes";
}

export interface MemoryHealthReport {
  generatedAt: number;
  checks: MemoryHealthCheck[];
  /** Whether every threshold check passes (skips and info rows do not count). */
  ok: boolean;
}
