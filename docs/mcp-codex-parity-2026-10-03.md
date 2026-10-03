# MCP calling and approval validation — 2026-10-03

Connected MCP tools now remain available without English integration keywords,
the word MCP, or exact tool names. Full access permits configured MCP calls under
the default automatic policy; explicit server/tool approval requirements and
hard permission restrictions remain authoritative. The Configure dialog offers
Automatic, Ask before writes, Ask before every call, and Allow without asking.
See [access profiles](access-profiles.md) for the policy table and per-tool settings.

## Root causes and fixes

- Integration exposure and step-level filtering independently hid MCP tools.
  Both now preserve connected MCP definitions, including custom prefixes and
  tool-count trimming.
- Blanket external-service consent created an approval requirement for every
  MCP call. Full access uses `approval: never`, so that requirement became a
  denial. Calls now resolve authority from the saved server/tool policy and
  connected catalog, never model-supplied inputs.
- Interrupted task recovery could run before initial MCP discovery completed.
  Recovery now awaits the shared initialization promise.
- OpenAI Responses implicitly normalized optional filters into required fields.
  The adapter now sets `strict: false`, preserving the tool's required fields.
- MCP `isError` application results became exceptions and could disable tools.
  They now reach the model as failed results without tripping the tool circuit
  breaker. Transport exceptions continue to be handled separately.

The original captured denial occurred at **2026-10-03T10:44:06.397Z** in
`logs/dev-20261003-113324.log`:

> The active access profile is configured with never; required authority is unavailable.

An intermediate live run also demonstrated mandatory optional filters and an
`invalid_chamber` result at **2026-10-03T11:13:30.969Z**. Those findings led to the
Responses-schema and error-result fixes above.

The policy choices follow [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
The schema fix follows the [OpenAI function-calling documentation](https://developers.openai.com/api/docs/guides/function-calling),
which documents Responses strict normalization and the explicit opt-out.

## Live acceptance

The saved OpenAI GPT-6.1 Sol configuration and existing Dayanak server were used
through CoWork's local Electron-backed CLI with **Full access**. No credentials,
server configuration, or global permission exceptions were changed.

Task: `9d9ee813-f736-47fc-845f-1804b63e7707`.

The Turkish test prompt requested Dayanak search, passage retrieval, and citation
verification without mentioning MCP or exact tool names. Persisted tool events
confirm these real calls and responses:

| Call | Result |
| --- | --- |
| `mcp_search_yargitay` | `results`; query and limit only, no invented filters |
| `mcp_get_yargitay_passage` | `passage_found`; paragraph `p000015` |
| `mcp_check_yargitay_citations` | `citations_checked`; `located_in_corpus`, `exact_text_match` |

The returned decision was **22.HD, 2014/35440 E., 2016/3457 K.** The task completed
with three calls and no approval-request or permission-denial events. This proves
the model/CoWork/MCP transport workflow; it does not establish official legal
source authenticity. The returned decision date was null and official-source
checking was `not_checked`.

Sanitized evidence is saved locally at
`artifacts/mcp-parity/live-acceptance-2026-10-03.json`; temporary source-link access
tokens are omitted. The Configure approval selector was inspected in the desktop
app. Final post-fix desktop interaction remained blocked by the locked Mac; the
live model acceptance above used the rebuilt Electron-backed CLI.

## Automated validation

- 391 focused tests passed across 16 files covering discovery, step filters,
  tool caps, MCP initialization, policy precedence, Full access dispatch,
  disabled servers, custom prefixes, read-only ceilings, optional arguments,
  application-error recovery, and media result handling.
- Electron build, CLI build, and renderer TypeScript checking passed.
- Scoped formatting and diff checks passed. Scoped lint has existing warnings
  and no errors.

These are local source changes; no package or release has been published.

## Follow-up: question phrasing and retrieval

A later Dayanak run exposed a separate routing failure: the Turkish request
“emsal bir Yargıtay kararı bulabilir misin?” was classified as advice, assigned
`terminal_quick_answer`, and completed without tool calls. Its imperative
equivalent reached the tools. The earlier MCP transport and approval fixes did
not address this upstream shortcut.

The intent router now treats question punctuation as neutral and recognizes
source-retrieval actions with Unicode-aware English/Turkish matching independent
of connector names. Unrecognized question wording retains the normal conversation
path instead of being forced into a terminal advice answer. Source retrieval is
also an execution signal for mixed advice/research requests. A procedural question
does not suppress a separate instruction to gather supporting evidence. Explicit
Chat and plan settings and all existing permission boundaries remain authoritative.

The exact original prompt was rerun, without test markers or MCP tool names,
through the rebuilt Electron-backed CLI using the saved OpenAI GPT-6.1 Sol profile.
Persisted events show:

- Before: task `4f325c67-2d25-4bba-ae5c-ae8df22e2159`, advice/plan, terminal quick
  answer, **zero tool calls**.
- After: task `016ca10d-ffad-4a14-97e7-4519d991756c`, execution/research, normal
  tool loop, **six calls** using search, passage retrieval, and citation checking.
  The task completed, citation checking returned `exact_text_match`, and no
  approval rows were created.

The retrieved record was 9.HD, 2013/2824 E., 2014/40055 K., with date 2014-12-24.
This is a retrieval/quotation smoke test, not an assessment of legal applicability.
Sanitized before/after evidence is at
`artifacts/mcp-parity/question-routing-2026-10-03.json`; source-link tokens and
unrelated profile memory are omitted. The broader routing, interaction-mode,
executor, MCP dispatch, and permission regression suite passed **466 tests across
14 files**. Electron/CLI builds and TypeScript checking passed.
