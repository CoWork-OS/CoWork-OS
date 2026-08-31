# Security Guide for End Users

This document summarizes the security model, permissions, and considerations for users who clone and run CoWork OS on their machines. The maintained references are [Access Profiles](docs/access-profiles.md) and [Security Guide](docs/security-guide.md).

## Overview

CoWork OS is an AI-powered task automation tool that can execute actions on your behalf. By design, it has capabilities that require careful consideration:

- Execute command tools when the active access profile exposes them
- Read and write files
- Browse the web
- Connect to external APIs

All of these capabilities are governed by the task's [access profile](docs/access-profiles.md), layered approval rules, administrator policy, and hard guardrails; sandboxing is applied where the active backend can represent it.

---

## Permissions Model

### Access Profiles

Each task has an effective access profile. The composer offers **Ask for approval**, **Approve for me**, **Full access**, and validated **Custom** profiles. A profile combines:

- sandbox boundary
- approval and reviewer behavior
- command-tool availability
- network and domain scope
- filesystem roots and read/write/deny rules

The selected profile is the task-level authority. Workspace booleans and legacy `shellAccess` values remain only for older tasks and integrations; new tasks do not have a separate Shell enabled/disabled switch. See [Access Profiles](docs/access-profiles.md) for defaults, inheritance, migration, and fail-closed behavior.

### Approval System

Many sensitive operations require explicit user approval before execution, depending on the effective profile and policy:

- **Command tools**: You see the exact command before it runs when the profile/policy requires review
- **File deletion**: Confirmation required before removing files
- **External writes and data export**: Review is required for outbound mutations and file/image transfers
- **Location access**: One-time operating-system consent is always required

You can approve or deny each request individually. An approval cannot widen a finite profile scope or repair an unavailable profile.

### Configurable Guardrails

CoWork OS includes configurable guardrails in **Settings > Guardrails** to limit what the agent can do:

| Guardrail | Description | Default |
|-----------|-------------|---------|
| **Token Budget** | Max tokens (input + output) per task | 100,000 (enabled) |
| **Cost Budget** | Max estimated cost (USD) per task | $1.00 (disabled) |
| **Iteration Limit** | Max LLM calls per task | 50 (enabled) |
| **Dangerous Commands** | Block command tools matching dangerous patterns | Enabled |
| **File Size Limit** | Max file size the agent can write | 50 MB (enabled) |
| **Domain Rules** | Profile- and administrator-controlled destination allow/deny rules | Profile-controlled |

#### Dangerous Command Blocking

The following command patterns are blocked by default:

| Pattern | Risk |
|---------|------|
| `sudo` | Elevated privileges |
| `rm -rf /` or `rm -rf ~` | Mass deletion |
| `mkfs` | Filesystem formatting |
| `dd if=` | Direct disk writes |
| Fork bombs | Process exhaustion |
| `curl\|bash`, `wget\|sh` | Remote code execution |
| `chmod 777` | Overly permissive |
| `> /dev/sd` | Direct device writes |
| `:(){ :|:& };:` | Fork bomb syntax |

Commands are blocked **before** reaching the approval dialog. You can add custom patterns in Settings.

#### Domain Rules

When a profile contains positive domain rules, built-in browser and network tools are restricted to the specified destinations:

- Exact match: `github.com`
- Wildcard: `*.google.com` (matches subdomains, not the apex)
- `**.example.com` matches the apex and descendants
- Deny rules win over allow rules

Arbitrary subprocess networking is not domain-aware and fails closed when a profile requires domain-level enforcement without a domain-aware proxy.

---

## What the App Can Access

### File System Access

| Scope | Access Level |
|-------|--------------|
| Workspace directories | Read/Write according to the effective profile and workspace capabilities |
| Profile-declared roots | Access only under matching profile filesystem rules |
| Outside profile scope | **No access**; finite profile scopes cannot be widened by approval |
| Protected system files | **No mutation access** |

**Technical details**:
- Path traversal protection and profile path rules prevent access outside the effective scope
- **Symlink escape detection**: File tools resolve symlinks via `realpath()` and verify the resolved path remains within the workspace boundary. Symlinks that point outside the workspace are rejected before any read/write operation.
- Implementation: `src/electron/agent/tools/file-tools.ts`

### Workspace Kit Project Access Rules

If a workspace contains a `.cowork/projects/<projectId>/ACCESS.md` file, built-in tools enforce per-project access based on the task's assigned agent role:

- `## Allow` and `## Deny` sections accept agent role IDs (one per line prefixed with `-`).
- Use `all` to match every agent role.
- Deny wins over allow.

Enforcement applies to:
- File/edit/grep/search tools when the path is inside `.cowork/projects/<projectId>/...`
- Workspace-kit context injection (denied projects are excluded from injected context)

Important: project-role rules are one layer of policy. Command tools are exposed and sandboxed by the task's access profile, while project-role rules continue to govern project file and workspace-kit surfaces. Review command-tool approvals carefully, especially for broad profiles.

### Command-Tool Execution

When command tools are exposed by the active access profile:

| Aspect | Implementation |
|--------|----------------|
| Working directory | Restricted to the active workspace and profile-approved roots |
| Environment variables | Minimal set (PATH, HOME, USER, SHELL, LANG, TERM, TMPDIR) |
| API keys | **Never passed** to subprocesses |
| Timeout | Maximum 5 minutes |
| Output limit | 100KB (truncated if exceeded) |

**Security note**: Your API keys and secrets are never exposed to command tools. The app creates a minimal, safe environment for each command.

### Browser Automation

The app includes Playwright for web automation:

| Capability | Details |
|------------|---------|
| Navigate to URLs | Destinations allowed by the active profile, administrator network policy, and browser rules |
| Fill forms | As directed by task |
| Take screenshots | Saved to workspace |
| Execute JavaScript | Within page context only |
| Mode | Headless by default; visible workbench actions remain separately gated |

**User agent**: `CoWork OS Browser Automation`

---

## Network Connections

### LLM API Providers

The app connects to these services based on your configuration:

| Provider | Endpoint | When Used |
|----------|----------|-----------|
| Anthropic | `api.anthropic.com` | Claude models |
| AWS Bedrock | `bedrock-runtime.*.amazonaws.com` | Bedrock models |
| Google AI | `generativelanguage.googleapis.com` | Gemini models |
| OpenRouter | `openrouter.ai` | OpenRouter models |
| Ollama | `localhost:11434` (default) | Local models |

### Search Providers (DuckDuckGo built-in; others optional)

| Provider | Endpoint | When Used |
|----------|----------|-----------|
| DuckDuckGo | `html.duckduckgo.com` | Free built-in web search (no API key) |
| Tavily | `api.tavily.com` | Web search (API key required) |
| Brave Search | `api.search.brave.com` | Web search (API key required) |
| SerpAPI | `serpapi.com` | Web search (API key required) |
| Google Custom Search | `customsearch.googleapis.com` | Web search (API key required) |

### Other Connections

| Destination | Purpose |
|-------------|---------|
| `api.github.com` | Update checks |
| `api.telegram.org` | Telegram bot (if configured) |
| Discord API | Discord bot (if configured) |
| Signal (via signal-cli) | Signal bot (if configured, local process) |

### No Telemetry

CoWork OS does **not**:
- Send usage analytics
- Track user behavior
- Phone home to any server
- Share your data with third parties

Your data stays on your machine and only goes to the LLM provider you explicitly configure.

---

## Data Storage

### Encrypted Settings Storage (SecureSettingsRepository)

All settings are now stored encrypted in the database using the `SecureSettingsRepository`:

| Data | Location | Encryption |
|------|----------|------------|
| All Settings | `app.getPath('userData')/cowork-os.db` | OS Keychain + AES-256 |
| Database | `app.getPath('userData')/cowork-os.db` | Settings encrypted per-category |
| Machine ID | `app.getPath('userData')/.cowork-machine-id` | Stable identifier for encryption |

Typical `userData` locations:
- macOS: `~/Library/Application Support/cowork-os/`
- Linux: `~/.config/cowork-os/`
- Windows: `%APPDATA%\\cowork-os\\`

### Encryption Layers

**Primary: OS Keychain (when available)**
- macOS: Keychain Services
- Windows: DPAPI (Data Protection API)
- Linux: libsecret

**Fallback: App-Level Encryption**
- AES-256-GCM encryption
- Key derived via PBKDF2 (100,000 iterations, SHA-512)
- Stable machine ID prevents key changes on hostname updates

### Settings Categories

All these are stored encrypted in the database:

