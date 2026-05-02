# Security Model

CoWork OS implements a layered security model with multiple defense mechanisms.

## Architecture Overview

```
+------------------------------------------------------------------+
|                        User Interface                             |
+------------------------------------------------------------------+
|                    Channel Security Layer                         |
|  [Pairing Mode] [Allowlist Mode] [Open Mode]                     |
|  [Context Policies: DM vs Group]                                  |
+------------------------------------------------------------------+
|                    Policy Manager Layer                           |
|  [Layered Permission Engine]                                     |
|  [Tool Groups] [Blocked Patterns] [Mode Defaults] [Rule Sources] |
+------------------------------------------------------------------+
|                    Encrypted Storage Layer                        |
|  [OS Keychain] [AES-256 Fallback] [Integrity Checksums]          |
+------------------------------------------------------------------+
|                    Sandbox Layer                                  |
|  [macOS sandbox-exec] [Docker Containers] [Process Isolation]    |
+------------------------------------------------------------------+
|                    Filesystem Layer                               |
|  [Workspace Boundaries] [Protected Paths] [Allowed Paths]        |
+------------------------------------------------------------------+
```

## Channel Security

### Security Modes

CoWork OS supports three security modes for external channels (Telegram, Discord, etc.):

| Mode | Description | Use Case |
|------|-------------|----------|
| **Pairing** | Users must enter a 6-character code | Recommended for most cases |
| **Allowlist** | Only pre-approved user IDs allowed | Enterprise deployments |
| **Open** | Anyone can interact | Trusted private channels only |

### Context Policies

Different security settings can apply to DMs vs group chats:

- **DM (Direct Messages)**: Full capability by default
- **Group Chats**: Memory tools (clipboard) restricted by default

This treats group messages as higher risk than direct messages, where shared context could expose sensitive data.

## Policy Manager

The policy manager implements a **layered permission engine** with hard-stop precedence:

### Layer 1: Global Guardrails

Dangerous patterns that are always blocked:
- `sudo` - Privilege escalation
- `rm -rf /` - Destructive deletions
- `curl | bash` - Remote code execution
- Fork bombs, disk formatting commands

### Layer 2: Workspace Permissions

Per-workspace controls:
- **Read**: Allow reading files
- **Write**: Allow creating/modifying files
- **Delete**: Allow file deletion
- **Shell**: Allow command execution
- **Network**: Allow network-capable tools to run at all

These remain coarse capability gates. They do not replace explicit rules, workspace policy files, or
mode defaults. A workspace with `network: true` can still require approval for export-sensitive
requests, and a workspace with `network: false` blocks both ordinary web access and outbound export.

### Layer 3: Context Restrictions

Based on message context (private/group/public):
- Memory tools denied in group contexts
- Clipboard access denied in shared contexts

### Layer 4: Tool-Specific Rules

Individual tool permissions and approval decisions:
- Destructive tools usually prompt unless an explicit allow rule or mode applies
- Shell commands usually prompt unless an explicit allow rule or mode applies
- Domain-scoped rules can allow or deny `web_fetch` / `http_request` per destination
- Exact reasons and matched scopes are surfaced in the prompt when available

### Layer 5: Permission Modes And Fallback

The selected mode and the denial fallback tracker finalize the decision:

- `default`, `plan`, `accept_edits`, `dangerous_only`, `dont_ask`, and `bypass_permissions` define baseline behavior
- `dangerous_only` is the middle ground between `accept_edits` and full autonomy: it auto-allows safe reads, edits, and a conservative read/test shell subset, while still prompting for destructive actions, privacy-sensitive non-workspace access, MCP/external side effects, and ambiguous shell commands
- `dont_ask` and `bypass_permissions` no longer suppress `data_export` prompts
- soft denials can escalate to a direct prompt after repeated hits
- hard guardrails and explicit deny rules are never bypassed

## Outbound Data Movement

CoWork now models outbound transfer separately from generic network reads.

### Egress Classes

- `web_fetch` is a network read and stays in the `network_access` lane
- `http_request` stays in `network_access` only for plain `GET` or `HEAD` requests with no body and no custom headers
- mutating or payload-carrying `http_request` calls are classified as `data_export`
- `analyze_image` and `read_pdf_visual` are also classified as `data_export` because file bytes are sent to external model providers
- `parse_document` is the local document/PDF text extraction path. Uploaded PDF excerpts and parser results remain untrusted document data, but ordinary PDF text reading does not become `data_export` unless the task uses an outbound tool such as `read_pdf_visual`.

### Destination Controls

- workspace `network` permission is still the first gate
- allowed-domain guardrails still apply to raw web requests
- permission rules can now target a specific domain, optionally scoped to one tool

### Approval Context

When CoWork asks for approval on export-sensitive actions, the prompt can include:

- the target domain, method, or provider
- the direct file source being exported
- whether the task recently read untrusted imported content

Session-wide "Approve all" and high-autonomy permission modes do not silently allow this class of
action. Export stays fail-closed to an explicit prompt.

