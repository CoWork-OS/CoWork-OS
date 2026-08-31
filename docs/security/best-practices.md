# Security Best Practices

Recommended security practices for CoWork OS deployments.

## Initial Setup

### 1. Use Pairing Mode by Default

Always start with pairing mode for external channels:
- Most secure option
- Users must prove access to desktop app
- Prevents unauthorized access

### 2. Use Dedicated Bot Accounts

Create separate bot accounts for CoWork OS:
- Don't use personal accounts
- Easier to audit and revoke
- Limits blast radius if compromised

### 3. Enable All Guardrails

Keep all guardrails enabled:
- Command blocking prevents dangerous operations
- Budget limits prevent runaway costs
- Iteration limits prevent infinite loops

### 4. Choose and review an access profile

Start with the least-privileged profile that fits the task:
- use **Ask for approval** for new or sensitive workflows
- use **Approve for me** only when automatic review is appropriate for bounded work
- use **Full access** only for a trusted task that genuinely needs unrestricted local access
- use a **Custom** profile for repeatable filesystem or domain boundaries
- review profile rules and administrator constraints periodically

Command tools are derived from the profile. There is no separate new-task shell
enable/disable switch. See [Access Profiles](../access-profiles.md) for the
profile fields, inheritance ceiling, migration behavior, and fail-closed rules.

### 5. Keep Group Memory Explicit

For shared chats and public channels:
- Leave shared context memory disabled unless the group is trusted
- Use channel specialization tool restrictions for shared groups that need narrower access
- Prefer deny-first restrictions for memory, system, network, or destructive tool groups when a channel has broad membership

## Ongoing Operations

### 1. Review Approval Requests

Always review approval requests carefully:
- Read the full command/action
- Verify it matches your intent
- Deny suspicious requests

### 2. Monitor Task Activity

Regularly check:
- Active tasks and their status
- Completed tasks and results
- Any unusual patterns

### 3. Audit User Access

Periodically review:
- Who has paired/allowlisted access
- Remove users who no longer need access
- Rotate pairing codes if shared widely

### 4. Keep CoWork OS Updated

Install updates promptly:
- Security fixes
- New features
- Bug fixes

## Channel-Specific Recommendations

### Telegram

- Use pairing mode
- Consider group restrictions
- Monitor bot commands usage

### Discord

- Use application ID verification
- Limit to specific guilds
- Consider server-specific bots

### Slack

- Use signing secret validation
- Restrict to specific workspaces
- Use app-level tokens

### WhatsApp

- Use pairing mode only
- Be cautious with group access
- Consider business API for production

### Microsoft Teams

- Use Azure Bot with proper tenant configuration
- Keep App Password rotated regularly
- Use pairing mode for multi-tenant deployments
- Monitor webhook endpoint access logs

### Google Chat

- Use dedicated service account with minimal permissions
- Restrict to specific Google Workspace organizations
- Review Chat API quotas and rate limits
- Use pairing mode for space-level access control

### iMessage (macOS)

- Only available on macOS with Messages app signed in
- Use pairing mode for external users
- Consider contact allowlist for stricter control
- Monitor imsg CLI access

### Signal

- E2E encrypted - messages are secure in transit
- Use trust-on-first-use (TOFU) carefully
- Keep signal-cli data directory secure
- Use pairing mode for unknown contacts

### Mattermost

- Use personal access token with minimal permissions
- Restrict to specific teams/channels
- Use pairing mode for external users
- Monitor WebSocket connection health

### Matrix

- Verify homeserver security practices
- Consider E2E encryption for sensitive rooms
- Use access token rotation
- Monitor room memberships

### Twitch

- Use OAuth tokens with minimal scopes
- Restrict to channels you moderate
- Disable whispers unless needed
- Monitor chat activity for abuse

### LINE

- Protect Channel Secret and Access Token
- Use webhook signature verification
- Monitor webhook server logs
- Consider rate limiting for high-traffic channels

### BlueBubbles (macOS)

- Secure BlueBubbles server with strong password
- Use local network only if possible
- Use pairing mode for unknown contacts
- Keep BlueBubbles server updated

