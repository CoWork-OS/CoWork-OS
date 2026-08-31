/**
 * CLI Agent Detection Utility
 *
 * Detects whether a child task is a CLI agent task (Codex CLI / Claude Code)
 * based on multi-signal analysis: task title, event content, and bash command patterns.
 * Used by the renderer to decide whether to render a CliAgentFrame instead of DispatchedAgentsPanel.
 */

import type { Task, TaskEvent } from "./types";

export type CliAgentType = "codex-cli" | "codex-acpx" | "claude-cli" | "claude-acpx";

// Title patterns (case-insensitive)
const CODEX_TITLE_PATTERNS = [
  /\bcodex\b/i,
  /\bcodex\s+cli\b/i,
  /\bcodex\s+(review|fix|exec|critiqu)/i,
  /\bcodex\s+(agent|task)\b/i,
];
const CLAUDE_TITLE_PATTERNS = [
  /\bclaude\b/i,
  /\bclaude\s+code\b/i,
  /\bclaude\s+(review|fix|exec|critiqu)/i,
  /\bclaude\s+(agent|task)\b/i,
];

// Bash command patterns found in task events
const CODEX_COMMAND_PATTERN = /\bcodex\s+(exec|review|--)/;
const CLAUDE_COMMAND_PATTERN = /(?:^|[\s;&|])claude(?:\s|$)/;

/**
 * Detect CLI agent type from a task's title.
 * Returns null if the title doesn't match any known CLI agent pattern.
 */
export function detectCliAgentFromTitle(title: string): CliAgentType | null {
  if (!title) return null;
  if (CODEX_TITLE_PATTERNS.some((p) => p.test(title))) return "codex-cli";
  if (CLAUDE_TITLE_PATTERNS.some((p) => p.test(title))) return "claude-cli";
  return null;
}

export function detectCliAgentFromTask(task: Task): CliAgentType | null {
  const externalRuntime = task.agentConfig?.externalRuntime;
  if (externalRuntime?.kind === "acpx") {
    return externalRuntime.agent === "claude" ? "claude-acpx" : "codex-acpx";
  }
  return detectCliAgentFromTitle(task.title);
}

/**
 * Detect CLI agent type from a task's events by scanning for CLI command patterns.
 * Looks at step_started and tool_call events with bash/run_command commands.
 */
export function detectCliAgentFromEvents(events: TaskEvent[]): CliAgentType | null {
  for (const event of events) {
    const payload = event.payload as Record<string, unknown> | undefined;
    const runtime = String(payload?.runtime || "");
    const runtimeAgent = String(payload?.runtimeAgent || "");
    if (runtime === "acpx" && runtimeAgent === "codex") return "codex-acpx";
    if (runtime === "acpx" && runtimeAgent === "claude") return "claude-acpx";

    const eventType = event.type;
    // Check step_started events
    if (
      eventType === "step_started" ||
      eventType === "timeline_step_started" ||
      eventType === "timeline_group_started"
    ) {
      const step = payload?.step as Record<string, unknown> | undefined;
      const command = String(step?.command || step?.tool || "");
      if (CODEX_COMMAND_PATTERN.test(command)) return "codex-cli";
      if (CLAUDE_COMMAND_PATTERN.test(command)) return "claude-cli";
    }
    // Check tool_call events (run_command with codex)
    if (eventType === "tool_call") {
      const tool = String(payload?.tool || payload?.toolName || "");
      if (tool === "run_command" || tool === "bash") {
        const cmd = String(
          payload?.command || (payload?.input as Record<string, unknown>)?.command || "",
        );
        if (CODEX_COMMAND_PATTERN.test(cmd)) return "codex-cli";
        if (CLAUDE_COMMAND_PATTERN.test(cmd)) return "claude-cli";
      }
    }
    // Check command_output events (start type)
    if (eventType === "command_output" || eventType === "timeline_command_output") {
      const payload = event.payload as Record<string, unknown> | undefined;
      const cmd = String(payload?.command || "");
      if (CODEX_COMMAND_PATTERN.test(cmd)) return "codex-cli";
      if (CLAUDE_COMMAND_PATTERN.test(cmd)) return "claude-cli";
    }
  }
  return null;
}

/**
 * Determine if a child task is a CLI agent task using multi-signal detection.
 * Checks title first (fast), then falls back to event scanning if needed.
 */
export function isCliAgentChildTask(task: Task, events?: TaskEvent[]): boolean {
  // Signal 1: Title match
  if (detectCliAgentFromTask(task)) return true;

  // Signal 2: Event content match (if events provided)
  if (events && events.length > 0 && detectCliAgentFromEvents(events)) return true;

  return false;
}

/**
 * Resolve the CLI agent type for a task.
 * Uses title first, then events as fallback.
 */
export function resolveCliAgentType(task: Task, events?: TaskEvent[]): CliAgentType | null {
  return detectCliAgentFromTask(task) ?? (events ? detectCliAgentFromEvents(events) : null);
}

/**
 * Get display metadata for a CLI agent type.
 */
export function getCliAgentDisplayInfo(agentType: CliAgentType): {
  icon: string;
  name: string;
  badge: string;
  color: string;
} {
  switch (agentType) {
    case "codex-cli":
      return { icon: "⚡", name: "Codex", badge: "Codex CLI", color: "#10b981" };
    case "codex-acpx":
      return { icon: "⚡", name: "Codex", badge: "Codex via ACP", color: "#0ea5e9" };
    case "claude-cli":
      return { icon: "🧠", name: "Claude", badge: "Claude CLI", color: "#f59e0b" };
    case "claude-acpx":
      return { icon: "🧠", name: "Claude", badge: "Claude via ACP", color: "#8b5cf6" };
  }
}
