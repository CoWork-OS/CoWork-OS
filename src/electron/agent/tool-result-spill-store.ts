import * as fs from "fs";
import * as path from "path";
import { createHash, randomBytes } from "crypto";
import { getUserDataDir } from "../utils/user-data-dir";
import { createLogger } from "../utils/logger";
import { isSpillHandle, type ToolResultSpillSink } from "./tool-result-spill";

const logger = createLogger("ToolResultSpill");

/** Spills older than this are expired, whatever their task is doing. */
export const SPILL_TTL_MS = 24 * 60 * 60 * 1000;
/** At most this much spilled text is kept per task; the oldest spills go first. */
export const SPILL_MAX_TASK_BYTES = 64 * 1024 * 1024;
/** Text past this many characters of one part is not kept (the marker says so). */
export const SPILL_MAX_PART_CHARS = 4_000_000;
export const SPILL_PAGE_DEFAULT_CHARS = 8_000;
export const SPILL_PAGE_MAX_CHARS = 16_000;
/** A page's JSON-escaped text stays under this, so the tool result itself is never shortened. */
const SPILL_PAGE_MAX_ESCAPED_CHARS = 24_000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export interface ToolResultSpillPage {
  success: true;
  handle: string;
  offset: number;
  length: number;
  total_chars: number;
  /** Where the next page starts, or null when this page reaches the end. */
  next_offset: number | null;
  content: string;
}

export interface ToolResultSpillReadFailure {
  success: false;
  error: string;
  expired?: boolean;
}

export interface ToolResultSpillStoreOptions {
  rootDir: string;
  ttlMs?: number;
  maxTaskBytes?: number;
  maxPartChars?: number;
  now?: () => number;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Index moved back by one when it would split a surrogate pair. */
function alignBack(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  return isHighSurrogate(text.charCodeAt(index - 1)) && isLowSurrogate(text.charCodeAt(index))
    ? index - 1
    : index;
}

/** A handle's base (its file) and part ("" for a single-part result). */
function splitHandle(handle: string): { base: string; part: string } {
  const dot = handle.indexOf(".");
  return dot < 0
    ? { base: handle, part: "" }
    : { base: handle.slice(0, dot), part: handle.slice(dot + 1) };
}

/** On-disk form of one result: its parts keyed by part ("" when it has one). */
interface SpillFile {
  parts: Record<string, string>;
}

/**
 * Full text of shortened tool results, one file per result (base handle) under
 * `<userData>/cache/tool-result-spill/<task hash>/`. Files are private to the user (0600),
 * scoped to the task that wrote them, deleted when the task finishes and after 24 hours,
 * and capped per task.
 */
export class ToolResultSpillStore {
  private static defaultStore: ToolResultSpillStore | null = null;

  private readonly rootDir: string;
  private readonly ttlMs: number;
  private readonly maxTaskBytes: number;
  private readonly maxPartChars: number;
  private readonly now: () => number;
  private lastSweepAt = 0;
  /** The last file read, so paging through one spill does not re-read it each time. */
  private cache: { file: string; mtimeMs: number; parts: Record<string, string> } | null = null;

  constructor(options: ToolResultSpillStoreOptions) {
    this.rootDir = options.rootDir;
    this.ttlMs = options.ttlMs ?? SPILL_TTL_MS;
    this.maxTaskBytes = options.maxTaskBytes ?? SPILL_MAX_TASK_BYTES;
    this.maxPartChars = options.maxPartChars ?? SPILL_MAX_PART_CHARS;
    this.now = options.now ?? Date.now;
  }

  static getDefault(): ToolResultSpillStore {
    ToolResultSpillStore.defaultStore ??= new ToolResultSpillStore({
      rootDir: path.join(getUserDataDir(), "cache", "tool-result-spill"),
    });
    return ToolResultSpillStore.defaultStore;
  }

  /** The sink a task's truncation code writes to. */
  sinkForTask(taskId: string): ToolResultSpillSink {
    return {
      newHandle: () => `sp${randomBytes(6).toString("hex")}`,
      write: (parts) => this.write(taskId, parts),
    };
  }

  /** Keep every part (all or none). Parts sharing a base handle go into one file. */
  write(taskId: string, parts: ReadonlyMap<string, string>): boolean {
    if (!taskId || parts.size === 0) return false;
    const byBase = new Map<string, Record<string, string>>();
    for (const [handle, value] of parts) {
      if (!isSpillHandle(handle) || typeof value !== "string") return false;
      const { base, part } = splitHandle(handle);
      const text =
        value.length > this.maxPartChars
          ? `${value.slice(0, alignBack(value, this.maxPartChars))}\n[... ${
              value.length - this.maxPartChars
            } more chars of this result were not kept ...]`
          : value;
      const fileParts = byBase.get(base) ?? {};
      fileParts[part] = text;
      byBase.set(base, fileParts);
    }
    const dir = this.taskDir(taskId);
    const entries = Array.from(byBase, ([base, fileParts]) => {
      const body = JSON.stringify({ parts: fileParts } satisfies SpillFile);
      return { file: path.join(dir, `${base}.json`), body, bytes: Buffer.byteLength(body, "utf8") };
    });
    const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    if (totalBytes > this.maxTaskBytes) return false;

    const written: string[] = [];
    try {
      this.maybeSweep();
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      this.evictToFit(dir, totalBytes);
      for (const entry of entries) {
        fs.writeFileSync(entry.file, entry.body, { encoding: "utf8", mode: 0o600 });
        written.push(entry.file);
        if (this.cache?.file === entry.file) this.cache = null;
      }
      return true;
    } catch (error) {
      logger.warn("Could not keep a shortened tool result:", error);
      for (const file of written) fs.rmSync(file, { force: true });
      return false;
    }
  }

