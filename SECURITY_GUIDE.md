# Security Guide for End Users

This document explains the security model, permissions, and considerations for users who clone and run CoWork-OSS on their machines.

## Overview

CoWork-OSS is an AI-powered task automation tool that can execute actions on your behalf. By design, it has capabilities that require careful consideration:

- Execute shell commands
- Read and write files
- Browse the web
- Connect to external APIs

All of these capabilities are **consent-based** and **sandboxed** where possible.

---

## Permissions Model

### Workspace Permissions

Each workspace you create has configurable permissions:

| Permission | Description | Default |
|------------|-------------|---------|
| **Read** | Read files within the workspace | Enabled |
| **Write** | Create and modify files | Enabled |
| **Delete** | Remove files (requires approval) | Disabled |
| **Shell** | Execute shell commands (requires approval) | Disabled |

**Recommendation**: Only enable shell and delete permissions for workspaces where you trust the AI to perform those operations.

### Approval System

Certain operations always require explicit user approval before execution:

- **Shell commands**: You see the exact command before it runs
- **File deletion**: Confirmation required before removing files
- **Sensitive operations**: Any action flagged as potentially destructive

You can approve or deny each request individually.

### Configurable Guardrails

CoWork-OSS includes configurable guardrails in **Settings > Guardrails** to limit what the agent can do:

| Guardrail | Description | Default |
|-----------|-------------|---------|
| **Token Budget** | Max tokens (input + output) per task | 100,000 (enabled) |
| **Cost Budget** | Max estimated cost (USD) per task | $1.00 (disabled) |
| **Iteration Limit** | Max LLM calls per task | 50 (enabled) |
| **Dangerous Commands** | Block shell commands matching patterns | Enabled |
| **File Size Limit** | Max file size the agent can write | 50 MB (enabled) |
| **Domain Allowlist** | Restrict browser to approved domains | Disabled |

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

#### Domain Allowlist

When enabled, browser automation is restricted to specified domains:

- Exact match: `github.com`
- Wildcard: `*.google.com` (matches subdomains)
- If enabled with no domains: all navigation blocked

This prevents unintended browsing during automation tasks.

---

## What the App Can Access

### File System Access

| Scope | Access Level |
|-------|--------------|
| Workspace directories | Read/Write (based on permissions) |
| Outside workspace | **No access** - path traversal is blocked |
| System files | **No access** |

**Technical details**:
- Path traversal protection prevents accessing files outside the workspace
- Symlink attacks are mitigated through path normalization
- Implementation: `src/electron/agent/tools/file-tools.ts`

### Shell Command Execution

When you enable shell permissions:

| Aspect | Implementation |
|--------|----------------|
| Working directory | Restricted to workspace folder |
| Environment variables | Minimal set (PATH, HOME, USER, SHELL, LANG, TERM, TMPDIR) |
| API keys | **Never passed** to subprocesses |
| Timeout | Maximum 5 minutes |
| Output limit | 100KB (truncated if exceeded) |

**Security note**: Your API keys and secrets are never exposed to shell commands. The app creates a minimal, safe environment for each command.

### Browser Automation

The app includes Playwright for web automation:

| Capability | Details |
|------------|---------|
| Navigate to URLs | Any URL (user-controlled tasks) |
| Fill forms | As directed by task |
| Take screenshots | Saved to workspace |
| Execute JavaScript | Within page context only |
| Mode | Headless by default |

**User agent**: `CoWork-OSS Browser Automation`

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

### Search Providers (Optional)

| Provider | Endpoint | When Used |
|----------|----------|-----------|
| Tavily | `api.tavily.com` | Web search |
| Brave Search | `api.search.brave.com` | Web search |
| SerpAPI | `serpapi.com` | Web search |
| Google Custom Search | `customsearch.googleapis.com` | Web search |

### Other Connections

| Destination | Purpose |
|-------------|---------|
| `api.github.com` | Update checks |
| `api.telegram.org` | Telegram bot (if configured) |
| Discord API | Discord bot (if configured) |

### No Telemetry

CoWork-OSS does **not**:
- Send usage analytics
- Track user behavior
- Phone home to any server
- Share your data with third parties

Your data stays on your machine and only goes to the LLM provider you explicitly configure.

---

## Data Storage

### Local Storage Locations

| Data | Location | Encryption |
|------|----------|------------|
| API Keys | OS Keychain via Electron safeStorage | AES-256 |
| Database | `~/.config/CoWork-OSS/cowork-oss.db` | None (local only) |
| LLM Settings | `~/.config/CoWork-OSS/llm-settings.json` | Keys encrypted |
| Search Settings | `~/.config/CoWork-OSS/search-settings.json` | Keys encrypted |

