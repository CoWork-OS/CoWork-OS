import type {
  ApprovalResponseAction,
  ApprovalType,
  InputRequest,
  PermissionPromptDetails,
  RequestUserInputArgs,
} from "../../shared/types";
import {
  ASSISTANT_APPROVAL_QUESTION_ID,
  RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID,
} from "../../shared/approval-draft-presentation";

// Shared so the needs-you queue can tell approval decisions from ordinary questions.
export { ASSISTANT_APPROVAL_QUESTION_ID };

const ALWAYS_ALLOW_LABEL = "Always allow";

const HIGH_IMPACT_APPROVAL_TYPES = new Set<ApprovalType>([
  "delete_file",
  "delete_multiple",
  "memory_delete",
  "bulk_rename",
  "external_file_access",
  "external_service",
  "data_export",
  "location_access",
  "protected_credential",
  "risk_gate",
  "computer_use",
]);

/** Fits a business scope description (500) plus its id (200), so none is cut in practice. */
const MAX_REVIEW_PERMISSION_LENGTH = 720;
/** Long enough for any realistic script; the rest is reported as omitted, never hidden. */
const MAX_APPROVAL_PREVIEW_LENGTH = 20_000;

/**
 * The exact content an approval covers, kept line for line: a tool supplies it as
 * `approvalPreview: { label, text }` in the approval details.
 */
function buildApprovalPreview(details: Record<string, unknown> | undefined) {
  const raw = details?.approvalPreview;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const { label, text } = raw as Record<string, unknown>;
  if (typeof text !== "string" || !text.trim()) return undefined;
  const content = text.replace(/\r\n?/g, "\n");
  const omittedChars = Math.max(0, content.length - MAX_APPROVAL_PREVIEW_LENGTH);
  return {
    label: normalizeText(label, 40) || "Content",
    text: omittedChars > 0 ? content.slice(0, MAX_APPROVAL_PREVIEW_LENGTH) : content,
    ...(omittedChars > 0 ? { omittedChars } : {}),
  };
}

