# Migrating from Hermes Agent

CoWork OS can import a Hermes Agent home (`~/.hermes`) so your agent keeps its persona, memory and skills when you move to the desktop. You see everything first: a preview lists each item as ready or skipped, with the reason, and nothing is written until you import.

## Two ways to import

**In the app.** Open **Settings > Import**, press **Preview** next to Hermes Agent, untick anything you want to leave behind, then press **Import**. If CoWork finds `~/.hermes` during first-run setup, it offers the same step before you connect a model.

**From the terminal.**

```bash
cowork import --from hermes --dry-run
```

```bash
cowork import --from hermes
```

| Flag                  | What it does                                                                      |
| --------------------- | --------------------------------------------------------------------------------- |
| `--dry-run`           | Lists what would be imported and why anything is skipped. Writes nothing.         |
| `--with-secrets`      | Also imports provider API keys and bot tokens. They are stored encrypted.         |
| `--workspace-id <id>` | Workspace for scheduled jobs and agent notes (`cowork workspace list` shows ids). |

Quit the desktop app before importing scheduled jobs from the terminal, or import them from Settings > Import; the open app keeps its own copy of the schedule.

## What comes over

| Hermes                                            | CoWork                                                     | Notes                                                                                                                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SOUL.md`                                         | Persona (Settings > Personality)                           | Skipped when it is still Hermes' default text, or when CoWork already has a custom persona.                                                                                    |
| `memories/USER.md`                                | `me.md` in your memory folder                              | One fact per entry.                                                                                                                                                            |
| `memories/MEMORY.md`                              | The workspace's notes, or `lessons.md` without a workspace | One note per entry.                                                                                                                                                            |
| `skills/`                                         | Installed skills (Settings > Skills)                       | Every skill goes through CoWork's security scan; a skill that fails it is quarantined, not installed. Skills that ship with Hermes are left behind because CoWork has its own. |
| Provider keys in `.env`                           | Model settings, encrypted                                  | Only with `--with-secrets` (or the checkbox in Settings). OpenRouter, Anthropic, OpenAI, Gemini, DeepSeek, Groq, xAI and Kimi.                                                 |
| `model` in `config.yaml`                          | Default model                                              | Only when CoWork has no working model yet and a key for that provider exists.                                                                                                  |
| Telegram, Discord, Slack tokens and allowed users | Channels, switched off                                     | Only with secrets. Allowed users become the channel's allowlist; without one, people pair first. Turn the channel on in Settings > Channels after testing it.                  |
| `command_allowlist`                               | Not imported                                               | Hermes approves whole categories of risky commands. CoWork asks per command, so you approve them as they come up.                                                              |
| `cron/jobs.json`                                  | Scheduled tasks, paused                                    | Cron, interval and future one-time jobs. Jobs that run a script, or whose time has passed, are skipped.                                                                        |

Other credentials in `.env` (search, voice, tool keys) and other chat platforms are listed as skipped so nothing disappears silently.

## Where CoWork looks

CoWork reads `HERMES_HOME` when it is set, then `%LOCALAPPDATA%\hermes` on Windows, then `~/.hermes`. If you use Hermes profiles, the profile named in `active_profile` is imported.

The import only reads your Hermes home. It never changes or deletes anything there, so you can keep running Hermes alongside CoWork.

## Running Hermes inside CoWork

You do not have to choose. When Hermes is installed, CoWork lists it as an agent it can delegate
to over the Agent Client Protocol, so a CoWork task can hand work to your existing Hermes with
its own memory, skills and model. It needs Hermes' `acp` extra (`hermes acp --check`) and an
unrestricted access profile, because Hermes cannot enforce CoWork's bounded file and network
rules. See [ACP / acpx integration](acp-acpx-integration.md#hermes-agent-as-an-acp-agent).

## Privacy and safety

- API keys and bot tokens are left out unless you opt in, and are stored with the operating system's encrypted storage when you do. They are never written to the database in plain text or to logs.
- Imported memory lines are tagged `source: hermes` so you can find and remove them in the memory folder.
- Imported scheduled tasks start paused, and imported channels start switched off.