### What's Stored in the Database

- Workspace configurations
- Task history and logs
- Channel/gateway configurations
- No conversation content is permanently stored

### API Key Security

Your API keys are:
1. Encrypted using the macOS Keychain (via Electron's safeStorage)
2. Decrypted only when needed for API calls
3. Never logged or displayed in full
4. Never passed to shell commands or subprocesses

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

**Not requested**: Camera, microphone, contacts, location, or other sensitive permissions.

---

## Telegram/Discord Bot Security

If you use the gateway feature to connect Telegram or Discord bots:

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
3. Runs: `git pull`, `npm install`, `npm run build`
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
| npm install risks | postinstall only rebuilds better-sqlite3 |

**Note**: If you're security-conscious, review changes before updating:
```bash
git fetch origin
git diff HEAD..origin/main
```

---

## Security Best Practices

### For General Use

1. **Review shell commands** before approving - read what will execute
2. **Use dedicated workspaces** - don't point at sensitive directories
3. **Enable minimal permissions** - only enable what you need
4. **Keep updated** - security fixes come through updates
5. **Protect your API keys** - don't share configuration files

### For Telegram/Discord Bots

1. **Never use "open" mode** for public bots
2. **Use pairing codes** for secure user onboarding
3. **Regularly audit** connected users
4. **Revoke access** when no longer needed

### For Development

1. **Review code changes** before pulling updates
2. **Audit dependencies** periodically with `npm audit`
3. **Don't commit** `.env` or settings files
4. **Use separate workspaces** for testing

---

## Threat Model

### What CoWork-OSS Protects Against

| Threat | Protection |
|--------|------------|
| Path traversal | Path normalization and validation |
| Command injection | User approval required |
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

### Check Workspace Permissions

In the app, navigate to your workspace settings to review:
- Read/Write/Delete/Shell permissions
- Workspace path scope

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

CoWork-OSS includes a comprehensive security framework inspired by formal verification techniques.

### Tool Groups & Risk Levels

Tools are categorized by risk level for policy-based access control:

| Risk Level | Tools | Description |
|------------|-------|-------------|
| **Read** | `read_file`, `list_directory`, `search_files` | Low risk, read-only operations |
| **Write** | `write_file`, `copy_file`, `create_directory` | Medium risk, creates/modifies files |
| **Destructive** | `delete_file`, `run_command` | High risk, always requires approval |
| **System** | `read_clipboard`, `take_screenshot`, `open_application` | System-level access |
| **Network** | `web_search`, `browser_*` | External network operations |

### Monotonic Policy Precedence (Deny-Wins)

Security policies are evaluated across multiple layers in order:

1. **Global Guardrails** - Blocked commands, patterns
2. **Workspace Permissions** - Read, write, delete, shell, network flags
3. **Context Restrictions** - Gateway context (private/group/public)
4. **Tool-Specific Rules** - Per-tool overrides

**Key invariant**: Once denied by any layer, a tool cannot be re-enabled by later layers. This prevents policy bypasses.

### Context-Aware Tool Isolation

When tasks originate from gateway bots (WhatsApp/Telegram/Discord/Slack), tools are restricted based on context:

| Context | Restrictions |
|---------|-------------|
| **Private** | Full access (with approvals) |
| **Group** | Memory tools blocked (clipboard), destructive tools blocked |
| **Public** | System tools blocked, all destructive operations blocked |

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

### Shell Command Sandboxing

On macOS, shell commands execute within a `sandbox-exec` profile that:

- Restricts filesystem access to workspace + temp directories
- Blocks network access unless workspace has `network` permission
- Limits write access based on workspace permissions
- Uses minimal, safe environment variables

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
npm test                    # Run all 132 security tests
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

CoWork-OSS is designed with security in mind:

| Aspect | Status |
|--------|--------|
| API key storage | Encrypted (OS keychain) |
| File access | Sandboxed to workspace |
| Shell execution | Requires approval + sandbox |
| Network access | Only configured providers |
| Telemetry | None |
| Electron security | Best practices followed |
| Guardrails | Configurable limits on tokens, cost, iterations, commands, file size, and domains |
| Policy system | Monotonic deny-wins precedence |
| Gateway security | Context-aware tool isolation |
| Concurrency | Mutex locks + idempotency guarantees |
| Skill security | Input validation, path traversal protection, binary sanitization |

**The security model is transparent and consent-based.** You remain in control of what the AI can do on your machine.

### Guardrails Settings Location

All guardrail settings can be configured at:
- **Settings file**: `~/.config/CoWork-OSS/guardrail-settings.json`
- **UI**: Settings (gear icon) → Guardrails tab
