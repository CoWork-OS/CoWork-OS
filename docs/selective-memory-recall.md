# Selective memory recall

Private task prompts keep the personal memory index and select workspace/bot notes using
user intent. The executor supplies the latest user message followed by the original,
undecorated task request. Every prompt surface uses the same query for the pinned memory
block and the hashes excluded from L0/L1, so omitted facts are not mistakenly deduplicated.

Selection happens inside the files the existing memory policy already permits: the current
workspace and the task's own bot. It does not search additional workspaces or bots. Personal
`MEMORY.md` and applicable team indexes retain their existing rendering. Explicit
`memory_recall` and file reads continue to provide on-demand access to omitted notes.

## Selection within existing budgets

- Bounded Unicode-aware, case/accent-folded terms reuse the search tokenizer (24 query terms,
  at most 4,000 input characters). A query is selection data and is never echoed into memory.
- Lexical overlap is weighted by how uncommon a term is within the candidate file. Weak
  matches below 40% of the best note's score are dropped, so a shared project name alone
  does not crowd out a specific match. Ties use original file order.
- Typed user rules, preferences, identity and active commitments are prioritized within the
  existing budget. They do not consume the quota of five relevant notes. Their priority
  order stays stable across queries. Agent-inferred constraints receive normal relevance
  treatment. Untyped handwritten notes are treated as notes; enduring anchors belong in
  `MEMORY.md` or can carry `by: user; kind: rule` metadata.
- At most five other relevant entries per workspace/bot file are included. Duplicate content
  is selected once. Ranking precedes budgeting, and an oversized entry can be skipped to
  fit a smaller useful one. Display order, line refs, hashes and source labels still refer
  to the original file.
- Redaction, tag escaping and expiry filtering happen before selection. Changed-source notes
  are not automatically selected, except prioritized user constraints which retain their
  warning. The personal index retains its existing source warnings.
- Queries without informative terms retain file-order compatibility. A meaningful query with
  no matches keeps only applicable user constraints; the personal index remains available.

The normalized query terms join the context cache key alongside repo version, workspace,
bot, day, source-flag version and file stamps. A follow-up can change selected notes even
when no file changes. There is no new model call, embedding index, memory write or budget
increase. This is lexical selection; synonyms without shared terms may require on-demand
recall or reading the linked topic file.

## Evaluation

`npm run qa:memory-quality` now evaluates three arms over each identical history: selective
memory, memory disabled, and the previous file-order context. All original answer/safety
thresholds remain. New gates require at least 5% lower mean estimated prompt-context tokens,
at least 0.10 greater injected useful recall, no task-proxy or tool-recall regression, no
fixture-marked irrelevant notes in selected context, and retention of required user rules.
The pressure case requires the useful command to be missing from the old prompt but present
in the selected prompt. A thirteenth history checks an unrelated user rule survives.

The JSON artifact includes all three arms, comparative metrics and thresholds. Token counts
are character estimates including the memory wrapper, and these task proxies use a scripted
responder; they are not live-agent quality or provider-billing measurements. See
[Memory quality benchmark](memory-quality-benchmark.md).
