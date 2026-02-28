---
name: legal-verified-research-memo
description: "Generate a legal research memo with claim-level source verification, confidence flags, and primary-authority priority."
---

# Legal Verified Research Memo

## Purpose

Generate a legal research memo with claim-level source verification, confidence flags, and primary-authority priority.

## Routing

- Use when: Use for legal/regulatory research memos where citation reliability is critical.
- Do not use when: Do not use for contract redline workflows that are primarily document-editing tasks.
- Outputs: Structured memo with verified citations, confidence flags, and practical recommendations.
- Success criteria: Every key claim is linked to a fetched source or clearly labeled uncertain.

## Trigger Examples

### Positive

- Use the legal-verified-research-memo skill for this request.
- Help me with legal verified research memo.
- Use for legal/regulatory research memos where citation reliability is critical.
- Legal Verified Research Memo: provide an actionable result.

### Negative

- Do not use for contract redline workflows that are primarily document-editing tasks.
- Do not use legal-verified-research-memo for unrelated requests.
- This request is outside legal verified research memo scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| question | string | Yes | Legal question to research |
| jurisdictions | string | No | Jurisdiction scope |
| output_report_path | string | No | Where to write the research memo |

## Runtime Prompt

- Current runtime prompt length: 1212 characters.
- Runtime prompt is defined directly in `../legal-verified-research-memo.json`. 
