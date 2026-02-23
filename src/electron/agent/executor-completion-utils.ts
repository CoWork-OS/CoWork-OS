import { isVerificationStepDescription } from "../../shared/plan-utils";
import type { CompletionContract } from "./executor-helpers";

export function shouldRequireExecutionEvidence(taskTitle: string, taskPrompt: string): boolean {
  const prompt = `${taskTitle}\n${taskPrompt}`.toLowerCase();
  return /\b(create|build|write|generate|transcribe|summarize|analyze|review|fix|implement|run|execute)\b/.test(
    prompt,
  );
}

export function promptRequestsArtifactOutput(taskTitle: string, taskPrompt: string): boolean {
  const prompt = `${taskTitle}\n${taskPrompt}`.toLowerCase();
  const createVerb = /\b(create|build|write|generate|produce|draft|prepare|save|export)\b/.test(
    prompt,
  );
  const artifactNoun =
    /\b(file|document|report|pdf|docx|markdown|md|spreadsheet|csv|xlsx|json|txt|pptx|slide|slides)\b/.test(
      prompt,
    );
  return createVerb && artifactNoun;
}

export function inferRequiredArtifactExtensions(taskTitle: string, taskPrompt: string): string[] {
  const prompt = `${taskTitle}\n${taskPrompt}`.toLowerCase();
  const hasCreateIntent =
    /\b(create|build|write|generate|produce|draft|prepare|save|export|compile)\b/.test(prompt);
  if (!hasCreateIntent) return [];

  const stripped = prompt.replace(/\/\S+/g, " ").replace(/\w+\.\w{2,5}\b/g, " ");
  const extensions = new Set<string>();

  if (/\bpdf\b|\.pdf\b/.test(stripped)) extensions.add(".pdf");
  if (/\bdocx\b|\.docx\b|\bword document\b/.test(stripped)) extensions.add(".docx");
  if (/\bmarkdown\b|\.md\b|\bmd file\b/.test(stripped)) extensions.add(".md");
  if (/\bcsv\b|\.csv\b/.test(stripped)) extensions.add(".csv");
  if (/\bxlsx\b|\.xlsx\b|\bexcel\b|\bspreadsheet\b/.test(stripped)) extensions.add(".xlsx");
  if (/\bjson\b|\.json\b/.test(stripped)) extensions.add(".json");
  if (/\btxt\b|\.txt\b|\btext file\b/.test(stripped)) extensions.add(".txt");
  if (/\bpptx\b|\.pptx\b|\bpowerpoint\b|\bslides?\b/.test(stripped)) extensions.add(".pptx");

  return Array.from(extensions);
}

export function buildCompletionContract(opts: {
  taskTitle: string;
  taskPrompt: string;
  requiresDirectAnswer: boolean;
  requiresDecisionSignal: boolean;
  isWatchSkipRecommendationTask: boolean;
}): CompletionContract {
  const requiresExecutionEvidence = shouldRequireExecutionEvidence(opts.taskTitle, opts.taskPrompt);
  const requiredArtifactExtensions = inferRequiredArtifactExtensions(
    opts.taskTitle,
    opts.taskPrompt,
  );
  const requiresArtifactEvidence =
    (promptRequestsArtifactOutput(opts.taskTitle, opts.taskPrompt) ||
      requiredArtifactExtensions.length > 0) &&
    !opts.isWatchSkipRecommendationTask;

  const prompt = `${opts.taskTitle}\n${opts.taskPrompt}`.toLowerCase();
  const hasReviewCue = /\b(review|evaluate|assess|verify|check|read|audit)\b/.test(prompt);
  const hasJudgmentCue =
    /\b(let me know|tell me|advise|recommend|whether|should i|worth|waste of)\b/.test(prompt);
  const hasEvidenceWorkCue =
    /\b(transcribe|summarize|review|evaluate|assess|audit|analy[sz]e|watch|read)\b/.test(prompt);
  const hasSequencingCue = /\b(and then|then|after|based on)\b/.test(prompt);
  const requiresVerificationEvidence =
    requiresExecutionEvidence &&
    (hasReviewCue || (hasJudgmentCue && hasEvidenceWorkCue && hasSequencingCue));

  return {
    requiresExecutionEvidence,
    requiresDirectAnswer: opts.requiresDirectAnswer,
    requiresDecisionSignal: opts.requiresDecisionSignal,
    requiresArtifactEvidence,
    requiredArtifactExtensions,
    requiresVerificationEvidence,
  };
}

