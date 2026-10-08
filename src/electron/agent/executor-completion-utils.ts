import * as path from "path";
import { isVerificationStepDescription } from "../../shared/plan-utils";
import { TOOL_GROUPS, type RuntimeToolResultKind } from "../../shared/types";
import type { CompletionContract } from "./executor-helpers";
import { CANONICAL_ARTIFACT_PATH_REGEX, extractArtifactExtensionsFromText } from "./step-contract";
import {
  canonicalizeToolName,
  isArtifactGenerationToolName,
  isCanonicalWriteToolName,
  isFileMutationToolName,
} from "./tool-semantics";
import { getDefaultRuntimeToolMetadata } from "./tools/runtime-tool-definition";

const ARTIFACT_CREATION_VERBS = String.raw`(?:create|build|write|generate|produce|draft|prepare|save|export|compile|synthesize|combine|merge|join|stitch|concatenate|concat|transcode|remux)`;
const ARTIFACT_CREATION_VERB_REGEX = new RegExp(String.raw`\b${ARTIFACT_CREATION_VERBS}\b`);
// "Video" names a deliverable only as a media object. "Two video calls" or a
// "video meeting" describes how the user communicates, not an output to make.
const VIDEO_ARTIFACT_NOUN = String.raw`(?:videos?|clips?|movies?|footage)(?![\s-]*(?:calls?|calling|meetings?|conferenc\w*|chats?|interviews?|consultations?|sessions?)\b)`;
// A prohibition whose verb list ends in an artifact verb, such as "do not
// contact anyone, reserve, pay, or create files". Removing these spans keeps
// the negated "create files" from being read as an affirmative output request.
const NEGATED_ARTIFACT_CLAUSE_REGEX = new RegExp(
  String.raw`\b(?:do\s+not|don'?t|must\s+not|should\s+not|never|no\s+need\s+to)\s+` +
    String.raw`(?:(?!\b(?:but|instead|then|unless|except|rather)\b)[^.!?;\n]){0,160}?` +
    String.raw`\b(?:create|build|write|generate|produce|draft|prepare|save|export|make)\s+` +
    String.raw`(?:any\s+|new\s+|a\s+|an\s+)*(?:files?|documents?|reports?|artifacts?|attachments?|${VIDEO_ARTIFACT_NOUN})\b`,
  "gi",
);

/**
 * Lowercased contract prompt with negated artifact clauses removed, for
 * inferring which output files the user affirmatively asked for.
 */
function promptForArtifactIntent(taskTitle: string, taskPrompt: string): string {
  return `${taskTitle}\n${normalizePromptForContracts(taskPrompt)}`
    .toLowerCase()
    .replace(NEGATED_ARTIFACT_CLAUSE_REGEX, " ");
}
const STRATEGY_CONTEXT_BLOCK_REGEX =
  /\[AGENT_STRATEGY_CONTEXT_V1\][\s\S]*?\[\/AGENT_STRATEGY_CONTEXT_V1\]/g;
const ADDITIONAL_CONTEXT_HEADER = "ADDITIONAL CONTEXT:";
const WORKFLOW_DECOMPOSITION_HEADER =
  "WORKFLOW DECOMPOSITION (execute these phases sequentially, passing output from each phase to the next):";
const USER_UPDATE_HEADER = "USER UPDATE:";
const SYNTHETIC_SECTION_LOOKAHEAD = `(?:${ADDITIONAL_CONTEXT_HEADER}|${WORKFLOW_DECOMPOSITION_HEADER}|${USER_UPDATE_HEADER})`;
const COMPLETED_REVIEW_STEP_REGEX =
  /\b(review(?:ed|ing)?|evaluat(?:e|ed|ing|ion)|assess(?:ed|ing|ment)?|verif(?:y|ied|ying|ication)|check(?:ed|ing)?|read(?:ing)?|audit(?:ed|ing)?|analy[sz](?:e|ed|ing|is)|scan(?:ned|ning)?|summari[sz](?:e|ed|ing)|triag(?:e|ed|ing))\b/i;
const VERIFICATION_TOOL_EVIDENCE = new Set([
  "web_search",
  "web_fetch",
  "search_files",
  "grep",
  "glob",
  "run_command",
  "http_request",
  "read_file",
  "get_file_info",
  "list_directory",
  // The bounded document pipeline performs a policy-checked, checksum-backed
  // source extraction internally rather than through a model tool call. Treat
  // that extraction as verification evidence for its completed review step.
  "bounded_document_extract",
]);
// Content-gathering tools whose names do not follow the read_/list_/get_/
// search_ conventions the runtime metadata infers read-only results from.
const CONTENT_GATHERING_TOOL_REGEX =
  /^(?:scrape_|qa_|youtube_)|^(?:parse_document|read_pdf_visual|analyze_image|execute_code)$/;
