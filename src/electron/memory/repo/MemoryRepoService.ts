/**
 * MemoryRepoService — the only writer of the memory repo (docs/memory-repo-phase1-design.md).
 *
 * The repo is a local git repository of markdown files in the Agent Memory Repo format,
 * outside every workspace. The agent never writes its files or runs git on it: every change
 * goes through `remember` / `forget` / the purge helpers here, which
 *   1. screen the text (salience, secret redaction: `screenMemoryText`, shared with
 *      MemoryWriter) and apply `<no-memory>` and the workspace memory settings;
 *   2. pick the file (§5.1: `me.md`, `lessons.md`, `workspaces/<slug>.md`, `MEMORY.md` for
 *      pinned statements of the user, `inbox.md` for agent writes from tainted tasks);
 *   3. dedupe by normalized text, replace by subject (an agent never replaces a user line);
 *   4. take the cross-process lock, commit any hand edits, write the file atomically
 *      (no symlinks under the root) and commit with hardened git (memory-repo-git.ts).
 *
 * Without git the files are still written, but nothing is committed.
 */
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  MemoryRepoKeepTarget,
  MemoryRepoStatusReport,
} from "../../../shared/memory-repo-types";
import { createLogger } from "../../utils/logger";
import {
  screenMemoryText,
  workspaceMemoryPolicyDecision,
  type MemoryWorkspacePolicy,
} from "../MemoryWriter";
import type { MemoryItemKind } from "../memory-items-types";
import { containsNoMemoryDirective } from "../no-memory-directive";
import {
  MEMORY_REPO_ENTRY_FILE,
  MEMORY_REPO_INBOX_FILE,
  MEMORY_REPO_LESSONS_FILE,
  MEMORY_REPO_LIMITS,
  MEMORY_REPO_ME_FILE,
  MEMORY_REPO_SWARMS_DIR,
  MEMORY_REPO_WORKSPACES_DIR,
  ensureIndexLink,
  initialEntryFile,
  initialTopicFile,
  insertEntryLine,
  isSafeRepoPath,
  isSwarmRepoPath,
  isoDay,
  memoryRepoRef,
  parseMemoryRepoEntries,
  parseMemoryRepoLine,
  renderMemoryRepoEntry,
  replaceLine,
  splitLines,
  workspaceSlug,
  type MemoryRepoAuthor,
  type MemoryRepoEntry,
  type MemoryRepoMetadata,
} from "./memory-repo-format";
import {
  SWARM_FINDINGS_FILE,
  SWARM_NOTE_KINDS,
  SWARM_QUESTIONS_FILE,
  SWARM_README_FILE,
  initialSwarmNotesFile,
  renderSwarmReadme,
  swarmFileForKind,
  swarmFolderPath,
  swarmSlug,
  type SwarmMember,
  type SwarmNoteKind,
} from "./memory-repo-swarm";
import {
  isGitAvailable,
  parsePorcelainZ,
  runMemoryRepoGit,
  type GitRunner,
} from "./memory-repo-git";
import { MemoryRepoBusyError, withMemoryRepoLock } from "./memory-repo-lock";
import {
  MEMORY_REPO_SYNC_REMOTE,
  configureSyncRemote,
  emptySyncState,
  memoryRepoRemoteUrlProblem,
  pullMemoryRepo,
  pushMemoryRepo,
  redactRemoteUrl,
  type MemoryRepoSyncState,
} from "./memory-repo-sync";
import {
  applyDreamOperations,
  describeDreamOperation,
  type ClassifiedDreamOperation,
} from "./memory-repo-dream-plan";

const logger = createLogger("MemoryRepo");

/** Files editors and Finder leave next to notes; never part of memory. */
const MEMORY_REPO_GITIGNORE = [".DS_Store", "Thumbs.db", "*.tmp", "*.swp", "*~", ".obsidian/", ".vscode/", ".idea/", ""].join("\n");

/** Kinds that describe the user; global ones go to `me.md`. */
const ABOUT_USER_KINDS: ReadonlySet<MemoryItemKind> = new Set([
  "identity",
  "preference",
  "correction",
]);

/** The `# ` heading of a new `inbox.md`. */
const MEMORY_REPO_INBOX_TITLE = "Inbox (unreviewed: saved by the agent after reading untrusted content)";

/** One note read from another folder, before screening (`importToInbox`). */
export interface MemoryRepoImportEntry {
  text: string;
  kind?: MemoryItemKind | null;
  /** `YYYY-MM-DD` from the source line; anything else becomes today. */
  added?: string | null;
}

export interface MemoryRepoImportOutcome {
  imported: number;
  duplicates: number;
  skipped: number;
  truncated: boolean;
  error?: string;
}

export type MemoryRepoOrigin =
  | "agent_tool"
  | "memory_hub"
  | "export"
  | "hand_edit"
  | "dream"
  | "onboarding"
  | "import"
  | "feedback"
  | "swarm";

/** Metadata keys `remember` sets itself; `metadata` cannot override them. */
const RESERVED_METADATA_KEYS: ReadonlySet<string> = new Set([
  "by",
  "kind",
  "subject",
  "workspace",
  "added",
]);

export interface MemoryRepoRememberInput {
  text: string;
  kind: MemoryItemKind;
  scope: "global" | "workspace";
  workspaceId?: string | null;
  workspaceName?: string | null;
  by: MemoryRepoAuthor;
  /** Keep it in every prompt: honoured only for the user's own statements. */
  pinned?: boolean;
  subject?: string | null;
  taskId?: string | null;
  /** The task read untrusted content: an agent write goes to `inbox.md`. */
  tainted?: boolean;
  /** Checked for `<no-memory>`. */
  originText?: string | null;
  noMemory?: boolean;
  origin: MemoryRepoOrigin;
  /** Day the fact was learned (export keeps the original date). */
  addedAt?: number;
  /** Skip the workspace memory settings (an explicit user act, an export). */
  skipWorkspacePolicy?: boolean;
  /**
   * Extra metadata on the line (`origin: onboarding`, `source: import`). Lower-case keys;
   * `by`, `kind`, `subject`, `workspace` and `added` are ignored, and `source` only applies
   * when there is no `taskId`.
   */
  metadata?: Record<string, string>;
}

/** A peer note in a swarm folder (`swarmAppend`). */
export interface MemoryRepoSwarmAppendInput {
  slug: string;
  kind: SwarmNoteKind;
  text: string;
  /** The author's role or title (metadata `author`). */
  author?: string | null;
  taskId?: string | null;
  sources?: string[];
  /** The author read untrusted content (metadata `tainted: yes`). */
  tainted?: boolean;
  /** For the README written with the first note. */
  goal?: string;
  rootTaskId?: string;
  members?: SwarmMember[];
}

export type MemoryRepoSkipReason =
  | "empty"
  | "low_salience"
  | "secret_only"
  | "no_memory"
  | "memory_disabled"
  | "private"
  | "outranked"
  | "too_large"
  | "unavailable"
  | "busy"
  | "dirty";

export type MemoryRepoWriteResult =
  | {
      status: "written";
      action: "inserted" | "replaced" | "reinforced";
      ref: string;
      path: string;
      line: number;
      redactions: number;
      replaced?: string;
    }
  | { status: "skipped"; reason: MemoryRepoSkipReason; ref?: string; detail?: string };

/** The service status; the renderer sees it with the setting (`MemoryRepoStatusReport`). */
export type MemoryRepoStatus = Omit<MemoryRepoStatusReport, "enabled">;

export interface MemoryRepoChange {
  paths: string[];
  version: string;
}

export interface MemoryRepoServiceDeps {
  root: string;
  runtime: "desktop" | "node" | "cli";
  /** No writes at all (CLI, quiet mode). */
  readOnly?: boolean;
  git?: GitRunner;
  now?: () => number;
  /** Workspace memory settings; null means "no settings" (allowed). */
  getWorkspacePolicy?: (workspaceId: string) => Promise<MemoryWorkspacePolicy | null>;
  /** The user's preferred name for the MEMORY.md title. */
  ownerName?: () => string | null | undefined;
  lockTimeoutMs?: number;
  /** Tests only: accept a local path as the sync remote. */
  allowLocalRemotesForTests?: boolean;
}

type ChangeListener = (change: MemoryRepoChange) => void;

/** Lowest-level error for a write that touched nothing. */
class SkipWrite extends Error {
  constructor(
    readonly reason: MemoryRepoSkipReason,
    readonly detail?: string,
  ) {
    super(reason);
  }
}

export class MemoryRepoService {
  private static instance: MemoryRepoService | null = null;

  static get(): MemoryRepoService | null {
    return this.instance;
  }

  private static readonly instanceListeners = new Set<(service: MemoryRepoService | null) => void>();

  static setInstance(service: MemoryRepoService | null): void {
    const changed = this.instance !== service;
    this.instance = service;
    if (!changed) return;
    for (const listener of this.instanceListeners) {
      try {
        listener(service);
      } catch (error) {
        logger.warn("Memory repo instance listener failed:", error);
      }
    }
  }

  /** Called whenever the running service changes (started, restarted at a new path, off). */
  static onInstanceChange(listener: (service: MemoryRepoService | null) => void): () => void {
    this.instanceListeners.add(listener);
    return () => this.instanceListeners.delete(listener);
  }