### Email

- Use app passwords, not main account password
- Consider dedicated email account for bot
- Use subject line filtering to limit access
- Monitor for phishing attempts in responses

## Environment Recommendations

### Development

- **Ask for approval** is the recommended development default
- **Full access** is acceptable only for a deliberately trusted local task
- Keep filesystem and domain scope narrow while testing new skills/connectors
- Enable debug logging

### Production

- Use pairing or allowlist mode
- Use **Ask for approval** or a reviewed **Custom** profile
- Restrict file access to the workspace and explicitly approved roots
- Disable debug logging
- Enable all guardrails

### Shared Environments

- Use context policies to restrict groups
- Block memory tools in shared contexts
- Review channel specializations for each shared group or channel
- Enable shared context memory only for trusted specialized groups
- Consider Docker sandboxing

## FAQ

### Can different groups route to different workspaces or agents?

Yes. Use channel specialization in channel settings to bind a channel, chat/group, or topic/thread to a workspace, agent role, prompt guidance, tool restrictions, and optional shared-memory policy. Keep group memory disabled unless the participants and use case are trusted.

## Incident Response

### 1. How to Revoke Access

To immediately revoke a user's access:
1. Go to **Settings > Channels > [Channel] > Users**
2. Find the user
3. Click **Revoke Access**

Or remove from allowlist in channel settings.

### 2. How to Stop a Runaway Task

If a task is misbehaving:
1. Click the task in the UI
2. Click **Cancel Task**
3. Or use the task manager to force-stop

### 3. How to Reset Security

If you suspect compromise:
1. Revoke all channel users
2. Generate new pairing codes
3. Review audit logs
4. Update any leaked credentials

### 4. How to Report Vulnerabilities

If you find a security issue:
1. Do not disclose publicly
2. Email info@coworkosapp.com
3. Include:
   - Description of the issue
   - Steps to reproduce
   - Potential impact
   - Your contact info

## FAQ

### Q: Is my data sent to external servers?

Only to the configured LLM provider (Anthropic/AWS Bedrock). No data is sent to CoWork OS servers.

### Q: Are my API keys stored securely?

API keys are stored locally and encrypted (OS keychain when available, with AES-256 fallback). Keys are decrypted only when needed for API calls and are never passed to shell commands or subprocesses.

### Q: Can other users see my clipboard?

Clipboard tools are blocked by default in group contexts. In DM contexts, only you and the bot can access clipboard content.

### Q: What happens if Docker isn't available?

On macOS, native sandbox-exec is preferred. On other platforms, a restricted
profile fails closed if the configured backend cannot enforce its boundary;
CoWork does not silently turn an unavailable sandbox into unrestricted command
execution. Check the active profile and sandbox backend in the task details.

### Q: How long are pairing codes valid?

Default: 5 minutes (300 seconds). Configurable in channel settings.

### Q: Can I use multiple security modes?

Yes, context policies allow different modes for DMs vs groups on the same channel.

### Q: Are command-tool calls logged?

Yes, command-tool calls and their outputs are recorded in the task audit trail,
subject to normal redaction and output-size limits.

### Q: Can I disable the approval requirement for command tools?

Choose **Full access** when a trusted task intentionally needs the no-approval
profile. **Approve for me** uses automatic review for eligible requests. Hard
guardrails, administrator policy, explicit denies, export consent, and other
non-bypassable boundaries still apply; there is no separate shell switch.

## Security Checklist

### Before First Use

- [ ] Updated to latest version
- [ ] Reviewed default settings
- [ ] Selected and reviewed the default access profile
- [ ] Configured filesystem/domain scope and workspace compatibility gates
- [ ] Tested pairing flow

### Before Adding External Channels

- [ ] Security mode selected (pairing recommended)
- [ ] Context policies configured
- [ ] Test with limited users first
- [ ] Document who has access

### Regular Maintenance

- [ ] Check for updates
- [ ] Review user access list
- [ ] Check audit logs
- [ ] Test recovery procedures
