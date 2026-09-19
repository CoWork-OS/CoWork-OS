# Feishu / Lark User Guide

Feishu / Lark is best for organizations that use Lark or Feishu as their primary enterprise chat. It is a good fit for tenant-specific internal workflows and structured operational task intake.

## Best For

- Enterprise teams on Feishu or Lark.
- Internal task intake from approved spaces.
- Alert and operations workflows.
- Tenant-controlled deployments.
- Teams that need signed or encrypted webhook events.

## Key Features

- Feishu/Lark app credential integration.
- Bot and event subscription support.
- Secure webhook verification.
- Encrypted event handling.
- Gateway replies for tasks, approvals, and scheduled results.

## Daily Workflow

Use direct chats for private work and approvals. Use group chats for shared operational work:

```text
/new
Summarize today's production incidents and list owners for follow-up.
```

Use commands in busy groups so normal conversation does not become task input.

## Best Practices

- Use a dedicated app for the tenant or business unit.
- Keep bot access scoped to the spaces where CoWork should operate.
- Use command-first workflows in busy groups.
- Keep sensitive approvals in direct chats.
- Use scheduled summaries for recurring operational reporting.

## Watch-Outs

- Callback URLs, verification token, and encryption key must match the app configuration.
- **At least one of Encrypt Key or Verification Token is required.** The callback server
  will not start without one, and events lacking a valid signature or token are rejected.
  Both fields were previously optional; leaving them blank meant events were accepted
  unverified.
- Enterprise app permissions can affect event delivery.
- Broad tenant access can create unwanted task routing.

## Related Docs

- [Channel Integrations](../channels.md#feishu--lark)
- [Gateway User Guide](../gateway-user-guide.md)