  read(
    taskId: string,
    handle: string,
    offset = 0,
    length = SPILL_PAGE_DEFAULT_CHARS,
  ): ToolResultSpillPage | ToolResultSpillReadFailure {
    if (!isSpillHandle(handle)) {
      return {
        success: false,
        error: `Not a tool result handle: ${JSON.stringify(String(handle).slice(0, 40))}. Copy the handle from the "[... chars omitted; call tool_result_read(...)]" marker.`,
      };
    }
    const { base, part } = splitHandle(handle);
    const file = path.join(this.taskDir(taskId), `${base}.json`);
    let text: string | undefined;
    try {
      const stat = fs.statSync(file);
      if (this.now() - stat.mtimeMs > this.ttlMs) {
        fs.rmSync(file, { force: true });
        return this.expired(handle);
      }
      if (this.cache?.file !== file || this.cache.mtimeMs !== stat.mtimeMs) {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<SpillFile>;
        this.cache = { file, mtimeMs: stat.mtimeMs, parts: parsed.parts ?? {} };
      }
      const kept = this.cache.parts[part];
      text = typeof kept === "string" ? kept : undefined;
    } catch {
      text = undefined;
    }
    if (text === undefined) return this.expired(handle);

    const total = text.length;
    const start = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
    if (start > total) {
      return {
        success: false,
        error: `offset ${start} is past the end of this result (${total} chars).`,
      };
    }
    const wanted = Number.isFinite(length)
      ? Math.min(SPILL_PAGE_MAX_CHARS, Math.max(1, Math.floor(length)))
      : SPILL_PAGE_DEFAULT_CHARS;
    const from = alignBack(text, start);
    // A page always moves forward, even when one character is half of a surrogate pair.
    const pageEnd = (size: number) => {
      const end = alignBack(text, Math.min(total, from + size));
      return end > from || from >= total ? end : Math.min(total, from + 2);
    };
    let end = pageEnd(wanted);
    let content = text.slice(from, end);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const escaped = JSON.stringify(content).length;
      if (escaped <= SPILL_PAGE_MAX_ESCAPED_CHARS || end - from <= 1) break;
      const shorter = Math.floor(((end - from) * SPILL_PAGE_MAX_ESCAPED_CHARS) / escaped);
      end = pageEnd(Math.max(1, shorter));
      content = text.slice(from, end);
    }
    return {
      success: true,
      handle,
      offset: from,
      length: content.length,
      total_chars: total,
      next_offset: end < total ? end : null,
      content,
    };
  }

  /** Delete every spill of a task (it finished). */
  expireTask(taskId: string): void {
    const dir = this.taskDir(taskId);
    if (this.cache?.file.startsWith(dir + path.sep)) this.cache = null;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      logger.debug("Could not remove spilled tool results:", error);
    }
  }

  /** Delete spills older than the TTL. Returns how many files were removed. */
  sweepExpired(): number {
    let removed = 0;
    let taskDirs: string[];
    try {
      taskDirs = fs.readdirSync(this.rootDir);
    } catch {
      return 0;
    }
    const cutoff = this.now() - this.ttlMs;
    for (const name of taskDirs) {
      const dir = path.join(this.rootDir, name);
      try {
        const files = fs.readdirSync(dir);
        let left = files.length;
        for (const file of files) {
          const full = path.join(dir, file);
          if (fs.statSync(full).mtimeMs < cutoff) {
            fs.rmSync(full, { force: true });
            removed += 1;
            left -= 1;
          }
        }
        if (left === 0) fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Not a directory, or removed meanwhile.
      }
    }
    return removed;
  }

  private expired(handle: string): ToolResultSpillReadFailure {
    return {
      success: false,
      expired: true,
      error:
        `The full text behind handle "${handle}" is no longer kept (a task's shortened results ` +
        "expire when it finishes and after 24 hours). Run the original tool again if you still need it.",
    };
  }

  private taskDir(taskId: string): string {
    const name = createHash("sha256").update(taskId).digest("hex").slice(0, 32);
    return path.join(this.rootDir, name);
  }

  private maybeSweep(): void {
    const now = this.now();
    if (now - this.lastSweepAt < SWEEP_INTERVAL_MS) return;
    this.lastSweepAt = now;
    this.sweepExpired();
  }

  /** Remove the task's oldest spills until `incomingBytes` more fit its cap. */
  private evictToFit(dir: string, incomingBytes: number): void {
    const files = fs
      .readdirSync(dir)
      .map((name) => {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        return { full, size: stat.size, mtimeMs: stat.mtimeMs };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    let used = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files) {
      if (used + incomingBytes <= this.maxTaskBytes) break;
      fs.rmSync(file.full, { force: true });
      if (this.cache?.file === file.full) this.cache = null;
      used -= file.size;
    }
  }
}
