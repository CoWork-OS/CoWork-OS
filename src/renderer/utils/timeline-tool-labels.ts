/**
 * User-facing labels for agent tool calls (timeline / step feed).
 * Prefer plain language over raw tool ids (snake_case).
 */

const TRUNC = 72;

export function truncateLabel(s: string, max = TRUNC): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asTrimmedStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function fileBase(path: string): string {
  return path.split("/").pop() || path;
}

function parentDirBase(path: string): string {
  const parts = path.split("/").filter((part) => part.length > 0);
  if (parts.length < 2) return "";
  return parts[parts.length - 2] || "";
}

function humanizeIdentifier(value: string): string {
  const normalized = value
    .trim()
    .replace(/\.(?:md|markdown)$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ");
  if (!normalized) return "";
  return normalized.replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

function formatSkillLabel(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "skill";
  return /\bskill$/i.test(trimmed) ? trimmed : `${trimmed} skill`;
}

export function isSkillToolName(toolName: string | undefined): boolean {
  const normalized = (toolName || "").trim().toLowerCase();
  return normalized === "skill" || normalized === "use_skill" || normalized === "run_skill";
}

function skillNameFromPayload(values: Record<string, unknown>): string {
  const rawName =
    asTrimmedString(values.skillName) ||
    asTrimmedString(values.skill_name) ||
    asTrimmedString(values.name) ||
    asTrimmedString(values.title) ||
    asTrimmedString(values.skill) ||
    asTrimmedString(values.skillId) ||
    asTrimmedString(values.skill_id) ||
    asTrimmedString(values.id);
  return rawName ? humanizeIdentifier(rawName) : "";
}

function skillNameFromSkillPath(path: string): string {
  const base = fileBase(path);
  if (!/^SKILL\.md$/i.test(base)) return "";
  return humanizeIdentifier(parentDirBase(path));
}

function skillNameFromToolInput(input: Record<string, unknown>): string {
  return skillNameFromPayload(input) || skillNameFromSkillPath(asTrimmedString(input.path));
}

function skillNamesFromReadFilesResult(result: Record<string, unknown>): string[] {
  const files = Array.isArray(result.files) ? result.files : [];
  const names = files
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "";
      return skillNameFromSkillPath(asTrimmedString((entry as Record<string, unknown>).path));
    })
    .filter((entry) => entry.length > 0);
  return Array.from(new Set(names));
}

function skillReadLabel(name: string, tense: "running" | "completed"): string {
  const skillLabel = formatSkillLabel(name);
  return tense === "running" ? `Reading ${skillLabel}` : `Read ${skillLabel}`;
}

function summarizeList(values: string[], maxItems = 2): string {
  const items = values.slice(0, maxItems);
  if (items.length === 0) return "";
  const joined = items.join(", ");
  return values.length > maxItems ? `${joined}, +${values.length - maxItems} more` : joined;
}

export function isBrowserToolName(toolName: string | undefined): boolean {
  return typeof toolName === "string" && toolName.trim().startsWith("browser_");
}

function browserToolDisplayName(toolName: string): string {
  switch (toolName) {
    case "browser_navigate":
      return "Browser navigate";
    case "browser_screenshot":
      return "Browser take screenshot";
    case "browser_snapshot":
      return "Browser snapshot";
    case "browser_get_content":
      return "Browser get content";
    case "browser_get_text":
      return "Browser get text";
    case "browser_evaluate":
      return "Browser evaluate";
    case "browser_click":
      return "Browser click";
    case "browser_hover":
      return "Browser hover";
    case "browser_drag":
      return "Browser drag";
    case "browser_fill":
      return "Browser fill";
    case "browser_type":
      return "Browser type";
    case "browser_press":
      return "Browser press";
    case "browser_select":
      return "Browser select";
    case "browser_upload_file":
      return "Browser upload file";
    case "browser_handle_dialog":
      return "Browser handle dialog";
    case "browser_scroll":
      return "Browser scroll";
    case "browser_wait":
      return "Browser wait";
    case "browser_tabs":
      return "Browser tabs";
    case "browser_switch_tab":
      return "Browser switch tab";
    case "browser_close_tab":
      return "Browser close tab";
    case "browser_back":
      return "Browser back";
    case "browser_forward":
      return "Browser forward";
    case "browser_reload":
      return "Browser reload";
    case "browser_console":
      return "Browser console";
    case "browser_network":
      return "Browser network";
    case "browser_downloads":
      return "Browser downloads";
    case "browser_storage":
      return "Browser storage";
    case "browser_emulate":
      return "Browser emulate";
    case "browser_trace_start":
      return "Browser trace start";
    case "browser_trace_stop":
      return "Browser trace stop";
    case "browser_save_pdf":
      return "Browser save PDF";
    case "browser_close":
      return "Browser close";
    default:
      return "Browser";
  }
}

