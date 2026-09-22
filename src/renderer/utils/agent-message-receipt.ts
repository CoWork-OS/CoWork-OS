export type AgentMessageReceiptStatus =
  | "accepted"
  | "queued"
  | "started"
  | "delivered"
  | "failed"
  | "quarantined";

export interface AgentMessageReceipt {
  status: AgentMessageReceiptStatus;
  label: string;
  messageId: string;
  senderTaskId: string;
  targetTaskId: string;
  error: string;
  duplicate: boolean;
}

function firstString(...values: unknown[]): string {
  return (
    values
      .find((value): value is string => typeof value === "string" && value.trim().length > 0)
      ?.trim() ?? ""
  );
}

function normalizeStatus(value: unknown): AgentMessageReceiptStatus {
  if (
    value === "accepted" ||
    value === "queued" ||
    value === "started" ||
    value === "delivered" ||
    value === "failed" ||
    value === "quarantined"
  ) {
    return value;
  }
  return "accepted";
}

function shortenMessageId(messageId: string): string {
  return messageId.length > 12 ? `${messageId.slice(0, 8)}…` : messageId;
}

export function getAgentMessageReceipt(
  payload: Record<string, unknown> | undefined,
  options?: { defaultStatus?: AgentMessageReceiptStatus },
): AgentMessageReceipt & { shortMessageId: string } {
  const rawStatus = payload?.deliveryStatus ?? payload?.delivery_status ?? payload?.status;
  const status = normalizeStatus(
    rawStatus ?? (payload?.success === false ? "failed" : options?.defaultStatus),
  );
  const messageId = firstString(payload?.messageId, payload?.message_id);
  const duplicate = payload?.duplicate === true;
  const label = duplicate
    ? status === "queued"
      ? "Already queued; duplicate ignored"
      : status === "delivered"
        ? "Already delivered; duplicate ignored"
        : status === "failed"
          ? "Duplicate failed"
          : status === "quarantined"
            ? "Duplicate quarantined"
            : "Duplicate accepted"
    : status === "queued"
      ? "Queued for the next turn"
      : status === "started"
        ? "Started on the next turn"
        : status === "failed"
          ? "Delivery failed"
          : status === "quarantined"
            ? "Delivery quarantined — repair the team to retry"
            : status === "delivered"
              ? "Delivered"
              : "Accepted — delivery pending";

  return {
    status,
    label,
    messageId,
    shortMessageId: shortenMessageId(messageId),
    senderTaskId: firstString(payload?.senderTaskId, payload?.sender_task_id),
    targetTaskId: firstString(payload?.targetTaskId, payload?.target_task_id),
    error: firstString(payload?.error, payload?.errorMessage, payload?.error_message),
    duplicate,
  };
}

/**
 * Bot runtimes can echo the structured send_agent_message result as the next
 * assistant message. That protocol receipt is useful for transport, but it is
 * not user-facing conversation copy. Recognize both the structured JSON and
 * legacy plain-text forms while leaving ordinary answers visible.
 */
export function parseAgentMessageProtocolResult(
  text: string,
): (AgentMessageReceipt & { shortMessageId: string }) | null {
  const trimmed = text.trim();

  const plainTextMatch = trimmed.match(
    /^success=(true|false)\s*(?:[,;]\s*|\s+)deliveryStatus=(accepted|queued|started|delivered|failed|quarantined)\s*(?:[,;]\s*|\s+)message_id=([^\s,;]+)(?:\s*(?:[,;]\s*|\s+)error=(.+))?$/i,
  );
  if (plainTextMatch) {
    return getAgentMessageReceipt({
      success: plainTextMatch[1]?.toLowerCase() === "true",
      deliveryStatus: plainTextMatch[2]?.toLowerCase(),
      message_id: plainTextMatch[3],
      ...(plainTextMatch[4] ? { error: plainTextMatch[4].trim() } : {}),
    });
  }

  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const payload = parsed as Record<string, unknown>;
  const hasMessageId = Boolean(firstString(payload.messageId, payload.message_id));
  const hasDeliveryMarker =
    payload.success === true ||
    payload.success === false ||
    payload.deliveryStatus !== undefined ||
    payload.delivery_status !== undefined ||
    payload.status !== undefined;
  if (!hasMessageId || !hasDeliveryMarker) return null;

  return getAgentMessageReceipt(payload);
}

/**
 * Convert a structured send_agent_message echo into conversation copy. The
 * raw JSON remains available in the technical event details, but it should
 * never be the bot's visible transcript text.
 */
export function formatAgentMessageProtocolForDisplay(text: string): string {
  const receipt = parseAgentMessageProtocolResult(text);
  if (!receipt) return text;
  return receipt.messageId ? `${receipt.label} · ${receipt.shortMessageId}` : receipt.label;
}
