const CONFIRMATION_REQUIRED_AGENT_SECURITY_COMMANDS = new Set([
  "agent-security-prune",
  "agent-security-hook-install",
  "agent-security-hook-uninstall",
]);

export function requiresAgentSecurityConfirmation(command: string | undefined): boolean {
  return Boolean(command && CONFIRMATION_REQUIRED_AGENT_SECURITY_COMMANDS.has(command));
}
