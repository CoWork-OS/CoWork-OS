import { LLMProvider, LLMProviderConfig, LLMRequest, LLMResponse } from "./types";
import { OpenAICompatibleProvider } from "./openai-compatible-provider";

const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const DEFAULT_COPILOT_BASE_URL = "https://api.individual.githubcopilot.com";

type CopilotTokenCache = {
  token: string;
  expiresAt: number;
  baseUrl: string;
};

function isTokenValid(cache: CopilotTokenCache, now = Date.now()): boolean {
  return cache.expiresAt - now > 5 * 60 * 1000;
}

function parseCopilotTokenResponse(payload: Any): { token: string; expiresAt: number } {
  if (!payload || typeof payload !== "object") {
    throw new Error("Unexpected response from Copilot token endpoint");
  }
  const token = payload.token;
  const expiresAt = payload.expires_at;
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("Copilot token response missing token");
  }

  if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) {
    return { token, expiresAt: expiresAt > 10_000_000_000 ? expiresAt : expiresAt * 1000 };
  }

  if (typeof expiresAt === "string" && expiresAt.trim()) {
    const parsed = Number.parseInt(expiresAt, 10);
    if (!Number.isFinite(parsed)) {
      throw new Error("Copilot token response has invalid expires_at");
    }
    return { token, expiresAt: parsed > 10_000_000_000 ? parsed : parsed * 1000 };
  }

  throw new Error("Copilot token response missing expires_at");
}

function deriveCopilotBaseUrl(token: string): string {
  const match = token.match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i);
  const proxyEp = match?.[1]?.trim();
  if (!proxyEp) return DEFAULT_COPILOT_BASE_URL;
  const host = proxyEp.replace(/^https?:\/\//, "").replace(/^proxy\./i, "api.");
  return host ? `https://${host}` : DEFAULT_COPILOT_BASE_URL;
}

export class GitHubCopilotProvider implements LLMProvider {
  readonly type = "github-copilot" as const;
  private githubToken: string;
  private model: string;
  private static cache?: CopilotTokenCache;

  constructor(config: LLMProviderConfig) {
    const token = config.providerApiKey;
    if (!token) {
      throw new Error("GitHub token is required for Copilot. Configure it in Settings.");
    }
    this.githubToken = token;
    this.model = config.model || "gpt-4o";
  }

  async createMessage(request: LLMRequest): Promise<LLMResponse> {
    const client = await this.getClient(request.model || this.model);
    return client.createMessage(request);
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const client = await this.getClient(this.model);
      return await client.testConnection();
    } catch (error: Any) {
      return { success: false, error: error.message || "Failed to connect to Copilot" };
    }
  }

  private async getClient(model: string): Promise<OpenAICompatibleProvider> {
    const auth = await this.getCopilotAuth();
    return new OpenAICompatibleProvider({
      type: "github-copilot",
      providerName: "GitHub Copilot",
      apiKey: auth.token,
      baseUrl: auth.baseUrl,
      defaultModel: model,
    });
  }

  private async getCopilotAuth(): Promise<CopilotTokenCache> {
    if (GitHubCopilotProvider.cache && isTokenValid(GitHubCopilotProvider.cache)) {
      return GitHubCopilotProvider.cache;
    }

    const response = await fetch(COPILOT_TOKEN_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.githubToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Copilot token exchange failed: HTTP ${response.status}`);
    }

    const json = await response.json();
    const parsed = parseCopilotTokenResponse(json);
    const cache: CopilotTokenCache = {
      token: parsed.token,
      expiresAt: parsed.expiresAt,
      baseUrl: deriveCopilotBaseUrl(parsed.token),
    };
    GitHubCopilotProvider.cache = cache;
    return cache;
  }
}
