---
name: local-websearch
description: "Search the web privately via a self-hosted SearXNG metasearch engine."
---

# local-websearch

## Purpose

Search the web privately via a self-hosted SearXNG metasearch engine.

## Routing

- Use when: Use when users ask for web lookup, private browsing, or recent facts not in local files.
- Do not use when: Don't use for internal workspace-only questions already covered by local docs or files.
- Outputs: Structured search results with titles, URLs, and snippets.
- Success criteria: Returns concise results with enough context to support a cited answer.

## Trigger Examples

### Positive

- Use the local-websearch skill for this request.
- Help me with local-websearch.
- Use when users ask for web lookup, private browsing, or recent facts not in local files.
- local-websearch: provide an actionable result.

### Negative

- Don't use for internal workspace-only questions already covered by local docs or files.
- Do not use local-websearch for unrelated requests.
- This request is outside local-websearch scope.
- This is conceptual discussion only; no tool workflow is needed.

## Runtime Prompt

- Current runtime prompt length: 1364 characters.
- Runtime prompt is defined directly in `../local-websearch.json`. 
