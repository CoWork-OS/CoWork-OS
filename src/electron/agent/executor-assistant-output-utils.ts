export function processAssistantResponseText(opts: {
  responseContent: any[] | undefined;
  eventPayload?: Record<string, unknown>;
  updateLastAssistantText?: boolean;
  emitAssistantMessage: (payload: Record<string, unknown>) => void;
  checkOutput: (text: string) => any;
  onSuspiciousOutput: (text: string, outputCheck: any) => void;
  isAskingQuestion: (text: string) => boolean;
  setLastAssistantText?: (text: string) => void;
}): { assistantText: string; assistantAskedQuestion: boolean; hasMeaningfulText: boolean } {
  const textParts = (opts.responseContent || [])
    .filter((item: any) => item.type === "text" && item.text)
    .map((item: any) => String(item.text));
  const meaningfulTextParts = textParts.filter((text) => text.trim().length > 0);
  const assistantText = meaningfulTextParts.join("\n");

  let assistantAskedQuestion = false;
  let hasMeaningfulText = false;

  for (const text of meaningfulTextParts) {
    hasMeaningfulText = true;

    opts.emitAssistantMessage({
      message: text,
      ...(opts.eventPayload || {}),
    });

    const outputCheck = opts.checkOutput(text);
    if (outputCheck?.suspicious) {
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
