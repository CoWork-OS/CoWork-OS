---
name: legal-contract-negotiation-review
description: "Analyze counterparty contract changes against agreement/schedules, flag conflicts, and produce severity-rated counterpositions."
---

# Legal Contract Negotiation Review

## Purpose

Analyze counterparty contract changes against agreement/schedules, flag conflicts, and produce severity-rated counterpositions.

## Routing

- Use when: Use for contract markups, last-minute deal term demands, or clause-by-clause negotiation defense work.
- Do not use when: Do not use for pure legal research questions that do not require document comparison.
- Outputs: Clause matrix, severity-ranked recommendations, counter-language, and a written negotiation brief.
- Success criteria: Finds cross-document conflicts, produces actionable counterpositions, and writes the report artifact.

## Trigger Examples

### Positive

- Use the legal-contract-negotiation-review skill for this request.
- Help me with legal contract negotiation review.
- Use for contract markups, last-minute deal term demands, or clause-by-clause negotiation defense work.
- Legal Contract Negotiation Review: provide an actionable result.

### Negative

- Do not use for pure legal research questions that do not require document comparison.
- Do not use legal-contract-negotiation-review for unrelated requests.
- This request is outside legal contract negotiation review scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| agreement_path | string | No | Optional explicit path to the main agreement (DOCX/PDF/TXT) |
| disclosure_schedules_path | string | No | Optional explicit path to disclosure schedules or side letter |
| counterparty_changes_path | string | No | Optional explicit path to counterparty redline or demand letter |
| client_side | select | No | Which side you represent |
| output_report_path | string | No | Where to write the negotiation analysis markdown |
| output_docx_path | string | No | Optional path for a clean revised DOCX draft |

## Runtime Prompt

- Current runtime prompt length: 2482 characters.
- Runtime prompt is defined directly in `../legal-contract-negotiation-review.json`. 
