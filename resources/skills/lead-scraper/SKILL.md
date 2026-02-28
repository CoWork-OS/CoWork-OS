---
name: lead-scraper
description: "Extract business and contact information from directory pages and company websites."
---

# Lead Scraper

## Purpose

Extract business and contact information from directory pages and company websites.

## Routing

- Use when: Use when the user wants to extract business information, contact details, or lead data from websites.
- Do not use when: Don't use for personal data harvesting without consent or for spam purposes.
- Outputs: Structured business/contact data in table format.
- Success criteria: Extracts accurate contact and business information from the target page.

## Trigger Examples

### Positive

- Use the lead-scraper skill for this request.
- Help me with lead scraper.
- Use when the user wants to extract business information, contact details, or lead data from websites.
- Lead Scraper: provide an actionable result.

### Negative

- Don't use for personal data harvesting without consent or for spam purposes.
- Do not use lead-scraper for unrelated requests.
- This request is outside lead scraper scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| url | string | Yes | URL of directory page or company website |

## Runtime Prompt

- Current runtime prompt length: 959 characters.
- Runtime prompt is defined directly in `../lead-scraper.json`. 
