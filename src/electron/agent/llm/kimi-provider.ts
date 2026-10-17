import { LLMProvider, LLMProviderConfig, LLMRequest, LLMResponse } from "./types";
import { OpenAICompatibleProvider } from "./openai-compatible-provider";
import { KIMI_DEFAULT_MODEL } from "../../../shared/kimi-models";

const KIMI_BASE_URL = "https://api.moonshot.ai/v1";

export class KimiProvider implements LLMProvider {
  readonly type = "kimi" as const;
  private client: OpenAICompatibleProvider;

  constructor(config: LLMProviderConfig) {
    const apiKey = config.kimiApiKey;
    if (!apiKey) {
      throw new Error("Kimi API key is required. Configure it in Settings.");
    }

    const baseUrl = config.kimiBaseUrl || KIMI_BASE_URL;

    this.client = new OpenAICompatibleProvider({
      type: "kimi",
      providerName: "Kimi",
      apiKey,
      baseUrl,
      defaultModel: config.model || KIMI_DEFAULT_MODEL,
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