export function responseHasDecisionSignal(text: string): boolean {
  const normalized = String(text || "").toLowerCase();
  if (!normalized.trim()) return false;
  return (
    /\byes\b/.test(normalized) ||
    /\bno\b/.test(normalized) ||
    /\bi recommend\b/.test(normalized) ||
    /\byou should\b/.test(normalized) ||
    /\bshould (?:you|i|we)\b/.test(normalized) ||
    /\bgo with\b/.test(normalized) ||
    /\bchoose\b/.test(normalized) ||
    /\bworth(?:\s+it)?\b/.test(normalized) ||
    /\bnot worth\b/.test(normalized) ||
    /\bskip\b/.test(normalized)
  );
}

export function responseHasVerificationSignal(text: string): boolean {
  const normalized = String(text || "").toLowerCase();
  if (!normalized.trim()) return false;
  return (
    /\bi\s+(reviewed|read|analyzed|assessed|verified|checked)\b/.test(normalized) ||
    /\bafter\s+(reviewing|reading|analyzing)\b/.test(normalized) ||
    /\bbased on\b/.test(normalized) ||
    /\baccording to\b/.test(normalized) ||
    /\b(i|we)\s+found\b/.test(normalized) ||
    /\b(?:my|the)\s+analysis\b/.test(normalized) ||
    /\bfindings\b/.test(normalized) ||
    /\bkey takeaways\b/.test(normalized) ||
    /\brecommendation\b/.test(normalized)
  );
}

export function responseHasReasonedConclusionSignal(text: string): boolean {
  const normalized = String(text || "").toLowerCase();
  if (!normalized.trim()) return false;

  const hasConclusionCue =
    responseHasDecisionSignal(normalized) ||
    /\b(recommend(?:ation)?|conclusion|overall|in summary|it appears|i believe)\b/.test(normalized);
  const hasReasoningCue =
    /\b(because|since|therefore|as a result|due to|which means|this suggests|that indicates|given that)\b/.test(
      normalized,
    );

  return hasConclusionCue && hasReasoningCue;
}

export function hasVerificationToolEvidence(
  toolResultMemory: Array<{ tool: string }> | undefined,
): boolean {
  if (!Array.isArray(toolResultMemory) || toolResultMemory.length === 0) return false;
  return toolResultMemory.some(
    (entry) =>
      entry.tool === "web_search" ||
      entry.tool === "web_fetch" ||
      entry.tool === "search_files" ||
      entry.tool === "glob",
  );
}

export function responseLooksOperationalOnly(text: string): boolean {
  const normalized = String(text || "")
    .trim()
    .toLowerCase();
  if (!normalized) return true;

  const hasArtifactReference =
    /\.(pdf|docx|txt|md|csv|xlsx|pptx|json)\b/.test(normalized) ||
    /\b(document|file|report|output|artifact)\b/.test(normalized);
  const hasStatusVerb =
    /\b(created|saved|generated|wrote|updated|exported|finished|completed|done)\b/.test(normalized);
  const hasReasoningCue =
    /\b(because|therefore|so that|tradeoff|pros|cons|reason|recommend|should|why|answer|conclusion)\b/.test(
      normalized,
    );

  const sentenceCount = normalized
    .split(/[.!?]\s+/)
    .map((part) => part.trim())
    .filter(Boolean).length;

  if (/^created:\s+\S+/i.test(normalized) || /^saved:\s+\S+/i.test(normalized)) {
    return true;
  }

  return (
    hasArtifactReference &&
    hasStatusVerb &&
    !hasReasoningCue &&
    sentenceCount <= 2 &&
    normalized.length < 320
  );
}

export function getBestFinalResponseCandidate(opts: {
  buildResultSummary: () => string | undefined;
  lastAssistantText: string | null;
  lastNonVerificationOutput: string | null;
  lastAssistantOutput: string | null;
}): string {
  const candidates = [
    opts.buildResultSummary(),
    opts.lastAssistantText,
    opts.lastNonVerificationOutput,
    opts.lastAssistantOutput,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    return trimmed;
  }

  return "";
}

export function responseDirectlyAddressesPrompt(opts: {
  text: string;
  contract: CompletionContract;
  minResultSummaryLength: number;
}): boolean {
  const normalized = String(opts.text || "").trim();
  if (!normalized) return false;
  if (!opts.contract.requiresDirectAnswer) return true;
  if (responseLooksOperationalOnly(normalized)) return false;
  if (opts.contract.requiresDecisionSignal && !responseHasDecisionSignal(normalized)) return false;
  const needsDetailedAnswer =
    opts.contract.requiresExecutionEvidence || opts.contract.requiresDecisionSignal;
  if (needsDetailedAnswer && normalized.length < opts.minResultSummaryLength) return false;
  return true;
}

