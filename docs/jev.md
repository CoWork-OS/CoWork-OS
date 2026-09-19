# Jev Decision Support and Harness

Jev is an optional structured-decision service for CoWork OS. Jev can help
CoWork choose an execution strategy, model profile, agent team, or parallel
lane; select a grounded prefix of a browser-action batch; and provide an
opt-in review layer for selected tool calls and bounded no-progress checks.
The configured chat model still runs the agents, uses the tools, and writes
the final response.

Jev is therefore a decision route, not a replacement for the normal model
route or the local policy engine. It is useful when a task benefits from
several complementary roles, when a bounded task should be routed to the
least-cost eligible model profile, or when an operator wants additional
context on high-impact tool calls. It does not execute the work or become the
source of permission authority.

See the provider's [Jev Latest model page on OpenRouter](https://openrouter.ai/~typesafe/jev-latest)
and the [TypeSafe API documentation](https://docs.typesafe.ai/api).
For implementation evidence and the latest live comparison, see the [JEV
Harness Validation Record](jev-harness-validation.md).

## What Jev does in CoWork

When automatic team selection is enabled and CoWork is starting a
multi-agent collaboration, the flow is:

1. CoWork reads the task and the active agent-role catalog.
2. CoWork narrows the catalog to relevant candidates.
3. Jev returns typed choices for the team members and leader.
4. CoWork creates the team and delegates the work through the normal
   orchestration graph.
5. The configured chat model executes the child tasks and synthesizes the
   result.

The decision request is structured: Jev returns typed choices, probabilities,
and confidence data, not a free-form plan or an agent response. Jev does not
select permissions, approve actions, run tools, or replace the model configured
under **Model Access**.

Jev is used for team selection in collaborative multi-agent work, including
the **Collaborative** mode and `/multitask` runs. When the optional harness is
**Active**, an eligible foreground task may also call Jev while it is still a
single-agent candidate. The adaptive strategy decision can keep it single
agent or promote it to a team, multitask run, or verification pass. A task
that is explicitly orchestrated, delegated, background, low-complexity, or
already has a fixed strategy remains on its existing route.

### Decision authority model

Jev is always downstream of CoWork's deterministic runtime. CoWork first
determines what is eligible, what tools are available, which access profile
applies, and whether hard policy or security blocks the operation. Jev can
choose or rank only within that bounded set:

| Boundary | Jev may decide | CoWork still owns |
| --- | --- | --- |
| Model routing | `cheap` versus `strong` for an eligible task | Explicit model/profile choices, provider failover, and model execution |
| Task strategy | Single agent, team, multitask, or verification | Eligibility, role availability, queue limits, and orchestration |
| Team and lane selection | Eligible roles, leader, and bounded lane candidates | Role catalog, task scope, child prompts, and synthesis |
| Tool review | Benign, concerning, uncertain, or unavailable observation | Permission, approval, hard policy, Numbat security, and tool execution |
| Browser action selection | A safe prefix of unchanged snapshot-bound candidates | Browser session state, stale/sensitive/destructive checks, and approvals |
| Loop control | Continue, change strategy, stop, or ask at a warning checkpoint | Hard budgets, circuit breakers, cancellation, and terminal state |
| Context retention | Keep/drop choices from a bounded compaction candidate set | Pinned/tool-pair context, transcript, summary, and token budget |
| Skill/tool reranking | Order already eligible candidates | Availability, policy filtering, explicit invocation, and tool catalog |
| Output guardrails | Pass, revise, verify, clarify, or block-publication advice | Evidence checks, policy, verification, artifacts, and final authority |

An abstention, timeout, provider error, cache miss, circuit-open result, or
budget exhaustion never grants authority. The caller applies the safe fallback
for that boundary.

## Configure Jev

Jev is disabled by default. Open **Settings > AI & Models > Jev**. Keep the
normal chat provider configured separately under **Settings > AI & Models >
Model Access**; that route is still required to do the work after a team is
selected.

To use the optional harness without team selection, enable **Enable optional
JEV harness**, choose **Observe** or **Active** under **Contextual tool review**,
and save. Active mode also supplies Jev for the bounded team and lane decisions
used by Collaborative mode and `/multitask`. In Active mode, Jev may also
route an otherwise single-agent foreground task to the least-cost eligible
model profile and promote it to a team, multitask, or verification strategy
when the bounded decision is confident and CoWork has enough eligible roles;
explicit, child, and background tasks remain untouched.

The individual **Active harness decisions** checkboxes are enabled by default
when omitted from saved settings. Turning one off disables only that decision
family; it does not disable the provider, the other decision families, or
local policy enforcement.

| Settings control | Saved field | Effect |
| --- | --- | --- |
| Enable Jev decision support | `enabled` | Allows the configured Jev provider to be resolved. |
| Provider route | `provider` | Selects `typesafe` or `openrouter`. |
| Use Jev for automatic agent-team selection | `teamSelectionEnabled` | Enables structured team/leader selection independently of the harness. |
| Enable optional JEV harness | `harnessEnabled` | Enables the tool-review and bounded harness surface. |
| Contextual tool review | `toolReviewMode` | `off`, `observe`, or `active`; Active is required for Jev decisions to influence bounded routing/escalation. |
| Active harness decisions | `modelRoutingEnabled`, `adaptiveStrategyEnabled`, `browserActionSelectionEnabled`, `loopControlEnabled`, `contextCompactionEnabled`, `skillToolSelectionEnabled`, `outputGuardrailsEnabled` | Enables or disables each decision family; omitted values default to enabled when the harness is active. |

### Option A: OpenRouter

This is the simplest route when CoWork already uses OpenRouter for normal
tasks.

1. In **Settings > AI & Models > Model Access > OpenRouter**, enter and save
   the OpenRouter API key. Choose and test a normal chat model there.
2. Open **Settings > AI & Models > Jev** and set **Provider route** to
   **OpenRouter**.
3. Leave **Reuse the OpenRouter API key from OpenRouter settings for Jev**
   enabled. No second Jev key is required.
4. Keep the base URL as `https://openrouter.ai` and the model as
   `~typesafe/jev-latest` unless you have a specific supported model choice.
5. Click **Enable Jev decision support**. Enable **Use Jev for automatic
   agent-team selection** if you want Jev to compose teams, enable the optional
   harness and choose **Observe** or **Active** if you want harness decisions,
   then click **Save** and **Test Jev Connection**.

The reused key is accepted only with the official HTTPS OpenRouter host. This
prevents a credential saved for the main OpenRouter route from silently being
sent to an unrelated endpoint.

### Option B: TypeSafe API

1. In **Settings > AI & Models > Jev**, set **Provider route** to **TypeSafe
   API**.
2. Enter the TypeSafe API key.
3. Keep the base URL as `https://api.typesafe.ai` and the model as
   `jev-latest`, or enter the values supplied by TypeSafe.
4. Enable Jev. Enable automatic team selection if desired, configure the
   optional harness if desired, click **Save**, and run **Test Jev Connection**.

The TypeSafe credential is stored separately from the main chat provider and
from the OpenRouter credential.

The connection test makes a small authenticated decision request through the
selected route. A successful result shows the provider, model, and latency.
It verifies Jev transport and authentication; it does not guarantee that a
later chat-model request, tool call, or integration will succeed.

## Use Jev in a task

After configuration:

1. Start a task that can be split into complementary lanes.
2. Turn on **Collaborative** in the composer, or use `/multitask` for a
   one-shot lane fan-out.
3. State the outcome and the kinds of work that need to be coordinated. For
   example:

   ```text
   Review this repository's authentication change. Have one agent inspect the
   implementation, another assess security risks, and another design the
   focused test plan. Return one prioritized set of changes.
   ```

   Or:

   ```text
   /multitask 3 Compare the three proposed data-import designs, evaluate their
   operational risks, and recommend one with a rollout plan.
   ```

4. Watch the task timeline. CoWork reports whether the team came from Jev,
   the normal chat-model selector, or the keyword fallback.

The selected roles are still subject to the parent task's access profile,
approval rules, workspace boundaries, and global queue limits. Jev cannot
widen those policies.

## Optional harness modes

Users who have enabled Jev can also enable **Optional JEV harness** and set
**Contextual tool review** to **Observe**. CoWork then sends a small,
redacted, bounded decision request for selected higher-risk calls after local
policy, permission, and security checks have allowed the call. The result is
recorded in the local tool-policy trace as benign, concerning, uncertain, or
unavailable.

**Observe** is telemetry-only. A Jev result cannot grant an approval, bypass a
denial, change Numbat's security decision, or alter tool execution. Ordinary
read-only calls are not sent, and provider failure or missing credentials
leaves the normal tool path unchanged.

**Active** uses Jev for bounded harness decisions. For team selection and lane
planning, Jev chooses only among candidates already made eligible by CoWork;
an unavailable or low-confidence result falls directly to deterministic
capability/lane matching instead of making a second generative LLM call. For a
selected higher-risk tool call, only a concerning Jev assessment adds an
approval request. Uncertain or unavailable observations remain advisory so a
bounded context or temporary provider outage does not create a second approval
loop; local permissions, hard policy, and security still decide authority. A
benign assessment preserves the normal policy outcome. Active mode never grants
access, weakens permissions, overrides an independent security denial, or
executes a tool by itself.

### Headless and CLI behavior

`cowork run` and other headless task surfaces use the same JEV provider,
decision service, policy pipeline, and telemetry ledger as the desktop app,
but they do not have a renderer approval prompt. For a trusted task started
with an explicit non-interactive profile such as `--access-profile full_access`,
an active concerning Jev review is retained in the policy trace as an advisory
observation and the already-authorized operation proceeds. This prevents a
second, impossible approval request from deadlocking a headless task.

This exception is narrow: the effective profile must already have
`permissionMode: bypass_permissions` and `approval: never`, and local
permission evaluation must have allowed the exact operation. Missing
authority, hard policy denials, Numbat denials, protected paths, network
restrictions, and mandatory operating-system consent still fail closed. An
interactive task keeps the normal concerning-review path and can receive an
inline approval decision when policy permits it.

When Active mode is enabled, the settings panel also exposes separate controls
for adaptive model routing, adaptive task strategy, snapshot-bound browser
action selection, bounded goal/stuck-loop checks, context compaction retention,
eligible skill/tool reranking, and output/trace guardrails. Adaptive task strategy is
the control that lets Jev decide whether an eligible task should stay
single-agent or use a team, multitask, or verification pass. Cost guards keep
ordinary medium-complexity tasks on the existing single-agent/cheap route unless
the task has explicit parallel, review, verification, or similarly strong
expansion signals.

### Active harness decisions

When enabled, the active controls use one bounded typed decision per stable
boundary and retain the result in the existing task/runtime path:

- **Adaptive model routing** lets Jev choose between CoWork's existing `cheap`
  and `strong` profiles. Explicit models, forced profiles, verification work,
  collaborative/multitask orchestration, and child tasks bypass it. A cost
  guard prevents an unjustified upgrade from `cheap` to `strong` on ordinary
  medium-complexity work.
- **Adaptive task strategy** lets Jev choose single-agent, team, multitask, or
  verification execution for eligible foreground tasks, including tasks that
  initially look single-agent. Low-complexity tasks and explicit,
  child/background, already-collaborative, multitask, multi-LLM, or verification
  tasks bypass the promotion decision. Deterministic eligibility checks still
  decide whether the selected strategy can be applied.
- **Snapshot-bound browser action selection** lets Jev select only unchanged,
  safe candidates from the current browser snapshot. Sensitive, destructive,
  stale, incomplete, or low-confidence selections abstain and leave the
  existing browser and approval path in control.
- **Goal and stuck-loop checks** run only after CoWork's deterministic progress
  and hard-budget checks identify a warning or no-progress condition. Jev may
  suggest continuing, changing strategy, stopping, or asking the user; hard
  caps and deterministic circuit breakers remain authoritative.
- **Context compaction retention** is called only when deterministic compaction
  is already required. Jev may retain or drop a bounded set of older,
  non-pinned, non-tool-pair entries. The original transcript, protected
  messages, hard token budget, and the durable compaction summary remain under
  CoWork's control; the decision manifest is replayable and reversible.
- **Eligible skill/tool reranking** reorders only the deterministic shortlist
  that has already passed availability, requirement, policy, and explicit
  invocation checks. Jev cannot activate a skill, add a tool, widen access, or
  replace an explicit user request.
- **Output and trace guardrails** inspect a bounded candidate response against
  available evidence, required criteria, secret-safety, policy consistency,
  and artifact references. Jev can recommend pass, revise, verification,
  user clarification, or external-publication blocking; deterministic
  verification, policy, and artifact checks remain authoritative.

Every active decision is bounded by a per-service timeout, cancellation path,
concurrency/call budget, short cache, circuit breaker, and local redacted
telemetry. A timeout, provider failure, exhausted budget, or abstention never
turns into a permission grant. Model-routing and strategy failures preserve the
configured route; review and loop-control failures preserve the stricter
deterministic runtime behavior.

The review state is bounded, redacted, labeled as untrusted context, and may
include task intent, tool metadata, and redacted arguments; it should not be
treated as a universal confidence score.

### Which calls are made

The runtime records the decision purpose with each provider call. The usual
purposes are `team-selection`, `lane-planning`, `model-routing`,
`task-strategy`, `tool-review`, `browser-action`, `loop-control`,
`context-compaction`, `skill-tool-selection`, and `output-guardrail`.

Not every task reaches every boundary. For example, tool review is considered
only for selected higher-risk tools and side effects; ordinary read-only
browser calls are excluded. Browser action selection requires a current
snapshot. Loop control runs only after deterministic progress/budget checks
identify a warning. Context retention runs only when deterministic compaction
is already required. Skill/tool reranking receives only the shortlist that
already passed availability and policy checks.

The decision service bounds each family independently. The task and model
gates use one-call, short-lived cached services; semantic tool review uses a
small concurrent budget and a short cache; loop and P2 decisions use their own
bounded services. A cached Jev result is still visible as a decision event,
but its provider-reported token and cost contribution is zero.

## Observability, accounting, and validation

Jev usage is intentionally separate from LLM usage. Each provider call is
stored in the `jev_call_events` table with its purpose, provider/model,
status, latency, request id, input/output tokens, cache flag, and
provider-reported cost. CoWork does not run Jev tokens through the normal LLM
pricing table. Usage Insights therefore reports a separate **Jev usage**
section.

The task timeline can also show `jev_decision` events and the tool-policy trace
records the semantic-review outcome. A successful task alone does not prove
that Jev made a selection: inspect the decision purpose/status and distinguish
`selected` from `abstain`, `unavailable`, or a deterministic fallback.

For a source checkout, validate the complete runtime rather than only the
desktop compiler. The desktop app and direct CLI have separate compiled
Electron trees:

```bash
npm run build:electron
npm run build:cli
npx vitest run \
  src/electron/agent/__tests__/tool-policy-pipeline.test.ts \
  src/electron/agent/__tests__/daemon-jev-routing.test.ts \
  src/electron/database/__tests__/schema-jev-telemetry-migration.test.ts \
  src/electron/agent/jev/__tests__/jev-harness.test.ts
```

For a live comparison, run the same bounded task in two isolated temporary
workspaces: one with the harness off and one with **Active** enabled. Report
wall time, LLM calls/tokens/cost, Jev calls/tokens/cost, completion status,
artifacts, approval errors, and decision purposes separately. Use multiple
runs or medians before making a speed or cost claim; a single run can be
dominated by provider latency, model behavior, cache state, or a safe Jev
abstention.

## Good use cases

Jev is most helpful when the task has a clear primary responsibility plus
meaningful secondary responsibilities:

| Use case                 | Useful team shape                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Repository change        | Implementer or coder leads; reviewer and tester check the change.                                                |
| Security-sensitive work  | Implementer leads; security analyst and verifier inspect risks and evidence.                                     |
| Research and comparison  | Researcher gathers evidence; analyst compares it; reviewer checks the recommendation.                            |
| Product or UI work       | Product/planning role frames the outcome; designer and implementer turn it into a solution; reviewer checks fit. |
| Documentation or reports | Researcher supplies source material; writer produces the artifact; reviewer checks accuracy and completeness.    |
| Operations planning      | Planner or operations role coordinates; security and verification roles review rollout and rollback concerns.    |

Prompts work best when they describe the desired outcome, constraints, and
why multiple perspectives are useful. A simple request such as “summarize
this paragraph” should remain a single-agent task.

## Fallback and visibility

In Observe mode, Jev is deliberately non-blocking. CoWork falls through the
following team-selection paths:

1. Jev structured team selection.
2. The existing chat-model team selector.
3. Deterministic keyword/capability matching.

Fallback can happen when Jev is disabled, the provider is not configured, the
request times out, authentication or transport fails, the response is
invalid, there are not enough candidates, or Jev does not have a sufficiently
confident choice. In Observe mode, the existing chat-model selector remains
the next path. In Active mode, CoWork skips that extra LLM decision and uses
deterministic keyword/capability matching instead. The root task continues
when a fallback can choose a team.

The timeline identifies the source with messages such as:

- `Jev selected ...`
- `Chat-model fallback selected ... after Jev was unavailable or declined ...`
- `Active Jev harness used deterministic capability matching ...`
- `Keyword fallback selected ... after Jev and chat-model selection were unavailable ...`

This means a successful collaborative task does not prove that Jev handled
the decision; check the timeline source when validating a route.

## Boundaries and troubleshooting

- **No second OpenRouter key:** select the OpenRouter Jev route and leave key
  reuse enabled. Save the main OpenRouter credential under Model Access first.
- **401 or missing-key errors:** confirm the selected route has a key and that
  the key was saved in the active CoWork profile.
- **429 or upstream errors:** the decision transport has bounded retry and
  fallback behavior. Test again later or use the existing chat-model and
  keyword paths while the provider is unavailable.
- **Jev test succeeds but a task falls back:** this is expected when a live
  decision request times out, returns a low-confidence choice, or has too few
  suitable active roles. The timeline and Jev usage ledger are the sources of
  truth.
- **A simple task has no Jev call:** low-complexity tasks and fixed,
  orchestrated, child, or background tasks intentionally bypass the relevant
  adaptive decision. Active harness mode is not a requirement that every
  task call the provider.
- **`cowork run` reports `approval_unavailable` or appears to wait forever:**
  confirm that the task uses an explicit profile with the required authority.
  For a source checkout, rebuild both `dist/electron` and `dist/cli` with
  `npm run build:electron && npm run build:cli`; rebuilding only the desktop
  tree leaves the headless CLI on stale policy code.
- **Jev usage is missing from reports:** confirm that the active profile's
  database has `jev_call_events`, then inspect the task's decision events. A
  disabled feature, deterministic eligibility skip, cache hit, provider
  failure, or low-confidence abstention can all produce no billable provider
  call or no selected strategy.
- **Custom endpoint rejected:** Jev requires HTTPS and the official TypeSafe
  or OpenRouter host. Main OpenRouter-key reuse additionally requires
  `https://openrouter.ai`.

Provider charges, eligibility, rate limits, and data-handling terms remain
with TypeSafe or OpenRouter. CoWork does not proxy or resell Jev access.

## API transport reference

CoWork's provider adapters use these default routes:

| Route      | Default endpoint                            | Default model          |
| ---------- | ------------------------------------------- | ---------------------- |
| TypeSafe   | `https://api.typesafe.ai/v1/systemone`      | `jev-latest`           |
| OpenRouter | `https://openrouter.ai/api/alpha/decisions` | `~typesafe/jev-latest` |

The adapters validate the typed Jev response before it can affect team
composition. The normal agent orchestration, tool policy, approvals, and
chat-model execution remain outside the Jev transport.
