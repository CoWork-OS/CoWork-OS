/**
 * Plan steps the executor writes itself, rather than the planner. Their descriptions
 * are instructions to the model, so the UI shows a short label for each instead.
 */

/** The user-facing summary step appended after a plan's final verification. */
export const GENERATED_HANDOFF_STEP_DESCRIPTION =
  "Summarize completed work for the user. Link every requested deliverable that actually exists. Use the completed checks and actual artifact metadata to report the final outcome, page or sheet counts, and remaining limitations. Replace stale intermediate statements about pending checks. Do not modify files or repeat completed work.";

// Starts with "Repair", which marks the step as remediation rather than a
// verification checkpoint, and names no file so the step contract does not
// demand a particular write tool: the deliverable may be a file or the answer.
export const VERIFICATION_REPAIR_STEP_DESCRIPTION =
  "Repair the delivered work so it resolves the blocking issues found by the final check.";

export const VERIFICATION_RECHECK_STEP_DESCRIPTION =
  "Verify the repaired deliverable against the task requirements and the issues the final check reported.";

/** Final check added to matching-output and multi-file plans that have none. */
export const MATCHING_OUTPUTS_VERIFICATION_STEP_DESCRIPTION =
  "Verify that every requested file exists, that files meant to match carry the same content (facts, figures, names, dates and sections), and that the final answer links each requested file.";

/** Final check added to sourced research plans that have none. */
export const SOURCED_ANSWER_VERIFICATION_STEP_DESCRIPTION =
  "Verify the final answer covers every requested item and that each sourced fact in it carries a direct link to an official source fetched in this task.";

/** First step added when the user asked for work split across sub-agents. */
export const AGENT_DISPATCH_STEP_DESCRIPTION =
  "Use orchestrate_agents to dispatch the explicitly requested independent scopes to actual child agents and collect their results. Assign public official-source research to web_researcher. Do not replace agents with serial passes; preserve the original task scope and memory exclusions.";

// Matched by opening sentence, so a step keeps its label if the instructions after it change.
const GENERATED_STEP_LABELS: ReadonlyArray<readonly [prefix: string, label: string]> = [
  ["Summarize completed work for the user.", "Summarize the results"],
  ["Repair the delivered work so it resolves", "Fix the issues the final check found"],
  ["Verify the repaired deliverable against", "Re-check the fixes"],
  ["Verify that every requested file exists", "Check the files are complete and consistent"],
  ["Verify the final answer covers every requested item", "Check every fact links to its source"],
  ["Use orchestrate_agents to dispatch", "Hand the separate parts to sub-agents"],
];

/** The short label for an executor-written step, or undefined for a planner step. */
export function generatedPlanStepLabel(description: string): string | undefined {
  const text = description.trim();
  return GENERATED_STEP_LABELS.find(([prefix]) => text.startsWith(prefix))?.[1];
}
