/**
 * Secret detection for memory text, shared by capture, imports and the write gate.
 *
 * Two different questions:
 * - `redactSecrets` / `containsSecret`: does the text hold a secret value (a key, a token,
 *   a password assignment)? Those values are replaced before storage, so plaintext
 *   secrets never reach the database or a prompt.
 * - `mentionsSensitiveTopic`: does the text talk about auth, tokens or passwords? That
 *   is ordinary engineering text and must not hide a memory; it is informational only.
 */

export const REDACTED_SECRET = "[REDACTED_SECRET]";

interface SecretRule {
  name: string;
  pattern: RegExp;
  replace: (match: string, ...groups: string[]) => string;
}

const whole = () => REDACTED_SECRET;

// Values that are references, not secrets: env lookups, template slots, earlier redactions.
const NOT_A_LITERAL = String.raw`(?!\$|<|\{|\[|%|process\.env|os\.environ|env\.|\*{3,})`;

const ASSIGNMENT_KEYS = [
  String.raw`api[_-]?key`,
  "apikey",
  String.raw`access[_-]?key(?:[_-]?id)?`,
  String.raw`secret(?:[_-]?(?:access[_-]?)?key)?`,
  String.raw`client[_-]?secret`,
  String.raw`(?:access|auth|refresh|id|session|bearer)[_-]?token`,
  "token",
  "password",
  "passwd",
  String.raw`private[_-]?key`,
].join("|");

const SECRET_RULES: SecretRule[] = [
  {
    name: "private_key_block",
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
    replace: whole,
  },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replace: whole,
  },
  {
    name: "github_token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    replace: whole,
  },
  {
    // OpenAI / Anthropic style keys: sk-..., sk-proj-..., sk-ant-...
    name: "sk_key",
    pattern: /\bsk-(?:[A-Za-z]+-)?[A-Za-z0-9_-]{20,}/g,
    replace: whole,
  },
  {
    name: "slack_token",
    pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
    replace: whole,
  },
  {
    name: "aws_access_key_id",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replace: whole,
  },
  {
    name: "google_api_key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replace: whole,
  },
  {
    name: "bearer_token",
    pattern: /\b(Bearer)\s+(?!\[REDACTED)[A-Za-z0-9\-._~+/]{16,}=*/gi,
    replace: (_match, scheme) => `${scheme} ${REDACTED_SECRET}`,
  },
  {
    name: "url_credentials",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]{3,})@/gi,
    replace: (_match, prefix) => `${prefix}${REDACTED_SECRET}@`,
  },
  {
    // `password=…`, `api_key: …`, `"token": "…"`, `AWS_SECRET_ACCESS_KEY=…`: a key that
    // names a secret, an assignment, and a literal value of 6+ characters.
    name: "secret_assignment",
    pattern: new RegExp(
      String.raw`\b((?:[A-Za-z0-9]+[_-])*(?:${ASSIGNMENT_KEYS}))(["']?\s*[:=]\s*["']?)${NOT_A_LITERAL}([^\s"',;]{6,})`,
      "gi",
    ),
    replace: (_match, key, separator) => `${key}${separator}${REDACTED_SECRET}`,
  },
];

export interface SecretRedaction {
  text: string;
  /** Number of secret values replaced. */
  count: number;
  /** Names of the rules that matched, for diagnostics (never the values). */
  kinds: string[];
}

/** Replace secret values with `[REDACTED_SECRET]`, keeping the surrounding text. */
export function redactSecrets(text: string): SecretRedaction {
  if (!text) return { text: text || "", count: 0, kinds: [] };
  let output = text;
  let count = 0;
  const kinds: string[] = [];
  for (const rule of SECRET_RULES) {
    rule.pattern.lastIndex = 0;
    let hits = 0;
    output = output.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
      hits += 1;
      const groups = rest.filter((value): value is string => typeof value === "string");
      return rule.replace(match, ...groups);
    });
    if (hits > 0) {
      count += hits;
      kinds.push(rule.name);
    }
  }
  return { text: output, count, kinds };
}

/** Whether `text` holds a secret value (as opposed to merely mentioning one). */
export function containsSecret(text: string): boolean {
  return redactSecrets(text).count > 0;
}

const SENSITIVE_TOPIC =
  /\b(?:api[_-]?keys?|secrets?|passwords?|passwd|tokens?|credentials?|auth\w*|oauth|ssh[_-]?keys?|private[_-]?keys?)\b|\.env\b/i;

/**
 * Whether `text` talks about a sensitive topic (auth, tokens, passwords, `.env`).
 * Informational only: it must not be used to hide or privatize a memory.
 */
export function mentionsSensitiveTopic(text: string): boolean {
  return SENSITIVE_TOPIC.test(text || "");
}
