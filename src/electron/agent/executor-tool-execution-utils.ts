import { truncateToolResult } from "./context-manager";
import type { LLMImageMimeType, LLMToolResult, LLMToolResultCompanionContent } from "./llm";
import { canonicalizeToolName } from "./tool-semantics";

export interface NormalizedToolFailureReason {
  message: string;
  kind?: string;
  display?: string;
  code?: string;
}

export interface ToolInputValidationResult {
  input: Any;
  error: string | null;
  repairable: boolean;
  repaired: boolean;
  repairReason?: string;
}

const QUERY_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "to",
  "in",
  "of",
  "for",
  "and",
  "or",
  "with",
  "on",
  "at",
  "from",
  "by",
  "if",
  "then",
  "also",
  "this",
  "that",
  "these",
  "those",
  "step",
  "task",
  "create",
  "build",
  "write",
  "implement",
  "generate",
  "file",
  "files",
  "script",
  "results",
  "output",
]);

const NESTED_PACKAGE_MANIFEST_PATH_REGEX = /(?:^|[\\/])src[\\/]+package\.json$/i;
const WEB_APP_SCAFFOLD_CONTEXT_REGEX =
  /\b(create|build|scaffold|bootstrap|initialize|set up|setup|implement|make)\b[\s\S]{0,120}\b(website|web app|webapp|app|application|ui|interface|react|vite|next\.?js|nextjs|vue|svelte|angular)\b/i;
const NESTED_PACKAGE_INTENT_REGEX =
  /\b(monorepo|multi[- ]package|nested package|subpackage|workspace package|package workspace)\b/i;
const LOCAL_MODEL_NETWORK_RESULT_COMPACT_TRIGGER_CHARS = 2_500;
const LOCAL_MODEL_NETWORK_RESULT_MAX_CHARS = 4_000;
const LOCAL_MODEL_NETWORK_BODY_MAX_CHARS = 2_200;
const LOCAL_MODEL_NETWORK_BODY_HEAD_CHARS = 1_400;
const LOCAL_MODEL_NETWORK_BODY_TAIL_CHARS = 350;
const LOCAL_MODEL_JSON_ARRAY_ITEMS = 6;
const LOCAL_MODEL_JSON_STRING_VALUE_MAX_CHARS = 700;

const NETWORK_RESULT_TOOLS = new Set(["http_request", "web_fetch"]);
const IMPORTANT_JSON_KEYS = [
  "full_name",
  "name",
  "tag_name",
  "title",
  "description",
  "html_url",
  "url",
  "homepage",
  "created_at",
  "updated_at",
  "pushed_at",
  "published_at",
  "released_at",
  "stargazers_count",
  "forks_count",
  "watchers_count",
  "subscribers_count",
  "open_issues_count",
  "language",
  "default_branch",
  "topics",
  "license",
  "login",
  "type",
  "contributions",
  "author",
  "prerelease",
  "draft",
  "body",
  "assets",
  "browser_download_url",
  "download_count",
  "content",
  "text",
] as const;
const NOISY_JSON_KEYS = new Set([
  "node_id",
  "avatar_url",
  "gravatar_id",
  "followers_url",
  "following_url",
  "gists_url",
  "starred_url",
  "subscriptions_url",
  "organizations_url",
  "repos_url",
  "events_url",
  "received_events_url",
  "site_admin",
]);

