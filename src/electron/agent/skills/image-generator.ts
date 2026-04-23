import * as fs from "fs";
import * as path from "path";
import * as mimetypes from "mime-types";
import OpenAI from "openai";
import { Workspace } from "../../../shared/types";
import { getOpenRouterAttributionHeaders } from "../llm/openrouter-attribution";
import { OpenAIOAuth, OpenAIOAuthTokens } from "../llm/openai-oauth";
import { loadPiAiModule } from "../llm/pi-ai-loader";
import { LLMProviderFactory } from "../llm/provider-factory";

/**
 * Image generation provider types
 */
export type ImageProvider = "gemini" | "openai" | "openai-codex" | "azure" | "openrouter";

/**
 * Image generation model types
 *
 * Notes:
 * - Gemini uses fixed model IDs under the hood, mapped from internal presets.
 * - OpenAI models are passed through to the Images API (e.g. gpt-image-1.5).
 * - Azure OpenAI uses deployments; for Azure, "model" maps to deployment name.
 */
export type ImageModel =
  | "gpt-image-1"
  | "gpt-image-1.5"
  | "dall-e-3"
  | "dall-e-2"
  // Allow future models without code changes
  | (string & {});

/**
 * Image size options
 */
export type ImageSize = "1K" | "2K";
type OpenAIImageSize = "auto" | "1024x1024" | "1024x1536" | "1536x1024";

/**
 * Image generation request
 */
export interface ImageGenerationRequest {
  prompt: string;
  /**
   * Optional provider override. Default is "auto" which picks the best configured provider.
   */
  provider?: ImageProvider | "auto";
  /**
   * Optional model override.
   * - Gemini: gemini-image-fast | gemini-image-pro
   * - OpenAI: gpt-image-1 | gpt-image-1.5 | dall-e-3 | dall-e-2 (also accepts "gpt-1.5" alias)
   * - Azure: deployment name
   */
  model?: ImageModel;
  filename?: string;
  imageSize?: ImageSize;
  numberOfImages?: number;
}

/**
 * Image generation result
 */
export interface ImageGenerationResult {
  success: boolean;
  images: Array<{
    path: string;
    filename: string;
    mimeType: string;
    size: number;
  }>;
  provider?: ImageProvider;
  model: string;
  textResponse?: string;
  error?: string;
  actionHint?: { type: string; label: string; target: string };
}

/**
 * Map our Gemini presets to Gemini model IDs.
 * nano-banana-2 = Gemini 3.1 Flash Image Preview (Nano Banana 2)
 */
const GEMINI_MODEL_MAP: Record<
  "gemini-image-fast" | "gemini-image-pro" | "nano-banana-2",
  string
> = {
  "gemini-image-fast": "gemini-2.5-flash-image",
  "gemini-image-pro": "gemini-3-pro-image-preview",
  "nano-banana-2": "gemini-3.1-flash-image-preview",
};

const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const OPENAI_CODEX_IMAGE_INSTRUCTIONS =
  "You are an assistant that must fulfill image generation requests by using the image_generation tool when provided.";
const OPENAI_CODEX_PREFERRED_HOST_MODELS = [
  "gpt-5.4",
  "gpt-5.3",
  "gpt-5.2",
  "gpt-5.1",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
] as const;
const OPENAI_CODEX_RESPONSES_IMAGE_MODELS = new Set(["gpt-image-1", "gpt-image-1.5"]);

function buildSetupHint(provider: ImageProvider): { type: string; label: string; target: string } {
  if (provider === "gemini")
    return { type: "open_settings", label: "Set up Gemini API key", target: "gemini" };
  if (provider === "azure")
    return { type: "open_settings", label: "Set up Azure OpenAI", target: "azure" };
  if (provider === "openrouter")
    return { type: "open_settings", label: "Set up OpenRouter API key", target: "openrouter" };
  if (provider === "openai-codex") {
    return { type: "open_settings", label: "Sign in to OpenAI OAuth", target: "openai" };
  }
  return { type: "open_settings", label: "Set up OpenAI API key", target: "openai" };
}

function isOpenAIImageModel(model?: string): boolean {
  if (!model) return false;
  const m = model.trim().toLowerCase();
  return (
    m.startsWith("gpt-image-") ||
    m === "dall-e-3" ||
    m === "dall-e-2" ||
    m === "dalle-3" ||
    m === "dalle-2"
  );
}

function resolveOpenAIModelOverride(modelOverride?: string): string | null {
  const normalized = normalizeOpenAIImageModel(modelOverride);
  if (!normalized) return null;
  return isOpenAIImageModel(normalized) ? normalized : null;
}

function normalizeOpenAIImageModel(model?: string): string | undefined {
  if (!model) return undefined;
  const raw = model.trim();
  const m = raw.toLowerCase();
  // Accept common aliases users mention conversationally
  if (m === "gpt-1.5" || m === "gpt1.5") return "gpt-image-1.5";
  if (m === "gpt-1" || m === "gpt1") return "gpt-image-1";
  if (m === "dalle-3") return "dall-e-3";
  if (m === "dalle-2") return "dall-e-2";
  return raw;
}

function inferOpenAIImageModelFromText(text: string): string | null {
  const t = (text || "").toLowerCase();
  if (!t.trim()) return null;
  if (t.includes("gpt-image-1.5") || t.includes("gpt-1.5") || t.includes("gpt1.5"))
    return "gpt-image-1.5";
  if (t.includes("gpt-image-1") || t.includes("gpt-1") || t.includes("gpt1")) return "gpt-image-1";
  if (t.includes("dall-e-3") || t.includes("dalle-3")) return "dall-e-3";
  if (t.includes("dall-e-2") || t.includes("dalle-2")) return "dall-e-2";
  return null;
}

