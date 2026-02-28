---
name: translate
description: "Translate content to another language"
---

# Translate

## Purpose

Translate content to another language

## Routing

- Use when: Use when user asks for language localization of user-visible content.
- Do not use when: Don't use for translating source code identifiers or binary formats.
- Outputs: Locale-specific content file(s).
- Success criteria: Preserves meaning and structure with style-appropriate phrasing.

## Trigger Examples

### Positive

- Use the translate skill for this request.
- Help me with translate.
- Use when user asks for language localization of user-visible content.
- Translate: provide an actionable result.

### Negative

- Don't use for translating source code identifiers or binary formats.
- Do not use translate for unrelated requests.
- This request is outside translate scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| path | string | Yes | Path to the file to translate |
| language | select | Yes | Target language |

## Runtime Prompt

- Current runtime prompt length: 415 characters.
- Runtime prompt is defined directly in `../translate.json`. 
