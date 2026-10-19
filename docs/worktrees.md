# Build in a Git worktree

In **Build**, choose a project folder, then select **Local** or **Worktree** below
the composer. Local edits the selected folder directly. Worktree creates a separate
checkout and a task branch, keeping the build's edits isolated from your local work.
The **Starting branch** picker can use the current checkout's HEAD or another existing
local branch. The checkout starts from committed code; uncommitted and untracked local
files are not copied.

Worktree requires a writable, non-temporary Git workspace with at least one commit.
Unsupported folders and hosts show a reason beside the selector. Build's explicit
choice overrides the global automatic-isolation setting, without changing it.
Required-isolation tasks still require worktrees even if their configuration also
requests Local. Worktree creation or access failures stop explicitly isolated tasks
instead of running them in the original folder.

Tasks keep their worktree path and branch in session metadata. Follow-ups and retries
reuse that checkout, preserving edits. Missing or occupied checkouts are reported for
recovery rather than deleted during task admission. Build preview and Changes use the
task's worktree path. Existing agent Git tools provide commit and merge operations,
and the worktree APIs provide cleanup;
**Settings → Integrations → Git → Worktrees** controls branch naming, automatic commits
on completion, and cleanup after merging.

## Compare

**Compare** (next to Local and Worktree) builds the same request as 2 or 3 variants, each in
its own worktree. All variants start from the same commit: the starting branch is resolved to
one commit when you press build, so a branch that moves meanwhile does not split them. An
optional **check** (for example `npm test`) is the variant's success criteria: each variant
runs it before it finishes, through its own `run_command`, so the task's shell permission and
approvals apply. Compare variants are one family: they never block each other.

## Merge review

When the folder is a Git project, Build shows a **merge review** of the worktree builds
waiting to merge (not yet merged, removed or failed), grouped by intent. A Compare request is
one group of alternatives: each variant shows its branch, status, check result and diff size,
with **Merge** and **Keep only this** (removes the other variants' worktrees after a
confirmation). Other builds are grouped by title. Because different groups have to combine,
the review lists files more than one group changed and pairs of branches that would conflict,
computed with `git merge-tree --write-tree` (Git 2.38 or later; older Git shows overlapping
files only). Nothing is merged without your click.

## Shared-change coordination

Before a task writes a file, it records a claim on the file's path relative to its checkout,
so the same file in the folder and in every worktree has one key.

- **Same folder:** while another task in the same folder is still running and has changed the
  file, a write to it is refused with a message naming that task, and the task records an
  external wait (`resource_conflict:`) that ends when a later write to the file goes ahead or
  the task ends. A task and the sub-agents it starts never block each other, and a running task
  idle for 24 hours no longer blocks.
- **Worktrees:** writes are never refused. The overlap is shown in Mission Control and in the
  merge review.

Mission Control lists each file two or more tasks are changing: in the same folder under
**Needs attention**, in worktrees as a review to do before merging. Application operations
keep their own resource locks; they are not part of these claims.

This uses CoWork's existing named task branches and repository-local
`.cowork-worktrees` directory. Detached-HEAD checkouts, local-change copying, setup-script environments, and
Local/Worktree session handoff are not supported.
The Build location selector currently requires the desktop host API.
