/**
 * Verification repair pass: when the final verification step of a plan answers
 * FAIL_BLOCKING with concrete, fixable findings, the executor appends one repair
 * step (which revises the deliverable from the findings) and one re-check step.
 * A task gets at most one repair pass; a second blocking verdict finishes the
 * task as partial success with the remaining issues.
 *
 * This module holds the pure decisions and texts; the executor wires them into
 * its plan-revision recovery path.
 */

import { parseVerificationProtocolOutcome } from "./executor-completion-utils";

/** Repair passes allowed per task. */
export const MAX_VERIFICATION_REPAIR_PASSES = 1;

/** Model turns a repair step plus its re-check needs to be worth starting. */
export const MIN_TURNS_FOR_VERIFICATION_REPAIR = 6;

const MAX_FINDINGS_CHARS = 1500;

// Starts with "Repair", which marks the step as remediation rather than a
// verification checkpoint, and names no file so the step contract does not
// demand a particular write tool: the deliverable may be a file or the answer.
export const VERIFICATION_REPAIR_STEP_DESCRIPTION =
  "Repair the delivered work so it resolves the blocking issues found by the final check.";

export const VERIFICATION_RECHECK_STEP_DESCRIPTION =
  "Verify the repaired deliverable against the task requirements and the issues the final check reported.";

export function isVerificationRepairStepDescription(description: unknown): boolean {
  return String(description || "").trim() === VERIFICATION_REPAIR_STEP_DESCRIPTION;
}

export function isVerificationRecheckStepDescription(description: unknown): boolean {
  return String(description || "").trim() === VERIFICATION_RECHECK_STEP_DESCRIPTION;
}

const OFFICE_ARTIFACT_PATTERN = /\.(?:xlsx|xlsm|docx|pptx|pdf)\b|\b(?:xlsx|docx|pptx|pdf)\b/i;

/** True when any text names an Office workbook, document, deck, or a PDF. */
export function mentionsOfficeArtifact(texts: Array<string | null | undefined>): boolean {
  return texts.some((text) => OFFICE_ARTIFACT_PATTERN.test(String(text || "")));
}

/**
 * Verification guidance for Office and PDF deliverables. Hand-written zip/XML
 * scripts misread these files (inline strings read as empty, built-in number
 * formats read as General, relationship targets joined into bad paths) and
 * then fail a correct deliverable.
 */
export function buildOfficeArtifactVerificationGuidance(): string {
  return (
    `- To check .xlsx, .xlsm, .docx, .pptx, or .pdf files, read them with parse_document. It reports cell values with their stored type (text, number, date), formulas with saved results, number formats, and PDF page counts; treat its output as the source of truth.\n` +
    `- Do not unzip the file or parse its XML with a custom script. If another script's result disagrees with parse_document, trust parse_document and quote it as evidence.\n`
  );
}

// Failures that only the user or an outside system can resolve: missing input,
// approvals, sign-in, or a source the task cannot reach. A repair pass cannot fix them.
const NEEDS_USER_OR_EXTERNAL_ACCESS_PATTERN = new RegExp(
  [
    String.raw`\bpending_user_action\b`,
    String.raw`\b(?:the )?user (?:must|needs? to|should|has to) (?:provide|confirm|approve|choose|decide|supply|sign|grant|connect|log)`,
    String.raw`\bask(?:ing)? the user\b`,
    String.raw`\bneeds? (?:your|the user'?s) (?:input|approval|confirmation|decision|credentials?)\b`,
    String.raw`\brequires? (?:user |your )?(?:input|approval|confirmation|sign[- ]?in|log ?in|credentials?|an? api key|access token)\b`,
    String.raw`\b(?:access|permission) (?:was )?denied\b`,
    String.raw`\b(?:sign[- ]?in|log ?in|authentication) (?:is )?required\b`,
    String.raw`\b(?:could not|cannot|can't|unable to|failed to) (?:access|reach|fetch|download|retrieve|connect to)\b`,
    String.raw`\bnot (?:accessible|reachable)\b`,
    String.raw`\b(?:paywall(?:ed)?|captcha|unauthori[sz]ed|forbidden)\b`,
    String.raw`\b(?:401|403|429)\b`,
    String.raw`\brate[- ]limit`,
    String.raw`\boutside (?:the )?workspace\b|\ballowed paths\b|\bblocked by policy\b`,
  ].join("|"),
  "i",
);

