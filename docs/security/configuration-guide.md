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
| Destructive Tools | Delete, shell commands | Allowed (with approval) |

## Workspace Permissions

### Basic Permissions

Configure per workspace in **Settings > Workspaces**. These booleans are coarse capability gates;
the permission engine still evaluates explicit rules, guardrails, and mode defaults.

| Permission | Description | Default |
|------------|-------------|---------|
| Read | Read files | Yes |
| Write | Create/modify files | Yes |
| Delete | Delete files (usually approval-gated, unless a matching rule allows it) | No |
| Shell | Run shell commands (usually approval-gated, unless a matching rule allows it) | No |
| Network | Allow network-capable tools to run at all. Export-sensitive requests may still prompt, and domain guardrails/rules may still block specific destinations. | Yes |

### Allowed Paths

Add paths outside workspace that tools can access:

1. Go to **Settings > Workspaces > [Your Workspace]**
2. Click **Add Allowed Path**
3. Enter the path (e.g., `/Users/me/shared`)

### Unrestricted Mode

Enable broader file access for development:

1. Go to **Settings > Workspaces > [Your Workspace]**
2. Toggle **Unrestricted File Access**

**Warning:** Only use in trusted environments.

### Permission Rules

For explicit tool, domain, path, command-prefix, and MCP-server rules:

1. Open **Settings > System & Security**
2. Set the default permission mode if needed
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

Common mode choices:

- `default` - safe reads auto-run; writes, deletes, shell, data export, and external effects prompt
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

### Sandbox Type

Choose your sandbox implementation:

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
- [ ] Workspace permissions appropriate
- [ ] Guardrails configured
- [ ] Permission rules reviewed
- [ ] Sandbox type selected
- [ ] Test with a pairing code
