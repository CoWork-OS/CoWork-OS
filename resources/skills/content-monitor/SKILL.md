---
name: content-monitor
description: "Monitor web pages for changes and extract updated content with scheduling support."
---

# Content Monitor

## Purpose

Monitor web pages for changes and extract updated content with scheduling support.

## Routing

- Use when: Use when the user wants to monitor a webpage for changes, track content updates, or set up recurring content checks.
- Do not use when: Don't use for one-time scraping where web-scraper skill is more appropriate.
- Outputs: Content snapshot with timestamp for comparison, optionally scheduled for recurring checks.
- Success criteria: Captures a clean content snapshot that can be compared with future scrapes to detect changes.

## Trigger Examples

### Positive

- Use the content-monitor skill for this request.
- Help me with content monitor.
- Use when the user wants to monitor a webpage for changes, track content updates, or set up recurring content checks.
- Content Monitor: provide an actionable result.

### Negative

- Don't use for one-time scraping where web-scraper skill is more appropriate.
- Do not use content-monitor for unrelated requests.
- This request is outside content monitor scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| url | string | Yes | URL to monitor for changes |
| selector | string | No | CSS selector for the section to monitor (optional) |

## Runtime Prompt

- Current runtime prompt length: 997 characters.
- Runtime prompt is defined directly in `../content-monitor.json`. 
