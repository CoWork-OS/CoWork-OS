import { randomUUID } from "crypto";
import type { RoutineWorkflowDefinition } from "../../../shared/routine-workflow";
import { ROUTINE_WORKFLOW_VERSION } from "../../../shared/routine-workflow";
import { ROUTINE_WORKFLOW_TEMPLATES } from "./templates";

/**
 * Produce a safe draft from natural language without executing or enabling it.
 * Template matching is deterministic; unmatched requests become an editable
 * manual-starter + agent workflow rather than inventing connector arguments.
 */
export function generateRoutineWorkflowDraft(prompt: string): {
  workflow: RoutineWorkflowDefinition;
  matchedTemplateId?: string;
  confidence: number;
} {
  const normalized = normalize(prompt);
  let best: { templateId: string; score: number } | null = null;
  for (const template of ROUTINE_WORKFLOW_TEMPLATES) {
    const phrases = [template.name, template.description, ...template.promptHints];
    const score = Math.max(...phrases.map((phrase) => similarity(normalized, normalize(phrase))));
    if (!best || score > best.score) best = { templateId: template.id, score };
  }

  if (best && best.score >= 0.34) {
    const template = ROUTINE_WORKFLOW_TEMPLATES.find(
      (candidate) => candidate.id === best!.templateId,
    )!;
    return {
      workflow: {
        ...structuredClone(template.workflow),
        generatedFromPrompt: prompt.trim(),
        updatedAt: Date.now(),
      },
      matchedTemplateId: template.id,
      confidence: Math.min(1, best.score),
    };
  }

  const starterId = randomUUID();
  const agentId = randomUUID();
  return {
    workflow: {
      version: ROUTINE_WORKFLOW_VERSION,
      starterNodeId: starterId,
      generatedFromPrompt: prompt.trim(),
      nodes: [
        {
          id: starterId,
          kind: "starter",
          operation: "starter.manual",
          name: "Run manually",
          config: {},
          position: { x: 80, y: 80 },
        },
        {
          id: agentId,
          kind: "agent",
          operation: "agent.run",
          name: "Run the requested work",
          description: "Review this generated draft before turning it on.",
          config: { prompt: prompt.trim() },
          position: { x: 392, y: 80 },
        },
      ],
      edges: [
        {
          id: `${starterId}:success:${agentId}`,
          sourceNodeId: starterId,
          targetNodeId: agentId,
          sourcePort: "success",
        },
      ],
      settings: {
        maxRunDurationMs: 30 * 60 * 1_000,
        maxStepCount: 100,
        maxForEachItems: 100,
        maxParallelSteps: 4,
        retainStepDataDays: 30,
      },
      updatedAt: Date.now(),
    },
    confidence: best?.score || 0,
  };
}

function normalize(value: string): string {
  return String(value || "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function similarity(left: string, right: string): number {
  const leftWords = new Set(left.split(" ").filter((word) => word.length > 2));
  const rightWords = new Set(right.split(" ").filter((word) => word.length > 2));
  if (leftWords.size === 0 || rightWords.size === 0) return 0;
  const overlap = Array.from(leftWords).filter((word) => rightWords.has(word)).length;
  const containmentBonus = left.includes(right) || right.includes(left) ? 0.45 : 0;
  return Math.min(1, overlap / Math.min(leftWords.size, rightWords.size) + containmentBonus);
}