function friendlyBrowserRunningLabel(toolName: string): string {
  return browserToolDisplayName(toolName);
}

function friendlyBrowserCompletedLabel(toolName: string): string {
  return browserToolDisplayName(toolName);
}

/** Short label for parallel lane "running" state */
export function friendlyToolRunningLabel(toolName: string | undefined): string {
  const t = (toolName || "").trim();
  if (!t) return "Running tool";
  if (isBrowserToolName(t)) return friendlyBrowserRunningLabel(t);
  if (isSkillToolName(t)) return "Reading a skill";
  switch (t) {
    case "web_fetch":
    case "http_request":
      return "Fetching a web page";
    case "web_search":
      return "Searching the web";
    case "read_file":
    case "read_files":
      return "Reading a file";
    case "list_directory":
      return "Listing a folder";
    case "glob":
      return "Finding files";
    case "grep":
      return "Searching in files";
    case "search_files":
      return "Searching the codebase";
    case "write_file":
      return "Writing a file";
    case "edit_file":
      return "Editing a file";
    case "run_command":
      return "Running a command";
    case "task_history":
      return "Checking task history";
    default:
      return `Using ${t.replace(/_/g, " ")}`;
  }
}

function hostOrPathFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const suffix = `${u.pathname || ""}${u.search || ""}`;
    const normalizedSuffix = suffix && suffix !== "/" ? suffix : "";
    return `${u.hostname || ""}${normalizedSuffix}` || url;
  } catch {
    return url;
  }
}

type ToolInput = Record<string, unknown> | null | undefined;
type ToolResult = Record<string, unknown> | null | undefined;

/** Title for a tool_call row (present tense / intent). */
export function friendlyToolCallTitle(tool: string | undefined, input: ToolInput): string {
  const tc = (tool || "").trim();
  if (!tc) return "Tool call";

  const ins = input && typeof input === "object" ? input : {};

  if (tc === "web_fetch" || tc === "http_request") {
    const url = typeof ins.url === "string" ? ins.url.trim() : "";
    return url ? `Fetching ${truncateLabel(hostOrPathFromUrl(url), 60)}` : "Fetching a web page";
  }
  if (tc === "web_search") {
    const q = typeof ins.query === "string" ? ins.query.trim() : "";
    const provider = typeof ins.provider === "string" ? ins.provider.trim() : "";
    const via = provider ? ` via ${provider.charAt(0).toUpperCase() + provider.slice(1)}` : "";
    return q ? `Web search${via}: ${truncateLabel(q, 52)}` : `Web search${via}`;
  }
  if (isBrowserToolName(tc)) {
    if (tc === "browser_navigate") {
      const url = typeof ins.url === "string" ? ins.url.trim() : "";
      return url
        ? `Browser navigate: ${truncateLabel(hostOrPathFromUrl(url), 52)}`
        : "Browser navigate";
    }
    if (tc === "browser_get_text") {
      const selector = asTrimmedString(ins.selector) || asTrimmedString(ins.ref);
      return selector ? `Browser get text: ${truncateLabel(selector, 42)}` : "Browser get text";
    }
    if (tc === "browser_click") {
      const target = asTrimmedString(ins.ref) || asTrimmedString(ins.selector);
      return target ? `Browser click: ${truncateLabel(target, 44)}` : "Browser click";
    }
    if (tc === "browser_fill" || tc === "browser_type") {
      const target = asTrimmedString(ins.ref) || asTrimmedString(ins.selector);
      return target ? `Browser type: ${truncateLabel(target, 42)}` : "Browser type";
    }
    return friendlyBrowserRunningLabel(tc);
  }
  if (isSkillToolName(tc)) {
    return skillReadLabel(skillNameFromToolInput(ins), "running");
  }
  if (tc === "read_file") {
    const path = asTrimmedString(ins.path);
    const skillName = skillNameFromSkillPath(path);
    if (skillName) return skillReadLabel(skillName, "running");
    const base = path ? fileBase(path) : "";
    return base ? `Read ${base}` : "Read file";
  }
  if (tc === "read_files") {
    const path = asTrimmedString(ins.path);
    const skillName = skillNameFromSkillPath(path);
    if (skillName) return skillReadLabel(skillName, "running");
    const patterns = asTrimmedStringArray(ins.patterns);
    if (patterns.length > 0) {
      const skillNames = patterns.map(skillNameFromSkillPath).filter((entry) => entry.length > 0);
      if (skillNames.length === 1 && patterns.length === 1) {
        return skillReadLabel(skillNames[0], "running");
      }
      return `Read files: ${truncateLabel(summarizeList(patterns), 52)}`;
    }
    return path ? `Read files in ${truncateLabel(path, 48)}` : "Read files";
  }
  if (tc === "grep") {
    const pattern = asTrimmedString(ins.pattern);
    return pattern ? `Search in files: ${truncateLabel(pattern, 48)}` : "Search in files";
  }
  if (tc === "search_files") {
    const query = asTrimmedString(ins.query) || asTrimmedString(ins.pattern);
    return query ? `Search files: ${truncateLabel(query, 48)}` : "Search files";
  }
  if (tc === "run_command") {
    const cmd = typeof ins.command === "string" ? ins.command.trim() : "";
    return cmd ? `Run: ${truncateLabel(cmd, 56)}` : "Run command";
  }
  if (tc === "write_file") {
    const path = typeof ins.path === "string" ? ins.path.trim() : "";
    const base = path ? path.split("/").pop() || path : "";
    return base ? `Write ${base}` : "Write file";
  }
  if (tc === "edit_file") {
    const path = typeof ins.file_path === "string" ? ins.file_path.trim() : "";
    const base = path ? path.split("/").pop() || path : "";
    return base ? `Edit ${base}` : "Edit file";
  }
  if (tc === "glob") {
    const pattern = asTrimmedString(ins.pattern);
    return pattern ? `Find files: ${truncateLabel(pattern, 52)}` : "Find files";
  }

  return friendlyToolRunningLabel(tc);
}

