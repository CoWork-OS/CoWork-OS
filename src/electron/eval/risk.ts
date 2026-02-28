import type { ReviewPolicy, Task, TaskEvent, TaskOutputSummary, TaskRiskLevel } from "../../shared/types";
import { detectTestRequirement, isTestCommand } from "../agent/executor-prompt-heuristics-utils";

export interface TaskRiskSignals {
  shellOrGitMutation: boolean;
  changedFileCount: number;
  testsExpectedNoEvidence: boolean;
  repeatedToolFailures: boolean;
  maxToolFailureCount: number;
}

export interface TaskRiskComputation {
  score: number;
  level: TaskRiskLevel;
  reasons: string[];
  signals: TaskRiskSignals;
}

export interface ReviewGateDecision {
  policy: ReviewPolicy;
  tier: TaskRiskLevel;
  runQualityPass: boolean;
  strictCompletionContract: boolean;
  runVerificationAgent: boolean;
  explicitEvidenceRequired: boolean;
}

const SHELL_MUTATION_PATTERN =
  /\b(git\s+(add|commit|push|pull|checkout|switch|merge|rebase|reset|cherry-pick|apply)|npm\s+(install|i|update)|pnpm\s+(add|install|update)|yarn\s+(add|install|upgrade)|rm\s+-rf|mv\s+|cp\s+|sed\s+-i|perl\s+-i|echo\s+.+>\s*|tee\s+)\b/i;

const TEST_TOOL_HINTS = new Set(["vitest", "jest", "pytest", "go_test", "cargo_test", "mvn_test"]);

function toTaskPrompt(task: Pick<Task, "title" | "prompt">): string {
  return `${task.title || ""}\n${task.prompt || ""}`.trim();
}

function getEventToolName(event: TaskEvent): string {
  if (!event || event.type !== "tool_call") return "";
  const tool = (event.payload?.tool || event.payload?.name || "").toString().trim();
  return tool;
}

function getRunCommandFromEvent(event: TaskEvent): string {
  const input = event.payload?.input;
  if (!input || typeof input !== "object") return "";
  const command = (input.command || "").toString().trim();
  return command;
}

function collectChangedPaths(events: TaskEvent[], outputSummary?: TaskOutputSummary): Set<string> {
  const changed = new Set<string>();
  const add = (raw: unknown) => {
    if (typeof raw !== "string") return;
    const normalized = raw.trim().replace(/\\/g, "/");
    if (!normalized) return;
    changed.add(normalized);
  };

  for (const event of events) {
    if (
      event.type !== "file_created" &&
      event.type !== "file_modified" &&
      event.type !== "file_deleted" &&
      event.type !== "artifact_created"
    ) {
      continue;
    }
    add(event.payload?.path);
    add(event.payload?.from);
    add(event.payload?.to);
  }

  for (const filePath of outputSummary?.created || []) add(filePath);
  for (const filePath of outputSummary?.modifiedFallback || []) add(filePath);

  return changed;
}

function hasTestEvidence(events: TaskEvent[]): boolean {
  for (const event of events) {
    if (event.type !== "tool_call") continue;
    const tool = getEventToolName(event);
    if (tool === "run_command") {
      const command = getRunCommandFromEvent(event);
      if (command && isTestCommand(command)) return true;
      continue;
    }
    if (TEST_TOOL_HINTS.has(tool)) return true;
  }
  return false;
}

function countToolFailures(events: TaskEvent[]): { repeated: boolean; maxCount: number } {
  const failureCounts = new Map<string, number>();
  for (const event of events) {
    if (event.type !== "tool_error") continue;
    const tool = (event.payload?.tool || "unknown").toString().trim() || "unknown";
    failureCounts.set(tool, (failureCounts.get(tool) || 0) + 1);
  }
  const maxCount = Math.max(0, ...Array.from(failureCounts.values()));
  return { repeated: maxCount > 2, maxCount };
}

function hasShellOrGitMutation(events: TaskEvent[]): boolean {
  for (const event of events) {
    if (event.type !== "tool_call") continue;
    const tool = getEventToolName(event);
    if (!tool) continue;
    if (tool.startsWith("git_")) return true;
    if (tool !== "run_command") continue;
    const command = getRunCommandFromEvent(event);
    if (command && SHELL_MUTATION_PATTERN.test(command)) return true;
  }
  return false;
}

export function scoreTaskRisk(
  task: Pick<Task, "title" | "prompt">,
  events: TaskEvent[],
  outputSummary?: TaskOutputSummary,
): TaskRiskComputation {
  const reasons: string[] = [];
  let score = 0;

  const shellOrGitMutation = hasShellOrGitMutation(events);
  if (shellOrGitMutation) {
    score += 2;
    reasons.push("shell_or_git_mutation");
  }

  const changedPaths = collectChangedPaths(events, outputSummary);
  if (changedPaths.size > 5) {
    score += 2;
    reasons.push("more_than_five_files_changed");
  }

  const testsExpected = detectTestRequirement(toTaskPrompt(task));
  const testEvidence = hasTestEvidence(events);
  const testsExpectedNoEvidence = testsExpected && !testEvidence;
  if (testsExpectedNoEvidence) {
    score += 2;
    reasons.push("tests_expected_without_evidence");
  }

  const toolFailures = countToolFailures(events);
  if (toolFailures.repeated) {
    score += 1;
    reasons.push("repeated_tool_failures");
  }

  const level: TaskRiskLevel = score >= 6 ? "high" : score >= 3 ? "medium" : "low";

  return {
    score,
    level,
    reasons,
    signals: {
      shellOrGitMutation,
      changedFileCount: changedPaths.size,
      testsExpectedNoEvidence,
      repeatedToolFailures: toolFailures.repeated,
      maxToolFailureCount: toolFailures.maxCount,
    },
  };
}

export function resolveReviewPolicy(requestedPolicy: unknown): ReviewPolicy {
  if (requestedPolicy === "off" || requestedPolicy === "balanced" || requestedPolicy === "strict") {
    return requestedPolicy;
  }

  const envDefault = (process.env.COWORK_REVIEW_POLICY_DEFAULT || "").trim().toLowerCase();
  if (envDefault === "off" || envDefault === "balanced" || envDefault === "strict") {
    return envDefault;
  }

  return "off";
}

export function deriveReviewGateDecision(params: {
  policy: ReviewPolicy;
  riskLevel: TaskRiskLevel;
  isMutatingTask: boolean;
}): ReviewGateDecision {
  const { policy, riskLevel, isMutatingTask } = params;
  if (policy === "off") {
    return {
      policy,
      tier: riskLevel,
      runQualityPass: false,
      strictCompletionContract: false,
      runVerificationAgent: false,
      explicitEvidenceRequired: false,
    };
  }

  if (policy === "strict") {
    return {
      policy,
      tier: riskLevel,
      runQualityPass: true,
      strictCompletionContract: true,
      runVerificationAgent: riskLevel !== "low",
      explicitEvidenceRequired: riskLevel !== "low",
    };
  }

  // balanced
  return {
    policy,
    tier: riskLevel,
    runQualityPass: isMutatingTask,
    strictCompletionContract: riskLevel !== "low",
    runVerificationAgent: riskLevel === "high",
    explicitEvidenceRequired: riskLevel === "high",
  };
}

export function inferMutationFromSummary(summary?: TaskOutputSummary): boolean {
  if (!summary) return false;
  return (summary.created?.length || 0) > 0 || (summary.modifiedFallback?.length || 0) > 0;
}
