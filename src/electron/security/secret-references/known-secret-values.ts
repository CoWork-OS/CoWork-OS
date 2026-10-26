/**
 * Values read from vault references, so output that echoes one (an MCP server printing its
 * environment, a command's output) can be masked before it reaches the model, task logs or
 * memory. Pattern-based redaction only catches key shapes it knows; this catches the exact
 * values CoWork handed out. Kept in memory only.
 */
const MIN_LENGTH = 8;
const MAX_VALUES = 200;
export const VAULT_SECRET_PLACEHOLDER = "[REDACTED_VAULT_SECRET]";

const values = new Set<string>();

export function rememberResolvedSecret(value: string): void {
  if (value.length < MIN_LENGTH || values.has(value)) return;
  if (values.size >= MAX_VALUES) {
    const oldest = values.values().next().value;
    if (oldest !== undefined) values.delete(oldest);
  }
  values.add(value);
}

export function redactResolvedSecrets(text: string): string {
  if (!text || values.size === 0) return text;
  let redacted = text;
  for (const value of values) {
    if (redacted.includes(value)) redacted = redacted.split(value).join(VAULT_SECRET_PLACEHOLDER);
  }
  return redacted;
}

export function _resetResolvedSecretsForTests(): void {
  values.clear();
}
