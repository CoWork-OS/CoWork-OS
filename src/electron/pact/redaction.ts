/**
 * Redaction for everything PACT writes to logs, task events, Control Plane results and errors.
 *
 * There is no central log redaction in CoWork, so PACT applies this at its own boundaries. The
 * covered values are credentials or credential-equivalents: personal-agent and delegation tokens,
 * device codes, user codes, sign-in links that embed a user code, refresh tokens, and the
 * business-side user id carried in receipts.
 */

const REDACTED = "[redacted]";

const SENSITIVE_KEYS = new Set(
  [
    "authorization",
    "x-a2a-user-delegation",
    "access_token",
    "accessToken",
    "refresh_token",
    "refreshToken",
    "device_code",
    "deviceCode",
    "user_code",
    "userCode",
    "verification_uri_complete",
    "verificationUriComplete",
    "pact.verificationUriComplete",
    "id_token",
    "client_assertion",
    "assertion",
    "jws",
    "signerCredential",
    "credential",
    "privateJwk",
    "private_key",
    "password",
    "secret",
    "token",
    "paJwt",
    "delegationToken",
  ].map((key) => key.toLowerCase()),
);

/** Receipt claim keys that identify the business account holder. */
const RECEIPT_IDENTITY_KEYS = new Set(["user"]);

const BEARER_PATTERN = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
const FORM_SECRET_PATTERN =
  /\b(device_code|user_code|refresh_token|access_token|code|assertion)=([^&\s"']+)/gi;
const PREFIXED_SECRET_PATTERN = /\b(dc|rt|at)_[A-Za-z0-9_-]{12,}/g;

export function redactPactString(value: string): string {
  return value
    .replace(BEARER_PATTERN, `$1 ${REDACTED}`)
    .replace(JWT_PATTERN, REDACTED)
    .replace(FORM_SECRET_PATTERN, (_match, key: string) => `${key}=${REDACTED}`)
    .replace(PREFIXED_SECRET_PATTERN, REDACTED)
    .replace(/(user_code%3D)[A-Za-z0-9-]+/gi, `$1${REDACTED}`);
}

function redactValue(value: unknown, depth: number, insideReceipt: boolean): unknown {
  if (depth > 12) return REDACTED;
  if (typeof value === "string") return redactPactString(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1, insideReceipt));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lower)) {
      output[key] = child === undefined || child === null ? child : REDACTED;
      continue;
    }
    if (insideReceipt && RECEIPT_IDENTITY_KEYS.has(lower)) {
      output[key] = REDACTED;
      continue;
    }
    const childInsideReceipt =
      insideReceipt || lower === "pact.receipt" || lower === "receipt" || lower === "claims";
    output[key] = redactValue(child, depth + 1, childInsideReceipt);
  }
  return output;
}

/** Deep-copy a value with PACT secrets removed. Safe for logs, events and remote results. */
export function redactPact<T>(value: T): T {
  return redactValue(value, 0, false) as T;
}

export function redactPactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactPactString(message);
}

/** Headers safe to log: the two credential headers are replaced. */
export function redactPactHeaders(headers: Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    output[name] = SENSITIVE_KEYS.has(name.toLowerCase()) ? REDACTED : redactPactString(value);
  }
  return output;
}
