# Suggested Tasks

While it works on your request, the agent may notice other work worth doing: a bug it found in passing, a slow path too large to fix in the same change, a missing test, stale docs. It does not do that work unasked, and it does not leave it as a line in its reply. It proposes it as a **suggested task** instead. Nothing runs until you choose.

## The card

When a turn ends, its suggestions appear in one card under the agent's answer:

- **N suggested tasks** heads the card. **Start all** starts every suggestion still waiting, each as its own task.
- Each suggestion shows a title and a one- or two-sentence summary. Click the summary to read the full task, which is the exact prompt the new task starts from.
- **Start** starts it as a new task. The row then shows that task's status (Queued, Running, Needs you, Done, Failed); **Open** switches to it.
- **Do it here** sends the full task to the current conversation as a message, so this agent does it next with everything it already knows. The message is labelled as a suggested task.
- **Options** lets you choose how the new task runs before you click Start:
  - **Environment**: Local, which is this computer.
  - **Folder**: the workspace the task works in.
  - **Worktree**: run in its own git worktree and branch. This is available for Git project folders, and the agent may suggest it for code changes.
  - **Model** and **Effort**: the model for the new task. Effort uses the provider setting, as in the model picker.
  - **Permissions**: the access profile for the new task.
- **X** dismisses the suggestion.

## What the agent suggests

The agent uses the `propose_task` tool. It is told to propose only real work outside your current request. It must not propose what you asked for, work it is about to do anyway, one-line tweaks, or speculation. A fix that acts on what it just found stays in the conversation as a question. A turn can add at most three suggestions, and the same task is never suggested twice. Each suggestion's full task is written to stand alone, because the new task does not see the conversation.

If a suggestion goes stale before you act on it, the agent can withdraw it (`withdraw_task_proposal`). For example, it may have done the work in the same task after all. Suggestions you do not act on expire after seven days. Delegated work (sub-agents and team lanes) does not suggest tasks.

## Safety

- **The prompt is the agent's words.** A task started from a suggestion has no "typed by you" provenance, so the tools that change your agent for every later task (persona, behavioral rules, expertise, heartbeat, integration setup) stay locked. A **Do it here** message is marked the same way.
- **No more access than the task that proposed it.** The new task keeps every access limit of the proposing task: its agent's limit and any limits it inherited. By default it also keeps that task's access profile and pinned model.
- **Nothing starts on its own.** Proposing only stores the suggestion and shows the card. Every Start, Do it here, or dismiss is a click on the card. The main process checks that whoever clicked may act on the proposing task, and it reads the task text from its own store, never from the click.

## Where it is stored

Suggestions live in the `task_proposals` table and are deleted with the task that proposed them. They are shown in the desktop app. A workspace tool policy (`.cowork/policy/tools.monty`) can deny `propose_task` to turn suggestions off for a workspace.
