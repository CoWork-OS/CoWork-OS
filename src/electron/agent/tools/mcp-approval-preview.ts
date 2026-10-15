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

export function buildMcpApprovalPresentation(
  toolName: string,
  serverName: string,
  input: unknown,
): McpApprovalPresentation {
  const target = `Allow ${toolName} to call ${serverName}`;
  if (!hasArguments(input)) {
    return { description: `${target} with no arguments?` };
  }
  let text: string;
  try {
    text = JSON.stringify(input, null, 2);
  } catch {
    text = String(input);
  }
  return {
    description: `${target} with the arguments shown below?`,
    approvalPreview: { label: "Arguments", text },
  };
}
