export type ShellPermissionDecision =
  | "enable_shell"
  | "continue_without_shell"
  | "unknown";

export function classifyShellPermissionDecision(text: string): ShellPermissionDecision {
  const lower = String(text || "")
    .toLowerCase()
    .trim();
  if (!lower) return "unknown";

  if (/^(?:yes|yep|yeah|sure|ok|okay|please do|do it)[.!]?$/i.test(lower)) {
    return "enable_shell";
  }
  if (/^(?:no|nope|nah)[.!]?$/i.test(lower)) {
    return "continue_without_shell";
  }
  if (
    /\b(?:enable|turn on|allow|grant)\b[\s\S]{0,20}\bshell\b/.test(lower) ||
    /\bshell\b[\s\S]{0,20}\b(?:enable|enabled|on|allow|grant)\b/.test(lower)
  ) {
    return "enable_shell";
  }
  if (
    /\b(?:continue|proceed|go ahead|move on)\b[\s\S]{0,40}\b(?:without shell|no shell|limited|best effort)\b/.test(
      lower,
    ) ||
    /\bwithout shell\b/.test(lower) ||
    /\b(?:don['’]?t|do not)\s+enable\s+shell\b/.test(lower) ||
    /\blimited\s+best\s+effort\b/.test(lower)
  ) {
    return "continue_without_shell";
  }

  return "unknown";
}