/** The verifier's findings without the protocol token or the step-failure prefix. */
export function extractVerificationFindings(text: unknown): string {
  const findings = String(text || "")
    .trim()
    .replace(/^verification failed:\s*/i, "")
    .replace(/^[*_`#>\s]+/, "")
    .replace(/^FAIL_BLOCKING\b[*_`]*[\s:\u2014\u2013-]*/i, "")
    .trim();
  return findings.length > MAX_FINDINGS_CHARS
    ? `${findings.slice(0, MAX_FINDINGS_CHARS - 1).trimEnd()}…`
    : findings;
}

/** True when a verification reply or a recorded step error is a FAIL_BLOCKING verdict. */
export function isBlockingVerificationVerdict(text: unknown): boolean {
  const raw = String(text || "").trim();
  if (parseVerificationProtocolOutcome(raw) === "fail_blocking") return true;
  const withoutPrefix = raw.replace(/^verification failed:\s*/i, "");
  return (
    withoutPrefix !== raw && parseVerificationProtocolOutcome(withoutPrefix) === "fail_blocking"
  );
}

export type VerificationRepairSkipReason =
  | "not_final_verification"
  | "not_blocking_verdict"
  | "recheck_step"
  | "repair_already_used"
  | "prior_repair_in_step"
  | "needs_user_or_external_access"
  | "no_findings"
  | "budget_exhausted";

export type VerificationRepairDecision =
  | { repair: true; findings: string }
  | { repair: false; reason: VerificationRepairSkipReason };

export function decideVerificationRepair(input: {
  /** The verification step's final reply. */
  verdictText: string;
  /** The step failure reason recorded for the verification step. */
  failureReason: string;
  /** The step is the plan's final verification checkpoint. */
  isFinalVerification: boolean;
  /** The step is the re-check a previous repair pass added. */
  isRecheckStep: boolean;
  repairPassesUsed: number;
  /** The step already had an in-place retry that could edit files. */
  priorRepairAttemptInStep: boolean;
  budgetAvailable: boolean;
}): VerificationRepairDecision {
  if (!input.isFinalVerification) return { repair: false, reason: "not_final_verification" };
  const verdictIsBlocking = isBlockingVerificationVerdict(input.verdictText);
  if (!verdictIsBlocking && !isBlockingVerificationVerdict(input.failureReason)) {
    return { repair: false, reason: "not_blocking_verdict" };
  }
  if (input.isRecheckStep) return { repair: false, reason: "recheck_step" };
  if (input.repairPassesUsed >= MAX_VERIFICATION_REPAIR_PASSES) {
    return { repair: false, reason: "repair_already_used" };
  }
  if (input.priorRepairAttemptInStep) return { repair: false, reason: "prior_repair_in_step" };
  const findings = extractVerificationFindings(
    verdictIsBlocking ? input.verdictText : input.failureReason,
  );
  if (findings.length < 8) return { repair: false, reason: "no_findings" };
  if (NEEDS_USER_OR_EXTERNAL_ACCESS_PATTERN.test(findings)) {
    return { repair: false, reason: "needs_user_or_external_access" };
  }
  if (!input.budgetAvailable) return { repair: false, reason: "budget_exhausted" };
  return { repair: true, findings };
}

/** Step context for the repair step. */
export function buildVerificationRepairStepContext(findings: string): string {
  return (
    `\n\nVERIFICATION REPAIR PASS:\n` +
    `- The final check of this task reported these blocking issues:\n${findings}\n` +
    `- Fix only these issues in the delivered work. Revise the existing output in place with the same kind of tool that produced it, and regenerate any exported copy (for example the PDF of an edited document). When the deliverable is the answer in chat, rewrite that answer.\n` +
    `- First confirm each issue against the actual output. For .xlsx, .docx, .pptx, and .pdf files use parse_document; if it shows an issue is not present, leave that part unchanged and state the parse_document evidence.\n` +
    `- When files that must match differ (for example a .docx and its PDF), decide the correct content from the task's facts, fix the source file, then regenerate every other copy from that corrected content so all of them match. Check each file with parse_document afterwards.\n` +
    `- When a fact in the answer has no source link, add the link to the official page already fetched in this task that supports it. Never invent, guess, or construct URLs. If no fetched page supports the fact, reword it as not documented and name the page that was checked instead of keeping the unsupported claim.\n` +
    `- Do not start unrelated work and do not ask the user for input.\n` +
    `- End with the complete final answer for the user that matches the corrected deliverable, not only a list of changes. Link every file the user asked for. Do not claim a requirement is met unless the output now meets it.`
  );
}

