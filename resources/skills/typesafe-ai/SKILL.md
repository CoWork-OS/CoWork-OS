---
name: typesafe-ai
description: Build AI-powered software with TypeSafe System One models, including Jev, as typed judgments and probabilities for routing, ranking, extraction, verification, and other structured decisions. Use when integrating TypeSafe or replacing a semantic LLM prompt-and-parse step with a programmable decision primitive.
---

# Build with TypeSafe

This guide is bundled from [TypeSafe AI's official skill](https://github.com/typesafe-ai/skills/tree/main/skills/typesafe-ai) under its MIT license. The [live TypeSafe docs](https://docs.typesafe.ai/llms.txt) are the source of truth for current concepts, prompting guidance, API contracts, SDK usage, models, limits, and examples.

TypeSafe makes units of AI intelligence usable like programming primitives: small
judgments you can compose into larger capabilities. Its **System One models** return
fast, focused judgments that software can consume directly. **Jev** is TypeSafe's
flagship and first System One model. It understands natural language and returns
typed answers and probabilities rather than generating text or reasoning
explanations. Code owns the workflow; the model supplies programmable common sense
where ordinary code needs semantic understanding.

## Read the live docs

- Start with the [documentation index](https://docs.typesafe.ai/llms.txt) and read only relevant pages.
- Mintlify serves Markdown by appending `.md` to a page path. Follow links from the index and resolve relative links against `https://docs.typesafe.ai`.
- Before writing an integration, read the current API or chosen SDK page and the question guidance relevant to the design. For a new workflow, inspect the closest cookbook.
- If live access is unavailable, use available local docs or installed SDK types, state the limitation, and avoid inventing version-dependent details.

| Task | Start here |
| --- | --- |
| Understand the programming model | [System One](https://docs.typesafe.ai/concepts/system-one.md), [building guide](https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md) |
| Explore what to build | [Use-case map](https://docs.typesafe.ai/concepts/use-case-map.md), then relevant cookbooks |
| Prepare inputs and questions | [State](https://docs.typesafe.ai/concepts/state.md), [primitives](https://docs.typesafe.ai/primitives.md) |
| Decide how to handle uncertainty | [Confidence](https://docs.typesafe.ai/confidence.md) |
| Write API code | [HTTP API](https://docs.typesafe.ai/api.md), [Python SDK](https://docs.typesafe.ai/sdk/python.md), or [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript.md) |
| Update an older integration | [Migration guide](https://docs.typesafe.ai/migrating-to-v1.md) and the installed SDK's current reference |

## Find the useful shape

Start from the behavior the user wants: what will the application show, select,
change, or hand off? Work backward to the judgments it needs. Keep known rules,
calculations, exact lookups, and execution in code. Preserve the user's chosen stack
and scope; add TypeSafe where semantic understanding helps.

Useful patterns include:

- **Route and fill known arguments.** Select a handler and typed parameters from a candidate set; ask useful branch-specific questions up front. Explore [function calling](https://docs.typesafe.ai/cookbooks/function_calling.md) and [speculative fan-out](https://docs.typesafe.ai/patterns/fan-out.md).
- **Select instead of generate.** Let code build candidate values or source spans, use a judgment to select the intended one, then copy or normalize it. Explore [value extraction](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook.md) and [structure recovery](https://docs.typesafe.ai/cookbooks/autoformat.md).
- **Find and judge evidence.** Retrieve candidates, compare their relevance, and select useful context. Explore [reranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe.md) and [hierarchical classification](https://docs.typesafe.ai/cookbooks/hierarchical_classification.md).
- **Turn judgments into reusable data.** Score dimensions once, then let code change weights, thresholds, rankings, and views. Explore [composite scoring](https://docs.typesafe.ai/patterns/composite-scoring.md) and [feature discovery](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery.md).
- **Verify and escalate.** Check claims or fields against evidence; send uncertain or failing cases to a person or reasoning model. Explore [citation checks](https://docs.typesafe.ai/cookbooks/citation_check.md) and [extraction cascades](https://docs.typesafe.ai/cookbooks/sde_cascade.md).
- **Respond to changing state.** Keep inferred state distinct from observed facts and check freshness before applying a result to changed state.

## Design the judgments

Choose by what the answer means, then read the relevant primitive page:

| Need | Primitive | Important distinction |
| --- | --- | --- |
| One of a defined set | [Choice](https://docs.typesafe.ai/primitives/choice.md) | Picks one option; its distribution compares competing options |
| Whether a condition holds | [Noul](https://docs.typesafe.ai/primitives/noul.md) | Probability of yes; no separate confidence; use one per label when several may apply |
| Degree along a described dimension | [Score](https://docs.typesafe.ai/primitives/score.md) | Probability-weighted position on ordered levels; use comparable per-item Scores for graded ranking |

Give each question enough relevant **state**: source text, identities,
relationships, policies, and current facts. Prefer named JSON fields when context
has several parts. Put the judgment in instructions and define possible answers in
criteria. Question IDs are for code and are not sent to the model; include complete
meaning in the question. Reference nested state with backticked paths such as
`ticket.messages[0].text`.

Ask one narrow, coherent judgment per question. Split independently useful
dimensions without destroying the relationship being judged. Strings work for simple
questions; use structured objects or arrays when definitions, contrasts, exclusions,
or examples clarify instructions or criteria. Score levels must describe concrete
situations and stand on their own.

Keep the needed answers available. Include a no-match outcome when nothing may fit;
use a separate presence judgment when it is independently useful. For source-value
selection, check candidate coverage: the model cannot choose an omitted value.

## Compose and verify

Ask independent questions over the same state together, including useful speculative
questions. They run in parallel and cannot see one another's answers. State each
speculative premise explicitly; code consumes the applicable answers. A second
request is warranted when an earlier answer is needed to fetch evidence, construct
new state, or determine the next options. Measure actual request budgets, cost, and
end-to-end latency.

Use probabilities and confidence to guide behavior, with thresholds evaluated on the
user's data and consequences. Choice/Score confidence summarizes distribution
concentration, not overall workflow correctness or permission to act. A Noul near
0.5 means similar probability for yes and no, not medium intensity. Several
acceptable alternatives can also spread probability; low confidence need not
invalidate a harmless preference choice. Ignore uncertainty on unused branches.

Keep policy explicit and raw judgments reusable. Weighted scores suit compensating
preferences; an “any serious violation” rule needs separate conditions. Typed output
guarantees the interface, not truth. System One models are trained for calibrated
decisions; validate their performance in the target domain.

Test representative cases and resulting application behavior. For failures, inspect
the exact state, questions, candidates, answers, composition, and observed outcome.
Separate missing evidence, model errors, code errors, and service failures. Treat
cookbook thresholds and demo results as examples to evaluate, not universal rules or
permanent model limitations. Keep API credentials server-side in web apps.