  readonly root: string;
  private readonly git: GitRunner;
  private readonly now: () => number;
  private readonly listeners = new Set<ChangeListener>();
  private ready = false;
  private problem: string | undefined;
  private hasGit = false;
  private writeCount = 0;
  private head: string | null = null;
  private lastWriteError: string | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private workspaceFiles: Map<string, string> | null = null;
  /** Private-remote sync (Phase 4); null when off. */
  private syncUrl: string | null = null;
  private syncState: MemoryRepoSyncState = emptySyncState();
  private pushTimer: NodeJS.Timeout | null = null;
  /** History was rewritten (compaction): the next push replaces the remote's history. */
  private forcePushPending = false;
  private silentNotify = false;

  constructor(private readonly deps: MemoryRepoServiceDeps) {
    this.root = path.resolve(deps.root);
    this.git = deps.git ?? runMemoryRepoGit;
    this.now = deps.now ?? Date.now;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Create the repo when the path is missing or empty, adopt an existing memory repo. */
  async start(): Promise<MemoryRepoStatus> {
    this.hasGit = await isGitAvailable(this.git);
    try {
      await this.openOrCreate();
      this.ready = true;
      this.problem = undefined;
    } catch (error) {
      this.ready = false;
      this.problem = error instanceof Error ? error.message : String(error);
      logger.warn(`Memory repo unavailable at ${this.root}: ${this.problem}`);
    }
    return this.status();
  }

  /** Wait (bounded) for the write in progress; no new writes after this. */
  async stop(timeoutMs = 3_000): Promise<void> {
    this.stopped = true;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = null;
    await Promise.race([
      this.chain.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  isReady(): boolean {
    return this.ready;
  }

  isWritable(): boolean {
    return this.ready && !this.deps.readOnly && !this.stopped;
  }

  /** Changes on every write (HEAD when git is available), for prompt-block caches. */
  version(): string {
    return `${this.head ?? "nogit"}:${this.writeCount}`;
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async status(): Promise<MemoryRepoStatus> {
    const base: MemoryRepoStatus = {
      sync: this.syncUrl ? { ...this.syncState } : null,
      root: this.root,
      ready: this.ready,
      writable: this.isWritable(),
      gitAvailable: this.hasGit,
      ...(this.problem ? { problem: this.problem } : {}),
      lastWriteError: this.lastWriteError,
    };
    if (!this.ready) return base;
    const entryFile = await this.readFile(MEMORY_REPO_ENTRY_FILE);
    const inbox = await this.readFile(MEMORY_REPO_INBOX_FILE);
    let clean: boolean | undefined;
    let head: string | null = null;
    let lastCommitAt: number | null = null;
    if (this.hasGit) {
      try {
        clean = parsePorcelainZ(await this.runGit(["status", "--porcelain=v1", "-z"])).length === 0;
        const log = (await this.runGit(["log", "-1", "--format=%H %ct"])).trim();
        if (log) {
          const [sha, seconds] = log.split(" ");
          head = sha;
          lastCommitAt = Number(seconds) * 1000;
        }
      } catch {
        // An empty repo has no log; status failures surface as `clean: undefined`.
      }
    }
    return {
      ...base,
      clean,
      head,
      lastCommitAt,
      entryFileBytes: Buffer.byteLength(entryFile ?? "", "utf8"),
      inboxEntries: parseMemoryRepoEntries(inbox ?? "").length,
    };
  }

  private async openOrCreate(): Promise<void> {
    const stat = await fs.lstat(this.root).catch(() => null);
    if (stat?.isSymbolicLink()) throw new Error("the memory folder is a symbolic link");
    if (stat && !stat.isDirectory()) throw new Error("the memory path is not a folder");
    const empty = !stat || (await fs.readdir(this.root)).length === 0;
    if (empty) {
      if (this.deps.readOnly) throw new Error("the memory folder does not exist yet");
      await this.create();
      return;
    }
    const hasEntryFile = await this.readFile(MEMORY_REPO_ENTRY_FILE).then((text) => text !== null);
    if (!hasEntryFile) throw new Error("the folder is not a memory repo (no MEMORY.md)");
    if (this.hasGit) {
      const top = await this.runGit(["rev-parse", "--show-toplevel"]).catch(() => "");
      const realRoot = await fs.realpath(this.root);
      const realTop = top.trim() ? await fs.realpath(top.trim()).catch(() => "") : "";
      if (!realTop) {
        // A folder of memory files without git: start its history.
        if (!this.deps.readOnly) await this.initGit("Start memory history");
      } else if (realTop !== realRoot) {
        throw new Error("the memory folder is inside another git repository");
      } else {
        this.head = (await this.runGit(["rev-parse", "HEAD"]).catch(() => "")).trim() || null;
      }
    }
  }

  private async create(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    await this.writeFileAtomic(MEMORY_REPO_ENTRY_FILE, initialEntryFile(this.deps.ownerName?.()));
    await this.writeFileAtomic(MEMORY_REPO_ME_FILE, initialTopicFile("About me"));
    await this.writeFileAtomic(MEMORY_REPO_LESSONS_FILE, initialTopicFile("Lessons"));
    await fs.writeFile(path.join(this.root, ".gitignore"), MEMORY_REPO_GITIGNORE, { mode: 0o600 });
    await fs.writeFile(path.join(this.root, ".gitattributes"), "*.md merge=union\n", { mode: 0o600 });
    if (this.hasGit) await this.initGit("Create memory repo");
  }

  private async initGit(message: string): Promise<void> {
    await this.runGit(["init", "-q"]);
    await this.runGit(["symbolic-ref", "HEAD", "refs/heads/main"]).catch(() => undefined);
    const files = (await this.listFiles()).filter((file) => isSafeRepoPath(file));
    if (fsSync.existsSync(path.join(this.root, ".gitignore"))) files.push(".gitignore");
    if (fsSync.existsSync(path.join(this.root, ".gitattributes"))) files.push(".gitattributes");
    if (files.length > 0) await this.runGit(["add", "--", ...files]);
    await this.commit(message, { origin: "hand_edit" }, true);
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** A repo file's text, or null when missing, unsafe or a symlink. */
  async readFile(relPath: string): Promise<string | null> {
    if (!isSafeRepoPath(relPath)) return null;
    const absolute = path.join(this.root, relPath);
    try {
      if (await this.hasSymlinkUnderRoot(absolute, true)) return null;
      const stat = await fs.stat(absolute);
      if (!stat.isFile() || stat.size > MEMORY_REPO_LIMITS.fileBytes * 4) return null;
      return await fs.readFile(absolute, "utf8");
    } catch {
      return null;
    }
  }

  /** Root-relative markdown paths, `.git` and hidden entries skipped, at most the file limit. */
  async listFiles(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      if (out.length >= MEMORY_REPO_LIMITS.files) return;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), childRel);
        else if (entry.isFile() && /\.md$/i.test(entry.name)) out.push(childRel);
        if (out.length >= MEMORY_REPO_LIMITS.files) return;
      }
    };
    await walk(this.root, "");
    return out.sort();
  }

  async entries(relPath: string): Promise<MemoryRepoEntry[]> {
    return parseMemoryRepoEntries((await this.readFile(relPath)) ?? "");
  }

  /** The workspace's file (`workspaces/<slug>.md`), if one names this workspace id. */
  async workspaceFile(workspaceId: string): Promise<string | null> {
    if (!workspaceId) return null;
    const map = await this.workspaceFileMap();
    return map.get(workspaceId) ?? null;
  }

  private async workspaceFileMap(): Promise<Map<string, string>> {
    if (this.workspaceFiles) return this.workspaceFiles;
    const map = new Map<string, string>();
    for (const file of await this.listFiles()) {
      if (!file.startsWith(`${MEMORY_REPO_WORKSPACES_DIR}/`)) continue;
      for (const entry of await this.entries(file)) {
        const id = entry.metadata.workspace;
        if (id && !map.has(id)) map.set(id, file);
      }
    }
    this.workspaceFiles = map;
    return map;
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  async remember(input: MemoryRepoRememberInput): Promise<MemoryRepoWriteResult> {
    if (!this.isWritable()) return { status: "skipped", reason: "unavailable" };
    const screened = screenMemoryText(input.text, MEMORY_REPO_LIMITS.entryChars);
    if (!screened.ok) return { status: "skipped", reason: screened.reason };
    if (input.noMemory || containsNoMemoryDirective(input.originText)) {
      return { status: "skipped", reason: "no_memory" };
    }
    if (!input.skipWorkspacePolicy && input.workspaceId && this.deps.getWorkspacePolicy) {
      let policy: MemoryWorkspacePolicy | null = null;
      try {
        policy = await this.deps.getWorkspacePolicy(input.workspaceId);
      } catch {
        policy = null;
      }
      const decision = workspaceMemoryPolicyDecision(
        policy,
        input.by === "user" ? "user_stated" : "inferred",
      );
      if (!decision.allowed) return { status: "skipped", reason: "memory_disabled" };
      // Strict privacy keeps memory private; the repo only holds what may be in a prompt.
      if (decision.private) return { status: "skipped", reason: "private" };
    }
    if (input.scope === "workspace" && !input.workspaceId) {
      return { status: "skipped", reason: "unavailable", detail: "workspace scope needs a workspace" };
    }
    return this.serialized(() => this.writeEntry(input, screened.content, screened.redactions));
  }

  /** Remove the entry at `repo:<path>#L<n>`. `expectHash` guards against shifted lines. */
  async forget(
    relPath: string,
    line: number,
    options: {
      expectHash?: string;
      reason?: string;
      taskId?: string | null;
      /** Commit origin (default `agent_tool`). */
      origin?: MemoryRepoOrigin;
    } = {},
  ): Promise<{ removed: MemoryRepoEntry | null; error?: string }> {
    if (!this.isWritable()) return { removed: null, error: "The memory repo is not available." };
    if (!isSafeRepoPath(relPath)) return { removed: null, error: "Not a memory repo file." };
    try {
      return await this.serialized(() =>
        this.locked(async () => {
          await this.commitHandEdits();
          const text = await this.readFile(relPath);
          if (text === null) return { removed: null, error: "No such memory file." };
          const entry = parseMemoryRepoLine(splitLines(text)[line - 1] ?? "", line);
          if (!entry) return { removed: null, error: "That line is not a saved memory." };
          if (options.expectHash && entry.hash !== options.expectHash) {
            return { removed: null, error: "The memory file changed; recall the memory again." };
          }
          await this.writeFileAtomic(relPath, replaceLine(text, line, null));
          await this.commitPaths([relPath], `Forget: ${preview(entry.text)}`, {
            origin: options.origin ?? "agent_tool",
            taskId: options.taskId ?? null,
          });
          return { removed: entry };
        }),
      );
    } catch (error) {
      return { removed: null, error: this.describeError(error) };
    }
  }

  /** The entry at a line, for approval prompts and attribution. */
  async entryAt(relPath: string, line: number): Promise<MemoryRepoEntry | null> {
    const text = await this.readFile(relPath);
    if (text === null) return null;
    return parseMemoryRepoLine(splitLines(text)[line - 1] ?? "", line);
  }

  /**
   * Replace the text of the entry at a line, keeping its metadata (`by` may be set: an
   * edit in the Memory Hub makes the line the user's). The text is screened like
   * `remember`. When another entry of the file already says the same, the edited line is
   * removed instead and that entry is returned.
   */
  async updateEntry(
    relPath: string,
    line: number,
    text: string,
    options: { expectHash?: string; by?: MemoryRepoAuthor; origin?: MemoryRepoOrigin } = {},
  ): Promise<{ entry: MemoryRepoEntry | null; unchanged?: boolean; error?: string }> {
    if (!this.isWritable()) return { entry: null, error: "The memory repo is not available." };
    if (!isSafeRepoPath(relPath)) return { entry: null, error: "Not a memory repo file." };
    const screened = screenMemoryText(text, MEMORY_REPO_LIMITS.entryChars);
    if (!screened.ok) return { entry: null, error: screenErrorMessage(screened.reason) };
    if (containsNoMemoryDirective(text)) {
      return { entry: null, error: "The text asks not to be remembered." };
    }
    try {
      return await this.serialized(() =>
        this.locked(async () => {
          await this.commitHandEdits();
          const file = await this.readFile(relPath);
          if (file === null) return { entry: null, error: "No such memory file." };
          const raw = splitLines(file)[line - 1] ?? "";
          const entry = parseMemoryRepoLine(raw, line);
          const problem = editableEntryProblem(entry, options.expectHash);
          if (problem || !entry) return { entry: null, error: problem ?? "That line is not a saved memory." };
          const metadata: MemoryRepoMetadata = {
            ...entry.metadata,
            ...(options.by ? { by: options.by } : {}),
          };
          const next = renderMemoryRepoEntry(screened.content, metadata);
          if (next === raw.trim()) return { entry, unchanged: true };
          const updated = parseMemoryRepoLine(next, line);
          if (!updated) return { entry: null, error: "That text cannot be saved." };
          const duplicate = parseMemoryRepoEntries(file).find(
            (other) => other.line !== line && other.hash === updated.hash,
          );
          const nextFile = replaceLine(file, line, duplicate ? null : next);
          if (Buffer.byteLength(nextFile, "utf8") > this.fileLimit(relPath)) {
            return { entry: null, error: `${relPath} is full; consolidate it first.` };
          }
          await this.writeFileAtomic(relPath, nextFile);
          await this.commitPaths([relPath], `Edit: ${preview(screened.content)}`, {
            origin: options.origin ?? "memory_hub",
          });
          if (duplicate) {
            const shifted = duplicate.line > line ? duplicate.line - 1 : duplicate.line;
            return { entry: { ...duplicate, line: shifted } };
          }
          return { entry: updated };
        }),
      );
    } catch (error) {
      return { entry: null, error: this.describeError(error) };
    }
  }

  /**
   * Move the entry at a line to another file (pin = move to `MEMORY.md`), keeping its
   * metadata (`by` may be set). When the target already holds the same text, only the
   * source line is removed and the target's line is returned.
   */
  async moveEntry(
    relPath: string,
    line: number,
    targetPath: string,
    options: { expectHash?: string; by?: MemoryRepoAuthor; origin?: MemoryRepoOrigin } = {},
  ): Promise<{ moved: { path: string; line: number } | null; error?: string }> {
    if (!this.isWritable()) return { moved: null, error: "The memory repo is not available." };
    if (!isSafeRepoPath(relPath) || !isSafeRepoPath(targetPath)) {
      return { moved: null, error: "Not a memory repo file." };
    }
    if (relPath === targetPath) return { moved: null, error: "The memory is already there." };
    try {
      return await this.serialized(() =>
        this.locked(async () => {
          await this.commitHandEdits();
          const source = await this.readFile(relPath);
          if (source === null) return { moved: null, error: "No such memory file." };
          const entry = parseMemoryRepoLine(splitLines(source)[line - 1] ?? "", line);
          const problem = editableEntryProblem(entry, options.expectHash);
          if (problem || !entry) return { moved: null, error: problem ?? "That line is not a saved memory." };
          const target = await this.readFile(targetPath);
          if (target === null) return { moved: null, error: "No such memory file." };
          const metadata: MemoryRepoMetadata = {
            ...entry.metadata,
            ...(options.by ? { by: options.by } : {}),
          };
          const rendered = renderMemoryRepoEntry(entry.text, metadata);
          const existing = parseMemoryRepoEntries(target).find((other) => other.hash === entry.hash);
          let nextTarget = target;
          let targetLine: number;
          if (existing) {
            targetLine = existing.line;
          } else {
            nextTarget = insertEntryLine(target, rendered, targetPath === MEMORY_REPO_ENTRY_FILE);
            targetLine = splitLines(nextTarget).findIndex((row) => row === rendered) + 1;
            if (Buffer.byteLength(nextTarget, "utf8") > this.fileLimit(targetPath)) {
              return { moved: null, error: `${targetPath} is full; consolidate it first.` };
            }
          }
          const changed = [relPath];
          await this.writeFileAtomic(relPath, replaceLine(source, line, null));
          if (nextTarget !== target) {
            await this.writeFileAtomic(targetPath, nextTarget);
            changed.push(targetPath);
          }
          await this.commitPaths(
            changed,
            `${targetPath === MEMORY_REPO_ENTRY_FILE ? "Pin" : "Move"}: ${preview(entry.text)}`,
            { origin: options.origin ?? "memory_hub" },
          );
          return { moved: { path: targetPath, line: targetLine } };
        }),
      );
    } catch (error) {
      return { moved: null, error: this.describeError(error) };
    }
  }

  /**
   * Keep an inbox entry (docs/memory-repo-phase5-design.md §3): move it to `me.md`,
   * `lessons.md` or the workspace's file as the user's line, keeping its other metadata.
   * The target file is created (and linked from the index) when missing.
   */
  async keepEntry(
    relPath: string,
    line: number,
    target: MemoryRepoKeepTarget,
    options: { expectHash?: string; workspaceId?: string | null; workspaceName?: string | null } = {},
  ): Promise<{ moved: { path: string; line: number } | null; error?: string }> {
    if (!this.isWritable()) return { moved: null, error: "The memory repo is not available." };
    if (relPath !== MEMORY_REPO_INBOX_FILE) {
      return { moved: null, error: "Only inbox entries can be kept." };
    }
    if (target === "workspace" && !options.workspaceId) {
      return { moved: null, error: "Keeping it for a workspace needs a workspace." };
    }
    try {
      return await this.serialized(() =>
        this.locked(async () => {
          await this.commitHandEdits();
          const source = await this.readFile(relPath);
          if (source === null) return { moved: null, error: "No such memory file." };
          const entry = parseMemoryRepoLine(splitLines(source)[line - 1] ?? "", line);
          const problem = editableEntryProblem(entry, options.expectHash);
          if (problem || !entry) return { moved: null, error: problem ?? "That line is not a saved memory." };
          const file =
            target === "workspace"
              ? await this.chooseFile({
                  text: entry.text,
                  kind: entry.kind ?? "project_fact",
                  scope: "workspace",
                  workspaceId: options.workspaceId,
                  workspaceName: options.workspaceName,
                  by: "user",
                  origin: "memory_hub",
                })
              : target === "me"
                ? { path: MEMORY_REPO_ME_FILE, initial: initialTopicFile("About me") }
                : { path: MEMORY_REPO_LESSONS_FILE, initial: initialTopicFile("Lessons") };
          const current = await this.readFile(file.path);
          const created = current === null;
          const targetText = current ?? file.initial;
          const rendered = renderMemoryRepoEntry(entry.text, { ...entry.metadata, by: "user" });
          const existing = parseMemoryRepoEntries(targetText).find((other) => other.hash === entry.hash);
          let nextTarget = targetText;
          let targetLine: number;
          if (existing) {
            targetLine = existing.line;
          } else {
            nextTarget = insertEntryLine(targetText, rendered, false);
            targetLine = splitLines(nextTarget).findIndex((row) => row === rendered) + 1;
            if (Buffer.byteLength(nextTarget, "utf8") > this.fileLimit(file.path)) {
              return { moved: null, error: `${file.path} is full; consolidate it first.` };
            }
          }
          const changed = [relPath];
          await this.writeFileAtomic(relPath, replaceLine(source, line, null));
          if (created || nextTarget !== targetText) {
            await this.writeFileAtomic(file.path, nextTarget);
            changed.push(file.path);
          }
          if (created) {
            const entryFile = (await this.readFile(MEMORY_REPO_ENTRY_FILE)) ?? initialEntryFile();
            const linked = ensureIndexLink(entryFile, file.path);
            if (linked !== entryFile) {
              await this.writeFileAtomic(MEMORY_REPO_ENTRY_FILE, linked);
              changed.push(MEMORY_REPO_ENTRY_FILE);
            }
          }
          if (file.path.startsWith(`${MEMORY_REPO_WORKSPACES_DIR}/`)) this.workspaceFiles = null;
          await this.commitPaths(changed, `Keep: ${preview(entry.text)}`, { origin: "memory_hub" });
          return { moved: { path: file.path, line: targetLine } };
        }),
      );
    } catch (error) {
      return { moved: null, error: this.describeError(error) };
    }
  }

  /**
   * Add notes read from another folder to `inbox.md` (docs/memory-repo-phase5-design.md §3),
   * in one commit: each text is screened like `remember` (salience, secrets, `<no-memory>`),
   * deduped against every file of the folder, and written as an agent line with
   * `source: import` and `import: <label>`. Stops at the inbox size limit (`truncated`).
   */
  async importToInbox(
    entries: ReadonlyArray<MemoryRepoImportEntry>,
    label: string,
  ): Promise<MemoryRepoImportOutcome> {
    const outcome: MemoryRepoImportOutcome = { imported: 0, duplicates: 0, skipped: 0, truncated: false };
    if (!this.isWritable()) return { ...outcome, error: "The memory repo is not available." };
    const lines: string[] = [];
    for (const candidate of entries) {
      if (containsNoMemoryDirective(candidate.text)) {
        outcome.skipped += 1;
        continue;
      }
      const screened = screenMemoryText(candidate.text, MEMORY_REPO_LIMITS.entryChars);
      if (!screened.ok) {
        outcome.skipped += 1;
        continue;
      }
      lines.push(
        renderMemoryRepoEntry(screened.content, {
          by: "agent",
          ...(candidate.kind ? { kind: candidate.kind } : {}),
          source: "import",
          import: label,
          added: candidate.added && /^\d{4}-\d{2}-\d{2}$/.test(candidate.added)
            ? candidate.added
            : isoDay(this.now()),
        }),
      );
    }
    if (lines.length === 0) return outcome;
    try {
      return await this.serialized(() =>
        this.locked(async () => {
          await this.commitHandEdits();
          const known = new Set<string>();
          for (const file of (await this.listFiles()).filter((name) => !isSwarmRepoPath(name))) {
            for (const entry of parseMemoryRepoEntries((await this.readFile(file)) ?? "")) {
              known.add(entry.hash);
            }
          }
          const current = await this.readFile(MEMORY_REPO_INBOX_FILE);
          let text = current ?? initialTopicFile(MEMORY_REPO_INBOX_TITLE);
          for (const line of lines) {
            const parsed = parseMemoryRepoLine(line, 1);
            if (!parsed) {
              outcome.skipped += 1;
              continue;
            }
            if (known.has(parsed.hash)) {
              outcome.duplicates += 1;
              continue;
            }
            const next = insertEntryLine(text, line, false);
            if (Buffer.byteLength(next, "utf8") > MEMORY_REPO_LIMITS.fileBytes) {
              outcome.truncated = true;
              break;
            }
            text = next;
            known.add(parsed.hash);
            outcome.imported += 1;
          }
          if (outcome.imported === 0) return outcome;
          await this.writeFileAtomic(MEMORY_REPO_INBOX_FILE, text);
          await this.commitPaths(
            [MEMORY_REPO_INBOX_FILE],
            `Import ${outcome.imported} note${outcome.imported === 1 ? "" : "s"} from ${label}`,
            { origin: "import" },
          );
          return outcome;
        }),
      );
    } catch (error) {
      if (error instanceof MemoryRepoBusyError) {
        return { ...outcome, imported: 0, error: "The memory folder is busy; try again." };
      }
      this.lastWriteError = this.describeError(error);
      return { ...outcome, imported: 0, error: this.lastWriteError };
    }
  }

  /**
   * Remove every entry `match` accepts (default: in every file), in one commit. The
   * workspace marker lines are kept. Returns how many entries were removed.
   */
  async forgetWhere(
    match: (entry: MemoryRepoEntry, file: string) => boolean,
    options: { files?: string[]; message: string; origin?: MemoryRepoOrigin },
  ): Promise<number> {
    if (!this.isWritable()) return 0;
    const files = options.files?.filter((file) => isSafeRepoPath(file));
    try {
      return await this.removeMatching(match, options.message, files, options.origin);
    } catch (error) {
      logger.warn("Memory repo forget failed:", error);
      return 0;
    }
  }

  /**
   * The absolute path of a repo file for "Open file": a safe repo-relative markdown path
   * to a regular file with no symlink between the root and the file; null otherwise.
   */
  async resolveFile(relPath: string): Promise<string | null> {
    if (!this.ready || !isSafeRepoPath(relPath)) return null;
    const absolute = path.join(this.root, relPath);
    try {
      if (await this.hasSymlinkUnderRoot(absolute, true)) return null;
      const stat = await fs.lstat(absolute);
      return stat.isFile() ? absolute : null;
    } catch {
      return null;
    }
  }

  private fileLimit(relPath: string): number {
    return relPath === MEMORY_REPO_ENTRY_FILE
      ? MEMORY_REPO_LIMITS.entryFileBytes
      : MEMORY_REPO_LIMITS.fileBytes;
  }

  /**
   * Remove agent lines learned in a task (task delete with `purgeDerivedMemory`). The
   * history keeps them until the user compacts it.
   */
  async purgeTask(taskId: string): Promise<number> {
    if (!this.isWritable() || !taskId) return 0;
    const source = taskSourceLink(taskId);
    return this.removeMatching(
      (entry) => entry.by === "agent" && entry.metadata.source === source,
      `Forget what task ${taskId.slice(0, 8)} learned`,
    );
  }

  // ---------------------------------------------------------------------------
  // Swarm folders (docs/memory-repo-phase5-design.md §2)
  // ---------------------------------------------------------------------------

  /**
   * Append a peer note to `swarms/<slug>/findings.md` (finding, ruled_out) or `questions.md`
   * (question, answer), creating `README.md` with the first note. Screened like `remember`;
   * one commit per note (origin `swarm`); never linked from MEMORY.md. The slug comes from
   * the task chain (`resolveSwarm`), never from the model.
   */
  async swarmAppend(input: MemoryRepoSwarmAppendInput): Promise<MemoryRepoWriteResult> {
    if (!this.isWritable()) return { status: "skipped", reason: "unavailable" };
    const folder = swarmFolderPath(input.slug);
    if (!folder) return { status: "skipped", reason: "unavailable", detail: "invalid swarm" };
    if (!(SWARM_NOTE_KINDS as readonly string[]).includes(input.kind)) {
      return { status: "skipped", reason: "empty", detail: "unknown note kind" };
    }
    const screened = screenMemoryText(input.text, MEMORY_REPO_LIMITS.entryChars);
    if (!screened.ok) return { status: "skipped", reason: screened.reason };
    if (containsNoMemoryDirective(input.text)) return { status: "skipped", reason: "no_memory" };
    const sources = (input.sources ?? [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .slice(0, 5)
      .join(", ");
    const metadata: MemoryRepoMetadata = {
      by: "agent",
      kind: input.kind,
      ...(input.taskId ? { source: taskSourceLink(input.taskId) } : {}),
      added: isoDay(this.now()),
      ...(input.author?.trim() ? { author: input.author.trim() } : {}),
      ...(sources ? { sources } : {}),
      ...(input.tainted ? { tainted: "yes" } : {}),
    };
    const relPath = `${folder}/${swarmFileForKind(input.kind)}`;
    const readmePath = `${folder}/${SWARM_README_FILE}`;
    const redactions = screened.redactions;
    return this.serialized(async () => {
      try {
        return await this.locked(async () => {
          const current = await this.readFile(relPath);
          let text = current ?? initialSwarmNotesFile(input.kind);
          const hash = parseMemoryRepoLine(`- ${screened.content}`, 1)?.hash;
          const same = parseMemoryRepoEntries(text).find((entry) => entry.hash === hash);
          if (same) {
            return {
              status: "written",
              action: "reinforced",
              ref: memoryRepoRef(relPath, same.line),
              path: relPath,
              line: same.line,
              redactions,
            } as const;
          }
          const line = renderMemoryRepoEntry(screened.content, metadata);
          text = insertEntryLine(text, line, false);
          if (Buffer.byteLength(text, "utf8") > MEMORY_REPO_LIMITS.fileBytes) {
            throw new SkipWrite("too_large", `${relPath} is full.`);
          }
          await this.commitHandEdits();
          const changed = [relPath];
          await this.writeFileAtomic(relPath, text);
          if ((await this.readFile(readmePath)) === null) {
            await this.writeFileAtomic(
              readmePath,
              renderSwarmReadme({
                goal: input.goal ?? "",
                rootTaskId: input.rootTaskId ?? "",
                members: input.members ?? [],
              }),
            );
            changed.push(readmePath);
          }
          await this.commitPaths(changed, `Swarm ${input.kind}: ${preview(screened.content)}`, {
            origin: "swarm",
            taskId: input.taskId ?? null,
          });
          const lineNumber = splitLines(text).findIndex((row) => row === line) + 1;
          return {
            status: "written",
            action: "inserted",
            ref: memoryRepoRef(relPath, lineNumber),
            path: relPath,
            line: lineNumber,
            redactions,
          } as const;
        });
      } catch (error) {
        if (error instanceof SkipWrite) {
          return { status: "skipped", reason: error.reason, ...(error.detail ? { detail: error.detail } : {}) };
        }
        if (error instanceof MemoryRepoBusyError) return { status: "skipped", reason: "busy" };
        this.lastWriteError = this.describeError(error);
        logger.warn("Memory repo swarm write failed:", error);
        return { status: "skipped", reason: "unavailable", detail: this.lastWriteError };
      }
    });
  }

  /** The texts of a swarm folder's files (null when missing). */
  async swarmFiles(
    slug: string,
  ): Promise<{ readme: string | null; findings: string | null; questions: string | null } | null> {
    const folder = swarmFolderPath(slug);
    if (!folder || !this.ready) return null;
    return {
      readme: await this.readFile(`${folder}/${SWARM_README_FILE}`),
      findings: await this.readFile(`${folder}/${SWARM_FINDINGS_FILE}`),
      questions: await this.readFile(`${folder}/${SWARM_QUESTIONS_FILE}`),
    };
  }

  /**
   * Remove the swarm folder of a root task (the root task was deleted), in one commit.
   * Folders are matched by the root id in the slug and confirmed by the README's root link.
   */
  async purgeSwarm(rootTaskId: string): Promise<number> {
    if (!this.isWritable() || !rootTaskId) return 0;
    const suffix = `-${swarmSlug("", rootTaskId).split("-").pop()}`;
    const swarmsDir = path.join(this.root, MEMORY_REPO_SWARMS_DIR);
    // Most deleted tasks never started a swarm: skip the lock then.
    const candidates = await fs.readdir(swarmsDir).catch(() => [] as string[]);
    if (!candidates.some((name) => name.endsWith(suffix))) return 0;
    try {
      return await this.serialized(() =>
        this.locked(async () => {
          const names = await fs.readdir(swarmsDir, { withFileTypes: true }).catch(() => []);
          const folders: string[] = [];
          for (const entry of names) {
            if (!entry.isDirectory() || !entry.name.endsWith(suffix)) continue;
            const folder = swarmFolderPath(entry.name);
            if (!folder) continue;
            const readme = await this.readFile(`${folder}/${SWARM_README_FILE}`);
            if (readme !== null && !readme.includes(taskSourceLink(rootTaskId))) continue;
            if (await this.hasSymlinkUnderRoot(path.join(this.root, folder), true)) continue;
            folders.push(folder);
          }
          if (folders.length === 0) return 0;
          await this.commitHandEdits();
          for (const folder of folders) {
            await fs.rm(path.join(this.root, folder), { recursive: true, force: true });
          }
          await this.commitPaths(folders, `Remove swarm notes of task ${rootTaskId.slice(0, 8)}`, {
            origin: "swarm",
            taskId: rootTaskId,
          });
          return folders.length;
        }),
      );
    } catch (error) {
      logger.warn("Memory repo swarm purge failed:", error);
      return 0;
    }
  }

  /** Delete a workspace's file and its index link, then compact (Clear All Memories). */
  async clearWorkspace(workspaceId: string): Promise<boolean> {
    if (!this.isWritable()) return false;
    const file = await this.workspaceFile(workspaceId);
    if (!file) return false;
    await this.serialized(() =>
      this.locked(async () => {
        await this.commitHandEdits();
        await fs.rm(path.join(this.root, file), { force: true });
        const entryFile = (await this.readFile(MEMORY_REPO_ENTRY_FILE)) ?? "";
        const linkLine = splitLines(entryFile).findIndex(
          (row) => row.trim() === `- [[${file.replace(/\.md$/i, "")}]]`,
        );
        const changed = [file];
        if (linkLine >= 0) {
          await this.writeFileAtomic(MEMORY_REPO_ENTRY_FILE, replaceLine(entryFile, linkLine + 1, null));
          changed.push(MEMORY_REPO_ENTRY_FILE);
        }
        this.workspaceFiles = null;
        await this.commitPaths(changed, "Clear workspace memory", { origin: "memory_hub" });
      }),
    );
    await this.compactHistory();
    return true;
  }

  /** Empty the user's global files (Clear global memories), then compact. */
  async clearGlobal(): Promise<void> {
    if (!this.isWritable()) return;
    await this.removeMatching(() => true, "Clear global memories", [
      MEMORY_REPO_ENTRY_FILE,
      MEMORY_REPO_ME_FILE,
      MEMORY_REPO_LESSONS_FILE,
      MEMORY_REPO_INBOX_FILE,
    ]);
    await this.compactHistory();
  }

  /**
   * Replace the history with one commit of the current files, so removed lines are really
   * gone (§7.2). This departs from the spec skill's "never rewrite history" on purpose; the
   * repo has no remote in Phase 1.
   */
  async compactHistory(): Promise<{ compacted: boolean; error?: string }> {
    if (!this.isWritable()) return { compacted: false, error: "The memory repo is not available." };
    if (!this.hasGit) return { compacted: false, error: "git is not available." };
    try {
      return await this.serialized(() =>
        this.locked(async () => {
          await this.commitHandEdits();
          // Dream branches would keep the old history (and forgotten text) reachable.
          await this.dropDreamBranches("history compacted");
          const temp = `compact-${this.now().toString(36)}`;
          await this.runGit(["checkout", "-q", "--orphan", temp]);
          await this.commit("Compact memory history", { origin: "memory_hub" }, true);
          await this.runGit(["branch", "-D", "main"]).catch(() => undefined);
          await this.runGit(["branch", "-m", "main"]);
          await this.runGit(["reflog", "expire", "--expire=now", "--all"]);
          await this.runGit(["gc", "-q", "--prune=now"]);
          if (this.syncUrl) this.forcePushPending = true;
          this.head = (await this.runGit(["rev-parse", "HEAD"])).trim() || null;
          this.notify([]);
          return { compacted: true };
        }),
      );
    } catch (error) {
      return { compacted: false, error: this.describeError(error) };
    }
  }

  // ---------------------------------------------------------------------------
  // Sync with the user's private remote (docs/memory-repo-phase4-design.md §1)
  // ---------------------------------------------------------------------------

  /** Make the managed remote match the setting (null turns sync off). */
  async configureSync(url: string | null): Promise<{ ok: boolean; error?: string }> {
    const next = url && url.trim() ? url.trim() : null;
    if (next && !this.deps.allowLocalRemotesForTests && memoryRepoRemoteUrlProblem(next)) {
      return { ok: false, error: memoryRepoRemoteUrlProblem(next) ?? "Invalid remote." };
    }
    if (!this.isWritable() || !this.hasGit) {
      this.syncUrl = null;
      return { ok: !next, ...(next ? { error: "Sync needs a writable memory folder and git." } : {}) };
    }
    try {
      await this.serialized(() => this.locked(() => configureSyncRemote(this.git, this.root, next)));
      this.syncUrl = next;
      this.syncState = { ...emptySyncState(), remoteUrl: next ? redactRemoteUrl(next) : null };
      if (!next && this.pushTimer) {
        clearTimeout(this.pushTimer);
        this.pushTimer = null;
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: this.describeError(error) };
    }
  }

  isSyncConfigured(): boolean {
    return this.syncUrl !== null;
  }

  /**
   * Pull (fetch + rebase local commits) and, unless `push: false`, push. A conflict aborts the
   * rebase and pauses pushing until a later sync succeeds.
   */
  async syncNow(options: { push?: boolean } = {}): Promise<MemoryRepoSyncState> {
    if (!this.syncUrl || !this.isWritable() || !this.hasGit) return { ...this.syncState };
    try {
      await this.serialized(() =>
        this.locked(async () => {
          await this.commitHandEdits();
          await this.ensureUnionMerge();
          if (this.forcePushPending) {
            // History was compacted: the remote's history is replaced, not rebased onto.
            await this.runGit(["fetch", "--quiet", "--no-tags", MEMORY_REPO_SYNC_REMOTE, "main"]).catch(
              () => undefined,
            );
            const forced = await pushMemoryRepo(this.git, this.root, { force: true });
            this.syncState = forced.ok
              ? { ...this.syncState, lastPushAt: this.now(), ahead: 0, behind: 0, conflict: null, lastError: null }
              : { ...this.syncState, lastError: forced.error };
            if (forced.ok) this.forcePushPending = false;
            return;
          }
          const pulled = await pullMemoryRepo(this.git, this.root);
          const now = this.now();
          if (!pulled.ok) {
            this.syncState = {
              ...this.syncState,
              conflict: pulled.conflict ?? null,
              lastError: pulled.error ?? pulled.conflict ?? null,
            };
            return;
          }
          this.syncState = {
            ...this.syncState,
            lastPullAt: now,
            ahead: pulled.ahead,
            behind: pulled.behind,
            conflict: null,
            lastError: null,
          };
          if (pulled.changed) {
            this.head = (await this.runGit(["rev-parse", "HEAD"])).trim() || null;
            this.writeCount += 1;
            this.workspaceFiles = null;
            this.silentNotify = true;
            try {
              this.notify([]);
            } finally {
              this.silentNotify = false;
            }
          }
          if (options.push === false || (this.syncState.ahead === 0 && !this.forcePushPending)) return;
          const pushed = await pushMemoryRepo(this.git, this.root, { force: this.forcePushPending });
          if (pushed.ok) {
            this.forcePushPending = false;
            this.syncState = { ...this.syncState, lastPushAt: this.now(), ahead: 0, lastError: null };
          } else {
            this.syncState = { ...this.syncState, lastError: pushed.error };
          }
        }),
      );
    } catch (error) {
      this.syncState = { ...this.syncState, lastError: this.describeError(error) };
    }
    return { ...this.syncState };
  }

  /**
   * Memory notes are line lists: two machines adding lines to the same file should keep both
   * (git's `union` merge), instead of stopping on a conflict. Dreaming tidies duplicates.
   */
  private async ensureUnionMerge(): Promise<void> {
    const file = path.join(this.root, ".gitattributes");
    const current = await fs.readFile(file, "utf8").catch(() => "");
    if (/^\*\.md\s+merge=union\s*$/m.test(current)) return;
    await fs.writeFile(file, `${current.trimEnd()}${current.trim() ? "\n" : ""}*.md merge=union\n`, {
      mode: 0o600,
    });
    await this.runGit(["add", "--", ".gitattributes"]);
    await this.commit("Merge memory notes line by line", { origin: "memory_hub" });
  }

  private schedulePush(delayMs = 30_000): void {
    if (this.pushTimer || this.stopped) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.syncNow().catch(() => undefined);
    }, delayMs);
    this.pushTimer.unref?.();
  }

  // ---------------------------------------------------------------------------
  // Dreaming (docs/memory-repo-phase2-design.md §5)
  // ---------------------------------------------------------------------------

  /** Every markdown file's text, inbox included. */
  async readAllFiles(): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    for (const file of await this.listFiles()) {
      const text = await this.readFile(file);
      if (text !== null) files.set(file, text);
    }
    return files;
  }

  /**
   * Apply a dream: the automatic operations as one commit on main, the review operations as
   * one commit on branch `dream/<id>` (built in a temporary worktree outside the folder).
   * Operations are re-resolved against the files as they are now, under the lock.
   */
  async applyDream(params: {
    id: string;
    trigger: MemoryRepoDreamTrigger;
    startedAt: number;
    summary: string;
    operations: ClassifiedDreamOperation[];
    rejected: number;
    tokens: number;
    taskIds: string[];
    lastTaskCreatedAt: number | null;
  }): Promise<MemoryRepoDreamRecord> {
    if (!this.isWritable()) throw new Error("The memory repo is not available.");
    if (!this.hasGit) throw new Error("Dreaming needs git.");
    return this.serialized(() =>
      this.locked(async () => {
        await this.commitHandEdits();
        const now = this.now();
        const files = await this.readAllFiles();
        const autoOps = params.operations.filter((op) => op.decision === "auto");
        const reviewOps = params.operations.filter((op) => op.decision === "review");
        const auto = applyDreamOperations({ files, operations: autoOps, by: "agent", now });
        let autoCommit: string | null = null;
        if (auto.files.size > 0) {
          for (const [file, text] of auto.files) await this.writeFileAtomic(file, text);
          this.workspaceFiles = null;
          this.writeCount += 1;
          await this.runGit(["add", "-A", "--", ...auto.files.keys()]);
          await this.commit(
            `Dream ${isoDay(now)}: ${auto.applied.length} change${auto.applied.length === 1 ? "" : "s"}`,
            { origin: "dream", dreamId: params.id, details: auto.applied.map(describeDreamOperation) },
          );
          autoCommit = this.head;
          this.notify([...auto.files.keys()]);
        }
        const merged = new Map(files);
        for (const [file, text] of auto.files) merged.set(file, text);
        const review = applyDreamOperations({ files: merged, operations: reviewOps, by: "user", now });
        let reviewBranch: string | null = null;
        let reviewBase: string | null = null;
        if (review.files.size > 0) {
          reviewBase = this.head;
          reviewBranch = `dream/${params.id}`;
          await this.commitOnBranch(reviewBranch, review.files, {
            message: `Dream ${isoDay(now)} (for review): ${review.applied.length} change${review.applied.length === 1 ? "" : "s"}`,
            details: review.applied.map(describeDreamOperation),
            dreamId: params.id,
          });
        }
        const describe = (op: ClassifiedDreamOperation, decision: string, why?: string) => ({
          decision,
          description: describeDreamOperation(op),
          ...(op.op.reason ? { reason: op.op.reason } : {}),
          ...(why ? { why } : {}),
        });
        const record: MemoryRepoDreamRecord = {
          id: params.id,
          trigger: params.trigger,
          status: "completed",
          startedAt: params.startedAt,
          finishedAt: now,
          summary: params.summary,
          tokens: params.tokens,
          autoCommit,
          autoCount: auto.applied.length,
          reviewBranch,
          reviewBase,
          reviewCount: review.applied.length,
          reviewStatus: reviewBranch ? "pending" : null,
          rejected: params.rejected + params.operations.filter((op) => op.decision === "rejected").length,
          skipped: auto.skipped.length + review.skipped.length,
          operations: [
            ...auto.applied.map((op) => describe(op, "auto")),
            ...review.applied.map((op) => describe(op, "review", op.why)),
            ...params.operations
              .filter((op) => op.decision === "rejected")
              .map((op) => describe(op, "rejected", op.why)),
            ...[...auto.skipped, ...review.skipped].map((entry) => describe(entry.op, "skipped", entry.why)),
          ],
          taskIds: params.taskIds,
          lastTaskCreatedAt: params.lastTaskCreatedAt,
        };
        await this.writeDreamRecord(record);
        return record;
      }),
    );
  }

  /** Record a dream that did not apply anything (skipped or failed). */
  async recordDream(record: MemoryRepoDreamRecord): Promise<void> {
    if (!this.ready) return;
    await this.writeDreamRecord(record);
  }

  /** Dream records, newest first. */
  async listDreams(limit = 30): Promise<MemoryRepoDreamRecord[]> {
    const dir = this.dreamsDir();
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    const records: MemoryRepoDreamRecord[] = [];
    for (const name of names) {
      if (!/^[A-Za-z0-9_-]+\.json$/.test(name)) continue;
      try {
        records.push(JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as MemoryRepoDreamRecord);
      } catch {
        // A half-written record is skipped.
      }
    }
    return records.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
  }

  async getDream(id: string): Promise<MemoryRepoDreamRecord | null> {
    if (!DREAM_ID.test(id)) return null;
    try {
      return JSON.parse(await fs.readFile(path.join(this.dreamsDir(), `${id}.json`), "utf8")) as MemoryRepoDreamRecord;
    } catch {
      return null;
    }
  }

  /** The diff of a dream: its review branch against its base, or its automatic commit. */
  async dreamDiff(id: string, part: "review" | "auto"): Promise<string> {
    const record = await this.getDream(id);
    if (!record || !this.hasGit) return "";
    try {
      if (part === "review" && record.reviewBranch && record.reviewBase && record.reviewStatus === "pending") {
        return await this.runGit(["diff", "--no-color", "--no-ext-diff", `${record.reviewBase}..${record.reviewBranch}`]);
      }
      if (part === "auto" && record.autoCommit) {
        return await this.runGit(["show", "--no-color", "--no-ext-diff", "--format=", record.autoCommit]);
      }
    } catch {
      // The commit is gone (history compacted).
    }
    return "";
  }

  /** Merge a dream's review branch into main. A conflict leaves main unchanged (stale). */
  async acceptDream(id: string): Promise<{ accepted: boolean; error?: string }> {
    const record = await this.getDream(id);
    if (!record?.reviewBranch || record.reviewStatus !== "pending") {
      return { accepted: false, error: "Nothing waiting for review in this dream." };
    }
    if (!this.isWritable()) return { accepted: false, error: "The memory repo is not available." };
    const branch = record.reviewBranch;
    try {
      return await this.serialized(() =>
        this.locked(async () => {
          await this.commitHandEdits();
          // A review was made against older lines: a change underneath it must conflict (stale),
          // not be unioned in as sync merges are. `.git/info/attributes` wins over .gitattributes.
          const infoAttributes = path.join(this.root, ".git", "info", "attributes");
          const previousAttributes = await fs.readFile(infoAttributes, "utf8").catch(() => null);
          await fs.mkdir(path.dirname(infoAttributes), { recursive: true });
          await fs.writeFile(infoAttributes, "*.md merge=text\n", { mode: 0o600 });
          const restoreAttributes = () =>
            previousAttributes === null
              ? fs.rm(infoAttributes, { force: true })
              : fs.writeFile(infoAttributes, previousAttributes, { mode: 0o600 });
          try {
            await this.runGit(["merge", "--no-ff", "--no-edit", "-m", `Accept dream ${record.id}`, branch]);
            await restoreAttributes();
          } catch (error) {
            await restoreAttributes();
            await this.runGit(["merge", "--abort"]).catch(() => undefined);
            await this.writeDreamRecord({ ...record, reviewStatus: "stale" });
            await this.runGit(["branch", "-D", branch]).catch(() => undefined);
            return {
              accepted: false,
              error: `The memory folder changed since this dream; it was not applied (${this.describeError(error)}).`,
            };
          }
          this.head = (await this.runGit(["rev-parse", "HEAD"])).trim() || null;
          await this.runGit(["branch", "-D", branch]).catch(() => undefined);
          this.writeCount += 1;
          this.workspaceFiles = null;
          await this.writeDreamRecord({ ...record, reviewStatus: "accepted", reviewMergeCommit: this.head });
          this.notify([]);
          return { accepted: true };
        }),
      );
    } catch (error) {
      return { accepted: false, error: this.describeError(error) };
    }
  }

  async rejectDream(id: string): Promise<{ rejected: boolean; error?: string }> {
    const record = await this.getDream(id);
    if (!record?.reviewBranch || record.reviewStatus !== "pending") {
      return { rejected: false, error: "Nothing waiting for review in this dream." };
    }
    const branch = record.reviewBranch;
    try {
      return await this.serialized(() =>
        this.locked(async () => {
          await this.runGit(["branch", "-D", branch]).catch(() => undefined);
          await this.writeDreamRecord({ ...record, reviewStatus: "rejected" });
          return { rejected: true };
        }),
      );
    } catch (error) {
      return { rejected: false, error: this.describeError(error) };
    }
  }

  /** Undo a dream's automatic commit with `git revert`. A conflict leaves main unchanged. */
  async undoDream(id: string): Promise<{ undone: boolean; error?: string }> {
    const record = await this.getDream(id);
    if (!record?.autoCommit || record.undoneAt) {
      return { undone: false, error: "This dream has no automatic changes to undo." };
    }
    if (!this.isWritable()) return { undone: false, error: "The memory repo is not available." };
    const commit = record.autoCommit;
    try {
      return await this.serialized(() =>
        this.locked(async () => {
          await this.commitHandEdits();
          try {
            await this.runGit(["revert", "--no-edit", commit]);
          } catch (error) {
            await this.runGit(["revert", "--abort"]).catch(() => undefined);
            return {
              undone: false,
              error: `Later changes touch the same lines; undo it by hand (${this.describeError(error)}).`,
            };
          }
          this.head = (await this.runGit(["rev-parse", "HEAD"])).trim() || null;
          this.writeCount += 1;
          this.workspaceFiles = null;
          await this.writeDreamRecord({ ...record, undoneAt: this.now() });
          this.notify([]);
          return { undone: true };
        }),
      );
    } catch (error) {
      return { undone: false, error: this.describeError(error) };
    }
  }

  private dreamsDir(): string {
    return path.join(this.root, ".git", "cowork-dreams");
  }

  private async writeDreamRecord(record: MemoryRepoDreamRecord): Promise<void> {
    if (!DREAM_ID.test(record.id)) throw new Error("invalid dream id");
    const dir = this.dreamsDir();
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, `${record.id}.json`);
    const temp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(record, null, 2), { mode: 0o600 });
    await fs.rename(temp, target);
  }

