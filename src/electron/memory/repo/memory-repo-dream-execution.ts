import { createHash } from "node:crypto";
import type { Task, TaskEvent } from "../../../shared/types";
import { InputSanitizer } from "../../agent/security/input-sanitizer";
import { isThirdPartyGatewayTask } from "../../gateway/gateway-sender-identity";
import { screenMemoryText, type MemoryWorkspacePolicy } from "../MemoryWriter";
import { isSafeExcludedPattern, MAX_EXCLUDED_PATTERNS } from "../excluded-patterns";
import { containsNoMemoryDirective, taskDisablesMemoryCapture } from "../no-memory-directive";
import {
  MEMORY_EXECUTION_DETAIL_CHARS,
  MEMORY_EXECUTION_MAX_CHECKS,
  type MemoryExecutionCheck,
} from "./memory-repo-execution-receipt";

/** Immutable references to observations, never an assistant's claim of task success. */
export interface DreamExecutionEvidenceRef {
  taskId: string;
  workspaceId: string;
  eventId: string;
  contentHash: string;
}

export interface DreamExecutionEvidence extends DreamExecutionEvidenceRef {
  excerpt: string;
}

export type DreamExecutionWorkspacePolicy = MemoryWorkspacePolicy & {
  autoCapture?: boolean;
  excludedPatterns?: string[];
};
export const DREAM_EXECUTION_MAX_EVENTS = 80;
export const DREAM_EXECUTION_EXCERPT_CHARS = 12_000;
export const DREAM_EXECUTION_EVENT_TYPES = [
  "user_message",
  "assistant_message",
  "task_completed",
  "verification_failed",
  "verification_pending_user_action",
];

const PRIVATE_MARKER = /<\s*\/?\s*private\b/i;

function payloadOf(event: TaskEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)
    : {};
}

function eventType(event: TaskEvent): string {
  return String(event.legacyType || event.type || "");
}

function verificationAllows(payload: Record<string, unknown>): boolean {
  return (
    (payload.verificationVerdict === undefined || payload.verificationVerdict === "PASS") &&
    (payload.verificationOutcome === undefined || payload.verificationOutcome === "pass") &&
    !payload.failureClass &&
    [
      "pendingChecklist",
      "failedMutationRequiredStepIds",
      "failedStepIds",
      "incompleteStepIds",
    ].every(
      (key) =>
        payload[key] === undefined || (Array.isArray(payload[key]) && payload[key].length === 0),
    )
  );
}

