# Security Configuration Guide

This guide covers how to configure security settings in CoWork OS.

## Channel Security Modes

### Pairing Mode (Recommended)

Pairing mode requires users to enter a code to connect:

1. Go to **Settings > Channels > [Your Channel]**
2. Set **Security Mode** to "Pairing"
3. Click **Generate Pairing Code**
4. Share the 6-character code with the user
5. User sends the code as a message to pair

**Configuration:**
```
Security Mode: Pairing
Pairing Code TTL: 300 seconds (default)
Max Pairing Attempts: 5 (default)
```

### Allowlist Mode

Allowlist mode pre-approves specific users:

1. Go to **Settings > Channels > [Your Channel]**
2. Set **Security Mode** to "Allowlist"
3. Add user IDs to the **Allowed Users** list

**Finding User IDs:**
- Telegram: Use @userinfobot
- Discord: Enable Developer Mode, right-click user
- Slack: User profile > More > Copy member ID

### Open Mode (Use Carefully)

Open mode allows anyone to interact:

1. Go to **Settings > Channels > [Your Channel]**
2. Set **Security Mode** to "Open"

**When to use:**
- Private channels only you can access
- Testing environments
- Controlled internal deployments

## Context Policies

### Per-Context Security

Configure different settings for DMs vs groups:

1. Go to **Settings > Channels > [Your Channel] > Context Policies**
2. Select the **Direct Messages** or **Group Chats** tab
3. Configure:
   - Security mode per context
   - Tool restrictions per context

**Recommended Configuration:**

| Context | Security Mode | Tool Restrictions |
|---------|---------------|-------------------|
| DMs | Pairing | None |
| Groups | Pairing | Memory tools (clipboard) |

### Tool Restrictions

Restrict tool groups per context:

| Tool Group | Description | Default in Groups |
|------------|-------------|-------------------|
| Memory Tools | Clipboard read/write | Denied |
| System Tools | Screenshot, app launch | Allowed |
| Network Tools | Browser, web access | Allowed |
| Destructive Tools | Delete, command tools | Allowed (with approval and profile controls) |

## Channel Specialization Policy

For shared gateway spaces, channel specialization adds a routing and policy layer on top of context policies:

1. Go to **Settings > Channels > [Your Channel] > Channel Specialization**
2. Choose a whole-channel default, a specific chat/group, or a topic/thread ID when the channel supports it
3. Select the workspace and agent role for new tasks from that scope
4. Add prompt guidance only when it should apply to every new task from that scope
5. Apply tool restrictions for broad or semi-trusted groups
6. Enable shared context memory only when the participants and workflow are trusted

Specialization tool restrictions merge with context-policy restrictions using deny-first behavior. A channel specialization must not contain provider tokens, bot credentials, or connector secrets.

## Access Profiles and Workspace Permissions

[Access Profiles](../access-profiles.md) are the primary user-facing control for a task. Open
**Settings > System & Security > Permissions** to choose the default profile or define a custom
profile, then use the **Permission access mode** selector in the main composer for a particular
task. The built-in choices are **Ask for approval**, **Approve for me**, **Full access**, and
**Custom**.

A profile combines sandbox boundary, approval policy, reviewer policy, network posture, filesystem
roots/rules, and domain rules. Command tools derive their availability from the selected profile;
there is no separate shell enable/disable setting for a new task.

### Legacy workspace capability gates

Workspace booleans remain as compatibility and coarse capability data. They are not a second
modern profile selector. For a task with a named profile, the profile's effective command/network
and filesystem policy is applied before per-request rules. For an older unprofiled task, the legacy
fields continue to preserve its prior behavior.

| Permission | Description | Modern profile behavior |
|------------|-------------|-------------------------|
| Read | Read files | Still required by the effective profile |
| Write | Create/modify files | Still required; a read-only profile removes writes |
| Delete | Delete files | Separate destructive capability; a `write` profile rule never grants delete |
| `shell` | Legacy command-tool capability bit | Consulted for unprofiled legacy tasks; named profiles derive command access; not a new-task toggle |
| Network | Coarse network capability | The profile chooses disabled/on-request/enabled, subject to admin policy and export rules |

### Paths and unrestricted-file compatibility

For modern profiles, use `workspaceRoots` and `filesystemRules` in the profile editor. Rules are
deny-first, symlink-aware, and evaluated separately for read, write, and delete. A profile's finite
filesystem scope cannot be widened by an old allowed-path entry or a new one-shot approval.

The older workspace controls remain available for compatibility:

- **Allowed Paths** can add an external root for an unprofiled legacy task. A named profile must
  explicitly include any additional root it needs.
- **Unrestricted File Access** is a legacy broad-file flag. It does not override a named profile's
  finite roots, deny rules, protected operating-system paths, or unavailable-profile fail-closed
  state.

