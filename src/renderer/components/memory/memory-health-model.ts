/**
 * Memory Hub "Sources" and "Health": labels, explanations and formatting for the two
 * tabs. Kept free of React so it can be tested on its own.
 */
import type {
  MemoryHealthCheck,
  MemoryHealthReport,
  MemorySourcesReport,
} from "../../../shared/memory-health-types";
import type { MemoryHubSource } from "../../../shared/memory-hub-types";

export type MemoryHealthApi = {
  getMemorySources: (data: { workspaceId: string }) => Promise<MemorySourcesReport>;
  getMemoryHealth: (data: { workspaceId: string }) => Promise<MemoryHealthReport>;
};

export const MEMORY_SOURCES_METHODS = ["getMemorySources"] as const;
export const MEMORY_HEALTH_METHODS = ["getMemoryHealth"] as const;

/** What each `memory_items.source` means, in plain language. */
export const SOURCE_EXPLANATIONS: Record<MemoryHubSource, string> = {
  user_stated: "Facts you told CoWork directly: in a task, in the Memory Hub or in a kit file.",
  user_confirmed: "Facts CoWork proposed and you accepted.",
  curated: "Facts the agent curated into the workspace memory files.",
  inferred: "Facts CoWork inferred from your work. Dreaming may merge or archive them.",
  import: "Facts about you from a ChatGPT export or a pasted memory export.",
  third_party: "Text from messages other people sent you, kept per contact.",
  system: "Recorded by CoWork itself rather than learned from you.",
};

/** The producers behind `source_ref.store`. Unknown stores are shown by name. */
export const STORE_LABELS: Record<string, { label: string; explanation: string }> = {
  memory_hub: { label: "Memory Hub", explanation: "Added or edited by you in this Hub." },
  kit_file: {
    label: "Kit files",
    explanation: "Written back from your edits to .cowork/USER.md or MEMORY.md.",
  },
  agent_tool: {
    label: "Agent memory tool",
    explanation: "Saved by the agent during a task (memory_remember).",
  },
  core_candidate: {
    label: "Task traces",
    explanation: "Distilled from what happened in tasks (core memory candidates).",
  },
  dreaming: {
    label: "Dreaming",
    explanation: "Learned by Dreaming from outcomes that recur across tasks.",
  },
  import: { label: "Imports", explanation: "From a ChatGPT export or a pasted memory export." },
  mailbox: { label: "Mailbox", explanation: "Taken from messages other people sent you." },
  awareness: { label: "Awareness", explanation: "Inferred by ambient awareness." },
  adaptive_style: {
    label: "Adaptive style",
    explanation: "Adapted from how you respond to answers.",
  },
  personality: { label: "Personality", explanation: "Your name from the personality settings." },
  user_profile: {
    label: "Profile (migrated)",
    explanation: "Profile facts moved over from the former profile store.",
  },
  relationship: {
    label: "Relationship (migrated)",
    explanation: "Moved over from the former relationship memory.",
  },
  curated: {
    label: "Curated (migrated)",
    explanation: "Moved over from the former curated memory entries.",
  },
  "(none)": { label: "Unknown", explanation: "No producer was recorded." },
};

export function storeLabel(store: string): { label: string; explanation: string } {
  return STORE_LABELS[store] ?? { label: store, explanation: "" };
}

/** What a capture origin of the archive means. */
export const ORIGIN_LABELS: Record<string, string> = {
  task: "Task outcomes",
  heartbeat: "Heartbeat",
  tool: "Agent notes",
  chronicle: "Screen context (Chronicle)",
  playbook: "Playbook",
  proactive: "Suggestions",
  import: "Imports",
  system: "System",
  unknown: "Not classified",
};

export const HEALTH_STATUS_LABELS: Record<MemoryHealthCheck["status"], string> = {
  pass: "PASS",
  warn: "WARN",
  skip: "SKIP",
  info: "INFO",
};

export function healthStatusTone(
  status: MemoryHealthCheck["status"],
): "success" | "warning" | "neutral" {
  if (status === "pass") return "success";
  if (status === "warn") return "warning";
  return "neutral";
}

function formatNumber(value: number, unit: MemoryHealthCheck["unit"]): string {
  switch (unit) {
    case "ratio":
      return `${(value * 100).toFixed(1)}%`;
    case "mib":
      return `${value.toLocaleString()} MiB`;
    case "tokens":
      return `${value.toLocaleString()} tokens`;
    case "bytes":
      return value >= 1024 ? `${(value / 1024).toFixed(1)} KB` : `${value.toLocaleString()} B`;
    default:
      return value.toLocaleString();
  }
}

/** The value column of a check ("-" when unavailable). */
export function formatHealthValue(check: MemoryHealthCheck): string {
  if (check.value === null) return "-";
  return formatNumber(check.value, check.unit);
}

/** The threshold column, e.g. "at most 5.0%"; empty for informational rows. */
export function formatHealthThreshold(check: MemoryHealthCheck): string {
  if (check.threshold === undefined || !check.op) return "";
  const unit = check.unit === "tokens" ? "count" : check.unit;
  return `${check.op === "<=" ? "at most" : "at least"} ${formatNumber(check.threshold, unit)}`;
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