function deriveSearchQueryFromContext(context: string): string {
  const tokens = String(context || "")
    .toLowerCase()
    .replace(/[^a-z0-9_./-]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(
      (token) =>
        token.length >= 3 &&
        !QUERY_STOPWORDS.has(token) &&
        !/^\d+$/.test(token) &&
        !token.startsWith("http"),
    );
  return tokens.slice(0, 6).join(" ");
}

function safeJsonParseValue(value: string): Any | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function compactStringValue(
  value: string,
  maxChars = LOCAL_MODEL_JSON_STRING_VALUE_MAX_CHARS,
): string {
  if (value.length <= maxChars) return value;
  const head = Math.max(0, maxChars - 160);
  return `${value.slice(0, head)}\n[... truncated ${value.length - head} chars ...]`;
}

function compactHeadersForLocalModel(headers: unknown): Record<string, string> {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return {};
  const keep = new Set([
    "content-type",
    "content-length",
    "etag",
    "last-modified",
    "link",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
  ]);
  const compact: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(headers as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();
    if (!keep.has(lowerKey)) continue;
    const value = typeof rawValue === "string" ? rawValue : JSON.stringify(rawValue);
    compact[key] = compactStringValue(value, 400);
  }
  return compact;
}

function compactJsonValueForLocalModel(value: Any, depth = 0): Any {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return compactStringValue(value);
  if (Array.isArray(value)) {
    const items = value
      .slice(0, LOCAL_MODEL_JSON_ARRAY_ITEMS)
      .map((item) => compactJsonValueForLocalModel(item, depth + 1));
    return {
      _type: "array",
      originalLength: value.length,
      items,
      ...(value.length > items.length ? { omittedItems: value.length - items.length } : {}),
    };
  }
  if (typeof value !== "object") return String(value);

  const source = value as Record<string, Any>;
  const compact: Record<string, Any> = {};
  const used = new Set<string>();
  for (const key of IMPORTANT_JSON_KEYS) {
    if (!(key in source)) continue;
    used.add(key);
    compact[key] =
      depth >= 3
        ? compactStringValue(JSON.stringify(source[key]), 1200)
        : compactJsonValueForLocalModel(source[key], depth + 1);
  }

  let extraCount = 0;
  for (const [key, rawValue] of Object.entries(source)) {
    if (used.has(key) || NOISY_JSON_KEYS.has(key)) continue;
    if (extraCount >= 16) break;
    if (
      rawValue === null ||
      typeof rawValue === "string" ||
      typeof rawValue === "number" ||
      typeof rawValue === "boolean"
    ) {
      compact[key] = compactJsonValueForLocalModel(rawValue, depth + 1);
      used.add(key);
      extraCount++;
    }
  }

  const omittedKeys = Object.keys(source).filter(
    (key) => !used.has(key) && !NOISY_JSON_KEYS.has(key),
  );
  if (omittedKeys.length > 0) {
    compact._omittedKeys = omittedKeys.slice(0, 24);
    if (omittedKeys.length > 24) compact._omittedKeyCount = omittedKeys.length;
  }
  return compact;
}

function compactTextForLocalModel(text: string): string {
  if (text.length <= LOCAL_MODEL_NETWORK_BODY_MAX_CHARS) return text;
  const headingLines = text
    .split(/\r?\n/)
    .filter((line) =>
      /^\s{0,3}(#{1,6}\s+|[-*]\s+|release|version|feature|changelog|date\b)/i.test(line),
    )
    .slice(0, 80)
    .join("\n");
  const headingBlock = headingLines
    ? `\n\n[Extracted headings/key lines]\n${headingLines.slice(0, 3_000)}`
    : "";
  return (
    text.slice(0, LOCAL_MODEL_NETWORK_BODY_HEAD_CHARS) +
    headingBlock +
    `\n\n[... truncated ${text.length - LOCAL_MODEL_NETWORK_BODY_HEAD_CHARS - LOCAL_MODEL_NETWORK_BODY_TAIL_CHARS} chars for local model context; refetch URL if exact omitted text is needed ...]\n\n` +
    text.slice(-LOCAL_MODEL_NETWORK_BODY_TAIL_CHARS)
  );
}

function compactNetworkBodyForLocalModel(body: string): string {
  const parsed = safeJsonParseValue(body);
  if (parsed !== null) {
    const compactJson = JSON.stringify(compactJsonValueForLocalModel(parsed), null, 2);
    return compactJson.length <= LOCAL_MODEL_NETWORK_BODY_MAX_CHARS
      ? compactJson
      : compactTextForLocalModel(compactJson);
  }
  return compactTextForLocalModel(body);
}

function compactNetworkEnvelopeForLocalModel(source: Record<string, Any>): Record<string, Any> {
  const compacted: Record<string, Any> = {};
  const used = new Set<string>();
  const topLevelKeys = [
    "success",
    "url",
    "finalUrl",
    "normalizedUrl",
    "status",
    "statusText",
    "title",
    "contentLength",
    "truncated",
    "error",
  ];

  for (const key of topLevelKeys) {
    if (!(key in source)) continue;
    compacted[key] = compactJsonValueForLocalModel(source[key]);
    used.add(key);
  }

  if (source.headers) {
    compacted.headers = compactHeadersForLocalModel(source.headers);
    used.add("headers");
  }

  const bodyKey =
    typeof source.body === "string"
      ? "body"
      : typeof source.content === "string"
        ? "content"
        : typeof source.text === "string"
          ? "text"
          : "";
  if (bodyKey) {
    compacted[bodyKey] = compactNetworkBodyForLocalModel(source[bodyKey] as string);
    compacted.originalBodyLength = (source[bodyKey] as string).length;
    used.add(bodyKey);
  }

  if (Array.isArray(source.links)) {
    compacted.links = {
      _type: "array",
      originalLength: source.links.length,
      items: source.links.slice(0, 10).map((link) => compactJsonValueForLocalModel(link)),
      ...(source.links.length > 10 ? { omittedItems: source.links.length - 10 } : {}),
    };
    used.add("links");
  }

  const omittedKeys = Object.keys(source).filter((key) => !used.has(key));
  if (omittedKeys.length > 0) {
    compacted._omittedTopLevelKeys = omittedKeys.slice(0, 20);
    if (omittedKeys.length > 20) compacted._omittedTopLevelKeyCount = omittedKeys.length;
  }

  return compacted;
}

export function compactNetworkToolResultForLocalModel(opts: {
  toolName: string;
  result: Any;
  rawResult: string;
}): string {
  const toolName = canonicalizeToolName(String(opts.toolName || ""));
  if (!NETWORK_RESULT_TOOLS.has(toolName)) return opts.rawResult;
  if (
    typeof opts.rawResult !== "string" ||
    opts.rawResult.length <= LOCAL_MODEL_NETWORK_RESULT_COMPACT_TRIGGER_CHARS
  ) {
    return opts.rawResult;
  }

  const parsed = safeJsonParseValue(opts.rawResult);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return compactTextForLocalModel(opts.rawResult);
  }

  const compacted = compactNetworkEnvelopeForLocalModel(parsed as Record<string, Any>);
  compacted._cowork_compacted_for_local_model = true;
  compacted._compaction_note =
    "Network response compacted for local Ollama context. URLs, dates, counts, headers, and representative body text were preserved; refetch the source URL if exact omitted text is needed.";

  const rendered = JSON.stringify(compacted, null, 2);
  return rendered.length <= LOCAL_MODEL_NETWORK_RESULT_MAX_CHARS
    ? rendered
    : compactTextForLocalModel(rendered);
}

export function preflightValidateAndRepairToolInput(opts: {
  toolName: string;
  input: Any;
  contextText?: string;
}): ToolInputValidationResult {
  const toolName = String(opts.toolName || "");
  let input: Any =
    opts.input && typeof opts.input === "object" && !Array.isArray(opts.input)
      ? { ...opts.input }
      : {};
  let repaired = false;
  let repairable = false;
  const repairReasons: string[] = [];

  if (toolName === "search_files") {
    repairable = true;
    if (typeof input.path !== "string" || input.path.trim().length === 0) {
      input.path = ".";
      repaired = true;
      repairReasons.push('defaulted path to "."');
    }
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (!query) {
      const derivedQuery = deriveSearchQueryFromContext(opts.contextText || "");
      if (!derivedQuery) {
        return {
          input,
          error: "search_files requires a non-empty query",
          repairable: false,
          repaired,
          repairReason: repairReasons.join("; ") || undefined,
        };
      }
      input.query = derivedQuery;
      repaired = true;
      repairReasons.push(`derived query from context: "${derivedQuery}"`);
    }
  } else if (toolName === "glob") {
    repairable = true;
    if (typeof input.path !== "string" || input.path.trim().length === 0) {
      input.path = ".";
      repaired = true;
      repairReasons.push('defaulted path to "."');
    }
    if (typeof input.pattern !== "string" || input.pattern.trim().length === 0) {
      input.pattern = "**/*";
      repaired = true;
      repairReasons.push('defaulted pattern to "**/*"');
    }
  } else if (toolName === "read_file") {
    repairable = true;
    if (typeof input.path !== "string" || input.path.trim().length === 0) {
      const candidatePath = [input.filename, input.file, input.target]
        .map((candidate) => (typeof candidate === "string" ? candidate.trim() : ""))
        .find(Boolean);
      if (candidatePath) {
        input.path = candidatePath;
        repaired = true;
        repairReasons.push("normalized alternate path field");
      }
    }
  } else if (toolName === "write_file") {
    repairable = true;
    if (
      (typeof input.path !== "string" || input.path.trim().length === 0) &&
      typeof input.filename === "string"
    ) {
      input.path = input.filename;
      repaired = true;
      repairReasons.push("normalized filename -> path");
    }
    if (typeof input.content !== "string" || input.content.length === 0) {
      const altContent = input.contents || input.text || input.body || input.data;
      if (typeof altContent === "string" && altContent.length > 0) {
        input.content = altContent;
        delete input.contents;
        delete input.text;
        delete input.body;
        delete input.data;
        repaired = true;
        repairReasons.push("normalized alternate content field");
      }
    }

    const normalizedPath = String(input.path || "").replace(/\\/g, "/");
    const normalizedContext = String(opts.contextText || "");
    const isSuspiciousNestedPackageManifest =
      NESTED_PACKAGE_MANIFEST_PATH_REGEX.test(normalizedPath) &&
      WEB_APP_SCAFFOLD_CONTEXT_REGEX.test(normalizedContext) &&
      !NESTED_PACKAGE_INTENT_REGEX.test(normalizedContext);
    if (isSuspiciousNestedPackageManifest) {
      return {
        input,
        error:
          "write_file to a nested src/package.json is blocked for website/app scaffold tasks. Use the workspace root package.json unless this is explicitly a monorepo or nested-package setup.",
        repairable: false,
        repaired,
        repairReason: repairReasons.join("; ") || undefined,
      };
    }
  }

  const error = getToolInputValidationError(toolName, input);
  return {
    input,
    error,
    repairable,
    repaired,
    repairReason: repairReasons.join("; ") || undefined,
  };
}

export function formatToolInputForLog(input: Any, maxLength = 200): string {
  try {
    const serialized = JSON.stringify(input);
    return serialized.length > maxLength ? `${serialized.slice(0, maxLength)}...` : serialized;
  } catch {
    return "(unserializable)";
  }
}

function getRunCommandTerminationContext(result: Any): string {
  if (!result || !result.terminationReason) return "";

  switch (result.terminationReason) {
    case "user_stopped":
      return (
        "[USER STOPPED] The user intentionally interrupted this command. " +
        "Do not retry automatically. Ask the user if they want you to continue or try a different approach."
      );
    case "timeout":
      return (
        "[TIMEOUT] Command exceeded time limit. " +
        "Consider: 1) Breaking into smaller steps, 2) Using a longer timeout if available, 3) Asking the user to run this manually."
      );
    case "error":
      return "[EXECUTION ERROR] The command could not be spawned or executed properly.";
    default:
      return "";
  }
}

function prependRunCommandTerminationContext(sanitizedResult: string, result: Any): string {
  const context = getRunCommandTerminationContext(result);
  return context ? `${context}\n\n${sanitizedResult}` : sanitizedResult;
}

// Failed tool results are the model's only view of why a call failed, so they
// carry bounded diagnostics instead of a bare error string. Command output is
// tail-biased: test failures, compiler errors and tracebacks print last.
const TOOL_FAILURE_PAYLOAD_MAX_CHARS = 16_000;
const TOOL_FAILURE_ERROR_MAX_CHARS = 4_000;
const TOOL_FAILURE_DISPLAY_MAX_CHARS = 4_000;
const TOOL_FAILURE_URL_MAX_CHARS = 2_000;
const TOOL_FAILURE_STDERR_TAIL_CHARS = 8_000;
const TOOL_FAILURE_STDOUT_HEAD_CHARS = 1_500;
const TOOL_FAILURE_STDOUT_TAIL_CHARS = 6_000;
const TOOL_FAILURE_DETAIL_MAX_CHARS = 2_000;
const TOOL_FAILURE_RESULT_ITEMS_MAX = 8;
const TOOL_FAILURE_DETAIL_FIELDS = [
  "message",
  "hint",
  "suggestion",
  "details",
  "status",
  "reason",
  "missing",
  "missing_requirements",
  "missing_tools",
  "missing_items",
  "task_id",
  "taskId",
  "completed",
  "failed",
] as const;
// Per-child fields kept for orchestrate_agents-style results; caps keep each item near 1.5K.
const TOOL_FAILURE_RESULT_ITEM_FIELDS: ReadonlyArray<readonly [string, number]> = [
  ["task_id", 120],
  ["taskId", 120],
  ["title", 200],
  ["status", 60],
  ["error", 500],
  ["summary", 700],
  ["result_summary", 700],
];

const ANSI_CSI_SEQUENCE_REGEX = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** Keep the start and end of `text`, cut at line boundaries when one is close. */
function clipFailureText(text: string, headChars: number, tailChars: number): string {
  const headBudget = Math.max(0, Math.floor(headChars));
  const tailBudget = Math.max(0, Math.floor(tailChars));
  if (text.length <= headBudget + tailBudget) return text;
  let head = text.slice(0, headBudget);
  const lastHeadBreak = head.lastIndexOf("\n");
  if (lastHeadBreak >= headBudget * 0.75) head = head.slice(0, lastHeadBreak);
  let tail = tailBudget > 0 ? text.slice(-tailBudget) : "";
  const firstTailBreak = tail.indexOf("\n");
  if (firstTailBreak >= 0 && firstTailBreak <= tailBudget * 0.25) {
    tail = tail.slice(firstTailBreak + 1);
  }
  const marker = `[... ${text.length - head.length - tail.length} chars omitted ...]`;
  return [head, marker, tail].filter(Boolean).join("\n");
}

function clipCommandOutput(text: string, headChars: number, tailChars: number): string {
  return clipFailureText(text.replace(ANSI_CSI_SEQUENCE_REGEX, ""), headChars, tailChars);
}

function boundFailureDetailValue(value: unknown, maxChars: number): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? clipFailureText(trimmed, maxChars * 0.6, maxChars * 0.4) : undefined;
  }
  if (typeof value !== "object") return undefined;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (typeof serialized !== "string") return undefined;
  return serialized.length <= maxChars
    ? value
    : clipFailureText(serialized, maxChars * 0.6, maxChars * 0.4);
}