  /** Delete every `dream/*` branch and mark pending reviews stale (before compaction). */
  private async dropDreamBranches(reason: string): Promise<void> {
    const branches = (await this.runGit(["for-each-ref", "--format=%(refname:short)", "refs/heads/dream/"]).catch(() => ""))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    for (const branch of branches) await this.runGit(["branch", "-D", branch]).catch(() => undefined);
    for (const record of await this.listDreams(1000)) {
      if (record.reviewStatus === "pending" || (record.autoCommit && !record.undoneAt)) {
        await this.writeDreamRecord({
          ...record,
          ...(record.reviewStatus === "pending" ? { reviewStatus: "stale" as const } : {}),
          ...(record.autoCommit ? { autoCommit: null, historyNote: reason } : {}),
        });
      }
    }
  }

  /** One commit on a new branch from HEAD, built in a temporary worktree outside the folder. */
  private async commitOnBranch(
    branch: string,
    files: Map<string, string>,
    meta: { message: string; details: string[]; dreamId: string },
  ): Promise<void> {
    const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-dream-"));
    await fs.rm(worktree, { recursive: true, force: true });
    await this.runGit(["worktree", "add", "-q", "-b", branch, worktree, "HEAD"]);
    try {
      for (const [file, text] of files) {
        if (!isSafeRepoPath(file)) throw new Error(`unsafe memory path: ${file}`);
        const absolute = path.join(worktree, file);
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        await fs.writeFile(absolute, text.endsWith("\n") ? text : `${text}\n`, { mode: 0o600 });
      }
      await this.git(worktree, ["add", "-A", "--", ...files.keys()]);
      await this.git(worktree, ["commit", "-q", "--no-verify", "-m", this.commitBody(meta.message, { origin: "dream", dreamId: meta.dreamId, details: meta.details })]);
    } catch (error) {
      await this.runGit(["worktree", "remove", "--force", worktree]).catch(() => undefined);
      await this.runGit(["branch", "-D", branch]).catch(() => undefined);
      throw error;
    }
    await this.runGit(["worktree", "remove", "--force", worktree]).catch(() => undefined);
    await this.runGit(["worktree", "prune"]).catch(() => undefined);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async writeEntry(
    input: MemoryRepoRememberInput,
    content: string,
    redactions: number,
  ): Promise<MemoryRepoWriteResult> {
    try {
      return await this.locked(async () => {
        const target = await this.chooseFile(input);
        const created = (await this.readFile(target.path)) === null;
        let text = created ? target.initial : ((await this.readFile(target.path)) ?? "");
        const entries = parseMemoryRepoEntries(text);
        const hash = parseMemoryRepoLine(`- ${content}`, 1)?.hash;
        const same = entries.find((entry) => entry.hash === hash);
        if (same) {
          return {
            status: "written",
            action: "reinforced",
            ref: memoryRepoRef(target.path, same.line),
            path: target.path,
            line: same.line,
            redactions,
          } as const;
        }
        const metadata: MemoryRepoMetadata = {
          ...extraMetadata(input.metadata, Boolean(input.taskId)),
          by: input.by,
          kind: input.kind,
          ...(input.subject ? { subject: input.subject } : {}),
          ...(input.taskId ? { source: taskSourceLink(input.taskId) } : {}),
          added: isoDay(input.addedAt ?? this.now()),
        };
        const line = renderMemoryRepoEntry(content, metadata);
        const holder = input.subject
          ? entries.find((entry) => entry.subject && entry.subject === normalizeSubject(input.subject))
          : undefined;
        let action: "inserted" | "replaced" = "inserted";
        let lineNumber: number;
        if (holder) {
          if (holder.by === "user" && input.by === "agent") {
            throw new SkipWrite("outranked", `The user stated "${preview(holder.text)}".`);
          }
          text = replaceLine(text, holder.line, line);
          action = "replaced";
          lineNumber = holder.line;
        } else {
          text = insertEntryLine(text, line, target.path === MEMORY_REPO_ENTRY_FILE);
          lineNumber = splitLines(text).findIndex((row) => row === line) + 1;
        }
        const limit =
          target.path === MEMORY_REPO_ENTRY_FILE
            ? MEMORY_REPO_LIMITS.entryFileBytes
            : MEMORY_REPO_LIMITS.fileBytes;
        if (Buffer.byteLength(text, "utf8") > limit) {
          throw new SkipWrite("too_large", `${target.path} is full; consolidate it first.`);
        }
        await this.commitHandEdits();
        const changed = [target.path];
        await this.writeFileAtomic(target.path, text);
        // The inbox is unreviewed: never linked, so following the index never reaches it.
        if (created && target.path !== MEMORY_REPO_ENTRY_FILE && target.path !== MEMORY_REPO_INBOX_FILE) {
          const entryFile = (await this.readFile(MEMORY_REPO_ENTRY_FILE)) ?? initialEntryFile();
          const linked = ensureIndexLink(entryFile, target.path);
          if (linked !== entryFile) {
            await this.writeFileAtomic(MEMORY_REPO_ENTRY_FILE, linked);
            changed.push(MEMORY_REPO_ENTRY_FILE);
          }
        }
        if (target.path.startsWith(`${MEMORY_REPO_WORKSPACES_DIR}/`)) this.workspaceFiles = null;
        await this.commitPaths(
          changed,
          `${action === "replaced" ? "Update" : "Remember"} ${input.kind}: ${preview(content)}`,
          { origin: input.origin, taskId: input.taskId ?? null },
        );
        return {
          status: "written",
          action,
          ref: memoryRepoRef(target.path, lineNumber),
          path: target.path,
          line: lineNumber,
          redactions,
          ...(holder ? { replaced: holder.text } : {}),
        } as const;
      });
    } catch (error) {
      if (error instanceof SkipWrite) {
        return { status: "skipped", reason: error.reason, ...(error.detail ? { detail: error.detail } : {}) };
      }
      if (error instanceof MemoryRepoBusyError) return { status: "skipped", reason: "busy" };
      this.lastWriteError = this.describeError(error);
      logger.warn("Memory repo write failed:", error);
      return { status: "skipped", reason: "unavailable", detail: this.lastWriteError };
    }
  }

  private async chooseFile(
    input: MemoryRepoRememberInput,
  ): Promise<{ path: string; initial: string }> {
    if (input.by === "agent" && input.tainted) {
      return { path: MEMORY_REPO_INBOX_FILE, initial: initialTopicFile(MEMORY_REPO_INBOX_TITLE) };
    }
    if (input.by === "user" && input.pinned) {
      const entryFile = (await this.readFile(MEMORY_REPO_ENTRY_FILE)) ?? "";
      if (Buffer.byteLength(entryFile, "utf8") < MEMORY_REPO_LIMITS.entryFileBytes - MEMORY_REPO_LIMITS.entryChars * 2) {
        return { path: MEMORY_REPO_ENTRY_FILE, initial: initialEntryFile(this.deps.ownerName?.()) };
      }
    }
    if (input.scope === "global") {
      return ABOUT_USER_KINDS.has(input.kind)
        ? { path: MEMORY_REPO_ME_FILE, initial: initialTopicFile("About me") }
        : { path: MEMORY_REPO_LESSONS_FILE, initial: initialTopicFile("Lessons") };
    }
    const workspaceId = String(input.workspaceId);
    const existing = await this.workspaceFile(workspaceId);
    const name = input.workspaceName?.trim() || "Workspace";
    const header = `${initialTopicFile(name)}${renderMemoryRepoEntry("CoWork workspace", {
      by: "user",
      workspace: workspaceId,
    })}\n`;
    if (existing) return { path: existing, initial: header };
    const taken = new Set(await this.listFiles());
    const slug = workspaceSlug(name);
    let candidate = `${MEMORY_REPO_WORKSPACES_DIR}/${slug}.md`;
    for (let n = 2; taken.has(candidate); n += 1) {
      candidate = `${MEMORY_REPO_WORKSPACES_DIR}/${slug}-${n}.md`;
    }
    return { path: candidate, initial: header };
  }

  /** Remove every entry `match` accepts in `files` (default: all files), in one commit. */
  private async removeMatching(
    match: (entry: MemoryRepoEntry, file: string) => boolean,
    message: string,
    files?: string[],
    origin: MemoryRepoOrigin = "memory_hub",
  ): Promise<number> {
    return this.serialized(() =>
      this.locked(async () => {
        await this.commitHandEdits();
        let removed = 0;
        const changed: string[] = [];
        for (const file of files ?? (await this.listFiles())) {
          const text = await this.readFile(file);
          if (text === null) continue;
          const lines = splitLines(text);
          const keep = lines.filter((row, index) => {
            const entry = parseMemoryRepoLine(row, index + 1);
            // The workspace marker line keeps the file mapped.
            if (!entry || entry.metadata.workspace) return true;
            if (!match(entry, file)) return true;
            removed += 1;
            return false;
          });
          if (keep.length !== lines.length) {
            await this.writeFileAtomic(file, keep.join("\n"));
            changed.push(file);
          }
        }
        if (changed.length > 0) await this.commitPaths(changed, message, { origin });
        return removed;
      }),
    );
  }

  private serialized<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job, job);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private locked<T>(job: () => Promise<T>): Promise<T> {
    return withMemoryRepoLock(this.lockPath(), job, {
      timeoutMs: this.deps.lockTimeoutMs ?? 5_000,
      runtime: this.deps.runtime,
      now: this.now,
    });
  }

