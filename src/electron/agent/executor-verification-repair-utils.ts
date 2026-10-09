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
    `- Do not start unrelated work and do not ask the user for input.\n` +
    `- End with the complete final answer for the user that matches the corrected deliverable, not only a list of changes. Do not claim a requirement is met unless the output now meets it.`
  );
}

/** Step context for the re-check step that follows a repair. */
export function buildVerificationRecheckStepContext(findings: string): string {
  return (
    `\n\nISSUES REPORTED BY THE FIRST CHECK (now repaired):\n${findings}\n` +
    `- Confirm each of these is resolved in the actual deliverable, then apply the normal checks.`
  );
}