function normalizeText(value: unknown, maxLength = 480): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function getToolName(details: unknown): string {
  if (!details || typeof details !== "object" || Array.isArray(details)) return "";
  const value = (details as Record<string, unknown>).tool;
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Decide whether an `ask` result needs a human response in the no-popup
 * runtime. The permission engine has already classified this call as `ask`,
 * so every result must become an inline assistant question. Keeping this
 * decision in one helper makes the no-popup boundary explicit and leaves room
 * for future metadata checks without reintroducing a modal approval path.
 */
export function shouldUseAssistantApprovalInput(
  approvalType: string,
  details: unknown,
  options?: { allowAutoApprove?: boolean; requireExplicitApproval?: boolean },
): boolean {
  if (options?.requireExplicitApproval === true || options?.allowAutoApprove === false) {
    return true;
  }

  const normalizedType = approvalType as ApprovalType;
  if (HIGH_IMPACT_APPROVAL_TYPES.has(normalizedType)) return true;

  const toolName = getToolName(details);
  if (
    toolName.startsWith("mcp_") ||
    toolName.endsWith("_action") ||
    toolName === "voice_call" ||
    toolName === "request_protected_credential" ||
    toolName === "get_current_location"
  ) {
    return true;
  }

  // This function is called only after the permission engine has returned an
  // `ask` decision. Every remaining ask must therefore become an inline
  // assistant decision, including ordinary network/on-request boundaries.
  return true;
}

/**
 * Identify approvals that must be failed closed across restart even when the
 * legacy approval queue is explicitly enabled for diagnostics. Ordinary
 * network asks can still use the legacy queue in that opt-in mode; credentials,
 * exports, side effects, destructive work, and boundary crossings cannot.
 */
export function isHighImpactApprovalDecision(approvalType: string, details?: unknown): boolean {
  const normalizedType = approvalType as ApprovalType;
  if (HIGH_IMPACT_APPROVAL_TYPES.has(normalizedType)) return true;

  const toolName = getToolName(details);
  if (
    toolName.startsWith("mcp_") ||
    toolName.endsWith("_action") ||
    toolName === "voice_call" ||
    toolName === "request_protected_credential" ||
    toolName === "get_current_location"
  ) {
    return true;
  }

  const command =
    details && typeof details === "object" && !Array.isArray(details)
      ? (details as Record<string, unknown>).command
      : undefined;
  return (
    normalizedType === "run_command" &&
    typeof command === "string" &&
    /(^|\s)(sudo|rm|dd|mkfs|diskutil|shutdown|reboot|killall)\b/i.test(command)
  );
}

function getPermissionPrompt(details: unknown): Partial<PermissionPromptDetails> | null {
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const prompt = (details as Record<string, unknown>).permissionPrompt;
  return prompt && typeof prompt === "object" && !Array.isArray(prompt)
    ? (prompt as Partial<PermissionPromptDetails>)
    : null;
}

/**
 * "Always allow" saves a workspace rule for the prompt's scope, so the card offers it only
 * when the permission engine produced a scope and suggested `allow_workspace`. The engine
 * withholds persistence for requests that must be decided one at a time.
 */
export function canOfferAssistantAlwaysAllow(details: unknown): boolean {
  const prompt = getPermissionPrompt(details);
  if (!prompt?.scope || !Array.isArray(prompt.suggestedActions)) return false;
  return prompt.suggestedActions.some((option) => option?.action === "allow_workspace");
}

export function buildAssistantApprovalRequest(
  approvalType: string,
  description: string,
  details?: unknown,
): RequestUserInputArgs {
  const detailsRecord =
    details && typeof details === "object" && !Array.isArray(details)
      ? (details as Record<string, unknown>)
      : undefined;
  const actionReview = detailsRecord?.responsibilityActionReview;
  const questionId =
    approvalType === "workspace_write" &&
    actionReview &&
    typeof actionReview === "object" &&
    (actionReview as Record<string, unknown>).version === 1
      ? RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID
      : ASSISTANT_APPROVAL_QUESTION_ID;
  const requiresExactWriteReview = questionId === RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID;
  const safeDescription = normalizeText(description) || "The next operation needs your decision.";
  const scopePreview = normalizeText(getPermissionPrompt(details)?.scopePreview);
  const taskConsent =
    (approvalType === "external_service" ||
      approvalType === "network_access" ||
      approvalType === "computer_use" ||
      approvalType === "data_export") &&
    details &&
    typeof details === "object" &&
    typeof (details as Record<string, unknown>).taskConsentScope === "string"
      ? normalizeText((details as Record<string, unknown>).taskConsentScope)
      : "";
  const consentLabel = normalizeText(detailsRecord?.taskConsentLabel, 40);
  const allowLabel = taskConsent
    ? consentLabel && /^Allow for this (task|chat)$/.test(consentLabel)
      ? consentLabel
      : "Allow for this task"
    : "Allow once";
  const scopeText = scopePreview ? ` Scope: ${scopePreview}.` : "";
  // Exact content the decision is about (a PACT message is up to 4000 characters), written by
  // the main process; it gets its own bound so the description limit never truncates it.
  const reviewText = normalizeText(detailsRecord?.approvalReviewText, 4600);
  // What the user grants by approving: always listed in full, outside the review text bound.
  const rawPermissions: unknown = detailsRecord?.approvalReviewPermissions;
  const reviewPermissions = Array.isArray(rawPermissions)
    ? rawPermissions
        .map((permission) => normalizeText(permission, MAX_REVIEW_PERMISSION_LENGTH))
        .filter(Boolean)
    : [];
  const permissionsText =
    reviewPermissions.length > 0 ? ` Permissions: ${reviewPermissions.join("; ")}.` : "";
  const preview = buildApprovalPreview(detailsRecord);
  const operation = normalizeText(approvalType, 80) || "operation";
  // Deny is first so an accidental Enter/keyboard submission fails closed. The user
  // explicitly chooses an allow option; the one-time allow stays last as the primary action.
  const options = [
    {
      label: requiresExactWriteReview ? "Deny once" : "Deny",
      description: "Stop this operation and return control to the task.",
    },
  ];
  // Task consent already covers the task, and an exact-write review approves one write only.
  if (!taskConsent && !requiresExactWriteReview && canOfferAssistantAlwaysAllow(details)) {
    options.push({
      label: ALWAYS_ALLOW_LABEL,
      description: scopePreview
        ? `Continue and stop asking in this workspace for ${scopePreview}.`
        : `Continue and stop asking for this ${operation} in this workspace.`,
    });
  }
  options.push({
    label: allowLabel,
    description:
      taskConsent ||
      (approvalType === "memory_delete"
        ? "Forget this memory."
        : `Continue this ${operation} only once.`),
  });

  return {
    questions: [
      {
        header: "Permission",
        id: questionId,
        question: `${safeDescription}${reviewText ? ` ${reviewText}` : ""}${permissionsText}${scopeText}${
          taskConsent
            ? allowLabel === "Allow for this chat"
              ? ` Consent covers ${taskConsent}.`
              : ` Consent covers ${taskConsent} until this task ends.`
            : ""
        } Do you want CoWork to continue?`,
        ...(preview ? { preview } : {}),
        options,
      },
    ],
  };
}

/**
 * The transcript line posted with an inline approval. The card below it explains the decision
 * in full, so the line only points there: repeating the explanation showed it twice on one
 * screen. Inline approvals never reach a chat without the card (gateway tasks fail closed).
 */
export function buildAssistantApprovalMessage(
  approvalType: string,
  description: string,
  details?: unknown,
): string {
  const request = buildAssistantApprovalRequest(approvalType, description, details);
  const labels = request.questions[0].options.map((option) => `**${option.label}**`);
  const choices =
    labels.length > 2
      ? `${labels.slice(0, -1).join(", ")}, or ${labels[labels.length - 1]}`
      : labels.join(" or ");
  return `I need your decision before I can continue. Choose ${choices} below.`;
}

export function isAssistantApprovalInputRequest(request: InputRequest | undefined): boolean {
  return Boolean(
    request?.questions?.some(
      (question) =>
        question.id === ASSISTANT_APPROVAL_QUESTION_ID ||
        question.id === RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID,
    ),
  );
}

/**
 * Map the card answer to an approval action. Anything other than an explicit allow option
 * (including a free-text "Other" answer) is a denial. A reviewed write only ever allows once.
 */
export function parseAssistantApprovalAction(
  answers: InputRequest["answers"] | undefined,
  responsibilityActionReview = false,
): ApprovalResponseAction {
  const label =
    answers?.[
      responsibilityActionReview
        ? RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID
        : ASSISTANT_APPROVAL_QUESTION_ID
    ]?.optionLabel;
  const normalized = typeof label === "string" ? label.trim().toLowerCase() : "";
  if (!responsibilityActionReview && normalized === ALWAYS_ALLOW_LABEL.toLowerCase())
    return "allow_workspace";
  if (normalized.startsWith("allow")) return "allow_once";
  return "deny_once";
}

export function parseAssistantApprovalAnswer(
  answers: InputRequest["answers"] | undefined,
  responsibilityActionReview = false,
): boolean {
  return parseAssistantApprovalAction(answers, responsibilityActionReview) !== "deny_once";
}

/** The card option that answers an approval action, or undefined when the card has none. */
export function findAssistantApprovalOptionLabel(
  options: readonly { label: string }[] | undefined,
  action: ApprovalResponseAction,
): string | undefined {
  const labels = (options ?? []).map((option) => option.label);
  const normalized = (label: string) => label.trim().toLowerCase();
  if (action === "allow_workspace") {
    const always = labels.find((label) => normalized(label) === ALWAYS_ALLOW_LABEL.toLowerCase());
    if (always) return always;
  }
  // Without a matching broader scope on the card, an allow is answered with the one-time allow.
  const prefix = action.startsWith("allow_") ? "allow" : "deny";
  return labels.find((label) => normalized(label).startsWith(prefix));
}