  private lockPath(): string {
    const gitDir = path.join(this.root, ".git");
    if (fsSync.existsSync(gitDir)) return path.join(gitDir, "cowork-write.lock");
    const key = createHash("sha256").update(this.root).digest("hex").slice(0, 16);
    return path.join(os.tmpdir(), `cowork-memory-${key}.lock`);
  }

  /**
   * Commit hand edits to markdown files before a write (§5.3). Anything else in the work
   * tree (non-markdown files, conflicts, a merge or rebase) stops the write.
   */
  private async commitHandEdits(): Promise<void> {
    if (!this.hasGit) return;
    for (const marker of ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD"]) {
      if (fsSync.existsSync(path.join(this.root, ".git", marker))) {
        throw new SkipWrite("dirty", "a git operation is in progress in the memory folder");
      }
    }
    const all = parsePorcelainZ(await this.runGit(["status", "--porcelain=v1", "-z", "-uall"]));
    // Untracked files that are not memory notes (.DS_Store, editor folders) are left alone.
    const changes = all.filter((change) => change.code !== "??" || isSafeRepoPath(change.path));
    if (changes.length === 0) return;
    const unsafe = changes.find(
      (change) =>
        change.code.includes("U") ||
        change.code === "AA" ||
        change.code === "DD" ||
        !isSafeRepoPath(change.path),
    );
    if (unsafe) {
      throw new SkipWrite("dirty", `unexpected change in the memory folder: ${unsafe.path}`);
    }
    await this.runGit(["add", "-A", "--", ...changes.map((change) => change.path)]);
    await this.commit("Hand edits", { origin: "hand_edit" });
    this.workspaceFiles = null;
  }

