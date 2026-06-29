# LLM Providers & Costs (BYOK)

CoWork OS is **free and open source**. To run tasks, configure your own model credentials or use local models.

> **First-run recommendation**: Start with **Sign in with ChatGPT** if you already have a ChatGPT subscription, or use a detected local Ollama model if one is installed. API-key providers, including OpenRouter, Claude, Gemini, Groq, and OpenAI API, are available in **Settings > AI & Models**. The onboarding provider picker marks OpenRouter, Gemini, and Groq with **Free** where a free usage path is available. You can explore the app without AI, but running tasks requires one connected and tested model route.

<p align="center">
  <img src="../resources/branding/images/cowork-os-10.webp" alt="LLM provider settings" width="700">
  <br><em>Provider settings centralize built-in models, compatible gateways, authentication, and fallback routing.</em>
</p>

## Built-in Providers

| Provider | Configuration | Billing |
|----------|---------------|---------|
| Claude | Claude API key or Claude subscription token in Settings | API: pay-per-token; subscription: uses your Claude account |
| Azure Anthropic | API key + endpoint + deployment in Settings | Pay-per-token via Azure |
| Google Gemini | API key in Settings | Free usage available through Google AI Studio subject to Google's current limits; pay-per-token beyond free limits |
| OpenRouter | API key in Settings (default provider) | Free model options available; pay-per-token for premium models |
| DeepSeek | API key in Settings | Provider billing |
| OpenAI (API Key) | API key in Settings | Pay-per-token |
| OpenAI (ChatGPT OAuth) | Sign in with ChatGPT account | Uses your ChatGPT subscription |
| AWS Bedrock | AWS credentials in Settings (auto-resolves inference profiles) | Pay-per-token via AWS |
| Azure OpenAI | API key + endpoint in Settings | Pay-per-token via Azure |
| Mixture of Agents | Presets composed from already-configured providers | No separate billing; each selected provider bills normally |
| Ollama (Local) | Install Ollama and pull models | **Free** (runs locally) |
| HuggingFace Local AI | Install `hf-agents` and run `llama.cpp` locally | **Free** (runs locally) |
| Groq | API key in Settings | Free usage available subject to Groq's current limits; pay-per-token beyond free limits |
| xAI (Grok API) | API key in Settings | Pay-per-token |
| xAI Grok OAuth (SuperGrok Subscription) | Browser sign-in in Settings | Uses your active SuperGrok subscription |
| Kimi (Moonshot) | API key in Settings | Pay-per-token |
| Pi (Multi-LLM) | Unified API via pi-ai | Routes to multiple providers |

## Compatible / Gateway Providers

| Provider | Configuration | Billing |
|----------|---------------|---------|
| OpenCode Zen | API key + base URL in Settings | Provider billing |
| Google Vertex | Access token + base URL in Settings | Provider billing |
| Google Antigravity | Access token + base URL in Settings | Provider billing |
| Google Gemini CLI | Access token + base URL in Settings | Provider billing |
| Z.AI | API key + base URL in Settings | Provider billing |
| GLM | API key + base URL in Settings | Provider billing |
| Vercel AI Gateway | API key in Settings | Provider billing |
| Cerebras | API key in Settings | Provider billing |
| Mistral | API key in Settings | Provider billing |
| GitHub Copilot | GitHub token in Settings | Subscription-based |
| Moonshot (Kimi) | API key in Settings | Provider billing |
| Qwen Portal | API key in Settings | Provider billing |
| MiniMax | API key in Settings | Provider billing |
| MiniMax Portal | API key in Settings | Provider billing |
| Xiaomi MiMo | API key in Settings | Provider billing |
| Venice AI | API key in Settings | Provider billing |
| Synthetic | API key in Settings | Provider billing |
| Kimi Code | API key in Settings | Provider billing |
| Kimi Coding | API key in Settings | Provider billing |
| OpenAI-Compatible (Custom) | API key + base URL in Settings | Provider billing |
| Anthropic-Compatible (Custom) | API key + base URL in Settings | Provider billing |

