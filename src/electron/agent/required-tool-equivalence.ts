import { canonicalizeToolName, getToolSemantics } from "./tool-semantics";

/**
 * Step contracts name concrete tools ("use grep", "edit the file"), but several
 * tools perform the same operation. A required tool is satisfied by any
 * successful call from its equivalence group, so a step that asked for
 * write_file is not failed for a correct edit_file call (and vice versa), and
 * "use grep" accepts search_files or `rg` through run_command.
 */
export type RequiredToolGroup = "file_mutation" | "search" | "fetch";

const SEARCH_TOOLS = new Set(["grep", "search_files", "glob"]);
const FETCH_TOOLS = new Set([
  "web_fetch",
  "http_request",
  "browser_get_content",
  "browser_get_text",
]);
// A search program at command position: "rg -n getUser src", "cd src && git grep x".
const SEARCH_COMMAND_REGEX =
  /(?:^|[;&|(]\s*|\bxargs\s+)(?:rg|grep|egrep|fgrep|ag|ack|find|fd|git\s+grep)(?=\s|$)/;

/** Content-writing file tools per tool semantics (write_file, edit_file). */
function isFileContentMutationTool(toolName: string): boolean {
  const semantics = getToolSemantics(toolName);
  return (
    semantics?.mutatesFile === true &&
    semantics.artifactKind === "file" &&
    (semantics.dedupeClass === "file_write" || semantics.dedupeClass === "file_edit")
  );
}

export function getRequiredToolGroup(toolName: string): RequiredToolGroup | null {
  const canonical = canonicalizeToolName(toolName);
  if (isFileContentMutationTool(canonical)) return "file_mutation";
  if (SEARCH_TOOLS.has(canonical)) return "search";
  if (FETCH_TOOLS.has(canonical)) return "fetch";
  return null;
}

function getCallGroup(toolName: string, input: unknown): RequiredToolGroup | null {
  const canonical = canonicalizeToolName(toolName);
  if (canonical === "run_command") {
    // Shell file writes are bridged through verified mutation evidence, so a
    // command only stands in for a search requirement here.
    const command =
      input && typeof input === "object" ? (input as { command?: unknown }).command : undefined;
    return typeof command === "string" && SEARCH_COMMAND_REGEX.test(command.trim())
      ? "search"
      : null;
  }
  return getRequiredToolGroup(canonical);
}

/**
 * Required tools, other than the called tool itself, that a successful call
 * satisfies because they belong to the same equivalence group.
 */
export function getEquivalentRequiredToolsForCall(
  requiredTools: Iterable<string>,
  toolName: string,
  input: unknown,
): string[] {
  const group = getCallGroup(toolName, input);
  if (!group) return [];
  const called = canonicalizeToolName(toolName);
  const satisfied: string[] = [];
  for (const requiredTool of requiredTools) {
    const canonical = canonicalizeToolName(requiredTool);
    if (canonical === called) continue;
    if (getRequiredToolGroup(canonical) === group) satisfied.push(requiredTool);
  }
  return satisfied;
}

const GROUP_NUDGE_LABELS: Record<RequiredToolGroup, string> = {
  file_mutation:
    "a file change (edit_file for targeted edits to an existing file; write_file only for a new file or a deliberate full rewrite)",
  search: "a search (grep, search_files, glob, or rg/grep via run_command)",
  fetch: "a content fetch (web_fetch, http_request, or browser_get_content)",
};

/**
 * Describe pending required tools by group for model-facing nudges. Naming a
 * specific file tool ("use write_file now") after an edit invites rewriting the
 * file from memory, so file mutation requirements are described as a group.
 */
export function describeRequiredToolsForNudge(toolNames: Iterable<string>): string[] {
  const descriptions: string[] = [];
  const seenGroups = new Set<RequiredToolGroup>();
  for (const toolName of toolNames) {
    const group = getRequiredToolGroup(toolName);
    if (!group) {
      if (!descriptions.includes(toolName)) descriptions.push(toolName);
      continue;
    }
    if (seenGroups.has(group)) continue;
    seenGroups.add(group);
    descriptions.push(GROUP_NUDGE_LABELS[group]);
  }
  return descriptions;
}
