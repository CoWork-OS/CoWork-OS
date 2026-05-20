import { isVerificationStepDescription } from "../../shared/plan-utils";
import type { CompletionContract } from "./executor-helpers";
import { extractArtifactExtensionsFromText } from "./step-contract";

const ARTIFACT_CREATION_VERB_REGEX =
  /\b(create|build|write|generate|produce|draft|prepare|save|export|compile|synthesize|combine|merge|join|stitch|concatenate|concat|transcode|remux)\b/;
const STRATEGY_CONTEXT_BLOCK_REGEX =
  /\[AGENT_STRATEGY_CONTEXT_V1\][\s\S]*?\[\/AGENT_STRATEGY_CONTEXT_V1\]/g;
const ADDITIONAL_CONTEXT_HEADER = "ADDITIONAL CONTEXT:";
const WORKFLOW_DECOMPOSITION_HEADER =
  "WORKFLOW DECOMPOSITION (execute these phases sequentially, passing output from each phase to the next):";
const USER_UPDATE_HEADER = "USER UPDATE:";
const SYNTHETIC_SECTION_LOOKAHEAD = `(?:${ADDITIONAL_CONTEXT_HEADER}|${WORKFLOW_DECOMPOSITION_HEADER}|${USER_UPDATE_HEADER})`;
const COMPLETED_REVIEW_STEP_REGEX =
  /\b(review(?:ed|ing)?|evaluat(?:e|ed|ing|ion)|assess(?:ed|ing|ment)?|verif(?:y|ied|ying|ication)|check(?:ed|ing)?|read(?:ing)?|audit(?:ed|ing)?|analy[sz](?:e|ed|ing|is)|scan(?:ned|ning)?|summari[sz](?:e|ed|ing)|triag(?:e|ed|ing))\b/i;

