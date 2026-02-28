---
name: marketing-strategist
description: "Comprehensive marketing strategy across 25 disciplines — positioning, copywriting frameworks, buyer psychology, SEO, CRO, paid ads, funnel architecture, content strategy, growth loops, analytics, pricing, product launches, and competitive intelligence. Use when the user needs marketing strategy, campaign planning, copy review, landing page audits, ad creation, GTM plans, or growth advice."
---

# Marketing Strategist

## Purpose

Comprehensive marketing strategy across 25 disciplines — positioning, copywriting frameworks, buyer psychology, SEO, CRO, paid ads, funnel architecture, content strategy, growth loops, analytics, pricing, product launches, and competitive intelligence. Use when the user needs marketing strategy, campaign planning, copy review, landing page audits, ad creation, GTM plans, or growth advice.

## Routing

- Use when: User asks about marketing strategy, copywriting, landing page optimization, SEO, paid ads, funnel design, GTM plans, pricing strategy, product launches, growth tactics, content strategy, competitive analysis, or general marketing advice
- Do not use when: User asks specifically about email marketing (use email-marketing-bible), writing tweets (use twitter skill), or community engagement (use auto-commenter). Use this skill for strategic marketing questions that span multiple channels or disciplines.
- Outputs: Marketing strategies, copy variants, audit reports, campaign plans, pricing recommendations, funnel designs, GTM playbooks, competitive analyses, A/B test plans
- Success criteria: User receives actionable marketing advice with specific frameworks, copy suggestions, or strategic plans they can immediately execute

## Trigger Examples

### Positive

- Use the marketing-strategist skill for this request.
- Help me with marketing strategist.
- User asks about marketing strategy, copywriting, landing page optimization, SEO, paid ads, funnel design, GTM plans, pricing strategy, product launches, growth tactics, content strategy, competitive analysis, or general marketing advice
- Marketing Strategist: provide an actionable result.

### Negative

- User asks specifically about email marketing (use email-marketing-bible), writing tweets (use twitter skill), or community engagement (use auto-commenter). Use this skill for strategic marketing questions that span multiple channels or disciplines.
- Do not use marketing-strategist for unrelated requests.
- This request is outside marketing strategist scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| task | string | No | What to do (e.g., 'audit my landing page', 'write ad copy', 'build a GTM plan', 'improve SEO', 'create pricing strategy') |
| channel | select | No | Focus channel or discipline |
| stage | select | No | Business stage for tailored advice |

## Runtime Prompt

- Current runtime prompt length: 1200 characters.
- Runtime prompt is defined directly in `../marketing-strategist.json`. 
