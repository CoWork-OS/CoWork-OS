import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { createHash } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
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
import { downscaleImage } from "./image-utils";

type VisionProvider = "openai" | "anthropic" | "gemini" | "bedrock";

const DEFAULT_MAX_TOKENS = 900;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20MB
const IMAGE_DOWNSCALE_THRESHOLD = 2 * 1024 * 1024; // 2MB — auto-downscale above this
const VISION_CACHE_MAX_ENTRIES = 128;

const execFileAsync = promisify(execFile);

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
  /**
   * Cache for vision analysis results keyed by file identity + request parameters.
   * Prevents redundant (expensive) LLM vision calls for the same file
   * across different steps within one task execution.
   */
  private visionCache = new Map<string, { result: any; cachedAt: number }>();

  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {}

  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  private buildCacheKey(parts: Record<string, unknown>): string {
    const raw = JSON.stringify(parts);
    const digest = createHash("sha1").update(raw).digest("hex");
    return digest;
  }

  private getCachedResult(cacheKey: string): any | null {
    const cached = this.visionCache.get(cacheKey);
    return cached ? cached.result : null;
  }

  private setCachedResult(cacheKey: string, result: any): void {
    this.visionCache.set(cacheKey, { result, cachedAt: Date.now() });

    if (this.visionCache.size <= VISION_CACHE_MAX_ENTRIES) return;
    const entries = Array.from(this.visionCache.entries()).sort((a, b) => a[1].cachedAt - b[1].cachedAt);
    const overflow = this.visionCache.size - VISION_CACHE_MAX_ENTRIES;
    for (let i = 0; i < overflow; i++) {
      this.visionCache.delete(entries[i][0]);
    }
  }

  private shouldRetryVisionError(error: unknown): boolean {
    const asAny = (error ?? {}) as any;
    const statusRaw =
      asAny?.status ??
      asAny?.statusCode ??
      asAny?.response?.status ??
      asAny?.response?.statusCode ??
      asAny?.cause?.status ??
      asAny?.cause?.statusCode;
    const status = Number(statusRaw);
    if (Number.isFinite(status)) {
      if ([408, 409, 425, 429, 500, 502, 503, 504].includes(status)) return true;
      if ([400, 401, 403, 404, 405, 406, 410, 411, 413, 414, 415, 422].includes(status))
        return false;
    }

    const code = String(asAny?.code || asAny?.name || asAny?.type || "").toLowerCase();
    if (code) {
      const retryableCodes = [
        "etimedout",
        "econnreset",
        "econnrefused",
        "eai_again",
        "enotfound",
        "timeout",
        "throttl",
        "rate_limit",
      ];
      if (retryableCodes.some((frag) => code.includes(frag))) return true;

      const nonRetryableCodes = [
        "invalid_request",
        "unauthorized",
        "forbidden",
        "permission_denied",
        "not_found",
        "unsupported",
        "invalid_argument",
      ];
      if (nonRetryableCodes.some((frag) => code.includes(frag))) return false;
    }

    const text = String(asAny?.message || error || "").toLowerCase();
    if (!text) return false;

    const deterministicPatterns = [
      /api key not configured/,
      /credentials not configured/,
      /authentication/i,
      /unauthorized/i,
      /forbidden/i,
      /invalid api key/,
      /insufficient quota/,
      /billing/i,
      /unsupported model/,
      /model.*not found/,
      /invalid request/,
      /bad request/,
      /path must be within the current workspace/,
      /missing required "path"/,
      /must be a pdf/,
      /pdftoppm is not installed/,
    ];
    if (deterministicPatterns.some((re) => re.test(text))) return false;

    const transientPatterns = [
      /timeout/,
      /timed out/,
      /etimedout/,
      /econnreset/,
      /econnrefused/,
      /eai_again/,
      /enotfound/,
      /socket hang up/,
      /network/i,
      /connection/i,
      /temporar/i,
      /rate limit/,
      /too many requests/,
      /\b429\b/,
      /throttl/i,
      /internal server error/,
      /service unavailable/,
      /bad gateway/,
      /gateway timeout/,
      /\b5\d{2}\b/,
      /overloaded/i,
    ];
    return transientPatterns.some((re) => re.test(text));
  }

  private logReadPdfVisualFailure(
    error: string,
    details: Record<string, unknown> = {},
  ): void {
    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "read_pdf_visual",
      success: false,
      error,
      ...details,
    });
    this.daemon.logEvent(this.taskId, "tool_error", {
      tool: "read_pdf_visual",
      error,
      ...details,
    });
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
      {
        name: "read_pdf_visual",
        description:
          "Visually analyze a PDF document's layout, design, and content using a vision-capable LLM. " +
          "Converts PDF pages to images and analyzes them in one step. Use this when you need to understand " +
          "a PDF's visual layout, design, formatting, colors, or structure — not just its text content. " +
          "For text-only extraction, use read_file instead.",
        input_schema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Path to a PDF file within the current workspace.",
            },
            prompt: {
              type: "string",
              description:
                'What to analyze about the PDF (default: "Describe the layout, design, content, and visual structure of this document in detail.").',
            },
            pages: {
              type: "string",
              description:
                'Page range to analyze: "1", "1-3", or "all" (default: "1-2"). Max 5 pages.',
            },
            provider: {
              type: "string",
              enum: ["openai", "anthropic", "gemini", "bedrock"],
              description: "Optional vision provider override.",
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

    // Check vision cache with request-specific key to avoid cross-prompt/page/provider contamination.
    const cacheKey = this.buildCacheKey({
      tool: "analyze_image",
      absPath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      prompt,
      provider: providerOverride || null,
      model: modelOverride || null,
      maxTokens,
    });
    const cached = this.getCachedResult(cacheKey);
    if (cached) {
      console.log(`[VisionTools] Cache hit for ${relPath} — skipping duplicate vision call`);
      return cached;
    }

    const buffer = await fs.readFile(absPath);
    let processedBuffer: Buffer = buffer;
    let mimeType = guessImageMimeType(absPath);

    // Auto-downscale large images to prevent vision API timeouts
    if (buffer.length > IMAGE_DOWNSCALE_THRESHOLD) {
      try {
        const result = await downscaleImage(buffer, mimeType, {
          maxDimension: 1600,
          quality: 80,
        });
        processedBuffer = result.buffer;
        mimeType = result.mimeType;
        console.log(
          `[VisionTools] Downscaled image from ${buffer.length} to ${processedBuffer.length} bytes`,
        );
      } catch (err) {
        console.warn(`[VisionTools] Image downscale failed, using original:`, err);
      }
    }

    const base64 = processedBuffer.toString("base64");

    const result = await this.analyzeBuffer({
      base64,
      mimeType,
      prompt,
      maxTokens,
      providerOverride: providerOverride || undefined,
      modelOverride: modelOverride || undefined,
      toolName: "analyze_image",
    });

    // Store successful results in cache (keyed by file path + mtime).
    if (result.success) {
      this.setCachedResult(cacheKey, result);
    }

    return result;
  }

  /**
   * Core vision analysis method that takes a base64-encoded image and routes to
   * the appropriate provider. Used by both analyzeImage and readPdfVisual.
   */
  private async analyzeBuffer(args: {
    base64: string;
    mimeType: string;
    prompt: string;
    maxTokens: number;
    providerOverride?: string;
    modelOverride?: string;
    toolName: string;
    emitToolError?: boolean;
  }): Promise<
    | { success: true; provider: VisionProvider; model: string; text: string }
    | {
        success: false;
        error: string;
        retryable: boolean;
        actionHint?: { type: string; label: string; target: string };
      }
  > {
    const {
      base64,
      mimeType,
      prompt,
      maxTokens,
      providerOverride,
      modelOverride,
      toolName,
      emitToolError = true,
    } = args;

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
          const normalizedProviderType =
            rawProviderType === "amazon-bedrock" ? "bedrock" : rawProviderType;
          const order: VisionProvider[] = [];
          if (normalizedProviderType === "bedrock") order.push("bedrock");
          if (normalizedProviderType === "openai") order.push("openai");
          if (normalizedProviderType === "anthropic") order.push("anthropic");
          if (normalizedProviderType === "gemini") order.push("gemini");
          order.push("bedrock", "openai", "anthropic", "gemini");
          return order.filter((p, idx) => order.indexOf(p) === idx);
        })();

    let lastError: string | undefined;
    let lastErrorRaw: unknown;

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
            tool: toolName,
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
            tool: toolName,
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
            tool: toolName,
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
            tool: toolName,
            success: true,
            provider,
            model,
          });
          return { success: true, provider, model, text };
        }
      } catch (error: any) {
        lastErrorRaw = error;
        lastError = error?.message || String(error);
      }
    }

    const fallbackProvider = preferred || "openai";
    const actionHint = buildSetupHint(fallbackProvider);

    const fallbackError =
      lastError ||
      "No vision-capable provider configured. Configure OpenAI/Anthropic/Gemini in Settings.";
    const retryable = this.shouldRetryVisionError(lastErrorRaw ?? fallbackError);

    if (emitToolError) {
      this.daemon.logEvent(this.taskId, "tool_error", {
        tool: toolName,
        error: lastError || "No vision-capable provider configured",
        actionHint,
      });
    }

    return {
      success: false,
      error: fallbackError,
      retryable,
      actionHint,
    };
  }

  async readPdfVisual(input: {
    path: unknown;
    prompt?: unknown;
    pages?: unknown;
    provider?: unknown;
  }): Promise<
    | { success: true; pages: Array<{ page: number; analysis: string }>; pageCount: number }
    | { success: false; error: string }
  > {
    const relPath = typeof input?.path === "string" ? input.path.trim() : "";
    const prompt =
      typeof input?.prompt === "string" && input.prompt.trim().length > 0
        ? input.prompt.trim()
        : "Describe the layout, design, content, and visual structure of this document page in detail.";
    const pagesSpec = typeof input?.pages === "string" ? input.pages.trim() : "1-2";
    const providerOverride =
      typeof input?.provider === "string" ? input.provider.trim().toLowerCase() : undefined;

    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "read_pdf_visual",
      path: relPath,
      pages: pagesSpec,
    });

    if (!relPath) {
      return { success: false, error: 'Missing required "path"' };
    }

    if (!relPath.toLowerCase().endsWith(".pdf")) {
      return {
        success: false,
        error: "File must be a PDF. For images, use analyze_image instead.",
      };
    }

    const absPath = safeResolveWithinWorkspace(this.workspace.path, relPath);
    if (!absPath) {
      return { success: false, error: "PDF path must be within the current workspace" };
    }

    let pdfStat;
    try {
      pdfStat = await fs.stat(absPath);
    } catch {
      return { success: false, error: `PDF not found: ${relPath}` };
    }

    // Parse and canonicalize page range up front so equivalent specs share cache entries.
    const { firstPage, lastPage } = this.parsePageRange(pagesSpec);
    const normalizedPages = `${firstPage}-${lastPage}`;

    // Check vision cache with request-specific key so different page-ranges/prompts don't collide.
    const cacheKey = this.buildCacheKey({
      tool: "read_pdf_visual",
      absPath,
      size: pdfStat.size,
      mtimeMs: pdfStat.mtimeMs,
      ctimeMs: pdfStat.ctimeMs,
      pages: normalizedPages,
      prompt,
      provider: providerOverride || null,
    });
    const cached = this.getCachedResult(cacheKey);
    if (cached) {
      console.log(`[VisionTools] Cache hit for PDF ${relPath} — skipping duplicate vision call`);
      return cached;
    }

    // Check pdftoppm availability
    let hasPdftoppm = false;
    try {
      await execFileAsync("which", ["pdftoppm"]);
      hasPdftoppm = true;
    } catch {
      // pdftoppm not available
    }

    if (!hasPdftoppm) {
      return {
        success: false,
        error:
          "pdftoppm is not installed. Install poppler (brew install poppler) for PDF visual analysis. " +
          "As an alternative, use read_file to extract text content from the PDF.",
      };
    }

    // Convert PDF pages to images at 72 DPI (sufficient for layout analysis, keeps images small)
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-pdf-"));
    const outputPrefix = path.join(tmpDir, "page");

    try {
      const args = [
        "-png",
        "-r",
        "72",
        "-f",
        String(firstPage),
        "-l",
        String(lastPage),
        absPath,
        outputPrefix,
      ];

      await execFileAsync("pdftoppm", args, { timeout: 30_000 });

      // Find generated page images
      const files = await fs.readdir(tmpDir);
      const pageFiles = files.filter((f) => f.startsWith("page-") && f.endsWith(".png")).sort();

      if (pageFiles.length === 0) {
        return {
          success: false,
          error: "PDF conversion produced no images. The PDF may be empty or corrupt.",
        };
      }

      // Analyze each page
      const results: Array<{ page: number; analysis: string }> = [];
      const pageFailures: Array<{ page: number; error: string }> = [];

      for (let i = 0; i < pageFiles.length; i++) {
        const pageFile = pageFiles[i];
        const pageNum = firstPage + i;
        const pagePath = path.join(tmpDir, pageFile);

        // Read and optionally downscale the page image
        let pageBuffer: Buffer = await fs.readFile(pagePath);
        let pageMime = "image/png";

        if (pageBuffer.length > IMAGE_DOWNSCALE_THRESHOLD) {
          try {
            const downscaled = await downscaleImage(pageBuffer, pageMime, {
              maxDimension: 1600,
              quality: 80,
            });
            pageBuffer = downscaled.buffer;
            pageMime = downscaled.mimeType;
          } catch {
            // Use original if downscale fails
          }
        }

        const pagePrompt =
          pageFiles.length > 1 ? `Page ${pageNum} of ${lastPage}: ${prompt}` : prompt;

        const pageBase64 = pageBuffer.toString("base64");
        let analysisResult = await this.analyzeBuffer({
          base64: pageBase64,
          mimeType: pageMime,
          prompt: pagePrompt,
          maxTokens: 1500,
          providerOverride,
          toolName: "read_pdf_visual",
          emitToolError: false,
        });

        // Retry once only for transient model/provider failures.
        if (!analysisResult.success && analysisResult.retryable) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          analysisResult = await this.analyzeBuffer({
            base64: pageBase64,
            mimeType: pageMime,
            prompt: pagePrompt,
            maxTokens: 1500,
            providerOverride,
            toolName: "read_pdf_visual",
            emitToolError: false,
          });
        }

        if (analysisResult.success) {
          results.push({ page: pageNum, analysis: analysisResult.text });
        } else {
          pageFailures.push({ page: pageNum, error: analysisResult.error });
        }
      }

      // Requirement: all requested pages must be analyzed successfully.
      // Do not cache partial outputs.
      if (pageFailures.length > 0) {
        const details = pageFailures
          .map((f) => `p${f.page}: ${f.error}`)
          .join(" | ");
        this.logReadPdfVisualFailure(details, {
          pagesAnalyzed: results.length,
          pagesFailed: pageFailures.length,
        });
        return {
          success: false,
          error:
            `Failed to analyze all requested PDF pages (${pageFailures.length}/${pageFiles.length} failed). ` +
            details,
        };
      }

      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "read_pdf_visual",
        success: true,
        pagesAnalyzed: results.length,
      });

      const pdfResult = { success: true as const, pages: results, pageCount: results.length };
      // Cache the successful PDF analysis result.
      this.setCachedResult(cacheKey, pdfResult);
      return pdfResult;
    } catch (error: any) {
      const errorMessage = error?.message || String(error);
      this.logReadPdfVisualFailure(errorMessage);
      return {
        success: false,
        error: `PDF conversion failed: ${errorMessage}`,
      };
    } finally {
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  private parsePageRange(spec: string): { firstPage: number; lastPage: number } {
    const maxPages = 5;
    const cleaned = spec.trim().toLowerCase();

    if (cleaned === "all") {
      return { firstPage: 1, lastPage: maxPages };
    }

    if (cleaned.includes("-")) {
      const [startStr, endStr] = cleaned.split("-");
      let start = Math.max(1, parseInt(startStr, 10) || 1);
      let end = Math.max(1, parseInt(endStr, 10) || start);
      if (end < start) {
        const tmp = start;
        start = end;
        end = tmp;
      }
      end = Math.min(start + maxPages - 1, end);
      return { firstPage: start, lastPage: end };
    }

    const page = Math.max(1, parseInt(cleaned, 10) || 1);
    return { firstPage: page, lastPage: page };
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