function reduceFailureResultItem(item: unknown, scale: number): unknown {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return boundFailureDetailValue(item, 1_500 * scale);
  }
  const source = item as Record<string, unknown>;
  const reduced: Record<string, unknown> = {};
  for (const [key, maxChars] of TOOL_FAILURE_RESULT_ITEM_FIELDS) {
    const bounded = boundFailureDetailValue(source[key], maxChars * scale);
    if (bounded !== undefined) reduced[key] = bounded;
  }
  return reduced;
}

function buildToolFailurePayload(
  result: Any,
  failure: NormalizedToolFailureReason,
  guidance: string,
  scale: number,
): Record<string, unknown> {
  const source: Record<string, Any> = result && typeof result === "object" ? result : {};
  const errorText = failure.message;
  const payload: Record<string, unknown> = {
    error: clipFailureText(
      errorText,
      Math.max(TOOL_FAILURE_ERROR_MAX_CHARS * scale * 0.5, 250),
      Math.max(TOOL_FAILURE_ERROR_MAX_CHARS * scale * 0.5, 250),
    ),
  };
  if (failure.kind) payload.kind = failure.kind;
  if (failure.display) {
    payload.display = clipFailureText(
      failure.display,
      TOOL_FAILURE_DISPLAY_MAX_CHARS * scale * 0.25,
      TOOL_FAILURE_DISPLAY_MAX_CHARS * scale * 0.75,
    );
  }
  if (failure.code) payload.code = failure.code;
  if (source.url) payload.url = boundFailureDetailValue(source.url, TOOL_FAILURE_URL_MAX_CHARS);
  if (guidance) payload.guidance = guidance;

  if (typeof source.exitCode === "number" || source.exitCode === null) {
    payload.exitCode = source.exitCode;
  }
  if (typeof source.terminationReason === "string" && source.terminationReason) {
    payload.terminationReason = source.terminationReason;
  }
  if (typeof source.stderr === "string" && source.stderr.trim()) {
    payload.stderr = clipCommandOutput(source.stderr, 0, TOOL_FAILURE_STDERR_TAIL_CHARS * scale);
  }
  if (typeof source.stdout === "string" && source.stdout.trim()) {
    payload.stdout = clipCommandOutput(
      source.stdout,
      TOOL_FAILURE_STDOUT_HEAD_CHARS * scale,
      TOOL_FAILURE_STDOUT_TAIL_CHARS * scale,
    );
  }
  if (typeof source.truncated === "boolean") payload.truncated = source.truncated;

  for (const key of TOOL_FAILURE_DETAIL_FIELDS) {
    if (key in payload || !(key in source)) continue;
    const value = source[key];
    if (typeof value === "string" && value.trim() === errorText) continue;
    const bounded = boundFailureDetailValue(value, TOOL_FAILURE_DETAIL_MAX_CHARS * scale);
    if (bounded !== undefined) payload[key] = bounded;
  }

  if (Array.isArray(source.results) && source.results.length > 0) {
    payload.results = source.results
      .slice(0, TOOL_FAILURE_RESULT_ITEMS_MAX)
      .map((item: unknown) => reduceFailureResultItem(item, scale));
    if (source.results.length > TOOL_FAILURE_RESULT_ITEMS_MAX) {
      payload.results_omitted = source.results.length - TOOL_FAILURE_RESULT_ITEMS_MAX;
    }
  }

  return payload;
}