/** The caller also applies the ordinary dream task filter before reading source events. */
export function extractDreamExecutionEvidence(
  task: Task,
  events: TaskEvent[],
  policy: DreamExecutionWorkspacePolicy | null | undefined,
): DreamExecutionEvidence | null {
  if (
    events.length >= DREAM_EXECUTION_MAX_EVENTS ||
    events.some((event) => event.taskId === task.id && !Number.isFinite(event.timestamp)) ||
    !Number.isFinite(task.createdAt) ||
    !task.workspaceId ||
    task.status !== "completed" ||
    task.terminalStatus !== "ok" ||
    task.failureClass ||
    (task.verificationVerdict !== undefined && task.verificationVerdict !== "PASS") ||
    taskDisablesMemoryCapture(task) ||
    task.parentTaskId ||
    (task.depth ?? 0) > 0 ||
    task.agentType === "sub" ||
    task.agentType === "parallel" ||
    task.agentConfig?.gatewayContext === "group" ||
    task.agentConfig?.gatewayContext === "public" ||
    isThirdPartyGatewayTask(task) ||
    !policy?.enabled ||
    policy.autoCapture !== true ||
    (policy.privacyMode !== undefined && policy.privacyMode !== "normal") ||
    (policy.excludedPatterns !== undefined &&
      (!Array.isArray(policy.excludedPatterns) ||
        policy.excludedPatterns.length > MAX_EXCLUDED_PATTERNS)) ||
    [task.prompt, task.rawPrompt, task.userPrompt].some(
      (prompt) => typeof prompt === "string" && PRIVATE_MARKER.test(prompt),
    )
  )
    return null;

  // Replay repositories return the newest bounded slice in durable sequence order.
  // Timestamps can move backwards; re-sorting them could hide a later owner correction.
  const ordered = events.filter((event) => event.taskId === task.id);
  let completionIndex = -1;
  for (let index = 0; index < ordered.length; index += 1) {
    if (eventType(ordered[index]) === "task_completed") completionIndex = index;
  }
  if (completionIndex < 0) return null;
  const completion = ordered[completionIndex];
  const payload = payloadOf(completion);
  if (!completion.id || payload.terminalStatus !== "ok" || !verificationAllows(payload))
    return null;

  let latestOwnerMessageAt = task.createdAt;
  for (const [index, event] of ordered.entries()) {
    const type = eventType(event);
    const eventPayload = payloadOf(event);
    if (type === "user_message" && eventPayload.messageSource !== "agent") {
      if (
        index > completionIndex ||
        containsNoMemoryDirective(eventPayload.message) ||
        (typeof eventPayload.message === "string" && PRIVATE_MARKER.test(eventPayload.message))
      )
        return null;
      latestOwnerMessageAt = Math.max(latestOwnerMessageAt, event.timestamp);
    }
    if (
      index > completionIndex &&
      (type === "verification_failed" || type === "verification_pending_user_action")
    )
      return null;
  }

  const raw = payload.memoryExecutionReceipt;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const receipt = raw as Record<string, unknown>;
  if (
    receipt.version !== 1 ||
    Object.keys(receipt).some((key) => key !== "version" && key !== "checks") ||
    !Array.isArray(receipt.checks) ||
    receipt.checks.length === 0 ||
    receipt.checks.length > MEMORY_EXECUTION_MAX_CHECKS
  )
    return null;
  const checks: MemoryExecutionCheck[] = [];
  const lines: string[] = [];
  let chars = 0;
  for (const candidate of receipt.checks) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const check = candidate as Record<string, unknown>;
    if (
      Object.keys(check).some(
        (key) => key !== "kind" && key !== "detail" && key !== "capturedAt",
      ) ||
      (check.kind !== "shell_command" &&
        check.kind !== "file_exists" &&
        check.kind !== "http_head") ||
      typeof check.detail !== "string" ||
      !check.detail.trim() ||
      check.detail.length > MEMORY_EXECUTION_DETAIL_CHARS ||
      containsNoMemoryDirective(check.detail) ||
      PRIVATE_MARKER.test(check.detail) ||
      typeof check.capturedAt !== "number" ||
      !Number.isFinite(check.capturedAt) ||
      check.capturedAt <= 0 ||
      check.capturedAt < latestOwnerMessageAt ||
      check.capturedAt > completion.timestamp
    )
      return null;
    const screened = screenMemoryText(check.detail, MEMORY_EXECUTION_DETAIL_CHARS);
    if (!screened.ok) return null;
    // Match archive capture semantics: apply safe exclusion patterns after secret redaction.
    if (
      policy.excludedPatterns?.some(
        (pattern) =>
          isSafeExcludedPattern(pattern) && new RegExp(pattern, "i").test(screened.content),
      )
    )
      return null;
    const detail = InputSanitizer.sanitizeInlineMemoryLine(screened.content);
    const line = `- ${check.kind}: ${detail}`;
    // A check is atomic: never cut a command, target or qualification in half.
    if (chars + line.length + 1 > DREAM_EXECUTION_EXCERPT_CHARS) return null;
    chars += line.length + 1;
    lines.push(line);
    checks.push({ kind: check.kind, detail: check.detail, capturedAt: check.capturedAt });
  }
  const excerpt = lines.join("\n");
  if (
    policy.excludedPatterns?.some(
      (pattern) => isSafeExcludedPattern(pattern) && new RegExp(pattern, "i").test(excerpt),
    )
  )
    return null;
  const contentHash = createHash("sha256")
    .update(
      JSON.stringify({
        taskId: task.id,
        workspaceId: task.workspaceId,
        taskVerificationVerdict: task.verificationVerdict ?? null,
        eventId: completion.id,
        eventTimestamp: completion.timestamp,
        verificationVerdict: payload.verificationVerdict ?? null,
        verificationOutcome: payload.verificationOutcome ?? null,
        latestOwnerMessageAt,
        receipt: { version: 1, checks },
      }),
    )
    .digest("hex");
  return {
    taskId: task.id,
    workspaceId: task.workspaceId,
    eventId: completion.id,
    contentHash,
    excerpt,
  };
}

export interface DreamExecutionValidationDeps {
  findTaskById?: (taskId: string) => Promise<Task | null | undefined>;
  findTaskEvents?: (taskId: string, types: string[], maxEvents: number) => Promise<TaskEvent[]>;
  getWorkspacePolicy?: (workspaceId: string) => Promise<DreamExecutionWorkspacePolicy | null>;
  isTaskEligible: (task: Task) => boolean;
}

/** Re-resolve the exact evidence after inference and again before accepting a review. */
export function createDreamExecutionEvidenceValidator(
  deps: DreamExecutionValidationDeps,
): (refs: DreamExecutionEvidenceRef[]) => Promise<boolean> {
  return async (refs) => {
    if (!Array.isArray(refs) || refs.length > 200) return false;
    if (refs.length === 0) return true;
    if (!deps.findTaskById || !deps.findTaskEvents || !deps.getWorkspacePolicy) return false;
    try {
      const seen = new Set<string>();
      for (const ref of refs) {
        if (
          !ref ||
          typeof ref.taskId !== "string" ||
          !ref.taskId ||
          typeof ref.workspaceId !== "string" ||
          !ref.workspaceId ||
          typeof ref.eventId !== "string" ||
          !ref.eventId ||
          typeof ref.contentHash !== "string" ||
          !/^[a-f0-9]{64}$/.test(ref.contentHash)
        )
          return false;
        const key = JSON.stringify(ref);
        if (seen.has(key)) continue;
        seen.add(key);
        const task = await deps.findTaskById(ref.taskId);
        if (
          !task ||
          task.id !== ref.taskId ||
          !deps.isTaskEligible(task) ||
          task.workspaceId !== ref.workspaceId
        )
          return false;
        const policy = await deps.getWorkspacePolicy(ref.workspaceId);
        const events = await deps.findTaskEvents(
          task.id,
          DREAM_EXECUTION_EVENT_TYPES,
          DREAM_EXECUTION_MAX_EVENTS,
        );
        const current = extractDreamExecutionEvidence(task, events, policy);
        if (!current || current.eventId !== ref.eventId || current.contentHash !== ref.contentHash)
          return false;
      }
      return true;
    } catch {
      return false;
    }
  };
}
