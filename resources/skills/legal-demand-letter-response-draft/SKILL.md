---
name: legal-demand-letter-response-draft
description: "Map allegations to contract language and draft a response letter with no unintended admissions."
---

# Legal Demand Letter Response Draft

## Purpose

Map allegations to contract language and draft a response letter with no unintended admissions.

## Routing

- Use when: Use when a demand letter must be analyzed and answered against contract language.
- Do not use when: Do not use when the task is generic writing unrelated to legal allegations.
- Outputs: Allegation map and response draft with section-level legal grounding.
- Success criteria: Produces a defensible response draft, avoids unsupported admissions, and writes both artifacts.

## Trigger Examples

### Positive

- Use the legal-demand-letter-response-draft skill for this request.
- Help me with legal demand letter response draft.
- Use when a demand letter must be analyzed and answered against contract language.
- Legal Demand Letter Response Draft: provide an actionable result.

### Negative

- Do not use when the task is generic writing unrelated to legal allegations.
- Do not use legal-demand-letter-response-draft for unrelated requests.
- This request is outside legal demand letter response draft scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| agreement_path | string | No | Optional explicit path to the governing contract |
| demand_letter_path | string | No | Optional explicit path to the demand letter |
| facts_path | string | No | Optional chronology/facts memo path |
| client_role | select | No | Role of your client in the dispute |
| response_output_path | string | No | Where to write the draft response letter |
| issues_table_output_path | string | No | Where to write the allegation mapping table |

## Runtime Prompt

- Current runtime prompt length: 1932 characters.
- Runtime prompt is defined directly in `../legal-demand-letter-response-draft.json`. 