/** Step context for the re-check step that follows a repair. */
export function buildVerificationRecheckStepContext(findings: string): string {
  return (
    `\n\nISSUES REPORTED BY THE FIRST CHECK (now repaired):\n${findings}\n` +
    `- Confirm each of these is resolved in the actual deliverable, then apply the normal checks.`
  );
}

// Document formats a user may ask for side by side ("a Word document and a matching PDF").
const DELIVERABLE_FORMAT_PATTERNS: RegExp[] = [
  /\.docx\b|\bdocx\b|\bword\s+(?:document|doc|file|version)\b/i,
  /\.pdf\b|\bpdf\b/i,
  /\.xlsx\b|\bxlsx\b|\bexcel\b|\bspreadsheet\b|\bworkbook\b/i,
  /\.pptx\b|\bpptx\b|\bpowerpoint\b|\bslide\s+deck\b/i,
  /\.html?\b|\bhtml\b|\bweb\s+page\b/i,
  /\.md\b|\bmarkdown\b/i,
];

const MATCHING_OUTPUTS_PATTERN = new RegExp(
  [
    String.raw`\bmatching\b`,
    String.raw`\b(?:that|which|to) match(?:es)?\b`,
    String.raw`\b(?:the )?same (?:content|text|data|figures|numbers|information|document)\b`,
    String.raw`\b(?:identical|corresponding)\b`,
    String.raw`\b(?:pdf|word|docx|html|markdown|printable) (?:version|copy|export|edition)\b`,
    String.raw`\bexport(?:ed)? (?:it |this |that |them )?(?:as|to) (?:an? )?(?:pdf|docx|word|html)\b`,
  ].join("|"),
  "i",
);

const PAIRED_OUTPUT_FILE_PATTERN = /([\w][\w.-]*)\.(docx|pdf|xlsx|pptx|html?|md|odt|rtf)\b/gi;

function hasSameStemOutputPair(names: string[]): boolean {
  const extensionsByStem = new Map<string, Set<string>>();
  for (const name of names) {
    for (const match of String(name || "").matchAll(PAIRED_OUTPUT_FILE_PATTERN)) {
      const stem = match[1].toLowerCase();
      const extensions = extensionsByStem.get(stem) || new Set<string>();
      extensions.add(match[2].toLowerCase());
      extensionsByStem.set(stem, extensions);
    }
  }
  return Array.from(extensionsByStem.values()).some((extensions) => extensions.size >= 2);
}

/**
 * True when the request asks for several outputs that must carry the same
 * content: "a Word document and a matching PDF", "a PDF version of the
 * report", or a pair of files with the same name in two formats.
 */
export function requestsMatchingOutputs(prompt: string, createdFiles: string[] = []): boolean {
  const text = String(prompt || "");
  if (hasSameStemOutputPair([text, ...createdFiles])) return true;
  if (!MATCHING_OUTPUTS_PATTERN.test(text)) return false;
  const formats = DELIVERABLE_FORMAT_PATTERNS.filter((pattern) => pattern.test(text)).length;
  return formats >= 2;
}

const FILE_LINKS_REQUEST_PATTERN = new RegExp(
  [
    String.raw`\b(?:download\s+)?links?\s+(?:to|for)\s+(?:(?:the|both|all|each|every|my|these|those|two|three|four)\s+){0,2}(?:[\w.-]+\s+){0,2}(?:files?|documents?|docs|outputs?|workbooks?|spreadsheets?|decks?|reports?|pdfs?|versions?|copies)\b`,
    String.raw`\blinks?\b[^.\n]{0,60}\.(?:docx|pdf|xlsx|pptx|html?|md|csv|txt|png|jpe?g|svg|zip|mp4)\b`,
  ].join("|"),
  "i",
);

/** True when the request asks for links to the files the task produces. */
export function requestsFileLinks(prompt: string): boolean {
  return FILE_LINKS_REQUEST_PATTERN.test(String(prompt || ""));
}

