# CoWork OS Positioning and Go-to-Market Strategy

Last reviewed: 2026-08-27

## Canonical Positioning

**CoWork OS is the free, open-source AI super app for real work.** It brings coding,
research, browser work, inbox, documents, spreadsheets, presentations, channels,
automations, and agents into one GUI-first, CLI-capable workspace.

Underneath that super app is an open, multi-provider agent harness. Users can connect
supported provider accounts, API keys, compatible gateways, cloud credentials, or local
models and keep the same CoWork tools, memory, agents, approvals, artifacts, and workflows
as they change model routes.

Short line:

> **One app for the work. Your choice of AI.**

Supporting line:

> Bring the AI access you already have. CoWork OS is free; provider eligibility, limits,
> and usage charges remain with each provider.

## Message Architecture

| Layer | Approved message | What it explains |
| --- | --- | --- |
| Category | Free, open-source AI super app / everything app | What CoWork OS is |
| User benefit | One workspace for real work across code, browser, inbox, files, artifacts, and automation | Why it matters |
| Differentiator | Open, multi-provider, and MIT-licensed | Why CoWork is structurally different |
| Technical engine | One agent harness across supported model routes | How model flexibility works |
| Access promise | Supported subscriptions/accounts, APIs, gateways, cloud credentials, and local models | What users can bring |
| Continuity promise | Keep tools, skills, memory, approvals, agents, artifacts, and workflows when routes change | The practical advantage |
| Trust | Local-first state, visible execution, policies, approvals, and source access | Why users can rely on it |

The relationship should always be explained in this order:

```text
supported accounts · APIs · gateways · cloud credentials · local models
                                  ↓
                   open multi-provider agent harness
                 tools · memory · agents · policy · routing
                                  ↓
                         CoWork OS super app
          code · browser · inbox · docs · data · automation · channels
```

“Agent harness” is a technical and comparison term. It must support—not replace—the
plain-language super-app category on acquisition and onboarding surfaces.

## Positioning Pillars

### 1. One super app for real work

CoWork keeps the task, the tools, and the output together. A user can move from research
to code, a browser check, an inbox action, a document, a spreadsheet, a deck, or an
automation without rebuilding context in a separate AI product.

### 2. Your choice of AI

CoWork is not defined by a single model vendor. Users choose from supported access routes,
switch per task, compare models, configure routing, or add ordered fallback providers.
Model-specific capabilities and commercial terms still apply.

### 3. One harness across model strengths

The surrounding work environment—tools, skills, memory, policies, approvals, agents,
artifacts, and workspace context—belongs to CoWork. Changing a model route should not mean
changing the operating system around the work.

### 4. GUI-first, CLI-capable, headless-ready

The desktop application is the primary visual operator console. The `cowork` CLI and
headless daemons extend the same runtime to terminals, servers, and remote operations.

### 5. Open control and visible governance

CoWork is MIT-licensed and local-first. Execution remains inspectable through timelines,
approvals, policies, sandboxes, and explicit remote-provider boundaries.

## Audience

Primary audiences:

- AI power users who currently split work across several model apps and agent harnesses.
- Developers who want coding agents without making the coding tool their entire workspace.
- Operators, founders, and knowledge workers who need files, browser work, communication,
  automations, and agents in the same environment.
- Teams that need model flexibility, visible approvals, and a path to local or self-hosted
  operation.

## Competitive Frame

### Coding agents

Claude Code, Codex, Cursor, and OpenCode are primarily evaluated as coding environments or
coding-agent harnesses. CoWork should not claim automatic coding superiority. Its durable
contrast is a broader work surface: code plus inbox, research, browser, office artifacts,
channels, automations, agents, and headless operations.

### AI workspaces and super apps

ChatGPT and Claude Cowork increasingly span knowledge work, files, connectors, artifacts,
automation, browser use, and project work. CoWork competes in that broad category while
differentiating through MIT licensing, model-route flexibility, optional local inference,
CLI/headless operation, and user-controlled runtime state.

### Open personal-agent systems

OpenClaw and Hermes are open, multi-provider peers. CoWork should differentiate through its
GUI-first Everything Workbench, artifact editing, inbox and channels, visual approvals,
operator surfaces, and the combination of desktop, CLI, and headless modes—not simply by
claiming to be open or multi-provider.

Comparison content must be fit-based:

- “Choose them when …”
- “Choose CoWork when …”
- “Use both when …”

## Claim Guardrails

| Topic | Approved wording | Do not claim |
| --- | --- | --- |
| Price | “CoWork OS is free and MIT-licensed. Provider usage may cost money.” | “All AI is free.” |
| Breadth | “Dozens of model routes and compatible endpoints.” | “Every LLM” or “all models.” |
| Accounts | “Supported account-based and subscription routes.” | “Any subscription.” |
| Lock-in | “Reduce model-provider lock-in.” | “No lock-in.” |
| Locality | “Local-first persistence with optional local inference.” | “Everything is fully local.” |
| Credentials | “Credentials are stored locally and sent only to the configured provider or gateway for authentication.” | “Keys never leave the device.” |
| Analytics | “No mandatory product analytics by default.” | “No telemetry.” |
| Capability | “One harness across different model strengths.” | “Every model supports identical features.” |
| Competition | “A broader open workspace for users who want model choice.” | “Better than every harness.” |

Use stable capability language instead of hardcoded provider, channel, skill, connector, or
test counts unless the number is generated from a canonical released source.

## Provider and Access Proof

`docs/providers.md` is the public contract for model access. It must distinguish:

1. Supported account or subscription routes.
2. Direct API-key routes.
3. Compatible gateways and cloud credentials.
4. Local inference.
5. Delegated external agent runtimes.

Every marketed route needs a current smoke check for setup, model discovery, text response,
streaming, tool use where supported, refresh or expiry behavior, logout/disconnect, and
clear entitlement/billing errors.

## Comparison Evidence Policy

Comparison pages must use official sources and record:

- Product and version or release channel.
- Claim being made.
- Source URL.
- Verification date.
- Stable, experimental, beta, or planned status.
- Review owner and next review date.

Use “alternative” for proprietary or single-vendor products. Use neutral “vs” language for
open-source peers such as Codex, OpenCode, OpenClaw, and Hermes.

## Acquisition Surfaces

All high-signal surfaces must share the same hierarchy:

1. Website hero and social preview.
2. README and npm description.
3. Documentation homepage and metadata.
4. First-run onboarding.
5. AI & Models / Model Access settings.
6. About & Updates.
7. Comparison and migration pages.

Historical changelog and release-note entries should remain historical. Apply this
positioning to current summaries and the next release entry only.

## Success Criteria

The positioning is working when a new user can answer three questions after the first
screen:

1. What is CoWork OS? — A free, open-source AI super app for real work.
2. Why is it different? — One open harness across supported model routes.
3. What can I use with it? — Supported accounts, APIs, gateways, cloud credentials, and
   local models, with provider terms and charges remaining separate.
