# LLM Providers & Costs (BYOK)

CoWork OS is **free and open source**. To run tasks, configure your own model credentials or use local models.

> **Zero-config start**: CoWork OS ships with [OpenRouter](https://openrouter.ai) selected as the default provider using its free model router (`openrouter/free`), which automatically picks from available free models. You can start using the app immediately without any API keys. To unlock the full range of models, create a free OpenRouter account at [openrouter.ai/keys](https://openrouter.ai/keys) (no credit card required) and paste the key in **Settings > LLM**. You can switch to any other provider at any time.

## Built-in Providers

| Provider | Configuration | Billing |
|----------|---------------|---------|
| Anthropic API | API key in Settings | Pay-per-token |
| Google Gemini | API key in Settings | Pay-per-token (free tier available) |
| OpenRouter | API key in Settings (default provider) | Free tier available, pay-per-token for premium models |
| OpenAI (API Key) | API key in Settings | Pay-per-token |
| OpenAI (ChatGPT OAuth) | Sign in with ChatGPT account | Uses your ChatGPT subscription |
| AWS Bedrock | AWS credentials in Settings (auto-resolves inference profiles) | Pay-per-token via AWS |
| Azure OpenAI | API key + endpoint in Settings | Pay-per-token via Azure |
| Ollama (Local) | Install Ollama and pull models | **Free** (runs locally) |
| Groq | API key in Settings | Pay-per-token |
| xAI (Grok) | API key in Settings | Pay-per-token |
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

## Google Gemini

1. Get API key from [Google AI Studio](https://aistudio.google.com/apikey)
2. Configure in **Settings** > **Google Gemini**

Models: `gemini-2.0-flash` (default), `gemini-2.5-pro` (most capable), `gemini-2.5-flash` (fast)

---

## OpenRouter

Access multiple AI providers through one API.

1. Get API key from [OpenRouter](https://openrouter.ai/keys)
2. Configure in **Settings** > **OpenRouter**

Available: Claude, GPT-4, Gemini, Llama, Mistral, and more — see [openrouter.ai/models](https://openrouter.ai/models)

---

## OpenAI / ChatGPT

- **Option 1: API Key** — Standard pay-per-token access to GPT models
- **Option 2: ChatGPT OAuth** — Sign in with your ChatGPT subscription

---

## Web Search Providers

Multi-provider web search for research tasks with automatic retry and fallback.

| Provider | Types | Best For |
|----------|-------|----------|
| **Tavily** | Web, News | AI-optimized results (recommended) |
| **Brave Search** | Web, News, Images | Privacy-focused |
| **SerpAPI** | Web, News, Images | Google results |
| **Google Custom Search** | Web, Images | Direct Google integration |

Configure in **Settings** > **Web Search**.
