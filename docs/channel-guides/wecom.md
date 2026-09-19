# WeCom User Guide

WeCom is best for enterprise teams that want CoWork inside a controlled corporate messaging environment.

## Best For

- Internal company workflows.
- Operations and alert channels.
- Approval routing in enterprise chat.
- Scheduled reports to controlled groups.
- Admin-managed access patterns.

## Key Features

- WeCom app integration.
- Corp ID, Agent ID, Secret, token, and EncodingAESKey based setup.
- The callback **token** is required: `msg_signature` is verified on every inbound
  callback, encrypted or not. Plaintext callbacks without a valid signature are rejected.
- Signed and encrypted event routing.
- Gateway task replies and scheduled result delivery.

## Daily Workflow

Use WeCom groups for defined workflows:

```text
/commands
/new
Prepare a short operations summary for today's incidents.
```

Use direct chats for approvals and sensitive questions.

## Best Practices

- Keep CoWork access limited to approved departments or groups.
- Use command-first interaction in shared groups.
- Prefer scheduled summaries for recurring operational reporting.
- Use DMs for sensitive task details and approvals.
- Review group membership before enabling broad task routing.

## Watch-Outs

- Corporate policy may affect message delivery.
- Credential rotation must be coordinated with CoWork settings.
- WeCom is better for structured internal workflows than casual ad hoc task intake.

## Related Docs

- [Channel Integrations](../channels.md#wecom)
- [Gateway User Guide](../gateway-user-guide.md)