export function fallbackContainsDirectAnswer(opts: {
  contract: CompletionContract;
  lastAssistantText: string | null;
  lastNonVerificationOutput: string | null;
  lastAssistantOutput: string | null;
  minResultSummaryLength: number;
}): boolean {
  const fallbackCandidates = [
    opts.lastAssistantText,
    opts.lastNonVerificationOutput,
    opts.lastAssistantOutput,
  ];

  return fallbackCandidates.some((candidate) =>
    responseDirectlyAddressesPrompt({
      text: candidate || "",
      contract: opts.contract,
      minResultSummaryLength: opts.minResultSummaryLength,
    }),
  );
}

export function hasArtifactEvidence(opts: {
  contract: CompletionContract;
  createdFiles: string[];
}): boolean {
  if (!opts.contract.requiresArtifactEvidence) return true;
  if (opts.createdFiles.length === 0) return false;
  if (!opts.contract.requiredArtifactExtensions.length) return true;

  const lowered = opts.createdFiles.map((file) => String(file).toLowerCase());
  return opts.contract.requiredArtifactExtensions.some((ext: string) =>
    lowered.some((file: string) => file.endsWith(ext)),
  );
}

export function hasVerificationEvidence(opts: {
  bestCandidate: string;
  planSteps?: Array<{ status?: string; description?: string }>;
  toolResultMemory?: Array<{ tool: string }>;
}): boolean {
  const hasCompletedReviewStep = !!opts.planSteps?.some(
    (step) =>
      step.status === "completed" &&
      (isVerificationStepDescription(step.description || "") ||
        /\b(review|evaluate|assess|verify|check|read|audit|analy[sz]e)\b/i.test(
          step.description || "",
        )),
  );

  const hasReviewBackedConclusion = responseHasVerificationSignal(opts.bestCandidate);
  if (hasCompletedReviewStep || hasReviewBackedConclusion) {
    return true;
  }

  return (
    hasVerificationToolEvidence(opts.toolResultMemory) &&
    responseHasReasonedConclusionSignal(opts.bestCandidate)
  );
}

export function getFinalOutcomeGuardError(opts: {
  contract: CompletionContract;
  preferBestEffortCompletion: boolean;
  softDeadlineTriggered: boolean;
  cancelReason: string | null;
  bestCandidate: string;
  hasExecutionEvidence: boolean;
  hasArtifactEvidence: boolean;
  createdFiles: string[];
  responseDirectlyAddressesPrompt: (text: string, contract: CompletionContract) => boolean;
  fallbackContainsDirectAnswer: (contract: CompletionContract) => boolean;
  hasVerificationEvidence: (bestCandidate: string) => boolean;
}): string | null {
  const bestEffortMode =
    opts.preferBestEffortCompletion &&
    (opts.softDeadlineTriggered || opts.cancelReason === "timeout");
  if (bestEffortMode && opts.bestCandidate.trim()) {
    return null;
  }

  if (opts.contract.requiresExecutionEvidence && !opts.hasExecutionEvidence) {
    return "Task missing execution evidence: no plan step completed successfully.";
  }

  if (!opts.hasArtifactEvidence) {
    const hasSubstantiveText = opts.bestCandidate.trim().length >= 50;
    if (!(hasSubstantiveText && opts.createdFiles.length === 0)) {
      const requested = opts.contract.requiredArtifactExtensions.join(", ");
      return requested
        ? `Task missing artifact evidence: expected an output artifact (${requested}) but no matching created file was detected.`
        : "Task missing artifact evidence: expected an output file/document but no created file was detected.";
    }
  }

  if (
    opts.contract.requiresDirectAnswer &&
    !opts.responseDirectlyAddressesPrompt(opts.bestCandidate, opts.contract)
  ) {
    if (opts.fallbackContainsDirectAnswer(opts.contract)) {
      return null;
    }
    return "Task missing direct answer: the final response does not clearly answer the user request and appears to be operational status only.";
  }

  if (
    opts.contract.requiresVerificationEvidence &&
    !opts.hasVerificationEvidence(opts.bestCandidate) &&
    opts.createdFiles.length === 0
  ) {
    return "Task missing verification evidence: no completed review/verification step or review-backed conclusion was detected.";
  }

  return null;
}