| Category | Contents |
|----------|----------|
| `voice` | Voice settings, TTS/STT API keys |
| `llm` | LLM provider settings, API keys |
| `search` | Search provider settings, API keys |
| `appearance` | Theme, accent color preferences |
| `personality` | Agent personality settings |
| `guardrails` | Safety limits and blocked patterns |
| `permissions` | Default access profile, custom profiles, and permission rules |
| `hooks` | Automation hooks configuration |
| `mcp` | MCP server configurations |
| `controlplane` | Control plane settings |
| `channels` | Channel/gateway configurations |
| `builtintools` | Built-in tool settings |
| `tailscale` | Tailscale integration settings |
| `queue` | Task queue settings |
| `tray` | Menu bar/tray settings |

### Data Integrity

Each stored setting includes:
- SHA-256 checksum for integrity verification
- Creation and update timestamps
- Automatic corruption detection on load

### What's Stored in the Database

- Workspace configurations
- Task history, events, and logs (including task prompts and timeline messages)
- Channel/gateway configurations
- Channel message history (incoming/outgoing message content for configured channels)
- **All encrypted settings** (API keys, preferences, configurations)

Everything is stored **locally** on your machine. CoWork OS does not upload your database or message history to any CoWork OS servers.

### API Key Security

Your API keys are:
1. Encrypted using OS Keychain when available (macOS Keychain, Windows DPAPI, Linux libsecret)
2. Fallback to AES-256 app-level encryption with stable machine-derived key
3. Decrypted only when needed for API calls
4. Never logged or displayed in full
5. Never passed to command tools or subprocesses
6. Checksummed for integrity verification

---

## Electron Security Configuration

### Security Settings

| Setting | Value | Purpose |
|---------|-------|---------|
| `nodeIntegration` | `false` | Prevents renderer from accessing Node.js |
| `contextIsolation` | `true` | Isolates preload scripts from page context |
| `sandbox` | Default | Uses Chromium sandbox |

