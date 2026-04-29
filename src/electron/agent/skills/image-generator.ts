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
 * - OpenAI models are passed through to the Images API (e.g. gpt-image-2).
 * - Azure OpenAI uses deployments; for Azure, "model" maps to deployment name.
 */
export type ImageModel =
  | "gpt-image-1"
  | "gpt-image-1.5"
  | "gpt-image-2"
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
   * - OpenAI: gpt-image-2 | gpt-image-1 | gpt-image-1.5 | dall-e-3 | dall-e-2 (also accepts "gpt-2" alias)
   * - Azure: deployment name
   */
  model?: ImageModel;
  filename?: string;
  imageSize?: ImageSize;
  numberOfImages?: number;
  /** Internal cancellation signal from the task executor. */
  signal?: AbortSignal;
  /** Internal progress hook for timeline-visible provider transitions. */
  onProgress?: (event: {
    type: "image_generation_attempt" | "image_generation_fallback";
    provider: ImageProvider;
    model: string;
    message: string;
    timeoutMs?: number;
    fallbackModel?: string;
  }) => void;
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

function throwIfImageGenerationAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Image generation cancelled");
  }
}

const DEFAULT_IMAGE_PROVIDER_TIMEOUT_SECONDS = 300;
const MIN_IMAGE_PROVIDER_TIMEOUT_SECONDS = 30;
const MAX_IMAGE_PROVIDER_TIMEOUT_SECONDS = 30 * 60;

function formatImageGenerationError(error: unknown): string {
  const err = error as Any;
  const message =
    typeof err?.message === "string" && err.message.trim()
      ? err.message.trim()
      : String(error || "").trim() || "Failed to generate image";
  const cause = err?.cause as Any;
  const causeParts = [
    typeof cause?.code === "string" ? cause.code : "",
    typeof cause?.message === "string" ? cause.message : "",
  ].filter((value) => value.trim().length > 0);
  return causeParts.length > 0 ? `${message}: ${causeParts.join(" - ")}` : message;
}

function isTransientImageProviderError(error: string | undefined): boolean {
  const lower = String(error || "").toLowerCase();
  return (
    lower.includes("fetch failed") ||
    lower.includes("network") ||
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("und_err") ||
    lower.includes("socket") ||
    lower.includes("temporarily unavailable") ||
    lower.includes("service unavailable") ||
    lower.includes("gateway")
  );
}

function imageProviderTimeoutKey(
  provider: ImageProvider,
): "openai" | "openaiCodex" | "azure" | "openrouter" | "gemini" {
  return provider === "openai-codex" ? "openaiCodex" : provider;
}

function normalizeImageProviderTimeoutSeconds(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(
    MAX_IMAGE_PROVIDER_TIMEOUT_SECONDS,
    Math.max(MIN_IMAGE_PROVIDER_TIMEOUT_SECONDS, Math.round(n)),
  );
}

function getImageProviderTimeoutMs(
  settings: ReturnType<typeof LLMProviderFactory.loadSettings>,
  provider: ImageProvider,
): number {
  const key = imageProviderTimeoutKey(provider);
  const configured = normalizeImageProviderTimeoutSeconds(settings.imageGeneration?.timeouts?.[key]);
  return (configured ?? DEFAULT_IMAGE_PROVIDER_TIMEOUT_SECONDS) * 1000;
}