// A long successful run_command result would reach the generic tool-result
// budget, which cuts head-only and drops the summary at the end of a build or
// test log. Its stdout/stderr are bounded head+tail before that.
const RUN_COMMAND_RESULT_MAX_CHARS = 32_000;
const RUN_COMMAND_STDOUT_HEAD_CHARS = 4_000;
const RUN_COMMAND_STDOUT_TAIL_CHARS = 20_000;
const RUN_COMMAND_STDERR_TAIL_CHARS = 6_000;

function boundRunCommandOutputForModel(toolName: string, rawResult: string): string {
  if (toolName !== "run_command" || rawResult.length <= RUN_COMMAND_RESULT_MAX_CHARS) {
    return rawResult;
  }
  const parsed = safeJsonParseValue(rawResult);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return rawResult;
  let scale = 1;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const bounded = { ...parsed };
    if (typeof parsed.stdout === "string") {
      bounded.stdout = clipCommandOutput(
        parsed.stdout,
        RUN_COMMAND_STDOUT_HEAD_CHARS * scale,
        RUN_COMMAND_STDOUT_TAIL_CHARS * scale,
      );
    }
    if (typeof parsed.stderr === "string") {
      bounded.stderr = clipCommandOutput(parsed.stderr, 0, RUN_COMMAND_STDERR_TAIL_CHARS * scale);
    }
    const serialized = JSON.stringify(bounded);
    if (serialized.length <= RUN_COMMAND_RESULT_MAX_CHARS) return serialized;
    scale *= (RUN_COMMAND_RESULT_MAX_CHARS / serialized.length) * 0.9;
  }
  return rawResult;
}

