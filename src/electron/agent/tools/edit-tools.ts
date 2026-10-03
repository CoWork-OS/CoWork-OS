import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isUtf8 } from "buffer";
import { createHash, randomUUID } from "crypto";
import { Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import {
  checkProjectAccess,
  getProjectIdFromWorkspaceRelPath,
  getWorkspaceRelativePosixPath,
} from "../../security/project-access";
import {
  authorizeToolActionWithFallback,
  evaluateWorkspaceFilesystemAccess,
  resolveAccessControlledPath,
} from "../../security/access-profile-paths";
import { LLMTool } from "../llm/types";
import { GuardrailManager } from "../../guardrails/guardrail-manager";
import { getUserDataDir } from "../../utils/user-data-dir";

function hasStableFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  if (left.dev === 0 || right.dev === 0 || left.ino === 0 || right.ino === 0) return true;
  return left.dev === right.dev && left.ino === right.ino;
}

interface EditRecoveryRecord {
  version: 1;
  path: string;
  fileDev: number;
  fileIno: number;
  ownerPid: number;
  // Optional for backward compatibility with records written before these fields existed.
  // ownerBootTimeMs lets a reboot (and therefore PID reuse) prove the owner is gone;
  // transactionId makes every record's checksum unique so cleanup can verify identity.
  ownerBootTimeMs?: number;
  transactionId?: string;
  state: "prepared" | "committed";
  beforeBase64: string;
  afterBase64: string;
  beforeSha256: string;
  afterSha256: string;
  checksum: string;
}

interface LoadedEditRecoveryRecord {
  record: EditRecoveryRecord;
  /** Identity of the record file itself, used to confirm cleanup removes the record it read. */
  recordDev: number;
  recordIno: number;
}

const editPathLocks = new Map<string, Promise<void>>();
const activeEditTransactions = new Set<string>();
const EDIT_RECOVERY_DIRECTORY = "edit-recovery";
const EDIT_RECOVERY_RECORD_OVERHEAD_BYTES = 16 * 1024;
// Separate from the configurable per-file guardrail: recovery retains two
// versions and must stay bounded even when the ordinary size guardrail is off.
const MAX_EDIT_RECOVERY_CONTENT_BYTES = 128 * 1024 * 1024;

async function withEditPathLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = editPathLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const queued = previous.then(() => held);
  editPathLocks.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (editPathLocks.get(key) === queued) editPathLocks.delete(key);
  }
}

function editRecoveryPayload(record: EditRecoveryRecord): Omit<EditRecoveryRecord, "checksum"> {
  const { checksum: _checksum, ...payload } = record;
  return payload;
}

function editRecoveryChecksum(record: EditRecoveryRecord): string {
  return createHash("sha256")
    .update(JSON.stringify(editRecoveryPayload(record)))
    .digest("hex");
}

function hashEditContent(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function assertEditContentSize(sizeBytes: number): void {
  const check = GuardrailManager.isFileSizeExceeded(sizeBytes);
  if (check.exceeded) {
    throw new Error(
      `File size limit exceeded: ${check.sizeMB.toFixed(2)}MB exceeds limit of ${check.limitMB}MB.`,
    );
  }
  if (sizeBytes > MAX_EDIT_RECOVERY_CONTENT_BYTES) {
    throw new Error("Edit recovery storage supports at most 128 MiB per file version.");
  }
}

function getEditRecoveryRecordLimitBytes(): number {
  return (
    Math.ceil((2 * MAX_EDIT_RECOVERY_CONTENT_BYTES * 4) / 3) + EDIT_RECOVERY_RECORD_OVERHEAD_BYTES
  );
}

function getEditRecoveryRecordPath(directory: string, stats: fs.Stats, realPath: string): string {
  // Processes using the same profile must contend even when they use different
  // hard-link names. Different user-data profiles remain separate coordinators.
  const id = createHash("sha256").update(getEditLockKey(stats, realPath)).digest("hex");
  return path.join(directory, `${id}.json`);
}

function getEditLockKey(stats: fs.Stats, realPath: string): string {
  if (stats.dev !== 0 && stats.ino !== 0) return `inode:${stats.dev}:${stats.ino}`;
  return `path:${realPath}`;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: Any) {
    return error.code !== "ESRCH";
  }
}

// Boot time derived from wall clock minus uptime drifts with clock adjustments, so allow a
// generous margin. A false "same boot" only falls back to the PID probe; a false "different
// boot" would discard a live record, so the tolerance errs toward treating the owner as alive.
const BOOT_TIME_TOLERANCE_MS = 10 * 60 * 1000;

function getCurrentBootTimeMs(): number {
  return Math.round(Date.now() - os.uptime() * 1000);
}

/** Liveness of a record owned by another PID (same-PID ownership is tracked in-process). */
function isOtherRecoveryRecordOwnerAlive(record: EditRecoveryRecord): boolean {
  const hasBootTime = typeof record.ownerBootTimeMs === "number";
  if (
    hasBootTime &&
    Math.abs((record.ownerBootTimeMs as number) - getCurrentBootTimeMs()) > BOOT_TIME_TOLERANCE_MS
  ) {
    // The owner ran before the last reboot; its PID may now belong to an unrelated process.
    return false;
  }
  // Legacy records (no boot time) keep the previous conservative behavior: any error other
  // than ESRCH, including EPERM, means alive. With a matching boot time, EPERM still means a
  // process exists under that PID in this boot, so it is treated as alive too.
  return isProcessAlive(record.ownerPid);
}

function cleanupStaleRecoveryTemps(directory: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return;
  }
  for (const name of names) {
    const match = /^[a-f0-9]{64}\.(\d+)\.[a-f0-9-]+\.tmp$/.exec(name);
    if (!match || isProcessAlive(Number(match[1]))) continue;
    const candidate = path.join(directory, name);
    try {
      const stats = fs.lstatSync(candidate);
      if (
        stats.isFile() &&
        !stats.isSymbolicLink() &&
        (process.platform === "win32" || (stats.mode & 0o077) === 0)
      ) {
        fs.unlinkSync(candidate);
      }
    } catch {
      // Stale temp cleanup is best effort; never block the user edit on it.
    }
  }
}

function writeBufferFully(fd: number, buffer: Buffer): void {
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset, offset);
    if (written <= 0) throw new Error("File write made no progress");
    offset += written;
  }
}

function readDescriptorBuffer(fd: number): Buffer {
  const initial = fs.fstatSync(fd);
  if (!initial.isFile()) throw new Error("Edit target is not a regular file");
  assertEditContentSize(initial.size);
  const content = Buffer.alloc(initial.size);
  let offset = 0;
  while (offset < content.length) {
    const read = fs.readSync(fd, content, offset, content.length - offset, offset);
    if (read === 0) break;
    offset += read;
  }
  const latest = fs.fstatSync(fd);
  if (offset !== content.length || latest.size !== initial.size) {
    throw new Error("File changed while its contents were being read; retry the edit.");
  }
  return content;
}

