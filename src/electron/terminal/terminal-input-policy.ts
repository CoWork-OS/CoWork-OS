export function normalizeTerminalAttachInput(input: unknown): string {
  if (typeof input !== "string" || input.length === 0) {
    return "";
  }
  throw new Error(
    "Raw terminal input is disabled. Use terminalTab:run so command approval and guardrails apply.",
  );
}
