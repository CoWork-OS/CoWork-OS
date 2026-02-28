---
name: usecase-transaction-scan
description: "Scan recent messages/emails for card transactions and flag suspicious charges."
---

# Transaction Scan

## Purpose

Scan recent messages/emails for card transactions and flag suspicious charges.

## Routing

- Use when: Use when the user asks to scan recent messages/emails for card transactions and flag suspicious charges.
- Do not use when: Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Outputs: Outcome from Transaction Scan: task-specific result plus concrete action notes.
- Success criteria: Returns concrete actions and decisions matching the requested task, with no fabricated tool-side behavior.

## Trigger Examples

### Positive

- Use the usecase-transaction-scan skill for this request.
- Help me with transaction scan.
- Use when the user asks to scan recent messages/emails for card transactions and flag suspicious charges.
- Transaction Scan: provide an actionable result.

### Negative

- Do not use when the request is asking for planning documents, high-level strategy, or non-executable discussion; use the relevant planning or design workflow instead.
- Do not use usecase-transaction-scan for unrelated requests.
- This request is outside transaction scan scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| channel | select | Yes | Where transaction alerts arrive |
| chat_hint | string | No | Issuer/merchant keyword to identify the feed (e.g., "Amex", "Wise", "Chase") |
| since | string | No | Time window (e.g., "24h", "7d") |
| message_limit | number | No | How many messages to fetch |
| amount_threshold | number | No | Flag transactions at or above this amount |

## Runtime Prompt

- Current runtime prompt length: 1202 characters.
- Runtime prompt is defined directly in `../usecase-transaction-scan.json`. 