### Content Security Policy (Production)

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: https:;
font-src 'self' data:;
connect-src 'self' https:;
frame-ancestors 'none';
form-action 'self';
```

### macOS Entitlements

| Entitlement | Purpose |
|-------------|---------|
| `allow-jit` | Required for V8 JavaScript engine |
| `allow-unsigned-executable-memory` | Required for Electron |
| `allow-dyld-environment-variables` | Loading native modules |
| `files.user-selected.read-write` | Access to user-selected folders |
| `network.client` | Connect to LLM APIs |

**Not requested automatically**: Camera, microphone, contacts, or other sensitive permissions. Location is requested only when a task explicitly uses the location tool and must be approved through the operating system.

---

## Messaging Channel Security

If you use the gateway feature to connect messaging bots (Telegram, Discord, Slack, WhatsApp, iMessage, Signal):

### Security Modes

| Mode | Description | Recommendation |
|------|-------------|----------------|
| **Open** | Anyone can use the bot | Not recommended for production |
| **Allowlist** | Only pre-approved user IDs | Good for known users |
| **Pairing** | Users must enter a code from the app | Best for security |

### Best Practices

1. **Use pairing mode** for bots accessible to others
2. **Generate new pairing codes** for each user
3. **Revoke access** for users who no longer need it
4. **Don't share bot tokens** publicly

---

## Auto-Update Mechanism

### How Updates Work

For **git clones** (development):
1. Checks GitHub API for new releases/commits
2. User initiates update manually
3. Runs: `git pull`, `npm run setup`, `npm run build`
4. Requires app restart

For **packaged builds**:
1. Uses electron-updater with GitHub releases
2. Downloads signed releases from official repo
3. Verifies integrity before installing

### Supply Chain Considerations

| Risk | Mitigation |
|------|------------|
| Malicious code in update | Updates are user-initiated, not automatic |
| Compromised dependencies | Dependencies from reputable sources only |
| npm install risks | Third-party lifecycle scripts disabled via `.npmrc`; `npm run setup` handles native rebuilds explicitly |

**Note**: If you're security-conscious, review changes before updating:
```bash
git fetch origin
git diff HEAD..origin/main
```

---

## Security Best Practices

### For General Use

1. **Review command-tool requests** before approving - read what will execute and where
2. **Use dedicated workspaces** - don't point at sensitive directories
3. **Choose the least-privileged access profile** - start with Ask for approval and use Custom or Full access only when justified
4. **Keep updated** - security fixes come through updates
5. **Protect your API keys** - don't share configuration files

### For Messaging Bots (Telegram/Discord/Slack/WhatsApp/iMessage/Signal)

1. **Never use "open" mode** for public bots
2. **Use pairing codes** for secure user onboarding
3. **Regularly audit** connected users
4. **Revoke access** when no longer needed
5. **For Signal**: Use a dedicated phone number (registration deactivates other Signal instances)

### For Development

1. **Review code changes** before pulling updates
2. **Audit dependencies** periodically with `npm audit`
3. **Don't commit** `.env` or settings files
4. **Use separate workspaces** for testing

---

## Threat Model

### What CoWork OS Protects Against

| Threat | Protection |
|--------|------------|
| Path traversal | Path normalization and validation |
| Symlink escape | `realpath()` resolution with workspace boundary check |
| Command injection | Profile-gated command tools, dangerous-pattern blocking, and approval where required |
| API key leakage | Encrypted storage, minimal env |
| XSS attacks | Content Security Policy |
| Unauthorized bot access | Multiple auth modes |
| Malicious skill IDs | Input validation and sanitization |
| Binary name injection | Shell metacharacter filtering |

### What Requires User Vigilance

| Risk | User Responsibility |
|------|---------------------|
| Approving malicious commands | Review before approving |
| Workspace selection | Don't add sensitive directories |
| Bot token security | Keep tokens private |
| Update verification | Review changes if concerned |

### Out of Scope

- Protection against malicious LLM responses (AI safety)
- Physical access to your machine
- Compromised macOS system
- Malicious code you add to workspaces

---

## Verifying Security

### Check Access Profiles And Workspace Permissions

In the app, open **Settings > System & Security > Permissions** to review:
- the default and selected access profile
- sandbox, approval/reviewer, command-tool, network, filesystem, and domain scope
- legacy workspace capability flags and workspace-local rules

New tasks do not have a separate Shell enabled/disabled switch. Existing tasks
may retain legacy fields until a profile is explicitly selected. See [Access
Profiles](docs/access-profiles.md).

### Audit Connected Users (Bots)

In the Gateway settings, you can:
- View all connected users
- Revoke access for specific users
- Generate new pairing codes

### Review Pending Approvals

The app shows a notification badge when approvals are pending. Always review:
- The exact command to be executed
- The file to be deleted
- Any other sensitive operation

---

## Reporting Security Issues

If you discover a security vulnerability:

1. **Do NOT** create a public GitHub issue
2. Use GitHub Security Advisories (Security tab > Report a vulnerability)
3. Include reproduction steps and impact assessment

See [SECURITY.md](SECURITY.md) for full details.

---

## Advanced Security Framework (v0.3.8.7+)

CoWork OS includes a comprehensive security framework inspired by formal verification techniques.

### Tool Groups & Risk Levels

Tools are categorized by risk level for policy-based access control:

| Risk Level | Tools | Description |
|------------|-------|-------------|
| **Read** | `read_file`, `list_directory`, `search_files` | Low risk, read-only operations |
| **Write** | `write_file`, `copy_file`, `create_directory` | Medium risk, creates/modifies files |
| **Destructive** | `delete_file`, `run_command` | High risk, exposed and approved according to the access profile and policy |
| **System** | `read_clipboard`, `take_screenshot`, `open_application` | System-level access |
| **Network** | `web_search`, `browser_*` | External network operations |

### Monotonic Policy Precedence (Deny-Wins)

Security policies are evaluated across multiple layers in order:

1. **Global Guardrails** - Blocked commands, patterns
2. **Access Profile** - Sandbox, approval, reviewer, command-tool, filesystem, network, and domain boundaries
3. **Legacy Workspace Permissions** - Compatibility capability flags
4. **Context Restrictions** - Gateway context (private/group/public)
5. **Tool-Specific Rules** - Per-tool overrides

**Key invariant**: Once denied by any layer, a tool cannot be re-enabled by later layers. This prevents policy bypasses.

### Context-Aware Tool Isolation

When tasks originate from gateway bots (WhatsApp/Telegram/Discord/Slack/iMessage/Signal), tools are restricted based on context:

| Context | Restrictions |
|---------|-------------|
| **Private** | Target access profile with no additional channel restriction |
| **Group** | Target profile plus memory-tool restrictions and any configured destructive-tool restrictions |
| **Public** | Target profile plus the strongest configured channel restrictions; system/destructive operations may be blocked |

This prevents accidental exposure of sensitive data in shared contexts.

### Concurrent Access Safety

Critical operations use mutex locks and idempotency guarantees to prevent race conditions:

| Operation | Protection |
|-----------|------------|
| Pairing code verification | Mutex per channel + idempotency check |
| Approval responses | Idempotency prevents double-approval |
| Task creation | Deduplication via idempotency keys |

### Brute-Force Protection

Pairing code verification includes protection against brute-force attacks:

| Feature | Value | Description |
|---------|-------|-------------|
| Max attempts | 5 | Failed attempts before lockout |
| Lockout duration | 15 minutes | Time before retry allowed |
| Code charset | 32 characters | Excludes ambiguous chars (I, O, 1, 0) |
| Code length | 6 characters | ~1 billion combinations |
| Estimated crack time | >1000 years | With lockout enabled |

When a user exceeds the maximum attempts:
1. Account is locked for 15 minutes
2. User sees remaining lockout time
3. Attempts counter resets after lockout expires

**Implementation**: `src/electron/gateway/security.ts`

### Command-Tool Sandboxing

When exposed by the task's access profile, macOS command tools execute within a generated `sandbox-exec` profile that:

- Restricts filesystem access to the workspace and profile-approved roots
- Applies the profile's coarse network posture
- Limits write access based on profile and workspace permissions
- Uses minimal, safe environment variables

Restricted profiles fail closed if no backend can represent their requested
boundary. Domain-scoped arbitrary-process egress is denied unless a
domain-aware proxy is available; built-in network tools apply domain rules
in-process.

**Implementation**: `src/electron/agent/sandbox/runner.ts`

### Skill Security

SkillHub includes multiple security measures to prevent attacks via malicious skills:

| Protection | Description |
|------------|-------------|
| **Skill ID Validation** | IDs must match `^[a-z0-9_-]+$` pattern (lowercase alphanumeric, hyphens, underscores) |
| **Path Traversal Prevention** | IDs containing `..`, `/`, or `\` are rejected |
| **Binary Name Sanitization** | Binary names in `requires.bins` must match `^[a-zA-Z0-9._-]+$` |
| **Command Injection Prevention** | Shell metacharacters in binary names are blocked before `which` execution |
| **Debounced Reloading** | Rapid skill reloads are debounced (100ms) to prevent race conditions |

**Rejected inputs (skill IDs)**:
- `../../../etc/passwd` - Path traversal
- `foo/bar` - Contains path separator
- `skill;rm -rf /` - Special characters

**Rejected inputs (binary names)**:
- `node; rm -rf /` - Shell metacharacters
- `$(whoami)` - Command substitution
- `` `whoami` `` - Backtick execution

**Implementation**:
- `src/electron/agent/skill-registry.ts` (skill ID validation)
- `src/electron/agent/skill-eligibility.ts` (binary name sanitization)

### Running Security Tests

```bash
npm run test                # Full suite (~4,583 passing tests; includes security)
npx vitest run tests/security   # Security-focused tests only (135 tests)
npm run test:coverage       # With coverage report
```

Test files:
- `tests/security/tool-groups.test.ts` - Tool categorization tests
- `tests/security/policy-manager.test.ts` - Policy evaluation tests
- `tests/security/concurrency.test.ts` - Mutex and idempotency tests
- `tests/security/sandbox-runner.test.ts` - Sandbox execution tests
- `tests/security/gateway-security.test.ts` - Brute-force protection tests

---

## Summary

CoWork OS is designed with security in mind:

| Aspect | Status |
|--------|--------|
| API key storage | Encrypted (OS keychain) |
| File access | Bounded by the selected access profile and workspace |
| Command execution | Exposed by the selected profile; sandboxed/approval-gated according to policy |
| Network access | Profile- and administrator-controlled; export-sensitive actions remain separately reviewed |
| Telemetry | None |
| Electron security | Best practices followed |
| Guardrails | Configurable limits on tokens, cost, iterations, commands, file size, and domains |
| Policy system | Monotonic deny-wins precedence |
| Gateway security | Context-aware tool isolation |
| Concurrency | Mutex locks + idempotency guarantees |
| Skill security | Input validation, path traversal protection, binary sanitization |

**The security model is transparent and profile-governed.** You remain in control of what the AI can do on your machine through the selected profile, approvals, administrator policy, and hard guardrails.

### Guardrails Settings Location

All guardrail settings can be configured at:
- **Database**: Stored encrypted in `app.getPath('userData')/cowork-os.db` (category: `guardrails`)
- **UI**: Settings (gear icon) → Guardrails tab

### Settings Migration

Legacy JSON settings files are automatically migrated to the encrypted database:
- Migration creates a `.migration-backup` file before proceeding
- On successful migration, both backup and original are deleted
- On failed migration, backup is preserved for recovery
- Migration logs are available in the app console