**Your usage is billed directly by your provider.** CoWork OS does not proxy or resell model access.

---

## Ordered LLM Fallback Chains

CoWork OS can route a task through an explicit provider/model fallback chain instead of relying on a single primary provider.

Configure this in **Settings > AI & Models**:

- choose your primary provider/model
- add fallback providers in order
- optionally choose capability-based routing for workflow phases or specialized tasks

Fallback chains are used when a provider is unavailable, rate-limited, rejected by policy, or lacks the required capability for the task. Runtime surfaces in the app and Mission Control show the active provider, routing reason, and whether a fallback occurred.

For LLM chains, retryable provider failures such as `429` rate limits and transient upstream errors move execution to the next configured provider/model in the ordered list. Once a fallback route is active, CoWork OS preserves that working route briefly so retries do not immediately bounce back to the primary provider.

You can control when the primary route is tried again in **Settings > AI & Models > Provider Failover > Retry primary after (seconds)**:

- leave it blank to use the default 60-second cooldown
- set it to `0` to retry the primary on the next route refresh
- set a value up to `3600` seconds to keep the active fallback route longer before probing the primary again

---

## Mixture of Agents

Mixture of Agents is a virtual LLM provider for preset-based model collaboration. A preset runs one or more reference advisor models first, then passes their bounded advisory notes to a final aggregator model that answers the task.

Configure it in **Settings > AI & Models > AI Model > Mixture of Agents**:

- create an enabled preset
- choose the aggregator provider/model
- add reference advisor provider/model slots
- tune advisor token limits, advisory context size, and advisor concurrency
- save settings, then select **Mixture of Agents** as the provider and the preset as the model

Advisor calls are intentionally tool-free. The aggregator receives the original task messages, tools, and tool choice, so workspace edits, shell commands, browser actions, and MCP calls still happen through the final route.

MoA has two failover layers:

- slot-level failover from each selected provider's own fallback chain
- optional MoA-provider failover for falling back from the whole preset to another provider/model

MoA does not automatically inherit global fallback providers. Configure MoA provider failover only when you want the entire preset to fall back after the MoA route fails.

See [Mixture of Agents](mixture-of-agents.md) for preset design, runtime behavior, UI testing, and corporate TLS troubleshooting.

---

## Prompt Caching

CoWork OS enables prompt caching by default in `auto` mode for supported model routes. The cacheable prefix is built from session-scoped prompt sections, while volatile turn context stays outside the stable prefix so follow-ups and routed turns can keep reusing the same provider-side foundation.

### Strategy by provider family

- **Claude API / Azure Anthropic / Anthropic-compatible**: CoWork sends structured `systemBlocks` and prefers Anthropic automatic caching. If a route rejects automatic cache control, the session downgrades to explicit Anthropic breakpoints.
- **OpenRouter Claude**: CoWork uses explicit cache breakpoints over the stable system prefix plus the last 3 non-system messages, with a maximum of 4 total breakpoints.
- **OpenAI / Azure OpenAI**: CoWork derives a deterministic stable-prefix cache key and sends it through OpenAI-style prompt-cache fields. This keeps GPT routes such as `gpt-5.4` and `gpt-5.4-mini` aligned under the same stable-prefix strategy.
- **OpenRouter GPT-style routes**: CoWork participates in the same stable-prefix partitioning and cache-epoch tracking, but without Anthropic-specific markers.

### What stays cacheable

Cacheable prefix material comes from stable session-scoped sections such as:

- identity and safety core
- workspace / worktree context
- mode and task-domain contracts
- role, personality, and guidelines
- tool policy and rendered tool schema

Dynamic turn-scoped material such as current time, layered memory sections (`<cowork_hot_memory>`, `<cowork_structured_memory>`), and turn guidance is intentionally kept outside the stable prefix. Session transcript recall, verbatim quote recall, archive recall, and topic-pack recall are tool-driven, so they only enter the active turn after explicit `search_sessions`, `search_quotes`, `search_memories`, or `memory_topics_load` use.

