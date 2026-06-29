# Mixture of Agents

Mixture of Agents is a virtual LLM provider that lets one task consult several configured models before a final aggregator model answers. It is useful when you want model diversity, stronger review, or a cheaper set of advisor models feeding one high-quality final route.

MoA does not replace provider credentials. It orchestrates the providers you already configured in CoWork OS.

## Where to Configure It

Open **Settings > AI & Models > AI Model**, then choose **Mixture of Agents** in the LLM Provider list.

From this panel you can:

- create and delete MoA presets
- enable or disable each preset
- choose the default preset
- set a display name and description
- choose the aggregator provider/model
- add reference advisor provider/model slots
- tune advisor output limits and concurrency

Enabled presets appear as model choices when **Mixture of Agents** is selected as the active LLM provider. Selecting a preset makes that preset the model route for new tasks.

## Mental Model

Each MoA preset has two layers:

| Layer | What it does | Tool access |
|-------|--------------|-------------|
| Reference advisors | Review the prompt first and produce concise guidance, critiques, alternatives, or domain-specific notes | No tools |
| Aggregator | Receives the original task plus the advisor notes and produces the task response | Original tools and tool choice |

The aggregator is the only model that executes the real task. Advisors are there to improve the aggregator's context, not to call tools or mutate the workspace.

## Runtime Flow

For each MoA request, CoWork OS runs this sequence:

1. Resolve the selected MoA preset.
2. Run the reference advisor slots with tools disabled.
3. Collect advisor outputs into a bounded advisory context block.
4. Append that advisory context as an additional user message.
5. Run the aggregator with the original messages, tools, and `toolChoice`.
6. Merge usage from advisors and aggregator for reporting.

Advisor requests are sent with no tools and `toolChoice: "none"`. The aggregator receives the original tool configuration, so normal agentic execution still happens through the final route.

The advisory context is appended as a separate user message instead of rewriting previous messages. This preserves tool-result turn structure for providers that validate tool call history strictly.

## Preset Fields

| Field | Purpose |
|-------|---------|
| Name | The preset label shown in the model picker |
| Description | Optional operator note for what the preset is for |
| Enabled | Whether the preset can be selected for tasks |
| Default preset | The preset CoWork should choose by default for MoA |
| Aggregator | The final provider/model that answers and can use tools |
| Reference advisors | Provider/model slots consulted before the aggregator |
| Max reference tokens | Per-advisor output budget |
| Max reference chars per model | How much advisor text can enter the aggregator context |
| Concurrency | How many advisor calls can run at the same time |

Reference slots can also carry a short role instruction, such as "focus on security risk" or "check factual assumptions". Keep those instructions narrow. Broad role prompts make advisors verbose and less useful.

## Recommended Presets

Good default setup:

- one strong aggregator with reliable tool calling
- one to three diverse advisors
- cheap or fast advisors when latency matters
- at least one advisor from a different provider family when you want real diversity

Examples:

| Preset | Aggregator | Advisors |
|--------|------------|----------|
| Coding review | OpenAI or Azure OpenAI GPT route | Claude, Gemini, OpenRouter coding model |
| Research synthesis | Claude or OpenAI | Gemini, OpenRouter, local Ollama |
| Low-cost drafting | A capable mid-tier model | one cheap model plus one local model |

Avoid adding many advisors by default. Latency and cost scale with the number of advisor calls plus the aggregator call.

## Failover Behavior

MoA has two failover levels.

First, each slot honors the failover chain configured for that slot's provider. If the aggregator is OpenAI and OpenAI has Azure OpenAI configured as its backup, the MoA aggregator slot can try OpenAI first and then Azure OpenAI if OpenAI fails.

Second, the MoA provider itself can have its own provider failover chain. This is for falling back from the whole MoA route to another provider/model after the preset fails.

MoA does not automatically inherit global fallback providers. Configure MoA provider failover explicitly only when you want the entire preset to fall back after MoA cannot complete.

Advisor failures are tolerated. CoWork records a compact "reference call failed" note and continues with the remaining advisors and aggregator. Aggregator failure is fatal unless the aggregator slot has a working fallback candidate.

## Caching

Reference advisor outputs are cached briefly for repeated identical MoA prompt/preset inputs. The current runtime cache is short lived:

- 10 minute TTL
- up to 64 cached reference entries

The cache is meant to reduce repeated advisor cost during near-identical turns. It is not durable memory and is cleared with process lifetime.

## Tools and Images

Advisors do not receive tools. If a task requires file edits, shell commands, browser actions, or MCP tools, those actions happen only after the aggregator chooses to call tools.

For multimodal turns, advisors receive a text-rendered transcript of the request. The aggregator receives the original messages plus advisory context, so image-capable aggregators can still use the original visual inputs where the underlying provider supports them.

## Limits and Safety

- MoA presets cannot recursively reference MoA as a slot provider.
- A preset needs an aggregator and at least one advisor.
- Advisor outputs are clipped before entering the aggregator prompt.
- Costs and latency are additive across advisors and aggregator.
- Tool use belongs to the aggregator, so choose a tool-capable aggregator for execution tasks.

## Testing in the UI

1. Configure and test the underlying providers first.
2. Open **Settings > AI & Models > AI Model > Mixture of Agents**.
3. Create a preset with one aggregator and one or two advisors.
4. Save settings.
5. Select **Mixture of Agents** as the provider and choose the preset as the model.
6. Run a small task, such as:

   ```text
   Compare two implementation approaches for a small settings UI change and recommend one.
   ```

With developer logging enabled, a healthy run shows:

- `[LLM:moa] ... start`
- advisor provider calls with `toolsOffered: 0` and `toolChoice: 'none'`
- an aggregator provider call with the original tool count and tool choice
- `[LLM:moa] ... success`

For a tool-use task, the advisor calls should still show no tools, while the aggregator can call tools normally.

## Corporate TLS and Zscaler

On corporate Macs, OpenAI or ChatGPT OAuth requests can fail inside Electron/Node when a network filter such as Zscaler installs a company root certificate that Node does not trust by default.

For macOS development runs, `npm run dev` enables Node's system certificate store by default with:

```bash
NODE_OPTIONS=--use-system-ca
```

You can disable that behavior for comparison:

```bash
COWORK_DEV_USE_SYSTEM_CA=0 npm run dev
```

If OpenAI still fails with `fetch failed`, export your company's Zscaler/root CA certificate to a PEM file and run:

```bash
NODE_EXTRA_CA_CERTS=/path/to/zscaler-root.pem npm run dev
```

This affects OpenAI inside MoA the same way it affects normal OpenAI provider calls, because MoA uses the same provider implementation for each slot.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| The MoA provider is visible but no preset is selectable | No enabled preset | Create or enable a preset, then save settings |
| Advisors run but the task fails | Aggregator failed | Test the aggregator provider directly or add slot failover |
| OpenAI works outside MoA but fails inside MoA | Stale dev run, slot fallback, or TLS trust mismatch | Restart the dev app, verify the selected preset, and check developer logs |
| Advisor calls try to use tools | Bug or stale build | Restart after pulling/building and verify logs show `toolsOffered: 0` |
| MoA falls back to an unexpected provider | Provider-level failover is configured for a slot or MoA provider fallback is configured | Review both the slot provider's failover chain and the MoA provider failover panel |

For current failures, turn on **Settings > Appearance > Developer logging** or start with:

```bash
npm run dev:log
```

Then inspect `logs/dev-latest.log` and `logs/dev-latest.jsonl`.
