# Memory Repo — Phase 4 design: sync and team memory

**Status.** Implemented in this change (2026-10-06). Builds on Phases 1–3
([1](memory-repo-phase1-design.md), [2](memory-repo-phase2-design.md),
[3](memory-repo-phase3-design.md)).

**Goal.** The two things git gives memory that Phases 1–3 did not use: the same memory on
several machines (a private remote the user owns), and memory shared by a team (other memory
repos read next to the personal one), as in the Agent Memory Repo spec's "composability".

Non-goals: writing to team repos (Phase 4 reads them only), swarm folders for multi-agent
tasks, importing other agents' memory formats.

## 1. Private remote (sync across machines)

- **Settings** (Memory folder card): `memoryRepoRemoteUrl` (empty = no sync) and
  `memoryRepoRemoteConfirmedPrivate` (the user ticks "This repository is private and mine";
  sync stays off until it is ticked). Accepted URLs: `https://…`, `ssh://…` and scp-style
  `user@host:path`; refused: `file:`, `ext::`, local paths, URLs with credentials embedded
  (`https://user:token@…`), anything starting with `-`.
- **Remote** `cowork-sync` is managed by CoWork (added, updated or removed to match the setting);
  the agent never runs git on the folder (Phase 1 §6.4), so only the service talks to the remote.
- **Pull** on start, before a dream and at most every 10 minutes while the app runs:
  `fetch cowork-sync main`, then `rebase` the local commits onto it (memory commits are small,
  independent line edits). A conflicting rebase is aborted; sync pauses with the conflict shown
  in the card and Health ("open the folder and resolve, then press Sync now").
- **Push** after local commits (debounced 30 s) and on **Sync now**: `push cowork-sync main`.
  Dream review branches are never pushed. No force push, except after **Compact history** when
  sync is on: the dialog says the remote's history is replaced too, and the push uses
  `--force-with-lease` against the fetched head.
- **Credentials** come from the user's own git setup (credential helper, SSH agent); CoWork stores
  none. Network commands run with the Phase 1 hardening (no hooks, scrubbed `GIT_*`, no
  prompts) and a 30 s timeout.
- **Status**: last pull and push times, ahead/behind counts, the last error.

## 2. Team memory (read-only)

- **Settings**: `memoryRepoTeamRepos`: a list of `{ name, path }` local folders (each a memory repo:
  its own git top level with a `MEMORY.md`), for example a team's shared repo the user cloned.
  Each can be limited to some workspaces (`workspaceIds`, empty = all). Paths are validated like
  the personal folder (absolute, not a protected location, not inside a project workspace, not
  a symlink) and must not overlap the personal folder or each other.
- **Prompt**: the `<cowork_memory_repo>` block adds each team repo's `MEMORY.md` (300 tokens each,
  at most 3 repos) under a heading with the repo's name, after the personal folder. Lines carry
  refs `team:<name>:<path>#L<n>`.
- **Recall**: the `repo` lane also searches team repos; hits name the repo.
- **File access**: team repo roots are read-only roots like the personal folder (reads under the
  task's memory scope, writes and `.git` always denied).
- **Writes**: none. `memory_remember` writes to the personal folder only. Dreams read team
  repos as context for duplicates, but never edit them.
- **Updates**: a team repo with a remote is fetched and fast-forwarded (`pull --ff-only`) with the
  personal folder's pull schedule, only when its work tree is clean; anything else is left to the
  user.

## 3. UI

- Memory folder card: a **Sync** section (remote URL, the private confirmation, **Sync now**,
  status) and a **Team memory** section (add folder by path, name, workspaces, remove, status per
  repo).
- Health: "Memory folder sync" (SKIP when off; WARN on a paused conflict or a failing push or
  pull for more than a day) and "Team memory" (WARN when a configured repo is missing or not a
  memory repo).

## 4. Security

- Only the service runs network git; URLs are validated and passed after `--`; no credentials
  are stored or logged (URLs are logged without user info).
- Sync needs the explicit "private and mine" confirmation; the default is off.
- Team repos are third-party-ish content written by teammates: their text goes through the same
  per-line sanitizing as the personal folder, is labelled with the repo name, and the block
  header says it is shared context, never instructions. Team repos are never written.

## 5. As built

- **Union merge.** Memory notes are line lists, so the folder carries `.gitattributes` with
  `*.md merge=union`: two machines adding or changing lines in the same file keep both sides
  instead of stopping on a conflict (dreaming tidies duplicates). Accepting a dream review uses
  a normal three-way merge (`.git/info/attributes` overrides it for that merge), so a review
  made against lines that changed since is still marked stale. A pull that still conflicts
  (for example a file deleted on one machine and edited on the other) aborts and pauses sync.
- **After compaction** the next sync skips the pull and force-pushes with a lease against the
  fetched head, replacing the remote's history.
- **Pull before dreaming**: a dream pulls first (without pushing), so it works on the latest
  memory.
- **Code.** `memory-repo-sync.ts` (URL validation, remote, pull, push), `MemoryRepoService`
  (`configureSync`, `syncNow`, debounced push after commits), `memory-repo-team.ts` (team repo
  registry, fast-forward pulls), `memory-repo-bootstrap.ts` (applies the settings, 10-minute
  timer, save-time validation `memoryRepoSettingsProblem`).
