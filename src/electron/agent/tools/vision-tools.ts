import * as fs from "fs/promises";
import * as path from "path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import {
  BedrockRuntimeClient,
  BedrockRuntimeClientConfig,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { fromIni } from "@aws-sdk/credential-provider-ini";
import { Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import { LLMTool, MODELS } from "../llm/types";
import { LLMProviderFactory, type LLMSettings } from "../llm/provider-factory";

type VisionProvider = "openai" | "anthropic" | "gemini" | "bedrock";

const DEFAULT_MAX_TOKENS = 900;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20MB

function safeResolveWithinWorkspace(workspacePath: string, relPath: string): string | null {
  const root = path.resolve(workspacePath);
  const candidate = path.resolve(root, relPath);
  if (candidate === root) return null;
  if (candidate.startsWith(root + path.sep)) return candidate;
  return null;
}

function guessImageMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".bmp":
      return "image/bmp";
    default:
      return "application/octet-stream";
  }
}

function buildSetupHint(provider: VisionProvider): { type: string; label: string; target: string } {
  switch (provider) {
    case "openai":
      return { type: "open_settings", label: "Set up OpenAI API key", target: "openai" };
    case "anthropic":
      return { type: "open_settings", label: "Set up Anthropic API key", target: "anthropic" };
    case "gemini":
      return { type: "open_settings", label: "Set up Gemini API key", target: "gemini" };
    case "bedrock":
      return {
        type: "open_settings",
        label: "Set up Amazon Bedrock credentials",
        target: "bedrock",
      };
  }
}