  private async commitPaths(
    paths: string[],
    message: string,
    meta: { origin: MemoryRepoOrigin; taskId?: string | null },
  ): Promise<void> {
    this.writeCount += 1;
    if (this.hasGit) {
      await this.runGit(["add", "-A", "--", ...paths]);
      await this.commit(message, meta);
    }
    this.lastWriteError = null;
    this.notify(paths);
  }

  private commitBody(message: string, meta: CommitMeta): string {
    return [
      message.slice(0, 200),
      ...(meta.details?.length ? ["", ...meta.details.slice(0, 50).map((line) => `- ${line}`)] : []),
      "",
      `Origin: ${meta.origin}`,
      ...(meta.taskId ? [`Task: ${meta.taskId}`] : []),
      ...(meta.dreamId ? [`Dream: ${meta.dreamId}`] : []),
    ].join("\n");
  }

  private async commit(message: string, meta: CommitMeta, allowEmpty = false): Promise<void> {
    const body = this.commitBody(message, meta);
    await this.runGit(["commit", "-q", "--no-verify", ...(allowEmpty ? ["--allow-empty"] : []), "-m", body]);
    this.head = (await this.runGit(["rev-parse", "HEAD"]).catch(() => "")).trim() || null;
  }

  private runGit(args: string[]): Promise<string> {
    return this.git(this.root, args);
  }

