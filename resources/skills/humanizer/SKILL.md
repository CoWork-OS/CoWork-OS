---
name: humanizer
description: "Rewrite AI-generated text to sound natural and human-written. Removes LLM tells — cliché phrases, predictable structure, inflated language, and robotic patterns. Use when editing drafts, emails, articles, or any text that reads like it was written by AI."
---

# Humanizer

## Purpose

Rewrite AI-generated text to sound natural and human-written. Removes LLM tells — cliché phrases, predictable structure, inflated language, and robotic patterns. Use when editing drafts, emails, articles, or any text that reads like it was written by AI.

## Routing

- Use when: User asks to humanize text, make text sound less like AI, rewrite AI-generated content, remove AI tells, make writing more natural, or edit text to sound human-written
- Do not use when: User wants to generate new content from scratch, translate text, or summarize text
- Outputs: Rewritten text that reads naturally without AI writing markers
- Success criteria: The output text would not be flagged by AI detection tools and reads like natural human writing

## Trigger Examples

### Positive

- Use the humanizer skill for this request.
- Help me with humanizer.
- User asks to humanize text, make text sound less like AI, rewrite AI-generated content, remove AI tells, make writing more natural, or edit text to sound human-written
- Humanizer: provide an actionable result.

### Negative

- User wants to generate new content from scratch, translate text, or summarize text
- Do not use humanizer for unrelated requests.
- This request is outside humanizer scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| text | string | No | The text to humanize (or paste it directly in your message) |
| tone | select | No | Target tone for the rewrite |

## Runtime Prompt

- Current runtime prompt length: 818 characters.
- Runtime prompt is defined directly in `../humanizer.json`. 
