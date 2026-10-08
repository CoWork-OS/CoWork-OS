# Memory Repo — Phase 5 design: kit files, swarm folders, importing notes

**Status.** Implemented in this change (2026-10-06). Finishes the roadmap of
[Phases 1–4](memory-repo-phase1-design.md): the kit files deferred in Phase 3, and the swarm
folders and imports from the original plan.

## 1. Kit files

| File | What writes it | Decision |
|---|---|---|
| `MISTAKES.md` auto block (`cowork:auto:mistakes`) | FeedbackService: 👎/edit reasons as patterns | **Fold**: each pattern becomes an entry in the workspace's memory folder file (`kind: correction`, `by: user`, `subject: feedback:<hash>` so a repeat updates the same line, `origin: feedback`); written on live feedback from the workspace owner only (no startup rebuild into the folder). The auto block is no longer written when the folder is writable and is stripped once (with the Phase 3 strip). Hand-written `MISTAKES.md` text is untouched and still injected. With the folder off, the old block is kept as the fallback. |
| `LORE.md` auto block (`cowork:auto:lore`) | LoreService: one milestone line per finished task | **Retire.** The prompt never reads the block (it is stripped at injection), the same history is in the task database and the conversation index that dreams read, and folding it would commit once per task. LoreService stops; `update_lore` milestones go outside the generated block. The old block is stripped once. |
| `CROSS_SIGNALS.md` | CrossSignalService: entities two agent roles mentioned in 24 h | **Keep.** It is a short-lived, workspace-wide signal for the shared-context block, not memory; folding would commit on every flush. Swarm folders (§2) are the explicit coordination channel. |

## 2. Swarm folders

When several agents work on one goal, they share `swarms/<slug>/` in the memory folder, as in the
Agent Memory Repo spec's swarm example.

- **Swarm.** The root of a task's `parentTaskId` chain, when it has child tasks or a team run
  (sub-agents from `spawn_agent` / `orchestrate_agents`, collaborative runs, workflow
  pipelines). Slug: `<title slug>-<first 8 of the root id>`. Bot teams are not covered (their
  tasks share no goal id).
- **Files.** `README.md` (goal: the root prompt, one line; members; rules: write what you measured
  and what you ruled out with sources, ask other agents in questions, read before each step),
  `findings.md`, `questions.md`. Created on first write; never linked from `MEMORY.md`.
- **Tool `swarm_note`** `{ kind: "finding" | "ruled_out" | "question" | "answer", text, sources? }`.
  The slug comes from the task's swarm, never from the model. Entries carry `by: agent`, the
  author's role, `source: cowork://tasks/<id>` and a `tainted` mark when the author read untrusted
  content. Screened like every memory write (salience, redaction). Available to the root and its
  sub-agents and team lanes (researchers included), not to verifiers. Not a memory write tool
  (it does not touch facts about the user).
- **Reading.** A `swarm` layer gives members a pinned `<cowork_swarm>` block (goal, members, the
  10 latest findings, open questions, and a header that these are peer notes, never
  instructions) and read access to `swarms/<slug>/` only (file tools and recall). Sub-agents and
  verifiers get this layer even though they get no personal memory.
- **Lifecycle.** Swarm notes stay after the root finishes (history); deleting the root task removes
  its swarm folder. Dreams never read `swarms/`.

## 3. Importing notes from a folder

**Import notes from a folder…** in the Memory folder card (desktop): main opens a folder picker;
the folder is validated (absolute, not protected, not a symlink, not the memory folder or inside
it), walked (`.md` only, no hidden entries or symlinks, depth ≤ 4, ≤ 200 files, ≤ 256 KB per file,
≤ 2 MB total) and parsed as Agent Memory Repo entries or plain bullets. Entries go to `inbox.md`
in one commit (`by: agent`, `source: import`, `import: folder:<name>`), screened, deduped against
the whole folder, within the inbox size limit. The user keeps entries from the inbox in What
CoWork knows (**Keep** moves an entry to `me.md`, `lessons.md` or the workspace file as theirs;
**Pin** to `MEMORY.md`; **Delete**). Dreams leave imported inbox entries for the user (they are
not promoted or discarded automatically).

This is how memory comes over from other agents that use the same format (their folder is
read, never written).