### Defaults and overrides

- Default mode: `auto`
- Default TTL: `5m`
- Optional long TTL: `1h`
- Advanced disable: set `promptCaching.mode` to `off` in saved LLM settings or launch with `COWORK_PROMPT_CACHE_MODE=off`
- Advanced TTL override: `COWORK_PROMPT_CACHE_TTL=5m|1h`

### Telemetry

When an upstream provider reports prompt-cache usage, CoWork records:

- `cachedTokens`: tokens served from the provider cache
- `cacheWriteTokens`: tokens spent creating or extending the cache entry, when available

These values flow into Usage Insights and cost accounting.

---

## Adaptive Output Budgeting

When `COWORK_LLM_OUTPUT_POLICY=adaptive` is enabled, CoWork OS applies a shared output-budget policy for agentic execution turns across the main provider families instead of relying on provider defaults.

### What it covers

The current rollout resolves explicit output limits for:

- Anthropic-family routes
- Bedrock Claude routes
- OpenAI routes
- Azure OpenAI routes
- Gemini routes
- OpenRouter routes
- a conservative generic fallback for the remaining providers

This policy currently targets execution and follow-up turns first. Explicit chat keeps its separate behavior for now, and `legacy` mode preserves the older executor path.

### Default request budgets

Internal defaults are:

- first execution turn: `8000`
- tool-follow-up turn: `16000`
- one-shot escalated retry after truncation: `48000`
- one-shot escalated retry for Anthropic-family routes: `64000`
- generic fallback escalation: `16000`

Budget selection is resolved in this order:

1. task-level `agentConfig.maxTokens`, when present
2. `COWORK_LLM_MAX_OUTPUT_TOKENS`
3. adaptive family defaults
4. final clamping by known hard caps and context headroom

### Transport fields by provider shape

CoWork maps the chosen budget into the provider-appropriate request field:

- `max_tokens` for Anthropic-style, OpenRouter-style, and most compatible chat-completions routes
- `max_completion_tokens` for newer OpenAI-style reasoning/chat-completions routes
- `max_output_tokens` for Gemini and OpenAI-style responses routes

This mapping is resolved centrally so execution behavior stays consistent even when providers differ in field names.

### Truncation recovery behavior

If an execution turn hits the output limit:

1. CoWork retries the same request once with a larger budget
2. if the retried response still truncates but contains visible partial output, CoWork falls back to a continuation prompt
3. if the retried response contains only reasoning or no usable answer text, CoWork stops retrying continuations and surfaces targeted guidance instead

This avoids wasting turns on repeated truncation loops that produce no visible answer.

### Internal controls

This rollout is currently controlled by environment flags rather than UI settings:

- `COWORK_LLM_OUTPUT_POLICY=legacy|adaptive`
- `COWORK_LLM_MAX_OUTPUT_TOKENS`
- `COWORK_LLM_AGENTIC_INITIAL_MAX_TOKENS`
- `COWORK_LLM_AGENTIC_ESCALATED_MAX_TOKENS`

`COWORK_LLM_OUTPUT_POLICY` defaults to `legacy` unless explicitly set. `COWORK_LLM_TOOL_RESPONSE_MAX_TOKENS` remains available for legacy compatibility but is no longer the primary behavior in adaptive mode.

---

## Azure Anthropic

Use Azure-hosted Claude models through your Azure subscription.

### Setup

1. Deploy a Claude model in your Azure AI Studio account.
2. Open **Settings** > **LLM** and select **Azure Anthropic**.
3. Enter your Azure API key, endpoint URL (e.g. `https://<resource>.services.ai.azure.com`), and deployment name.

### Notes

- Uses the Anthropic messages API format, not the Azure OpenAI format.
- Separate from the existing **Azure OpenAI** provider — use this for Claude models, Azure OpenAI for GPT models.
- All billing goes through your Azure subscription.

---

## Ollama (Local LLMs)

Run completely offline and free.

### Setup