  /** Atomic write of a repo file; refuses a symlink anywhere between the root and the file. */
  private async writeFileAtomic(relPath: string, text: string): Promise<void> {
    if (!isSafeRepoPath(relPath)) throw new Error(`unsafe memory path: ${relPath}`);
    const absolute = path.join(this.root, relPath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    if (await this.hasSymlinkUnderRoot(absolute, false)) {
      throw new Error(`refusing to write through a symbolic link: ${relPath}`);
    }
    const temp = path.join(
      path.dirname(absolute),
      `.${path.basename(absolute)}.${process.pid}.${this.now().toString(36)}.tmp`,
    );
    await fs.writeFile(temp, text.endsWith("\n") ? text : `${text}\n`, { mode: 0o600 });
    await fs.rename(temp, absolute);
  }

  private async hasSymlinkUnderRoot(absolute: string, includeLeaf: boolean): Promise<boolean> {
    const relative = path.relative(this.root, absolute);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return true;
    const segments = relative.split(path.sep);
    let current = this.root;
    const rootStat = await fs.lstat(current).catch(() => null);
    if (rootStat?.isSymbolicLink()) return true;
    for (let i = 0; i < segments.length; i += 1) {
      current = path.join(current, segments[i]);
      if (i === segments.length - 1 && !includeLeaf) {
        const leaf = await fs.lstat(current).catch(() => null);
        return leaf?.isSymbolicLink() === true;
      }
      const stat = await fs.lstat(current).catch(() => null);
      if (!stat) return false;
      if (stat.isSymbolicLink()) return true;
    }
    return false;
  }

  private notify(paths: string[]): void {
    if (this.syncUrl && !this.silentNotify) this.schedulePush();
    const change = { paths, version: this.version() };
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (error) {
        logger.warn("Memory repo change listener failed:", error);
      }
    }
  }

