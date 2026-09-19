# Codex CLI — Full Execution Guidance

## Overview

This skill runs the OpenAI Codex CLI (`codex`) as an autonomous sub-agent. Follow phases in order: **Detect → Setup → Execute**.

**IMPORTANT**: When running a Codex task, always use `spawn_agent` to create a dedicated child task. This ensures the CLI work appears in its own dedicated frame in the UI. The child task's prompt should contain the exact commands below — do NOT make the child task re-read this guidance doc.

---

## Phase 0: Detect

```bash
which codex
```

- **Found** (exit 0): skip to Phase 2
- **Not found** (exit 1): go to Phase 1

Then verify auth:

```bash
codex --version
```

If this errors with auth issues: go to Phase 1b.

---

## Phase 1: Install

Tell the user: **"Codex CLI is not installed. I'll set it up."**

```bash
npm install -g @openai/codex
```

Verify:

```bash
which codex && codex --version
```

If `which codex` still fails after install — PATH issue:

```bash
npm bin -g         # shows the global bin path
echo $PATH         # check if it's included
```

Fix: add to `~/.zshrc` or `~/.bashrc`:

```bash
export PATH="$(npm bin -g):$PATH"
```

Then `source ~/.zshrc && which codex`.

---

## Phase 1b: Configure Auth

Codex requires an OpenAI API key.

### Option A: Browser Login (recommended)

```bash
codex login
```

Opens browser for OAuth. Credentials saved to `~/.codex/auth.json`.

### Option B: API Key

```bash
# Check if already set
echo $OPENAI_API_KEY | head -c 10

# If not set, add to shell config:
export OPENAI_API_KEY="sk-your-key-here"
# Or: export CODEX_API_KEY="sk-your-key-here"
```

Verify auth works:

```bash
codex --version
```

---

## Phase 2: Execute

### Spawning as a sub-agent

Always use `spawn_agent` to run Codex as a child task:

```
spawn_agent({
  title: "Codex review PR #55",
  prompt: "...(exact commands below)...",
  capability_hint: "cli-agent",
  model_preference: "smarter",
  wait: true
})
```

The child task prompt should contain the EXACT bash commands to run. See patterns below.

### PTY Auto-Allocated

Codex is an interactive terminal app. CoWork OS **automatically wraps `codex` commands with PTY allocation** — no special syntax needed. Just use `run_command` normally:

```bash
codex exec 'Your prompt'
```

API keys (`OPENAI_API_KEY`, `CODEX_API_KEY`) are also auto-forwarded from the host environment.

### Git Repo Required

Codex refuses to run outside a trusted git directory. For scratch work:

```bash
SCRATCH=$(mktemp -d) && cd $SCRATCH && git init
```

---

## Complete Command Reference

### Subcommands

| Command               | Description                                     |
| --------------------- | ----------------------------------------------- |
| `codex exec "prompt"` | One-shot: run prompt and exit. Alias: `codex e` |
| `codex login`         | Browser-based OAuth login                       |
| `codex logout`        | Remove stored credentials                       |
| `codex resume`        | Resume a previous session                       |
| `codex resume --last` | Resume the most recent session                  |
| `codex resume --all`  | List all resumable sessions                     |
| `codex mcp`           | Run as MCP server (for external orchestration)  |
| `codex completion`    | Generate shell completions                      |

### Global Flags

| Flag                   | Short | Description                                                     |
| ---------------------- | ----- | --------------------------------------------------------------- |
| `--model MODEL`        | `-m`  | Override model (default: from config)                           |
| `--approval-mode MODE` | `-a`  | `on-request` (default) or `never`                               |
| `--sandbox TYPE`       | `-s`  | `read-only`, `workspace-write`, or `danger-full-access`         |
| `--quiet`              | `-q`  | Suppress non-essential output                                   |
| `--chdir DIR`          |       | Change working directory before execution                       |
| `--full-auto`          |       | Shorthand: `--approval-mode never --sandbox workspace-write`    |
| `--yolo`               |       | Shorthand: `--approval-mode never --sandbox danger-full-access` |
| `--add-writable DIR`   |       | Add extra writable directory                                    |
| `--no-project-doc`     |       | Skip reading AGENTS.md                                          |
| `--enable FEATURE`     |       | Enable a feature                                                |
| `--disable FEATURE`    |       | Disable a feature                                               |
| `-c key=value`         |       | Set config override                                             |

### Exec-Specific Flags

