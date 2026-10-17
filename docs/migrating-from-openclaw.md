# Migrating from OpenClaw

CoWork OS can import an OpenClaw home (`~/.openclaw`, or the older `~/.clawdbot` and `~/.moltbot`) so your agent keeps its persona, workspace instructions, memory and skills. A preview lists each item as ready or skipped, with the reason, and nothing is written until you import.

## Two ways to import

**In the app.** Open **Settings > Import**, press **Preview** next to OpenClaw, untick anything you want to leave behind, choose a workspace for workspace instructions and scheduled jobs, then press **Import**. If CoWork finds an OpenClaw home during first-run setup, it offers the same step before you connect a model.

**From the terminal.**

```bash
cowork import --from openclaw --dry-run
```

```bash
cowork import --from openclaw --workspace-id <workspaceId>
```

| Flag                  | What it does                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| `--dry-run`           | Lists what would be imported and why anything is skipped. Writes nothing.                      |
| `--with-secrets`      | Also imports provider API keys and bot tokens. They are stored encrypted.                      |
| `--workspace-id <id>` | Workspace for `AGENTS.md`, scheduled jobs and agent notes (`cowork workspace list` shows ids). |

Quit the desktop app before importing scheduled jobs from the terminal, or import them from Settings > Import.

## What comes over

Workspace files are read from `workspace/` (or `workspace-main/`, `workspace-assistant/`, `workspace.default/`, or the folder in `agents.defaults.workspace`).

| OpenClaw                                                                               | CoWork                                                     | Notes                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SOUL.md`                                                                              | Persona (Settings > Personality)                           | Skipped when CoWork already has a custom persona.                                                                                                                                                               |
| `AGENTS.md`                                                                            | `.cowork/AGENTS.md` in the chosen workspace                | Added as its own section when the workspace already has instructions. Up to 12,000 characters.                                                                                                                  |
| `USER.md`                                                                              | `me.md` in your memory folder                              | List items and paragraphs become facts; blank template fields are dropped.                                                                                                                                      |
| `MEMORY.md`                                                                            | The workspace's notes, or `lessons.md` without a workspace | More than 50 notes go to the memory inbox for review instead.                                                                                                                                                   |
| `memory/*.md` daily notes                                                              | The memory inbox                                           | You keep or drop each note in Settings > Memory > Review.                                                                                                                                                       |
| Skills in the workspace and in `~/.openclaw/skills`                                    | Installed skills                                           | Every skill goes through CoWork's security scan; a skill that fails it is quarantined.                                                                                                                          |
| Provider keys (`models.providers.*.apiKey`, `.env`, the config's `env`, auth profiles) | Model settings, encrypted                                  | Only with `--with-secrets`. `${VAR}` templates and `env` references are resolved; `file` and `exec` references are not followed.                                                                                |
| `agents.defaults.model`                                                                | Default model                                              | Only when CoWork has no working model yet and a key for that provider exists.                                                                                                                                   |
| Telegram, Discord, Slack tokens and `allowFrom`                                        | Channels, switched off                                     | Only with secrets. `allowFrom` becomes the channel's allowlist.                                                                                                                                                 |
| `exec-approvals.json`                                                                  | "Always allow" command rules                               | Only exact programs, such as `/opt/homebrew/bin/rg`. Wildcards, shells and interpreters stay approval-gated. CoWork's protected paths, guardrails and access profiles still apply.                              |
| `cron/jobs.json`                                                                       | Scheduled tasks, paused                                    | Jobs that send the agent a message. System events and past one-time jobs are skipped. Newer OpenClaw releases keep jobs in their state database, which CoWork does not read; recreate those in Scheduled tasks. |

The config file is read as JSON5, so comments and unquoted keys are fine. Other chat platforms (WhatsApp, Signal, Matrix and so on) are listed as skipped; connect them in Settings > Channels. Personal skills in `~/.agents/skills` are shared with other tools and are not imported.

## Privacy and safety

- The import only reads your OpenClaw home and never changes it.
- API keys and bot tokens are left out unless you opt in, and are stored with the operating system's encrypted storage when you do. They are never written to the database in plain text or to logs.
- Imported memory lines are tagged `source: openclaw`.
- Imported scheduled tasks start paused, and imported channels start switched off.

See also: [Migration Guide](migration.md) and [CoWork OS vs OpenClaw](comparisons/openclaw.md).
