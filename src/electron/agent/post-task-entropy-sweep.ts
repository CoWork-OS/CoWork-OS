/**
 * Post-task entropy sweep — prompt construction for read-only repository hygiene audits.
 * Used by AgentDaemon after task completion when deriveEntropySweepDecision allows it.
 */

import type { Task, TaskEvent, TaskOutputSummary } from "../../shared/types";
import { listChangedPathsForTask } from "../eval/risk";

/**
 * Build blast-radius path list from file mutation events and output summary.
 */
export function collectBlastRadiusPaths(
  events: TaskEvent[],
  outputSummary?: TaskOutputSummary,
  maxPaths = 60,
): string[] {
  return listChangedPathsForTask(events, outputSummary, maxPaths);
}

export function buildEntropySweepPrompt(params: {
  task: Task;
  blastRadiusPaths: string[];
  resultSummary?: string;
}): string {
  const { task, blastRadiusPaths, resultSummary } = params;
  const promptText = task.rawPrompt || task.userPrompt || task.prompt || "";
  const pathBlock =
    blastRadiusPaths.length > 0
      ? blastRadiusPaths.map((p) => `- ${p}`).join("\n")
      : "(no specific paths recorded — use search_files to infer related files from the task)";

  return [
    "You are an independent post-task entropy sweep agent.",
    "Your job is read-only hygiene: find stale documentation, contradictory comments vs behavior,",
    "obvious dead code or unused exports in the blast radius, and README/docs that still describe old behavior.",
    "Do NOT modify any files. Use read_file, search_files, list_directory only.",
    "",
    "## Original task",
    `Title: ${task.title}`,
    `Prompt: ${promptText}`,
    "",
    "## Result summary (may be incomplete)",
    resultSummary?.trim() || "(none)",
    "",
    "## Blast radius (prioritize these paths)",
    pathBlock,
    "",
    "## Instructions",
    "1. Focus on the blast radius first; only expand if you find contradictions that require cross-file checks.",
    "2. Report concrete file:line references and a short fix suggestion.",
    "3. If nothing is wrong, say clearly NO_ISSUES_FOUND.",
    "4. Start your response with exactly `ENTROPY: CLEAN` or `ENTROPY: ISSUES`.",
    "5. Then bullet findings. Be concise.",
  ].join("\n");
}
