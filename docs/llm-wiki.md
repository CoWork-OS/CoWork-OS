# LLM Wiki

CoWork OS ships `llm-wiki` as a bundled, first-class research-vault workflow.

It is inspired by **Andrej Karpathy's LLM Wiki / raw-folder knowledgebase concept**: keep raw source material, build durable linked notes on top of it, and make the result easy for both humans and agents to navigate.

In CoWork, that idea is implemented as a deterministic research-vault runtime: GUI prompts, starter cards, and slash syntax all land on the same workspace-local vault convention instead of staying as one-off chat output.

## What it does

`llm-wiki` builds and maintains a persistent markdown knowledge base inside the current workspace.

Default vault layout:

```text
research/wiki/
  SCHEMA.md
  index.md
  log.md
  inbox.md
  maps/
  concepts/
  entities/
  projects/
  comparisons/
  queries/
  raw/articles/
  raw/papers/
  raw/transcripts/
  raw/repos/
  raw/datasets/
  raw/assets/
  outputs/slides/
  outputs/charts/
```

Core behavior:

- keeps `raw/` captures immutable after ingest
- writes durable wiki pages with structured frontmatter
- uses Obsidian-style `[[wikilinks]]`
- captures articles, papers, repos, datasets, and images into deterministic raw locations
- searches the vault deterministically before broader re-research
- files generated slide decks and charts back into `outputs/`
- keeps `index.md`, `log.md`, and `inbox.md` current
- writes run artifacts under `artifacts/skills/<task>/llm-wiki/`
- runs a deterministic analyzer to report vault topology and maintenance gaps
- can expose the default vault in the GUI welcome screen as a browsable surface when the optional home widget is enabled

## Why it is first-class in CoWork

`llm-wiki` is not treated as a loose skill invocation.

It is integrated into the same first-class surfaces as `/simplify` and `/batch`:

- GUI prompts such as `Build a persistent Obsidian-friendly research vault for GRPO papers`
- welcome screen and onboarding starter cards
- optional welcome-screen vault browser, enabled from **Settings > Appearance > Home widgets > Show research vault**
- desktop slash command handling
- gateway/channel slash command handling
- inline chaining such as `research this topic then run /llm-wiki`
- WhatsApp natural-language mapping for research-vault phrasing
- deterministic parameter parsing and validation

The runtime still follows the additive skill model: the canonical user request stays intact while the skill adds structured instructions and scoped behavior.

## GUI-first usage

For desktop users, the normal path is a prompt, not a command.

Examples:

```text
Build a persistent Obsidian-friendly research vault for GRPO papers
Create a research vault about CoWork OS competitors
Audit my research vault for stale pages and broken links
Use the research vault in this workspace to answer a question
Build a persistent Obsidian-friendly research vault in this workspace. If I have not given the topic yet, ask me for it first.
```

Natural research-vault prompts route deterministically into `llm-wiki`.

If the request clearly asks for a vault but does not yet include the topic, CoWork starts the `llm-wiki` workflow and asks one short scoping question before doing durable ingest work.

## Command syntax

```text
/llm-wiki <objective> [--mode <auto|init|ingest|query|lint|refresh>] [--path <path>] [--obsidian <auto|on|off>]
```

Notes:

- `objective` is normally required
- `--mode init`, `--mode lint`, and `--mode refresh` may run without an objective
- `--path` can be workspace-relative or absolute
- `--obsidian auto` is the default behavior
- GUI prompt routing may start with no objective yet; in that case the agent asks for the topic first

Examples:

```text
/llm-wiki research CoWork OS competitors
/llm-wiki transformer RL papers --mode ingest --path research/wiki/rl
/llm-wiki --mode init --path research/wiki
/llm-wiki --mode lint --path "Research Vault"
```

Inline chaining is also supported:

```text
Research GRPO implementations and tradeoffs then run /llm-wiki --mode ingest
```

## Modes

| Mode | Purpose |
|------|---------|
| `init` | Create the vault structure and seed files |
| `ingest` | Capture sources and update durable notes |
| `query` | Answer from the vault first, then save durable syntheses back |
| `lint` | Audit structure, linking, frontmatter, index coverage, and contradictions |
| `refresh` | Re-check important pages against fresher evidence and tighten links |
| `auto` | Infer the best mode from the request and current vault state |

## Deterministic workbench

The vault runtime is backed by small deterministic helper scripts, not only by prompt instructions.

Bundled helpers:

- `resources/skills/llm-wiki/scripts/wiki-import.mjs`
- `resources/skills/llm-wiki/scripts/wiki-search.mjs`
- `resources/skills/llm-wiki/scripts/wiki-render.mjs`
- `resources/skills/llm-wiki/scripts/wiki-graph-report.mjs`

What they cover:

- `wiki-import.mjs`: raw ingest for local files, URLs, repo directories, datasets, and images
- `wiki-search.mjs`: vault-first search across wiki pages, raw captures, and rendered slide decks
- `wiki-render.mjs`: filed-back Marp slide decks and deterministic SVG charts under `outputs/`
- `wiki-graph-report.mjs`: topology and maintenance reporting

Typical runtime behavior:

- ingest raw material first into `raw/...`
- search the vault before browsing outward again
- file durable answers into `queries/` or `comparisons/`
- file visual outputs into `outputs/slides/` or `outputs/charts/`

## Deterministic analyzer

The bundled analyzer lives at:

- `resources/skills/llm-wiki/scripts/wiki-graph-report.mjs`

It produces both markdown and JSON reports and is used to ground vault-health claims in exact counts instead of model guesswork.

Current analyzer outputs include:

- wiki page count
- raw source count
- total cross-references
- unique link targets
- top inbound-link pages
- orphan pages
- broken links
- ambiguous links
- weak outbound linking
- pages missing from `index.md`
- frontmatter issues
- bridge pages
- surprising cross-section links
- suggested follow-up questions

This gives the vault a maintenance loop, not just an ingestion loop.

## GUI vault surface

The desktop app can treat the default vault path as a visible part of the product when the optional home widget is enabled.

When **Settings > Appearance > Home widgets > Show research vault** is enabled and `research/wiki` exists in the active workspace, the welcome screen shows a vault panel with:

- core files such as `index.md`, `inbox.md`, `log.md`, and `SCHEMA.md`
- recent durable notes
- recent query pages
- recent output files
- recent raw captures
- quick GUI actions for ingest, query, audit, explore, briefing, and opening the vault index

When the home widget is enabled, the vault is easier to inspect and showcase without dropping into slash syntax or opening the filesystem manually. It is disabled by default; normal prompts and `/llm-wiki` continue to work either way.

## Prompt library

Useful GUI-first prompts, adapted to CoWork:

```text
Build a persistent Obsidian-friendly research vault in this workspace. If I have not given the topic yet, ask me for it first.
Use the research vault in this workspace to answer a question. If I have not asked the question yet, ask me for it first.
Audit the research vault in this workspace for broken links, orphan notes, weak pages, stale content, missing source capture, and missing output opportunities.
Use the research vault in this workspace to identify the 5 most interesting unexplored connections between existing topics.
Use the research vault in this workspace to write an executive briefing on a topic I give you.
Process all unprocessed raw sources in this workspace research vault sequentially and keep the vault curated.
```

These map cleanly onto the main loops:

- ingest
- query
- lint / health check
- explore open questions
- write reusable briefings
- batch catch-up ingest

## Limits

This pattern is strong, but it is not magic.

Main operational limits:

- context ceilings still exist, so the agent must read selectively and can miss material
- errors can compound if low-quality syntheses get filed back into the vault
- source-grounded notes reduce hallucination but do not eliminate it
- cost grows with ingest volume and rewrite breadth
- this pattern works best for focused domain vaults, not giant enterprise corpora
- one model can impose one style of interpretation unless you deliberately cross-check

Best operating posture:

- keep each vault scoped to one domain or problem area
- treat `raw/` as immutable evidence and keep provenance explicit
- use `Audit` regularly instead of only when something feels off
- review high-stakes claims against the raw sources, not only against the wiki
- file back only durable, reusable outputs instead of every transient thought

## Obsidian-friendly behavior

When `--obsidian auto` or `--obsidian on` is used, the skill optimizes for:

- `[[wikilinks]]`
- concise map-of-content pages
- image references such as `![[diagram.png]]`
- durable markdown pages that remain readable outside Obsidian

CoWork does **not** create `.obsidian/` settings unless explicitly asked.

## Output artifacts

Each substantial run writes:

- `wiki-manifest.md`
- `wiki-summary.md`
- `wiki-graph-report.md`
- `wiki-graph-report.json`

These live under the task artifact directory so each run is auditable even though the vault itself is persistent.

## Guardrails and maintenance rules

- `raw/` captures are append-only after ingestion
- new pages should be high-signal, not created for passing mentions
- durable pages should usually link to at least two distinct other pages
- durable answers should be filed back into the vault instead of staying only in chat when they add reusable knowledge
- durable visual outputs should be written to `outputs/` instead of staying transient
- if a run would rewrite more than 10 existing wiki pages, the skill is expected to confirm first
- `SCHEMA.md` owns the tag taxonomy
- analyzer output should drive follow-up work in `inbox.md`, `queries/`, and `comparisons/`

## Related docs

- [Features](features.md)
- [Channels](channels.md)
- [Skills Runtime Model](skills-runtime-model.md)
- [Use Cases](use-cases.md)