/** Title for a tool_result row when shown alone (past tense / outcome). */
export function friendlyToolResultTitle(
  tool: string | undefined,
  result: ToolResult,
  success: boolean,
): string {
  const tc = (tool || "").trim();
  const res = result && typeof result === "object" ? result : {};
  const err = typeof res.error === "string" ? res.error : "";

  if (!success && err) {
    const clipped = truncateLabel(err, 64);
    return tc ? `${friendlyPastVerb(tc)} — ${clipped}` : clipped;
  }

  if (tc === "web_fetch" || tc === "http_request") {
    const url = typeof res.url === "string" ? res.url.trim() : "";
    const title = typeof res.title === "string" ? res.title.trim() : "";
    const bit = title || (url ? hostOrPathFromUrl(url) : "");
    return bit ? `Fetched ${truncateLabel(bit, 64)}` : "Fetched page";
  }
  if (tc === "web_search") {
    const q = typeof res.query === "string" ? res.query.trim() : "";
    const provider = typeof res.provider === "string" ? res.provider.trim() : "";
    const via = provider ? ` via ${provider.charAt(0).toUpperCase() + provider.slice(1)}` : "";
    return q ? `Searched${via}: ${truncateLabel(q, 52)}` : `Search complete${via}`;
  }
  if (isBrowserToolName(tc)) {
    const url = typeof res.url === "string" ? res.url.trim() : "";
    const title = typeof res.title === "string" ? res.title.trim() : "";
    const page = title || (url ? hostOrPathFromUrl(url) : "");
    if (tc === "browser_navigate") {
      return page ? `Browser navigate: ${truncateLabel(page, 52)}` : "Browser navigate";
    }
    const label = friendlyBrowserCompletedLabel(tc);
    return page ? `${label} — ${truncateLabel(page, 48)}` : label;
  }
  if (isSkillToolName(tc)) {
    return skillReadLabel(skillNameFromPayload(res), "completed");
  }
  if (tc === "read_file") {
    const path = asTrimmedString(res.path);
    const skillName = skillNameFromSkillPath(path);
    if (skillName) return skillReadLabel(skillName, "completed");
    const base = path ? fileBase(path) : "";
    return base ? `Read ${base}` : "Read file";
  }
  if (tc === "read_files") {
    const skillNames = skillNamesFromReadFilesResult(res);
    if (skillNames.length === 1) return skillReadLabel(skillNames[0], "completed");
    if (skillNames.length > 1) {
      return `Read ${skillNames.length} skills`;
    }
    const files = Array.isArray(res.files)
      ? res.files
          .map((entry) => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "";
            return asTrimmedString((entry as Record<string, unknown>).path);
          })
          .filter((entry) => entry.length > 0)
      : [];
    if (files.length === 1) return `Read ${fileBase(files[0])}`;
    if (files.length > 1) {
      return `Read files: ${truncateLabel(summarizeList(files.map((path) => fileBase(path))), 52)}`;
    }
    const patterns = asTrimmedStringArray(res.includePatterns);
    if (patterns.length > 0) {
      return `Read files: ${truncateLabel(summarizeList(patterns), 52)}`;
    }
    return "Read files";
  }
  if (tc === "grep") {
    const pattern = asTrimmedString(res.pattern);
    return pattern
      ? `Searched in files: ${truncateLabel(pattern, 52)}`
      : `${friendlyPastVerb(tc)}${detailSuffix(res, tc)}`;
  }
  if (tc === "search_files") {
    const query = asTrimmedString(res.query) || asTrimmedString(res.pattern);
    return query
      ? `Searched files: ${truncateLabel(query, 52)}`
      : `${friendlyPastVerb(tc)}${detailSuffix(res, tc)}`;
  }

  return `${friendlyPastVerb(tc)}${detailSuffix(res, tc)}`;
}