const SOURCE_LINKS_REQUEST_PATTERN = new RegExp(
  [
    String.raw`\b(?:with|include|including|add|give|provide|show|list|plus)\s+(?:(?:me|direct|official|source|working|relevant|the|their|all|clickable|inline|supporting)\s+){0,3}(?:links?|urls?|sources?|citations?|references?)\b`,
    String.raw`\bcit(?:e|ing)\b`,
    String.raw`\b(?:linked|cited)\s+(?:sources?|answer|comparison|summary|table)\b`,
    String.raw`\bsource\s+links?\b`,
    String.raw`\bofficial\s+(?:documentation|docs)\b`,
  ].join("|"),
  "i",
);

const RESEARCH_REQUEST_PATTERN =
  /\b(?:look(?:ing)?\s+up|research|compare|comparison|versus|vs\.?|documentation|docs|official|investigate|survey|latest|pricing|licen[cs]ing)\b/i;

/** True when the request asks for the answer's facts to come with links or citations. */
export function requestsSourceLinks(prompt: string): boolean {
  const text = String(prompt || "");
  if (requestsFileLinks(text) && !/\bsources?\b|\bcit(?:e|ing|ations?)\b/i.test(text)) {
    return false;
  }
  return SOURCE_LINKS_REQUEST_PATTERN.test(text);
}

/**
 * A research or comparison request that explicitly asks for links or sources.
 * Such answers get a final check on their links even when the plan omits one.
 */
export function requestsSourcedResearchAnswer(prompt: string): boolean {
  const text = String(prompt || "");
  return requestsSourceLinks(text) && RESEARCH_REQUEST_PATTERN.test(text);
}

/** Final check added to sourced research plans that have none. */
export const SOURCED_ANSWER_VERIFICATION_STEP_DESCRIPTION =
  "Verify the final answer covers every requested item and that each sourced fact in it carries a direct link to an official source fetched in this task.";

/**
 * Severity rules for a verification step. WARN_NON_BLOCKING stays for optional
 * or cosmetic issues; a missed explicit requirement is FAIL_BLOCKING so the
 * repair pass can act on it.
 */
