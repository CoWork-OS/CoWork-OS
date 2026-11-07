import type {
  Task,
  TaskVerificationEvidenceBundle,
  VerificationVerdict,
} from "../../../shared/types";
import { containsNoMemoryDirective } from "../no-memory-directive";
import { redactSecrets } from "../sensitive-content";

export const MEMORY_EXECUTION_MAX_CHECKS = 8;
export const MEMORY_EXECUTION_DETAIL_CHARS = 1_200;

export interface MemoryExecutionCheck {
  kind: "shell_command" | "file_exists" | "http_head";
  detail: string;
  capturedAt: number;
}

/** Runtime observations of particular checks, never proof of the entire plan or task. */
export interface MemoryExecutionReceipt {
  version: 1;
  checks: MemoryExecutionCheck[];
}

/** Build after final completion gates settle, from runtime checks rather than assistant text. */
export function buildMemoryExecutionReceipt(input: {
  status: Task["status"];
  terminalStatus: Task["terminalStatus"];
  verificationVerdict?: VerificationVerdict;
  evidenceBundle?: TaskVerificationEvidenceBundle;
}): MemoryExecutionReceipt | undefined {
  if (
    input.status !== "completed" ||
    input.terminalStatus !== "ok" ||
    (input.verificationVerdict !== undefined && input.verificationVerdict !== "PASS")
  )
    return undefined;
  const entries = input.evidenceBundle?.entries;
  if (
    !Array.isArray(entries) ||
    entries.length === 0 ||
    entries.some((entry) => entry?.ok !== true)
  ) {
    return undefined;
  }
  const checks: MemoryExecutionCheck[] = [];
  for (const entry of entries) {
    // `none` is an acknowledged lack of verification. grep_absent's current runtime
    // accepts nonzero error exits, so neither is admitted as successful-check evidence.
    if (
      entry.kind !== "shell_command" &&
      entry.kind !== "file_exists" &&
      entry.kind !== "http_head"
    )
      continue;
    if (
      typeof entry.detail !== "string" ||
      containsNoMemoryDirective(entry.detail) ||
      /<\/?private\b/i.test(entry.detail) ||
      !Number.isFinite(entry.capturedAt) ||
      entry.capturedAt <= 0
    )
      continue;
    const detail = redactSecrets(entry.detail).text.trim();
    // Omit overlong checks instead of cutting off their targets or qualifications.
    if (!detail || detail.length > MEMORY_EXECUTION_DETAIL_CHARS) continue;
    checks.push({ kind: entry.kind, detail, capturedAt: entry.capturedAt });
    if (checks.length >= MEMORY_EXECUTION_MAX_CHECKS) break;
  }
  return checks.length > 0 ? { version: 1, checks } : undefined;
}