```bash
brew install ollama
ollama pull llama3.2
ollama serve
```

### Recommended Models

| Model | Size | Best For |
|-------|------|----------|
| `llama3.2` | 3B | Quick tasks |
| `qwen2.5:14b` | 14B | Balanced performance |
| `deepseek-r1:14b` | 14B | Coding tasks |

---

## HuggingFace Local AI (`hf-agents` + `llama.cpp`)

Run compatible local models through CoWork's HuggingFace Local AI provider.

### Setup

```bash
pip install huggingface_hub
hf extensions install hf-agents
```

Then open **Settings** > **LLM**, choose **HuggingFace Local AI**, select or enter a model, and start the local `llama.cpp` server from the provider panel.

### Notes

- Default local endpoint: `http://localhost:8080`
- API key is optional for local runs
- Best fit when you want a private local provider but do not want to depend on Ollama

---

## Google Gemini

1. Get API key from [Google AI Studio](https://aistudio.google.com/apikey)
2. Configure in **Settings** > **Google Gemini**

Models: `gemini-2.0-flash` (default), `gemini-2.5-pro` (most capable), `gemini-2.5-flash` (fast)

---

## OpenRouter

Access multiple AI providers through one API.

1. Get API key from [OpenRouter](https://openrouter.ai/keys)
2. Configure in **Settings** > **LLM** > **OpenRouter**

Available: Claude, GPT-4, Gemini, Llama, Mistral, and more — see [openrouter.ai/models](https://openrouter.ai/models)

### Pareto Code Router

OpenRouter's Pareto Code Router is available as a normal OpenRouter model selection, not as a separate provider:

| Model ID | Display name | Use when |
|----------|--------------|----------|
| `openrouter/pareto-code` | Pareto Code Router | You want OpenRouter to choose a strong coding model from its coding frontier |
| `openrouter/pareto-code:nitro` | Pareto Code Router (Nitro) | You want the same coding-score routing, but prefer the fastest measured model in the selected tier |

When one of those models is selected, **Settings > AI & Models > OpenRouter** shows a **Pareto Router** field for the optional minimum coding score.

- `min_coding_score` is a decimal number from `0` to `1`; do not enter percentages such as `80`.
- Leave the field blank to let OpenRouter use its default strongest/high coding tier.
- Current OpenRouter tiers are `>= 0.66` for high, `0.33` to `< 0.66` for medium, and `< 0.33` for lower-cost low-tier routing.
- The score is sent through OpenRouter's `pareto-router` plugin only for `openrouter/pareto-code` and `openrouter/pareto-code:nitro`.
- In headless or VPS installs, pass the same value through Control Plane as `settings.paretoMinCodingScore`, for example `{"providerType":"openrouter","model":"openrouter/pareto-code","settings":{"paretoMinCodingScore":0.8}}`.
- The response `model` field can report the concrete underlying model that handled the request, so usage and cost records may show a Claude, GPT, Gemini, DeepSeek, or other routed model rather than the router id.
- The fallback local catalog lists both Pareto models with OpenRouter's documented `200,000` token context. When the live OpenRouter model catalog returns metadata, CoWork keeps the live catalog value instead of overriding it.

The Pareto Router itself adds no extra fee. Billing follows whichever underlying OpenRouter model handles the request, so cost can vary by tier and availability.

Reference: [OpenRouter Pareto Router docs](https://openrouter.ai/docs/guides/routing/routers/pareto-router) and [Pareto Code Router model page](https://openrouter.ai/openrouter/pareto-code).

CoWork OS also sends OpenRouter app attribution headers by default so usage is associated with the app in OpenRouter analytics and rankings. The current defaults are:

- `HTTP-Referer: https://github.com/CoWork-OS/CoWork-OS`
- `X-OpenRouter-Title: CoWork OS`
- `X-Title: CoWork OS`
- `X-OpenRouter-Categories: personal-agent,programming-app`

The category pairing is intentional: CoWork OS is positioned primarily as a personal AI agent, with programming workflows as a secondary fit.

For prompt caching, OpenRouter Claude routes use explicit Anthropic-style cache breakpoints, while GPT-style OpenRouter routes participate in the shared stable-prefix prompt-cache pipeline.

---

## OpenAI / ChatGPT

- **Option 1: API Key** — Standard pay-per-token access to GPT models
- **Option 2: ChatGPT OAuth** — Sign in with your ChatGPT subscription

---

## xAI / Grok

CoWork OS supports Grok through either direct xAI API billing or a browser OAuth login that uses your active SuperGrok subscription.

### Option 1: SuperGrok Subscription

Use this when you already have a Grok/SuperGrok subscription and do not want to manage an `XAI_API_KEY`.

1. Open **Settings** > **LLM**.
2. Select **Grok OAuth** or open the **xAI** provider panel and choose **SuperGrok Subscription**.
3. Click **Sign in with Grok**.
4. Complete the xAI browser sign-in and consent flow.
5. Keep the default model `grok-4.3`, or select another listed Grok chat model.
6. Click **Test Connection**, then save settings.

CoWork stores the OAuth tokens in encrypted LLM settings for the current profile and refreshes the access token before model calls. Logging out from the same panel clears the stored xAI OAuth tokens without removing an xAI API key.

### Option 2: xAI API Key

Use this when you want pay-per-token API billing through the xAI developer console.

1. Create or copy an API key from [xAI Console](https://console.x.ai/).
2. Open **Settings** > **LLM** and select **xAI API Key**.
3. Paste the key, click **Refresh Models**, choose a model, then save.

### Models

The built-in Grok catalog is pinned to the current SuperGrok OAuth chat models:

| Model ID | Notes |
|----------|-------|
| `grok-4.3` | Default OAuth model for chat and reasoning |
| `grok-4.20-0309-reasoning` | Reasoning variant |
| `grok-4.20-0309-non-reasoning` | Non-reasoning variant |
| `grok-4.20-multi-agent-0309` | Multi-agent variant |

### Transport and endpoint

The OAuth route uses xAI's Responses-style endpoint at `https://api.x.ai/v1`, matching the Hermes Agent `xai-oauth` provider shape. The direct API-key route continues to use the OpenAI-compatible xAI API path. The **Base URL** field can override the endpoint for either mode when xAI changes deployment requirements or when testing a compatible gateway.

### Troubleshooting

- If the browser sign-in times out, start **Sign in with Grok** again. The loopback authorization window is intentionally finite.
- If the callback port is busy, CoWork falls back to an ephemeral local port automatically.
- If token refresh fails because the xAI session was revoked, disconnect the Grok account in Settings and sign in again.
- If a model call fails with a subscription or entitlement error, confirm the signed-in xAI account has an active SuperGrok subscription.

References: [xAI Grok + Hermes announcement](https://x.ai/news/grok-hermes) and [Hermes xAI Grok OAuth docs](https://hermes-agent.nousresearch.com/docs/guides/xai-grok-oauth).

---

## Web Search Providers

Multi-provider web search for research tasks with automatic retry and fallback. DuckDuckGo is built-in and requires no setup — it serves as a free fallback so web search always works, even without API keys.

| Provider | Types | API Key | Best For |
|----------|-------|---------|----------|
| **DuckDuckGo** | Web | Not required (built-in) | Zero-config free fallback |
| **Tavily** | Web, News | Required | AI-optimized results (recommended) |
| **Exa** | Web, News | Required | Semantic search and research-heavy retrieval |
| **Brave Search** | Web, News, Images | Required | Privacy-focused |
| **SerpAPI** | Web, News, Images | Required | Google results |
| **Google Custom Search** | Web, Images | Required | Direct Google integration |

DuckDuckGo is always available as the last-resort fallback. When paid providers are configured, they are tried first in the configured order, with DuckDuckGo only used if all others fail. Search settings also support explicit primary/fallback ordering and provider cooldown behavior after repeated failures.

Configure paid providers in **Settings** > **Web Search**.
