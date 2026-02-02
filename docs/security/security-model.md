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
|  [4-Layer Monotonic Deny-Wins System]                            |
|  [Tool Groups] [Blocked Patterns] [Approval Gates]               |
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

The policy manager implements a **monotonic deny-wins** system with four layers:

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
- **Network**: Allow web/browser access

### Layer 3: Context Restrictions

Based on message context (private/group/public):
- Memory tools denied in group contexts
- Clipboard access denied in shared contexts

### Layer 4: Tool-Specific Rules

Individual tool permissions and approval gates:
- Destructive tools require user approval
- Shell commands always require approval

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
| **Tool Results** | Injection patterns in web/file content annotated |
| **Memory Context** | Stored memories sanitized before injection |
| **Skill Guidelines** | Validated and filtered before system prompt injection |

### Defense Philosophy

These defenses are **transparent and non-blocking**:
- Suspicious patterns are logged and flagged, not rejected
- Security directives in the system prompt provide primary defense
- Monitoring enables detection and forensics without limiting capabilities
- The agent remains fully autonomous and capable
