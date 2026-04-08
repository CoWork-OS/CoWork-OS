---
name: llm-wiki
description: "Build and maintain a workspace-local, Obsidian-friendly research vault using Karpathy's LLM Wiki pattern."
---

# LLM Wiki

## Purpose

Create and maintain a persistent markdown research vault with immutable raw sources, linked concept/entity pages, maps of content, and a maintenance log.

## Routing

- Use when: The user wants a persistent research vault, markdown knowledge base, or Obsidian-style wiki instead of a one-off report.
- Do not use when: The task is a disposable summary or a normal one-off research answer that does not need durable notes.
- Outputs: A workspace-local wiki vault plus `{artifactDir}/wiki-manifest.md` and `{artifactDir}/wiki-summary.md`.
- Success criteria: Raw sources are preserved, linked notes are updated, and `index.md`, `log.md`, and `inbox.md` remain current.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| objective | string | No | Topic, question, or research objective. If omitted, ask one short scoping question before durable ingest work. |
| mode | string | No | `auto`, `init`, `ingest`, `query`, `lint`, or `refresh` |
| path | string | No | Workspace-relative or absolute vault path |
| obsidian | string | No | `auto`, `on`, or `off` |

## Runtime Prompt

- Current runtime prompt is defined in `../llm-wiki.json`.
- Default vault path: `research/wiki` relative to the current workspace.
- Deterministic topology checks live in `scripts/wiki-graph-report.mjs`.
- Deterministic raw-source capture lives in `scripts/wiki-import.mjs`.
- Deterministic vault-first lookup lives in `scripts/wiki-search.mjs`.
- Deterministic filed-back outputs live in `scripts/wiki-render.mjs` for Marp slide decks and SVG charts.