Do not use these legacy fields as a replacement for selecting a profile. See [Access Profiles](../access-profiles.md#filesystem-behavior)
for external-file approvals, path canonicalization, and protected roots.

### Permission Rules

For explicit tool, domain, path, command-prefix, and MCP-server rules:

1. Open **Settings > System & Security**
2. Set the default access profile. Set a legacy permission mode only when maintaining an older
   task or integration.
3. Add profile rules for global policy
4. Use the workspace-local rule list to review or remove rules for the active workspace

Available rule scopes:

| Scope | What it matches | Typical use |
|-------|------------------|-------------|
| `tool` | One tool name | Always ask or always allow a specific tool |
| `domain` | A destination hostname, optionally for one tool | Allow `web_fetch` or `http_request` only for `api.example.com` |
| `path` | Absolute path prefix, optionally for one tool | Allow a tool only under a shared folder |
| `command_prefix` | Normalized shell prefix | Auto-approve trusted read/test commands |
| `mcp_server` | One MCP backend | Narrow access to a specific connector/server |

Legacy permission-mode choices:

- `default` - safe reads auto-run; writes, deletes, command tools, data export, and external effects prompt
- `dangerous_only` - recommended when you want fewer interruptions without fully disabling review; safe reads/edits and conservative read/test shell commands auto-run, while risky or ambiguous actions still prompt
- `dont_ask` / `bypass_permissions` - high-autonomy modes for trusted environments only, but export-sensitive actions still require explicit approval

Workspace-local rules are stored in SQLite and mirrored to `.cowork/policy/permissions.json`.
Removing a workspace rule updates both storage locations when possible.

### Export-Sensitive Operations

The permission engine now distinguishes ordinary network reads from outbound data export.

- `web_fetch` is a normal network read
- `http_request` stays a normal network read only for simple `GET` or `HEAD` requests with no body and no custom headers
- mutating or payload-carrying `http_request` calls are treated as `data_export`
- `analyze_image` and `read_pdf_visual` are also treated as `data_export` because file bytes leave the local machine
- `parse_document` is the local PDF/document text extraction path. Uploaded PDF excerpts and parser output are untrusted document data, but ordinary PDF reading does not leave the local machine unless a later export-capable tool is used.

This means:

- enabling workspace `Network` does not automatically suppress approval for these export paths
- `dont_ask` and `bypass_permissions` still pause on `data_export`
- the session-level "Approve all" shortcut does not auto-approve export either

Practical examples:

- use a `domain` allow rule for `http_request` if a workspace should talk only to `api.example.com`
- keep `web_fetch` open to a docs domain while still requiring approval for raw API posts
- expect imports, drag-and-drop files, and channel attachments to show up as untrusted sources in later export prompts

## Sandbox Configuration

Access profiles choose the logical task boundary (`read-only`, `workspace-write`, or
`danger-full-access`). The setting below chooses the backend used to enforce that boundary. A
sandbox backend is not an alternative access profile, and selecting `None` does not remove hard
guardrails or profile rules.

### Sandbox Type

Choose the sandbox implementation for the effective profile:

| Type | Platforms | Features |
|------|-----------|----------|
| Auto | All | Best available for platform |
| macOS | macOS only | Native sandbox-exec |
| Docker | All | Container isolation |
| None | All | No isolation (not recommended) |

### Docker Configuration

If using Docker sandbox:

```
Image: node:20-alpine (default)
CPU Limit: 1 core (default)
Memory Limit: 512m (default)
Network Mode: none (default) or bridge
```

**Prerequisites:**
- Docker must be installed and running
- User must have permission to create containers

## Guardrails

### Command Blocking

Built-in blocked patterns:
- `sudo` - Privilege escalation
- `rm -rf /` - Destructive deletions
- `curl | bash` - Remote code execution

Add custom blocked patterns:
1. Go to **Settings > Guardrails**
2. Add patterns to **Custom Blocked Patterns**

### Trusted Commands

Trusted commands feed the permission engine as compatibility rules:
1. Go to **Settings > Guardrails**
2. Enable **Auto-approve Trusted Commands**
3. Default includes: npm/yarn test, git status, ls, etc.

The final decision still comes from the permission engine, so a trusted command can be overridden by
an explicit deny rule or a higher-priority hard restriction.

### Budget Limits

Set limits per task:
- **Max Tokens**: Limit API token usage
- **Max Cost**: Limit spending per task
- **Max Iterations**: Limit planning loops

## Rate Limiting

Rate limits are automatic and not configurable:

| Operation | Limit |
|-----------|-------|
| Expensive (LLM, search) | 10/minute |
| Standard | 60/minute |
| Settings changes | 5/minute |

## Audit Logging

All messages and actions are logged automatically:
- Location: `~/Library/Application Support/cowork-os/`
- Database: `cowork-os.db`
- Tables: `audit_log`, `channel_messages`

## Verification Checklist

After configuration, verify:

- [ ] Pairing mode enabled for external channels
- [ ] Context policies configured for groups
- [ ] Channel specializations reviewed for shared groups, channels, and threads
- [ ] Shared-memory opt-in enabled only for trusted specialized groups
- [ ] Default access profile selected and custom profiles reviewed
- [ ] Workspace permissions appropriate
- [ ] Guardrails configured
- [ ] Permission rules reviewed
- [ ] Sandbox type selected
- [ ] Test with a pairing code