function writeRecoveryRecord(
  recordPath: string,
  record: EditRecoveryRecord,
  create: boolean,
): void {
  const bytes = Buffer.from(JSON.stringify(record), "utf8");
  if (bytes.length > getEditRecoveryRecordLimitBytes()) {
    throw new Error("File edit recovery record exceeds the independent recovery storage limit.");
  }
  const noFollow = (fs.constants as Any).O_NOFOLLOW;
  const noFollowFlag = typeof noFollow === "number" ? noFollow : 0;
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | noFollowFlag;
  const tempPath = `${recordPath}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | null = null;
  let linkedRecord = false;
  try {
    fd = fs.openSync(tempPath, flags | fs.constants.O_EXCL, 0o600);
    writeBufferFully(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    if (create) {
      fs.linkSync(tempPath, recordPath);
      linkedRecord = true;
      fs.unlinkSync(tempPath);
    } else {
      fs.renameSync(tempPath, recordPath);
    }
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the write error.
      }
    }
    if (linkedRecord) {
      try {
        fs.unlinkSync(recordPath);
      } catch {
        // Preserve the write error.
      }
    }
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Preserve the write error.
    }
    throw error;
  }
}

const ASCII_EDIT_TEXT_PATTERN = /^[\x01-\x7f]*$/;

function firstInvalidUtf8Line(content: Buffer): number {
  // A newline byte never occurs inside a UTF-8 sequence, so lines can be validated one by one.
  let line = 1;
  for (let start = 0; ; line += 1) {
    const newline = content.indexOf(0x0a, start);
    const end = newline === -1 ? content.length : newline;
    if (!isUtf8(content.subarray(start, end)) || newline === -1) return line;
    start = newline + 1;
  }
}

/**
 * Decode file bytes for matching. UTF-8 round-trips exactly. Any other encoding is edited only
 * when old_string and new_string are ASCII: its bytes are then read one-to-one as Latin-1, so
 * everything outside the replaced ASCII text is written back byte-for-byte instead of being
 * re-encoded (which turned every Windows-1252/Latin-1 "é" into U+FFFD).
 */
function decodeEditableText(
  content: Buffer,
  oldString: string,
  newString: string,
): { text: string; encoding: "utf8" | "latin1" } {
  if (isUtf8(content)) return { text: content.toString("utf8"), encoding: "utf8" };
  const utf16Bom =
    content.length >= 2 &&
    ((content[0] === 0xff && content[1] === 0xfe) || (content[0] === 0xfe && content[1] === 0xff));
  if (utf16Bom || content.includes(0)) {
    throw new Error(
      "File is not UTF-8 text: it contains NUL bytes or a UTF-16 byte order mark (binary, UTF-16 or UTF-32). " +
        "edit_file only edits UTF-8 text and left the file unchanged.",
    );
  }
  if (!ASCII_EDIT_TEXT_PATTERN.test(oldString) || !ASCII_EDIT_TEXT_PATTERN.test(newString)) {
    throw new Error(
      `File is not valid UTF-8 (first invalid byte on line ${firstInvalidUtf8Line(content)}); it is probably in a legacy encoding such as Windows-1252, Latin-1 or Shift_JIS. ` +
        "edit_file left it unchanged: rewriting it as UTF-8 would corrupt its other non-ASCII characters, which read_file shows as U+FFFD. " +
        "Edits whose old_string and new_string are plain ASCII are applied byte-for-byte; to change non-ASCII text, convert the file to UTF-8 first with the user's agreement. " +
        "Do not recreate it with write_file.",
    );
  }
  return { text: content.toString("latin1"), encoding: "latin1" };
}

/**
 * In a non-UTF-8 file, a byte in 0x40-0x7E right after a non-ASCII byte can be the second half of
 * a Shift_JIS/GBK/Big5 character, so an ASCII match starting there could split that character.
 */
function assertLegacyMatchBoundaries(text: string, needle: string): void {
  const first = needle.charCodeAt(0);
  if (first < 0x40 || first > 0x7e) return;
  for (
    let index = text.indexOf(needle);
    index !== -1;
    index = text.indexOf(needle, index + needle.length)
  ) {
    if (index > 0 && text.charCodeAt(index - 1) >= 0x80) {
      throw new Error(
        `old_string would start right after a non-ASCII byte on line ${lineNumberAt(text, index)} of this non-UTF-8 file, where it could be the second half of a multi-byte character, so edit_file left the file unchanged. ` +
          "Choose an old_string that starts after ASCII text (for example at a space or punctuation), or convert the file to UTF-8 first with the user's agreement.",
      );
    }
  }
}

/** One way of reading old_string/new_string against the file; tried in order until one matches. */
interface EditMatchCandidate {
  oldString: string;
  newString: string;
  /** Set when line-number prefixes were stripped: the 1-based line the match must start on. */
  expectedLine?: number;
}

// Prefixes copied from numbered views: `cat -n`/`nl` (tab), `grep -n` (colon), arrow and pipe gutters.
const LINE_NUMBER_PREFIX_PATTERN = /^[ \t]*(\d+)(?:\t|:|→|[ \t]?\|[ \t]?)/;

function withLineEndings(value: string, lineEnding: "\n" | "\r\n"): string {
  return value.replace(/\r?\n/g, lineEnding);
}

/** The file's line ending when every line uses the same one; null for mixed or single-line files. */
function detectConsistentLineEnding(text: string): "\n" | "\r\n" | null {
  let newlines = 0;
  let crlf = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    newlines += 1;
    if (index > 0 && text.charCodeAt(index - 1) === 13) crlf += 1;
  }
  if (newlines === 0) return null;
  if (crlf === newlines) return "\r\n";
  return crlf === 0 ? "\n" : null;
}

/**
 * Remove consecutive line-number prefixes (e.g. "    12\t") that a model copied from a numbered
 * view. Returns null unless every line carries one and the numbers increase by one.
 */
function stripLineNumberPrefixes(value: string): { text: string; firstLine: number } | null {
  const lines = value.split("\n");
  const hasTrailingNewline = lines.length > 1 && lines[lines.length - 1] === "";
  const contentLines = hasTrailingNewline ? lines.slice(0, -1) : lines;
  let firstLine = 0;
  const stripped: string[] = [];
  for (const [index, line] of contentLines.entries()) {
    const match = LINE_NUMBER_PREFIX_PATTERN.exec(line);
    if (!match) return null;
    const lineNumber = Number(match[1]);
    if (index === 0) firstLine = lineNumber;
    else if (lineNumber !== firstLine + index) return null;
    stripped.push(line.slice(match[0].length));
  }
  if (firstLine < 1) return null;
  return { text: stripped.join("\n") + (hasTrailingNewline ? "\n" : ""), firstLine };
}

function lineNumberAt(text: string, offset: number): number {
  let line = 1;
  let index = text.indexOf("\n");
  while (index !== -1 && index < offset) {
    line += 1;
    index = text.indexOf("\n", index + 1);
  }
  return line;
}

/**
 * Exact text first, then the same text with the other line-ending convention (models emit LF
 * even for CRLF files), then without numbered-view prefixes. new_string follows the file's line
 * ending whenever the file uses only one, so an edit never mixes LF and CRLF lines.
 */
function buildEditMatchCandidates(
  text: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): EditMatchCandidate[] {
  const fileLineEnding = detectConsistentLineEnding(text);
  const candidates: EditMatchCandidate[] = [];
  const addWithLineEndings = (oldValue: string, newValue: string, expectedLine?: number) => {
    const variants: Array<[string, string]> = [
      [oldValue, fileLineEnding ? withLineEndings(newValue, fileLineEnding) : newValue],
    ];
    if (oldValue.includes("\n") && text.includes("\r\n")) {
      variants.push([withLineEndings(oldValue, "\r\n"), withLineEndings(newValue, "\r\n")]);
    }
    if (oldValue.includes("\r\n")) {
      variants.push([withLineEndings(oldValue, "\n"), withLineEndings(newValue, "\n")]);
    }
    for (const [variantOld, variantNew] of variants) {
      if (candidates.some((candidate) => candidate.oldString === variantOld)) continue;
      candidates.push({ oldString: variantOld, newString: variantNew, expectedLine });
    }
  };

  addWithLineEndings(oldString, newString);
  // Line numbers address a single location, so prefixes are never stripped for replace_all.
  const strippedOld = replaceAll ? null : stripLineNumberPrefixes(oldString);
  if (strippedOld) {
    const strippedNew = stripLineNumberPrefixes(newString);
    addWithLineEndings(
      strippedOld.text,
      strippedNew && strippedNew.firstLine === strippedOld.firstLine ? strippedNew.text : newString,
      strippedOld.firstLine,
    );
  }
  return candidates;
}

// Miss diagnostics scan the whole file; beyond this size they would cost more than they help.
const EDIT_MISS_ANALYSIS_MAX_CHARS = 4 * 1024 * 1024;
const EDIT_MISS_EXCERPT_MAX_LINES = 12;
const EDIT_MISS_EXCERPT_MAX_LINE_CHARS = 240;
const EDIT_MISS_MIN_SIMILARITY = 0.5;
const WORD_TOKEN_PATTERN = /[\p{L}\p{N}_]+/gu;

function formatLineRange(startLine: number, endLine: number): string {
  return startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
}

function clipForMessage(value: string): string {
  return value.length > EDIT_MISS_EXCERPT_MAX_LINE_CHARS
    ? `${value.slice(0, EDIT_MISS_EXCERPT_MAX_LINE_CHARS)}…`
    : value;
}

/** Offset in text of the character at compactIndex in text with all whitespace removed. */
function offsetOfCompactIndex(text: string, compactIndex: number): number {
  const whitespace = /\s+/g;
  let removed = 0;
  for (
    let match = whitespace.exec(text);
    match && match.index - removed <= compactIndex;
    match = whitespace.exec(text)
  ) {
    removed += match[0].length;
  }
  return compactIndex + removed;
}

function findWhitespaceInsensitiveMatch(
  text: string,
  target: string,
): { startLine: number; endLine: number } | null {
  const compactTarget = target.replace(/\s+/g, "");
  if (!compactTarget) return null;
  const compactIndex = text.replace(/\s+/g, "").indexOf(compactTarget);
  if (compactIndex === -1) return null;
  const start = offsetOfCompactIndex(text, compactIndex);
  const end = offsetOfCompactIndex(text, compactIndex + compactTarget.length - 1);
  return { startLine: lineNumberAt(text, start), endLine: lineNumberAt(text, end) };
}

/** Window of file lines sharing the most words with target (multiset overlap), if any is close. */
function findMostSimilarLines(
  lines: string[],
  targetLines: string[],
): { startLine: number; endLine: number; score: number } | null {
  const targetTokens = targetLines.join("\n").match(WORD_TOKEN_PATTERN) ?? [];
  if (targetTokens.length === 0 || lines.length === 0) return null;
  const targetCounts = new Map<string, number>();
  for (const token of targetTokens) targetCounts.set(token, (targetCounts.get(token) ?? 0) + 1);
  const lineStats = lines.map((line) => {
    const tokens = line.match(WORD_TOKEN_PATTERN) ?? [];
    return { total: tokens.length, shared: tokens.filter((token) => targetCounts.has(token)) };
  });

  const windowSize = Math.min(targetLines.length, lines.length);
  const windowCounts = new Map<string, number>();
  let overlap = 0;
  let windowTotal = 0;
  const apply = (stats: { total: number; shared: string[] }, delta: 1 | -1) => {
    windowTotal += delta * stats.total;
    for (const token of stats.shared) {
      const cap = targetCounts.get(token) ?? 0;
      const before = windowCounts.get(token) ?? 0;
      windowCounts.set(token, before + delta);
      overlap += Math.min(before + delta, cap) - Math.min(before, cap);
    }
  };

  let best: { startLine: number; endLine: number; score: number } | null = null;
  for (let end = 0; end < lineStats.length; end += 1) {
    apply(lineStats[end], 1);
    if (end >= windowSize) apply(lineStats[end - windowSize], -1);
    if (end < windowSize - 1) continue;
    const score = overlap / Math.max(targetTokens.length, windowTotal);
    if (!best || score > best.score) {
      best = { startLine: end - windowSize + 2, endLine: end + 1, score };
    }
  }
  return best && best.score >= EDIT_MISS_MIN_SIMILARITY ? best : null;
}

/**
 * Explain an old_string miss with the closest region of the file, so the model can copy the
 * current text instead of re-reading the whole file and guessing again.
 */
function describeEditMiss(text: string, oldString: string): string {
  const base =
    "old_string not found in file. Make sure the string matches exactly (including whitespace and indentation).";
  if (text.length > EDIT_MISS_ANALYSIS_MAX_CHARS) {
    return `${base} The file is too large to search for a closest match; use grep to locate the text, then read those lines and copy them exactly.`;
  }

  const stripped = stripLineNumberPrefixes(oldString);
  const prefix = stripped ? LINE_NUMBER_PREFIX_PATTERN.exec(oldString)?.[0] : undefined;
  const prefixNote = prefix
    ? ` old_string seems to start each line with a line-number prefix such as ${JSON.stringify(prefix)}; those numbers are not part of the file.`
    : "";
  const target = (stripped?.text ?? oldString).replace(/\r\n/g, "\n");
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  const excerpt = (startLine: number, endLine: number) => {
    const last = Math.min(endLine, startLine + EDIT_MISS_EXCERPT_MAX_LINES - 1);
    const shown = lines.slice(startLine - 1, last).map(clipForMessage);
    if (endLine > last) shown.push(`[... ${endLine - last} more lines ...]`);
    return `The exact current text of ${formatLineRange(startLine, endLine)} is:\n${shown.join("\n")}`;
  };

  const whitespaceMatch = findWhitespaceInsensitiveMatch(text, target);
  if (whitespaceMatch) {
    const range = formatLineRange(whitespaceMatch.startLine, whitespaceMatch.endLine);
    if (prefix && text.replace(/\r\n/g, "\n").includes(target)) {
      return `${base}${prefixNote} Without them the text is at ${range}; remove the prefixes from old_string.`;
    }
    return `${base}${prefixNote} The same text is at ${range}, but its whitespace or indentation differs. ${excerpt(whitespaceMatch.startLine, whitespaceMatch.endLine)}`;
  }

  const targetLines = target.split("\n");
  if (targetLines.length > 1 && targetLines[targetLines.length - 1] === "") targetLines.pop();
  const similar = findMostSimilarLines(lines, targetLines);
  if (similar) {
    let difference = "";
    for (let index = 0; index < targetLines.length; index += 1) {
      const fileLine = lines[similar.startLine - 1 + index];
      if (fileLine === undefined || fileLine === targetLines[index]) continue;
      difference = ` First difference at line ${similar.startLine + index}: the file has ${JSON.stringify(clipForMessage(fileLine))} where old_string has ${JSON.stringify(clipForMessage(targetLines[index]))}.`;
      break;
    }
    return `${base}${prefixNote} The most similar text is at ${formatLineRange(similar.startLine, similar.endLine)} (${Math.round(similar.score * 100)}% of words in common).${difference} ${excerpt(similar.startLine, similar.endLine)}`;
  }

  return `${base}${prefixNote} No similar text was found in the file; re-read it (it may have changed) before retrying.`;
}

/**
 * EditTools provides surgical file editing capabilities
 * Similar to Claude Code's Edit tool for precise string replacements
 */
export class EditTools {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {}

  /**
   * Update the workspace for this tool
   */
  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  /**
   * Get tool definitions for Edit tools
   */
  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: "edit_file",
        description:
          "Perform surgical text replacements in files. " +
          "Replaces exact matches of old_string with new_string. " +
          "PREFERRED over write_file when making targeted changes - safer and preserves file structure. " +
          "The edit will FAIL if old_string is not found or is not unique (unless replace_all is true). " +
          "If the file changes before commit, the edit is rebased only when its original match remains safe; replace_all also requires the same match count.",
        input_schema: {
          type: "object",
          properties: {
            file_path: {
              type: "string",
              description: "Path to the file to edit (relative to workspace)",
            },
            old_string: {
              type: "string",
              description:
                "The exact text to find and replace (must be unique in file unless replace_all)",
            },
            new_string: {
              type: "string",
              description: "The text to replace it with (can be empty to delete)",
            },
            replace_all: {
              type: "boolean",
              description:
                "Replace all occurrences instead of requiring unique match (default: false)",
            },
          },
          required: ["file_path", "old_string", "new_string"],
        },
      },
    ];
  }

  /**
   * Execute surgical file edit
   */
  async editFile(input: {
    file_path: string;
    old_string: string;
    new_string: string;
    replace_all?: boolean;
  }): Promise<{
    success: boolean;
    file_path: string;
    replacements: number;
    error?: string;
  }> {
    const { file_path, old_string, new_string, replace_all = false } = input;

    this.daemon.logEvent(this.taskId, "log", {
      message: `Editing file: ${file_path}`,
    });

    try {
      // Validate inputs
      if (!old_string) {
        throw new Error("old_string cannot be empty");
      }

      if (old_string === new_string) {
        throw new Error("old_string and new_string are identical - no change needed");
      }

      // Resolve path
      const workspaceRoot = path.resolve(this.workspace.path);
      const requestedFullPath = path.resolve(workspaceRoot, file_path);
      const candidatePath = resolveAccessControlledPath(this.workspace.path, requestedFullPath);
      let externalApprovalGranted =
        typeof (this.daemon as Any)?.consumeExternalFileApproval === "function" &&
        (this.daemon as Any).consumeExternalFileApproval(this.taskId, candidatePath, "write") ===
          true;
      let access = evaluateWorkspaceFilesystemAccess(this.workspace, requestedFullPath, "write", {
        externalApprovalGranted,
      });
      if (access.decision !== "allow") {
        if (access.reason === "profile_filesystem_denied") {
          throw new Error(`Path is denied by the active access profile: ${requestedFullPath}`);
        }
        if (access.reason === "outside_workspace") {
          const approved = await authorizeToolActionWithFallback(this.daemon, this.taskId, {
            toolName: "edit_file",
            approvalType: "external_file_access",
            description: `Allow write access to external file: ${candidatePath}`,
            details: {
              path: candidatePath,
              operation: "write",
              tool: "edit_file",
            },
            allowAutoApprove: true,
          });
          if (!approved) throw new Error("External file access was not approved.");
          if (
            resolveAccessControlledPath(this.workspace.path, requestedFullPath) !== candidatePath
          ) {
            throw new Error("File path changed while awaiting approval");
          }
          externalApprovalGranted =
            typeof (this.daemon as Any)?.consumeExternalFileApproval === "function"
              ? (this.daemon as Any).consumeExternalFileApproval(
                  this.taskId,
                  candidatePath,
                  "write",
                ) === true
              : true;
          access = evaluateWorkspaceFilesystemAccess(this.workspace, requestedFullPath, "write", {
            externalApprovalGranted,
          });
        }
        if (access.decision !== "allow") {
          const detail =
            access.reason === "protected_path"
              ? " (the target must remain within workspace and cannot be an OS-protected path)"
              : "";
          throw new Error(`Write permission not granted: ${access.reason}${detail}`);
        }
      }
      const fullPath = access.path;

      // Enforce per-project access for `.cowork/projects/*`
      const relPosix = getWorkspaceRelativePosixPath(workspaceRoot, fullPath);
      if (relPosix !== null) {
        const projectId = getProjectIdFromWorkspaceRelPath(relPosix);
        if (projectId) {
          const taskGetter = (this.daemon as Any)?.getTask;
          const task =
            typeof taskGetter === "function" ? taskGetter.call(this.daemon, this.taskId) : null;
          const agentRoleId = task?.assignedAgentRoleId || null;
          const res = await checkProjectAccess({
            workspacePath: workspaceRoot,
            projectId,
            agentRoleId,
          });
          if (!res.allowed) {
            throw new Error(res.reason || `Access denied for project "${projectId}"`);
          }
        }
      }

      // Check file exists
      if (!fs.existsSync(fullPath)) {
        throw new Error(`File not found: ${file_path}`);
      }

      // Apply the same profile rule to the resolved symlink target. This
      // prevents an in-workspace link from bypassing an external deny rule.
      const realPath = fs.realpathSync(fullPath);
      const realAccess = evaluateWorkspaceFilesystemAccess(this.workspace, realPath, "write", {
        externalApprovalGranted,
      });
      if (realAccess.decision !== "allow") {
        if (realAccess.reason !== "profile_filesystem_denied") {
          throw new Error("File path resolves outside workspace");
        }
        throw new Error(`Path is denied by the active access profile: ${realPath}`);
      }
      const initialStats = fs.statSync(realPath);
      if (!initialStats.isFile()) throw new Error("Edit target is not a regular file");
      const initialParentPath = path.dirname(realPath);
      const initialParentStats = fs.statSync(initialParentPath);
      const noFollow = (fs.constants as Any).O_NOFOLLOW;
      const descriptorFlags = fs.constants.O_RDWR | (typeof noFollow === "number" ? noFollow : 0);
      const targetFd = fs.openSync(realPath, descriptorFlags);
      try {
        if (!hasStableFileIdentity(fs.fstatSync(targetFd), initialStats)) {
          throw new Error("File target changed before edit was read");
        }

        // Recover a prior interrupted edit before taking the content version used by this edit.
        await withEditPathLock(getEditLockKey(initialStats, realPath), async () => {
          await this.revalidateEditTarget({
            requestedFullPath,
            realPath,
            initialStats,
            initialParentStats,
            targetFd,
            externalApprovalGranted,
          });
          await this.recoverPendingEdit({
            requestedFullPath,
            realPath,
            targetFd,
            expectedIdentity: initialStats,
            expectedParentIdentity: initialParentStats,
            externalApprovalGranted,
          });
        });

        const initialBuffer = readDescriptorBuffer(targetFd);
        const initialReplacement = this.buildReplacement(
          initialBuffer,
          old_string,
          new_string,
          replace_all,
        );

        await this.daemon.captureTaskMutationBaseline?.(this.taskId, fullPath);

        const replacement = await withEditPathLock(
          getEditLockKey(initialStats, realPath),
          async () => {
            await this.revalidateEditTarget({
              requestedFullPath,
              realPath,
              initialStats,
              initialParentStats,
              targetFd,
              externalApprovalGranted,
            });
            const currentBuffer = readDescriptorBuffer(targetFd);
            let next: { content: string; encoding: "utf8" | "latin1"; replacements: number };
            try {
              next = this.buildReplacement(currentBuffer, old_string, new_string, replace_all);
            } catch (error: Any) {
              if (!currentBuffer.equals(initialBuffer)) {
                throw new Error(
                  `File changed while this edit was waiting, and the requested text can no longer be matched safely. ${error.message} Re-read the file and retry with current text.`,
                );
              }
              throw error;
            }
            if (
              !currentBuffer.equals(initialBuffer) &&
              replace_all &&
              next.replacements !== initialReplacement.replacements
            ) {
              throw new Error(
                `File changed while this edit was waiting, so replace_all would affect ${next.replacements} matches instead of the original ${initialReplacement.replacements}. Re-read the file and retry with current text.`,
              );
            }

            const nextBuffer = Buffer.from(next.content, next.encoding);
            assertEditContentSize(nextBuffer.length);
            await this.revalidateEditTarget({
              requestedFullPath,
              realPath,
              initialStats,
              initialParentStats,
              targetFd,
              externalApprovalGranted,
            });
            this.writeFileThroughDescriptor({
              realPath,
              requestedFullPath,
              targetFd,
              contentBefore: currentBuffer,
              contentAfter: nextBuffer,
              expectedIdentity: initialStats,
              expectedParentIdentity: initialParentStats,
              externalApprovalGranted,
            });
            return next;
          },
        );

        this.daemon.logEvent(this.taskId, "tool_result", {
          tool: "edit_file",
          result: {
            file_path,
            replacements: replacement.replacements,
            oldLength: old_string.length,
            newLength: new_string.length,
          },
        });

        // Emit file modified event with edit preview
        const oldPreview = old_string.length > 80 ? old_string.slice(0, 80) + "..." : old_string;
        const newPreview = new_string.length > 80 ? new_string.slice(0, 80) + "..." : new_string;
        const oldLineCount = old_string.split("\n").length;
        const newLineCount = new_string.split("\n").length;
        const netLines = newLineCount - oldLineCount;

        this.daemon.logEvent(this.taskId, "file_modified", {
          path: file_path,
          type: "edit",
          replacements: replacement.replacements,
          oldPreview,
          newPreview,
          netLines,
        });

        return {
          success: true,
          file_path,
          replacements: replacement.replacements,
        };
      } finally {
        fs.closeSync(targetFd);
      }
    } catch (error: Any) {
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "edit_file",
        error: error.message,
      });

      return {
        success: false,
        file_path,
        replacements: 0,
        error: error.message,
      };
    }
  }

  /**
   * Count occurrences of a string in content
   */
  private countOccurrences(content: string, searchString: string): number {
    let count = 0;
    let position = 0;

    while (true) {
      const index = content.indexOf(searchString, position);
      if (index === -1) break;
      count++;
      position = index + 1;
    }

    return count;
  }

  private buildReplacement(
    fileBytes: Buffer,
    oldString: string,
    newString: string,
    replaceAll: boolean,
  ): { content: string; encoding: "utf8" | "latin1"; replacements: number } {
    const { text: content, encoding } = decodeEditableText(fileBytes, oldString, newString);
    for (const candidate of buildEditMatchCandidates(content, oldString, newString, replaceAll)) {
      const occurrences = this.countOccurrences(content, candidate.oldString);
      if (occurrences === 0) continue;
      if (candidate.expectedLine !== undefined) {
        if (occurrences > 1) {
          throw new Error(
            `old_string appears to include line-number prefixes; without them it was found ${occurrences} times in file. ` +
              "Remove the prefixes and include more surrounding lines to make it unique.",
          );
        }
        const index = content.indexOf(candidate.oldString);
        const startsLine = index === 0 || content[index - 1] === "\n";
        if (!startsLine || lineNumberAt(content, index) !== candidate.expectedLine) continue;
      }
      if (occurrences > 1 && !replaceAll) {
        throw new Error(
          `old_string found ${occurrences} times in file. ` +
            "Use replace_all: true to replace all occurrences, or provide more context to make it unique.",
        );
      }
      if (encoding === "latin1") assertLegacyMatchBoundaries(content, candidate.oldString);
      if (replaceAll) {
        return {
          content: content.split(candidate.oldString).join(candidate.newString),
          encoding,
          replacements: occurrences,
        };
      }
      const index = content.indexOf(candidate.oldString);
      return {
        content:
          content.substring(0, index) +
          candidate.newString +
          content.substring(index + candidate.oldString.length),
        encoding,
        replacements: 1,
      };
    }
    throw new Error(describeEditMiss(content, oldString));
  }

  protected async revalidateEditTarget(options: {
    requestedFullPath: string;
    realPath: string;
    initialStats: fs.Stats;
    initialParentStats: fs.Stats;
    targetFd: number;
    externalApprovalGranted: boolean;
  }): Promise<void> {
    const {
      requestedFullPath,
      realPath,
      initialStats,
      initialParentStats,
      targetFd,
      externalApprovalGranted,
    } = options;
    const access = evaluateWorkspaceFilesystemAccess(this.workspace, requestedFullPath, "write", {
      externalApprovalGranted,
    });
    if (access.decision !== "allow") {
      if (access.reason === "profile_filesystem_denied") {
        throw new Error(`Path is denied by the active access profile: ${requestedFullPath}`);
      }
      if (access.reason === "outside_workspace") {
        throw new Error("File path resolves outside workspace");
      }
      throw new Error(`Write permission not granted: ${access.reason}`);
    }
    const latestRealPath = fs.realpathSync(access.path);
    if (latestRealPath !== realPath) throw new Error("File path changed during edit");
    const realAccess = evaluateWorkspaceFilesystemAccess(this.workspace, latestRealPath, "write", {
      externalApprovalGranted,
    });
    if (realAccess.decision !== "allow") {
      if (realAccess.reason === "profile_filesystem_denied") {
        throw new Error(`Path is denied by the active access profile: ${latestRealPath}`);
      }
      throw new Error("File path resolves outside workspace");
    }
    const pathEntry = fs.lstatSync(latestRealPath);
    if (pathEntry.isSymbolicLink() || !pathEntry.isFile()) {
      throw new Error("File path changed during edit");
    }
    const latestStats = fs.statSync(latestRealPath);
    if (!hasStableFileIdentity(initialStats, latestStats)) {
      throw new Error("File target changed during edit");
    }
    const latestParentPath = path.dirname(latestRealPath);
    const latestParentStats = fs.statSync(latestParentPath);
    if (
      fs.realpathSync(latestParentPath) !== path.dirname(realPath) ||
      !hasStableFileIdentity(initialParentStats, latestParentStats)
    ) {
      throw new Error("Parent directory changed during edit");
    }
    if (!hasStableFileIdentity(initialStats, fs.fstatSync(targetFd))) {
      throw new Error("File target changed during edit");
    }

    const workspaceRoot = path.resolve(this.workspace.path);
    const relPosix = getWorkspaceRelativePosixPath(workspaceRoot, access.path);
    if (relPosix !== null) {
      const projectId = getProjectIdFromWorkspaceRelPath(relPosix);
      if (projectId) {
        const taskGetter = (this.daemon as Any)?.getTask;
        const task =
          typeof taskGetter === "function" ? taskGetter.call(this.daemon, this.taskId) : null;
        const res = await checkProjectAccess({
          workspacePath: workspaceRoot,
          projectId,
          agentRoleId: task?.assignedAgentRoleId || null,
        });
        if (!res.allowed) {
          throw new Error(res.reason || `Access denied for project "${projectId}"`);
        }
      }
    }
  }

  private assertDescriptorCommitPath(options: {
    requestedFullPath: string;
    realPath: string;
    targetFd: number;
    expectedIdentity: fs.Stats;
    expectedParentIdentity: fs.Stats;
    externalApprovalGranted: boolean;
  }): void {
    const {
      requestedFullPath,
      realPath,
      targetFd,
      expectedIdentity,
      expectedParentIdentity,
      externalApprovalGranted,
    } = options;
    const access = evaluateWorkspaceFilesystemAccess(this.workspace, requestedFullPath, "write", {
      externalApprovalGranted,
    });
    if (access.decision !== "allow") {
      if (access.reason === "profile_filesystem_denied") {
        throw new Error(`Path is denied by the active access profile: ${requestedFullPath}`);
      }
      throw new Error("File path resolves outside workspace");
    }
    const latestRealPath = fs.realpathSync(access.path);
    if (latestRealPath !== realPath) throw new Error("File path changed during edit");
    const realAccess = evaluateWorkspaceFilesystemAccess(this.workspace, latestRealPath, "write", {
      externalApprovalGranted,
    });
    if (realAccess.decision !== "allow") {
      if (realAccess.reason === "profile_filesystem_denied") {
        throw new Error(`Path is denied by the active access profile: ${latestRealPath}`);
      }
      throw new Error("File path resolves outside workspace");
    }
    const entry = fs.lstatSync(latestRealPath);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error("File path changed during edit");
    }
    if (!hasStableFileIdentity(expectedIdentity, fs.statSync(latestRealPath))) {
      throw new Error("File target changed during edit");
    }
    const parentPath = path.dirname(latestRealPath);
    if (
      fs.realpathSync(parentPath) !== path.dirname(realPath) ||
      !hasStableFileIdentity(expectedParentIdentity, fs.statSync(parentPath))
    ) {
      throw new Error("Parent directory changed during edit");
    }
    if (!hasStableFileIdentity(expectedIdentity, fs.fstatSync(targetFd))) {
      throw new Error("File target changed during edit");
    }
  }

  private getRecoveryDirectory(): string {
    const userDataPath = path.resolve(getUserDataDir());
    const directory = path.join(userDataPath, EDIT_RECOVERY_DIRECTORY);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stats = fs.lstatSync(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("File edit recovery storage is not a private directory");
    }
    if (process.platform !== "win32") {
      const userId = typeof process.getuid === "function" ? process.getuid() : null;
      if (userId !== null && stats.uid !== userId) {
        throw new Error("File edit recovery storage is owned by another user");
      }
      if ((stats.mode & 0o077) !== 0) fs.chmodSync(directory, 0o700);
      const verified = fs.lstatSync(directory);
      if ((verified.mode & 0o077) !== 0) {
        throw new Error("File edit recovery storage permissions are too broad");
      }
    }
    const realDirectory = fs.realpathSync(directory);
    cleanupStaleRecoveryTemps(realDirectory);
    return realDirectory;
  }

  private activeEditConflictError(recordPath: string, reason: string): Error {
    const recordId = path.basename(recordPath, ".json");
    return new Error(
      `File edit conflict (${recordId}): ${reason}. No changes were made by this request; retry after the other edit finishes. Recovery record: ${recordPath}`,
    );
  }

  private recoveryRequiredError(recordPath: string, reason: string): Error {
    const recordId = path.basename(recordPath, ".json");
    return new Error(
      `File edit recovery is required (${recordId}): ${reason}. CoWork preserved the private recovery record at ${recordPath}. Save the current file and reconcile it with that record before retrying.`,
    );
  }

  private readRecoveryRecord(
    recordPath: string,
    realPath: string,
  ): LoadedEditRecoveryRecord | null {
    let fd: number;
    const noFollow = (fs.constants as Any).O_NOFOLLOW;
    try {
      fd = fs.openSync(
        recordPath,
        fs.constants.O_RDONLY | (typeof noFollow === "number" ? noFollow : 0),
      );
    } catch (error: Any) {
      if (error.code === "ENOENT") return null;
      throw this.recoveryRequiredError(
        recordPath,
        "the private recovery record cannot be opened safely",
      );
    }

    try {
      const stats = fs.fstatSync(fd);
      const userId = typeof process.getuid === "function" ? process.getuid() : null;
      if (
        !stats.isFile() ||
        stats.nlink > 2 ||
        (userId !== null && stats.uid !== userId) ||
        (process.platform !== "win32" && (stats.mode & 0o077) !== 0) ||
        stats.size <= 0 ||
        stats.size > getEditRecoveryRecordLimitBytes()
      ) {
        throw this.recoveryRequiredError(
          recordPath,
          "the private recovery record has unsafe metadata",
        );
      }
      const parsed = JSON.parse(fs.readFileSync(fd, "utf8")) as Any;
      const keys = Object.keys(parsed ?? {}).sort();
      const baseKeys = [
        "afterBase64",
        "afterSha256",
        "beforeBase64",
        "beforeSha256",
        "checksum",
        "fileDev",
        "fileIno",
        "ownerPid",
        "path",
        "state",
        "version",
      ];
      // Records written before ownerBootTimeMs/transactionId existed remain valid.
      const hasOwnerIdentity = Object.prototype.hasOwnProperty.call(parsed ?? {}, "transactionId");
      const expectedKeys = (
        hasOwnerIdentity ? [...baseKeys, "ownerBootTimeMs", "transactionId"] : baseKeys
      ).sort();
      if (
        !parsed ||
        typeof parsed !== "object" ||
        keys.length !== expectedKeys.length ||
        keys.some((key: string, index: number) => key !== expectedKeys[index]) ||
        parsed.version !== 1 ||
        typeof parsed.path !== "string" ||
        !path.isAbsolute(parsed.path) ||
        ((parsed.fileDev === 0 || parsed.fileIno === 0) && parsed.path !== realPath) ||
        !Number.isFinite(parsed.fileDev) ||
        !Number.isFinite(parsed.fileIno) ||
        !Number.isSafeInteger(parsed.ownerPid) ||
        (hasOwnerIdentity &&
          (!Number.isFinite(parsed.ownerBootTimeMs) ||
            typeof parsed.transactionId !== "string" ||
            !/^[a-f0-9-]{36}$/.test(parsed.transactionId))) ||
        (parsed.state !== "prepared" && parsed.state !== "committed") ||
        typeof parsed.beforeBase64 !== "string" ||
        typeof parsed.afterBase64 !== "string" ||
        typeof parsed.beforeSha256 !== "string" ||
        typeof parsed.afterSha256 !== "string" ||
        typeof parsed.checksum !== "string"
      ) {
        throw this.recoveryRequiredError(recordPath, "the private recovery record is malformed");
      }
      const record = parsed as EditRecoveryRecord;
      if (
        !/^[a-f0-9]{64}$/.test(record.checksum) ||
        editRecoveryChecksum(record) !== record.checksum
      ) {
        throw this.recoveryRequiredError(
          recordPath,
          "the private recovery record failed its integrity check",
        );
      }
      const before = Buffer.from(record.beforeBase64, "base64");
      const after = Buffer.from(record.afterBase64, "base64");
      if (
        before.toString("base64") !== record.beforeBase64 ||
        after.toString("base64") !== record.afterBase64 ||
        before.length > MAX_EDIT_RECOVERY_CONTENT_BYTES ||
        after.length > MAX_EDIT_RECOVERY_CONTENT_BYTES ||
        hashEditContent(before) !== record.beforeSha256 ||
        hashEditContent(after) !== record.afterSha256
      ) {
        throw this.recoveryRequiredError(
          recordPath,
          "the private recovery record contents failed validation",
        );
      }
      return { record, recordDev: stats.dev, recordIno: stats.ino };
    } catch (error: Any) {
      if (
        typeof error?.message === "string" &&
        error.message.includes("File edit recovery is required")
      ) {
        throw error;
      }
      throw this.recoveryRequiredError(
        recordPath,
        "the private recovery record is malformed or unreadable",
      );
    } finally {
      fs.closeSync(fd);
    }
  }

  private removeRecoveryRecord(recordPath: string): void {
    try {
      fs.unlinkSync(recordPath);
    } catch (error: Any) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  /** Test seam: runs after a record is judged orphaned and before it is discarded. */
  protected beforeOrphanRecoveryRecordRemoval(_recordPath: string): void {}

  /**
   * Discard an orphaned record only if the file at recordPath is still the record that was read.
   * Another process sharing the profile may have already discarded that orphan and created its own
   * live record at the same path; unlinking by path would silently delete the live record. POSIX
   * has no unlink-if-inode, so move the entry to a unique tombstone, verify the moved file's
   * identity and checksum (transactionId makes checksums unique), and restore it on mismatch.
   */
  private removeOrphanRecoveryRecord(
    recordPath: string,
    realPath: string,
    loaded: LoadedEditRecoveryRecord,
  ): void {
    const isSameRecord = (candidate: LoadedEditRecoveryRecord | null): boolean =>
      candidate !== null &&
      candidate.record.checksum === loaded.record.checksum &&
      (loaded.recordIno === 0 ||
        candidate.recordIno === 0 ||
        (candidate.recordDev === loaded.recordDev && candidate.recordIno === loaded.recordIno));
    const replacedError = () =>
      this.activeEditConflictError(
        recordPath,
        "another CoWork process replaced the recovery record while it was being reconciled",
      );

    try {
      const onDisk = fs.lstatSync(recordPath);
      if (
        loaded.recordIno !== 0 &&
        onDisk.ino !== 0 &&
        (onDisk.dev !== loaded.recordDev || onDisk.ino !== loaded.recordIno)
      ) {
        throw replacedError();
      }
    } catch (error: Any) {
      // Another reconciler already discarded this orphan; record creation is exclusive, so a
      // concurrent new edit will still be detected when this request creates its own record.
      if (error.code === "ENOENT") return;
      throw error;
    }

    const tombstonePath = `${recordPath}.${process.pid}.${randomUUID()}.reap`;
    try {
      fs.renameSync(recordPath, tombstonePath);
    } catch (error: Any) {
      if (error.code === "ENOENT") return;
      throw error;
    }

    let moved: LoadedEditRecoveryRecord | null = null;
    try {
      moved = this.readRecoveryRecord(tombstonePath, realPath);
    } catch {
      moved = null;
    }
    if (isSameRecord(moved)) {
      this.removeRecoveryRecord(tombstonePath);
      return;
    }

    // Not the orphan we inspected: put the other process's record back without overwriting
    // anything created meanwhile (link fails with EEXIST), then report the live conflict.
    try {
      fs.linkSync(tombstonePath, recordPath);
    } catch {
      throw this.recoveryRequiredError(
        tombstonePath,
        "a concurrent edit replaced the recovery record during reconciliation and it could not be restored",
      );
    }
    try {
      fs.unlinkSync(tombstonePath);
    } catch {
      // The restored record is intact; a leftover tombstone link is harmless evidence.
    }
    throw replacedError();
  }

  /**
   * Reconciliation runs on the next edit of this inode within the same profile, not during
   * startup or read-only access. Fsynced before/after bytes make process-killed writes manually
   * recoverable. Directory entries are not fsynced, so power-loss recovery is not promised.
   * No partial prefix proves ownership: even empty bytes could be an external user's edit.
   * Recovery never rewrites the target. Exact known states can discard the receipt; all other
   * content is preserved with an actionable conflict and the receipt intact. The write retains the
   * inode, hard links, mode, owner, ACLs, and other file metadata. On Windows privacy depends on
   * the app user-data directory ACL because POSIX mode bits cannot express its access rules.
   */
  private async recoverPendingEdit(options: {
    requestedFullPath: string;
    realPath: string;
    targetFd: number;
    expectedIdentity: fs.Stats;
    expectedParentIdentity: fs.Stats;
    externalApprovalGranted: boolean;
  }): Promise<void> {
    const { realPath, targetFd, expectedIdentity } = options;
    const directory = this.getRecoveryDirectory();
    const recordPath = getEditRecoveryRecordPath(directory, expectedIdentity, realPath);
    const loaded = this.readRecoveryRecord(recordPath, realPath);
    if (!loaded) return;
    const { record } = loaded;
    if (
      record.fileDev !== expectedIdentity.dev ||
      record.fileIno !== expectedIdentity.ino ||
      !hasStableFileIdentity(expectedIdentity, fs.fstatSync(targetFd))
    ) {
      throw this.recoveryRequiredError(
        recordPath,
        "the target inode no longer matches the interrupted edit",
      );
    }
    const before = Buffer.from(record.beforeBase64, "base64");
    const after = Buffer.from(record.afterBase64, "base64");
    const current = readDescriptorBuffer(targetFd);
    // A committed record whose target already holds the after-bytes describes a finished write:
    // the owner's only remaining step is an ENOENT-tolerant unlink by path, so it is reclaimable
    // even while the owner lives. Without this, a record that a concurrent reconciler tombstoned
    // and restored after the owner's unlink would block other processes for as long as a
    // long-lived owner (the daemon) runs. Prepared records never qualify: their owner may be
    // mid-write.
    const finishedCommit = record.state === "committed" && current.equals(after);
    if (
      !finishedCommit &&
      ((record.ownerPid === process.pid && activeEditTransactions.has(recordPath)) ||
        (record.ownerPid !== process.pid && isOtherRecoveryRecordOwnerAlive(record)))
    ) {
      throw this.activeEditConflictError(
        recordPath,
        "another live CoWork process owns this edit transaction",
      );
    }

    this.beforeOrphanRecoveryRecordRemoval(recordPath);
    if (record.state === "committed") {
      if (!current.equals(after)) {
        throw this.recoveryRequiredError(
          recordPath,
          "the file changed after the edit was committed; current user content was preserved",
        );
      }
      this.removeOrphanRecoveryRecord(recordPath, realPath, loaded);
      return;
    }

    if (current.equals(before)) {
      this.removeOrphanRecoveryRecord(recordPath, realPath, loaded);
      return;
    }
    if (current.equals(after)) {
      this.removeOrphanRecoveryRecord(recordPath, realPath, loaded);
      return;
    }
    throw this.recoveryRequiredError(
      recordPath,
      "the file may contain a partial write or an external edit; current user content was preserved",
    );
  }

  protected writeTargetBuffer(targetFd: number, content: Buffer): void {
    fs.ftruncateSync(targetFd, 0);
    writeBufferFully(targetFd, content);
    fs.fsyncSync(targetFd);
  }

  private writeFileThroughDescriptor(options: {
    realPath: string;
    requestedFullPath: string;
    targetFd: number;
    contentBefore: Buffer;
    contentAfter: Buffer;
    expectedIdentity: fs.Stats;
    expectedParentIdentity: fs.Stats;
    externalApprovalGranted: boolean;
  }): void {
    const {
      realPath,
      requestedFullPath,
      targetFd,
      contentBefore,
      contentAfter,
      expectedIdentity,
      expectedParentIdentity,
      externalApprovalGranted,
    } = options;
    const directory = this.getRecoveryDirectory();
    const recordPath = getEditRecoveryRecordPath(directory, expectedIdentity, realPath);
    const record: EditRecoveryRecord = {
      version: 1,
      path: realPath,
      fileDev: expectedIdentity.dev,
      fileIno: expectedIdentity.ino,
      ownerPid: process.pid,
      ownerBootTimeMs: getCurrentBootTimeMs(),
      transactionId: randomUUID(),
      state: "prepared",
      beforeBase64: contentBefore.toString("base64"),
      afterBase64: contentAfter.toString("base64"),
      beforeSha256: hashEditContent(contentBefore),
      afterSha256: hashEditContent(contentAfter),
      checksum: "",
    };
    record.checksum = editRecoveryChecksum(record);
    if (activeEditTransactions.has(recordPath)) {
      throw this.recoveryRequiredError(
        recordPath,
        "another edit transaction for this target is active",
      );
    }
    activeEditTransactions.add(recordPath);
    try {
      try {
        writeRecoveryRecord(recordPath, record, true);
      } catch (error: Any) {
        if (error.code === "EEXIST") {
          throw this.activeEditConflictError(
            recordPath,
            "another process created a recovery record for this target",
          );
        }
        throw error;
      }

      let mutationStarted = false;
      try {
        this.assertDescriptorCommitPath({
          requestedFullPath,
          realPath,
          targetFd,
          expectedIdentity,
          expectedParentIdentity,
          externalApprovalGranted,
        });
        if (!readDescriptorBuffer(targetFd).equals(contentBefore)) {
          throw new Error(
            "File changed before edit commit; re-read it and retry with current text.",
          );
        }
        mutationStarted = true;
        this.writeTargetBuffer(targetFd, contentAfter);
        if (!readDescriptorBuffer(targetFd).equals(contentAfter)) {
          throw new Error("The edited file did not match the staged content after writing.");
        }
        // Detect path, parent, or policy changes at the write boundary. Preserve the
        // current bytes and receipt on failure; a rollback cannot identify external edits.
        this.assertDescriptorCommitPath({
          requestedFullPath,
          realPath,
          targetFd,
          expectedIdentity,
          expectedParentIdentity,
          externalApprovalGranted,
        });
        const committed: EditRecoveryRecord = { ...record, state: "committed", checksum: "" };
        committed.checksum = editRecoveryChecksum(committed);
        writeRecoveryRecord(recordPath, committed, false);
      } catch (error: Any) {
        if (!mutationStarted) {
          this.removeRecoveryRecord(recordPath);
          throw error;
        }
        let current: Buffer;
        try {
          current = readDescriptorBuffer(targetFd);
        } catch (rollbackError: Any) {
          throw this.recoveryRequiredError(
            recordPath,
            `the write failed and automatic rollback could not safely inspect the target (${rollbackError.message})`,
          );
        }
        if (current.equals(contentBefore)) {
          this.removeRecoveryRecord(recordPath);
          throw error;
        }
        throw this.recoveryRequiredError(
          recordPath,
          `the write failed after mutation started (${error.message}); current user content was preserved`,
        );
      }

      try {
        this.removeRecoveryRecord(recordPath);
      } catch (error: Any) {
        this.daemon.logEvent(this.taskId, "log", {
          message: `Edit committed, but its recovery record ${path.basename(recordPath)} could not be cleaned up: ${error.message}`,
        });
      }
    } finally {
      activeEditTransactions.delete(recordPath);
    }
  }
}
