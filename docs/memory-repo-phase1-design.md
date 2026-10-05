# Memory Repo — Phase 1 design

**Status.** Implemented behind `memoryRepoEnabled` (off by default), 2026-10-05. Step 0 (the
agent can call `memory_remember` in every plan step; its own facts stay out of L0) shipped
first; see [memory-engine.md](memory-engine.md) §4a and §4b. Deviations from this design are
listed in §14.

**Decision this implements.** Move CoWork's long-term knowledge (facts about the user,
workspace facts, lessons) to a local git repository of markdown files that follows the
[Agent Memory Repo](https://github.com/AgentMemoryRepo/agentmemoryrepo) spec. Keep CoWork's
safety layer (redaction, `<no-memory>`, privacy modes, channel gating, third-party isolation)
and its episodic lanes (conversation index, archive, Chronicle, Supermemory). Phase 1 ships
behind a setting that is off by default.

**Why.** After memory Phases 0–5 the live fact store on the main development profile held
12 items, 9 of them mailbox notes about contacts. `memory_remember` had never been called,
and Dreaming had applied nothing. The engine's hygiene is sound, but nothing feeds it. The
Agent Memory Repo model puts the agent in charge of writing memory as it works, in a medium
it already knows (files and grep), with git for history, undo and sync.

## 1. Goals and non-goals

Goals for Phase 1:

1. A spec-compliant personal memory repo that CoWork creates and owns, outside every
   workspace.
2. `MEMORY.md` (plus the current workspace's file) in the prompt of every private task.
3. `memory_remember` writes one-line entries into the repo through a governed writer that
   redacts, checks policy and commits every change.
4. The agent can read and search the repo (read tools and a `repo` lane in `memory_recall`),
   but never writes files in it or runs git on it.
5. The existing facts are exported once into the repo.
6. Measurement: write rate, read rate, repo size, eval cases for poisoning and privacy.

Non-goals for Phase 1 (later phases):

- Dreaming as an LLM agent over the repo and recent sessions (Phase 2).
- Retiring `memory_items` as the store of truth, the kit auto-blocks, the heuristic curator,
  topic packs and daily summaries (Phase 3).
- Remotes, team repos, several repos per session, swarm folders, import and export with
  other agents (Phase 4).
- Agent-authored restructuring of the repo (moving entries, new topic files). Phase 1 writes
  to a fixed set of files; Phase 2's Dreaming reorganizes.

## 2. Where the repo lives

| Option | For | Against |
|---|---|---|
| `~/CoWork Memory/` (default proposed) | Visible in Finder, easy to open in any editor or point another agent at, survives an app reinstall | Outside the profile; a second profile needs its own path |
| `<userData>/memory-repo/` | Per profile by construction, next to the database | Hidden; editing by hand and sharing are harder |

Decided (2026-10-05): default `~/CoWork Memory/` for the default profile and
`<userData>/memory-repo/` for any other profile. The path is a setting
(`memoryRepoPath`), resolved and validated in main: absolute, not inside any workspace,
not a protected filesystem root, not a symlink, and either empty, missing, or already a
memory repo (its own git top level with a `MEMORY.md`). The renderer never sends a path for
anything other than this setting.

## 3. Repository layout and format

The spec leaves the layout open. CoWork uses a fixed starting layout so that the writer knows
where each kind goes:

```text
CoWork Memory/
  MEMORY.md              ← entry point, loaded every session (spec)
  me.md                  ← about the user: identity, preferences, corrections
  lessons.md             ← cross-workspace lessons: commands, setup, pitfalls
  workspaces/
    cowork.md            ← one file per workspace with facts, decisions, rules
    billing-service.md
  inbox.md               ← agent writes from tasks that read untrusted content (§7.3)
```

`MEMORY.md` follows the spec: a title, a few entries every session needs, and an index.

```markdown
# Memory: Mesut

- Prefers concise answers with bullet points [by: user; added: 2026-10-05]
- Answer in English unless asked otherwise [by: user; added: 2026-10-05]

## Index
- [[me]]
- [[lessons]]
- [[workspaces/cowork]]
```

**Entries.** One bullet per line, metadata at the end, as the spec says. CoWork uses the
recommended keys and adds three open keys (the spec allows any key):

| Key | Value | Notes |
|---|---|---|
| `source` | `cowork://tasks/<taskId>` | Spec key. The task deep link already registered by the app (`TASK_DEEPLINK_PROTOCOL`, `main.ts`). |
| `added` | `YYYY-MM-DD` | Spec key. |
| `by` | `user` or `agent` | CoWork. `user`: stated or confirmed by the user, or written by hand. `agent`: inferred by the agent. A line without `by` counts as `user` (a hand edit). |
| `kind` | a `memory_items` kind | CoWork, optional. Lets the writer and the Hub group entries. |
| `subject` | a subject key | CoWork, optional. A single-valued fact: a new value replaces the line with the same subject in the same file. |

**Workspace files.** `workspaces/<slug>.md` starts with a heading and one entry that names the
workspace: `- CoWork workspace [workspace: <id>; by: user]`. The slug comes from the workspace
name; the id makes the mapping survive renames. The service keeps a map from workspace id to
file, rebuilt from these lines.

**Limits.** `MEMORY.md` at most 4 KB, any other file at most 64 KB, an entry at most 500
characters, at most 2000 files. The writer refuses writes that would exceed them and says
where to write instead.

## 4. Components

```text
memory_remember / memory_forget / Memory Hub / export
        │
        ▼
MemoryRepoService (main process, one per runtime)
  ├─ MemoryRepoPolicy    validateCandidate (shared with MemoryWriter): salience, redaction,
  │                      <no-memory>, workspace memory settings, SEC-16 senders, taint
  ├─ MemoryRepoFiles     parse/serialize entries, choose the file, dedupe, replace by subject
  ├─ MemoryRepoGit       hardened git: init, status, add, commit, log, compact
  └─ MemoryRepoLock      cross-process write lock (file lock in the repo's .git directory)
        │
        ▼
CoWork Memory/ (markdown + .git)
        │
        ├─ MemoryRepoContext   builds the <cowork_memory_repo> pinned block (MEMORY.md +
        │                      the workspace file), cached by HEAD
        ├─ MemoryRecall        new `repo` lane (in-process search over the repo files)
        └─ file tools          read-only access to the repo root (§6)
```

New code lives in `src/electron/memory/repo/`. Nothing in the agent tool layer touches the
filesystem of the repo directly.

### 4.1 Lifecycle

- Started in `startMemoryEngine` (`memory-engine-bootstrap.ts`) after `MemoryWriter`, in the
  desktop app and the node daemon, only when `memoryRepoEnabled` is on. It is idempotent:
  it creates the repo when the path is missing or empty, and adopts an existing memory repo.
- Stopped in a new shutdown step "memory repo", after "kit writers" and before "memory
  engine" (`main.ts`, `src/daemon/main.ts`): it waits for the write in progress (bounded,
  3 s) and releases the lock.
- The CLI (`src/cli/direct-run.ts`) gets read-only access: the context block and the recall
  lane work, `memory_remember` keeps its archive fallback.
- Quiet mode starts the service read-only.

### 4.2 Settings

`MemoryFeaturesSettings` (`src/shared/types.ts`) gains `memoryRepoEnabled` (default `false`)
and `memoryRepoPath` (default resolved in main, §2). Both must be added to
`normalizeSettings` and `DEFAULT_SETTINGS` (`settings/memory-features-manager.ts`; unknown
keys are dropped there), the `memoryFeatures:getSettings` fallback object
(`ipc/handlers.ts`), the executor's `loadExecutionPromptMemoryFeatures` fallback, and the
browser host's strict zod schema (`host/services/browser-memory-methods.ts`). The path is
validated in main when saved (§2).

## 5. Write path

### 5.1 `MemoryRepoService.remember(candidate)`

The candidate is the one `memory_remember` already builds (content, kind, scope, subject,
source, task id, workspace id, origin text).

1. **Policy (shared with `MemoryWriter`).** Extract the private `prepareWrite` steps 1–3 of
   `MemoryWriter.ts` into an exported `validateCandidate()` and call it from both writers:
   salience gate, `redactSecrets` (secret-only text is dropped), `<no-memory>`, workspace
   memory settings (memory off or privacy `disabled` blocks `inferred` writes; explicit acts
   are recorded), SEC-16 (a third-party channel sender never writes the repo; the write goes
   to `memory_items` contact scope as today).
2. **Privacy.** Strict privacy mode, private items, contact and task scopes never go to the
   repo (they stay in `memory_items`). The repo only holds what may appear in a private
   prompt.
3. **Taint (§7.3).** An agent write from a task that read untrusted content goes to
   `inbox.md`, whatever its kind.
4. **File.** `identity`, `preference`, `correction` with scope `global` → `me.md`;
   cross-workspace lessons (scope `global`, kind `insight` or `rule`) → `lessons.md`;
   everything with scope `workspace` → `workspaces/<slug>.md`, created on first write and
   linked from the index. `MEMORY.md` itself only receives entries the user stated
   (`by: user`) and asked to keep in every prompt (`pin`), within its size limit.
5. **Dedupe and replace.** Same normalized text (the `content_hash` normalization of
   `memory_items`) in the same file: no write, report `reinforced`. Same `subject` in the
   same file: replace the line, unless the existing line is `by: user` and the write is
   `by: agent` (`outranked`, as `MemoryWriter` does today).
6. **Write.** Lock, check the work tree (§5.3), write the file atomically (temp file and
   rename, no symlinks between root and target, reuse `evaluateConfinedInternalWrite` from
   `security/background-write-guard.ts`), `git add <file>`, `git commit`.
7. **Commit message.** `Remember <kind>: <first 60 characters>` with the trailers
   `Task: <taskId>` and `Origin: agent_tool | memory_hub | export`. Author
   `CoWork OS <memory@cowork.invalid>`; never the user's global git identity.
8. **Notify.** Bump the repo context version (§6.1) and tell the Memory Hub.

`memory_remember` routes facts here when the service is running and the write is a fact
(`ARCHIVE_KINDS` still go to the archive). The result names the file and line:
`{ success, id: "repo:workspaces/cowork.md#L7", action }`.

### 5.2 `memory_forget` and edits

- `memory_forget` accepts `repo:<path>#L<n>` ids and removes the line (with the same approval
  rules as today: no prompt for a line this task's agent wrote, a `memory_delete` approval
  otherwise). The removal is a commit (`Forget: …`).
- Phase 1 has no agent edit tool beyond replace-by-subject. Hand edits are first-class:
  the user edits files in any editor (§5.3).

### 5.3 Hand edits and a dirty work tree

The app owns the repo, but the user may edit it at any time. Before each write the service
runs `git status --porcelain`:

- Clean: proceed.
- Changes to tracked markdown files only: commit them first as `Hand edits` (author
  `CoWork OS`, trailer `Origin: hand_edit`), then proceed. Lines added by hand carry no `by`
  key and therefore count as the user's.
- Anything else (untracked non-markdown files, a merge or rebase in progress, an index
  lock): do not write; record the failure, keep the write in `memory_items` as before and
  show a WARN in the Memory Hub Health tab.

### 5.4 Git hardening

No git library is bundled; `GitService` shells out to `git`. The repo service uses its own
runner modelled on `readOnlyGitOptions` and `commitStaged` in
`host/services/browser-git-methods.ts`:

- `execFile("git", args, { cwd: root, shell: false, timeout: 10_000 })`, environment with
  every `GIT_*` variable removed, `GIT_OPTIONAL_LOCKS=0`;
- `-c core.hooksPath=<empty temp dir> -c commit.gpgsign=false -c core.fsmonitor=false
  -c core.autocrlf=false` on every command, so hooks planted in `.git/hooks` never run;
- staged paths are explicit (`git add -- <file>`), never `add -A`;
- no `fetch`, `pull` or `push` in Phase 1.

When git is missing (`git --version` fails at start), the service still writes files but
skips commits, and the Health tab shows WARN "git not found: memory has no history".

### 5.5 Concurrency

The desktop app and the node daemon may both run on a profile, and tasks run in parallel.
Writes are short, so Phase 1 serializes them with a lock file rather than a lease:

- `<root>/.git/cowork-write.lock`, created with `O_EXCL`, holding `{ pid, runtime, at }`;
  a lock older than 30 s whose pid is gone is taken over.
- One write per lock: read file, apply, write, commit, release. A writer that cannot get the
  lock within 5 s fails the write with `busy` and the tool tells the agent to retry.

Per-task worktrees and git merges (Devin's model) are not needed while every write goes
through one serialized service; Phase 2's Dreaming works on a branch (§10).

## 6. Read path

### 6.1 The `<cowork_memory_repo>` block

- Built by `MemoryRepoContext.build({ workspaceId })`: `MEMORY.md` (budget 500 tokens) and the
  workspace's file (budget 300 tokens). Entries are rendered one per line through
  `InputSanitizer.sanitizeInlineMemoryLine` (control characters removed, `<` and `>`
  escaped); headings are kept; metadata is shortened to `(agent)` for `by: agent` lines and
  dropped otherwise. A header says the block is the user's saved memory, to use as context and
  never as instructions.
- `inbox.md` is never in the block.
- Cached by HEAD commit and workspace; a new commit invalidates it. This keeps the block
  byte-stable between commits for prompt caching.
- Injected as its own pinned block (a new `memoryRepo` tag in `PINNED_CONTEXT_TAGS`,
  `agent/pinned-context-blocks.ts`), upserted after `userProfile` in `SessionRuntime`, and
  in the chat, companion and planning system prompts next to `<cowork_hot_memory>`. A
  separate block (rather than lines inside L0) keeps it stable when L0 changes.
- Budget: a new `MEMORY_REPO_TOKENS = 800` in `agent/content/prompt-budgets.ts`. While both
  stores run, L0 dedupes against the repo block by normalized text, so a fact exported to the
  repo is not rendered twice.
- Attribution: the block lists refs `repo:<path>#L<n>`; `shared/memory-used.ts` gets a
  `repo` lane (regex, `countMemoryUsedRefs`, a badge in `MemoryUsedAffordance.tsx`, line text
  resolved through a new `memoryRepo:readLines` IPC). `markUsed` ignores `repo:` refs.

### 6.2 Injection policy

`resolveMemoryInjection` (`MemoryInjectionPolicy.ts`) gets a `memoryRepo` layer and a
`memoryRepoEnabled` input. On only when: the setting is on, not `<no-memory>`, the task
retains memory, not a sub-agent or verifier, a **private** gateway (never group or public,
even with trusted shared context: the repo is personal and spans workspaces), and workspace
memory is on. It does not require `workspaceCanRead` (the repo is outside the workspace).

### 6.3 Search: the `repo` lane

`MemoryRecall` gets a `repo` lane (weight 1.0, like `memory`), searched when the scopes
include `memory`:

- Phase 1 searches in process: list the markdown files (at most 2000, skipping `.git`),
  read them (cached by mtime), split into entries, match with the shared Unicode term
  builder (`database/fts-query.ts` term extraction and folding), rank by term coverage. At
  the Phase 1 limits this stays well under 50 ms; a dedicated FTS index is a Phase 3 item.
- Hits are entries with refs `repo:<path>#L<n>`; `detail: "full"` returns the file section
  around the line (at most 80 lines) through the repo read guard.
- `inbox.md` hits are tagged `unreviewed`.

### 6.4 File-tool access

The agent should be able to `read_file`, `grep`, `glob` and `list_directory` the repo, as in the
spec's loop, but never write it. Today a path outside the workspace is `outside_workspace`
(an approval for `read_file`; `grep` and `glob` hard-fail) and protected segments only apply
inside workspaces (`isProtectedWorkspacePath`), so `.git/hooks` in an outside directory is not
protected. Changes:

- `evaluateWorkspaceFilesystemAccess` (`security/access-profile-paths.ts`) learns one
  app-owned root, the memory repo, independent of the workspace and the profile:
  - **read:** allowed when the task's `memoryRepo` layer is on (the executor passes it in the
    access context); denied otherwise with reason `memory_repo_unavailable`;
  - **write, delete, rename:** always denied with reason `protected_path` (hard boundary, no
    approval and no rule can grant it).
- `grep` and `glob` accept the memory root as a search root under the same rule.
- Shell: the macOS seatbelt profile (`macos-sandbox.ts`) denies reads and writes of the
  memory root for `run_command`; the agent reads memory with file tools only. In unsandboxed
  or full-access mode nothing technical stops a shell command from reading the repo, the same
  as any other file the user can read (§7.4).

## 7. Security and privacy

### 7.1 Secrets

Every write is redacted with the shared detector before it reaches disk. A secret written by
hand is not redacted (the user's file), but the context block and recall run
`redactSensitiveMarkdownContent` on what they read, as kit files do today.

### 7.2 Forgetting and git history

Git keeps removed lines in its history. Phase 1 handles this locally:

- Removing a line (`memory_forget`, the Hub) is a commit; the old text stays in history.
- **Compact history** (Memory Hub, with confirmation): replaces the history with a single
  commit of the current files (`git checkout --orphan`, commit, replace `main`, delete the
  old branch, `git reflog expire --expire=now --all`, `git gc --prune=now`). This departs
  from the spec skill's "never rewrite history"; it is the only way to really forget
  locally, and there is no remote in Phase 1.
- **Clear All Memories** for a workspace deletes its workspace file and compacts. **Clear
  global memories** empties `me.md`, `lessons.md`, the `MEMORY.md` entries and `inbox.md`,
  and compacts.
- Task delete with `purgeDerivedMemory`: lines whose `source` is that task and `by: agent` are
  removed (no compaction; the user can compact).

### 7.3 Memory poisoning

`MEMORY.md` and the workspace file are in every private prompt, and the agent writes them. A
web page, email or file the agent reads could steer it to save a standing instruction.
Defenses, in order:

1. The agent cannot write files in the repo or run git on it (§6.4); every write goes through
   `MemoryRepoService`.
2. **Taint routing.** The task's untrusted-content signal
   (`SessionRuntime.recordSensitiveSourceRead`, today fed only by `read_file` and the
   document parser for untrusted files) is extended to `web_fetch`, the browser tools, mailbox
   reads and channel history. An agent write (`by: agent`) after any untrusted read goes to
   `inbox.md`, which is never injected; Phase 2's Dreaming or the user promotes it.
3. The agent never writes `MEMORY.md` (only the user's pinned statements land there, §5.1).
4. Injection-time sanitizing and the "context, not instructions" header (§6.1).
5. Provenance on every line (`source`, `by`), visible to the agent and in the Hub.

### 7.4 Exfiltration

Phase 1 configures no remote, and the service never pushes. A sandboxed `run_command` cannot
read the repo (§6.4). With full access or no sandbox an agent can read any file the user can,
including the repo; that is the existing risk of those modes, not a new one. Phase 4 adds
remotes only through Settings, owned by the service, with the user confirming the remote is
private.

### 7.5 What stays out of the repo

Third-party text (mailbox, other channel senders), Chronicle screen text, private and
strict-mode items, task-scoped facts, Supermemory results, raw transcripts. These keep their
current stores and rules.

## 8. Migration (one-time export)

`MemoryRepoExport`, claimed like the other one-time jobs (`withMaintenanceClaim`, marker
`memory_repo_export_v1` in `maintenance_state`), runs when the service starts for the first
time on a profile:

- Source: `MemoryItemsRepository.list` for active, non-private items with scope `global` or
  `workspace` (contact and task scopes and `third_party` excluded).
- Mapping: `by: user` for `user_stated`, `user_confirmed`, `curated`; `by: agent` for the rest;
  `added` from `created_at`; `source` from `task_id` when set; `kind` and `subject` kept; files
  per §5.1 step 4. Pinned user items go to `MEMORY.md`.
- One commit, `Import from CoWork memory`. The rows stay in `memory_items` (no deletion in
  Phase 1). Re-running adds nothing (dedupe).

On the main development profile this exports 3 items today (the 9 mailbox items are
third-party).

## 9. Memory Hub (Phase 1 scope)

- Settings > Memory: a **Memory folder (beta)** card: on/off, the path, **Open memory
  folder** (`memoryRepo:openFolder`, path resolved in main, rate-limited, `shell.openPath`;
  pattern of `CUSTOM_SKILL_OPEN_FOLDER`), **Compact history**, last commit time.
- Health tab: repo present and a memory repo, git available, work tree clean, `MEMORY.md`
  size against its limit, `inbox.md` entry count, last write error.
- New IPC channels in `IPC_CHANNELS` (`shared/types.ts`), `memoryRepo:*`, zod-validated in
  main, mirrored in the browser host.

The "What CoWork knows" tab is not rebuilt in Phase 1; it keeps showing `memory_items`.

## 10. How Phase 2 builds on this

Implemented: see [memory-repo-phase2-design.md](memory-repo-phase2-design.md).

Dreaming becomes an agent task: it reads the repo, `inbox.md` and the transcripts of recent
tasks (conversation index), works on a branch `dream/<date>` in a worktree, and ends with a
diff. Changes that only touch `by: agent` lines merge automatically; anything touching
`by: user` lines or `MEMORY.md` waits in the Review tab as a diff. Undo is `git revert`.
This replaces `memory_curation_log`, the heuristic `MemoryCurator` and its undo logic.

## 11. Measurement and evals

Phase 1 is a test of whether agent-written memory pays off. Track, per week, on dogfood
profiles:

- facts written per 10 tasks, by origin (user asked, agent on its own, inbox);
- share of tasks whose agent read the repo (file tools or the `repo` lane);
- `MEMORY.md` and repo size; inbox entries promoted or discarded;
- user corrections that repeat an earlier saved fact (should fall).

New `qa:memory-evals` cases: a write from a task that read a planted web page lands in
`inbox.md`, never in the prompt; a secret in content is redacted on disk; `<no-memory>`
blocks the write; a group-channel task gets no repo block; a sub-agent gets no repo block;
`memory_forget` plus **Compact history** leaves the text in no commit; a hook planted in
`.git/hooks` does not run on commit.

## 12. Work items

| # | Item | Main files |
|---|---|---|
| 1 | `validateCandidate()` extracted from `MemoryWriter.prepareWrite` | `memory/MemoryWriter.ts` |
| 2 | Repo service: files, git runner, lock, init/adopt | `memory/repo/*` (new) |
| 3 | Settings `memoryRepoEnabled`, `memoryRepoPath` | `shared/types.ts`, `settings/memory-features-manager.ts`, `ipc/handlers.ts`, `host/services/browser-memory-methods.ts`, executor fallback |
| 4 | Lifecycle in both runtimes, shutdown step, CLI read-only | `memory/memory-engine-bootstrap.ts`, `main.ts`, `src/daemon/main.ts`, `src/cli/direct-run.ts` |
| 5 | `memory_remember` / `memory_forget` routing to the repo | `agent/tools/memory-tools.ts` |
| 6 | Taint signal for web, browser, mailbox, channel reads | `agent/tools/*`, `agent/runtime/SessionRuntime.ts` |
| 7 | Context block, injection layer, budget, attribution | `memory/repo/MemoryRepoContext.ts`, `MemoryInjectionPolicy.ts`, `agent/pinned-context-blocks.ts`, `SessionRuntime.ts`, `executor.ts`, `prompt-budgets.ts`, `shared/memory-used.ts` |
| 8 | `repo` recall lane | `memory/MemoryRecall.ts` |
| 9 | Read-only file access to the repo root; seatbelt deny | `security/access-profile-paths.ts`, grep/glob tools, `macos-sandbox.ts` |
| 10 | One-time export | `memory/repo/MemoryRepoExport.ts` |
| 11 | Hub card, Health checks, IPC | `renderer/components/MemoryHubSettings.tsx`, `memory/MemoryHealthService.ts`, `ipc/*` |
| 12 | Evals and docs | `qa:memory-evals`, `docs/memory-engine.md`, this file |

Items 1–5 and 7 are the minimum to dogfood; 6 and 9 must land before the setting is offered to
anyone else.

## 13. Decisions and open questions

Decided (2026-10-05):

1. Default location: `~/CoWork Memory/` for the default profile, the profile directory for
   any other profile (§2).
2. The agent's own facts (`by: agent`) go straight into the workspace file (or `me.md` /
   `lessons.md`) from clean tasks, and into `inbox.md` from tasks that read untrusted
   content (§5.1, §7.3).

Open:

1. Interop: offer to point Claude Code and other agents at the same repo (their skill reads
   `MEMORY.md`), and how to keep their writes compatible with the `by` key.

## 14. As built (deviations and notes)

- **Code.** `src/electron/memory/repo/`: `MemoryRepoService` (writer), `memory-repo-format`,
  `memory-repo-git`, `memory-repo-lock`, `memory-repo-paths`, `memory-repo-bootstrap`,
  `MemoryRepoExport`, `MemoryRepoContext` (prompt block), `memory-repo-read` (line lookup for
  "Memory used"). Access: `security/memory-repo-access.ts`. IPC: `ipc/memory-repo-handlers.ts`.
  UI: `renderer/components/memory/MemoryRepoCard.tsx`.
- **Path rule.** A workspace that is the home folder (or above it) does not count as a
  project workspace when the repo path is checked; the access layer still denies every write
  under the memory root, also inside such a workspace.
- **Read access scope.** File tools have no per-task access context, so the executor runs each
  tool call inside an AsyncLocalStorage scope (`runWithMemoryRepoAccess`) carrying the task's
  `memoryRepo` layer. File reads under the root, the `repo` recall lane and repo writes from
  `memory_remember` all require it. Anything under the root's `.git` is denied, reads included.
- **Export.** One commit per exported fact (not one commit), through the normal write path.
  The export marker is `.git/cowork-export-v1` inside the repo, so a repo at a new path gets
  its own export.
- **Context block.** Cached by repo version, workspace and the two files' mtime and size, so
  hand edits show up before the next commit. L0 and L1 skip `memory_items` facts whose text
  the block already shows (`excludeHashes`).
- **Untrusted-content taint.** Recorded by `web_fetch`, `http_request` (non-empty body), the
  browser page-reading tools, mailbox content actions, Gmail and IMAP reads and channel
  history (`agent/security/untrusted-content-source.ts`).
- **Shell.** The macOS seatbelt profile denies reads and writes of the memory root. The
  Docker sandbox does not (not in scope); unsandboxed shells are not restricted (§7.4).
- **Known gaps.** A sub-agent started inside the parent's `spawn_agent` call inherits the
  parent's access scope for the few registry calls it makes directly (its own tool calls get
  its own scope). The Health rows for the memory folder are service-only (the
  `qa:memory-health` script reads only the database).