/**
 * Serialize a failed tool result for the model: the error first, then bounded
 * diagnostics. Field caps shrink proportionally until the JSON fits, so escaped
 * control characters cannot push the payload past its budget.
 */
function serializeToolFailureForModel(
  result: Any,
  failure: NormalizedToolFailureReason,
  guidance: string,
): string {
  let scale = 1;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const serialized = JSON.stringify(buildToolFailurePayload(result, failure, guidance, scale));
    if (serialized.length <= TOOL_FAILURE_PAYLOAD_MAX_CHARS) return serialized;
    scale *= (TOOL_FAILURE_PAYLOAD_MAX_CHARS / serialized.length) * 0.9;
  }
  return JSON.stringify({
    error: clipFailureText(failure.message, 500, 500),
    ...(guidance ? { guidance } : {}),
    diagnostics_omitted: true,
  });
}

function normalizeImageMimeType(value: unknown): LLMImageMimeType | null {
  switch (
    String(value || "")
      .trim()
      .toLowerCase()
  ) {
    case "image/png":
    case "image/jpeg":
    case "image/gif":
    case "image/webp":
      return String(value || "")
        .trim()
        .toLowerCase() as LLMImageMimeType;
    default:
      return null;
  }
}

function buildComputerUseCompanionContent(
  toolName: string,
  result: Any,
): { compactResult: string; companionUserContent: LLMToolResultCompanionContent[] } | null {
  if (!result || typeof result !== "object") {
    return null;
  }

  const imageBase64 = typeof result.imageBase64 === "string" ? result.imageBase64.trim() : "";
  const captureId = typeof result.captureId === "string" ? result.captureId.trim() : "";
  const mediaType = normalizeImageMimeType(result.mediaType);
  if (!imageBase64 || !captureId || !mediaType) {
    return null;
  }

  const action =
    typeof result.action === "string" && result.action.trim() ? result.action.trim() : toolName;
  const appName =
    typeof result?.target?.appName === "string" && result.target.appName.trim()
      ? result.target.appName.trim()
      : undefined;
  const windowTitle =
    typeof result?.target?.windowTitle === "string" && result.target.windowTitle.trim()
      ? result.target.windowTitle.trim()
      : undefined;
  const note =
    typeof result.note === "string" && result.note.trim() ? result.note.trim() : undefined;

  const compactResult = JSON.stringify({
    ok: true,
    tool: toolName,
    action,
    captureId,
    mediaType,
    width: Number.isFinite(result.width) ? result.width : undefined,
    height: Number.isFinite(result.height) ? result.height : undefined,
    scaleFactor: Number.isFinite(result.scaleFactor) ? result.scaleFactor : undefined,
    target: {
      appName,
      windowTitle,
      windowId: Number.isFinite(result?.target?.windowId) ? result.target.windowId : undefined,
    },
    imageAttached: true,
    ...(note ? { note } : {}),
  });

  const companionText =
    `Latest controlled-window screenshot after ${action}. ` +
    `Use only this newest screenshot for the next computer-use action. ` +
    `captureId=${captureId}.` +
    (appName ? ` App=${appName}.` : "") +
    (windowTitle ? ` Window=${windowTitle}.` : "") +
    (note ? ` Note=${note}` : "");

  return {
    compactResult,
    companionUserContent: [
      { type: "text", text: companionText.trim() },
      {
        type: "image",
        data: imageBase64,
        mimeType: mediaType,
      },
    ],
  };
}

export function buildNormalizedToolResult(opts: {
  toolName: string;
  toolUseId: string;
  result: Any;
  rawResult: string;
  sanitizeToolResult: (toolName: string, resultText: string) => string;
  getToolFailureReason: (result: Any, fallback: string) => string;
  includeRunCommandTerminationContext?: boolean;
  compactForLocalModel?: boolean;
}): { toolResult: LLMToolResult; resultIsError: boolean; toolFailureReason: string } {
  const rawResultForModel = opts.compactForLocalModel
    ? compactNetworkToolResultForLocalModel({
        toolName: opts.toolName,
        result: opts.result,
        rawResult: opts.rawResult,
      })
    : opts.rawResult;
  const truncatedResult = truncateToolResult(
    boundRunCommandOutputForModel(opts.toolName, rawResultForModel),
  );
  let sanitizedResult = opts.sanitizeToolResult(opts.toolName, truncatedResult);
  const includeTerminationContext =
    opts.includeRunCommandTerminationContext === true && opts.toolName === "run_command";

  if (includeTerminationContext) {
    sanitizedResult = prependRunCommandTerminationContext(sanitizedResult, opts.result);
  }

  const resultIsError = Boolean(opts.result && opts.result.success === false);
  const advisoryFallbackFailure = isAdvisoryToolFailureResult(opts.result);
  const normalizedFailure = resultIsError
    ? normalizeToolFailureReason(opts.result, "Tool execution failed")
    : null;
  const toolFailureReason = normalizedFailure?.message || "";
  const companion = !resultIsError
    ? buildComputerUseCompanionContent(opts.toolName, opts.result)
    : null;
  // Failure diagnostics go through the same sanitizer as success payloads.
  const failureContent =
    normalizedFailure && !advisoryFallbackFailure
      ? opts.sanitizeToolResult(
          opts.toolName,
          serializeToolFailureForModel(
            opts.result,
            normalizedFailure,
            includeTerminationContext ? getRunCommandTerminationContext(opts.result) : "",
          ),
        )
      : null;

  return {
    toolResult: {
      type: "tool_result",
      tool_use_id: opts.toolUseId,
      content: failureContent ?? (companion?.compactResult || sanitizedResult),
      is_error: resultIsError && !advisoryFallbackFailure,
      ...(companion ? { companion_user_content: companion.companionUserContent } : {}),
    },
    resultIsError,
    toolFailureReason,
  };
}

