# Permission System

CoWork OS uses a layered permission engine instead of a single risk-only approval gate.
The current model separates coarse capability gates from export-sensitive approvals so ordinary
network reads, raw outbound requests, and provenance-aware prompts can be handled differently
without flattening everything into one approval bucket.

[Access Profiles](access-profiles.md) are the canonical task-level policy. They replace the need
for a separate shell enable/disable choice by carrying sandbox, approval, reviewer, network,
filesystem, and domain boundaries together.

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

The runtime first resolves and applies the task's access profile. Individual tool requests then run
through this order:

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

The engine supports five explicit rule scopes:

- `tool` - match a single tool by name
- `domain` - match a destination domain, optionally scoped to one tool such as `web_fetch` or `http_request`
- `path` - match a tool and absolute path prefix
- `command_prefix` - match a normalized shell command prefix
- `mcp_server` - match a specific MCP server backend

Domain names are normalized to lowercase hostnames. Path scopes are normalized to absolute paths.
Command prefixes are whitespace-normalized before comparison. MCP server names are normalized for
stable matching.

## Location Access

`get_current_location` uses a dedicated `location_access` approval type that is separate from
other tool scopes. Location access:

- always requires explicit one-time user consent via a dedicated dialog
- cannot be auto-approved by any permission mode, including `dont_ask` and `bypass_permissions`
- cannot be persisted as a session, workspace, or profile rule
- delegates the actual permission grant to the operating system's native location dialog

## Legacy Permission Modes

Older tasks and API callers may still supply a permission mode. It remains supported as a
compatibility input, but new task-level access should use [Access Profiles](access-profiles.md).
Default behavior depends on the selected legacy permission mode:

- `default` - allow safe reads, ask on writes, deletes, shell, data export, external services, and side-effecting MCP tools
- `plan` - allow read-only tools, deny mutating and external tools by default
- `accept_edits` - allow in-workspace file edits and reads, ask on deletes, shell, data export, network side effects, and external services
- `dangerous_only` - allow safe reads, in-workspace edits, and a conservative read/test shell allowlist; ask on deletes, browser/system/computer actions, `run_applescript`, data export, MCP tools, external side effects, and ambiguous shell commands
- `dont_ask` - allow anything not hard-blocked or explicitly denied, except `data_export`, which still prompts
- `bypass_permissions` - skip prompts and ask-rules for normal actions, but still enforce hard guardrails, task restrictions, workspace capability gates, explicit deny rules, and explicit `data_export` prompts

`dangerous_only` is intentionally conservative for command-tool access. Known read/test commands can run without a prompt, but composite shell expressions and commands with unclear side effects still pause for approval.

`dont_ask` and `bypass_permissions` are no longer wildcard escape hatches for outbound transfer.
If the request is classified as `data_export`, the engine switches back to an explicit approval.

## Access Profiles

The main composer exposes four access choices modeled on Codex's access selector. The complete
operator and developer contract is in [Access Profiles](access-profiles.md). The short version is:
an access profile combines the process sandbox boundary, approval behavior, reviewer behavior,
network boundary, and optional filesystem/domain scope. The reviewer can reduce friction, but it
cannot widen the sandbox or override an explicit deny rule.

| Access choice | Sandbox | Approval/reviewer | Network |
|---|---|---|---|
| **Ask for approval** | Workspace-write | On request / user | On request |
| **Approve for me** | Workspace-write | On request / automatic safety review | On request |
| **Full access** | Danger-full-access | No approval / no reviewer | Enabled |
| **Custom** | Named profile | Named profile | Named profile |

Custom profiles are saved in the encrypted permission settings store rather than a plain-text
`config.toml`. They can define sandbox, approval, reviewer, network, additional roots, filesystem
read/write/deny rules, and domain allow/deny rules. Command tools follow the selected profile mode;
there is no separate shell toggle. A legacy `shellAccess: false` value is retained only as a
backward-compatible deny for profiles saved by older versions. Deny rules are authoritative and
are applied before legacy workspace permissions. A custom profile that cannot be represented by a
backend fails closed instead of silently widening access.

Sandboxing and approval are separate enforcement boundaries. The sandbox limits what a spawned
process can reach; approval controls whether the action may proceed. macOS and Docker provide a
coarse network on/off boundary, so arbitrary shell or code execution with domain-scoped network
rules is denied unless a domain-aware proxy is available. Built-in network tools can still apply
their domain rules in-process. CoWork also keeps `delete` separate from `write` as an additional
destructive-operation gate, even though some sandbox systems group those filesystem operations.

