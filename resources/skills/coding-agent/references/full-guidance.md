# Coding Agent (bash-first)

Use **bash** (with optional background mode) for all coding agent work. Simple and effective.

## PTY Auto-Allocated

CoWork OS **automatically wraps `claude`, `codex`, and other coding agent commands with PTY allocation** — no special syntax needed. Just use `run_command` with the command directly:

```bash
# PTY is auto-allocated by CoWork OS for claude/codex commands
codex exec 'Your prompt'
claude -p 'Your prompt'
```

API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY`) are auto-forwarded from the host environment.

### Process Tool Actions (for background sessions)

| Action      | Description                                          |
| ----------- | ---------------------------------------------------- |
| `list`      | List all running/recent sessions                     |
| `poll`      | Check if session is still running                    |
| `log`       | Get session output (with optional offset/limit)      |
| `write`     | Send raw data to stdin                               |
| `submit`    | Send data + newline (like typing and pressing Enter) |
| `send-keys` | Send key tokens or hex bytes                         |
| `paste`     | Paste text (with optional bracketed mode)            |
| `kill`      | Terminate the session                                |

---

## Quick Start: One-Shot Tasks

For quick prompts/chats, create a temp git repo and run:

```bash
# Quick chat (Codex needs a git repo!)
SCRATCH=$(mktemp -d) && cd $SCRATCH && git init && codex exec "Your prompt here"

# Or in a real project - with PTY!
cd ~/Projects/myproject && codex exec 'Add error handling to the API calls'
```

**Why git init?** Codex refuses to run outside a trusted git directory. Creating a temp repo solves this for scratch work.

---

## The Pattern: workdir + background + pty

For longer tasks, use background mode with PTY:

```bash
# Start agent in target directory (with PTY!)
cd ~/project && codex exec --full-auto 'Build a snake game'
# Returns sessionId for tracking

# Monitor progress
process action:log sessionId:XXX

# Check if done
process action:poll sessionId:XXX

# Send input (if agent asks a question)
process action:write sessionId:XXX data:"y"

# Submit with Enter (like typing "yes" and pressing Enter)
process action:submit sessionId:XXX data:"yes"

# Kill if needed
process action:kill sessionId:XXX
```

**Why workdir matters:** Agent wakes up in a focused directory, doesn't wander off reading unrelated files (like your soul.md 😅).

---

## Codex CLI

**Model:** `gpt-5.2-codex` is the default (set in ~/.codex/config.toml)

### Flags

| Flag            | Effect                                             |
| --------------- | -------------------------------------------------- |
| `exec "prompt"` | One-shot execution, exits when done                |
| `--full-auto`   | Sandboxed but auto-approves in workspace           |
| `--yolo`        | NO sandbox, NO approvals (fastest, most dangerous) |

### Building/Creating

```bash
# Quick one-shot (auto-approves) - remember PTY!
cd ~/project && codex exec --full-auto 'Build a dark mode toggle'

# Background for longer work
cd ~/project && codex --yolo 'Refactor the auth module'
```

### Reviewing PRs

**⚠️ CRITICAL: Never review PRs in CoWork-OSS's own project folder!**
Clone to temp folder or use git worktree.

```bash
# Clone to temp for safe review
REVIEW_DIR=$(mktemp -d)
git clone https://github.com/user/repo.git $REVIEW_DIR
cd $REVIEW_DIR && gh pr checkout 130
cd $REVIEW_DIR && codex review --base origin/main"
# Clean up after: trash $REVIEW_DIR

# Or use git worktree (keeps main intact)
git worktree add /tmp/pr-130-review pr-130-branch
cd /tmp/pr-130-review && codex review --base main"
```

### Batch PR Reviews (parallel army!)

```bash
# Fetch all PR refs first
git fetch origin '+refs/pull/*/head:refs/remotes/origin/pr/*'

# Deploy the army - one Codex per PR (all with PTY!)
cd ~/project && codex exec 'Review PR #86. git diff origin/main...origin/pr/86'
cd ~/project && codex exec 'Review PR #87. git diff origin/main...origin/pr/87'

# Monitor all
process action:list

# Post results to GitHub
gh pr comment <PR#> --body "<review content>"
```

---

## Claude Code

```bash
# With PTY for proper terminal output
cd ~/project && claude 'Your task'

# Background
cd ~/project && claude 'Your task'
```

---

## OpenCode

```bash
cd ~/project && opencode run 'Your task'
```

---

## Pi Coding Agent

```bash
# Install: npm install -g @mariozechner/pi-coding-agent
cd ~/project && pi 'Your task'

