# Terminal Tabs

Terminal Tabs turn CoWork OS into a real developer workbench instead of a chat app that occasionally runs shell commands. They give each workspace an interactive terminal dock inside the desktop app, backed by the operating system's native pseudoterminal layer and rendered with xterm.js.

This is one of the larger steps toward CoWork OS as a GUI-first AI super app and everything app: coding, agent execution, browser testing, documents, spreadsheets, presentations, inbox, automations, devices, and now full terminal work can stay in one governed workspace.

## What users get

- **Real interactive terminals**: typing, command echo, cursor movement, arrow keys, Ctrl+C, Tab completion, interactive prompts, and long-running process output flow through a PTY instead of a custom text emulator.
- **Multiple terminal tabs**: open more than one terminal for the same workspace, switch between tabs, create new tabs, close individual tabs, or close the whole dock.
- **In-app dock placement**: the terminal opens under the message box and pushes the main work area and right sidebar upward, so it behaves like another first-class work surface instead of a floating popup.
- **Native shell behavior**: macOS launches the user's login shell through `node-pty`; Windows launches `cmd.exe` through the Windows PTY backend.
- **Resizable terminal grid**: xterm.js measures the visible dock and sends column/row changes to the PTY so full-screen terminal UIs and wrapping behave like a normal terminal.
- **Prompt cleanup**: macOS zsh prompts are adjusted to show cwd-only prompts such as `cowork %`; Windows `cmd.exe` uses a cwd prompt such as `C:\Users\alex\project>`.
- **Cwd-aware tabs**: tab labels use the current directory when the shell emits cwd metadata. The macOS zsh integration emits OSC-7 cwd updates without writing setup commands into the visible terminal.
- **Link handling**: xterm web-link support makes URLs in terminal output clickable where the renderer allows it.

## Why it matters

Before this capability, CoWork could run shell commands and preserve shell-session state, but the user-facing terminal surface was custom-rendered. That made every terminal behavior a possible product-specific edge case: redraws, Tab completion, Ctrl+C, interactive CLI login flows, prompt rendering, and process control all needed bespoke handling.

The new model uses the same architecture used by mature Electron developer tools:

- xterm.js owns terminal rendering and keyboard behavior in the renderer.
- node-pty owns the OS pseudoterminal session in Electron.
- The shell running inside the PTY owns prompts, command editing, completion, signals, and interactive program behavior.
- CoWork owns workspace routing, tab lifecycle, approvals, dock placement, and visibility.

That division is the important product shift. CoWork can keep the terminal inside the super-app workspace without trying to impersonate a terminal itself.

## Architecture

Terminal Tabs are split across three layers:

| Layer         | Responsibility                                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Renderer      | `TerminalTabsDock` creates xterm instances, fits them to the dock, forwards keyboard input, renders PTY output, and exposes tab controls.                           |
| Preload / IPC | Typed terminal-tab channels create, list, write, resize, stop, and close tabs while keeping renderer access narrow.                                                 |
| Electron main | `TerminalPtyManager` creates and owns `node-pty` processes, keeps per-tab output replay buffers, tracks cwd/status metadata, and enforces per-workspace tab limits. |

The dock lazy-loads xterm so the main renderer bundle does not pay the terminal cost until the terminal is opened.

## Platform behavior

### macOS

macOS uses the user's login shell when available, usually zsh:

- shell executable resolves from `$SHELL`, then `/bin/zsh`, `/bin/bash`, then `/bin/sh`
- the PTY starts as a login shell with `-l`
- `ELECTRON_RUN_AS_NODE` is removed from the child environment
- `TERM`, `COLORTERM`, and `TERM_PROGRAM` are set for terminal-aware programs
- a generated `ZDOTDIR` sources the user's normal zsh files and then overrides prompt/CWD hooks at the end
- the prompt is cwd-only, and OSC-7 cwd metadata is emitted through zsh hooks

The generated zsh startup files are used specifically to avoid sending setup commands into the visible terminal after it opens.

### Windows

Windows uses the real Windows PTY path through node-pty:

- modern Windows uses Microsoft ConPTY
- older Windows can fall back to winpty through node-pty
- the shell defaults to `%SystemRoot%\System32\cmd.exe`, then `%COMSPEC%`, then `cmd.exe`
- `cmd.exe` starts with `/Q` to reduce noisy command echo behavior
- `PROMPT=$P$G ` makes the prompt show the current directory followed by `>`