| Flag                  | Description                                  |
| --------------------- | -------------------------------------------- |
| `--json`              | NDJSON streaming output (one event per line) |
| `--resume SESSION_ID` | Resume a previous exec session               |
| `--last`              | Resume the most recent session               |
| `--all`               | List all sessions                            |
| `--image PATH`        | Attach an image to the prompt                |

### Environment Variables

| Variable         | Description                                     |
| ---------------- | ----------------------------------------------- |
| `OPENAI_API_KEY` | API key (fallback)                              |
| `CODEX_API_KEY`  | API key (preferred)                             |
| `CODEX_HOME`     | Override config directory (default: `~/.codex`) |

### Config Files

| Path                   | Scope                | Format   |
| ---------------------- | -------------------- | -------- |
| `~/.codex/config.toml` | Global               | TOML     |
| `.codex/config.toml`   | Project              | TOML     |
| `~/.codex/auth.json`   | Auth credentials     | JSON     |
| `AGENTS.md`            | Project instructions | Markdown |

### NDJSON Event Types (`--json` mode)

| Event            | Description                   |
| ---------------- | ----------------------------- |
| `thread.started` | Execution session started     |
| `turn.started`   | New agent turn began          |
| `item.started`   | Tool call or message started  |
| `item.updated`   | Streaming update              |
| `item.completed` | Tool call or message finished |
| `turn.completed` | Turn finished                 |
| `turn.failed`    | Turn errored                  |

---

## Decision Tree

| Task                               | Command                                                                                |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| **PR Review** (read-only)          | `codex exec "Review this PR against main. Focus on bugs, security, breaking changes."` |
| **Fix/Build** (auto-approve)       | `codex exec --full-auto "Fix issue #N: description"`                                   |
| **Scratch/Dangerous** (no sandbox) | `codex exec --yolo "Do X"`                                                             |
| **JSON output** (programmatic)     | `codex exec --json "prompt"`                                                           |
| **Resume previous**                | `codex resume --last`                                                                  |
| **Specific model**                 | `codex exec -m o4-mini "prompt"`                                                       |

---

## Execution Patterns

### PR Review (safe — temp clone)

```bash
REVIEW_DIR=$(mktemp -d)
git clone https://github.com/OWNER/REPO.git $REVIEW_DIR
cd $REVIEW_DIR && gh pr checkout PR_NUMBER
codex exec 'Review this PR against main. Identify blocking issues, risks, and provide a merge/block verdict with severity-rated findings.'
rm -rf $REVIEW_DIR
```

### PR Review (fast — worktree)

```bash
git fetch origin pull/PR_NUMBER/head:pr/PR_NUMBER
git worktree add /tmp/pr-PR_NUMBER-codex pr/PR_NUMBER
cd /tmp/pr-PR_NUMBER-codex && codex exec 'Review this branch against main. Provide a structured verdict.'
git worktree remove /tmp/pr-PR_NUMBER-codex
git branch -d pr/PR_NUMBER
```

### Issue Fix (worktree isolation)

```bash
git worktree add -b fix/ISSUE_ID-codex /tmp/fix-ISSUE_ID-codex main
cd /tmp/fix-ISSUE_ID-codex && codex exec --full-auto 'Fix issue #ISSUE_ID: DESCRIPTION. Commit with message fix: ISSUE_ID and push.'
# After: cd /tmp/fix-ISSUE_ID-codex && git push -u origin fix/ISSUE_ID-codex
# PR: gh pr create --head fix/ISSUE_ID-codex --title 'fix: ISSUE_ID' --body '...'
```

### Background with monitoring

```bash
cd /path/to/repo && codex exec --full-auto 'Your task'
# The agent runs in the child task — monitor via CoWork OS UI
```

---

## Doc Fallback URLs

If you need to look up additional Codex CLI information at runtime:

- CLI Reference: `https://developers.openai.com/codex/cli/reference/`
- Config Reference: `https://developers.openai.com/codex/config-reference/`
- Auth Guide: `https://developers.openai.com/codex/auth/`
- Non-Interactive Mode: `https://developers.openai.com/codex/noninteractive/`
- GitHub: `https://github.com/openai/codex`

Use `web_fetch` to retrieve these if needed.

---

## Rules

1. **PTY is auto-allocated** — CoWork OS wraps `codex` commands with PTY automatically
2. **Always spawn as child task** via `spawn_agent` — ensures dedicated UI frame
3. **Never run in CoWork OS's own project directory**
4. **Respect user's tool choice** — don't substitute with Claude Code
5. **Don't kill sessions for being slow** — monitor with `process:log`
6. **Use `--full-auto` for building/fixing**, vanilla `codex exec` for reviewing
