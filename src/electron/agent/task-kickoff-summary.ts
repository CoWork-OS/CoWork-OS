import type { PlanStep, TaskEvent } from "../../shared/types";
import { isVerificationStepDescription } from "../../shared/plan-utils";
import { generatedPlanStepLabel } from "../../shared/generated-plan-steps";

export const TASK_KICKOFF_PROMPT_RULES = [
  "TASK KICKOFF:",
  "- At the start of an actionable task, before the first tool call, send one brief task-specific assistant update in normal prose.",
  "- Say what you will inspect or do first and how you will validate the result. Keep it to one or two sentences.",
  "- Do not repeat the user's request verbatim, list every plan step, claim findings before evidence exists, or add a kickoff for a direct answer that needs no tools.",
].join("\n");

const GERUND_BY_VERB: Record<string, string> = {
  add: "adding",
  analyze: "analyzing",
  build: "building",
  check: "checking",
  compare: "comparing",
  create: "creating",
  debug: "debugging",
  diagnose: "diagnosing",
  edit: "editing",
  explore: "exploring",
  fix: "fixing",
  gather: "gathering",
  generate: "generating",
  hand: "handing",
  identify: "identifying",
  implement: "implementing",
  inspect: "inspecting",
  locate: "locating",
  make: "making",
  map: "mapping",
  open: "opening",
  read: "reading",
  reproduce: "reproducing",
  research: "researching",
  review: "reviewing",
  run: "running",
  set: "setting",
  study: "studying",
  take: "taking",
  test: "testing",
  trace: "tracing",
  understand: "understanding",
  update: "updating",
  use: "using",
  verify: "verifying",
  write: "writing",
};

// Emphasis underscores sit at word edges; underscores inside names (run_command) stay.
const MAX_KICKOFF_DESCRIPTION_LENGTH = 140;

function cleanDescription(value: unknown): string {
  const raw = String(value || "");
  // A step the runtime wrote is an instruction to the model; say what it does instead.
  const text = (generatedPlanStepLabel(raw) ?? raw)
    .replace(/^[\s#>*\-\d.)]+/, "")
    .replace(/[`*#]/g, "")
    .replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return shortenToWholeWords(text)
    .replace(/[.!?:;,]+$/, "")
    .trim();
}

/** Long steps keep their first sentence, then whole words; never "Assign publ". */
function shortenToWholeWords(text: string): string {
  if (text.length <= MAX_KICKOFF_DESCRIPTION_LENGTH) return text;
  const firstSentence = text.match(/^[\s\S]*?[.!?](?=\s|$)/)?.[0] ?? "";
  if (firstSentence && firstSentence.length <= MAX_KICKOFF_DESCRIPTION_LENGTH) return firstSentence;
  const cut = text.slice(0, MAX_KICKOFF_DESCRIPTION_LENGTH + 1);
  const lastSpace = cut.lastIndexOf(" ");
  return (
    lastSpace > 0 ? cut.slice(0, lastSpace) : cut.slice(0, MAX_KICKOFF_DESCRIPTION_LENGTH)
  ).trim();
}

function toGerundPhrase(description: string): string | null {
  const match = description.match(/^([A-Za-z]+)(\b[\s\S]*)$/);
  if (!match) return null;
  const verb = match[1].toLowerCase();
  if (verb.endsWith("ing")) return `${verb}${match[2]}`;
  const gerund = GERUND_BY_VERB[verb];
  return gerund ? `${gerund}${match[2]}` : null;
}

function fallbackActionForTool(toolName: string): string {
  const normalized = String(toolName || "")
    .trim()
    .toLowerCase();
  if (/browser|web|search|fetch|http|citation/.test(normalized)) {
    return "gathering the relevant evidence";
  }
  if (/image|video|canvas|presentation|document|spreadsheet/.test(normalized)) {
    return "preparing the requested output";
  }
  if (/write|edit|patch|create|delete|move|copy|rename/.test(normalized)) {
    return "making the requested change";
  }
  return "inspecting the relevant context";
}

export function buildTaskKickoffSummary(args: {
  currentStepDescription?: string | null;
  planSteps?: PlanStep[];
  firstToolName?: string;
}): string {
  const currentStepDescription = cleanDescription(args.currentStepDescription);
  const candidates = [
    isVerificationStepDescription(currentStepDescription) ? "" : currentStepDescription,
    ...(args.planSteps || [])
      .filter(
        (step) => step.kind !== "verification" && !isVerificationStepDescription(step.description),
      )
      .map((step) => step.description),
  ];
  const description = candidates.map(cleanDescription).find(Boolean) || "";
  const action = description
    ? toGerundPhrase(description)
    : fallbackActionForTool(args.firstToolName || "");

  if (action) {
    return `I’ll start by ${action}, then continue through the remaining work and verify the result.`;
  }
  return `I’ll start with “${description},” then continue through the remaining work and verify the result.`;
}

export function responseHasAssistantText(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some(
      (item) =>
        item &&
        typeof item === "object" &&
        (item as { type?: unknown }).type === "text" &&
        String((item as { text?: unknown }).text || "").trim().length > 0,
    )
  );
}

export function taskSessionKickoffIsSettled(events: TaskEvent[]): boolean {
  return events.some((event) => {
    const type =
      typeof event.legacyType === "string" && event.legacyType.length > 0
        ? event.legacyType
        : event.type;
    if (type === "tool_call") return true;
    if (type !== "assistant_message") return false;
    const payload =
      event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : {};
    return (
      payload.internal !== true &&
      String(payload.message || payload.content || "").trim().length > 0
    );
  });
}
