# Terminal Tabs

Terminal Tabs turn CoWork OS into a real developer workbench instead of a chat app that occasionally runs shell commands. They give each workspace an interactive terminal dock inside the desktop app, backed by the operating system's native pseudoterminal layer and rendered with xterm.js.

This is one of the larger steps toward CoWork OS as a GUI-first AI super app and everything app: coding, agent execution, browser testing, documents, spreadsheets, presentations, inbox, automations, devices, and now full terminal work can stay in one governed workspace.

## What users get

- **Real interactive terminals**: typing, command echo, cursor movement, arrow keys, Ctrl+C, Tab completion, interactive prompts, and long-running process output flow through a PTY instead of a custom text emulator.
- **Multiple terminal tabs**: open more than one terminal for the same workspace, switch between tabs, create new tabs, close individual tabs, or close the whole dock.
- **In-app dock placement**: the terminal opens under the message box and pushes the main work area and right sidebar upward, so it behaves like another first-class work surface instead of a floating popup.
- **Native shell behavior**: macOS launches the user's login shell through `node-pty`; Windows launches `cmd.exe` through the Windows PTY backend.
- **Resizable terminal grid**: xterm.js measures the visible dock and sends column/row changes to the PTY so full-screen terminal UIs and wrapping behave like a normal terminal.
- **Prompt cleanup**: macOS zsh prompts are adjusted to show cwd-only prompts such as `cowork %`; Windows `cmd.exe` uses a cwd prompt such as `C:\Users\mesut\project>`.
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

| Layer | Responsibility |
| --- | --- |
| Renderer | `TerminalTabsDock` creates xterm instances, fits them to the dock, forwards keyboard input, renders PTY output, and exposes tab controls. |
| Preload / IPC | Typed terminal-tab channels create, list, write, resize, stop, and close tabs while keeping renderer access narrow. |
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

## Related docs

- [Features](features.md)
- [Architecture](architecture.md)
- [Everything Workbench](everything-workbench.md)
- [Operator Runtime Visibility](operator-runtime-visibility.md)
- [Development](development.md)
