---
name: web-scraper
description: "Scrape web pages with anti-bot bypass and structured data extraction using Scrapling."
---

# Web Scraper

## Purpose

Scrape web pages with anti-bot bypass and structured data extraction using Scrapling.

## Routing

- Use when: Use when the user wants to scrape content from websites, especially sites with anti-bot protection, dynamic content, or structured data that needs extraction.
- Do not use when: Don't use for simple URL fetching where web_fetch works fine. Don't use for internal files or local content.
- Outputs: Extracted web content including text, tables, links, images, and metadata.
- Success criteria: Successfully extracts the requested content from the target URL with clean formatting.

## Trigger Examples

### Positive

- Use the web-scraper skill for this request.
- Help me with web scraper.
- Use when the user wants to scrape content from websites, especially sites with anti-bot protection, dynamic content, or structured data that needs extraction.
- Web Scraper: provide an actionable result.

### Negative

- Don't use for simple URL fetching where web_fetch works fine. Don't use for internal files or local content.
- Do not use web-scraper for unrelated requests.
- This request is outside web scraper scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| url | string | Yes | URL to scrape |
| selector | string | No | CSS selector for specific content (optional) |

## Runtime Prompt

- Current runtime prompt length: 1117 characters.
- Runtime prompt is defined directly in `../web-scraper.json`. 