export function normalizeToolUseName(opts: {
  toolName: string;
  normalizeToolName: (toolName: string) => {
    name: string;
    original: string;
    modified: boolean;
  };
  emitParameterInference: (tool: string, inference: string) => void;
}): string {
  const normalized = opts.normalizeToolName(opts.toolName);
  if (normalized.modified) {
    opts.emitParameterInference(
      opts.toolName,
      `Normalized tool name "${normalized.original}" -> "${normalized.name}"`,
    );
  }
  return normalized.name;
}

export function inferAndNormalizeToolInput(opts: {
  toolName: string;
  input: Any;
  inferMissingParameters: (
    toolName: string,
    input: Any,
  ) => { modified: boolean; input: Any; inference?: string };
  emitParameterInference: (tool: string, inference: string) => void;
}): Any {
  const inference = opts.inferMissingParameters(opts.toolName, opts.input);
  if (!inference.modified) {
    return opts.input;
  }
  const message =
    typeof inference.inference === "string" && inference.inference.trim()
      ? inference.inference
      : "Inferred missing parameters from available context";
  opts.emitParameterInference(opts.toolName, message);
  return inference.input;
}

export function buildDisabledToolResult(opts: {
  toolName: string;
  toolUseId: string;
  lastError?: string;
}): LLMToolResult {
  const errorDetail =
    typeof opts.lastError === "string" && opts.lastError.trim() ? opts.lastError : "unknown error";
  return {
    type: "tool_result",
    tool_use_id: opts.toolUseId,
    content: JSON.stringify({
      error: `Tool "${opts.toolName}" is temporarily unavailable due to: ${errorDetail}. Please try a different approach or wait and try again later.`,
      disabled: true,
    }),
    is_error: true,
  };
}

export function buildUnavailableToolResult(opts: {
  toolName: string;
  toolUseId: string;
  hint?: string;
  alternatives?: string[];
}): LLMToolResult {
  const baseError = `Tool "${opts.toolName}" is not available in this context. Please choose a different tool or check permissions/integrations.`;
  const alternatives =
    Array.isArray(opts.alternatives) && opts.alternatives.length > 0
      ? Array.from(new Set(opts.alternatives.map((value) => String(value).trim()).filter(Boolean)))
      : [];
  const alternativesHint =
    alternatives.length > 0
      ? ` Try one of these available alternatives instead: ${alternatives.join(", ")}.`
      : "";
  const error = `${baseError}${alternativesHint}${opts.hint ? ` ${opts.hint}` : ""}`.trim();
  return {
    type: "tool_result",
    tool_use_id: opts.toolUseId,
    content: JSON.stringify({
      error,
      unavailable: true,
      ...(alternatives.length > 0 ? { alternatives } : {}),
    }),
    is_error: true,
  };
}

export function buildInvalidInputToolResult(opts: {
  toolUseId: string;
  validationError: string;
}): LLMToolResult {
  return {
    type: "tool_result",
    tool_use_id: opts.toolUseId,
    content: JSON.stringify({
      error: opts.validationError,
      suggestion:
        "Include all required fields in the tool call (e.g., content for create_document/write_file).",
      invalid_input: true,
    }),
    is_error: true,
  };
}

/**
 * What to tell the model after a blocked duplicate call. Never claims the earlier call
 * succeeded unless its recorded result did.
 */
export function buildDuplicateCallSuggestion(duplicateCheck: {
  kind?: "exact" | "semantic" | "rate_limit";
  previousOutcome?: "succeeded" | "failed" | "unknown";
}): string {
  if (duplicateCheck.kind === "rate_limit") {
    return "Wait before calling this tool again, or continue with a different approach.";
  }
  if (duplicateCheck.kind === "semantic") {
    return (
      "Check what the earlier attempts did before trying again: if one already did what " +
      "you need, move on; if they failed, fix the cause or change the approach."
    );
  }
  if (duplicateCheck.previousOutcome === "failed") {
    return (
      "Repeating this exact call unchanged will fail the same way. Fix the underlying " +
      "cause or change the inputs before running it again."
    );
  }
  if (duplicateCheck.previousOutcome === "succeeded") {
    return (
      "The earlier identical call succeeded: use its result and move on, or change the " +
      "inputs if you need something different."
    );
  }
  return "Use the result of the earlier identical call, or change the inputs if you need something different.";
}

export function buildDuplicateToolResult(opts: {
  toolName: string;
  toolUseId: string;
  duplicateCheck: { reason?: string; cachedResult?: string };
  isIdempotentTool: (toolName: string) => boolean;
  suggestion: string;
  sanitizeToolResult?: (toolName: string, resultText: string) => string;
}): { toolResult: LLMToolResult; hasDuplicateAttempt: boolean } {
  const reason =
    typeof opts.duplicateCheck.reason === "string" && opts.duplicateCheck.reason.trim()
      ? opts.duplicateCheck.reason
      : "Duplicate tool call blocked.";

  if (opts.duplicateCheck.cachedResult && opts.isIdempotentTool(opts.toolName)) {
    // The cached result is the raw tool output: bound and sanitize it like a live result,
    // and say it is a repeat rather than a new run.
    const bounded = truncateToolResult(opts.duplicateCheck.cachedResult);
    const sanitized = opts.sanitizeToolResult
      ? opts.sanitizeToolResult(opts.toolName, bounded)
      : bounded;
    return {
      toolResult: {
        type: "tool_result",
        tool_use_id: opts.toolUseId,
        content: markCachedToolResult(
          sanitized,
          `Served from cache instead of running the call again: ${reason}`,
        ),
      },
      hasDuplicateAttempt: false,
    };
  }

  return {
    toolResult: {
      type: "tool_result",
      tool_use_id: opts.toolUseId,
      content: JSON.stringify({
        error: reason,
        suggestion: opts.suggestion,
        duplicate: true,
      }),
      is_error: true,
    },
    hasDuplicateAttempt: true,
  };
}

