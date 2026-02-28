---
name: site-mapper
description: "Crawl a website and build a structured content map with page summaries."
---

# Site Mapper

## Purpose

Crawl a website and build a structured content map with page summaries.

## Routing

- Use when: Use when the user wants to understand a website's structure, discover all pages, or create a site inventory.
- Do not use when: Don't use for single-page scraping or when the user only needs content from one specific URL.
- Outputs: Hierarchical site map with page titles, URLs, and content summaries.
- Success criteria: Discovers and maps the main pages of the target website with accurate structure.

## Trigger Examples

### Positive

- Use the site-mapper skill for this request.
- Help me with site mapper.
- Use when the user wants to understand a website's structure, discover all pages, or create a site inventory.
- Site Mapper: provide an actionable result.

### Negative

- Don't use for single-page scraping or when the user only needs content from one specific URL.
- Do not use site-mapper for unrelated requests.
- This request is outside site mapper scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| url | string | Yes | Root URL of the website to map |

## Runtime Prompt

- Current runtime prompt length: 972 characters.
- Runtime prompt is defined directly in `../site-mapper.json`. 
