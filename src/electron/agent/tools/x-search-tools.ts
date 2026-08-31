import { Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import { LLMProviderFactory, type LLMSettings } from "../llm/provider-factory";
import {
  DEFAULT_XAI_OAUTH_BASE_URL,
  XAIOAuth,
  type XAIOAuthTokens,
  isXAIAccessTokenExpiring,
} from "../llm/xai-oauth";
import { evaluateNetworkPolicy } from "../../security/network-policy";

const DEFAULT_X_SEARCH_MODEL = "grok-4.20-reasoning";
const DEFAULT_X_SEARCH_TIMEOUT_SECONDS = 180;
const DEFAULT_X_SEARCH_RETRIES = 2;
const MAX_HANDLES = 10;

type XCredentialSource = "xai-oauth" | "xai";

interface XSearchInput {
  query: string;
  allowed_x_handles?: string[];
  excluded_x_handles?: string[];
  from_date?: string;
  to_date?: string;
  enable_image_understanding?: boolean;
  enable_video_understanding?: boolean;
}

interface XSearchCredential {
  apiKey: string;
  baseUrl: string;
  source: XCredentialSource;
}

function normalizeBaseUrl(value?: string): string {
  return (value || DEFAULT_XAI_OAUTH_BASE_URL).trim().replace(/\/+$/, "");
}

function normalizeApiKey(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function normalizeHandles(handles: unknown, fieldName: string): string[] {
  if (!Array.isArray(handles)) return [];
  const cleaned = handles
    .map((handle) =>
      String(handle || "")
        .trim()
        .replace(/^@+/, ""),
    )
    .filter(Boolean);
  if (cleaned.length > MAX_HANDLES) {
    throw new Error(`${fieldName} supports at most ${MAX_HANDLES} handles`);
  }
  return cleaned;
}

function extractResponseText(payload: Any): string {
  const directText = String(payload?.output_text || "").trim();
  if (directText) return directText;

  const parts: string[] = [];
  for (const item of payload?.output || []) {
    if (item?.type !== "message") continue;
    for (const content of item?.content || []) {
      const type = content?.type;
      if (type !== "output_text" && type !== "text") continue;
      const text = String(content?.text || "").trim();
      if (text) parts.push(text);
    }
  }
  return parts.join("\n\n").trim();
}

function extractInlineCitations(payload: Any): Any[] {
  const citations: Any[] = [];
  for (const item of payload?.output || []) {
    if (item?.type !== "message") continue;
    for (const content of item?.content || []) {
      for (const annotation of content?.annotations || []) {
        if (annotation?.type !== "url_citation") continue;
        citations.push({
          url: annotation.url || "",
          title: annotation.title || "",
          start_index: annotation.start_index,
          end_index: annotation.end_index,
        });
      }
    }
  }
  return citations;
}

async function parseHttpError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text.trim()) return `${response.status} ${response.statusText}`.trim();

  try {
    const payload = JSON.parse(text) as Any;
    if (payload && typeof payload === "object") {
      const code = String(payload.code || "").trim();
      const error = String(payload.error || payload.message || "").trim();
      const message = error || JSON.stringify(payload);
      return code && !message.includes(code) ? `${code}: ${message}` : message;
    }
  } catch {
    // Use the text body below.
  }

  return text.slice(0, 500);
}

function isRetryableFetchError(error: Any): boolean {
  const name = String(error?.name || "");
  const message = String(error?.message || "");
  return (
    name === "AbortError" ||
    name === "TimeoutError" ||
    /timeout|timed out|econnreset|enotfound|network|socket|connection/i.test(message)
  );
}

export class XSearchTools {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {}

  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  static hasCredentials(settings: LLMSettings = LLMProviderFactory.loadSettings()): boolean {
    const xai = settings.xai || {};
    if (normalizeApiKey(xai.accessToken) && normalizeApiKey(xai.refreshToken)) return true;
    if (normalizeApiKey(xai.apiKey)) return true;
    if (normalizeApiKey(process.env.XAI_API_KEY)) return true;
    return false;
  }

  private async resolveXaiCredential(): Promise<XSearchCredential> {
    const settings = LLMProviderFactory.loadSettings();
    const xai = settings.xai || {};
    const baseUrl = normalizeBaseUrl(xai.baseUrl);
    const accessToken = normalizeApiKey(xai.accessToken);
    const refreshToken = normalizeApiKey(xai.refreshToken);

    if (accessToken && refreshToken) {
      let tokens: XAIOAuthTokens = {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: xai.tokenExpiresAt,
        token_endpoint: xai.tokenEndpoint,
        id_token: xai.idToken,
      };

      if (isXAIAccessTokenExpiring(tokens.access_token, tokens.expires_at)) {
        tokens = await XAIOAuth.refreshTokens(tokens);
        const latestSettings = LLMProviderFactory.loadSettings();
        latestSettings.xai = {
          ...latestSettings.xai,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          tokenExpiresAt: tokens.expires_at,
          tokenEndpoint: tokens.token_endpoint,
          idToken: tokens.id_token,
          authMethod: "oauth",
        };
        LLMProviderFactory.saveSettings(latestSettings);
        LLMProviderFactory.clearCache();
      }

      return { apiKey: tokens.access_token, baseUrl, source: "xai-oauth" };
    }

    const apiKey = normalizeApiKey(xai.apiKey) || normalizeApiKey(process.env.XAI_API_KEY);
    if (apiKey) {
      return { apiKey, baseUrl, source: "xai" };
    }

    throw new Error(
      "No xAI credentials available. Sign in with Grok OAuth in Settings or configure an xAI API key.",
    );
  }

