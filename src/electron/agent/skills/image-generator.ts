import * as fs from "fs";
import * as path from "path";
import * as mimetypes from "mime-types";
import { Workspace } from "../../../shared/types";
import { LLMProviderFactory } from "../llm/provider-factory";

/**
 * Image generation provider types
 */
export type ImageProvider = "gemini" | "openai" | "azure";

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
 */
const GEMINI_MODEL_MAP: Record<"gemini-image-fast" | "gemini-image-pro", string> = {
  "gemini-image-fast": "gemini-2.5-flash-image",
  "gemini-image-pro": "gemini-3-pro-image-preview",
};

function buildSetupHint(provider: ImageProvider): { type: string; label: string; target: string } {
  if (provider === "gemini")
    return { type: "open_settings", label: "Set up Gemini API key", target: "gemini" };
  if (provider === "azure")
    return { type: "open_settings", label: "Set up Azure OpenAI", target: "azure" };
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
  if (t.includes("gemini")) return "gemini";
  if (t.includes("openai")) return "openai";
  return null;
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

  // For image generation, OpenAI currently requires API key (OAuth not supported here yet).
  const openaiKey = settings.openai?.apiKey?.trim();
  if (openaiKey) providers.push("openai");

  const geminiKey = settings.gemini?.apiKey?.trim();
  if (geminiKey) providers.push("gemini");

  return providers;
}

function sortProvidersByDefaultPreference(providers: ImageProvider[]): ImageProvider[] {
  const priority: Record<ImageProvider, number> = { azure: 0, openai: 1, gemini: 2 };
  return [...providers].sort((a, b) => priority[a] - priority[b]);
}

export function selectImageProviderOrder(args: {
  settings: ReturnType<typeof LLMProviderFactory.loadSettings>;
  providerOverride?: ImageProvider | "auto";
  modelOverride?: string;
  prompt: string;
}): ImageProvider[] {
  const configured = sortProvidersByDefaultPreference(getConfiguredImageProviders(args.settings));

  const requestedOpenAIModel =
    resolveOpenAIModelOverride(args.modelOverride) || inferOpenAIImageModelFromText(args.prompt);

  const explicitProvider =
    (args.providerOverride && args.providerOverride !== "auto" ? args.providerOverride : null) ||
    inferImageProviderFromText(args.modelOverride || "") ||
    inferImageProviderFromText(args.prompt);

  const base =
    explicitProvider ||
    (requestedOpenAIModel
      ? configured.includes("azure")
        ? "azure"
        : configured.includes("openai")
          ? "openai"
          : null
      : null) ||
    configured[0] ||
    null;
  if (!base) return [];

  // Start with base, then configured providers, then stable global order (deduped).
  const order: ImageProvider[] = [base, ...configured, "gemini", "openai", "azure"];
  return order.filter((p, idx) => order.indexOf(p) === idx);
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

    const baseProvider = providerOrder[0] || null;
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
          "No image generation provider configured. Configure Gemini/OpenAI/Azure OpenAI in Settings.",
        actionHint: buildSetupHint("openai"),
      };
    }

    for (const provider of providerOrder) {
      try {
        if (provider === "gemini") {
          const apiKey = settings.gemini?.apiKey?.trim();
          if (!apiKey) {
            // Only surface this if Gemini is actually configured as an image provider.
            if (configuredProviders.includes("gemini")) {
              considerError("gemini", "Gemini API key not configured.");
            }
            continue;
          }
          const chosen: "gemini-image-fast" | "gemini-image-pro" =
            modelOverride === "gemini-image-fast" || modelOverride === "gemini-image-pro"
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
            // Only surface this if OpenAI is actually configured as an image provider.
            if (configuredProviders.includes("openai")) {
              considerError(
                "openai",
                "OpenAI API key not configured (OpenAI OAuth sign-in does not support image generation here yet).",
              );
            }
            continue;
          }
          const chosenModel =
            resolveOpenAIModelOverride(modelOverride) ||
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

        if (provider === "azure") {
          const apiKey = settings.azure?.apiKey?.trim();
          const endpoint = settings.azure?.endpoint?.trim();
          const apiVersion = settings.azure?.apiVersion?.trim() || "2024-02-15-preview";
          const deploymentsToTry = selectAzureImageDeployments({
            settings,
            modelOverride,
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
        description: "OpenAI Images API model (newer)",
        modelId: "gpt-image-1.5",
      },
    ];
  }

  private mapOpenAIImageSize(size: ImageSize): string {
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
}
