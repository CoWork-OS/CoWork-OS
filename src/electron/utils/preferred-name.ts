const EXPLICIT_NAME_PATTERNS = [
  /\bmy name is\s+([\p{L}][\p{L}' -]{1,80})(?=$|[.!?,]|\s+(?:and|but|from)\b)/iu,
  /\b(?:you can\s+)?call me\s+([\p{L}][\p{L}' -]{1,80})(?=$|[.!?,]|\s+(?:and|but|from)\b)/iu,
  /\bi go by\s+([\p{L}][\p{L}' -]{1,80})(?=$|[.!?,]|\s+(?:and|but|from)\b)/iu,
];

const INTRO_NAME_PATTERNS = [
  /^(?:hi|hello|hey)[,\s!]*(?:i am|i'm)\s+([\p{L}][\p{L}' -]{1,50})$/iu,
  /^(?:i am|i'm)\s+([\p{L}][\p{L}' -]{1,50})$/iu,
];

const INFERRED_DISALLOWED_NAME_TOKENS = new Set([
  "building",
  "working",
  "trying",
  "authenticated",
  "authentication",
  "now",
  "cannot",
  "cant",
  "open",
  "need",
  "want",
  "ready",
  "curious",
  "busy",
  "currently",
  "using",
  "making",
  "doing",
  "fixing",
  "creating",
  "starting",
  "please",
  "thanks",
  "thank",
  "help",
  "from",
  "in",
  "at",
  "on",
  "for",
  "with",
  "to",
  "by",
  "as",
  "a",
  "an",
  "the",
  "this",
  "that",
  "my",
  "our",
  "your",
]);

function collapseWhitespace(value: string): string {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeToken(token: string): string {
  return token.replace(/^[^\p{L}]+|[^\p{L}'-]+$/gu, "");
}

function tokenizeName(rawName: string, maxTokens: number): string[] {
  const compact = collapseWhitespace(rawName);
  if (!compact) return [];

  return compact
    .split(" ")
    .map((part) => normalizeToken(part))
    .filter(Boolean)
    .slice(0, maxTokens);
}

function joinNameTokens(tokens: string[]): string {
  return tokens.join(" ").trim();
}

export function normalizePreferredNameCandidate(rawName: string, maxTokens = 3): string {
  return joinNameTokens(tokenizeName(rawName, maxTokens));
}

export function isLikelyPreferredName(name: string): boolean {
  const tokens = tokenizeName(name, 3);
  const normalized = joinNameTokens(tokens);
  if (!normalized) return false;
  if (normalized.length < 2 || normalized.length > 40) return false;

  if (tokens.length === 0 || tokens.length > 3) return false;
  const lowerTokens = tokens.map((token) => token.toLowerCase());

  for (let idx = 0; idx < lowerTokens.length; idx += 1) {
    const token = lowerTokens[idx];
    const rawToken = tokens[idx];
    if (!token || token.length < 2 || token.length > 20) return false;
    if (!/\p{L}/u.test(rawToken)) return false;
    if (INFERRED_DISALLOWED_NAME_TOKENS.has(token)) return false;
  }

  return true;
}

export function sanitizeInferredPreferredName(name: string | null | undefined): string | undefined {
  if (typeof name !== "string") return undefined;
  const normalized = normalizePreferredNameCandidate(name, 3);
  return isLikelyPreferredName(normalized) ? normalized : undefined;
}

export function sanitizeStoredPreferredName(name: string | null | undefined): string | undefined {
  if (typeof name !== "string") return undefined;

  const tokens = tokenizeName(name, 8);
  const normalized = joinNameTokens(tokens);
  if (!normalized) return undefined;
  if (normalized.length < 2 || normalized.length > 100) return undefined;

  const lowerTokens = tokens.map((token) => token.toLowerCase());
  const firstToken = lowerTokens[0];
  if (INFERRED_DISALLOWED_NAME_TOKENS.has(firstToken)) return undefined;

  // If a "name" looks like a sentence/task fragment, clear it.
  if (
    lowerTokens.length >= 3 &&
    lowerTokens.some((token) => INFERRED_DISALLOWED_NAME_TOKENS.has(token))
  ) {
    return undefined;
  }

  return normalized;
}

export function sanitizePreferredName(name: string | null | undefined): string | undefined {
  return sanitizeInferredPreferredName(name);
}

export function extractPreferredNameFromMessage(message: string): string | null {
  const text = collapseWhitespace(message);
  if (!text) return null;
  const plainText = text.replace(/[.!?]+$/g, "").trim();

  for (const pattern of EXPLICIT_NAME_PATTERNS) {
    const match = plainText.match(pattern);
    const preferredName = sanitizeInferredPreferredName(match?.[1]);
    if (preferredName) return preferredName;
  }

  for (const pattern of INTRO_NAME_PATTERNS) {
    const match = plainText.match(pattern);
    const preferredName = sanitizeInferredPreferredName(match?.[1]);
    if (preferredName) return preferredName;
  }

  return null;
}

export function sanitizePreferredNameMemoryLine(line: string): string | null {
  const text = collapseWhitespace(line);
  if (!text) return null;

  const preferredNameMatch = text.match(/^Preferred name:\s*(.+)$/i);
  if (!preferredNameMatch) return text;

  const preferredName = sanitizeInferredPreferredName(preferredNameMatch[1]);
  if (!preferredName) return null;
  return `Preferred name: ${preferredName}`;
}
