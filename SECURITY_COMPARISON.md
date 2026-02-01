# Security Considerations for AI Assistants

When choosing a self-hosted AI assistant platform, security should be a primary concern. This document outlines key security considerations and how CoWork-OSS addresses them.

## Key Questions to Ask

### 1. How is the application isolated?

**Considerations:**
- Does it run in containers with elevated privileges?
- Can a compromised agent escape its sandbox?
- What filesystem access does it have?

**CoWork-OSS approach:**
- Native Electron app with workspace boundaries
- All file operations constrained to selected workspace folder
- Path traversal protection prevents escape attempts
- VM sandbox using macOS Virtualization.framework (planned)

### 2. How are messaging credentials stored?

**Considerations:**
- Are credentials stored in plain text?
- Who can access the credential storage?
- Are credentials encrypted at rest?

**CoWork-OSS approach:**
- OS keychain integration via Electron's `safeStorage`
- Credentials encrypted using the operating system's secure storage
- No plain text credential storage
- API keys never sent to external services (except the configured LLM provider)

### 3. What protection exists against unauthorized access?

**Considerations:**
- Can anyone message the bot and run commands?
- Is there brute-force protection?
- How are users authenticated?

**CoWork-OSS approach:**
- **Three security modes**: Pairing (code-based), Allowlist (pre-approved users), Open
- **Brute-force protection**: Lockout after 5 failed pairing attempts (15 minute cooldown)
- **Per-channel allowlists**: Control access at the user level for each messaging channel
- **Rate limiting**: IP-based rate limiting for API authentication attempts

### 4. Can the AI execute arbitrary commands?

**Considerations:**
- What prevents the AI from running dangerous commands?
- Is there human-in-the-loop approval?
- Can you define what's allowed and blocked?

**CoWork-OSS approach:**
- **Dangerous command blocking**: Built-in patterns block `sudo`, `rm -rf /`, `mkfs`, fork bombs, etc.
- **Custom patterns**: Add your own regex patterns to block specific commands
- **Approval workflows**: Shell commands require explicit user approval before execution
- **Auto-approve trusted commands**: Optionally skip approval for safe commands (e.g., `npm test`, `git status`)

### 5. Are there resource limits to prevent runaway tasks?

**Considerations:**
- Can a task consume unlimited tokens/cost?
- Can infinite loops exhaust resources?
- What happens if a task goes out of control?

**CoWork-OSS approach:**
- **Token budget**: Configure maximum tokens (1K - 10M) per task
- **Cost budget**: Set maximum estimated cost ($0.01 - $100) per task
- **Iteration limit**: Cap LLM calls (5 - 500) to prevent infinite loops
- **File size limit**: Restrict maximum file size the agent can write (1 - 500 MB)
- **Guardrails enforcement**: Tasks automatically stop when limits are exceeded

### 6. How is browser automation secured?

**Considerations:**
- Can the AI navigate to any website?
- What prevents malicious navigation?
- Are browser actions logged?

**CoWork-OSS approach:**
- **Domain allowlist**: Optionally restrict browser to approved domains only
- **Workspace isolation**: Downloaded files go to the workspace, not arbitrary locations
- **Action logging**: All browser actions logged in the task timeline

### 7. Is security systematically tested?

**Considerations:**
- Are there security-focused tests?
- Is the codebase auditable?
- How are vulnerabilities handled?

**CoWork-OSS approach:**
- **132 security unit tests** for access control and policy enforcement
- **259 WebSocket protocol tests** for API security
- **Monotonic policy precedence**: Deny-wins across all security layers
- **Open source**: Full codebase available for audit
- **Responsible disclosure**: Security advisory process for vulnerability reports

### 8. How is tool access controlled in shared environments?

**Considerations:**
- Can tools access sensitive data when accessed via messaging channels?
- Is there context-aware permission control?
- Are memory/clipboard tools available to remote users?

**CoWork-OSS approach:**
- **Context-aware tool isolation**: Memory and clipboard tools blocked in gateway (messaging) contexts
- **Risk-level categorization**: Tools categorized by risk level (read/write/destructive/system/network)
- **Gateway vs local context**: Different tool availability based on access method

---

## Security Feature Comparison

| Feature | Important For | CoWork-OSS |
|---------|---------------|------------|
| Workspace boundaries | Limiting file access | Yes |
| Path traversal protection | Preventing escape | Yes |
| Credential encryption | Protecting secrets | OS keychain |
| Pairing codes | Access control | Yes (with TTL) |
| Brute-force lockout | Preventing attacks | 5 attempts, 15 min |
| Allowlists | User authorization | Per-channel |
| Dangerous command blocking | Safety | Built-in + custom |
| Shell approval workflow | Human oversight | Yes |
| Token/cost budgets | Cost control | Configurable |
| Iteration limits | Loop prevention | Configurable |
| Domain allowlist | Browser safety | Optional |
| Security tests | Verification | 390+ tests |
| Open source | Auditability | MIT license |

---

## Best Practices

Regardless of which AI assistant platform you use, follow these practices:

1. **Start restrictive**: Begin with pairing mode and allowlists, not open access
2. **Use dedicated accounts**: Create dedicated accounts for messaging channels when possible
3. **Enable guardrails**: Set token and cost budgets appropriate for your use case
4. **Review approvals**: Always read what the agent wants to do before approving
5. **Use separate workspaces**: Don't point the AI at sensitive or production data
6. **Keep backups**: Ensure Time Machine or equivalent is running before using any AI automation
7. **Monitor activity**: Review the task timeline regularly to understand what the agent is doing
8. **Update regularly**: Keep the application updated for security patches

---

## Reporting Security Issues

If you discover a security vulnerability in CoWork-OSS:

1. **Do NOT** report via public GitHub issues
2. Use GitHub Security Advisories (preferred)
3. Or email: coworkoss@icloud.com

See [SECURITY.md](SECURITY.md) for full details on our security policy and response timeline.