## Sandboxing

### macOS (Primary)

Uses native `sandbox-exec` with generated profiles:
- Deny-by-default policy
- Explicit allows for workspace and system paths
- Network isolation (localhost only by default)
- Mach service restrictions

### Docker (Cross-platform)

For Linux and Windows systems:
- Container isolation per command
- Volume mounts for workspace access
- CPU and memory limits
- Network mode: none (default) or bridge
- Read-only root filesystem

### Fallback

When sandboxing unavailable:
- Process isolation with timeout
- Output size limits
- Environment variable filtering

## Filesystem Protection

### Protected Paths

These paths can never be written to:
- `/System`, `/Library`, `/usr`, `/bin` (macOS)
- `C:\Windows`, `C:\Program Files` (Windows)

### Workspace Boundaries

By default, tools can only access:
1. The active workspace directory
2. Explicitly allowed paths in settings
3. Temporary directories

### Path Traversal Prevention

Multiple validation layers prevent `../` escape:
- Path normalization
- Relative path detection
- Workspace prefix checking

## Encrypted Settings Storage

All application settings are stored encrypted using `SecureSettingsRepository`:

### Encryption Hierarchy

```
+------------------------------------------+
|     OS Keychain (Primary)                |
|  macOS Keychain / Windows DPAPI / libsecret |
+------------------------------------------+
              |
              v (fallback when unavailable)
+------------------------------------------+
|     App-Level Encryption                 |
|  AES-256-GCM + PBKDF2 key derivation    |
+------------------------------------------+
```

### Features

| Feature | Description |
|---------|-------------|
| **Multi-layer encryption** | OS keychain preferred, AES-256 fallback |
| **Stable machine ID** | Survives hostname/user changes |
| **Integrity checks** | SHA-256 checksums per setting |
| **Safe migration** | Backups preserved on failure |
| **Health diagnostics** | Status APIs for debugging |

### Protected Categories

All sensitive settings including API keys, preferences, and configurations are stored encrypted:
- LLM provider settings and API keys
- Voice/TTS/STT configurations
- Search provider credentials
- Channel/gateway settings
- All user preferences

## Rate Limiting

| Operation | Limit |
|-----------|-------|
| LLM calls | 10/minute |
| Task creation | 10/minute |
| Settings changes | 5/minute |
| Standard operations | 60/minute |

## Brute-Force Protection

For pairing codes:
- Maximum 5 attempts
- 15-minute lockout after max attempts
- Automatic cleanup of expired codes

## Concurrency Safety

### Mutex Locks
- Pairing operations protected by named mutexes
- Prevents race conditions in verification

### Idempotency
- Approval operations tracked with idempotency keys
- Prevents double-processing of the same request

## Prompt Injection Defenses

CoWork OS implements multiple layers of defense against prompt injection attacks.

### System Prompt Hardening

The agent system prompt includes security directives that resist common attack vectors:

| Directive | Purpose |
|-----------|---------|
| **Confidentiality** | Prevents disclosure of system instructions in any format |
| **Output Integrity** | Resists behavioral modification (language changes, suffix injection) |
| **Code Review Safety** | Treats code comments as data, not instructions |
| **Autonomous Operation** | Resists response pattern manipulation |

### Input Sanitization (`InputSanitizer`)

Preprocesses all inputs to detect:
- **Encoded instructions**: Base64, ROT13, hex-encoded payloads
- **System impersonation**: `[SYSTEM]`, `[ADMIN OVERRIDE]`, mode activation attempts
- **Content injection**: Hidden instructions in documents, emails, HTML comments
- **Code injection**: `AI_INSTRUCTION:`, `ASSISTANT:` patterns in code

### Output Monitoring (`OutputFilter`)

Post-processes LLM responses to detect potential:
- **Canary compliance**: Verification strings like `ZEBRA_CONFIRMED_9X7K`
- **Format injection**: Word count suffixes, tracking codes
- **Prompt leakage**: System prompt section headers, YAML configuration

### Content Sanitization

| Source | Protection |
|--------|------------|
| **Tool Results** | Injection patterns in web/file content annotated; imported file reads can also carry an explicit untrusted-content banner |
| **Memory Context** | Stored memories sanitized before injection |
| **Skill Guidelines** | Validated and filtered before system prompt injection |
| **Imported Files / Attachments** | Provenance recorded so later export approvals can show what content recently entered from outside the workspace |

### Defense Philosophy

These defenses are layered rather than purely reactive:
- suspicious patterns are still logged and annotated instead of blindly discarded
- system-prompt hardening and sanitization still provide the first line of defense
- imported content is marked with provenance so the runtime can distinguish workspace-native data from externally supplied data
- outbound transfer from that content is no longer treated as just another network read; it routes through export-sensitive approval with destination and source hints

The result is intentionally asymmetric: reading rich external content stays easy, but moving local or
recently imported content outward now fails closed to a review step.