The selected profile is carried through desktop task creation, follow-ups, the local CLI
(`cowork run --access-profile <id>`), remote Control Plane task creation, task resume, and child
task creation. Child tasks cannot select a profile that widens their parent's sandbox, approval,
network, or scoped-rule boundary. Existing tasks that only have a legacy `permissionMode` keep
that mode until the user explicitly selects an access profile.

If a named profile is missing, invalid, or cannot be represented by the active sandbox backend, the
runtime uses an unavailable read-only profile and pauses the task with an
`access_profile_unavailable` reason. No later rule, approval, or legacy mode can widen that state.

## Core Automation Defaults

Always-on core automation does not rely on `bypass_permissions` by default.

Instead, core-created automated tasks inherit an autonomy policy that:

- disables interactive user-input pauses
- seeds an explicit allowlist of automation-safe approval types instead of using a wildcard
- auto-approves `run_command` by default for deep-work style automation
- can also auto-approve `network_access` and `external_service` for trusted operator work when the task or operator policy opts in
- does not auto-approve `data_export`
- still preserves hard guardrails, workspace capability denials, and explicit deny rules

Core automation also remains beneath the task's effective access profile. Its auto-approval
allowlist can reduce interruption for permitted actions, but it cannot add command, filesystem,
network, or export capability that the profile or administrator policy removed.

This is the default posture for the Workflow Intelligence core runtime because it keeps routine operator work flowing without turning the permission system off.

In other words:

- **core automation uses stronger allow rules**
- **it does not skip the permission engine entirely**

An explicit empty `autoApproveTypes` list is also preserved as empty. CoWork no longer silently
falls back to "approve everything" when a policy intended to be narrow.

## Export-Sensitive Approvals

CoWork now treats outbound data movement as its own approval lane: `data_export`.

Requests enter that lane when a tool could send workspace or imported content to an external
service, even if the tool looks read-like from the user perspective.

Current examples:

- `http_request` with a mutating method or request payload is treated as `data_export`
- plain `http_request` only stays in `network_access` when it is a simple `GET` or `HEAD` with no body and no custom headers
- `analyze_image` is treated as export because image bytes are sent to an external vision model
- `read_pdf_visual` is treated as export because PDF page images are sent to an external vision model

Ordinary uploaded-PDF reading uses `parse_document`, which is a local read/extraction path. It is still subject to workspace file permissions and untrusted-content banners, but it is not the visual data-export path unless the task escalates to `read_pdf_visual` or another outbound tool.

By contrast, Chronicle's `screen_context_resolve` is a **local screen-context lookup**. It can read from the local passive Chronicle buffer and optionally capture a fresh local screenshot, but it does not itself export screenshot bytes to an external provider. If the task later sends an image to a provider through `analyze_image` or another export-sensitive path, that later step still enters the normal `data_export` approval lane.

This is separate from the coarse workspace `network` capability:

- `network: false` still blocks all network-capable and export-capable tools at the workspace boundary
- `network: true` only means those tools are eligible to run; export-sensitive requests may still pause for approval
- domain-scoped rules can narrow `web_fetch` and `http_request` to approved destinations without globally opening network egress

The session-level "Approve all" convenience toggle also stays narrow. It can auto-approve
`run_command` and `network_access`, but not `data_export`.

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
- the main composer access selector, which chooses an access profile for the next task or follow-up
- Settings > System & Security, which manages default profiles, custom profiles, profile rules, and workspace-local rules

The workspace-rule panel lets users browse and remove workspace-local rules directly without having
to wait for another approval prompt.

## Provenance-Aware Approval Context

Approval prompts now include security context when the action could move data outward.

The current flow is:

- imported files are recorded as `user_imported_external`
- drag-and-drop or clipboard-backed files are recorded as `clipboard_or_drag_data`
- gateway and channel attachments are recorded as `channel_attachment`
- reads from those files prepend an explicit untrusted-content banner
- the task runtime tracks recent sensitive or untrusted sources read during the session
- export approvals surface the destination plus the direct source and recent-read hints when available

This keeps rich features intact, but makes it much harder for hidden instructions in imported
content to silently trigger an outbound action.

## Runtime Integration

`SessionRuntime` owns the session-local permission state and snapshot persistence.
`TaskExecutor` delegates permission decisions to the runtime and keeps only task bootstrap,
finalization, and UI projection responsibilities.

The always-on automation runtime layers on top of this by spawning tasks with explicit autonomy presets rather than depending on manual approval toggles.

## Related Docs

- [Core Automation](core-automation.md)
- [Security Model](security/security-model.md)
- [Security Configuration](security/configuration-guide.md)
- [Security Guide](security-guide.md)
- [Access Profiles](access-profiles.md)
- [Architecture](architecture.md)
- [Session Runtime](session-runtime.md)
- [Features](features.md)
- [Changelog](changelog.md)