  private describeError(error: unknown): string {
    if (error instanceof SkipWrite) return error.detail ?? error.reason;
    return error instanceof Error ? error.message : String(error);
  }
}

interface CommitMeta {
  origin: MemoryRepoOrigin;
  taskId?: string | null;
  dreamId?: string;
  details?: string[];
}

const DREAM_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type MemoryRepoDreamTrigger = "daily" | "manual";

/** One dream run as recorded in `.git/cowork-dreams/<id>.json` (design §5). */
export interface MemoryRepoDreamRecord {
  id: string;
  trigger: MemoryRepoDreamTrigger;
  status: "completed" | "skipped" | "failed";
  startedAt: number;
  finishedAt: number;
  summary: string;
  skipReason?: string;
  error?: string;
  tokens: number;
  autoCommit: string | null;
  autoCount: number;
  undoneAt?: number;
  reviewBranch: string | null;
  reviewBase: string | null;
  reviewCount: number;
  reviewStatus: "pending" | "accepted" | "rejected" | "stale" | null;
  reviewMergeCommit?: string | null;
  rejected: number;
  skipped: number;
  operations: Array<{ decision: string; description: string; reason?: string; why?: string }>;
  taskIds: string[];
  lastTaskCreatedAt: number | null;
  historyNote?: string;
}

