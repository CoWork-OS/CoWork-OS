const DEFAULT_AGENT_ROLE_ICON = "🤖";

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const lowered = trimmed.toLowerCase();
  if (lowered === "undefined" || lowered === "null" || lowered === "nan") {
    return undefined;
  }
  return trimmed;
}

export function normalizeAgentRoleIcon(
  value: unknown,
  fallback: string = DEFAULT_AGENT_ROLE_ICON,
): string {
  return normalizeNonEmptyString(value) || fallback;
}

export function formatAgentRoleDisplay(
  displayName: unknown,
  icon: unknown,
  options?: {
    fallbackDisplayName?: string;
    fallbackIcon?: string;
  },
): string {
  const name = normalizeNonEmptyString(displayName) || options?.fallbackDisplayName || "Agent";
  const normalizedIcon = normalizeAgentRoleIcon(icon, options?.fallbackIcon ?? DEFAULT_AGENT_ROLE_ICON);
  return `${normalizedIcon} ${name}`;
}