// Lanes whose tools act on the agent's own state rather than observe the task.
const NON_EVIDENCE_TOOL_LANES = new Set(["memory", "orchestration", "admin", "artifact"]);
const SELF_STATE_TOOL_REGEX = /^task_list_/;
const EVIDENCE_RESULT_KINDS = new Set<RuntimeToolResultKind>([
  "read",
  "search",
  "command",
  "browser",
  "integration",
]);
const READ_GROUP_TOOLS = new Set<string>(TOOL_GROUPS["group:read"]);
// Tools that can actually produce the command output or API responses an
// execution report claims (exit codes, HTTP statuses, pass/fail results).
const COMMAND_OR_API_EVIDENCE_TOOLS = new Set([
  "run_command",
  "execute_code",
  "http_request",
  "web_fetch",
]);

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
  const prompt = promptForArtifactIntent(taskTitle, taskPrompt);
  if (promptRequestsPresentationArtifactOutput(taskTitle, taskPrompt)) return true;

  const artifactNoun = String.raw`(?:files?(?!\s*(?:paths?|names?|areas?|refs?|references?|changes?|diffs?|statuses?|state|tree|lists?|involved)\b)|document|report|pdf|docx|markdown|md|spreadsheet|csv|xlsx|json|txt|pptx|slide|slides|${VIDEO_ARTIFACT_NOUN})`;
  const createVerb = String.raw`(?:create|build|write|generate|produce|draft|prepare|save|export|compile|synthesize|combine|merge|join|stitch|concatenate|concat|transcode|remux)`;
  const directObjectModifier = String.raw`(?:(?!(?:in|with|from|for|to|as|about|including|include|that|which)\b)[a-z0-9][a-z0-9-]*\s+)`;
  const directArtifactCreation = new RegExp(
    String.raw`\b${createVerb}\s+(?:a\s+|an\s+|the\s+)?(?:new\s+|final\s+|comprehensive\s+|concise\s+|polished\s+|requested\s+)?${directObjectModifier}{0,4}${artifactNoun}\b`,
    "i",
  ).test(prompt);
  const transformIntoArtifact = new RegExp(
    String.raw`\b(?:compile|synthesize|combine|merge|turn|convert|transform)\b[^.!?\n]{0,120}\binto\s+(?:a\s+|an\s+|the\s+)?(?:final\s+|comprehensive\s+|concise\s+)?${artifactNoun}\b`,
    "i",
  ).test(prompt);
  const explicitOutputPath =
    /\b(?:save|export|write|output)\b[\s\S]{0,80}\b(?:to|as)\b[\s\S]{0,80}\.(?:pdf|docx|txt|md|csv|xlsx|pptx|json)\b/i.test(
      prompt,
    );
  const explicitArtifactFormat = new RegExp(
    String.raw`\b(?:save|export|write|output)\b[^.!?\n]{0,80}\b(?:to|as)\b[^.!?\n]{0,80}\b(?:a\s+|an\s+|the\s+)?(?:new\s+|final\s+)?${artifactNoun}\s+(?:file|document|report|spreadsheet|deck|slides?|video|clip)\b`,
    "i",
  ).test(prompt);

  return (
    directArtifactCreation || transformIntoArtifact || explicitOutputPath || explicitArtifactFormat
  );
}