const CLOUD_ACTION_READ_ONLY_ACTIONS = new Set([
  "get_current_user",
  "search",
  "get_file",
  "get_folder",
  "list_folder_items",
  "list_folder",
  "list_children",
  "get_item",
  "get_item_metadata",
  "list_drives",
  "list_sites",
  "list_lists",
  "list_messages",
  "list_events",
  "download_file",
]);

const READ_ONLY_ACTION_PREFIX = /^(get_|list_|search|read_|query_|describe_|check_)/;
const MUTATING_ACTION_PREFIX =
  /^(create_|update_|delete_|remove_|move_|copy_|rename_|upload_|write_|set_|add_|append_|patch_|modify_)/;

function isReadOnlyCloudAction(action: string): boolean {
  const normalized = String(action || "")
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  if (CLOUD_ACTION_READ_ONLY_ACTIONS.has(normalized)) return true;
  if (MUTATING_ACTION_PREFIX.test(normalized)) return false;
  return READ_ONLY_ACTION_PREFIX.test(normalized);
}

export function isEffectivelyIdempotentToolCall(opts: {
  toolName: string;
  input: Any;
  isIdempotentTool: (toolName: string) => boolean;
}): boolean {
  if (opts.isIdempotentTool(opts.toolName)) return true;
  if (!opts.toolName.endsWith("_action")) return false;

  const action =
    opts.input && typeof opts.input.action === "string" ? String(opts.input.action) : "";
  if (!action) return false;
  return isReadOnlyCloudAction(action);
}

export function buildCancellationToolResult(opts: {
  toolUseId: string;
  cancelled: boolean;
}): LLMToolResult {
  return {
    type: "tool_result",
    tool_use_id: opts.toolUseId,
    content: JSON.stringify({
      error: opts.cancelled ? "Task was cancelled" : "Task already completed",
    }),
    is_error: true,
  };
}

/**
 * Label a result served from a cache instead of a new tool run. A JSON object result
 * gets a leading `_cached` field (the rest stays byte-identical and parseable); any
 * other result gets a one-line prefix.
 */
export function markCachedToolResult(content: string, note: string): string {
  const leadingWhitespace = /^\s*/.exec(content)?.[0] || "";
  const body = content.slice(leadingWhitespace.length);
  if (body.startsWith("{")) {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        if ("_cached" in parsed) return content;
        if (Object.keys(parsed).length > 0) {
          return `${leadingWhitespace}{"_cached":${JSON.stringify(note)},${body.slice(1)}`;
        }
      }
    } catch {
      // Not JSON: fall through to the text prefix.
    }
  }
  return `[cached] ${note}\n${content}`;
}

export function buildRedundantFileOperationToolResult(opts: {
  toolUseId: string;
  fileOpCheck: { cachedResult?: string; reason?: string; suggestion?: string };
}): LLMToolResult {
  const reason =
    typeof opts.fileOpCheck.reason === "string" && opts.fileOpCheck.reason.trim()
      ? opts.fileOpCheck.reason
      : "Redundant file operation blocked.";
  if (opts.fileOpCheck.cachedResult) {
    return {
      type: "tool_result",
      tool_use_id: opts.toolUseId,
      content: opts.fileOpCheck.cachedResult,
      is_error: false,
    };
  }

  return {
    type: "tool_result",
    tool_use_id: opts.toolUseId,
    content: JSON.stringify({
      error: reason,
      suggestion: opts.fileOpCheck.suggestion,
      blocked: true,
    }),
    is_error: true,
  };
}

export function buildWatchSkipBlockedArtifactToolResult(opts: {
  toolName: string;
  toolUseId: string;
}): LLMToolResult {
  return {
    type: "tool_result",
    tool_use_id: opts.toolUseId,
    content: JSON.stringify({
      error:
        `Tool "${opts.toolName}" is not allowed for this watch/skip recommendation task. ` +
        'Please provide a direct "watch" or "skip" recommendation based on your analysis.',
      suggestion: "Switch to a text-only answer with your recommendation and brief rationale.",
      blocked: true,
    }),
    is_error: true,
  };
}

export function recordToolFailureOutcome(opts: {
  toolName: string;
  failureReason: string;
  result: Any;
  persistentToolFailures: Map<string, number>;
  recordFailure: (toolName: string, error: string) => boolean;
  isHardToolFailure: (toolName: string, result: Any, reason: string) => boolean;
  /** False for a failure that is not a retry of the same thing (e.g. a red test run after an edit). */
  countTowardRepeatedFailures?: boolean;
}): {
  shouldDisable: boolean;
  isHardFailure: boolean;
  failureCount: number;
} {
  const shouldDisable = opts.recordFailure(opts.toolName, opts.failureReason);
  const isHardFailure = opts.isHardToolFailure(opts.toolName, opts.result, opts.failureReason);
  const previousCount = opts.persistentToolFailures.get(opts.toolName) || 0;
  const failureCount =
    opts.countTowardRepeatedFailures === false ? previousCount : previousCount + 1;
  opts.persistentToolFailures.set(opts.toolName, failureCount);
  return {
    shouldDisable,
    isHardFailure,
    failureCount,
  };
}

