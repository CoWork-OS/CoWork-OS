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

This uses CoWork's existing named task branches and repository-local
`.cowork-worktrees` directory. Detached-HEAD checkouts, local-change copying, setup-script environments, and
Local/Worktree session handoff are not supported.
The Build location selector currently requires the desktop host API.