This is not the old custom terminal path. `cmd.exe` is only the shell running inside the PTY; the PTY itself is provided by node-pty's Windows backend.

Current Windows limitation: `cmd.exe` does not have a clean zsh-style prompt hook for emitting hidden cwd metadata after every directory change. The visible prompt updates correctly because `$P` is expanded by cmd. If product requirements need reliable hidden cwd metadata on Windows, PowerShell is the better default shell because its prompt function can emit OSC-7 metadata cleanly.

## User controls

- **Open terminal**: title-bar terminal button opens the dock for the selected workspace.
- **New terminal tab**: plus button creates another PTY-backed tab.
- **Switch tab**: clicking a tab focuses that xterm instance.
- **Close tab**: tab close button kills and removes that PTY.
- **Close terminal**: dock close button hides the terminal dock without changing the rest of the task view.
- **Stop**: stops the active terminal process when a tab is marked running.

Opening a terminal tab is a user-facing work-surface action, not a permission escalation. Agent
command tools must still be exposed by the active [access profile](access-profiles.md), and the
profile's sandbox, workspace boundary, administrator policy, and guardrails apply to agent-run
commands. There is no separate shell enable/disable switch for new tasks. If a task's profile is
downgraded, new tabs and further use of the task's command lane are revalidated against the
narrower profile.

## Running code blocks from an answer

