/**
 * The question an approval card asks when a tool has no wording of its own. It used to read
 * "Allow canvas_create to access the requested resource?", which names neither the action
 * nor anything a person would recognise.
 */
const TOOL_ACTION_PHRASES: Record<string, string> = {
  canvas_create: "open a live canvas",
  canvas_push: "show content in the live canvas",
  canvas_open_url: "open a web page in the live canvas",
  canvas_eval: "run code in the live canvas",
  canvas_show: "show the live canvas",
  canvas_hide: "hide the live canvas",
  canvas_close: "close the live canvas",
  canvas_snapshot: "take a snapshot of the live canvas",
  canvas_export: "export the live canvas",
  canvas_add_asset: "add a file to the live canvas",
  canvas_checkpoint: "save a checkpoint of the live canvas",
  canvas_restore: "restore the live canvas from a checkpoint",
};

export function describeToolApprovalRequest(toolName: string): string {
  const action = TOOL_ACTION_PHRASES[toolName];
  if (action) return `Allow CoWork OS to ${action}?`;
  const words = String(toolName || "")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!words) return "Allow this step to continue?";
  return /\btool$/i.test(words)
    ? `Allow CoWork OS to use the ${words}?`
    : `Allow CoWork OS to use the ${words} tool?`;
}
