import { OpenAICompatibleProvider } from "./openai-compatible-provider";
import { LLMProviderConfig, LLMRequest, LLMResponse } from "./types";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";

export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(config: LLMProviderConfig) {
    if (!config.deepseekApiKey) {
      throw new Error(
        "DeepSeek API key is required. Get one at https://platform.deepseek.com/api_keys then add it in Settings > LLM.",
      );
    }

    super({
      type: "deepseek",
      providerName: "DeepSeek",
      apiKey: config.deepseekApiKey,
      baseUrl: config.deepseekBaseUrl || DEEPSEEK_BASE_URL,
      defaultModel: config.model || DEFAULT_DEEPSEEK_MODEL,
    });
  }

  async createMessage(request: LLMRequest): Promise<LLMResponse> {
    const model = request.model || DEFAULT_DEEPSEEK_MODEL;
    if (model === "deepseek-reasoner" && request.tools?.length) {
      throw new Error(
        "DeepSeek Reasoner is not supported for tool-using agent runs yet. Use deepseek-chat, or disable tools for this route.",
      );
    }

    return super.createMessage(request);
  }
}
