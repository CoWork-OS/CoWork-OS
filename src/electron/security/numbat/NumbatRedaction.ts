const SENSITIVE_KEY_RE =
  /(token|api[_-]?key|secret|password|authorization|cookie|private[_-]?key|credential)/i;
const SENSITIVE_VALUE_PATTERNS: Array<[RegExp, string]> = [
  [
    /(\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL|ACCESS_KEY)[A-Z0-9_]*\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s;&|]+)/g,
    "$1[REDACTED]",
  ],
  [
    /(["']?(?:api[-_]?key|access[-_]?key|token|secret|password|passwd|authorization|cookie|private[-_]?key|credential)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
    "$1[REDACTED]",
  ],
  [/(\bAuthorization\s*:\s*)[^\r\n]+/gi, "$1[REDACTED]"],
  [
    /(--?(?:api[-_]?key|token|secret|password|authorization|cookie|credential)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s&]+)/gi,
    "$1[REDACTED]",
  ],
  [
    /([?&](?:api[-_]?key|token|secret|password|authorization|cookie|credential)=)[^&#\s]+/gi,
    "$1[REDACTED]",
  ],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s/]+@/gi, "$1[REDACTED]@"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]"],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]"],
  [/\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g, "[REDACTED_TOKEN]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_ACCESS_KEY]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_JWT]"],
  [
    /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)? PRIVATE KEY-----/g,
    "[REDACTED_PRIVATE_KEY]",
  ],
];

export function redactAgentSecurityString(value: string, maxLength = 2_048): string {
  let output = value;
  for (const [pattern, replacement] of SENSITIVE_VALUE_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output.length > maxLength ? `${output.slice(0, maxLength)}[TRUNCATED]` : output;
}

export function redactAgentSecurityRecord(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactAgentSecurityString(value);
  if (typeof value !== "object") return value;
  if (seen.has(value as object)) return "[CIRCULAR]";
  seen.add(value as object);
  try {
    if (Array.isArray(value)) {
      return value.slice(0, 256).map((item) => redactAgentSecurityRecord(item, depth + 1, seen));
    }
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 256)) {
      output[key] = SENSITIVE_KEY_RE.test(key)
        ? "[REDACTED]"
        : redactAgentSecurityRecord(child, depth + 1, seen);
    }
    return output;
  } finally {
    seen.delete(value as object);
  }
}

export function isSensitiveAgentSecurityKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}
