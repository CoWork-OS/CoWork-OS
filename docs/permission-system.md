# Permission System

CoWork OS now uses a layered permission engine instead of a single risk-only approval gate.
The goal is to make every tool decision explainable, persistent when needed, and reversible from
the UI.

## What The Engine Decides

Each tool request resolves to one of three outcomes:

- `allow` - execute immediately
- `deny` - block execution
- `ask` - prompt the user for approval

The decision includes:

- an exact reason code
- the matched rule or mode
- the scope that matched
- optional persistence targets for workspace or profile rules

## Evaluation Order

Permission evaluation runs in this order:

1. hard task restrictions and explicit task denylists
2. hard guardrails and dangerous-command blocks
3. coarse workspace capability gates
4. workspace policy script results
5. explicit permission rules
6. mode defaults
7. denial fallback escalation

Later stages never override earlier hard blocks.

## Rule Sources

Permission rules can come from several places:

- `session` - temporary grants and session-local rules stored in `SessionRuntime`
- `workspace_db` - workspace-local rules stored in SQLite
- `workspace_manifest` - checked-in workspace policy file at `.cowork/policy/permissions.json`
- `profile` - encrypted profile-level rules in secure settings
- `legacy_guardrails` - compatibility rules derived from older trusted-command patterns
- `legacy_builtin_settings` - compatibility rules derived from earlier settings models

When rules overlap, the more specific rule wins first. If specificity ties, the source priority is:

`session > workspace_db > workspace_manifest > profile > legacy_* > mode`

If source priority also ties, the effect priority is:

`deny > ask > allow`

## Scope Types

The engine supports four explicit rule scopes:

- `tool` - match a single tool by name
- `path` - match a tool and absolute path prefix
- `command_prefix` - match a normalized shell command prefix
- `mcp_server` - match a specific MCP server backend

Path scopes are normalized to absolute paths. Command prefixes are whitespace-normalized before
comparison. MCP server names are normalized for stable matching.

## Permission Modes

Default behavior depends on the selected permission mode:

- `default` - allow safe reads, ask on writes, deletes, shell, external services, and side-effecting MCP tools
- `plan` - allow read-only tools, deny mutating and external tools by default
- `accept_edits` - allow in-workspace file edits and reads, ask on deletes, shell, network side effects, and external services
- `dont_ask` - allow anything not hard-blocked or explicitly denied
- `bypass_permissions` - skip prompts and ask-rules, but still enforce hard guardrails, task restrictions, workspace capability gates, and explicit deny rules

## Core Automation Defaults

Always-on core automation does not rely on `bypass_permissions` by default.

Instead, core-created automated tasks inherit an autonomy policy that:

- disables interactive user-input pauses
- auto-approves common automation-safe actions such as `run_command`
- can also auto-approve `network_access` and `external_service` for trusted operator work
- still preserves hard guardrails, workspace capability denials, and explicit deny rules

This is the default posture for the Heartbeat/Subconscious core runtime because it keeps routine operator work flowing without turning the permission system off.

In other words:

- **core automation uses stronger allow rules**
- **it does not skip the permission engine entirely**

## Denial Fallback

Soft denials are not always the end of the story.

CoWork tracks denial counts per permission fingerprint in `SessionRuntime`:

- `3` consecutive soft denials trigger fallback escalation
- `20` total soft denials trigger fallback escalation

When a fingerprint crosses the threshold, the next evaluation can surface a direct prompt instead
of silently repeating the same denial path.

Hard denials from guardrails, workspace capability gates, and explicit deny rules are never
overridden by fallback.

## Persistence Destinations

Different rule sources persist in different places:

- session rules and temporary grants live in `SessionRuntime` snapshots
- workspace-local rules are stored in SQLite and mirrored to `.cowork/policy/permissions.json`
- profile rules are stored in encrypted secure settings

Workspace-local rule removal updates both the database row and the manifest mirror. If the
manifest write fails, the database removal still succeeds and the UI reports the partial state.

## User Surfaces

Users can manage permission state from two places:

- approval prompts, which can create one-shot or persisted rules
- Settings > System & Security, which manages default mode, profile rules, and workspace-local rules

The workspace-rule panel lets users browse and remove workspace-local rules directly without having
to wait for another approval prompt.

## Runtime Integration

`SessionRuntime` owns the session-local permission state and snapshot persistence.
`TaskExecutor` delegates permission decisions to the runtime and keeps only task bootstrap,
finalization, and UI projection responsibilities.

The always-on automation runtime layers on top of this by spawning tasks with explicit autonomy presets rather than depending on manual approval toggles.

## Related Docs

- [Core Automation](core-automation.md)
- [Security Guide](security-guide.md)
- [Architecture](architecture.md)
- [Session Runtime](session-runtime.md)
- [Features](features.md)
- [Changelog](changelog.md)
