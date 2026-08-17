# CoWork OS CLI

CoWork OS is now both a desktop app and a terminal agent surface. The desktop GUI remains the primary operator console for agents, artifacts, approvals, automations, Mission Control, and settings. The `cowork` command adds a fast local command-line entrypoint for starting work without opening a separate Control Plane session.

## What `cowork` Runs

The CLI has two local modes plus local management commands:

- `cowork` opens an interactive terminal UI with the CoWork welcome panel, command shortcuts, local workspace/provider status, and a prompt for task input.
- `cowork run "<task>"` runs a one-shot local task and streams the result back to the terminal.
- Commands such as `cowork status`, `cowork sessions list`, `cowork tools list`, `cowork mcp list`, `cowork backup create`, and `cowork security audit` read or update the same local settings/database used by the desktop app.

By default, these local modes do **not** require `COWORK_CONTROL_PLANE_TOKEN`. They use the same local CoWork profile, database, provider settings, workspaces, skills, and MCP connector configuration that the desktop app uses.

Remote Control Plane mode is explicit:

```bash
cowork run "summarize the active project" --remote
```

Use `--remote` only when you intentionally want the CLI to call a running remote Control Plane endpoint. In that mode, configure `COWORK_CONTROL_PLANE_URL` and `COWORK_CONTROL_PLANE_TOKEN`, or pass the equivalent CLI options.

## First Run

Install globally from npm:

```bash
npm install -g cowork-os
cowork
```

From a source checkout:

```bash
npm run setup
npm run build:cli
cowork
```

The source launcher can build missing CLI artifacts automatically, but `npm run build:cli` is the fastest explicit path when iterating locally.

If you have already configured providers in the desktop app, `cowork` should pick them up. On macOS and Windows, the CLI prefers the bundled Electron runtime in `ELECTRON_RUN_AS_NODE=1` mode for local commands. That gives terminal commands normal stdout/stderr while preserving the Electron/Node ABI required by native modules and encrypted desktop settings. If Electron is unavailable, the CLI can fall back to the Node runner, but OS-encrypted desktop credentials and native modules may not be readable from that fallback process.

## Commands

```bash
cowork
cowork run "who are you?"
cowork run "inspect this repo and list the riskiest files" --workspace /path/to/repo
cowork run "return a compact status report" --json
cowork providers list
cowork providers configure openai --model gpt-5.5
cowork providers fallback list
cowork workspace list
cowork sessions list
cowork sessions export <sessionId> --output session.json
cowork logs latest
cowork tools list
cowork mcp list
cowork skills audit
cowork models list
cowork backup create --output cowork-backup.json
cowork backup restore cowork-backup.json --dry-run
cowork security audit
cowork security status --refresh
cowork security findings
cowork security finding <findingId> acknowledged
cowork security decisions
cowork security inventory --refresh
cowork security scan
cowork security check-rules
cowork security hooks status codex
cowork security hooks install codex --yes
cowork security case build incident-123 --task-id <taskId>
cowork security prune --yes
cowork prompt-size "estimate this prompt"
cowork completions zsh
cowork dashboard status
cowork tail <taskId>
cowork approvals
cowork run "run this on the remote node" --remote
cowork --help
```

Interactive mode accepts free-text tasks and slash commands:

- `/doctor` checks runtime, database, workspace, provider, and local CLI readiness.
- `/providers list` shows locally configured model routes.
- `/providers configure <provider>` saves common provider settings locally through the same encrypted settings store used by the desktop app.
- `/workspace list` shows known local workspaces.
- `/workspace use <path>` sets the working workspace for the session.
- `/exit` leaves the CLI.

`approve` and `reject` use a local desktop handoff by default. The CLI sends the response to the already-running CoWork OS app through the app's single-instance bridge, so the live task runtime can wake and continue without Control Plane. If no desktop app is running, open CoWork OS and retry, or use `cowork approve <approvalId> --remote` / `cowork reject <approvalId> --remote` against a running Control Plane target.

### Local Management Commands

These command groups are local-first and do not require a Control Plane token:

- `cowork version` and `cowork status` show installed runtime, provider, workspace, task, MCP, and tool readiness.
- `cowork sessions ...` manages local task lineages. Rename/delete/prune use CLI metadata; delete and prune require `--yes` and archive sessions from CLI lists instead of deleting task history.
- `cowork logs latest|tail|grep` reads local developer logs when developer logging has captured them.
- `cowork tools list|info|enable|disable` updates built-in tool category or per-tool settings.
- `cowork mcp list|add|remove|enable|disable|test` updates local MCP server settings.
- `cowork skills list|info|audit` inspects locally registered skills.
- `cowork models list` shows the current provider model list and stored model presets.
- `cowork providers fallback list|add|remove` manages global provider fallback routes.
- `cowork backup create|restore` exports local workspaces, recent task metadata, provider settings, tool settings, MCP settings, and skills. Task content, approval payloads, and MCP secrets are redacted unless `--include-secrets --yes` is passed. Restore previews are safe with `--dry-run`; actual restore requires `--yes`, validates settings, restores settings only, and keeps restored MCP servers disabled until re-enabled.
- `cowork security audit` checks local provider/tool/permission posture. Warnings return a non-zero exit code so CI can fail on risky local settings.
- `cowork security rules list|remove` inspects or removes workspace permission rules. Removal requires `--yes`.
- `cowork security status|findings|finding|decisions|inventory|scan|check-rules|hooks|case|prune` operates the optional Numbat agent-security runtime. Mutating operations require `--yes` where shown by `cowork security --help`.
- `cowork prompt-size` and `cowork prompt-preview` provide quick prompt diagnostics.
- `cowork completions zsh|bash|fish` prints shell completion snippets.
- `cowork dashboard` and `cowork open task <taskId>` launch the desktop app/deeplink without using the Control Plane.

## Runtime Model

The CLI is not a separate product backend. It is another surface over the same local runtime contracts:

- `bin/cowork-cli.js` resolves the installed package, ensures CLI build output exists, and launches the TypeScript-compiled CLI.
- `src/cli/main.ts` owns argument parsing, the interactive terminal UI, slash commands, local diagnostics, and remote-mode dispatch.
- `src/cli/direct-run.ts` owns one-shot local execution and local management commands when the CLI runs with the bundled Electron-as-Node runtime.
- `src/electron/main.ts` supports `--cowork-cli-direct-run`, a hidden app-entry mode retained for packaged app-entry compatibility, plus a single-instance approval handoff for local approval responses.

Local one-shot execution initializes the database, settings, provider routing, workspace resolution, skills, MCP servers, and agent daemon, then creates a task and waits for completion. The CLI daemon disables startup recovery for that process so it does not recover, resume, or rewrite GUI-owned tasks while the desktop app is also running.

Interactive `cowork` and local `cowork run` can be used while the GUI is installed and already configured. They share local profile state, but each CLI task is still a distinct task run with its own terminal output.

### Agent Security Commands

Numbat agent security is disabled by default. Configure it in **Settings > System & Security > Agent Security** or through the admin policy before expecting scans or enforcement decisions. Local commands use the desktop profile; add `--remote` only for an intentional Control Plane call, where state-changing operations require admin scope.

`status`, `findings`, `decisions`, and `inventory` are inspection commands. `scan` and `check-rules` run bounded checks. Finding-state changes, hook installation/removal, case-bundle creation, and retention pruning are explicit operator actions. Case verification checks the bundle manifest and checksums without changing runtime policy.

See [Agent Security with Numbat](agent-security-numbat.md) for policy defaults, rule provenance, failure behavior, retention, external hook constraints, and troubleshooting.

## Security And Credentials

- Local CLI mode keeps provider credentials and task data on the machine, following the desktop app's local-first model.
- Normal local CLI use does not need a Control Plane token.
- `--remote` is the token-gated path and should be treated like any other remote device operation.
- `--json` emits structured JSONL events for machine consumers without exposing hidden reasoning.
- Numbat decisions are an additional restriction layer. They cannot grant a permission, suppress an approval, or weaken sandbox and network controls.
- Set `COWORK_CLI_DEBUG=1` when you need verbose local runtime diagnostics.

## Troubleshooting

If `cowork` reports missing CLI runtime output, run:

```bash
npm run build:cli
```

If `cowork run` prints `Missing token`, check whether `--remote` was passed or a remote alias is being used. Local one-shot tasks should run without a Control Plane token.

If the CLI cannot see providers already configured in the desktop app, confirm the same install/profile is being used and try:

```bash
COWORK_CLI_DEBUG=1 cowork run "who are you?"
```

If the hidden Electron runner is unavailable in a source checkout, build the app-entry artifacts:

```bash
npm run build:electron
npm run build:cli
```

See [Troubleshooting](troubleshooting.md#cowork-cli-issues) for failure-specific recovery steps.