export function getToolInputValidationError(toolName: string, input: Any): string | null {
  const canonicalToolName = canonicalizeToolName(toolName);

  if (canonicalToolName === "create_document") {
    if (!input?.filename) return "create_document requires a filename";
    // create_document requires format; generate_document is valid with markdown/sections.
    if (toolName === "create_document" && !input?.format) {
      return "create_document requires a format (docx or pdf)";
    }
    if (toolName === "create_document" && !input?.content)
      return "create_document requires content";
    if (toolName === "generate_document" && !input?.markdown && !input?.sections) {
      return "generate_document requires markdown or sections";
    }
  }
  if (toolName === "compile_latex") {
    if (!input?.sourcePath) return "compile_latex requires a sourcePath";
  }
  if (toolName === "write_file") {
    if (typeof input?.path !== "string" || input.path.trim().length === 0)
      return "write_file requires a path";
    if (typeof input?.content !== "string" || input.content.length === 0)
      return (
        "write_file requires a non-empty 'content' parameter (string). " +
        "If the content is very long, split it: write the first half with write_file, " +
        "then append the rest with edit_file."
      );
  }
  if (toolName === "read_file") {
    if (typeof input?.path !== "string" || input.path.trim().length === 0) {
      return "read_file requires a non-empty path";
    }
  }
  if (toolName === "search_files") {
    if (typeof input?.query !== "string" || input.query.trim().length === 0) {
      return "search_files requires a non-empty query";
    }
  }
  if (toolName === "glob") {
    if (typeof input?.path !== "string" || input.path.trim().length === 0) {
      return "glob requires a non-empty path";
    }
    if (typeof input?.pattern !== "string" || input.pattern.trim().length === 0) {
      return "glob requires a non-empty pattern";
    }
  }
  if (canonicalToolName === "create_spreadsheet") {
    if (!input?.filename) return "create_spreadsheet requires a filename";
    if (!input?.sheets) return "create_spreadsheet requires sheets";
  }
  if (canonicalToolName === "create_presentation") {
    if (!input?.filename) return "create_presentation requires a filename";
    if (!input?.slides) return "create_presentation requires slides";
  }
  if (toolName === "count_text" || toolName === "text_metrics") {
    const hasText = typeof input?.text === "string";
    const hasPath = typeof input?.path === "string" && input.path.trim().length > 0;
    if (!hasText && !hasPath) {
      return `${toolName} requires either 'text' or 'path'`;
    }
    if (hasText && hasPath) {
      return `${toolName} requires either 'text' or 'path', not both`;
    }
  }
  if (toolName === "canvas_push") {
    return null;
  }
  return null;
}

export function isHardToolFailure(toolName: string, result: Any, failureReason = ""): boolean {
  if (!result || result.success !== false) {
    return false;
  }

  if (result.nonBlocking === true || result.recoverableFallback === true) {
    return false;
  }

  if (result.disabled === true || result.unavailable === true || result.blocked === true) {
    return true;
  }

  if (result.missing_requirements || result.missing_tools || result.missing_items) {
    return true;
  }

  const message = String(failureReason || result.error || result.reason || "").toLowerCase();
  if (!message) {
    return false;
  }

  if (toolName === "Skill") {
    return /not currently executable|cannot be invoked automatically|not found|blocked by|disabled/.test(
      message,
    );
  }

  if (toolName === "get_current_location") {
    return /desktop geolocation|native desktop geolocation|core location|geoclue|windows location|timed out while getting current location|location access was denied|current location is unavailable|geolocation is not available/i.test(
      message,
    );
  }

  // Free-text fallback for results without structured flags. Only tool-level
  // conditions count: a site that blocked one fetch ("blocked by the site's bot
  // protection") or a page that needs JavaScript says nothing about the tool.
  return (
    /not currently executable|not available in this context|not configured/.test(message) ||
    /\bblocked by\b(?:\s+[\w/'"-]+){0,4}?\s+(?:polic(?:y|ies)|allowlist|denylist)\b/.test(
      message,
    ) ||
    /(?:integration|tool|skill|connector|plugin|provider|search|fetch|browser|shell|command|feature|capabilit(?:y|ies))s?\b[^.\n]{0,30}?\b(?:is|are|been|was)\s+(?:currently\s+)?disabled\b/.test(
      message,
    ) ||
    /\bdisabled\s+(?:due to|by (?:policy|an? admin|the administrator|your organi[sz]ation)|in settings)\b/.test(
      message,
    )
  );
}

export function isAdvisoryToolFailureResult(result: Any): boolean {
  return Boolean(
    result &&
    result.success === false &&
    (result.nonBlocking === true || result.recoverableFallback === true),
  );
}

export function getToolFailureReason(result: Any, fallback: string): string {
  return normalizeToolFailureReason(result, fallback).message;
}

export function normalizeToolFailureReason(
  result: Any,
  fallback: string,
): NormalizedToolFailureReason {
  const fallbackMessage =
    typeof fallback === "string" && fallback.trim() ? fallback : "unknown error";
  const errorValue = result?.error;

  if (typeof errorValue === "string" && errorValue.trim()) {
    return { message: errorValue.trim() };
  }

  if (errorValue && typeof errorValue === "object") {
    const errorObj = errorValue as Record<string, unknown>;
    const message =
      typeof errorObj.message === "string" && errorObj.message.trim()
        ? errorObj.message.trim()
        : typeof errorObj.display === "string" && errorObj.display.trim()
          ? errorObj.display.trim()
          : typeof errorObj.kind === "string" && errorObj.kind.trim()
            ? `${errorObj.kind.trim()} error`
            : "";
    if (message) {
      return {
        message,
        kind: typeof errorObj.kind === "string" ? errorObj.kind : undefined,
        display: typeof errorObj.display === "string" ? errorObj.display : undefined,
        code: typeof errorObj.code === "string" ? errorObj.code : undefined,
      };
    }
  }

  if (typeof result?.reason === "string" && result.reason.trim()) {
    return { message: result.reason.trim() };
  }

  if (typeof result?.terminationReason === "string" && result.terminationReason.trim()) {
    const terminationReason = result.terminationReason.trim();
    if (
      terminationReason === "normal" &&
      typeof result?.exitCode === "number" &&
      result.exitCode !== 0
    ) {
      return { message: `exit code ${result.exitCode}` };
    }
    return { message: `termination: ${terminationReason}` };
  }
  if (typeof result?.status === "number") {
    const statusText = typeof result.statusText === "string" ? result.statusText.trim() : "";
    if (result.status > 0) {
      return { message: `HTTP ${result.status}${statusText ? ` ${statusText}` : ""}` };
    }
    if (statusText && statusText.toLowerCase() !== "error") {
      return { message: statusText };
    }
  }
  if (typeof result?.exitCode === "number") {
    return { message: `exit code ${result.exitCode}` };
  }
  return { message: fallbackMessage };
}