  private getModel(): string {
    return normalizeApiKey(process.env.COWORK_X_SEARCH_MODEL) || DEFAULT_X_SEARCH_MODEL;
  }

  private getTimeoutSeconds(): number {
    const parsed = Number(process.env.COWORK_X_SEARCH_TIMEOUT_SECONDS);
    return Number.isFinite(parsed)
      ? Math.max(30, Math.round(parsed))
      : DEFAULT_X_SEARCH_TIMEOUT_SECONDS;
  }

  private getRetries(): number {
    const parsed = Number(process.env.COWORK_X_SEARCH_RETRIES);
    return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : DEFAULT_X_SEARCH_RETRIES;
  }

  private async pause(attempt: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, 50 * (attempt + 1))));
  }

  async search(input: XSearchInput): Promise<Any> {
    const query = String(input?.query || "").trim();
    if (!query) {
      return { success: false, provider: "xai", tool: "x_search", error: "query is required" };
    }
    if (
      this.workspace.permissions?.network === false ||
      this.workspace.permissions?.accessNetworkMode === "disabled"
    ) {
      return {
        success: false,
        provider: "xai",
        tool: "x_search",
        error: "Network access disabled by the active access profile.",
        error_type: "NetworkPolicyError",
      };
    }

    let credential: XSearchCredential;
    try {
      credential = await this.resolveXaiCredential();
    } catch (error: Any) {
      return {
        success: false,
        provider: "xai",
        tool: "x_search",
        error: error?.message || "No xAI credentials available.",
        error_type: error?.name || "CredentialError",
      };
    }

    const endpointUrl = `${credential.baseUrl}/responses`;
    const endpointDecision = evaluateNetworkPolicy({
      url: endpointUrl,
      toolName: "x_search",
      networkEnabled: this.workspace.permissions?.network,
      accessNetworkMode: this.workspace.permissions?.accessNetworkMode,
      profileDomainRules: this.workspace.permissions?.accessDomainRules,
    });
    this.daemon.logEvent(this.taskId, "network_policy_decision", endpointDecision);
    if (endpointDecision.action === "deny") {
      return {
        success: false,
        provider: "xai",
        tool: "x_search",
        error: `Network access denied for "${endpointUrl}": ${endpointDecision.reason}`,
        error_type: "NetworkPolicyError",
        policyReason: endpointDecision.reason,
      };
    }

    try {
      const allowed = normalizeHandles(input.allowed_x_handles, "allowed_x_handles");
      const excluded = normalizeHandles(input.excluded_x_handles, "excluded_x_handles");
      if (allowed.length > 0 && excluded.length > 0) {
        return {
          success: false,
          provider: "xai",
          tool: "x_search",
          error: "allowed_x_handles and excluded_x_handles cannot be used together",
        };
      }

      const toolDef: Any = { type: "x_search" };
      if (allowed.length > 0) toolDef.allowed_x_handles = allowed;
      if (excluded.length > 0) toolDef.excluded_x_handles = excluded;
      if (String(input.from_date || "").trim()) toolDef.from_date = String(input.from_date).trim();
      if (String(input.to_date || "").trim()) toolDef.to_date = String(input.to_date).trim();
      if (input.enable_image_understanding) toolDef.enable_image_understanding = true;
      if (input.enable_video_understanding) toolDef.enable_video_understanding = true;

      const model = this.getModel();
      const payload = {
        model,
        input: [{ role: "user", content: query }],
        tools: [toolDef],
        store: false,
      };

      this.daemon.logEvent(this.taskId, "log", {
        message: `Searching X via xAI x_search: "${query}"`,
      });

      const retries = this.getRetries();
      const timeoutMs = this.getTimeoutSeconds() * 1000;
      let response: Response | null = null;

      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          response = await fetch(endpointUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${credential.apiKey}`,
              "Content-Type": "application/json",
              "User-Agent": "CoWork-OS x_search",
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(timeoutMs),
          });

          if (response.ok) break;
          if (response.status < 500 || attempt >= retries) {
            const error = await parseHttpError(response);
            return {
              success: false,
              provider: "xai",
              tool: "x_search",
              error,
              error_type: "HTTPError",
              status: response.status,
            };
          }
          await this.pause(attempt);
        } catch (error: Any) {
          if (attempt >= retries || !isRetryableFetchError(error)) throw error;
          await this.pause(attempt);
        }
      }

      if (!response) {
        throw new Error("x_search request did not return a response");
      }

      const data = (await response.json()) as Any;
      const result = {
        success: true,
        provider: "xai",
        credential_source: credential.source,
        tool: "x_search",
        model,
        query,
        answer: extractResponseText(data),
        citations: Array.isArray(data?.citations) ? data.citations : [],
        inline_citations: extractInlineCitations(data),
      };

      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "x_search",
        result: {
          query,
          credentialSource: credential.source,
          citationCount: result.citations.length + result.inline_citations.length,
        },
      });

      return result;
    } catch (error: Any) {
      const isTimeout = error?.name === "AbortError" || error?.name === "TimeoutError";
      const message = isTimeout
        ? `xAI x_search timed out after ${this.getTimeoutSeconds()} seconds`
        : error?.message || "x_search failed";
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "x_search",
        error: message,
      });
      return {
        success: false,
        provider: "xai",
        tool: "x_search",
        error: message,
        error_type: error?.name || "Error",
      };
    }
  }
}
