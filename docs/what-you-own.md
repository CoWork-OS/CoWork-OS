# What You Own

You rent the model and own everything else. The model comes from the provider you connect, and you
can swap it. Your files, memory, skills and settings stay on your machine, mostly in formats you can
open and read.

This page covers four things:

- where each kind of data is stored
- how to back it up or move it
- what leaves your machine when you run tasks
- what you can't export yet

`userData` below means the app's data folder:

- macOS: `~/Library/Application Support/cowork-os/`
- Linux: `~/.config/cowork-os/`
- Windows: `%APPDATA%\cowork-os\`

Additional profiles keep their own data under `userData/profiles/<id>/`.

## Where your data lives

| What                                                                               | Where                                                                                                                                | Format                                                                   | Back up or move it                                                                                        |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Workspaces and generated files                                                     | The folders you choose                                                                                                               | Your own files                                                           | Like any folder. Temporary workspaces, used when you don't pick a folder, are deleted after 14 days       |
| Memory folder: what CoWork knows about you, your workspaces and lessons            | `~/CoWork Memory` for the default profile, `userData/memory-repo` for other profiles, or a path you set                              | Markdown notes in a local git repo, in the open Agent Memory Repo format | Copy the folder, or turn on **Sync** to a private https or ssh remote you own                             |
| Other memory: commitments, notes about other people, task archive, knowledge graph | `userData/cowork-os.db`                                                                                                              | SQLite                                                                   | Profile export only                                                                                       |
| Skills                                                                             | Installed skills in `userData/skills/`, workspace skills in `<workspace>/.cowork/skills/`, bundled skills inside the app             | JSON manifest plus `SKILL.md` and support files                          | Copy the folders. Import from ClawHub, a Git repository or a `SKILL.md` URL                               |
| Bots, agent roles and teams                                                        | `userData/cowork-os.db`                                                                                                              | SQLite                                                                   | Profile export only                                                                                       |
| Automations and scheduled tasks                                                    | `userData/cowork-os.db`, with scheduled jobs in `userData/cron/jobs.json`                                                            | SQLite and JSON                                                          | Profile export only                                                                                       |
| Conversations and task history                                                     | `userData/cowork-os.db`, with checkpoints in `<workspace>/.cowork/memory/transcripts/checkpoints/`                                   | SQLite                                                                   | **Copy as Markdown** from a conversation's menu, one conversation at a time                               |
| Approval rules and policies                                                        | Workspace rules in the database, mirrored to `<workspace>/.cowork/policy/permissions.json`; admin policy in `userData/policies.json` | JSON                                                                     | The workspace file travels with the folder. You approve its allow rules again on a new machine, by design |
| API keys, sign-ins and connector credentials                                       | Encrypted settings in `userData/cowork-os.db`                                                                                        | Encrypted with your OS keychain (Keychain, DPAPI or libsecret)           | They don't move between machines. Enter them again after a restore                                        |

Generated documents, spreadsheets, decks and other outputs are written to your workspace as normal
files, so they stay with you whatever happens to the app.

## Moving to another machine

There are three ways to move data today. Each has limits.

- **Memory folder sync.** Turn it on in **Settings → Memory**, on the memory folder card. It
  pushes the folder to a private git remote you own and pulls it on your other machines. It uses
  your own git credentials.
- **Profile export.** **Settings → Profiles → Export** copies the profile's whole data folder.
  Export while no tasks are running. Its limits:
  - It doesn't include `~/CoWork Memory`, which lives outside the data folder, or your workspace
    folders.
  - Encrypted settings, such as API keys, can't be read on another machine. CoWork asks you to
    enter them again.
- **`cowork backup`.** `cowork backup create --output cowork-backup.json` records three things:
  - your workspaces and recent task metadata
  - provider, tool and MCP settings
  - your skills

  `cowork backup restore` brings back only the provider, tool and MCP settings. Secrets are
  redacted unless you pass `--include-secrets --yes`, and restored MCP servers start disabled. See
  [CoWork CLI](cli.md).

## Switching models

CoWork passes your memory, skills, tools and approval rules to whichever model you connect. A new
conversation on a different provider gets all of them. See [Models & Access](providers.md) for the
supported providers, including local models.

Picking a different model while a conversation is open changes that conversation only: it stays
open with its history, and the next message goes to the new model. The global default and other
conversations are unchanged. See [Bots and conversations](bots-and-conversations.md) for the
handoff note a provider change adds and for a bot's own model.

The optional `local-balanced-v1` profile for local models works with a lighter budget: at most 10
tools and 768 tokens of memory. See [Local-model execution](local-model-execution.md).

## What leaves your machine

CoWork stores your data locally. Running a task sends data to the services that do the work:

- **Your model provider** gets the prompts you send, plus the file content, tool results, memory
  and skill text a task uses. With a local model (Ollama, MLX and others), this stays on your
  machine.
- **Dreaming** is on by default while the memory folder is on. About once a day it sends the
  memory folder and recent task conversations to your active provider, within a 50,000-token daily
  budget. You can turn it off on the memory folder card in **Settings → Memory**.
- **Connectors, channels and web tools** get what their tools need for the task you run. These
  include MCP servers, messaging channels, web search and Browser Use Cloud.
- **Memory folder sync**, when you turn it on, pushes the folder to the remote you chose.
- **Update checks.** At startup, installed builds ask `pulse.coworkosapp.com` for the latest
  version, then fall back to GitHub. The request sends only the app version, platform, CPU
  architecture and surface. Manual checks in Settings go straight to GitHub.
- **CoWork Pulse** is off by default. If you opt in, it sends one daily record of aggregate counts.
  It never sends prompts, files, URLs, model routes or account data. See [CoWork Pulse](cowork-pulse.md).
- **Skill and pack registries** are downloaded from GitHub when you browse or install skills and
  packs.

## What CoWork doesn't do

- There's no CoWork account or subscription.
- CoWork doesn't proxy or resell model access. Your provider bills you directly.
- There are no usage analytics unless you opt in to CoWork Pulse.
- The code is MIT-licensed and public on [GitHub](https://github.com/CoWork-OS/CoWork-OS).

## Not exportable yet

Some data has no open export format today:

- bots, agent roles, teams and automations
- full conversation history, apart from **Copy as Markdown** one conversation at a time
- the knowledge graph, task archive, commitments and notes about other people

This data lives in the profile database and moves only with a profile export.

A versioned handoff package for an in-progress session is planned.

For encryption details and network destinations, see the [Security Guide](security-guide.md).
