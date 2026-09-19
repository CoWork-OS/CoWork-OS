# Autobrowse Full Guidance

## Run Directory

Create a run directory under the current artifact directory:

```text
{artifactDir}/autobrowse/<slug>/
  strategy.md
  iterations.md
  draft-skill.md
```

Keep these files concise. They are working memory and review artifacts, not full transcripts.

## `strategy.md` Template

```markdown
# Strategy

Objective: <repeatable task>
Target: <site or URL>
Updated: <YYYY-MM-DD>
Status: exploring | converged | blocked

## Current Best Path

1. <step>
2. <step>

## Deterministic Shortcuts

- Endpoint: <method URL>
  - Params: <required params>
  - Headers/cookies: <only non-secret requirements>
  - Response fields: <fields to read>

## Browser Fallback

- Start URL:
- Stable selectors:
- Required waits:
- Success signal:

## Gotchas

- <site-specific issue and mitigation>

## Stop Doing

- <steps from earlier attempts that were wasteful or brittle>
```

## `iterations.md` Template

```markdown
# Iterations

## Iteration 1

- Goal:
- Result: success | partial | failed
- Browser actions:
- Useful evidence:
- Problems:
- Strategy update:

## Iteration 2

- Goal:
- Result:
- Improvement over previous:
- Remaining fragility:
```

## `draft-skill.md` Template

```markdown
---
name: <skill-id>
description: "<what this workflow reliably does>"
---

# <Skill Name>

## Purpose

<One paragraph.>

## Routing

- Use when:
- Do not use when:
- Outputs:
- Success criteria:

## Inputs

| Name  | Required | Description |
| ----- | -------- | ----------- |
| query | Yes      | <example>   |

## Workflow

1. <deterministic step first>
2. <browser fallback if needed>

## Validation

- <observable success signal>
- <sanity checks on output>

## Site-Specific Gotchas

- Freshness: learned on <YYYY-MM-DD>.
- <gotcha>

## Safety

- <side-effect boundary>
```

## Skill Proposal Shape

When creating a proposal, include enough evidence for a human reviewer to trust it:

- `problem_statement`: the recurring workflow and why the browser exploration cost should not be paid again.
- `evidence`: iteration results, stable endpoint/selector discoveries, and convergence signal.
- `required_tools`: browser tools, shell helpers, fetch/scrape tools, or connector tools actually needed.
- `risk_note`: fragility, auth, data sensitivity, and side-effect constraints.
- `draft_skill`: name, description, prompt, parameters, category, and enabled state.

## Convergence Heuristics

Stop when any of these is true:

- A direct endpoint or helper script completes the workflow without fragile browser interaction.
- Two consecutive attempts follow the same steps and succeed.
- A later attempt does not reduce actions, tool calls, elapsed time, ambiguity, or failure risk.
- The remaining blocker is external: auth, captcha, permissions, missing user input, payment, or rate limit.

## Preferred Improvements

- Replace rendered-page reading with structured JSON when it is naturally exposed.
- Replace coordinate clicks with stable refs, labels, selectors, or form names.
- Replace repeated discovery with a fixed URL template and explicit params.
- Replace page waits with specific success signals.
- Keep screenshots and full traces out of the skill unless they are necessary; summarize the durable learning instead.
