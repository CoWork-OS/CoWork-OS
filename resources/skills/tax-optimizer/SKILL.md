---
name: tax-optimizer
description: "Tax optimization strategies including tax-loss harvesting, wash sale rule navigation, asset location optimization, Roth conversion analysis, and charitable giving strategies."
---

# Tax Optimizer

## Purpose

Tax optimization strategies including tax-loss harvesting, wash sale rule navigation, asset location optimization, Roth conversion analysis, and charitable giving strategies.

## Routing

- Use when: Use when the user asks about tax-loss harvesting, wash sale rules, asset location, Roth conversion, tax-efficient investing, capital gains management, charitable giving tax strategies, or tax-optimized withdrawal sequencing.
- Do not use when: Do not use when the request is about tax preparation/filing, business tax strategy, estate tax planning, or non-investment tax questions.
- Outputs: Outcome from Tax Optimizer: tax-efficient strategy recommendations with quantified tax savings, implementation steps, timing guidance, and compliance guardrails.
- Success criteria: Returns specific tax optimization actions with estimated dollar savings, applicable rules and thresholds, implementation timeline, and clear warnings about compliance requirements like wash sale rules.

## Trigger Examples

### Positive

- Use the tax-optimizer skill for this request.
- Help me with tax optimizer.
- Use when the user asks about tax-loss harvesting, wash sale rules, asset location, Roth conversion, tax-efficient investing, capital gains management, charitable giving tax strategies, or tax-optimized withdrawal sequencing.
- Tax Optimizer: provide an actionable result.

### Negative

- Do not use when the request is about tax preparation/filing, business tax strategy, estate tax planning, or non-investment tax questions.
- Do not use tax-optimizer for unrelated requests.
- This request is outside tax optimizer scope.
- This is conceptual discussion only; no tool workflow is needed.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| portfolio | string | Yes | Portfolio details including account types and holdings (e.g., Taxable: SPY $200K, AAPL $50K; IRA: BND $100K; Roth: VTI $75K) |
| strategy | select | Yes | Tax optimization strategy to focus on |
| question | string | Yes | Your specific tax optimization question |
| taxBracket | select | Yes | Federal marginal tax bracket |
| filingStatus | select | Yes | Tax filing status |

## Runtime Prompt

- Current runtime prompt length: 1139 characters.
- Runtime prompt is defined directly in `../tax-optimizer.json`. 