# Non-interactive mode (PTY still recommended)
$1

# Different provider/model
$1
```

**Note:** Pi now has Anthropic prompt caching enabled (PR #584, merged Jan 2026)!

## Context Minimization with Finder/Librarian

Before launching a large coding task, scout context first and hand the coding agent a strict file shortlist:

```bash
# Local repo scout (Finder)
cd ~/project && pi --no-session --tools read,grep,find,ls,bash -e npm:pi-finder-subagent -p 'Use finder to locate files relevant to <task>. Return max 12 files with line ranges.'

# Optional GitHub scout (Librarian)
cd ~/project && pi --no-session --tools read,grep,find,ls,bash -e npm:pi-librarian -p 'Use librarian to find reference implementations for <task>. Return cited files with line ranges.'
```

Use the resulting shortlist as the opening context for Codex/Claude prompts instead of broad repo reads.

---

## Parallel Issue Fixing with git worktrees

For fixing multiple issues in parallel, use git worktrees:

```bash
# 1. Create worktrees for each issue
git worktree add -b fix/issue-78 /tmp/issue-78 main
git worktree add -b fix/issue-99 /tmp/issue-99 main

# 2. Launch Codex in each (background + PTY!)
cd /tmp/issue-78 && pnpm install && codex --yolo 'Fix issue #78: <description>. Commit and push.'
cd /tmp/issue-99 && pnpm install && codex --yolo 'Fix issue #99: <description>. Commit and push.'

# 3. Monitor progress
process action:list
process action:log sessionId:XXX

# 4. Create PRs after fixes
cd /tmp/issue-78 && git push -u origin fix/issue-78
gh pr create --repo user/repo --head fix/issue-78 --title "fix: ..." --body "..."

# 5. Cleanup
git worktree remove /tmp/issue-78
git worktree remove /tmp/issue-99
```

---

## ⚠️ Rules

1. **PTY is auto-allocated** - CoWork OS wraps coding agent commands with PTY automatically
2. **Respect tool choice** - if user asks for Codex, use Codex.
   - Orchestrator mode: do NOT hand-code patches yourself.
   - If an agent fails/hangs, respawn it or ask the user for direction, but don't silently take over.
3. **Be patient** - don't kill sessions because they're "slow"
4. **Monitor with process:log** - check progress without interfering
5. **--full-auto for building** - auto-approves changes
6. **vanilla for reviewing** - no special flags needed
7. **Parallel is OK** - run many Codex processes at once for batch work
8. **NEVER start Codex in ~/CoWork-OSS/** - it'll read your soul docs and get weird ideas about the org chart!
9. **NEVER checkout branches in ~/Projects/CoWork-OSS/** - that's the LIVE CoWork-OSS instance!

---

## Progress Updates (Critical)

When you spawn coding agents in the background, keep the user in the loop.

- Send 1 short message when you start (what's running + where).
- Then only update again when something changes:
  - a milestone completes (build finished, tests passed)
  - the agent asks a question / needs input
  - you hit an error or need user action
  - the agent finishes (include what changed + where)
- If you kill a session, immediately say you killed it and why.

This prevents the user from seeing only "Agent failed before reply" and having no idea what happened.

---

## Auto-Notify on Completion

For long-running background tasks, append a wake trigger to your prompt so CoWork-OSS gets notified immediately when the agent finishes (instead of waiting for the next heartbeat):

```
... your task here.

When completely finished, run this command to notify me:
CoWork-OSS gateway wake --text "Done: [brief summary of what was built]" --mode now
```

**Example:**

```bash
cd ~/project && codex --yolo exec 'Build a REST API for todos.

When completely finished, run: CoWork-OSS gateway wake --text \"Done: Built todos REST API with CRUD endpoints\" --mode now'"
```

This triggers an immediate wake event — Skippy gets pinged in seconds, not 10 minutes.

---

## Learnings (Jan 2026)

- **PTY is auto-allocated:** CoWork OS handles PTY wrapping for `claude`/`codex` commands automatically.
- **Git repo required:** Codex won't run outside a git directory. Use `mktemp -d && git init` for scratch work.
- **exec is your friend:** `codex exec "prompt"` runs and exits cleanly - perfect for one-shots.
- **submit vs write:** Use `submit` to send input + Enter, `write` for raw data without newline.
- **Sass works:** Codex responds well to playful prompts. Asked it to write a haiku about being second fiddle to a space lobster, got: _"Second chair, I code / Space lobster sets the tempo / Keys glow, I follow"_ 🦞