function uniqStrings(values: Array<string | undefined | null>): string[] {
  const out: string[] = [];
  for (const v of values) {
    const s = typeof v === "string" ? v.trim() : "";
    if (!s) continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

function looksLikeImageDeployment(name: string): boolean {
  const n = (name || "").toLowerCase();
  return n.includes("image") || n.includes("dall") || n.includes("dalle");
}

function looksLikeKnownImageModelId(name: string): boolean {
  const n = (name || "").trim().toLowerCase();
  return n.startsWith("gpt-image-") || n.startsWith("dall-e-") || n.startsWith("dalle-");
}

function getAzureConfiguredDeployments(
  settings: ReturnType<typeof LLMProviderFactory.loadSettings>,
): string[] {
  return uniqStrings([settings.azure?.deployment, ...(settings.azure?.deployments || [])]);
}

function getAzureImageDeployments(
  settings: ReturnType<typeof LLMProviderFactory.loadSettings>,
): string[] {
  const all = getAzureConfiguredDeployments(settings);
  // Treat deployments that look like image models as image-capable.
  // If users name deployments arbitrarily, they should include a recognizable marker (e.g. "image")
  // or use the underlying model ID as the deployment name.
  return all.filter((d) => looksLikeImageDeployment(d) || looksLikeKnownImageModelId(d));
}

function selectAzureImageDeployments(args: {
  settings: ReturnType<typeof LLMProviderFactory.loadSettings>;
  modelOverride?: string;
  prompt: string;
}): string[] {
  const all = getAzureConfiguredDeployments(args.settings);
  const imageDeployments = getAzureImageDeployments(args.settings);

  const override =
    typeof args.modelOverride === "string" && args.modelOverride.trim()
      ? args.modelOverride.trim()
      : null;

  // Ignore known Gemini-only preset names when selecting Azure deployments.
  if (override === "gemini-image-fast" || override === "gemini-image-pro") {
    // fall through
  } else if (override) {
    // If override matches a configured deployment, prefer the configured name (preserve casing).
    const match = all.find((d) => d.toLowerCase() === override.toLowerCase());
    // Otherwise, only treat it as a deployment override if it looks image-capable.
    if (match) {
      // Only accept known configured deployments; if it's not image-capable we still accept it
      // as an explicit override (user knows what they're doing).
      return uniqStrings([match, ...imageDeployments]);
    }
    if (
      looksLikeImageDeployment(override) ||
      isOpenAIImageModel(normalizeOpenAIImageModel(override))
    ) {
      // If user typed a model-like name not in config, try it once then fall back to configured image deployments.
      return uniqStrings([override, ...imageDeployments]);
    }
    // Non-image overrides (like text model deployments) are almost certainly accidental for image generation.
    // fall through
  }

  const inferredModel = inferOpenAIImageModelFromText(args.prompt);
  const inferredMatch = inferredModel
    ? imageDeployments.filter((d) => d.toLowerCase() === inferredModel.toLowerCase())
    : [];

  const imageLike = imageDeployments.filter(looksLikeImageDeployment);

  // Prefer explicit inferred match, then any image-like deployments, then any remaining deployments.
  return uniqStrings([...inferredMatch, ...imageLike]);
}

export function inferImageProviderFromText(text: string): ImageProvider | null {
  const t = (text || "").toLowerCase();
  if (!t.trim()) return null;
  if (t.includes("azure openai") || /\bazure\b/.test(t)) return "azure";
  if (t.includes("codex auth") || t.includes("openai oauth") || t.includes("chatgpt oauth"))
    return "openai-codex";
  if (t.includes("openrouter")) return "openrouter";
  if (t.includes("gemini")) return "gemini";
  if (t.includes("openai")) return "openai";
  return null;
}

function hasOpenAIOAuthTokens(
  settings: ReturnType<typeof LLMProviderFactory.loadSettings>,
): boolean {
  return Boolean(
    settings.openai?.accessToken?.trim() &&
      (settings.openai?.authMethod === "oauth" || settings.openai?.refreshToken?.trim()),
  );
}

function getConfiguredImageProviders(
  settings: ReturnType<typeof LLMProviderFactory.loadSettings>,
): ImageProvider[] {
  const providers: ImageProvider[] = [];

  const azureImageDeployments = getAzureImageDeployments(settings);
  const azureOk =
    !!settings.azure?.apiKey?.trim() &&
    !!settings.azure?.endpoint?.trim() &&
    azureImageDeployments.length > 0;
  if (azureOk) providers.push("azure");

  const openaiKey = settings.openai?.apiKey?.trim();
  if (openaiKey) providers.push("openai");

  if (hasOpenAIOAuthTokens(settings)) providers.push("openai-codex");

  const openrouterKey = settings.openrouter?.apiKey?.trim();
  if (openrouterKey) providers.push("openrouter");

  const geminiKey = settings.gemini?.apiKey?.trim();
  if (geminiKey) providers.push("gemini");

  return providers;
}

function sortProvidersByDefaultPreference(providers: ImageProvider[]): ImageProvider[] {
  const priority: Record<ImageProvider, number> = {
    azure: 0,
    openai: 1,
    "openai-codex": 2,
    openrouter: 3,
    gemini: 4,
  };
  return [...providers].sort((a, b) => (priority[a] ?? 99) - (priority[b] ?? 99));
}

type ImageModelPreset = "gpt-image-1.5" | "nano-banana-2";

function getCompatibleImageModelPreset(
  provider: ImageProvider,
  preset?: ImageModelPreset,
): ImageModelPreset | undefined {
  if (!preset) return undefined;
  if (preset === "nano-banana-2") return provider === "gemini" ? preset : undefined;
  if (preset === "gpt-image-1.5") return provider === "gemini" ? undefined : preset;
  return undefined;
}

function pushConfiguredImageRoute(
  order: Array<{ provider: ImageProvider; modelPreset?: ImageModelPreset }>,
  configured: ImageProvider[],
  provider: ImageProvider | undefined,
  modelPreset?: ImageModelPreset,
): void {
  if (!provider || !configured.includes(provider)) return;
  if (order.some((entry) => entry.provider === provider)) return;
  order.push({
    provider,
    modelPreset: getCompatibleImageModelPreset(provider, modelPreset),
  });
}

/** Build provider order from settings.imageGeneration (default + backup). */
function buildProviderOrderFromImageSettings(
  settings: ReturnType<typeof LLMProviderFactory.loadSettings>,
): Array<{ provider: ImageProvider; modelPreset?: ImageModelPreset }> {
  const img = settings.imageGeneration;
  const defaultProvider = img?.defaultProvider;
  const defaultPreset = img?.defaultModel;
  const backupProvider = img?.backupProvider;
  const backupPreset = img?.backupModel;
  const configured = getConfiguredImageProviders(settings);

  const order: Array<{ provider: ImageProvider; modelPreset?: ImageModelPreset }> = [];

  pushConfiguredImageRoute(order, configured, defaultProvider, defaultPreset);

  if (!defaultProvider && defaultPreset === "gpt-image-1.5") {
    for (const p of ["azure", "openai", "openai-codex", "openrouter"] as ImageProvider[]) {
      if (configured.includes(p)) order.push({ provider: p, modelPreset: "gpt-image-1.5" });
    }
  }
  if (!defaultProvider && defaultPreset === "nano-banana-2" && configured.includes("gemini")) {
    order.push({ provider: "gemini", modelPreset: "nano-banana-2" });
  }

  pushConfiguredImageRoute(order, configured, backupProvider, backupPreset);

  if (!backupProvider && backupPreset && backupPreset !== defaultPreset) {
    if (backupPreset === "gpt-image-1.5") {
      for (const p of ["azure", "openai", "openai-codex", "openrouter"] as ImageProvider[]) {
        if (configured.includes(p) && !order.some((o) => o.provider === p))
          order.push({ provider: p, modelPreset: "gpt-image-1.5" });
      }
    } else if (backupPreset === "nano-banana-2" && configured.includes("gemini")) {
      if (!order.some((o) => o.provider === "gemini"))
        order.push({ provider: "gemini", modelPreset: "nano-banana-2" });
    }
  }

  return order;
}

export function selectImageProviderOrder(args: {
  settings: ReturnType<typeof LLMProviderFactory.loadSettings>;
  providerOverride?: ImageProvider | "auto";
  modelOverride?: string;
  prompt: string;
}): Array<{ provider: ImageProvider; modelPreset?: ImageModelPreset }> {
  const settings = args.settings;
  const configured = sortProvidersByDefaultPreference(getConfiguredImageProviders(settings));

  const requestedOpenAIModel =
    resolveOpenAIModelOverride(args.modelOverride) || inferOpenAIImageModelFromText(args.prompt);

  const explicitProvider =
    (args.providerOverride && args.providerOverride !== "auto" ? args.providerOverride : null) ||
    inferImageProviderFromText(args.modelOverride || "") ||
    inferImageProviderFromText(args.prompt);

  const fromSettings = buildProviderOrderFromImageSettings(settings);
  if (fromSettings.length > 0 && !explicitProvider && !args.modelOverride) {
    return fromSettings;
  }

  const legacyOrder: ImageProvider[] = [];
  const base =
    explicitProvider ||
    (requestedOpenAIModel
      ? configured.includes("azure")
        ? "azure"
        : configured.includes("openai")
          ? "openai"
          : configured.includes("openai-codex")
            ? "openai-codex"
          : configured.includes("openrouter")
            ? "openrouter"
            : null
      : null) ||
    configured[0] ||
    null;
  if (base) {
    legacyOrder.push(base);
    for (const p of configured) {
      if (!legacyOrder.includes(p)) legacyOrder.push(p);
    }
    for (const p of [
      "gemini",
      "openai",
      "openai-codex",
      "azure",
      "openrouter",
    ] as ImageProvider[]) {
      if (!legacyOrder.includes(p)) legacyOrder.push(p);
    }
  }
  const deduped = legacyOrder.filter((p, idx) => legacyOrder.indexOf(p) === idx);
  return deduped.map((provider) => ({ provider }));
}

function extractChatGPTAccountId(token: string): string {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("invalid_token");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (typeof accountId !== "string" || !accountId.trim()) throw new Error("missing_account_id");
    return accountId.trim();
  } catch {
    throw new Error("Failed to extract ChatGPT account ID from OpenAI OAuth token");
  }
}

function persistUpdatedOpenAITokens(tokens: OpenAIOAuthTokens): void {
  const settings = LLMProviderFactory.loadSettings();
  settings.openai = {
    ...settings.openai,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    tokenExpiresAt: tokens.expires_at,
    authMethod: "oauth",
  };
  LLMProviderFactory.saveSettings(settings);
  LLMProviderFactory.clearCache();
}

interface OpenAICodexCredentials {
  apiKey: string;
  accessToken: string;
}

async function resolveOpenAICodexCredentials(
  settings: ReturnType<typeof LLMProviderFactory.loadSettings>,
): Promise<OpenAICodexCredentials> {
  const accessToken = settings.openai?.accessToken?.trim();
  const refreshToken = settings.openai?.refreshToken?.trim();
  const tokenExpiresAt = settings.openai?.tokenExpiresAt;

  if (!accessToken) {
    throw new Error("OpenAI OAuth is not configured");
  }

  if (refreshToken) {
    const { apiKey, newTokens } = await OpenAIOAuth.getApiKeyFromTokens({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at:
        typeof tokenExpiresAt === "number" && Number.isFinite(tokenExpiresAt) ? tokenExpiresAt : 0,
    });
    if (
      newTokens &&
      (newTokens.access_token !== accessToken ||
        newTokens.refresh_token !== refreshToken ||
        newTokens.expires_at !== tokenExpiresAt)
    ) {
      persistUpdatedOpenAITokens(newTokens);
    }
    return { apiKey, accessToken: newTokens?.access_token ?? accessToken };
  }

  if (
    typeof tokenExpiresAt === "number" &&
    Number.isFinite(tokenExpiresAt) &&
    Date.now() > tokenExpiresAt - 5 * 60 * 1000
  ) {
    throw new Error("OpenAI OAuth token has expired. Sign in again in Settings.");
  }

  return { apiKey: accessToken, accessToken };
}

async function resolveOpenAICodexHostModel(): Promise<string> {
  try {
    const { getModels } = await loadPiAiModule();
    const availableModelIds = new Set(getModels("openai-codex").map((model) => model.id));
    for (const candidate of OPENAI_CODEX_PREFERRED_HOST_MODELS) {
      if (availableModelIds.has(candidate)) return candidate;
    }
    return [...availableModelIds][0] || "gpt-5.1";
  } catch {
    return "gpt-5.1";
  }
}

/**
 * ImageGenerator - Generates images using whichever provider is configured, with fallback.
 */
export class ImageGenerator {
  constructor(private workspace: Workspace) {}

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const prompt = request.prompt;
    const providerOverride = request.provider || "auto";
    const modelOverride = typeof request.model === "string" ? request.model : undefined;
    const filename = request.filename;
    const imageSize = request.imageSize || "1K";
    const numberOfImages = request.numberOfImages || 1;

    const settings = LLMProviderFactory.loadSettings();
    const configuredProviders = getConfiguredImageProviders(settings);
    const providerOrder = selectImageProviderOrder({
      settings,
      providerOverride,
      modelOverride,
      prompt,
    });

    const baseEntry = providerOrder[0];
    const baseProvider = baseEntry?.provider ?? null;
    // Use a ref object so TS doesn't incorrectly narrow a local union to `null` across closures.
    const bestErrorRef: {
      current: {
        provider: ImageProvider;
        model?: string;
        error: string;
        actionHint: { type: string; label: string; target: string };
      } | null;
    } = { current: null };

    const considerError = (provider: ImageProvider, error: string, model?: string) => {
      const actionHint = buildSetupHint(provider);
      const existing = bestErrorRef.current;
      if (!existing) {
        bestErrorRef.current = { provider, model, error, actionHint };
        return;
      }
      // Prefer the base provider's error (what we intended to use by default).
      if (baseProvider && existing.provider !== baseProvider && provider === baseProvider) {
        bestErrorRef.current = { provider, model, error, actionHint };
      }
    };

    if (providerOrder.length === 0) {
      return {
        success: false,
        images: [],
        model: normalizeOpenAIImageModel(modelOverride) || "gpt-image-1.5",
        error:
          "No image generation provider configured. Configure Gemini/OpenAI/Azure/OpenRouter/OpenAI OAuth in Settings.",
        actionHint: buildSetupHint("openai"),
      };
    }

    for (const entry of providerOrder) {
      const { provider, modelPreset } = entry;
      try {
        if (provider === "gemini") {
          const apiKey = settings.gemini?.apiKey?.trim();
          if (!apiKey) {
            if (configuredProviders.includes("gemini")) {
              considerError("gemini", "Gemini API key not configured.");
            }
            continue;
          }
          const chosen: "gemini-image-fast" | "gemini-image-pro" | "nano-banana-2" =
            modelPreset === "nano-banana-2"
              ? "nano-banana-2"
              : modelOverride === "gemini-image-fast" || modelOverride === "gemini-image-pro"
                ? (modelOverride as Any)
                : "gemini-image-pro";
          const modelId = GEMINI_MODEL_MAP[chosen];
          return await this.generateWithGemini({
            apiKey,
            modelId,
            prompt,
            filename,
            imageSize,
            numberOfImages,
          });
        }

        if (provider === "openai") {
          const apiKey = settings.openai?.apiKey?.trim();
          if (!apiKey) {
            if (configuredProviders.includes("openai")) {
              considerError("openai", "OpenAI API key not configured.");
            }
            continue;
          }
          const chosenModel =
            resolveOpenAIModelOverride(modelOverride) ||
            (modelPreset === "gpt-image-1.5" ? "gpt-image-1.5" : null) ||
            inferOpenAIImageModelFromText(prompt) ||
            "gpt-image-1.5";
          return await this.generateWithOpenAI({
            apiKey,
            model: chosenModel,
            prompt,
            filename,
            imageSize,
            numberOfImages,
          });
        }

        if (provider === "openai-codex") {
          if (!hasOpenAIOAuthTokens(settings)) {
            if (configuredProviders.includes("openai-codex")) {
              considerError("openai-codex", "OpenAI OAuth is not connected.");
            }
            continue;
          }
          const chosenModel =
            resolveOpenAIModelOverride(modelOverride) ||
            (modelPreset === "gpt-image-1.5" ? "gpt-image-1.5" : null) ||
            inferOpenAIImageModelFromText(prompt) ||
            "gpt-image-1.5";
          const normalizedChosenModel = normalizeOpenAIImageModel(chosenModel) || chosenModel;
          if (!OPENAI_CODEX_RESPONSES_IMAGE_MODELS.has(normalizedChosenModel.toLowerCase())) {
            considerError(
              "openai-codex",
              "OpenAI OAuth image generation supports GPT Image models in the Responses tool path (for example gpt-image-1.5).",
              normalizedChosenModel,
            );
            continue;
          }
          const credentials = await resolveOpenAICodexCredentials(settings);
          return await this.generateWithOpenAICodex({
            apiKey: credentials.apiKey,
            accessToken: credentials.accessToken,
            model: normalizedChosenModel,
            prompt,
            filename,
            imageSize,
            numberOfImages,
          });
        }

        if (provider === "azure") {
          const apiKey = settings.azure?.apiKey?.trim();
          const endpoint = settings.azure?.endpoint?.trim();
          const apiVersion = settings.azure?.apiVersion?.trim() || "2024-02-15-preview";
          const deploymentsToTry = selectAzureImageDeployments({
            settings,
            modelOverride: modelPreset === "gpt-image-1.5" ? "gpt-image-1.5" : modelOverride,
            prompt,
          });

          if (!apiKey || !endpoint || deploymentsToTry.length === 0) {
            if (configuredProviders.includes("azure")) {
              considerError(
                "azure",
                "Azure OpenAI has no image-capable deployment configured. Add an image deployment (e.g. gpt-image-1.5) in Settings.",
              );
            }
            continue;
          }

          let azureLast: ImageGenerationResult | null = null;
          for (const deployment of deploymentsToTry) {
            const result = await this.generateWithAzureOpenAI({
              apiKey,
              endpoint,
              apiVersion,
              deployment,
              prompt,
              filename,
              imageSize,
              numberOfImages,
            });
            if (result.success) {
              return result;
            }
            azureLast = result;
          }

          considerError(
            "azure",
            azureLast?.error || "Azure OpenAI image generation failed",
            azureLast?.model,
          );
          continue;
        }

        if (provider === "openrouter") {
          const apiKey = settings.openrouter?.apiKey?.trim();
          const baseUrl = (
            settings.openrouter?.baseUrl?.trim() || "https://openrouter.ai/api/v1"
          ).replace(/\/+$/, "");
          if (!apiKey) {
            if (configuredProviders.includes("openrouter")) {
              considerError("openrouter", "OpenRouter API key not configured.");
            }
            continue;
          }
          const openaiModel =
            resolveOpenAIModelOverride(modelOverride) ||
            (modelPreset === "gpt-image-1.5" ? "gpt-image-1.5" : null) ||
            inferOpenAIImageModelFromText(prompt) ||
            "gpt-image-1.5";
          const openRouterModel = `openai/${openaiModel}`;
          const result = await this.generateWithOpenRouter({
            apiKey,
            baseUrl,
            model: openRouterModel,
            prompt,
            filename,
            imageSize,
            numberOfImages,
          });
          if (result.success) return result;
          considerError(
            "openrouter",
            result.error || "OpenRouter image generation failed",
            result.model,
          );
          continue;
        }
      } catch (error: Any) {
        considerError(provider, error?.message || String(error));
      }
    }

    return {
      success: false,
      images: [],
      provider: bestErrorRef.current?.provider,
      model:
        bestErrorRef.current?.model || normalizeOpenAIImageModel(modelOverride) || "gpt-image-1.5",
      error: bestErrorRef.current?.error || "Image generation failed",
      actionHint: bestErrorRef.current?.actionHint || buildSetupHint("openai"),
    };
  }

  static isAvailable(): boolean {
    const settings = LLMProviderFactory.loadSettings();
    return getConfiguredImageProviders(settings).length > 0;
  }

  static getAvailableModels(): Array<{
    id: ImageModel;
    name: string;
    description: string;
    modelId: string;
  }> {
    return [
      {
        id: "gemini-image-fast" as Any,
        name: "Gemini Image (Fast)",
        description: "Fast image generation using Gemini",
        modelId: GEMINI_MODEL_MAP["gemini-image-fast"],
      },
      {
        id: "gemini-image-pro" as Any,
        name: "Gemini Image (High Quality)",
        description: "High-quality image generation using Gemini",
        modelId: GEMINI_MODEL_MAP["gemini-image-pro"],
      },
      {
        id: "gpt-image-1",
        name: "OpenAI GPT Image 1",
        description: "OpenAI Images API model",
        modelId: "gpt-image-1",
      },
      {
        id: "gpt-image-1.5",
        name: "OpenAI GPT Image 1.5",
        description: "OpenAI GPT Image model (API key, Azure/OpenRouter, or OpenAI OAuth)",
        modelId: "gpt-image-1.5",
      },
    ];
  }

  private mapOpenAIImageSize(size: ImageSize): OpenAIImageSize {
    // OpenAI image models support "auto" and a fixed set of sizes depending on model.
    // Use conservative defaults; "2K" maps to auto (larger output when supported).
    if (size === "2K") return "auto";
    return "1024x1024";
  }

  private async generateWithGemini(args: {
    apiKey: string;
    modelId: string;
    prompt: string;
    filename?: string;
    imageSize: ImageSize;
    numberOfImages: number;
  }): Promise<ImageGenerationResult> {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${args.modelId}:generateContent`;
    const baseFilename = args.filename || `generated_${Date.now()}`;
    const outputDir = this.workspace.path;

    try {
      console.log(`[ImageGenerator] Generating image with gemini (${args.modelId})`);
      console.log(
        `[ImageGenerator] Prompt: "${args.prompt.substring(0, 100)}${args.prompt.length > 100 ? "..." : ""}"`,
      );

      const images: ImageGenerationResult["images"] = [];
      let textResponse: string | undefined;

      for (let imageIndex = 0; imageIndex < Math.min(args.numberOfImages, 4); imageIndex++) {
        const response = await fetch(`${endpoint}?key=${args.apiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: args.prompt }] }],
            generationConfig: {
              responseModalities: ["IMAGE", "TEXT"],
              imageConfig: { imageSize: args.imageSize },
            },
          }),
        });

        if (!response.ok) {
          const errorBody = await response.text();
          let errorMessage = `Gemini image generation failed: ${response.status} ${response.statusText}`;
          try {
            const errorJson = JSON.parse(errorBody);
            if (errorJson.error?.message) errorMessage = errorJson.error.message;
          } catch {
            // Preserve fallback message when API error is not JSON.
          }

          if (imageIndex === 0) {
            return {
              success: false,
              images: [],
              provider: "gemini",
              model: args.modelId,
              error: errorMessage,
              actionHint: buildSetupHint("gemini"),
            };
          }
          break;
        }

        const data = (await response.json()) as {
          candidates?: Array<{
            content?: {
              parts?: Array<{
                text?: string;
                inlineData?: { mimeType: string; data: string };
              }>;
            };
          }>;
        };

        const parts = data.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
          if (part.text) {
            textResponse = part.text;
          }
          if (part.inlineData?.data) {
            const inlineData = part.inlineData;
            const mimeType = inlineData.mimeType || "image/png";
            const extension = mimetypes.extension(mimeType) || "png";

            const imageName =
              args.numberOfImages > 1
                ? `${baseFilename}_${imageIndex + 1}.${extension}`
                : `${baseFilename}.${extension}`;
            const outputPath = path.join(outputDir, imageName);

            const imageBuffer = Buffer.from(inlineData.data, "base64");
            await fs.promises.writeFile(outputPath, imageBuffer);
            const stats = await fs.promises.stat(outputPath);

            images.push({ path: outputPath, filename: imageName, mimeType, size: stats.size });
          }
        }
      }

      if (images.length === 0) {
        return {
          success: false,
          images: [],
          provider: "gemini",
          model: args.modelId,
          textResponse,
          error:
            textResponse ||
            "No images were generated. The prompt may have been blocked by safety filters.",
          actionHint: buildSetupHint("gemini"),
        };
      }

      return { success: true, images, provider: "gemini", model: args.modelId, textResponse };
    } catch (error: Any) {
      return {
        success: false,
        images: [],
        provider: "gemini",
        model: args.modelId,
        error: error?.message || "Failed to generate image",
        actionHint: buildSetupHint("gemini"),
      };
    }
  }

  private async generateWithOpenAI(args: {
    apiKey: string;
    model: string;
    prompt: string;
    filename?: string;
    imageSize: ImageSize;
    numberOfImages: number;
  }): Promise<ImageGenerationResult> {
    const baseFilename = args.filename || `generated_${Date.now()}`;
    const outputDir = this.workspace.path;
    const size = this.mapOpenAIImageSize(args.imageSize);

    try {
      console.log(`[ImageGenerator] Generating image with openai (${args.model})`);

      const images: ImageGenerationResult["images"] = [];
      const n = Math.min(args.numberOfImages, 4);

      const response = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${args.apiKey}`,
        },
        body: JSON.stringify({
          model: args.model,
          prompt: args.prompt,
          n,
          size,
          // Some image models reject unknown parameters; keep the payload minimal.
          ...(args.model.toLowerCase().startsWith("dall-e-")
            ? { response_format: "b64_json" }
            : {}),
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        let errorMessage = `OpenAI image generation failed: ${response.status} ${response.statusText}`;
        try {
          const errorJson = JSON.parse(errorBody);
          if (errorJson.error?.message) errorMessage = errorJson.error.message;
        } catch {
          // Preserve fallback message when API error is not JSON.
        }
        return {
          success: false,
          images: [],
          provider: "openai",
          model: args.model,
          error: errorMessage,
          actionHint: buildSetupHint("openai"),
        };
      }

      const data = (await response.json()) as Any;
      const items: Any[] = Array.isArray(data?.data) ? data.data : [];
      for (let i = 0; i < items.length; i++) {
        const b64 = items[i]?.b64_json || items[i]?.b64 || items[i]?.base64;
        const url = items[i]?.url;
        if (b64 && typeof b64 === "string") {
          const imageBuffer = Buffer.from(b64, "base64");
          const imageName = n > 1 ? `${baseFilename}_${i + 1}.png` : `${baseFilename}.png`;
          const outputPath = path.join(outputDir, imageName);
          await fs.promises.writeFile(outputPath, imageBuffer);
          const stats = await fs.promises.stat(outputPath);
          images.push({
            path: outputPath,
            filename: imageName,
            mimeType: "image/png",
            size: stats.size,
          });
          continue;
        }
        if (url && typeof url === "string") {
          const dl = await fetch(url);
          if (!dl.ok) continue;
          const arrayBuffer = await dl.arrayBuffer();
          const buf = Buffer.from(arrayBuffer);
          const mimeType = dl.headers.get("content-type") || "image/png";
          const extension = mimetypes.extension(mimeType) || "png";
          const imageName =
            n > 1 ? `${baseFilename}_${i + 1}.${extension}` : `${baseFilename}.${extension}`;
          const outputPath = path.join(outputDir, imageName);
          await fs.promises.writeFile(outputPath, buf);
          const stats = await fs.promises.stat(outputPath);
          images.push({ path: outputPath, filename: imageName, mimeType, size: stats.size });
        }
      }

      if (images.length === 0) {
        return {
          success: false,
          images: [],
          provider: "openai",
          model: args.model,
          error: "No images were returned by OpenAI.",
          actionHint: buildSetupHint("openai"),
        };
      }

      return { success: true, images, provider: "openai", model: args.model };
    } catch (error: Any) {
      return {
        success: false,
        images: [],
        provider: "openai",
        model: args.model,
        error: error?.message || "Failed to generate image",
        actionHint: buildSetupHint("openai"),
      };
    }
  }

  private async generateWithOpenAICodex(args: {
    apiKey: string;
    accessToken: string;
    model: string;
    prompt: string;
    filename?: string;
    imageSize: ImageSize;
    numberOfImages: number;
  }): Promise<ImageGenerationResult> {
    const baseFilename = args.filename || `generated_${Date.now()}`;
    const outputDir = this.workspace.path;
    const size = this.mapOpenAIImageSize(args.imageSize);
    const writtenPaths: string[] = [];
    const cleanupWrittenImages = async () => {
      await Promise.all(
        writtenPaths.map((filePath) => fs.promises.unlink(filePath).catch(() => undefined)),
      );
    };

    try {
      console.log(`[ImageGenerator] Generating image with openai-codex (${args.model})`);

      const accountId = extractChatGPTAccountId(args.accessToken);
      const hostModel = await resolveOpenAICodexHostModel();
      const client = new OpenAI({
        apiKey: args.apiKey,
        baseURL: OPENAI_CODEX_BASE_URL,
        defaultHeaders: {
          "chatgpt-account-id": accountId,
          "OpenAI-Beta": "responses=experimental",
          originator: "cowork-os",
        },
      });

      const images: ImageGenerationResult["images"] = [];
      const n = Math.min(args.numberOfImages, 4);

      for (let i = 0; i < n; i++) {
        let imageBase64: string | null = null;
        const stream = client.responses.stream({
          model: hostModel,
          store: false,
          instructions: OPENAI_CODEX_IMAGE_INSTRUCTIONS,
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: args.prompt }],
            },
          ],
          tools: [
            {
              type: "image_generation",
              model: args.model,
              size,
              output_format: "png",
              background: "opaque",
              partial_images: 1,
              ...(args.model === "gpt-image-1.5" ? { action: "generate" } : {}),
            },
          ],
          tool_choice: {
            type: "allowed_tools",
            mode: "required",
            tools: [{ type: "image_generation" }],
          },
        });

        for await (const event of stream) {
          if (event.type === "response.output_item.done" && event.item.type === "image_generation_call") {
            if (typeof event.item.result === "string" && event.item.result) {
              imageBase64 = event.item.result;
            }
          } else if (event.type === "response.image_generation_call.partial_image") {
            if (typeof event.partial_image_b64 === "string" && event.partial_image_b64) {
              imageBase64 = event.partial_image_b64;
            }
          }
        }

        const finalResponse = await stream.finalResponse();
        for (const item of finalResponse.output || []) {
          if (item.type === "image_generation_call" && typeof item.result === "string" && item.result) {
            imageBase64 = item.result;
          }
        }

        if (!imageBase64) {
          await cleanupWrittenImages();
          return {
            success: false,
            images: [],
            provider: "openai-codex",
            model: args.model,
            error: "No images were returned by OpenAI OAuth image generation.",
            actionHint: buildSetupHint("openai-codex"),
          };
        }

        const imageBuffer = Buffer.from(imageBase64, "base64");
        const imageName = n > 1 ? `${baseFilename}_${i + 1}.png` : `${baseFilename}.png`;
        const outputPath = path.join(outputDir, imageName);
        await fs.promises.writeFile(outputPath, imageBuffer);
        writtenPaths.push(outputPath);
        const stats = await fs.promises.stat(outputPath);
        images.push({
          path: outputPath,
          filename: imageName,
          mimeType: "image/png",
          size: stats.size,
        });
      }

      return { success: true, images, provider: "openai-codex", model: args.model };
    } catch (error: Any) {
      await cleanupWrittenImages();
      return {
        success: false,
        images: [],
        provider: "openai-codex",
        model: args.model,
        error: error?.message || "Failed to generate image",
        actionHint: buildSetupHint("openai-codex"),
      };
    }
  }

  private async generateWithAzureOpenAI(args: {
    apiKey: string;
    endpoint: string;
    apiVersion: string;
    deployment: string;
    prompt: string;
    filename?: string;
    imageSize: ImageSize;
    numberOfImages: number;
  }): Promise<ImageGenerationResult> {
    const baseFilename = args.filename || `generated_${Date.now()}`;
    const outputDir = this.workspace.path;
    const size = this.mapOpenAIImageSize(args.imageSize);
    const endpoint = args.endpoint.replace(/\/+$/, "");
    const deployment = encodeURIComponent(args.deployment);
    const apiVersion = encodeURIComponent(args.apiVersion);
    const url = `${endpoint}/openai/deployments/${deployment}/images/generations?api-version=${apiVersion}`;

    try {
      console.log(`[ImageGenerator] Generating image with azure (${args.deployment})`);

      const images: ImageGenerationResult["images"] = [];
      const n = Math.min(args.numberOfImages, 4);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": args.apiKey,
        },
        body: JSON.stringify({
          prompt: args.prompt,
          n,
          size,
          // Keep payload minimal; some Azure deployments reject unknown parameters.
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        let errorMessage = `Azure OpenAI image generation failed: ${response.status} ${response.statusText}`;
        try {
          const errorJson = JSON.parse(errorBody);
          if (errorJson.error?.message) errorMessage = errorJson.error.message;
        } catch {
          // Preserve fallback message when API error is not JSON.
        }
        console.error("[ImageGenerator] Azure images/generations error:", {
          status: response.status,
          statusText: response.statusText,
          deployment: args.deployment,
          apiVersion: args.apiVersion,
          message: errorMessage,
        });
        return {
          success: false,
          images: [],
          provider: "azure",
          model: args.deployment,
          error: errorMessage,
          actionHint: buildSetupHint("azure"),
        };
      }

      const data = (await response.json()) as Any;
      const items: Any[] = Array.isArray(data?.data) ? data.data : [];
      for (let i = 0; i < items.length; i++) {
        const b64 = items[i]?.b64_json || items[i]?.b64 || items[i]?.base64;
        const url = items[i]?.url;
        if (b64 && typeof b64 === "string") {
          const imageBuffer = Buffer.from(b64, "base64");
          const imageName = n > 1 ? `${baseFilename}_${i + 1}.png` : `${baseFilename}.png`;
          const outputPath = path.join(outputDir, imageName);
          await fs.promises.writeFile(outputPath, imageBuffer);
          const stats = await fs.promises.stat(outputPath);
          images.push({
            path: outputPath,
            filename: imageName,
            mimeType: "image/png",
            size: stats.size,
          });
          continue;
        }
        if (url && typeof url === "string") {
          const dl = await fetch(url);
          if (!dl.ok) continue;
          const arrayBuffer = await dl.arrayBuffer();
          const buf = Buffer.from(arrayBuffer);
          const mimeType = dl.headers.get("content-type") || "image/png";
          const extension = mimetypes.extension(mimeType) || "png";
          const imageName =
            n > 1 ? `${baseFilename}_${i + 1}.${extension}` : `${baseFilename}.${extension}`;
          const outputPath = path.join(outputDir, imageName);
          await fs.promises.writeFile(outputPath, buf);
          const stats = await fs.promises.stat(outputPath);
          images.push({ path: outputPath, filename: imageName, mimeType, size: stats.size });
        }
      }

      if (images.length === 0) {
        return {
          success: false,
          images: [],
          provider: "azure",
          model: args.deployment,
          error: "No images were returned by Azure OpenAI.",
          actionHint: buildSetupHint("azure"),
        };
      }

      return { success: true, images, provider: "azure", model: args.deployment };
    } catch (error: Any) {
      return {
        success: false,
        images: [],
        provider: "azure",
        model: args.deployment,
        error: error?.message || "Failed to generate image",
        actionHint: buildSetupHint("azure"),
      };
    }
  }

  private async generateWithOpenRouter(args: {
    apiKey: string;
    baseUrl: string;
    model: string;
    prompt: string;
    filename?: string;
    imageSize: ImageSize;
    numberOfImages: number;
  }): Promise<ImageGenerationResult> {
    const baseFilename = args.filename || `generated_${Date.now()}`;
    const outputDir = this.workspace.path;
    const url = `${args.baseUrl}/chat/completions`;

    try {
      console.log(`[ImageGenerator] Generating image with openrouter (${args.model})`);

      const body: Record<string, Any> = {
        model: args.model,
        messages: [{ role: "user", content: args.prompt }],
        modalities: ["image", "text"],
        image_config: { image_size: args.imageSize },
      };

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${args.apiKey}`,
          ...getOpenRouterAttributionHeaders(),
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        let errorMessage = `OpenRouter image generation failed: ${response.status} ${response.statusText}`;
        try {
          const errorJson = JSON.parse(errorBody);
          if (errorJson.error?.message) errorMessage = errorJson.error.message;
        } catch {
          // Preserve fallback message when API error is not JSON.
        }
        return {
          success: false,
          images: [],
          provider: "openrouter",
          model: args.model,
          error: errorMessage,
          actionHint: buildSetupHint("openrouter"),
        };
      }

      const data = (await response.json()) as Any;
      const message = data?.choices?.[0]?.message;
      const imageItems: Array<{ image_url?: { url?: string }; imageUrl?: { url?: string } }> =
        message?.images || message?.content?.filter?.((p: Any) => p.type === "image_url") || [];

      const images: ImageGenerationResult["images"] = [];
      const n = Math.min(args.numberOfImages, imageItems.length || 4);

      for (let i = 0; i < imageItems.length && images.length < n; i++) {
        const item = imageItems[i];
        const dataUrl =
          item?.image_url?.url || item?.imageUrl?.url || (typeof item === "string" ? item : null);
        if (!dataUrl || !dataUrl.startsWith("data:image/")) continue;

        const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
        if (!match) continue;

        const mimeType = `image/${match[1]}`;
        const extension = mimetypes.extension(mimeType) || "png";
        const imageName =
          imageItems.length > 1 ? `${baseFilename}_${i + 1}.${extension}` : `${baseFilename}.${extension}`;
        const outputPath = path.join(outputDir, imageName);

        const imageBuffer = Buffer.from(match[2], "base64");
        await fs.promises.writeFile(outputPath, imageBuffer);
        const stats = await fs.promises.stat(outputPath);
        images.push({ path: outputPath, filename: imageName, mimeType, size: stats.size });
      }

      if (images.length === 0) {
        return {
          success: false,
          images: [],
          provider: "openrouter",
          model: args.model,
          error:
            (message?.content as string) ||
            "No images were returned by OpenRouter. The model may not support image generation.",
          actionHint: buildSetupHint("openrouter"),
        };
      }

      return { success: true, images, provider: "openrouter", model: args.model };
    } catch (error: Any) {
      return {
        success: false,
        images: [],
        provider: "openrouter",
        model: args.model,
        error: error?.message || "Failed to generate image",
        actionHint: buildSetupHint("openrouter"),
      };
    }
  }
}