/** Lane row when a parallel tool lane finishes */
export function friendlyToolLaneCompletedLabel(
  toolName: string | undefined,
  failed: boolean,
): string {
  const t = (toolName || "").trim();
  if (!t) return failed ? "Step failed" : "Done";
  if (failed) {
    if (isBrowserToolName(t)) return "Browser action failed";
    switch (t) {
      case "web_fetch":
      case "http_request":
        return "Fetch failed";
      case "web_search":
        return "Search failed";
      case "skill":
      case "use_skill":
      case "run_skill":
        return "Skill read failed";
      default:
        return `${friendlyToolRunningLabel(t)} failed`;
    }
  }
  if (isSkillToolName(t)) return "Read skill";
  if (isBrowserToolName(t)) return friendlyBrowserCompletedLabel(t);
  switch (t) {
    case "web_fetch":
    case "http_request":
      return "Fetched page";
    case "web_search":
      return "Searched web";
    case "grep":
    case "search_files":
      return "Search complete";
    default:
      return `${friendlyPastVerb(t)}`;
  }
}

function friendlyPastVerb(tool: string): string {
  if (isBrowserToolName(tool)) return friendlyBrowserCompletedLabel(tool);
  if (isSkillToolName(tool)) return "Read skill";
  switch (tool) {
    case "web_fetch":
    case "http_request":
      return "Fetched page";
    case "web_search":
      return "Searched web";
    case "grep":
      return "Searched in files";
    case "search_files":
      return "Searched files";
    case "read_file":
      return "Read file";
    case "read_files":
      return "Read files";
    case "run_command":
      return "Ran command";
    case "write_file":
      return "Wrote file";
    case "edit_file":
      return "Edited file";
    case "glob":
      return "Matched files";
    case "task_history":
      return "Loaded task history";
    default:
      return `${tool.replace(/_/g, " ")} done`;
  }
}

function detailSuffix(res: Record<string, unknown>, tool: string): string {
  if (typeof res.path === "string" && res.path.trim()) {
    const base = fileBase(res.path);
    return ` — ${truncateLabel(base, 48)}`;
  }
  if (Array.isArray(res.matches) && res.matches.length > 0) {
    return ` — ${res.matches.length} match${res.matches.length === 1 ? "" : "es"}`;
  }
  if (Array.isArray(res.files) && res.files.length > 0) {
    return ` — ${res.files.length} file${res.files.length === 1 ? "" : "s"}`;
  }
  if (res.content && typeof res.content === "string") {
    const lines = res.content.split("\n").length;
    return ` — ${lines} lines`;
  }
  if (tool === "run_command" && typeof res.exitCode === "number") {
    return res.exitCode === 0 ? "" : ` (exit ${res.exitCode})`;
  }
  return "";
}