Shell code blocks in an answer (` ```bash `, `sh`, `zsh`, `shell`) show a **Run** button next to
**Copy**. Run types the command into the task's terminal tab, exactly as if the user had typed it,
and streams the output into a panel under the block. When the command finishes on its own, CoWork
sends the command, its exit code and its output to the agent as the next message, so the agent can
react to what happened. A quiet "Sent the output of …" line marks that message in the transcript.

- **Same terminal**: runs reuse one tab per task, so `cd`, environment changes and history carry
  over between runs. The terminal button in the output panel opens the dock on that tab.
- **Stop**: while a command runs, the Run button shows a spinner that turns into Stop on hover. Stop
  sends Ctrl+C. A stopped run is not sent to the agent.
- **Finish detection**: the zsh integration emits shell-integration marks (OSC 133 `C` when output
  starts, `D;<status>` when the prompt returns, and `E` with the command line just before `C`);
  bash emits the `D` mark from `PROMPT_COMMAND`. Other shells and Windows `cmd.exe` do not show the
  Run button.
- **Policy**: a run is the user's own input to their terminal, so it is gated like typing into a
  tab: the task's access profile must allow command tools, and dangerous-command guardrails still
  apply. The agent cannot start a run; only a click can.
- **Output limits**: the panel keeps the last 256 KB of output; the message to the agent keeps the
  head and tail of long output, about 12,000 characters.

## The agent's processes as tabs

A command the agent starts with `run_command` `background: true` (a dev server, a tunnel, a
watcher) shows as a tab in the task's terminal dock, after the shell tabs. The agent names the tab
with the tool's `title` argument (for example "dev server" or "https tunnel"), or the tab takes the
command's first line.

- **Read-only**: the tab shows the process's output as it arrives, with what was printed before
  the dock opened. Secrets are redacted the same way as in the output the agent reads. The process
  has no terminal to type into; it runs with the same approval, sandbox and access profile as any
  `run_command`.
- **Stop and close**: Stop ends the process and keeps its output; the tab's close button stops the
  process if it is still running and removes the tab. The agent sees the process as stopped
  (`stopped_by_user` or `tab_closed_by_user`). Both are recorded in the conversation's audit log.
- **Lifetime**: unchanged from background processes. They stop when the task is cancelled, after
  30 minutes without the agent reading their output, or when the app quits. Watching a tab does
  not keep a process alive.
- **Scope**: a window sees only the processes of a task it may view. Output reaches only windows
  that listed that task's tabs.

## Terminal tab links in answers

An answer can point at a terminal tab with a link of the form `[tab title](#terminal/<tab id>)`.
CoWork shows it as a small terminal chip; clicking it opens the dock on that tab, or says the tab
is closed. The `run_command` result for a background process includes the ready-made link
(`terminal_tab.link`) and asks the agent to use it when it mentions the process, so an answer such
as "the tunnel ([https tunnel](#terminal/bg-1a2b3c4d)) is still running" opens the right tab.

### Your own tabs

The agent can also see and point at the shell tabs you open yourself, through two read-only tools:

| Tool | What it returns | When the agent uses it |
| --- | --- | --- |
| `list_terminal_tabs` | Each shell tab of the task's workspace: `id`, `label` (the last part of its working directory, as the dock shows it), `cwd`, `status`, `last_command`, and a ready-made `link` | You mention your terminal, a command you ran or an error you saw there |
| `read_terminal` | The end of one tab's output as plain text (`tail_lines`, default 200; `max_chars`, default 16,000), with the tab's details. Asks you first, once per tab for the task | You ask about something a tab printed ("this error", "did it pass?") |

Both tools return the tab's link, and their descriptions tell the agent to write it as
`[label](#terminal/<id>)`, so "the test run in [cowork](#terminal/tab%3Aws-1%3Atab-1) failed on
`auth.test.ts`" opens that tab. `read_terminal` takes the tab id or its whole `#terminal/<id>` link.

What the agent can and cannot do with your tabs:

- **Read only.** Neither tool types into a tab, runs a command there, or stops it. To run something
  itself, the agent still uses `run_command`, with its usual approvals.
- **Only where the agent may run commands, and only for you.** The tools are offered only where
  `run_command` is: with an access profile that allows command tools, and not in a task whose
  restrictions take `run_command` away. Group and public channel conversations deny them, as they
  deny the clipboard tools, and so does a channel message from anyone but you, so your terminal is
  never quoted into someone else's chat. A bot whose **Works on** keeps it off this computer
  (Off, Browser, Own desktop) cannot read them either. Managed sessions count them with the shell
  tools.
- **This workspace only.** A tab of another workspace cannot be listed or read, even by its id.
- **Known secret patterns redacted.** Output goes through the same redaction as `run_command`
  output (API keys, tokens, private keys, seed phrases, JWTs, secret JSON fields), and then
  through patterns for what a terminal adds: values of names that contain a secret word
  (`TOKEN=…`, `export GITHUB_TOKEN=…`, `--password=…`, `aws_secret_access_key = …`,
  `password: …`, `X-Api-Key: …`), passwords in URLs, `Authorization` headers of any scheme,
  common vendor tokens (Stripe, Slack, Google, npm, GitLab, GitHub fine-grained), private keys
  whose BEGIN or END line is missing, and the tab's own shell-integration nonce. Redaction
  matches shapes, so it cannot promise to catch every secret; the tool description says so, and
  tells the agent that terminal output is data, not instructions.
- **What the screen shows, not what was typed.** Erasing on a line (backspaces with
  erase-to-end-of-line, Ctrl-U), cursor moves and deleted characters are applied, so text you
  deleted at the prompt is not returned. `clear` (and a terminal reset) drop everything before it.
  When older output has dropped out of the tab's 256 KB buffer, the cut-off first line is left out
  so a partial secret is never shown.
- **Your approval, once per tab.** Listing tabs never asks: it returns names, folders and status,
  not output. The first time the agent reads a tab in a task, CoWork asks: "Let the agent read the
  recent output of your terminal tab "cowork" (~/code/cowork)?", with **Deny** and **Allow for this
  task**. Allowing covers that tab until the task ends; another tab asks again. Redaction cannot
  catch everything a shell can show (a typed password, a pasted token, another project's output),
  which is why reading is not silent. Deny returns nothing from the tab.
  - The consent is dropped when the tab closes, when the task ends, or when the task's access
    profile or approval policy changes; the next read asks again.
  - A tab opened by running a code block from this task's answers needs no approval: you pressed
    Run and have seen what it printed.
  - **Full access** still asks, as it does for visual file analysis, because the output leaves
    your computer for the model provider. Without a way to ask (headless runs, the CLI,
    automations), reading is refused.
  - The default is recorded in `src/electron/security/monty-tool-policy.ts` (`read_terminal`:
    `require_approval`, `list_terminal_tabs`: `pass`), and the registry turns it into the per-tab
    consent above. A workspace `.cowork/policy/tools.monty` can deny `read_terminal` or require
    approval on every read; it cannot remove the per-tab consent, which the tool checks itself:

  ```python
  out = {"decision": "pass"}
  if input["tool"] == "read_terminal":
    out = {"decision": "deny", "reason": "no terminal reads in this workspace"}
  out
  ```

`last_command` is the last command that ran in the tab, redacted like `read_terminal` output and
cut to 300 characters.

- **zsh**: commands you type by hand count too. Just before each command runs, the shell
  integration's `preexec` hook reports the line you typed in a shell-integration mark (OSC 133
  `E`, carrying the tab's nonce and the line percent-encoded, cut at 2,048 bytes). Output from
  programs in the tab cannot fake the mark, because only the shell knows the nonce. A line your
  shell keeps out of its history because it starts with a space (`setopt HIST_IGNORE_SPACE`) is
  reported without its text, so `last_command` is left out until the next command.
- **bash**: only commands CoWork ran through the tab count, such as a code block run. Commands you
  type by hand show up in `read_terminal` output, not in `last_command`. Bash has no `preexec`
  hook, and a `DEBUG` trap is not a safe stand-in: it would replace your own `DEBUG` trap
  (bash-preexec, atuin, starship) or be replaced by it, and it sees only the first simple command
  of a line unless it reads history, which skips lines `HISTCONTROL=ignorespace` drops and would
  then report the previous command.

### Code block runs name their tab

When you run a shell code block from an answer, the message that hands its output to the agent
names the tab it ran in: "I ran this command in my terminal tab [cowork](#terminal/<id>) (exit code
1):". The agent can link that tab in its reply or read more of it with `read_terminal`. Messages
from earlier versions, without the tab, are still recognized and shown as a single "Sent the output
of" line.

## Reliability and packaging notes

- `node-pty` native files are unpacked from Electron ASAR so PTY helpers can run in packaged builds.
- On macOS, CoWork repairs the bundled `spawn-helper` executable bit when npm installs with scripts disabled.
- Output replay is sent only on first attach per renderer, avoiding duplicate prompt/output redraws while still preserving terminal history when the dock remounts.
- xterm CSS is isolated from app-wide typography so letter spacing, word spacing, and text transforms do not leak into terminal rendering.

## Relationship to command tools

Terminal Tabs are for user-visible interactive terminal work. Command tools still matter for agent
execution:

- structured command tools can capture stdout/stderr, exit codes, approvals, and sandbox details
- persistent shell sessions preserve operator state for agent-run commands
- terminal tabs give the user a direct live terminal beside the task

The two surfaces share the task workspace and policy context but are not interchangeable. A terminal
tab does not grant an agent a command tool, and selecting an access profile does not automatically
open a terminal tab. See [Access Profiles](access-profiles.md#network-and-command-behavior) for
command availability and profile revalidation.

The product direction is to keep both: reliable structured shell execution for agents and a real terminal surface for humans who need direct control.

## Recommended QA

Validate these flows on each platform before release:

- create, switch, and close multiple tabs
- type commands and verify no duplicate prompt replay
- `cd` and confirm visible prompt changes
- Tab completion in an empty directory and with partial paths
- Up/down history navigation
- Ctrl+C against a long-running command
- interactive CLI prompts such as `npm login`
- resize dock while a command is running
- close a running tab and confirm the child process exits
- packaged-app launch with node-pty native files available
- Run a shell code block from an answer: output streams under the block, the agent gets the
  output once it finishes, and Stop interrupts a long-running command
- Ask the agent to start a dev server: its tab appears with the given title, the answer's chip
  opens it, Stop ends it, and closing the tab stops it
- Run a failing command in your own tab, then ask the agent about it: it asks once to read that
  tab ("Allow for this task"), reads it again without asking, links it as a chip that opens it,
  and an `export SOME_TOKEN=…` typed there comes back redacted. Deny, and it reports that it could
  not read the tab
- Run a code block from an answer, then ask the agent about its tab: it reads it without asking

## Related docs

- [Features](features.md)
- [Architecture](architecture.md)
- [Everything Workbench](everything-workbench.md)
- [Operator Runtime Visibility](operator-runtime-visibility.md)
- [Development](development.md)
