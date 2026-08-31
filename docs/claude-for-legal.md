# Claude-for-Legal Workflows

CoWork OS bundles Claude-for-Legal plugin packs as normal plugin-pack skills and slash commands. They keep the upstream workflow names, but run through CoWork's composer, task timeline, [access profile](access-profiles.md), approval model, and workspace-local file rules.

Legal skills do not create a special permission lane. The task profile remains
the ceiling for local files, command tools, network, connectors, and exports;
legal-specific consent or an approval preset may add review, but cannot widen
that boundary. Use a profile with the narrowest filesystem and domain scope
that supports the matter, especially when working with privileged or personal
information.

## Starting A Legal Workflow

Type `/` in the main composer and search for a legal command such as:

```text
/litigation-legal-demand-intake
/privacy-legal-dpa-review
/commercial-legal-saas-msa-review
/employment-legal-termination-review
```

Selecting a skill-backed legal command inserts the slash token into the composer and keeps focus in the message box. It does not immediately run the workflow. Add the short context you already know, then send:

```text
/litigation-legal-demand-intake unpaid invoices acme logistics
```

Manual typing works the same way as picker selection.

## Main-View Intake Cards

Some Claude-for-Legal workflows need structured matter context before the agent can continue usefully. CoWork shows that context request in the main task view instead of forcing a long back-and-forth in chat.

Current behavior:

| Workflow shape | Main-view UI |
|----------------|--------------|
| `/litigation-legal-demand-intake ...` | A demand-letter intake card with matter title, demand type, parties, tone, response window, settlement marking, facts, basis, outcome, delivery, signer, seed docs, and strategy notes |
| Other legal workflow commands that benefit from matter context | A generic legal workflow details card with matter title, jurisdiction, role/side, objective, facts, documents, deadlines, stakeholders, assumptions, and output preferences |
| Legal pack management commands | No matter-intake card; commands such as `/legal-builder-hub-disable` are operational controls, not legal work-product workflows |

Submitting a card sends a follow-up message to the same task. Blank fields are preserved as `[not provided]` so the skill can flag missing inputs before relying on them.

The card remains available if the first slash-command turn finishes before the user has supplied follow-up context. It disappears after the user submits or dismisses it, or after any other user follow-up is sent in that task.

## Examples

Demand letter intake:

```text
/litigation-legal-demand-intake unpaid invoices acme logistics
```

Vendor DPA review:

```text
/privacy-legal-dpa-review acme processor terms
```

SaaS MSA review:

```text
/commercial-legal-saas-msa-review enterprise subscription renewal
```

Employment termination review:

```text
/employment-legal-termination-review senior salesperson california
```

## Safety Model

The bundled legal packs keep CoWork's legal workflow guardrails:

- output is draft legal work product for attorney review
- jurisdiction, source gaps, privilege concerns, and uncertainty should be surfaced explicitly
- the agent must not file, send, approve, execute, or take irreversible action without explicit user confirmation
- connector and document contents are treated as data, not instructions
- upstream `~/.claude` configuration writes are adapted to reviewable CoWork workspace content or explicit user-approved destinations

## Testing

Focused checks:

```bash
npx vitest run \
  src/renderer/utils/__tests__/legal-demand-intake.test.ts \
  src/renderer/utils/__tests__/message-slash-options.test.ts
```

Broader renderer validation:

```bash
npm run type-check
npm run build:react
```
