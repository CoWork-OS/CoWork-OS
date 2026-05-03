import type { AgentConfig, PersistentTaskGoalConfig } from "./types";

export type GoalSlashCommandAction = "start" | "status" | "pause" | "resume" | "clear";

export interface ParsedGoalSlashCommand {
  matched: boolean;
  action?: GoalSlashCommandAction;
  objective?: string;
  raw?: string;
  maxAutoContinuations?: number;
  lifetimeMaxTurns?: number;
}

const GOAL_ACTIONS = new Set(["pause", "resume", "clear", "status"]);

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function readNumberFlag(tokens: string[], index: number): { value?: number; nextIndex: number } {
  const token = tokens[index] || "";
  const equalsIndex = token.indexOf("=");
  if (equalsIndex >= 0) {
    const value = Number(token.slice(equalsIndex + 1));
    return { value: Number.isFinite(value) ? value : undefined, nextIndex: index + 1 };
  }

  const value = Number(tokens[index + 1]);
  return { value: Number.isFinite(value) ? value : undefined, nextIndex: index + 2 };
}

export function parseLeadingGoalSlashCommand(input: string): ParsedGoalSlashCommand {
  const raw = String(input || "").trim();
  const match = raw.match(/^\/goal(?=\s|$)([\s\S]*)$/i);
  if (!match) return { matched: false };

  const args = String(match[1] || "").trim();
  if (!args) {
    return { matched: true, action: "status", raw };
  }

  const tokens = args.split(/\s+/);
  const first = String(tokens[0] || "").toLowerCase();
  if (GOAL_ACTIONS.has(first)) {
    return { matched: true, action: first as GoalSlashCommandAction, raw };
  }

  const objectiveTokens: string[] = [];
  let maxAutoContinuations: number | undefined;
  let lifetimeMaxTurns: number | undefined;
  for (let i = 0; i < tokens.length; ) {
    const token = tokens[i] || "";
    const lower = token.toLowerCase();
    if (lower === "--max-continuations" || lower.startsWith("--max-continuations=")) {
      const parsed = readNumberFlag(tokens, i);
      if (typeof parsed.value === "number") {
        maxAutoContinuations = clampInteger(parsed.value, 0, 20);
      }
      i = parsed.nextIndex;
      continue;
    }
    if (lower === "--max-turns" || lower.startsWith("--max-turns=")) {
      const parsed = readNumberFlag(tokens, i);
      if (typeof parsed.value === "number") {
        lifetimeMaxTurns = clampInteger(parsed.value, 1, 5000);
      }
      i = parsed.nextIndex;
      continue;
    }
    objectiveTokens.push(token);
    i += 1;
  }

  const objective = objectiveTokens.join(" ").trim();
  return {
    matched: true,
    action: objective ? "start" : "status",
    objective,
    raw,
    maxAutoContinuations,
    lifetimeMaxTurns,
  };
}

export function buildPersistentGoalPrompt(objective: string, context?: string): string {
  const trimmedObjective = String(objective || "").trim();
  const trimmedContext = String(context || "").trim();
  const contextBlock =
    trimmedContext && trimmedContext !== `/goal ${trimmedObjective}`.trim()
      ? `\n\nInitial context:\n${trimmedContext}`
      : "";

  return [
    "Persistent goal mode is active.",
    "",
    `Goal: ${trimmedObjective}`,
    contextBlock,
    "",
    "Work toward this goal until it is verified complete, explicitly blocked, or paused by the user.",
    "Use the goal as the source of truth across continuations. Keep progress visible, continue after turn-window exhaustion when there is still useful progress to make, and avoid stopping after partial progress.",
    "Before finishing, verify the concrete outcome against the goal. Start the final response with `GOAL COMPLETE:` when the goal is done, or `GOAL BLOCKED:` when external input or access is required.",
  ].join("\n");
}

export function buildPersistentGoalAgentConfig(
  parsed: ParsedGoalSlashCommand,
  now: number,
  base?: AgentConfig,
): AgentConfig {
  const objective = String(parsed.objective || "").trim();
  const goalMode: PersistentTaskGoalConfig = {
    objective,
    status: "active",
    createdAt: now,
    updatedAt: now,
    maxAutoContinuations: parsed.maxAutoContinuations,
    lifetimeMaxTurns: parsed.lifetimeMaxTurns,
  };

  return {
    ...(base || {}),
    goalMode,
    executionMode: "execute",
    deepWorkMode: true,
    autoReportEnabled: true,
    progressJournalEnabled: true,
    autoContinueOnTurnLimit: true,
    maxAutoContinuations: parsed.maxAutoContinuations ?? base?.maxAutoContinuations ?? 12,
    lifetimeMaxTurns: parsed.lifetimeMaxTurns ?? base?.lifetimeMaxTurns ?? 1200,
    minProgressScoreForAutoContinue: base?.minProgressScoreForAutoContinue ?? -0.05,
    continuationStrategy: "adaptive_progress",
    compactOnContinuation: true,
    globalNoProgressCircuitBreaker: base?.globalNoProgressCircuitBreaker ?? 4,
    loopWarningThreshold: base?.loopWarningThreshold ?? 3,
    loopCriticalThreshold: base?.loopCriticalThreshold ?? 5,
  };
}
