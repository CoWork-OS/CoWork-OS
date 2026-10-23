export type JsonStringifyOptions = {
  indent?: number;
  sortKeys?: boolean;
  maxOutputChars?: number;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sortKeysDeep(value: unknown, seen: WeakSet<object>): unknown {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);

  let result: unknown = value;
  if (Array.isArray(value)) {
    result = value.map((v) => sortKeysDeep(v, seen));
  } else if (isPlainObject(value)) {
    // Code-unit order, like Python's sort_keys; localeCompare varied with the
    // ICU locale and put "a" before "B".
    const keys = Object.keys(value).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      out[k] = sortKeysDeep((value as Record<string, unknown>)[k], seen);
    }
    result = out;
  }

  // `seen` holds only the current path: a cycle is left for JSON.stringify to
  // reject, while an object that appears twice is sorted at both places.
  seen.delete(value as object);
  return result;
}

type JsonWithRawJson = JSON & { rawJSON?: (text: string) => unknown };
const rawJson = (JSON as JsonWithRawJson).rawJSON;

/**
 * Python ints beyond the safe range reach the sandbox as BigInt, which
 * JSON.stringify rejects. Write the exact digits as a JSON number, as
 * json.dumps does, or as a string where the runtime has no JSON.rawJSON.
 */
function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value !== "bigint") return value;
  return rawJson ? rawJson(value.toString()) : value.toString();
}

/**
 * Deterministic JSON.stringify.
 *
 * `JSON.stringify` returns `undefined` for `undefined`, functions and symbols,
 * so reading `out.length` crashed on those; they now produce `"null"`, matching
 * what `JSON.stringify` emits for them inside arrays (issue #608). `BigInt`
 * values are written as exact JSON numbers, so large Python ints keep their
 * digits. Circular structures and throwing `toJSON` methods raise an error,
 * like Python's `json.dumps`, instead of returning text that could be mistaken
 * for a real `null`.
 */
export function stableJsonStringify(value: unknown, options?: JsonStringifyOptions): string {
  const indent = typeof options?.indent === "number" ? Math.max(0, Math.min(8, options.indent)) : 0;
  // 0, negative and NaN fall back to the default instead of disabling the cap.
  const requestedMax = options?.maxOutputChars;
  const maxOutputChars =
    typeof requestedMax === "number" && requestedMax > 0
      ? Math.min(500_000, requestedMax)
      : 200_000;

  const sortKeys = !!options?.sortKeys;
  const prepared = sortKeys ? sortKeysDeep(value, new WeakSet()) : value;

  let out: string;
  try {
    // Typed explicitly because the lib.d.ts overload claims `string`, while the
    // runtime returns undefined for undefined, functions and symbols.
    const serialized: string | undefined = JSON.stringify(prepared, bigintReplacer, indent);
    out = serialized ?? "null";
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Value is not JSON serializable: ${reason}`);
  }

  if (out.length > maxOutputChars) {
    // Don't cut between the two halves of a surrogate pair.
    const lastKept = out.charCodeAt(maxOutputChars - 1);
    const cut = lastKept >= 0xd800 && lastKept <= 0xdbff ? maxOutputChars - 1 : maxOutputChars;
    out = out.slice(0, cut) + "\n[... truncated ...]";
  }

  return out;
}

export type JsonExtractOptions = {
  maxResults?: number;
  allowRepair?: boolean;
  maxCandidateChars?: number;
};

function extractFencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  const patterns = [/```json\s*([\s\S]*?)\s*```/gi, /```\s*([\s\S]*?)\s*```/g];

  for (const re of patterns) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const body = (match[1] || "").trim();
      if (body) blocks.push(body);
      if (blocks.length >= 50) return blocks;
    }
  }

  return blocks;
}

function scanBalancedJsonCandidates(text: string, maxCandidateChars: number): string[] {
  const out: string[] = [];
  const n = text.length;

  let start = -1;
  let stack: string[] = [];
  let inString = false;
  let stringDelim = "";
  let escaped = false;

  const reset = () => {
    start = -1;
    stack = [];
    inString = false;
    stringDelim = "";
    escaped = false;
  };

  for (let i = 0; i < n; i++) {
    const ch = text[i];

    if (start === -1) {
      if (ch === "{" || ch === "[") {
        start = i;
        stack = [ch];
        inString = false;
        stringDelim = "";
        escaped = false;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === stringDelim) {
        inString = false;
        stringDelim = "";
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringDelim = ch;
      continue;
    }

    if (ch === "{" || ch === "[") {
      stack.push(ch);
      continue;
    }

    if (ch === "}" || ch === "]") {
      const top = stack[stack.length - 1];
      const matches = (top === "{" && ch === "}") || (top === "[" && ch === "]");
      if (!matches) {
        reset();
        continue;
      }
      stack.pop();
      if (stack.length === 0) {
        const candidate = text.slice(start, i + 1).trim();
        if (candidate && candidate.length <= maxCandidateChars) {
          out.push(candidate);
        }
        reset();
      }
      continue;
    }

    if (start !== -1 && i - start + 1 > maxCandidateChars) {
      reset();
    }
  }

  return out;
}

function repairJsonString(text: string): string {
  let s = text.trim();

  s = s.replace(/\bNone\b/g, "null");
  s = s.replace(/\bTrue\b/g, "true");
  s = s.replace(/\bFalse\b/g, "false");

  s = s.replace(/,(\s*[}\]])/g, "$1");
  s = s.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)/g, '$1"$2"$3');
  s = s.replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'\s*([,}])/g, (_m, inner, tail) => {
    const escaped = String(inner).replace(/\\"/g, '"').replace(/"/g, '\\"');
    return `: "${escaped}"${tail}`;
  });

  return s;
}

function tryParseJson(text: string, allowRepair: boolean): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }
  if (!allowRepair) return undefined;
  const repaired = repairJsonString(trimmed);
  if (repaired === trimmed) return undefined;
  try {
    return JSON.parse(repaired);
  } catch {
    return undefined;
  }
}

export function extractJsonValues(text: string, options?: JsonExtractOptions): unknown[] {
  const maxResults =
    typeof options?.maxResults === "number" ? Math.max(1, Math.min(50, options.maxResults)) : 5;
  const allowRepair = !!options?.allowRepair;
  const maxCandidateChars =
    typeof options?.maxCandidateChars === "number"
      ? Math.max(256, Math.min(1_000_000, options.maxCandidateChars))
      : 200_000;

  const values: unknown[] = [];
  const seen = new Set<string>();

  const consider = (candidate: string) => {
    if (!candidate) return;
    const key = candidate.length > 4096 ? candidate.slice(0, 4096) : candidate;
    if (seen.has(key)) return;
    seen.add(key);

    const parsed = tryParseJson(candidate, allowRepair);
    if (parsed !== undefined) values.push(parsed);
  };

  for (const block of extractFencedBlocks(text)) {
    consider(block);
    if (values.length >= maxResults) return values.slice(0, maxResults);
  }

  for (const candidate of scanBalancedJsonCandidates(text, maxCandidateChars)) {
    consider(candidate);
    if (values.length >= maxResults) break;
  }

  return values.slice(0, maxResults);
}