export function buildVerificationSeverityGuidance(input: {
  prompt: string;
  createdFiles?: string[];
}): string {
  const prompt = String(input.prompt || "");
  const lines = [
    `- Severity: answer FAIL_BLOCKING when the deliverable misses, contradicts, or leaves out an explicit requirement of the request. Use WARN_NON_BLOCKING only for optional or cosmetic issues (wording, styling, layout polish) that leave every explicit requirement met.`,
  ];
  if (requestsMatchingOutputs(prompt, input.createdFiles || [])) {
    lines.push(
      `- Matching outputs: the request asks for outputs that must carry the same content (for example a document and its PDF). Compare them section by section. Any difference between them in facts, figures, names, dates, or sections is FAIL_BLOCKING, not a warning; name the file and section of each difference.`,
    );
  }
  if (requestsFileLinks(prompt)) {
    lines.push(
      `- Requested links: the user asked for links to the files. Every requested file must be linked in the final answer; a requested file the answer does not link is FAIL_BLOCKING.`,
    );
  }
  if (requestsSourceLinks(prompt)) {
    lines.push(
      `- Sourced facts: the user asked for links or sources. Every table cell or bullet that states a source-specific fact needs a direct link, or a numbered citation that maps to the answer's source list. A factual cell or bullet with neither is FAIL_BLOCKING; name its row and column. A cell that only says a detail is not specified or not documented may rely on the row's link, but it must name the page that was checked.`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export interface UnlinkedSourceCell {
  row: string;
  column: string;
}

const TABLE_SEPARATOR_PATTERN = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
// A Markdown or bare URL link, a numbered citation such as [1] or [^2], or a source marker.
const CELL_SOURCE_PATTERN =
  /\]\(\s*<?https?:\/\/|<https?:\/\/|\bhttps?:\/\/\S+|\[\^?\d+(?:\s*[,–-]\s*\d+)*\]|【\d+(?:†[^】]*)?】/i;
// Cells that report a gap instead of stating a fact.
const GAP_STATEMENT_PATTERN =
  /\b(?:not\s+(?:specified|documented|stated|listed|mentioned|published|found|verified|confirmed|available|disclosed)|unverified|undocumented|unspecified|unknown|no\s+(?:official\s+)?(?:documentation|details?|information|data)|could\s+not\s+be\s+(?:verified|confirmed|read)|n\/a)\b/i;
const SOURCE_COLUMN_HEADER_PATTERN =
  /^(?:official\s+)?(?:sources?|links?|references?|citations?|docs?|documentation)$/i;

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|\s*$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
}

function plainCellText(cell: string): string {
  return cell
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Cells of a sourced Markdown table that state a substantive fact with no link
 * or citation. Only tables that already cite sources in some cells are checked,
 * so a plain summary table without links is left to the verifier. A row whose
 * source column carries a link counts as sourced; cells that report a gap
 * ("not documented") and short values ("Yes", "Free") need no link.
 */
export function findUnlinkedSourcedTableCells(answer: string): UnlinkedSourceCell[] {
  const lines = String(answer || "").split("\n");
  const unlinked: UnlinkedSourceCell[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    if (!TABLE_SEPARATOR_PATTERN.test(lines[index]) || !lines[index - 1].includes("|")) continue;
    const headers = splitTableRow(lines[index - 1]).map(plainCellText);
    const rows: string[][] = [];
    let cursor = index + 1;
    while (cursor < lines.length && lines[cursor].includes("|") && lines[cursor].trim()) {
      rows.push(splitTableRow(lines[cursor]));
      cursor += 1;
    }
    index = cursor;
    if (rows.length === 0) continue;
    const tableCitesSources = rows.some((cells) =>
      cells.slice(1).some((cell) => CELL_SOURCE_PATTERN.test(cell)),
    );
    if (!tableCitesSources) continue;
    const sourceColumns = headers
      .map((header, column) => (SOURCE_COLUMN_HEADER_PATTERN.test(header) ? column : -1))
      .filter((column) => column > 0);
    for (const cells of rows) {
      if (sourceColumns.some((column) => CELL_SOURCE_PATTERN.test(cells[column] || ""))) continue;
      const rowLabel = plainCellText(cells[0] || "");
      for (let column = 1; column < cells.length; column += 1) {
        const cell = cells[column];
        if (!cell || CELL_SOURCE_PATTERN.test(cell)) continue;
        const text = plainCellText(cell);
        if (text.length < 20 || text.split(" ").length < 3) continue;
        if (GAP_STATEMENT_PATTERN.test(text)) continue;
        unlinked.push({
          row: rowLabel.slice(0, 60) || `row ${rows.indexOf(cells) + 1}`,
          column: (headers[column] || `column ${column + 1}`).slice(0, 60),
        });
      }
    }
  }
  return unlinked;
}

/** Verification finding for the unlinked cells of a sourced answer. */
export function buildUnlinkedSourceCellsFinding(cells: UnlinkedSourceCell[]): string {
  const listed = cells
    .slice(0, 8)
    .map((cell) => `${cell.row} / ${cell.column}`)
    .join("; ");
  const more = cells.length > 8 ? ` and ${cells.length - 8} more` : "";
  return (
    `The answer's table states source-specific facts with no direct link or citation in these cells: ${listed}${more}. ` +
    `Each needs the link to the official page already fetched in this task that supports it, or a rewording that says the detail is not documented on the page checked.`
  );
}

/** Link targets of the Markdown links in a text, without any sandbox: or file:// prefix. */
export function extractMarkdownLinkTargets(text: string): string[] {
  const targets: string[] = [];
  for (const match of String(text || "").matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    let target = match[1];
    try {
      target = decodeURI(target);
    } catch {
      // Keep the raw target when it is not valid URI encoding.
    }
    targets.push(
      target
        .replace(/^sandbox:/i, "")
        .replace(/^file:\/\//i, "")
        .replace(/\\/g, "/"),
    );
  }
  return targets;
}

/** True when the answer links the workspace-relative output path, directly or by an absolute path. */
export function answerLinksOutput(answer: string, relativePath: string): boolean {
  const relative = String(relativePath || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
  if (!relative) return false;
  return extractMarkdownLinkTargets(answer).some((target) => {
    const normalized = target.replace(/^\.\//, "");
    return normalized === relative || normalized.endsWith(`/${relative}`);
  });
}
