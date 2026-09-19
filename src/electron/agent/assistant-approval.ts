import type { ApprovalType, InputRequest, RequestUserInputArgs } from "../../shared/types";

/**
 * The desktop approval fallback is rendered as a task input card. Keeping a
 * stable question id lets recovery code distinguish an approval decision from
 * an ordinary `request_user_input` question without adding another durable
 * table or reviving the legacy approval modal.
 */
export const ASSISTANT_APPROVAL_QUESTION_ID = "approval_decision";

const HIGH_IMPACT_APPROVAL_TYPES = new Set<ApprovalType>([
  "delete_file",
  "delete_multiple",
  "bulk_rename",
  "external_file_access",
  "external_service",
  "data_export",
  "location_access",
  "protected_credential",
  "risk_gate",
  "computer_use",
]);

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

export function buildAssistantApprovalRequest(
  approvalType: string,
  description: string,
  details?: unknown,
): RequestUserInputArgs {
  const safeDescription = normalizeText(description) || "The next operation needs your decision.";
  const scopePreview =
    details && typeof details === "object" && !Array.isArray(details)
      ? normalizeText(
          (details as Record<string, unknown>).permissionPrompt &&
            typeof (details as Record<string, unknown>).permissionPrompt === "object"
            ? ((details as Record<string, unknown>).permissionPrompt as Record<string, unknown>)
                .scopePreview
            : undefined,
        )
      : "";
  const scopeText = scopePreview ? ` Scope: ${scopePreview}.` : "";

  return {
    questions: [
      {
        header: "Permission",
        id: ASSISTANT_APPROVAL_QUESTION_ID,
        question: `${safeDescription}${scopeText} Do you want CoWork to continue this operation?`,
        // Deny is first so an accidental Enter/keyboard submission fails
        // closed. The user can explicitly choose Allow once.
        options: [
          {
            label: "Deny",
            description: "Stop this operation and return control to the task.",
          },
          {
            label: "Allow once",
            description: `Continue this ${normalizeText(approvalType, 80) || "operation"} only once.`,
          },
        ],
      },
    ],
  };
}

export function buildAssistantApprovalMessage(
  approvalType: string,
  description: string,
  details?: unknown,
): string {
  const request = buildAssistantApprovalRequest(approvalType, description, details);
  const question = request.questions[0];
  return `I need your decision before I can continue. ${question.question} Choose **Deny** or **Allow once** below.`;
}

export function isAssistantApprovalInputRequest(request: InputRequest | undefined): boolean {
  return Boolean(
    request?.questions?.some((question) => question.id === ASSISTANT_APPROVAL_QUESTION_ID),
  );
}

export function parseAssistantApprovalAnswer(
  answers: InputRequest["answers"] | undefined,
): boolean {
  const label = answers?.[ASSISTANT_APPROVAL_QUESTION_ID]?.optionLabel;
  return typeof label === "string" && label.trim().toLowerCase().startsWith("allow");
}