export class VisionTools {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {}

  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: "analyze_image",
        description:
          "Analyze an image file from the workspace using a vision-capable LLM. " +
          "Use this for screenshots/photos: extract text, describe items, answer questions, or summarize what is shown. " +
          "This may require an API key for OpenAI/Anthropic/Gemini.",
        input_schema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description:
                'Path to an image file within the current workspace (e.g., "screenshot.png" or ".cowork/inbox/.../photo.jpg").',
            },
            prompt: {
              type: "string",
              description:
                'Optional instructions or question about the image (default: "Describe this image in detail.").',
            },
            provider: {
              type: "string",
              enum: ["openai", "anthropic", "gemini", "bedrock"],
              description:
                "Optional provider override (default: uses configured provider if vision-capable, otherwise falls back).",
            },
            model: {
              type: "string",
              description: "Optional model override (provider-specific model ID).",
            },
            max_tokens: {
              type: "number",
              description: `Optional max output tokens (default: ${DEFAULT_MAX_TOKENS}).`,
            },
          },
          required: ["path"],
        },
      },
    ];
  }

  async analyzeImage(input: {
    path: unknown;
    prompt?: unknown;
    provider?: unknown;
    model?: unknown;
    max_tokens?: unknown;
  }): Promise<
    | { success: true; provider: VisionProvider; model: string; text: string }
    | {
        success: false;
        error: string;
        actionHint?: { type: string; label: string; target: string };
      }
  > {
    const relPath = typeof input?.path === "string" ? input.path.trim() : "";
    const prompt =
      typeof input?.prompt === "string" && input.prompt.trim().length > 0
        ? input.prompt.trim()
        : "Describe this image in detail.";
    const providerOverride =
      typeof input?.provider === "string" ? input.provider.trim().toLowerCase() : "";
    const modelOverride = typeof input?.model === "string" ? input.model.trim() : "";
    const maxTokensRaw = typeof input?.max_tokens === "number" ? input.max_tokens : undefined;
    const maxTokens = Math.min(Math.max(maxTokensRaw ?? DEFAULT_MAX_TOKENS, 64), 4096);

    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "analyze_image",
      path: relPath,
      provider: providerOverride || undefined,
      model: modelOverride || undefined,
      maxTokens,
    });

    if (!relPath) {
      return { success: false, error: 'Missing required "path"' };
    }

    const absPath = safeResolveWithinWorkspace(this.workspace.path, relPath);
    if (!absPath) {
      return { success: false, error: "Image path must be within the current workspace" };
    }

    let stat;
    try {
      stat = await fs.stat(absPath);
    } catch {
      return { success: false, error: `Image not found: ${relPath}` };
    }

    if (!stat.isFile()) {
      return { success: false, error: `Not a file: ${relPath}` };
    }

    if (stat.size > MAX_IMAGE_BYTES) {
      return {
        success: false,
        error: `Image is too large (${stat.size} bytes). Max allowed is ${MAX_IMAGE_BYTES} bytes.`,
      };
    }

    const buffer = await fs.readFile(absPath);
    const base64 = buffer.toString("base64");
    const mimeType = guessImageMimeType(absPath);

    // Choose provider
    const settings = LLMProviderFactory.loadSettings();
    const preferred =
      providerOverride === "openai" ||
      providerOverride === "anthropic" ||
      providerOverride === "gemini" ||
      providerOverride === "bedrock"
        ? (providerOverride as VisionProvider)
        : undefined;

    const tryOrder: VisionProvider[] = preferred
      ? [preferred]
      : (() => {
          const rawProviderType = String(
            (settings as { providerType?: string }).providerType || "",
          );
          // Legacy settings may still contain "amazon-bedrock"; normalize it to "bedrock".
          const normalizedProviderType =
            rawProviderType === "amazon-bedrock" ? "bedrock" : rawProviderType;
          const order: VisionProvider[] = [];
          if (normalizedProviderType === "bedrock") order.push("bedrock");
          if (normalizedProviderType === "openai") order.push("openai");
          if (normalizedProviderType === "anthropic") order.push("anthropic");
          if (normalizedProviderType === "gemini") order.push("gemini");
          // Fallbacks if current provider is not vision-capable or not configured for vision
          order.push("bedrock", "openai", "anthropic", "gemini");
          // Dedupe while preserving order
          return order.filter((p, idx) => order.indexOf(p) === idx);
        })();

    let lastError: string | undefined;

    for (const provider of tryOrder) {
      try {
        if (provider === "openai") {
          const apiKey = settings.openai?.apiKey?.trim();
          if (!apiKey) {
            lastError =
              "OpenAI API key not configured (OpenAI OAuth sign-in does not support image analysis here yet).";
            continue;
          }
          const model = modelOverride || "gpt-4o-mini";
          const text = await this.analyzeWithOpenAI({
            apiKey,
            model,
            prompt,
            base64,
            mimeType,
            maxTokens,
          });
          this.daemon.logEvent(this.taskId, "tool_result", {
            tool: "analyze_image",
            success: true,
            provider,
            model,
          });
          return { success: true, provider, model, text };
        }

        if (provider === "anthropic") {
          const apiKey = settings.anthropic?.apiKey?.trim();
          if (!apiKey) {
            lastError = "Anthropic API key not configured.";
            continue;
          }
          const defaultModel = MODELS["sonnet-4-6"]?.anthropic || "claude-sonnet-4-6";
          const model = modelOverride || defaultModel;
          const text = await this.analyzeWithAnthropic({
            apiKey,
            model,
            prompt,
            base64,
            mimeType,
            maxTokens,
          });
          this.daemon.logEvent(this.taskId, "tool_result", {
            tool: "analyze_image",
            success: true,
            provider,
            model,
          });
          return { success: true, provider, model, text };
        }

        if (provider === "bedrock") {
          const hasCredentials =
            (settings.bedrock?.accessKeyId && settings.bedrock?.secretAccessKey) ||
            settings.bedrock?.profile ||
            settings.bedrock?.useDefaultCredentials;
          if (!hasCredentials) {
            lastError = "Amazon Bedrock credentials not configured.";
            continue;
          }
          const defaultModel = MODELS["sonnet-4-6"]?.bedrock || "anthropic.claude-sonnet-4-6";
          const model = modelOverride || settings.bedrock?.model || defaultModel;
          const text = await this.analyzeWithBedrock({
            settings,
            model,
            prompt,
            base64,
            mimeType,
            maxTokens,
          });
          this.daemon.logEvent(this.taskId, "tool_result", {
            tool: "analyze_image",
            success: true,
            provider,
            model,
          });
          return { success: true, provider, model, text };
        }

        if (provider === "gemini") {
          const apiKey = settings.gemini?.apiKey?.trim();
          if (!apiKey) {
            lastError = "Gemini API key not configured.";
            continue;
          }
          const model = modelOverride || settings.gemini?.model || "gemini-2.0-flash";
          const text = await this.analyzeWithGemini({
            apiKey,
            model,
            prompt,
            base64,
            mimeType,
            maxTokens,
          });
          this.daemon.logEvent(this.taskId, "tool_result", {
            tool: "analyze_image",
            success: true,
            provider,
            model,
          });
          return { success: true, provider, model, text };
        }
      } catch (error: any) {
        lastError = error?.message || String(error);
      }
    }

    const fallbackProvider = preferred || "openai";
    const actionHint = buildSetupHint(fallbackProvider);

    this.daemon.logEvent(this.taskId, "tool_error", {
      tool: "analyze_image",
      error: lastError || "No vision-capable provider configured",
      actionHint,
    });

    return {
      success: false,
      error:
        lastError ||
        "No vision-capable provider configured. Configure OpenAI/Anthropic/Gemini in Settings.",
      actionHint,
    };
  }

  private async analyzeWithOpenAI(args: {
    apiKey: string;
    model: string;
    prompt: string;
    base64: string;
    mimeType: string;
    maxTokens: number;
  }): Promise<string> {
    const client = new OpenAI({ apiKey: args.apiKey });
    const url = `data:${args.mimeType};base64,${args.base64}`;

    const response = await client.chat.completions.create({
      model: args.model,
      max_tokens: args.maxTokens,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: args.prompt },
            { type: "image_url", image_url: { url } },
          ],
        },
      ],
    });

    return response.choices?.[0]?.message?.content?.trim() || "";
  }

  private async analyzeWithAnthropic(args: {
    apiKey: string;
    model: string;
    prompt: string;
    base64: string;
    mimeType: string;
    maxTokens: number;
  }): Promise<string> {
    const client = new Anthropic({ apiKey: args.apiKey });

    const response = await client.messages.create({
      model: args.model,
      max_tokens: args.maxTokens,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: args.prompt },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: args.mimeType as
                  | "image/gif"
                  | "image/jpeg"
                  | "image/png"
                  | "image/webp",
                data: args.base64,
              },
            },
          ],
        },
      ],
    });

    return response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as Anthropic.TextBlock).text)
      .join("\n")
      .trim();
  }

  private async analyzeWithGemini(args: {
    apiKey: string;
    model: string;
    prompt: string;
    base64: string;
    mimeType: string;
    maxTokens: number;
  }): Promise<string> {
    const client = new GoogleGenerativeAI(args.apiKey);
    const model = client.getGenerativeModel({ model: args.model });

    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            { text: args.prompt },
            {
              inlineData: {
                mimeType: args.mimeType,
                data: args.base64,
              },
            },
          ],
        },
      ],
      generationConfig: { maxOutputTokens: args.maxTokens },
    });

    return result.response.text().trim();
  }

  private async analyzeWithBedrock(args: {
    settings: LLMSettings;
    model: string;
    prompt: string;
    base64: string;
    mimeType: string;
    maxTokens: number;
  }): Promise<string> {
    const bedrock = args.settings.bedrock;
    const clientConfig: BedrockRuntimeClientConfig = {
      region: bedrock?.region || "us-east-1",
    };

    if (bedrock?.accessKeyId && bedrock?.secretAccessKey) {
      clientConfig.credentials = {
        accessKeyId: bedrock.accessKeyId,
        secretAccessKey: bedrock.secretAccessKey,
        ...(bedrock.sessionToken && { sessionToken: bedrock.sessionToken }),
      };
    } else if (bedrock?.profile) {
      clientConfig.credentials = fromIni({ profile: bedrock.profile });
    }

    const client = new BedrockRuntimeClient(clientConfig);
    const format = args.mimeType.split("/")[1] as "jpeg" | "png" | "gif" | "webp";

    const command = new ConverseCommand({
      modelId: args.model,
      messages: [
        {
          role: "user",
          content: [
            { text: args.prompt },
            {
              image: {
                format,
                source: {
                  bytes: new Uint8Array(Buffer.from(args.base64, "base64")),
                },
              },
            },
          ],
        },
      ],
      inferenceConfig: {
        maxTokens: args.maxTokens,
      },
    });

    const response = await client.send(command);
    const outputBlocks = response.output?.message?.content ?? [];
    return outputBlocks
      .filter((b) => "text" in b && b.text)
      .map((b) => (b as { text: string }).text)
      .join("\n")
      .trim();
  }
}
