/**
 * What an MCP tool approval shows the user. A remote MCP call (a Workday name change, a
 * ticket update) is decided on its arguments, so the card prints them exactly as they will be
 * sent instead of a generic "access the requested resource" line.
 */
export interface McpApprovalPresentation {
  description: string;
  approvalPreview?: { label: string; text: string };
}

function hasArguments(input: unknown): boolean {
  if (input === null || input === undefined) return false;
  if (typeof input === "object" && !Array.isArray(input)) return Object.keys(input).length > 0;
  return true;
}

/**
 * A costed call (a tool that spends the vendor's credits) puts its estimate and the task's
 * spend above the arguments, so the price is the first thing on the card.
 */
export function withMcpCostLines(
  preview: { label: string; text: string } | undefined,
  costLines: readonly string[],
): { label: string; text: string } | undefined {
  if (costLines.length === 0) return preview;
  const cost = costLines.join("\n");
  if (!preview) return { label: "Cost", text: cost };
  return { label: `Cost and ${preview.label.toLowerCase()}`, text: `${cost}\n\n${preview.text}` };
}

export function buildMcpApprovalPresentation(
  toolName: string,
  serverName: string,
  input: unknown,
  costLines: readonly string[] = [],
): McpApprovalPresentation {
  const target = `Allow ${toolName} to call ${serverName}`;
  if (!hasArguments(input)) {
    const approvalPreview = withMcpCostLines(undefined, costLines);
    return {
      description: `${target} with no arguments?`,
      ...(approvalPreview ? { approvalPreview } : {}),
    };
  }
  let text: string;
  try {
    text = JSON.stringify(input, null, 2);
  } catch {
    text = String(input);
  }
  return {
    description: `${target} with the arguments shown below?`,
    approvalPreview: withMcpCostLines({ label: "Arguments", text }, costLines),
  };
}
