import type { ComplianceCheckResult } from "./security/output-filter";

export function processAssistantResponseText(opts: {
  responseContent: Array<{ type?: string; text?: unknown }> | undefined;
  eventPayload?: Record<string, unknown>;
  updateLastAssistantText?: boolean;
  sanitizeAssistantText?: (text: string) => string;
  emitAssistantMessage: (payload: Record<string, unknown>) => void;
  checkOutput: (text: string) => ComplianceCheckResult | null | undefined;
  onSuspiciousOutput: (text: string, outputCheck: ComplianceCheckResult) => void;
  isAskingQuestion: (text: string) => boolean;
  setLastAssistantText?: (text: string) => void;
}): { assistantText: string; assistantAskedQuestion: boolean; hasMeaningfulText: boolean } {
  const textParts = (opts.responseContent || [])
    .filter((item) => item.type === "text" && item.text)
    .map((item) => {
      const text = String(item.text);
      return opts.sanitizeAssistantText ? opts.sanitizeAssistantText(text) : text;
    })
    .filter((text) => text.trim().length > 0);
  const meaningfulTextParts = textParts.filter((text) => text.trim().length > 0);
  const assistantText = meaningfulTextParts.join("\n");

  let assistantAskedQuestion = false;
  let hasMeaningfulText = false;

  for (const text of meaningfulTextParts) {
    hasMeaningfulText = true;

    opts.emitAssistantMessage({
      message: text,
      ...opts.eventPayload,
    });

    const outputCheck = opts.checkOutput(text);
    if (outputCheck && outputCheck.suspicious === true) {
      opts.onSuspiciousOutput(text, outputCheck);
    }

    if (opts.isAskingQuestion(text)) {
      assistantAskedQuestion = true;
    }
  }

  if (opts.updateLastAssistantText && assistantText.trim().length > 0) {
    opts.setLastAssistantText?.(assistantText.trim());
  }

  return { assistantText, assistantAskedQuestion, hasMeaningfulText };
}