export function taskSourceLink(taskId: string): string {
  return `cowork://tasks/${taskId}`;
}

function normalizeSubject(subject: string | null | undefined): string | null {
  return parseMemoryRepoLine(`- x [subject: ${subject ?? ""}]`, 1)?.subject ?? null;
}

/** The caller's extra metadata, without the keys `remember` owns. */
function extraMetadata(
  metadata: Record<string, string> | undefined,
  hasTask: boolean,
): MemoryRepoMetadata {
  const out: MemoryRepoMetadata = {};
  for (const [rawKey, value] of Object.entries(metadata ?? {})) {
    const key = rawKey.trim().toLowerCase();
    if (!/^[a-z][\w-]*$/.test(key) || RESERVED_METADATA_KEYS.has(key)) continue;
    if (key === "source" && hasTask) continue;
    if (typeof value === "string" && value.trim()) out[key] = value;
  }
  return out;
}

/** Why an entry cannot be edited, moved or removed from the Hub; null when it can. */
function editableEntryProblem(entry: MemoryRepoEntry | null, expectHash?: string): string | null {
  if (!entry) return "That line is not a saved memory.";
  if (expectHash && entry.hash !== expectHash) {
    return "The memory file changed; reload and try again.";
  }
  // The `[workspace: <id>]` marker line maps the file to its workspace.
  if (entry.metadata.workspace) return "That line names the workspace; it cannot be changed here.";
  return null;
}

function screenErrorMessage(reason: "empty" | "low_salience" | "secret_only"): string {
  switch (reason) {
    case "empty":
      return "A memory cannot be empty.";
    case "secret_only":
      return "That text is only a secret; secrets are not saved to memory.";
    default:
      return "That text is too short to be a useful memory.";
  }
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
}
