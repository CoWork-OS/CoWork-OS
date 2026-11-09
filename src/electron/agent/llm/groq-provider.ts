import { LLMProvider, LLMProviderConfig, LLMRequest, LLMResponse } from "./types";
import { OpenAICompatibleProvider } from "./openai-compatible-provider";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_GROQ_MODEL = "llama-3.1-8b-instant";

export class GroqProvider implements LLMProvider {
  readonly type = "groq" as const;
  private client: OpenAICompatibleProvider;

  constructor(config: LLMProviderConfig) {
    const apiKey = config.groqApiKey;
    if (!apiKey) {
      throw new Error("Groq API key is required. Configure it in Settings.");
    }

    const baseUrl = config.groqBaseUrl || GROQ_BASE_URL;

    this.client = new OpenAICompatibleProvider({
      diagnosticFetch: config.diagnosticFetch,
      type: "groq",
      providerName: "Groq",
      apiKey,
      baseUrl,
      defaultModel: config.model || DEFAULT_GROQ_MODEL,
    });
  }

  createMessage(request: LLMRequest): Promise<LLMResponse> {
    return this.client.createMessage(request);
  }

  testConnection() {
    return this.client.testConnection();
  }

  getAvailableModels() {
    return this.client.getAvailableModels();
  }
}