function promptRequestsVideoArtifactOutput(taskTitle: string, taskPrompt: string): boolean {
  const prompt = promptForArtifactIntent(taskTitle, taskPrompt);
  if (!prompt.trim()) return false;
  if (!new RegExp(String.raw`\b${VIDEO_ARTIFACT_NOUN}`).test(prompt)) return false;

  // The video must be the object of the creation verb ("combine two videos",
  // "generate a short promo video"), not merely mentioned elsewhere in a
  // request that creates something else ("summarize the video").
  const createVerb = ARTIFACT_CREATION_VERBS;
  const objectModifier = String.raw`(?:(?!(?:in|with|from|for|to|as|about|of|on|including|include|that|which|and|or)\b)[a-z0-9][a-z0-9'-]*\s+)`;
  const directVideoObject = new RegExp(
    String.raw`\b${createVerb}\s+${objectModifier}{0,4}${VIDEO_ARTIFACT_NOUN}\b`,
  ).test(prompt);
  const intoVideo = new RegExp(
    String.raw`\b(?:${createVerb}|turn|convert|transform|edit|render)\b[^.!?;\n]{0,120}\binto\s+${objectModifier}{0,3}${VIDEO_ARTIFACT_NOUN}\b`,
  ).test(prompt);
  const saveAsVideo = new RegExp(
    String.raw`\b(?:save|export|output|render)\b[^.!?;\n]{0,60}\bas\s+${objectModifier}{0,3}${VIDEO_ARTIFACT_NOUN}\b`,
  ).test(prompt);
  return directVideoObject || intoVideo || saveAsVideo;
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

/**
 * Returns true when the user explicitly asks for a success/failure status.
 * These prompts are asking for an operational confirmation, not a substantive
 * recommendation or analysis. A concise status should therefore be accepted
 * as a direct answer after the requested work is evidenced.
 */
export function promptAllowsOperationalStatus(taskTitle: string, taskPrompt: string): boolean {
  const prompt = `${taskTitle}\n${normalizePromptForContracts(taskPrompt)}`.toLowerCase();
  if (!prompt.trim()) return false;

  const requestCue = String.raw`(?:report|tell|let\s+me\s+know|confirm|state|say)`;
  const statusCue = String.raw`(?:whether|if)\b[^.!?\n]{0,100}\b(?:succeed(?:ed)?|success(?:ful(?:ly)?)?|work(?:ed)?|complete(?:d)?|finish(?:ed)?|pass(?:ed)?|fail(?:ed)?|block(?:ed)?)\b`;
  const resultCue = String.raw`(?:success|failure|pass/fail|status|result)\b`;

  return (
    new RegExp(`\\b${requestCue}\\b[^.!?\\n]{0,80}\\b${statusCue}`, "i").test(prompt) ||
    new RegExp(`\\b${requestCue}\\b[^.!?\\n]{0,80}\\b${resultCue}`, "i").test(prompt)
  );
}

/**
 * Returns true when the current step has accumulated a tool failure that has
 * not been recovered by a later successful tool result or by a permitted
 * useful-partial-progress fallback. Assistant text emitted in this state must
 * stay internal until the step's terminal status is known; otherwise a model
 * can surface a fabricated-looking answer (for example, "200") immediately
 * before the executor marks the step failed.
 */
export function hasUnrecoveredToolFailureForAssistantOutput(opts: {
  hadAnyToolSuccess: boolean;
  hadToolError: boolean;
  hadToolSuccessAfterError: boolean;
  allToolErrorsInputDependent: boolean;
  toolErrors: Iterable<string>;
  visionFallbackRecovered?: boolean;
}): boolean {
  if (!opts.hadToolError || opts.hadToolSuccessAfterError) return false;

  const nonCriticalErrorTools = new Set(["web_search", "web_fetch"]);
  const toolErrors = Array.from(opts.toolErrors);
  const onlyNonCriticalErrors =
    toolErrors.length > 0 && toolErrors.every((tool) => nonCriticalErrorTools.has(tool));
  const recoveredByUsefulPartialProgress =
    opts.hadAnyToolSuccess &&
    (onlyNonCriticalErrors ||
      opts.allToolErrorsInputDependent ||
      opts.visionFallbackRecovered === true);

  return !recoveredByUsefulPartialProgress;
}

/**
 * Returns true when an assistant response belongs to a plan step that follows
 * an unrecovered, blocking step failure. Downstream text can otherwise turn a
 * failed prerequisite into a plausible-looking answer (for example, a model
 * inventing the output of a denied shell command after a metadata lookup).
 */
export function hasUnrecoveredBlockingPlanFailureForAssistantOutput(opts: {
  currentStepIndex: number;
  planSteps: ReadonlyArray<{
    status?: string;
    recovered?: boolean;
    optional?: boolean;
  }>;
}): boolean {
  const currentStepIndex = Number.isFinite(opts.currentStepIndex)
    ? Math.max(0, Math.floor(opts.currentStepIndex))
    : 0;

  return opts.planSteps
    .slice(0, currentStepIndex)
    .some((step) => step.status === "failed" && !step.recovered && !step.optional);
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
  const creationVerb = String.raw`(?:create|make|develop|write|build out|scaffold|set up|implement|build(?!\s+status\b))`;
  const webAppTarget = String.raw`(?:web\s+app|webapp|react\s+app|next\.?js\s+app|nextjs\s+app|vue\s+app|vite\s+app|svelte\s+app|angular\s+app|frontend|website|site|dashboard|portal|ui|interface|single-page\s+app|spa)`;
  const frameworkTarget = String.raw`(?:react|vue|svelte|next\.?js|nextjs|vite|angular)`;

  const directCreation = new RegExp(
    String.raw`\b${creationVerb}\b[\s\S]{0,60}\b(?:a|an|the|new|simple|full|working|interactive|production-ready|polished|responsive)?\s*${webAppTarget}\b`,
    "i",
  ).test(normalized);
  const frameworkCreation = new RegExp(
    String.raw`\b${creationVerb}\b[\s\S]{0,60}\b${frameworkTarget}\b[\s\S]{0,40}\b(?:app|application|site|website|dashboard|frontend|ui|interface)\b`,
    "i",
  ).test(normalized);
  const scaffoldCreation = new RegExp(
    String.raw`\b(?:scaffold|set up)\b[\s\S]{0,60}\b(?:${frameworkTarget}|frontend|web\s+app|website|dashboard)\b`,
    "i",
  ).test(normalized);

  return directCreation || frameworkCreation || scaffoldCreation;
}

export function inferRequiredArtifactExtensions(taskTitle: string, taskPrompt: string): string[] {
  const prompt = promptForArtifactIntent(taskTitle, taskPrompt);
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

const EXPLICIT_OUTPUT_EXTENSION_SET = new Set([
  "pdf",
  "docx",
  "md",
  "csv",
  "xlsx",
  "json",
  "jsonl",
  "txt",
  "pptx",
  "mp4",
  "mov",
  "webm",
  "html",
]);

/**
 * Extracts artifact extensions ONLY from explicit output-intent patterns —
 * e.g. "save as .pdf", "export to .xlsx", "create a PDF report".
 * Unlike inferRequiredArtifactExtensions() which scans the full prompt text,
 * this function does NOT pick up extensions from input-context references
 * like "read PRIORITIES.md".
 */
export function extractExplicitOutputExtensions(taskTitle: string, taskPrompt: string): string[] {
  const prompt = promptForArtifactIntent(taskTitle, taskPrompt);
  const extensions = new Set<string>();

  // Pattern 1: "save/export/write/output ... to/as ... .ext"
  const saveAsPattern =
    /\b(?:save|export|write|output)\b[^.!?\n]{0,80}\b(?:to|as)\b[^.!?\n]{0,80}\.(\w{2,5})\b/gi;
  let match = saveAsPattern.exec(prompt);
  while (match) {
    const ext = match[1]!;
    if (EXPLICIT_OUTPUT_EXTENSION_SET.has(ext)) extensions.add(`.${ext}`);
    match = saveAsPattern.exec(prompt);
  }

  // Pattern 2: "create/generate a PDF/DOCX/CSV file/document/report"
  const createFormatPattern =
    /\b(?:create|generate|produce|draft|build|write)\s+(?:a\s+|an\s+|the\s+)?(?:\w+\s+){0,3}(pdf|docx|xlsx|csv|pptx|txt|markdown|md)\s+(?:file|document|report|spreadsheet|deck)\b/gi;
  match = createFormatPattern.exec(prompt);
  while (match) {
    let ext = match[1]!;
    if (ext === "markdown") ext = "md";
    if (EXPLICIT_OUTPUT_EXTENSION_SET.has(ext)) extensions.add(`.${ext}`);
    match = createFormatPattern.exec(prompt);
  }

  // Pattern 3: "write ... as a markdown file" / "write the findings as a markdown file"
  const writeAsFormatPattern =
    /\b(?:write|save|export)\b[^.!?\n]{0,60}\bas\s+(?:a\s+|an\s+)?(?:\w+\s+){0,2}(markdown|md|pdf|csv|json|txt|docx|xlsx|pptx)\s+(?:file|document|report)\b/gi;
  match = writeAsFormatPattern.exec(prompt);
  while (match) {
    let ext = match[1]!;
    if (ext === "markdown") ext = "md";
    if (EXPLICIT_OUTPUT_EXTENSION_SET.has(ext)) extensions.add(`.${ext}`);
    match = writeAsFormatPattern.exec(prompt);
  }

  // Pattern 4: an explicit output path after a creation verb, e.g.
  // "read notes.txt and create reports/action-items.md". Keep only the
  // path in the output clause so input references are not promoted to
  // required output types.
  // Keep periods that belong to a filename extension (for example
  // `action-items.md`) while still stopping at the end of the sentence. A
  // sentence boundary has a period followed by whitespace/end-of-string;
  // extension dots are followed by an alphanumeric character.
  const creationClausePattern =
    /\b(?:create|make|generate|produce|write|save|export|draft|build)\b(?:[^.!?\n]|\.(?=[A-Za-z0-9])){0,160}/gi;
  match = creationClausePattern.exec(prompt);
  while (match) {
    const clause = match[0] || "";
    const pathPattern = new RegExp(CANONICAL_ARTIFACT_PATH_REGEX.source, "gi");
    let pathMatch = pathPattern.exec(clause);
    while (pathMatch) {
      const prefix = clause.slice(0, pathMatch.index);
      // A path after an input/source cue belongs to the source material, not
      // the requested deliverable ("create report from notes.txt", "write a
      // summary of README.md"). A path right after "as"/"to"/"into"/"at" is
      // the destination even when the clause names a source first.
      const namesDestination = /\b(?:as|to|into|at)\s+(?:(?:the|a|an|new)\s+)?(?:file\s+)?$/i.test(
        prefix,
      );
      if (
        namesDestination ||
        !/\b(?:read|from|based\s+on|using|input|source|original|prior|previous|include|including|of|about|for)\b[^.!?\n]{0,60}$/i.test(
          prefix,
        )
      ) {
        const ext = path.extname(pathMatch[0]).toLowerCase();
        if (EXPLICIT_OUTPUT_EXTENSION_SET.has(ext.slice(1))) {
          extensions.add(ext);
        }
      }
      pathMatch = pathPattern.exec(clause);
    }
    match = creationClausePattern.exec(prompt);
  }

  // Pattern 5: Semantic format nouns in output-intent context
  // "create a spreadsheet" → .xlsx, "generate a PDF" → .pdf, etc.
  const semanticFormats: Array<[RegExp, string]> = [
    [
      /\b(?:create|generate|build|produce)\s+(?:a\s+|an\s+|the\s+)?(?:\w+\s+){0,3}spreadsheet\b/i,
      ".xlsx",
    ],
    [
      /\b(?:create|generate|build|produce)\s+(?:a\s+|an\s+|the\s+)?(?:\w+\s+){0,3}excel\s+(?:file|workbook|spreadsheet|document)\b/i,
      ".xlsx",
    ],
    [
      /\b(?:create|generate|build|produce|export)\s+(?:a\s+|an\s+|the\s+)?(?:\w+\s+){0,3}pdf\b/i,
      ".pdf",
    ],
    [
      /\b(?:create|generate|build|produce|export)\s+(?:a\s+|an\s+|the\s+)?(?:\w+\s+){0,3}docx?\b/i,
      ".docx",
    ],
  ];
  for (const [pattern, ext] of semanticFormats) {
    if (pattern.test(prompt)) extensions.add(ext);
  }

  // Presentation detection still uses the dedicated function
  if (promptRequestsPresentationArtifactOutput(taskTitle, taskPrompt)) {
    extensions.add(".pptx");
  }
  if (promptRequestsVideoArtifactOutput(taskTitle, taskPrompt) && extensions.size === 0) {
    extensions.add(".mp4");
  }

  return Array.from(extensions);
}

/**
 * Builds dynamic completion guidance for injection into the system prompt.
 * This is the Hermes-style behavioral steering layer — it tells the model
 * how to handle task completion rather than enforcing it post-hoc.
 */
export function buildCompletionGuidancePrompt(opts: {
  hasReadOnlyConstraint: boolean;
  explicitOutputExtensions: string[];
  likelyRequiresExecution: boolean;
}): string {
  const lines: string[] = [
    "TASK COMPLETION GUIDANCE:",
    "- When you create or modify files, use the appropriate write tool — do not describe what you would write without actually writing it.",
    "- If a tool call fails, report the failure honestly and try an alternative approach. Never fabricate tool output.",
    "- End with a substantive summary of what was accomplished, not just a status message (internal verification steps use their own OK/FAIL reply format instead).",
  ];

  if (opts.hasReadOnlyConstraint) {
    lines.push(
      "- IMPORTANT: This task has explicit read-only constraints. Do NOT create, modify, or delete files. Deliver all results as direct text output.",
    );
  }

  if (opts.explicitOutputExtensions.length > 0) {
    const exts = opts.explicitOutputExtensions.join(", ");
    lines.push(
      `- This task requests output in ${exts} format. Use the appropriate write tool and confirm the file was created successfully.`,
    );
  }

  if (opts.likelyRequiresExecution && !opts.hasReadOnlyConstraint) {
    lines.push(
      "- This task likely expects command execution. Use run_command to execute commands rather than describing what commands to run.",
    );
  }

  return lines.join("\n");
}

/**
 * Detects whether the prompt contains an explicit read-only constraint
 * (e.g. "do not edit files", "this is read-only", "without editing").
 * When true, artifact and execution requirements are suppressed because
 * the task should produce text output only, not file artifacts.
 *
 * "read-only" alone is NOT matched — it must appear as a constraint declaration
 * (e.g. "this is read-only", "read-only review", "work in read-only mode"), not
 * as an attribute of a deliverable ("add a read-only mode toggle") or a subject
 * to fix (e.g. "fix the read-only permission", "database is in read-only mode, fix it").
 */
export function detectReadOnlyConstraint(prompt: string): boolean {
  const lower = String(prompt || "").toLowerCase();

  // A boundary such as "do not access any other files" protects inputs and
  // unrelated workspace content; it does not prohibit an output that the
  // same request explicitly asks us to create. Keep those scoped constraints
  // from disabling the mutation tool needed for the requested deliverable.
  const hasScopedOtherFileRestriction =
    /\b(?:do\s+not|don'?t|must\s+not|should\s+not|never)\b[^.!?\n]{0,180}\b(?:any\s+other|other)\s+(?:files?|directories|folders?|paths?)\b/.test(
      lower,
    );
  const withoutNegatedClauses = lower.replace(
    /\b(?:do\s+not|don'?t|must\s+not|should\s+not|never)\b[^.!?\n]*/g,
    " ",
  );
  const explicitlyRequestsFileOutput =
    /\b(?:create|write|edit|modify|generate|produce|save|export|build|make)\b[^.!?\n]{0,140}\b(?:files?|reports?|documents?|spreadsheets?|workbooks?|artifacts?|\.xlsx|\.docx|\.pdf|\.md|\.csv)\b/.test(
      withoutNegatedClauses,
    );
  if (hasScopedOtherFileRestriction && explicitlyRequestsFileOutput) return false;

  // Explicit "do not" / "don't" constraints are global only when they are not
  // narrowed to a scope: "don't edit files under vendor/", "do not make
  // changes to the database schema", "no file changes beyond package.json" and
  // "without modifying its public signature" all permit the requested change.
  const wholeWorkspace =
    String.raw`(?:(?:this|the|your|my|our|any)\s+)?(?:repo(?:sitory)?|workspace|project|` +
    String.raw`code(?:base)?|working\s+(?:tree|copy|directory)|file\s*system|disk)\b`;
  const unscoped =
    String.raw`(?!\s+(?:(?:outside|other\s+than|except|besides|beyond|apart\s+from|that|which|` +
    String.raw`from|of|matching|named|like|for)\b|(?:in|under|inside|within|to|on)\b` +
    String.raw`(?!\s+${wholeWorkspace})))`;
  const hasExplicitConstraint =
    new RegExp(
      String.raw`\b(?:do\s+not|don'?t)\s+(?:edit|create|modify|write)\s+(?:any\s+)?files?\b${unscoped}`,
    ).test(lower) ||
    new RegExp(String.raw`\bdo\s+not\s+make\s+(?:any\s+)?changes\b${unscoped}`).test(lower) ||
    new RegExp(String.raw`\bno\s+file\s+changes\b${unscoped}`).test(lower) ||
    new RegExp(
      String.raw`\bwithout\s+(?:editing|modifying|creating)(?:\s*(?:[.!?;,\n]|$)|\s+anything\b(?!\s+else\b)|\s+(?:any\s+|the\s+)?files?\b${unscoped}|\s+${wholeWorkspace})`,
    ).test(lower) ||
    /\bsituational\s+awareness\s+(?:only|mode)\b/.test(lower);
  if (hasExplicitConstraint) return true;

  // A coordinated prohibition such as "do not create, write, edit, move, or
  // delete any file or directory" is still a global read-only constraint.
  // The simpler pattern above only handles one verb directly before "files".
  // Scoped ("any other files") or partial ("do not delete any files")
  // prohibitions attached to a requested change are not read-only.
  const hasNegatedFileOperationList =
    /\b(?:do\s+not|don'?t|must\s+not|should\s+not|never)\s+(?:create|write|edit|modify|move|delete|remove|rename|access|touch)(?:(?:\s*,\s*(?:(?:and|or)\s+)?|\s+(?:and|or)\s+)(?:create|write|edit|modify|move|delete|remove|rename|access|touch))*\s+(?:any\s+)?(?:files?|directories|folders?|paths?)\b/.test(
      lower,
    );
  const requestsChangeOutsideProhibition =
    /\b(?:fix|update|edit|modify|create|write|add|append|change|refactor|rename|move|delete|remove|save|replace|set|implement|generate|produce|export)\b/.test(
      withoutNegatedClauses,
    );
  if (hasNegatedFileOperationList && !requestsChangeOutsideProhibition) return true;

  // A mixed prohibition such as "do not contact anyone, reserve, pay, or
  // create files" lists non-file actions first, so the file-only verb list
  // above cannot see its final "create files" item.
  const hasMixedProhibitionEndingInFileCreation = new RegExp(
    String.raw`\b(?:do\s+not|don'?t|must\s+not|should\s+not|never)\s+` +
      String.raw`(?:(?!\b(?:but|instead|then|unless|except|rather)\b)[^.!?;\n]){1,160}?(?:,\s*|\s)(?:(?:and|or|nor)\s+)?` +
      String.raw`(?:create|write|edit|modify|save|generate|produce)\s+(?:any\s+)?(?:new\s+)?(?:files?|documents?|artifacts?)\b${unscoped}`,
  ).test(lower);
  if (hasMixedProhibitionEndingInFileCreation && !requestsChangeOutsideProhibition) return true;

  // "Keep it in chat" / "chat only" confines the deliverable to the reply
  // when nothing else in the request asks for a file or a change.
  const hasChatOnlyBoundary =
    /\b(?:keep|leave)\s+(?:it|this|everything|all\s+of\s+it|the\s+(?:answer|response|reply|plan|results?|output|comparison|summary|analysis|recommendation))\s+(?:all\s+)?in\s+(?:the\s+|this\s+)?chat\b/.test(
      lower,
    ) ||
    /\b(?:in|within)\s+(?:the\s+|this\s+)?chat\s+only\b|\bonly\s+in\s+(?:the\s+|this\s+)?chat\b|\bchat[- ]only\b/.test(
      lower,
    );
  if (hasChatOnlyBoundary && !explicitlyRequestsFileOutput && !requestsChangeOutsideProhibition) {
    return true;
  }

  // "read-only" counts only when it frames the task itself ("this task is
  // read-only", "read-only review: ...", "stay read-only", "Read-only."). As an
  // attribute of something to build ("a read-only mode toggle", "make the field
  // read-only", "a read-only Postgres user") it describes the deliverable.
  // It must also not be the subject of a fix ("fix the read-only issue").
  const readOnly = String.raw`read[- ]only\b`;
  const readOnlyTaskFraming =
    new RegExp(
      String.raw`\b(?:this|everything|task|request|job|session|review|analysis|audit|investigation|inspection|exploration|pass|assessment)\s+(?:is|should\s+be|must\s+be|will\s+be|stays?|remains?)\s+(?:strictly\s+|purely\s+|completely\s+|entirely\s+)?${readOnly}`,
    ).test(lower) ||
    new RegExp(
      String.raw`(?:^|[.!?;:\n]\s*|\b(?:please|and|but|you|we)\s+(?:(?:must|should|will|need\s+to)\s+)?)(?:stay|remain|work|operate|proceed|act)\s+(?:strictly\s+|purely\s+)?(?:in\s+)?${readOnly}`,
    ).test(lower) ||
    new RegExp(
      String.raw`\b${readOnly}\s+(?:task|request|review|analysis|audit|investigation|inspection|exploration|pass|assessment|session)\b`,
    ).test(lower) ||
    new RegExp(String.raw`\b(?:you(?:'re|\s+are)|we(?:'re|\s+are))\s+(?:in\s+)?${readOnly}`).test(
      lower,
    ) ||
    new RegExp(String.raw`(?:^|[.!?\n]\s*)${readOnly}(?:\s+only\b)?\s*(?:[:.,!;\-–—]|$)`).test(
      lower,
    );
  if (readOnlyTaskFraming) {
    const isSubjectToFix =
      /\b(?:fix|repair|resolve|debug|troubleshoot|diagnose|investigate|restore|change|update|remove|disable|toggle|switch)\b[^.!?\n]{0,40}\bread[- ]only\b/.test(
        lower,
      ) ||
      /\bread[- ]only\b[^.!?\n]{0,40}\b(?:fix|repair|resolve|broken|issue|problem|bug|error|fail)\b/.test(
        lower,
      );
    if (!isSubjectToFix) return true;
  }

  return false;
}

export function buildCompletionContract(opts: {
  taskTitle: string;
  taskPrompt: string;
  requiresDirectAnswer: boolean;
  requiresDecisionSignal: boolean;
  isWatchSkipRecommendationTask: boolean;
}): CompletionContract {
  const fullPrompt = `${opts.taskTitle}\n${normalizePromptForContracts(opts.taskPrompt)}`;
  const hasReadOnlyConstraint = detectReadOnlyConstraint(fullPrompt);
  const allowsOperationalStatus = promptAllowsOperationalStatus(opts.taskTitle, opts.taskPrompt);

  const requiresExecutionEvidence = shouldRequireExecutionEvidence(opts.taskTitle, opts.taskPrompt);
  const requiresCanvasArtifact = promptRequestsCanvasArtifactOutput(
    opts.taskTitle,
    opts.taskPrompt,
  );
  // Use explicit-only extraction: only picks up extensions from output-intent
  // patterns (e.g. "save as .pdf"), not from input references (e.g. "read PRIORITIES.md").
  const requiredArtifactExtensions = hasReadOnlyConstraint
    ? []
    : extractExplicitOutputExtensions(opts.taskTitle, opts.taskPrompt);
  const requiresArtifactEvidence =
    !hasReadOnlyConstraint &&
    (promptRequestsArtifactOutput(opts.taskTitle, opts.taskPrompt) ||
      requiresCanvasArtifact ||
      requiredArtifactExtensions.length > 0) &&
    !opts.isWatchSkipRecommendationTask;
  const prompt = `${opts.taskTitle}\n${normalizePromptForContracts(opts.taskPrompt)}`.toLowerCase();
  const hasExplicitCanvasCue = /\b(canvas|in-app canvas)\b/.test(prompt);
  const shouldTreatAsCanvasArtifact =
    requiresCanvasArtifact &&
    !opts.isWatchSkipRecommendationTask &&
    (hasExplicitCanvasCue || requiredArtifactExtensions.length === 0);
  const artifactKind: CompletionContract["artifactKind"] = hasReadOnlyConstraint
    ? "none"
    : shouldTreatAsCanvasArtifact
      ? "canvas"
      : requiresArtifactEvidence
        ? "file"
        : "none";

  // Only require canvas_push evidence when the prompt explicitly mentions "canvas".
  // Tasks detected as canvas via promptIsMultiFileWebAppCreation (e.g. "Create a website")
  // set artifactKind="canvas" to guide the agent but do NOT hard-require canvas_push —
  // the agent may serve locally, open a URL, or otherwise satisfy the intent without canvas_push.
  const requiredSuccessfulTools =
    requiresCanvasArtifact && hasExplicitCanvasCue && !opts.isWatchSkipRecommendationTask
      ? ["write_file", "canvas_push"]
      : [];
  const hasStrongReviewCue = /\b(review|evaluate|assess|verify|read|audit)\b/.test(prompt);
  const hasWeakCheckCue = /\bcheck\b/.test(prompt);
  const hasEvidenceContractCue =
    /\b(verification evidence|verification complete|review-backed|evidence|exit codes?|commands? completed|exact command results|pass\/fail|passed or failed|final .*verdict|build-health verdict|overall status|blocks release)\b/.test(
      prompt,
    );
  const hasJudgmentCue =
    /\b(let me know|tell me|advise|recommend|whether|should i|worth|waste of)\b/.test(prompt);
  const hasEvidenceWorkCue =
    /\b(transcribe|summarize|review|evaluate|assess|audit|analy[sz]e|watch|read)\b/.test(prompt);
  const hasSequencingCue = /\b(and then|then|after|based on)\b/.test(prompt);
  const requiresVerificationEvidence =
    requiresExecutionEvidence &&
    (hasStrongReviewCue ||
      hasEvidenceContractCue ||
      (hasWeakCheckCue && hasEvidenceContractCue) ||
      (hasJudgmentCue && hasEvidenceWorkCue && hasSequencingCue));

  return {
    requiresExecutionEvidence,
    requiresDirectAnswer: opts.requiresDirectAnswer,
    requiresDecisionSignal: opts.requiresDecisionSignal && !allowsOperationalStatus,
    allowsOperationalStatus,
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
    /\b(?:read[- ]?back|report|output|values?|figures?|counts?|totals?)\b[\s\S]{0,80}\b(?:match(?:ed|es)?|mismatch(?:ed)?|do not match|does not match|did not match|didn't match|failed to match)\b/.test(
      normalized,
    ) ||
    /\byes\b/.test(normalized) ||
    /\bno\b/.test(normalized) ||
    /\b(?:includes?|contains?|has)\b[^.!?\n]{0,60}\bheaders?(?:\s+row)?\b/.test(normalized) ||
    /\b(?:there is|there are|is|are|was|were)\s+(?:(?:a|the|one)\s+)?headers?(?:\s+row)?\b/.test(
      normalized,
    ) ||
    /\bi recommend\b/.test(normalized) ||
    /\byou should\b/.test(normalized) ||
    /\bshould (?:you|i|we)\b/.test(normalized) ||
    /\bgo with\b/.test(normalized) ||
    /\bchoose\b/.test(normalized) ||
    /\bworth(?:\s+it)?\b/.test(normalized) ||
    /\bnot worth\b/.test(normalized) ||
    /\bskip\b/.test(normalized) ||
    /\b(?:result|verdict|status)\s*:\s*\*{0,2}`?(?:green|degraded|broken|passed|failed)`?\*{0,2}\b/.test(
      normalized,
    ) ||
    /\bfinal\s+build-health\s+verdict\b/.test(normalized)
  );
}

export function responseHasVerificationSignal(text: string): boolean {
  const normalized = String(text || "").toLowerCase();
  if (!normalized.trim()) return false;
  return (
    responseHasExecutionReportEvidenceSignal(normalized) ||
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

function responseHasConcreteResultSignal(text: string): boolean {
  const normalized = String(text || "").toLowerCase();
  if (!normalized.trim()) return false;
  return (
    /\b(?:values?|figures?|counts?|totals?)\s+(?:match(?:ed|es)?|verified|confirmed)\b/.test(
      normalized,
    ) ||
    /\b\d[\d,]*(?:\.\d+)?\s+(?:unique\s+)?(?:attendees?|tickets?|items?|records?|rows?|entries|files?|pages?|cities?|errors?|warnings?|tests?|words?|characters?|bytes?)\b/.test(
      normalized,
    ) ||
    /\b(?:attendees?|tickets?|items?|records?|rows?|entries|files?|pages?|cities?|errors?|warnings?|tests?|words?|characters?|bytes?)\s*:\s*\d[\d,]*(?:\.\d+)?\b/.test(
      normalized,
    )
  );
}

export function responseHasExecutionReportEvidenceSignal(text: string): boolean {
  const normalized = String(text || "").toLowerCase();
  if (!normalized.trim()) return false;

  const hasCommandOrApiEvidence =
    /(?:^|[\n`*-]\s*)(?:cargo|go|make|cmake|xcodebuild|swift|pytest|python -m pytest|gradle|mvn|dotnet)\s+[\w:./-]+/m.test(
      normalized,
    ) ||
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?[\w:-]+\b/.test(normalized) ||
    /\bexit(?:\s+code)?\s*`?\d+`?\b/.test(normalized) ||
    /\bhttp\s*`?\d{3}`?\b/.test(normalized) ||
    /\b(?:get|post|put|patch|delete)\s+https?:\/\//.test(normalized);
  const hasPassFailEvidence =
    /\b(?:passed|failed|skipped|success|failure)\b/.test(normalized) ||
    /\bpass\/fail\b/.test(normalized) ||
    /\bpassed or failed\b/.test(normalized);
  const hasVerdict =
    /\b(?:final\s+)?build-health verdict\b/.test(normalized) ||
    /\boverall status\s*:\s*(?:`?green`?|`?degraded`?|`?broken`?)/.test(normalized) ||
    /\bbuild health status\s*:\s*`?(?:green|degraded|broken)`?/.test(normalized) ||
    /\bresult\s*:\s*\*{0,2}(?:green|degraded|broken)\*{0,2}\b/.test(normalized) ||
    /\bblocks release\s*:\s*(?:yes|no)\b/.test(normalized) ||
    /\bfinal verdict\b/.test(normalized);

  return hasCommandOrApiEvidence && hasPassFailEvidence && hasVerdict;
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

export function responseHasReviewReportEvidenceSignal(text: string): boolean {
  const normalized = String(text || "").toLowerCase();
  if (!normalized.trim()) return false;

  const hasAffectedDocumentation =
    /\b(?:affected\s+(?:documentation|docs?)|docs?\s+(?:that\s+need|to\s+update)|readme\.md|docs\/|changelog\.md|agents\.md|package\.json)\b/.test(
      normalized,
    );
  const hasSourceOfTruth =
    /\b(?:source(?:\s+of\s+truth)?|source-of-truth|code\/config|current\s+(?:repo\s+)?(?:behavior|state)|fresh\s+evidence|repo\s+evidence)\b/.test(
      normalized,
    );
  const hasMismatchOrFinding =
    /\b(?:drift|mismatch|stale|outdated|missing|under-?documented|not\s+documented|finding|gap)\b/.test(
      normalized,
    );
  const hasSuggestedDocChange =
    /\b(?:suggested\s+(?:documentation|doc)\s+(?:change|update)|documentation\s+change|doc\s+update|update\s+(?:the\s+)?docs?|add\s+(?:to\s+)?docs?)\b/.test(
      normalized,
    );
  const hasPriority = /\b(?:priority|must\s+fix\s+before\s+release|should\s+fix|optional)\b/.test(
    normalized,
  );
  const hasReviewFraming =
    /\b(?:documentation\s+drift|drift\s+(?:check|assessment|report)|review-backed|review\s+report|inspected|reviewed|checked)\b/.test(
      normalized,
    );

  const matchedFieldCount = [
    hasAffectedDocumentation,
    hasSourceOfTruth,
    hasMismatchOrFinding,
    hasSuggestedDocChange,
    hasPriority,
    hasReviewFraming,
  ].filter(Boolean).length;

  return matchedFieldCount >= 4 && hasMismatchOrFinding && hasSuggestedDocChange && hasPriority;
}

/**
 * Returns true when a successful call of this tool observed something about the
 * task (read, searched, fetched, browsed, queried, or executed), based on the
 * tool's runtime semantics rather than a fixed list of names. Writes, artifact
 * generators, orchestration, and reads of the agent's own memory or checklist
 * are not evidence.
 */
export function isVerificationEvidenceTool(toolName: string): boolean {
  const canonical = canonicalizeToolName(
    String(toolName || "")
      .trim()
      .toLowerCase(),
  );
  if (!canonical) return false;
  if (VERIFICATION_TOOL_EVIDENCE.has(canonical)) return true;
  if (
    isFileMutationToolName(canonical) ||
    isArtifactGenerationToolName(canonical) ||
    isCanonicalWriteToolName(canonical)
  ) {
    return false;
  }
  if (CONTENT_GATHERING_TOOL_REGEX.test(canonical)) return true;
  if (SELF_STATE_TOOL_REGEX.test(canonical)) return false;
  const runtime = getDefaultRuntimeToolMetadata(canonical);
  if (runtime.capabilityTags.some((tag) => NON_EVIDENCE_TOOL_LANES.has(tag))) return false;
  return (
    READ_GROUP_TOOLS.has(canonical) ||
    runtime.readOnly ||
    EVIDENCE_RESULT_KINDS.has(runtime.resultKind) ||
    runtime.capabilityTags.includes("integration")
  );
}

export function hasVerificationToolEvidence(
  toolResultMemory: Array<{ tool: string }> | undefined,
): boolean {
  if (!Array.isArray(toolResultMemory) || toolResultMemory.length === 0) return false;
  return toolResultMemory.some((entry) => isVerificationEvidenceTool(entry.tool));
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
  const hasConcreteResultSignal = responseHasConcreteResultSignal(normalized);

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
    !hasConcreteResultSignal &&
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

  const nonEmptyCandidates = candidates
    .filter((candidate): candidate is string => typeof candidate === "string")
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  const preferred = nonEmptyCandidates[0] || "";
  if (preferred && responseLooksOperationalOnly(preferred)) {
    const evidencedAnswer = nonEmptyCandidates
      .slice(1)
      .find(
        (candidate) =>
          !responseLooksOperationalOnly(candidate) &&
          (responseHasVerificationSignal(candidate) ||
            responseHasReasonedConclusionSignal(candidate) ||
            responseHasConcreteResultSignal(candidate)),
      );
    if (evidencedAnswer) return evidencedAnswer;
  }

  return preferred;
}

export function shouldPreserveExistingDeliverableForRecovery(opts: {
  existingDeliverable: string | null;
  recoveryText: string;
  minResultSummaryLength: number;
  contract?: CompletionContract;
}): boolean {
  const existing = String(opts.existingDeliverable || "").trim();
  const recovery = String(opts.recoveryText || "").trim();
  if (!existing || !recovery) return false;
  if (existing.length < opts.minResultSummaryLength) return false;
  if (recovery.length > existing.length * 1.15) return false;

  const existingPassesContract = opts.contract
    ? responseDirectlyAddressesPrompt({
        text: existing,
        contract: opts.contract,
        minResultSummaryLength: opts.minResultSummaryLength,
      })
    : true;
  const recoveryPassesContract = opts.contract
    ? responseDirectlyAddressesPrompt({
        text: recovery,
        contract: opts.contract,
        minResultSummaryLength: opts.minResultSummaryLength,
      })
    : false;
  const existingHasBriefSignals =
    responseHasVerificationSignal(existing) ||
    responseHasReasonedConclusionSignal(existing) ||
    /\b(top\s+3|suggested work|watchlist|health signals|current repo state|priorit(?:y|ies)|overall status|findings|summary|recommendation|verification evidence|commands completed|exact command results|blocks release)\b/i.test(
      existing,
    );
  const existingLooksLikeDeliverable =
    existingPassesContract && (existingHasBriefSignals || !responseLooksOperationalOnly(existing));
  if (!existingLooksLikeDeliverable) return false;

  const recoveryHasDeliverableSignals =
    responseHasVerificationSignal(recovery) || responseHasReasonedConclusionSignal(recovery);
  if (
    recoveryPassesContract &&
    !responseLooksOperationalOnly(recovery) &&
    (recoveryHasDeliverableSignals || recovery.length >= existing.length * 0.75)
  ) {
    return false;
  }

  const recoveryLooksLikeNarrowStatus =
    responseLooksOperationalOnly(recovery) ||
    /\b(alternative|recovery|fallback|retry|succeeded via|saved to scratchpad|captured the requested)\b/i.test(
      recovery,
    );
  return recoveryLooksLikeNarrowStatus && !recoveryHasDeliverableSignals;
}

export function responseDirectlyAddressesPrompt(opts: {
  text: string;
  contract: CompletionContract;
  minResultSummaryLength: number;
}): boolean {
  const normalized = String(opts.text || "").trim();
  if (!normalized) return false;
  if (!opts.contract.requiresDirectAnswer) return true;
  if (responseLooksOperationalOnly(normalized) && !opts.contract.allowsOperationalStatus) {
    return false;
  }
  if (opts.contract.requiresDecisionSignal && !responseHasDecisionSignal(normalized)) return false;
  const needsDetailedAnswer =
    !opts.contract.allowsOperationalStatus &&
    (opts.contract.requiresExecutionEvidence || opts.contract.requiresDecisionSignal);
  if (needsDetailedAnswer && normalized.length < opts.minResultSummaryLength) return false;
  return true;
}

export function fallbackContainsDirectAnswer(opts: {
  contract: CompletionContract;
  lastAssistantText: string | null;
  lastNonVerificationOutput: string | null;
  lastAssistantOutput: string | null;
  buildResultSummary?: () => string | undefined;
  minResultSummaryLength: number;
}): boolean {
  const fallbackCandidates = [
    opts.lastAssistantText,
    opts.lastNonVerificationOutput,
    opts.lastAssistantOutput,
    opts.buildResultSummary?.(),
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
  /** Successful, verified mutations may not be registered by the file tracker (for example, shell writes). */
  mutationFiles?: string[];
}): boolean {
  if (!opts.contract.requiresArtifactEvidence) return true;
  const trackedFiles =
    opts.createdFiles.length > 0
      ? opts.createdFiles
      : (opts.modifiedFiles || []).map((file) => String(file));
  const evidenceFiles = [...trackedFiles, ...(opts.mutationFiles || [])];
  if (evidenceFiles.length === 0) return false;
  if (!opts.contract.requiredArtifactExtensions.length) return true;

  const lowered = evidenceFiles.map((file) => String(file).toLowerCase());
  return opts.contract.requiredArtifactExtensions.some((ext: string) =>
    lowered.some((file: string) => file.endsWith(ext)),
  );
}

/**
 * A direct conclusion ("Yes. The Pro plan includes SSO…", "3 unique attendees")
 * rather than a status line. Only meaningful together with tool evidence.
 */
function responseStatesConclusion(text: string): boolean {
  const normalized = String(text || "").trim();
  if (!normalized || responseLooksOperationalOnly(normalized)) return false;
  return responseHasDecisionSignal(normalized) || responseHasConcreteResultSignal(normalized);
}

export function hasVerificationEvidence(opts: {
  bestCandidate: string;
  planSteps?: Array<{ status?: string; description?: string }>;
  toolResultMemory?: Array<{ tool: string }>;
  successfulTools?: string[];
}): boolean {
  const toolNames = [
    ...(opts.toolResultMemory || []).map((entry) => entry.tool),
    ...(opts.successfulTools || []),
  ].map((tool) =>
    canonicalizeToolName(
      String(tool || "")
        .trim()
        .toLowerCase(),
    ),
  );
  // Verification needs something the run actually observed. Wording alone
  // (including a well-formed command report) is easy to produce without work.
  if (!toolNames.some((tool) => isVerificationEvidenceTool(tool))) return false;

  // Reported command results or API responses count only when a tool that can
  // produce them ran; reading package.json does not show that `npm test` passed.
  if (
    responseHasExecutionReportEvidenceSignal(opts.bestCandidate) &&
    !toolNames.some((tool) => COMMAND_OR_API_EVIDENCE_TOOLS.has(tool))
  ) {
    return false;
  }

  const hasCompletedReviewStep = !!opts.planSteps?.some(
    (step) =>
      step.status === "completed" &&
      (isVerificationStepDescription(step.description || "") ||
        COMPLETED_REVIEW_STEP_REGEX.test(step.description || "")),
  );
  return (
    hasCompletedReviewStep ||
    responseHasVerificationSignal(opts.bestCandidate) ||
    responseHasReasonedConclusionSignal(opts.bestCandidate) ||
    responseHasReviewReportEvidenceSignal(opts.bestCandidate) ||
    responseStatesConclusion(opts.bestCandidate)
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
    // A substantive inline answer may stand in for an inferred deliverable
    // ("write a summary report"), but never for an explicitly requested output
    // path or format: a claim to have written it is not the file.
    const explicitOutputRequested = opts.contract.requiredArtifactExtensions.length > 0;
    const hasSubstantiveText = opts.bestCandidate.trim().length >= 50;
    if (explicitOutputRequested || !(hasSubstantiveText && opts.createdFiles.length === 0)) {
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
