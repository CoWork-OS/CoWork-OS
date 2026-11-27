# Importing from Claude Code and Cursor

CoWork OS can bring over what you set up in Claude Code (`~/.claude`) and Cursor (`~/.cursor`): your standing instructions, skills, MCP servers, the commands you always allow, and, for a workspace, Claude Code's memory notes and Cursor's project rules. You see everything first: a preview lists each item as ready or skipped, with the reason, and nothing is written until you import.

The import only reads those folders. It never changes or deletes anything there, so you can keep using both tools alongside CoWork.

## Two ways to import

**In the app.** Open **Settings > Import**, press **Preview** next to Claude Code or Cursor, choose a workspace if you want its memory or project rules, untick anything you want to leave behind, then press **Import**. If CoWork finds either tool during first-run setup, it offers the same step before you connect a model.

**From the terminal.**

```bash
cowork import --from claude-code --dry-run
```

```bash
cowork import --from cursor --workspace-id <id>
```

| Flag                  | What it does                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| `--dry-run`           | Lists what would be imported and why anything is skipped. Writes nothing.                                |
| `--with-secrets`      | Also imports API keys and MCP servers that need a token. They are stored encrypted.                      |
| `--workspace-id <id>` | Workspace for Claude Code's memory notes and Cursor's project rules (`cowork workspace list` shows ids). |

Quit the desktop app before importing MCP servers from the terminal, or import them from Settings > Import; the open app keeps its own copy of the server list.

## What comes over from Claude Code

| Claude Code                                                          | CoWork                                                        | Notes                                                                                                                                                                       |
| -------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.claude/CLAUDE.md`                                                | **Response guidance** (Settings > Personality > Instructions) | Skipped when CoWork already has response guidance, or when the file is longer than 12,000 characters. A project's own `CLAUDE.md` needs no import: CoWork already reads it. |
| `~/.claude/skills/`                                                  | Installed skills (Settings > Skills)                          | Every skill goes through CoWork's security scan; one that fails it is quarantined, not installed. Linked skill folders are listed and left alone.                           |
| `mcpServers` in `~/.claude.json`                                     | MCP servers, switched off (Settings > MCP Servers)            | Your user-scope servers. A server whose headers, environment, arguments or address hold a token needs the credentials box. Turn each one on after checking it.              |
| `Bash(...)` rules in `permissions.allow`                             | Commands CoWork runs without asking                           | See [Command rules](#command-rules).                                                                                                                                        |
| `ANTHROPIC_API_KEY` and other provider keys in `settings.json` `env` | Model settings, encrypted                                     | Only with the credentials box or `--with-secrets`. Claude Code's own sign-in is not imported.                                                                               |
| `projects/<workspace>/memory/`                                       | The memory inbox                                              | Needs a workspace. Each note lands in the inbox for you to keep or discard.                                                                                                 |

## What comes over from Cursor

| Cursor                                               | CoWork                                                        | Notes                                                                                                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User Rules (Cursor Settings > Rules)                 | **Response guidance** (Settings > Personality > Instructions) | Read from Cursor's settings. Skipped when CoWork already has response guidance.                                                                                     |
| `~/.cursor/skills/`                                  | Installed skills                                              | Skills that ship with Cursor (`skills-cursor/`) are left behind. Linked skill folders are listed and left alone.                                                    |
| `~/.cursor/mcp.json`                                 | MCP servers, switched off                                     | As for Claude Code.                                                                                                                                                 |
| `Shell(...)` rules in `~/.cursor/cli-config.json`    | Commands CoWork runs without asking                           | See [Command rules](#command-rules).                                                                                                                                |
| `.cursorrules` and `.cursor/rules/` in the workspace | The workspace's instructions (`.cowork/AGENTS.md`)            | Needs a workspace. Only rules that always apply come over; rules for matching files or on request are listed as skipped. A workspace's `AGENTS.md` needs no import. |

## MCP servers

Imported servers arrive switched off with **Imported from Claude Code** or **Imported from Cursor** in their description. Open **Settings > MCP Servers**, check the command or address, and turn the server on. A server CoWork already has (same name, same command line or same address) is skipped.

Servers that use `${VAR}` placeholders are skipped because CoWork does not fill them in; add them by hand with the real values. Servers that are turned off in the other tool stay behind.

## Command rules

A rule like `Bash(npm run test:*)` becomes "commands starting with `npm run test`", and `Bash(git status)` becomes "commands starting with `git status`". CoWork still applies its protected paths, guardrails, the consent for dangerous commands and your access profile before a rule is used.

These stay approval-gated, and are listed with the reason:

- rules for every command (`Bash` or `Bash(*)`) and rules with a wildcard anywhere but the end;
- rules with shell syntax such as pipes, `&&`, `$` or quotes;
- shells, interpreters and wrappers that can run anything (`bash`, `python3`, `node`, `sudo`, `env`, `xargs` and similar), and `rm` and `dd`;
- package runners without a named package (`npx` alone, or `npx -y …`). `npx tsc` is allowed.

Deny rules are not imported.

## Where CoWork looks

- Claude Code: `CLAUDE_CONFIG_DIR` when it is set, then `~/.claude`. The MCP servers come from `~/.claude.json`, or from `.claude.json` inside `CLAUDE_CONFIG_DIR`.
- Cursor: `~/.cursor`, and Cursor's settings database for User Rules (`~/Library/Application Support/Cursor` on macOS, `%APPDATA%\Cursor` on Windows, `~/.config/Cursor` on Linux).
