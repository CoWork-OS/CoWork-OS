/**
 * Heuristic step-intent alignment: token overlap between each plan step and the user task text.
 * Cheap, deterministic; used to surface likely plan drift before execution continues.
 */

import type { Plan } from "../../shared/types";

const STOP = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "as",
  "at",
  "by",
  "from",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
]);

function tokenize(text: string): string[] {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9_/.-]+/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** Jaccard-like overlap in [0,1] */
export function scoreStepIntentOverlap(stepDescription: string, taskText: string): number {
  const a = new Set(tokenize(stepDescription));
  const b = new Set(tokenize(taskText));
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) inter += 1;
  }
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

export interface StepIntentScoreRow {
  stepId: string;
  score: number;
  descriptionPreview: string;
}

export function scorePlanStepIntentAlignment(plan: Plan, taskText: string): {
  rows: StepIntentScoreRow[];
  lowAlignmentStepIds: string[];
  minScore: number;
} {
  const rows: StepIntentScoreRow[] = [];
  const lowAlignmentStepIds: string[] = [];
  let minScore = 1;
  for (const step of plan.steps) {
    if (step.kind === "verification") continue;
    const score = scoreStepIntentOverlap(step.description, taskText);
    rows.push({
      stepId: step.id,
      score,
      descriptionPreview: step.description.slice(0, 120),
    });
    minScore = Math.min(minScore, score);
    if (score < 0.08) {
      lowAlignmentStepIds.push(step.id);
    }
  }
  return { rows, lowAlignmentStepIds, minScore };
}