export function normalizePromptForContracts(taskPrompt: string): string {
  const raw = String(taskPrompt || "");
  if (!raw.trim()) return "";

  const withoutStrategy = raw.replace(STRATEGY_CONTEXT_BLOCK_REGEX, "");
  const withoutAdditionalContext = withoutStrategy.replace(
    new RegExp(
      `\\n{2}${ADDITIONAL_CONTEXT_HEADER}\\n[\\s\\S]*?(?=\\n{2}${SYNTHETIC_SECTION_LOOKAHEAD}|$)`,
      "g",
    ),
    "",
  );
  const withoutWorkflow = withoutAdditionalContext.replace(
    new RegExp(
      `\\n{2}${WORKFLOW_DECOMPOSITION_HEADER.replace(/[()]/g, "\\$&")}\\n[\\s\\S]*?(?=\\n{2}${USER_UPDATE_HEADER}|$)`,
      "g",
    ),
    "",
  );

  return withoutWorkflow
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function shouldRequireExecutionEvidence(taskTitle: string, taskPrompt: string): boolean {
  const prompt = `${taskTitle}\n${normalizePromptForContracts(taskPrompt)}`.toLowerCase();
  return /\b(create|build|write|generate|transcribe|summarize|analyze|review|fix|implement|run|execute)\b/.test(
    prompt,
  );
}

export function promptRequestsArtifactOutput(taskTitle: string, taskPrompt: string): boolean {
  const prompt = `${taskTitle}\n${normalizePromptForContracts(taskPrompt)}`.toLowerCase();
  const createVerb = ARTIFACT_CREATION_VERB_REGEX.test(prompt);
  const artifactNoun =
    /\b(file|document|report|pdf|docx|markdown|md|spreadsheet|csv|xlsx|json|txt|pptx|slide|slides|video|videos|clip|clips|movie|footage)\b/.test(
      prompt,
    );
  return (createVerb && artifactNoun) || promptRequestsPresentationArtifactOutput(taskTitle, taskPrompt);
}

function promptRequestsVideoArtifactOutput(taskTitle: string, taskPrompt: string): boolean {
  const prompt = `${taskTitle}\n${normalizePromptForContracts(taskPrompt)}`.toLowerCase();
  if (!prompt.trim()) return false;
  const hasVideoNoun = /\b(video|videos|clip|clips|movie|footage)\b/.test(prompt);
  if (!hasVideoNoun) return false;
  return ARTIFACT_CREATION_VERB_REGEX.test(prompt);
}

export function promptRequestsPresentationArtifactOutput(
  taskTitle: string,
  taskPrompt: string,
): boolean {
  const prompt = `${taskTitle}\n${normalizePromptForContracts(taskPrompt)}`.toLowerCase();
  if (!prompt.trim()) return false;

  const presentationNoun = String.raw`(?:presentation|slide\s+deck|pitch\s+deck|deck|powerpoint|pptx|slides?)`;
  const directCreation = new RegExp(
    String.raw`\b(?:create|build|make|generate|produce|draft|prepare|design|author|compose)\b[\s\S]{0,40}\b(?:a|an|the|concise|short|brief|full|complete|polished|powerpoint|pptx|slide\s+deck|pitch\s+deck|deck|presentation|slides?)\b[\s\S]{0,40}\b${presentationNoun}\b`,
    "i",
  ).test(prompt);
  const createNounImmediately = new RegExp(
    String.raw`\b(?:create|build|make|generate|produce|draft|prepare|design|author|compose)\s+(?:a\s+|an\s+|the\s+)?(?:concise\s+|short\s+|brief\s+|full\s+|complete\s+|polished\s+)?${presentationNoun}\b`,
    "i",
  ).test(prompt);
  const transformIntoPresentation = new RegExp(
    String.raw`\b(?:turn|convert|transform)\b[\s\S]{0,60}\binto\s+(?:a\s+|an\s+|the\s+)?${presentationNoun}\b`,
    "i",
  ).test(prompt);
  const explicitPptxOutput =
    /\b(?:create|build|make|generate|produce|draft|prepare|design|author|compose|export|save)\b/.test(
      prompt,
    ) && /\bpptx\b|\.pptx\b/.test(prompt);

  return directCreation || createNounImmediately || transformIntoPresentation || explicitPptxOutput;
}

export function promptRequestsCanvasArtifactOutput(taskTitle: string, taskPrompt: string): boolean {
  const prompt = `${taskTitle}\n${normalizePromptForContracts(taskPrompt)}`.toLowerCase();
  const hasCanvasCue = /\b(canvas|in-app canvas)\b/.test(prompt);

  if (hasCanvasCue) {
    const hasBuildIntent =
      /\b(build|create|develop|implement|make|craft|design|generate|produce|prototype)\b/.test(
        prompt,
      ) || /\b(interactive|web app|html app|single-page app|ui)\b/.test(prompt);
    if (!hasBuildIntent) return false;
    const hasShowIntent =
      /\b(show|render|display|open|preview|present)\b/.test(prompt) ||
      /\bin(?:to)?\s+(?:the\s+)?(?:in-app\s+)?canvas\b/.test(prompt);
    return hasShowIntent;
  }

  // Also trigger for multi-file web app creation prompts even without "canvas" keyword.
  // e.g. "Create a React app that...", "Build a Next.js dashboard", etc.
  return promptIsMultiFileWebAppCreation(prompt);
}

/**
 * Returns true when the prompt is clearly asking to build a multi-file web app
 * (React, Vue, Next.js, Vite, etc.) that should be run via a dev server and
 * shown in the canvas via canvas_open_url.
 */
export function promptIsMultiFileWebAppCreation(prompt: string): boolean {
  const normalized = typeof prompt === "string" ? prompt : String(prompt || "");
  const hasBuildVerb =
    /\b(create|build|make|develop|write|build out|scaffold|set up|implement)\b/.test(normalized);
  if (!hasBuildVerb) return false;

  const hasWebAppNoun =
    /\b(app|application|web app|webapp|react app|next\.?js|nextjs|vue app|vite app|svelte app|angular app|dashboard|tool|site|website|ui|interface)\b/.test(
      normalized,
    );
  return hasWebAppNoun;
}


export function inferRequiredArtifactExtensions(taskTitle: string, taskPrompt: string): string[] {
  const prompt = `${taskTitle}\n${normalizePromptForContracts(taskPrompt)}`.toLowerCase();
  const hasCreateIntent = ARTIFACT_CREATION_VERB_REGEX.test(prompt);
  if (!hasCreateIntent) return [];

  const extensions = new Set<string>(extractArtifactExtensionsFromText(prompt));
  if (promptRequestsPresentationArtifactOutput(taskTitle, taskPrompt)) {
    extensions.add(".pptx");
  }
  if (promptRequestsVideoArtifactOutput(taskTitle, taskPrompt) && extensions.size === 0) {
    extensions.add(".mp4");
  }

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
  const requiresCanvasArtifact = promptRequestsCanvasArtifactOutput(opts.taskTitle, opts.taskPrompt);
  const requiredArtifactExtensions = inferRequiredArtifactExtensions(
    opts.taskTitle,
    opts.taskPrompt,
  );
  const requiresArtifactEvidence =
    (promptRequestsArtifactOutput(opts.taskTitle, opts.taskPrompt) ||
      requiresCanvasArtifact ||
      requiredArtifactExtensions.length > 0) &&
    !opts.isWatchSkipRecommendationTask;
  const artifactKind: CompletionContract["artifactKind"] =
    requiresCanvasArtifact && !opts.isWatchSkipRecommendationTask
      ? "canvas"
      : requiresArtifactEvidence
        ? "file"
        : "none";

  const prompt = `${opts.taskTitle}\n${normalizePromptForContracts(opts.taskPrompt)}`.toLowerCase();
  // Only require canvas_push evidence when the prompt explicitly mentions "canvas".
  // Tasks detected as canvas via promptIsMultiFileWebAppCreation (e.g. "Create a website")
  // set artifactKind="canvas" to guide the agent but do NOT hard-require canvas_push —
  // the agent may serve locally, open a URL, or otherwise satisfy the intent without canvas_push.
  const hasExplicitCanvasCue = /\b(canvas|in-app canvas)\b/.test(prompt);
  const requiredSuccessfulTools =
    requiresCanvasArtifact && hasExplicitCanvasCue && !opts.isWatchSkipRecommendationTask
      ? ["write_file", "canvas_push"]
      : [];
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
    artifactKind,
    requiredSuccessfulTools,
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
    opts.lastNonVerificationOutput,
    opts.lastAssistantText,
    opts.lastAssistantOutput,
    opts.buildResultSummary(),
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
  /** When createdFiles is empty, modified files can satisfy artifact evidence (e.g. task edited existing file). */
  modifiedFiles?: string[];
}): boolean {
  if (!opts.contract.requiresArtifactEvidence) return true;
  const evidenceFiles =
    opts.createdFiles.length > 0 ? opts.createdFiles : (opts.modifiedFiles || []).map((file) => String(file));
  if (evidenceFiles.length === 0) return false;
  if (!opts.contract.requiredArtifactExtensions.length) return true;

  const lowered = evidenceFiles.map((file) => String(file).toLowerCase());
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
        COMPLETED_REVIEW_STEP_REGEX.test(step.description || "")),
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
