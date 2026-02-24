# Placeholder Engine

The placeholder engine powers the rotating prompt suggestions shown in the main input box. It progressively personalises what users see based on how well the system knows them.

## Overview

When the input box is empty, a placeholder cycles every 4 seconds with a fade transition. Rather than showing random suggestions from a flat list, the engine selects prompts that are relevant to the current user's persona and context.

```
Cold start (new user)  -->  Persona-detected  -->  Fully personalised
      |                         |                         |
  Universal only       Weighted by persona      Goals, commitments,
  20 safe prompts      ~3:1 matched vs          recent tasks shown
                       universal ratio           first in rotation
```

## Architecture

```
src/renderer/utils/placeholderEngine.ts   -- Pure logic, no React
src/renderer/components/MainContent.tsx   -- Consumer (useEffect)
src/renderer/styles/index.css             -- .cli-rotating-placeholder
```

The engine is lazy-imported from `MainContent.tsx` to keep the initial bundle small. It exports three functions and one type:

| Export | Purpose |
|---|---|
| `detectPersonas(signals)` | Score each persona from user data |
| `buildDynamicPrompts(signals)` | Generate personalised prompts from goals/tasks |
| `buildPlaceholders(personaResult, dynamicPrompts, pluginPrompts)` | Produce the final ordered playlist |
| `UserSignals` | Type describing the input data shape |

## Persona Taxonomy

The engine defines 20 persona categories:

| Persona | Example keywords |
|---|---|
| `universal` | *(always shown)* |
| `engineering` | code, deploy, api, test, docker, git, ci/cd |
| `trading` | stock, portfolio, earnings, dcf, options, backtest |
| `education` | lesson, curriculum, rubric, quiz, student, grading |
| `marketing` | campaign, seo, funnel, conversion, ad copy, content |
| `design` | figma, wireframe, wcag, typography, component |
| `product` | prd, roadmap, backlog, sprint, user story, okr |
| `founder` | startup, pitch, fundraise, term sheet, runway, tam |
| `sales` | prospect, pipeline, rfp, demo, crm, outreach |
| `hr` | hire, recruit, onboarding, performance review, dei |
| `legal` | contract, compliance, gdpr, nda, privacy policy |
| `data` | sql, dashboard, etl, tableau, anomaly, forecast |
| `research` | paper, hypothesis, literature review, methodology |
| `operations` | sop, supply chain, vendor, capacity, postmortem |
| `support` | ticket, knowledge base, escalation, csat, sla |
| `personal` | travel, meal plan, budget, fitness, reading list |
| `healthcare` | patient, clinical, treatment, ehr, care plan |
| `realestate` | property, listing, mortgage, comps, cap rate |
| `creative` | video, podcast, storyboard, script, thumbnail |
| `writing` | blog, article, draft, proofread, newsletter |

## Tagged Placeholder Pool

Each placeholder is tagged with one or more personas:

```ts
interface TaggedPlaceholder {
  text: string;
  personas: Persona[];
}
```

Examples:

```ts
{ text: "Backtest this moving-average crossover strategy", personas: ["trading"] }
{ text: "Build a competitive feature matrix",            personas: ["product", "founder"] }
{ text: "Summarize this PDF and extract the action items", personas: ["universal"] }
```

The pool contains **~160 entries** across all 20 personas. Entries tagged `"universal"` are safe for any user. Many entries are cross-tagged (e.g. a DCF model is both `trading` and `founder`).

## Persona Detection

### Signal sources

The engine collects five signal sources in parallel on mount:

| # | Source | API | Weight |
|---|---|---|---|
| 1 | **User profile facts** | `getUserProfile()` | 1x (goal/work facts get 3x) |
| 2 | **Recent completed tasks** | `listActivities({ activityType: "task_completed", limit: 15 })` | 1x |
| 3 | **Top skills used** | `getUsageInsights(workspaceId, 30).topSkills` | 1x |
| 4 | **Plugin pack prompts** | `listPluginPacks()` | 1x |
| 5 | **Open commitments** | `getOpenCommitments(5)` | 1x |

### Scoring algorithm

All signal text is combined into a single lowercase corpus. Each persona's keyword list is matched against the corpus:

```
For each persona (except universal):
  For each keyword in SIGNAL_KEYWORDS[persona]:
    if keyword found in corpus:
      score[persona] += 1

For each profile fact with category "goal" or "work":
  For each keyword match:
    score[persona] += 2   // extra weight for explicit user statements
```

The `hasSignal` flag is set to `true` when the total score across all personas is >= 3.

### Example

A user whose profile contains `goal: "ship v2 of our SaaS by March"` and recent tasks like `"Write unit tests for auth"`, `"Review PR #482"`:

- `engineering` scores high (test, PR, auth)
- `product` gets a boost (ship, SaaS)
- `trading`, `education`, etc. score 0

Result: the user sees engineering + product placeholders, with universal ones mixed in.

## Progressive Tiers

### Tier 1: Cold start (`hasSignal === false`)

New user, no profile, no tasks. Only the 20 `"universal"` placeholders are shown, shuffled randomly. These are domain-agnostic prompts like:

- "Summarize this PDF and extract the action items"
- "Help me plan my week"
- "What's on my calendar for tomorrow?"
- "Create a checklist for this project"

### Tier 2: Persona-detected (`hasSignal === true`)

The top 5 scoring personas are selected. Placeholders are interleaved:

```
[3 matched-persona placeholders] [1 universal] [3 matched] [1 universal] ...
```

Non-matching persona placeholders are **excluded entirely** -- a trader never sees "Create a grading rubric" and a teacher never sees "Backtest this moving-average strategy".

### Tier 3: Fully personalised

Dynamic prompts are generated from the user's own data and placed **first** in the rotation:

| Source | Prompt template |
|---|---|
| Profile goals | `Help me make progress on: {goal}` |
| Profile work facts | `Anything new I should know about {work}?` |
| Open commitments | `Follow up on: {commitment}` |
| Recent tasks | `Continue from: {task title}` |

These are deduplicated against the static pool to avoid repeats.

## Rotation & Animation

The placeholder cycles every **4 seconds** with a 300ms CSS fade transition:

1. `placeholderFading` set to `true` → opacity transitions to 0
2. After 300ms, index advances, `placeholderFading` set to `false` → opacity transitions back
3. Cycling pauses automatically when the user has typed anything (`inputValue` is non-empty)

The placeholder is rendered as a custom overlay `<span>` (not the native `placeholder` attribute) so the fade animation can be controlled via CSS.

```css
.cli-rotating-placeholder {
  color: var(--color-text-muted);
  transition: opacity 0.3s ease;
}
.cli-rotating-placeholder.fading {
  opacity: 0;
}
```

## Adding New Placeholders

To add placeholders, edit the `POOL` array in `placeholderEngine.ts`:

```ts
{ text: "Your new placeholder text", personas: ["persona1", "persona2"] }
```

Guidelines:
- Keep text under ~60 characters so it fits the input box
- Tag with `"universal"` only if it makes sense for **every** user
- Cross-tag when relevant (e.g. financial model → `["trading", "founder"]`)
- Use natural, conversational phrasing (as if the user is typing it)

## Adding New Personas

1. Add the persona to the `Persona` union type
2. Add keywords to `SIGNAL_KEYWORDS`
3. Add tagged placeholders to `POOL`

The detection and selection logic automatically picks up new personas -- no other changes needed.