async function runWithImageProviderTimeout<T>(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<{ result: T; timedOut: boolean }> {
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => controller.abort();
  if (parentSignal?.aborted) {
    controller.abort();
  } else {
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return { result: await run(controller.signal), timedOut };
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
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
const OPENAI_CODEX_RESPONSES_IMAGE_MODEL_PREFERENCE = ["gpt-image-2"] as const;
const OPENAI_CODEX_RESPONSES_IMAGE_MODELS = new Set<string>(
  OPENAI_CODEX_RESPONSES_IMAGE_MODEL_PREFERENCE,
);
const OPENAI_CODEX_LEGACY_IMAGE_MODELS = new Set<string>(["gpt-image-1.5", "gpt-image-1"]);

function getDefaultOpenAICodexImageModel(): ImageModel {
  return OPENAI_CODEX_RESPONSES_IMAGE_MODEL_PREFERENCE[0];
}

function resolveOpenAICodexImageModelOverride(modelOverride?: string): string | null {
  const normalized = normalizeOpenAIImageModel(modelOverride);
  if (!normalized) return null;
  if (OPENAI_CODEX_LEGACY_IMAGE_MODELS.has(normalized.toLowerCase())) {
    return getDefaultOpenAICodexImageModel();
  }
  return normalized;
}

function buildSetupHint(provider: ImageProvider): { type: string; label: string; target: string } {
  if (provider === "gemini")
    return { type: "open_settings", label: "Set up Gemini API key", target: "gemini" };
  if (provider === "azure")
    return { type: "open_settings", label: "Set up Azure OpenAI", target: "azure" };
  if (provider === "openrouter")
    return { type: "open_settings", label: "Set up OpenRouter API key", target: "openrouter" };
  if (provider === "openai-codex") {
    return { type: "open_settings", label: "Sign in with ChatGPT", target: "openai" };
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
  if (m === "gpt-2" || m === "gpt2") return "gpt-image-2";
  if (m === "gpt-1" || m === "gpt1") return "gpt-image-1";
  if (m === "dalle-3") return "dall-e-3";
  if (m === "dalle-2") return "dall-e-2";
  return raw;
}

function inferOpenAIImageModelFromText(text: string): string | null {
  const t = (text || "").toLowerCase();
  if (!t.trim()) return null;
  if (t.includes("gpt-image-2") || t.includes("gpt-2") || t.includes("gpt2"))
    return "gpt-image-2";
  if (t.includes("gpt-image-1.5") || t.includes("gpt-1.5") || t.includes("gpt1.5"))
    return "gpt-image-1.5";
  if (t.includes("gpt-image-1") || t.includes("gpt-1") || t.includes("gpt1")) return "gpt-image-1";
  if (t.includes("dall-e-3") || t.includes("dalle-3")) return "dall-e-3";
  if (t.includes("dall-e-2") || t.includes("dalle-2")) return "dall-e-2";
  return null;
}

function normalizeOpenRouterImageModel(model?: string): string | undefined {
  const normalized = normalizeOpenAIImageModel(model);
  if (!normalized) return undefined;
  return normalized.includes("/") ? normalized : `openai/${normalized}`;
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

/**
 * Normalize Azure endpoint variants users paste into Settings to the resource base URL.
 * e.g. "https://foo.openai.azure.com/openai/v1/videos" -> "https://foo.openai.azure.com"
 * e.g. "https://foo.openai.azure.com/openai/deployments/x/images/generations" -> "https://foo.openai.azure.com"
 */
function normalizeAzureImageBaseEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  const idx = trimmed.indexOf("/openai/");
  if (idx !== -1) return trimmed.slice(0, idx);
  return trimmed;
}

function getAzureConfiguredDeployments(
  settings: ReturnType<typeof LLMProviderFactory.loadSettings>,
): string[] {
  return uniqStrings([
    settings.imageGeneration?.azure?.imageDeployment,
    settings.azure?.deployment,
    ...(settings.azure?.deployments || []),
  ]);
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
  allowFallback?: boolean;
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
      return args.allowFallback ? uniqStrings([match, ...imageDeployments]) : [match];
    }
    if (
      looksLikeImageDeployment(override) ||
      isOpenAIImageModel(normalizeOpenAIImageModel(override))
    ) {
      return args.allowFallback ? uniqStrings([override, ...imageDeployments]) : [override];
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
  if (
    t.includes("codex auth") ||
    t.includes("openai oauth") ||
    t.includes("chatgpt oauth") ||
    t.includes("chatgpt subscription")
  )
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
    !!(settings.imageGeneration?.azure?.imageApiKey?.trim() || settings.azure?.apiKey?.trim()) &&
    !!(settings.imageGeneration?.azure?.imageEndpoint?.trim() || settings.azure?.endpoint?.trim()) &&
    azureImageDeployments.length > 0;
  if (azureOk) providers.push("azure");

  const openaiKey = settings.imageGeneration?.openai?.apiKey?.trim() || settings.openai?.apiKey?.trim();
  if (openaiKey) providers.push("openai");

  if (hasOpenAIOAuthTokens(settings)) providers.push("openai-codex");

  const openrouterKey =
    settings.imageGeneration?.openrouter?.apiKey?.trim() || settings.openrouter?.apiKey?.trim();
  if (openrouterKey) providers.push("openrouter");

  const geminiKey = settings.imageGeneration?.gemini?.apiKey?.trim() || settings.gemini?.apiKey?.trim();
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

type ImageModelPreset = "gpt-image-2" | "gpt-image-1.5" | "nano-banana-2" | (string & {});

function getCompatibleImageModelPreset(
  provider: ImageProvider,
  preset?: ImageModelPreset,
): ImageModelPreset | undefined {
  if (!preset) return undefined;
  if (preset === "nano-banana-2") return provider === "gemini" ? preset : undefined;
  if (provider === "openai-codex") {
    return resolveOpenAICodexImageModelOverride(preset) || undefined;
  }
  if (isOpenAIImageModel(preset))
    return provider === "gemini" ? undefined : normalizeOpenAIImageModel(preset) || preset;
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

  if (
    !defaultProvider &&
    (defaultPreset === "gpt-image-2" || defaultPreset === "gpt-image-1.5")
  ) {
    for (const p of ["azure", "openai", "openai-codex", "openrouter"] as ImageProvider[]) {
      if (configured.includes(p)) order.push({ provider: p, modelPreset: defaultPreset });
    }
  }
  if (!defaultProvider && defaultPreset === "nano-banana-2" && configured.includes("gemini")) {
    order.push({ provider: "gemini", modelPreset: "nano-banana-2" });
  }

  pushConfiguredImageRoute(order, configured, backupProvider, backupPreset);

  if (!backupProvider && backupPreset && backupPreset !== defaultPreset) {
    if (backupPreset === "gpt-image-2" || backupPreset === "gpt-image-1.5") {
      for (const p of ["azure", "openai", "openai-codex", "openrouter"] as ImageProvider[]) {
        if (configured.includes(p) && !order.some((o) => o.provider === p))
          order.push({ provider: p, modelPreset: backupPreset });
      }
    } else if (backupPreset === "nano-banana-2" && configured.includes("gemini")) {
      if (!order.some((o) => o.provider === "gemini"))
        order.push({ provider: "gemini", modelPreset: "nano-banana-2" });
    }
  }

  return order;
}

function shouldPreferOpenAICodexFromActiveProvider(
  settings: ReturnType<typeof LLMProviderFactory.loadSettings>,
): boolean {
  return (
    settings.providerType === "openai" &&
    settings.openai?.authMethod === "oauth" &&
    hasOpenAIOAuthTokens(settings)
  );
}

function buildOpenAICodexPreferredOrder(
  configured: ImageProvider[],
): Array<{ provider: ImageProvider; modelPreset?: ImageModelPreset }> {
  const order: ImageProvider[] = ["openai-codex"];
  for (const provider of configured) {
    if (!order.includes(provider)) order.push(provider);
  }
  for (const provider of [
    "gemini",
    "openai",
    "azure",
    "openrouter",
  ] as ImageProvider[]) {
    if (!order.includes(provider)) order.push(provider);
  }
  return order.map((provider) => ({
    provider,
    modelPreset: provider === "openai-codex" ? getDefaultOpenAICodexImageModel() : undefined,
  }));
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

  if (
    !explicitProvider &&
    !args.modelOverride &&
    shouldPreferOpenAICodexFromActiveProvider(settings) &&
    configured.includes("openai-codex")
  ) {
    return buildOpenAICodexPreferredOrder(configured);
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
    throw new Error("ChatGPT subscription sign-in is not configured");
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
    throw new Error("ChatGPT subscription sign-in has expired. Sign in again in Settings.");
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
    const signal = request.signal;
    const onProgress = request.onProgress;

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
    const emitProviderFallback = (
      provider: ImageProvider,
      model: string,
      timeoutMs: number,
      nextEntry?: { provider: ImageProvider; modelPreset?: ImageModelPreset },
    ) => {
      if (!nextEntry || signal?.aborted) return;
      onProgress?.({
        type: "image_generation_fallback",
        provider,
        model,
        timeoutMs,
        fallbackModel: nextEntry.modelPreset || nextEntry.provider,
        message: `${provider} image generation timed out after ${Math.round(timeoutMs / 1000)}s; falling back to ${nextEntry.provider}${nextEntry.modelPreset ? ` (${nextEntry.modelPreset})` : ""}.`,
      });
    };

    if (providerOrder.length === 0) {
      return {
        success: false,
        images: [],
        model: normalizeOpenAIImageModel(modelOverride) || "gpt-image-1.5",
        error:
          "No image generation provider configured. Configure Gemini/OpenAI/Azure/OpenRouter/ChatGPT Subscription in Settings.",
        actionHint: buildSetupHint("openai"),
      };
    }

    for (let providerIndex = 0; providerIndex < providerOrder.length; providerIndex += 1) {
      const entry = providerOrder[providerIndex];
      const nextProviderEntry = providerOrder[providerIndex + 1];
      const { provider, modelPreset } = entry;
      try {
        if (provider === "gemini") {
          const providerTimeoutMs = getImageProviderTimeoutMs(settings, provider);
          const apiKey =
            settings.imageGeneration?.gemini?.apiKey?.trim() || settings.gemini?.apiKey?.trim();
          if (!apiKey) {
            if (configuredProviders.includes("gemini")) {
              considerError("gemini", "Gemini API key not configured.");
            }
            continue;
          }
          const chosen: "gemini-image-fast" | "gemini-image-pro" | "nano-banana-2" =
            settings.imageGeneration?.gemini?.model === "nano-banana-2"
              ? "nano-banana-2"
              : modelPreset === "nano-banana-2"
                ? "nano-banana-2"
                : modelOverride === "gemini-image-fast" || modelOverride === "gemini-image-pro"
                  ? (modelOverride as Any)
                  : "gemini-image-pro";
          const modelId = GEMINI_MODEL_MAP[chosen];
          onProgress?.({
            type: "image_generation_attempt",
            provider,
            model: modelId,
            timeoutMs: providerTimeoutMs,
            message: `Trying Gemini image model ${modelId} (timeout ${Math.round(providerTimeoutMs / 1000)}s).`,
          });
          const attempt = await runWithImageProviderTimeout(signal, providerTimeoutMs, (attemptSignal) =>
            this.generateWithGemini({
              apiKey,
              modelId,
              prompt,
              filename,
              imageSize,
              numberOfImages,
              signal: attemptSignal,
            }),
          );
          if (attempt.result.success || !attempt.timedOut) return attempt.result;
          considerError(provider, attempt.result.error || "Gemini image generation timed out.", modelId);
          emitProviderFallback(provider, modelId, providerTimeoutMs, nextProviderEntry);
          continue;
        }

        if (provider === "openai") {
          const providerTimeoutMs = getImageProviderTimeoutMs(settings, provider);
          const apiKey =
            settings.imageGeneration?.openai?.apiKey?.trim() || settings.openai?.apiKey?.trim();
          if (!apiKey) {
            if (configuredProviders.includes("openai")) {
              considerError("openai", "OpenAI API key not configured.");
            }
            continue;
          }
          const chosenModel =
            resolveOpenAIModelOverride(settings.imageGeneration?.openai?.model) ||
            resolveOpenAIModelOverride(modelOverride) ||
            resolveOpenAIModelOverride(modelPreset) ||
            inferOpenAIImageModelFromText(prompt) ||
            "gpt-image-1.5";
          onProgress?.({
            type: "image_generation_attempt",
            provider,
            model: chosenModel,
            timeoutMs: providerTimeoutMs,
            message: `Trying OpenAI image model ${chosenModel} (timeout ${Math.round(providerTimeoutMs / 1000)}s).`,
          });
          const attempt = await runWithImageProviderTimeout(signal, providerTimeoutMs, (attemptSignal) =>
            this.generateWithOpenAI({
              apiKey,
              model: chosenModel,
              prompt,
              filename,
              imageSize,
              numberOfImages,
              signal: attemptSignal,
            }),
          );
          if (attempt.result.success || !attempt.timedOut) return attempt.result;
          considerError(provider, attempt.result.error || "OpenAI image generation timed out.", chosenModel);
          emitProviderFallback(provider, chosenModel, providerTimeoutMs, nextProviderEntry);
          continue;
        }

        if (provider === "openai-codex") {
          const providerTimeoutMs = getImageProviderTimeoutMs(settings, provider);
          if (!hasOpenAIOAuthTokens(settings)) {
            if (configuredProviders.includes("openai-codex")) {
              considerError("openai-codex", "ChatGPT subscription is not connected.");
            }
            continue;
          }
          const chosenModel =
            resolveOpenAICodexImageModelOverride(settings.imageGeneration?.openaiCodex?.model) ||
            resolveOpenAICodexImageModelOverride(modelOverride) ||
            resolveOpenAICodexImageModelOverride(modelPreset) ||
            resolveOpenAICodexImageModelOverride(inferOpenAIImageModelFromText(prompt) || undefined) ||
            getDefaultOpenAICodexImageModel();
          const normalizedChosenModel = normalizeOpenAIImageModel(chosenModel) || chosenModel;
          if (!OPENAI_CODEX_RESPONSES_IMAGE_MODELS.has(normalizedChosenModel.toLowerCase())) {
            considerError(
              "openai-codex",
              `ChatGPT subscription image generation supports GPT Image models in the Responses tool path (for example ${getDefaultOpenAICodexImageModel()}).`,
              normalizedChosenModel,
            );
            continue;
          }
          const credentials = await resolveOpenAICodexCredentials(settings);
          onProgress?.({
            type: "image_generation_attempt",
            provider,
            model: normalizedChosenModel,
            timeoutMs: providerTimeoutMs,
            message: `Trying ChatGPT subscription image model ${normalizedChosenModel} (timeout ${Math.round(providerTimeoutMs / 1000)}s).`,
          });
          const attempt = await runWithImageProviderTimeout(signal, providerTimeoutMs, (attemptSignal) =>
            this.generateWithOpenAICodex({
              apiKey: credentials.apiKey,
              accessToken: credentials.accessToken,
              model: normalizedChosenModel,
              prompt,
              filename,
              imageSize,
              numberOfImages,
              signal: attemptSignal,
            }),
          );
          if (attempt.result.success || !attempt.timedOut) return attempt.result;
          considerError(
            provider,
            attempt.result.error || "ChatGPT subscription image generation timed out.",
            normalizedChosenModel,
          );
          emitProviderFallback(provider, normalizedChosenModel, providerTimeoutMs, nextProviderEntry);
          continue;
        }

        if (provider === "azure") {
          const providerTimeoutMs = getImageProviderTimeoutMs(settings, provider);
          const apiKey =
            settings.imageGeneration?.azure?.imageApiKey?.trim() || settings.azure?.apiKey?.trim();
          const endpoint =
            settings.imageGeneration?.azure?.imageEndpoint?.trim() ||
            settings.azure?.endpoint?.trim();
          const apiVersion =
            settings.imageGeneration?.azure?.imageApiVersion?.trim() ||
            settings.azure?.apiVersion?.trim() ||
            "2024-02-15-preview";
          const azureModelOverride =
            settings.imageGeneration?.azure?.imageDeployment?.trim() ||
            (modelPreset === "gpt-image-2" ? "gpt-image-2" : null) ||
            (modelPreset === "gpt-image-1.5" ? "gpt-image-1.5" : modelOverride);
          const deploymentsToTry = selectAzureImageDeployments({
            settings,
            modelOverride: azureModelOverride,
            prompt,
            allowFallback: true,
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
          let azureTimedOut = false;
          for (let i = 0; i < deploymentsToTry.length; i += 1) {
            const deployment = deploymentsToTry[i];
            const nextDeployment = deploymentsToTry[i + 1];
            onProgress?.({
              type: "image_generation_attempt",
              provider,
              model: deployment,
              timeoutMs: providerTimeoutMs,
              fallbackModel: nextDeployment,
              message: `Trying Azure image deployment ${deployment} (timeout ${Math.round(providerTimeoutMs / 1000)}s).`,
            });
            const attempt = await runWithImageProviderTimeout(signal, providerTimeoutMs, (attemptSignal) =>
              this.generateWithAzureOpenAI({
                apiKey,
                endpoint,
                apiVersion,
                deployment,
                prompt,
                filename,
                imageSize,
                numberOfImages,
                signal: attemptSignal,
              }),
            );
            if (attempt.result.success) {
              return attempt.result;
            }
            azureLast = attempt.result;
            azureTimedOut = attempt.timedOut;
            const shouldTryNextDeployment =
              nextDeployment &&
              !signal?.aborted &&
              (attempt.timedOut || isTransientImageProviderError(attempt.result.error));
            if (shouldTryNextDeployment) {
              onProgress?.({
                type: "image_generation_fallback",
                provider,
                model: deployment,
                timeoutMs: providerTimeoutMs,
                fallbackModel: nextDeployment,
                message: attempt.timedOut
                  ? `Azure image deployment ${deployment} timed out after ${Math.round(providerTimeoutMs / 1000)}s; falling back to ${nextDeployment}.`
                  : `Azure image deployment ${deployment} failed with a transient provider error (${attempt.result.error || "unknown error"}); falling back to ${nextDeployment}.`,
              });
              continue;
            }
            break;
          }

          considerError(
            "azure",
            azureLast?.error || "Azure OpenAI image generation failed",
            azureLast?.model,
          );
          if (azureTimedOut && azureLast?.model) {
            emitProviderFallback("azure", azureLast.model, providerTimeoutMs, nextProviderEntry);
          }
          continue;
        }

        if (provider === "openrouter") {
          const providerTimeoutMs = getImageProviderTimeoutMs(settings, provider);
          const apiKey =
            settings.imageGeneration?.openrouter?.apiKey?.trim() ||
            settings.openrouter?.apiKey?.trim();
          const baseUrl = (
            settings.imageGeneration?.openrouter?.baseUrl?.trim() ||
            settings.openrouter?.baseUrl?.trim() ||
            "https://openrouter.ai/api/v1"
          ).replace(/\/+$/, "");
          if (!apiKey) {
            if (configuredProviders.includes("openrouter")) {
              considerError("openrouter", "OpenRouter API key not configured.");
            }
            continue;
          }
          const configuredOpenRouterModel = normalizeOpenRouterImageModel(
            settings.imageGeneration?.openrouter?.model,
          );
          const openaiModel =
            resolveOpenAIModelOverride(modelOverride) ||
            (modelPreset === "gpt-image-2" ? "gpt-image-2" : null) ||
            (modelPreset === "gpt-image-1.5" ? "gpt-image-1.5" : null) ||
            inferOpenAIImageModelFromText(prompt) ||
            "gpt-image-1.5";
          const openRouterModel = configuredOpenRouterModel || `openai/${openaiModel}`;
          onProgress?.({
            type: "image_generation_attempt",
            provider,
            model: openRouterModel,
            timeoutMs: providerTimeoutMs,
            message: `Trying OpenRouter image model ${openRouterModel} (timeout ${Math.round(providerTimeoutMs / 1000)}s).`,
          });
          const attempt = await runWithImageProviderTimeout(signal, providerTimeoutMs, (attemptSignal) =>
            this.generateWithOpenRouter({
              apiKey,
              baseUrl,
              model: openRouterModel,
              prompt,
              filename,
              imageSize,
              numberOfImages,
              signal: attemptSignal,
            }),
          );
          if (attempt.result.success) return attempt.result;
          considerError(
            "openrouter",
            attempt.result.error || "OpenRouter image generation failed",
            attempt.result.model,
          );
          if (attempt.timedOut) {
            emitProviderFallback(provider, openRouterModel, providerTimeoutMs, nextProviderEntry);
            continue;
          }
          return attempt.result;
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
        id: "gpt-image-2",
        name: "OpenAI GPT Image 2",
        description: "OpenAI GPT Image model (API key, Azure/OpenRouter, or ChatGPT subscription)",
        modelId: "gpt-image-2",
      },
      {
        id: "gpt-image-1.5",
        name: "OpenAI GPT Image 1.5",
        description: "OpenAI GPT Image model (API key, Azure/OpenRouter, or ChatGPT subscription)",
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
    signal?: AbortSignal;
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
        throwIfImageGenerationAborted(args.signal);
        const response = await fetch(`${endpoint}?key=${args.apiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: args.signal,
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
          throwIfImageGenerationAborted(args.signal);
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
    signal?: AbortSignal;
  }): Promise<ImageGenerationResult> {
    const baseFilename = args.filename || `generated_${Date.now()}`;
    const outputDir = this.workspace.path;
    const size = this.mapOpenAIImageSize(args.imageSize);

    try {
      console.log(`[ImageGenerator] Generating image with openai (${args.model})`);

      const images: ImageGenerationResult["images"] = [];
      const n = Math.min(args.numberOfImages, 4);
      throwIfImageGenerationAborted(args.signal);

      const response = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${args.apiKey}`,
        },
        signal: args.signal,
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
        throwIfImageGenerationAborted(args.signal);
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
          const dl = await fetch(url, { signal: args.signal });
          if (!dl.ok) continue;
          throwIfImageGenerationAborted(args.signal);
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
    signal?: AbortSignal;
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
        throwIfImageGenerationAborted(args.signal);
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
        } as Any, args.signal ? ({ signal: args.signal } as Any) : undefined);

        for await (const event of stream) {
          throwIfImageGenerationAborted(args.signal);
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
        throwIfImageGenerationAborted(args.signal);
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
            error: "No images were returned by ChatGPT subscription image generation.",
            actionHint: buildSetupHint("openai-codex"),
          };
        }

        const imageBuffer = Buffer.from(imageBase64, "base64");
        const imageName = n > 1 ? `${baseFilename}_${i + 1}.png` : `${baseFilename}.png`;
        const outputPath = path.join(outputDir, imageName);
        throwIfImageGenerationAborted(args.signal);
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
    signal?: AbortSignal;
  }): Promise<ImageGenerationResult> {
    const baseFilename = args.filename || `generated_${Date.now()}`;
    const outputDir = this.workspace.path;
    const size = this.mapOpenAIImageSize(args.imageSize);
    const endpoint = normalizeAzureImageBaseEndpoint(args.endpoint);
    const deployment = encodeURIComponent(args.deployment);
    const apiVersion = encodeURIComponent(args.apiVersion);
    const url = `${endpoint}/openai/deployments/${deployment}/images/generations?api-version=${apiVersion}`;

    try {
      console.log(`[ImageGenerator] Generating image with azure (${args.deployment})`);

      const images: ImageGenerationResult["images"] = [];
      const n = Math.min(args.numberOfImages, 4);
      throwIfImageGenerationAborted(args.signal);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": args.apiKey,
        },
        signal: args.signal,
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
        throwIfImageGenerationAborted(args.signal);
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
          const dl = await fetch(url, { signal: args.signal });
          if (!dl.ok) continue;
          throwIfImageGenerationAborted(args.signal);
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
      const errorMessage = formatImageGenerationError(error);
      console.error("[ImageGenerator] Azure images/generations request failed:", {
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
  }

  private async generateWithOpenRouter(args: {
    apiKey: string;
    baseUrl: string;
    model: string;
    prompt: string;
    filename?: string;
    imageSize: ImageSize;
    numberOfImages: number;
    signal?: AbortSignal;
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

      throwIfImageGenerationAborted(args.signal);
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${args.apiKey}`,
          ...getOpenRouterAttributionHeaders(),
        },
        signal: args.signal,
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
        throwIfImageGenerationAborted(args.signal);
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
