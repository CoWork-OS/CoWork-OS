import * as fs from "fs";
import * as path from "path";
import { Workspace } from "../../../shared/types";
import { LLMProviderFactory } from "../llm/provider-factory";
import {
  assertWorkspaceReadableFileAccessWithApproval,
  evaluateWorkspaceFilesystemAccess,
  type WorkspaceFilesystemApprovalHandlers,
} from "../../security/access-profile-paths";
import { evaluateNetworkPolicy } from "../../security/network-policy";
import { resolveSecretValue } from "../../security/secret-references/resolver";
import { coverImageToSize } from "../tools/image-utils";
import {
  buildLocalVideoArgs,
  cancelLocalVideoJob,
  resolveLocalVideoConfig,
  waitForLocalVideoJob,
  startLocalVideoJob,
} from "./local-video-provider";

// ── Provider & model types ────────────────────────────────────────────────────

export type VideoProvider = "openai-compatible" | "gemini" | "vertex" | "kling" | "local";

export type VideoGenerationMode =
  | "text_to_video"
  | "image_to_video"
  | "video_to_video"
  | "extend_video";

export type VideoAspectRatio = "16:9" | "9:16" | "1:1";
export type VideoResolution = "480p" | "720p" | "1080p";

// ── Request / Result shapes ───────────────────────────────────────────────────

export interface VideoGenerationRequest {
  prompt: string;
  mode?: VideoGenerationMode;
  provider?: VideoProvider | "auto";
  model?: string;
  duration?: number;
  aspectRatio?: VideoAspectRatio;
  resolution?: VideoResolution;
  /** Absolute path to a reference image (for image_to_video) */
  referenceImagePath?: string;
  /** Absolute path to a reference video (for video_to_video / extend_video) */
  referenceVideoPath?: string;
  filename?: string;
}

export interface VideoGenerationJobStatus {
  jobId: string;
  provider: VideoProvider;
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  progressPercent?: number;
  outputPaths?: string[];
  error?: string;
}

export interface VideoGenerationResult {
  success: boolean;
  jobId?: string;
  /** Populated once the job completes and the video is downloaded */
  outputPaths?: string[];
  provider?: VideoProvider;
  model?: string;
  error?: string;
  actionHint?: { type: string; label: string; target: string };
  /**
   * When the provider returns a job ID but the video isn't ready yet,
   * `pending` is true and `jobId` should be polled via `get_video_generation_job`.
   */
  pending?: boolean;
}

// ── Internal adapters ─────────────────────────────────────────────────────────

interface AdapterArgs {
  request: VideoGenerationRequest;
  settings: ReturnType<typeof LLMProviderFactory.loadSettings>;
  outputDir: string;
  outputPathGuard: (outputPath: string) => void;
  networkPolicyGuard?: NetworkPolicyGuard;
}

type OutputPathGuard = (outputPath: string) => void;
type NetworkPolicyGuard = (url: string, toolName?: string) => void;

interface AdapterResult {
  success: boolean;
  jobId?: string;
  outputPaths?: string[];
  model?: string;
  error?: string;
  pending?: boolean;
}

// ── Local model (Wan 2.2 via mlx-video) ───────────────────────────────────────

/** One local poll waits this long for the job to finish (under the 300 s tool timeout). */
const LOCAL_VIDEO_POLL_WAIT_MS = 240_000;

function generateWithLocal(args: AdapterArgs): AdapterResult {
  const config = resolveLocalVideoConfig(args.settings.videoGeneration?.local);
  if (!config) {
    return { success: false, error: "The local video model is not installed or configured." };
  }
  const mode = args.request.mode ?? "text_to_video";
  if (mode !== "text_to_video" && mode !== "image_to_video") {
    return { success: false, error: `The local video model does not support mode "${mode}".` };
  }
  const outputPath = buildOutputPath(args.outputDir, args.request.filename);
  args.outputPathGuard(outputPath);
  const input = {
    config,
    prompt: args.request.prompt,
    outputPath,
    referenceImagePath: mode === "image_to_video" ? args.request.referenceImagePath : undefined,
    aspectRatio: args.request.aspectRatio,
    duration: args.request.duration,
  };
  console.log(
    `[VideoGenerator][Local] ${config.pythonPath} ${buildLocalVideoArgs(input).slice(0, 2).join(" ")} (${mode})`,
  );
  const { jobId } = startLocalVideoJob(input);
  return { success: true, jobId, pending: true, model: "wan2.2-ti2v-5b" };
}

// ── OpenAI-compatible Videos API ──────────────────────────────────────────────
// Any service that implements the OpenAI Videos API shape:
//   POST   {baseUrl}/videos                        (JSON, or multipart with input_reference)
//   GET    {baseUrl}/videos/{videoId}
//   GET    {baseUrl}/videos/{videoId}/content?variant=video
//
// OpenAI removed its own Videos API and the Sora 2 models on 2026-09-24, so
// this adapter ships with no built-in endpoint: the user points it at whichever
// service they use (base URL, model and API key in Settings → Video Model).

/**
 * Normalize the configured base URL to the API root the `/videos` routes hang off.
 * e.g. "https://api.example.com/v1/videos/" → "https://api.example.com/v1"
 */
export function normalizeOpenAICompatibleVideoBaseUrl(raw: string): string {
  let base = raw.trim().replace(/\/+$/, "");
  if (/\/videos$/i.test(base)) base = base.slice(0, -"/videos".length);
  return base.replace(/\/+$/, "");
}

function resolveOpenAICompatibleVideoConfig(
  settings: ReturnType<typeof LLMProviderFactory.loadSettings>,
): { apiKey: string; baseUrl: string } | null {
  const cfg = settings.videoGeneration?.openaiCompatible;
  const apiKey = cfg?.apiKey?.trim();
  const rawBaseUrl = cfg?.baseUrl?.trim();
  if (!apiKey || !rawBaseUrl) return null;
  const baseUrl = normalizeOpenAICompatibleVideoBaseUrl(rawBaseUrl);
  if (!/^https?:\/\//i.test(baseUrl)) return null;
  return { apiKey, baseUrl };
}

/** The config with its key read from a vault when the key is a vault reference. */
async function withResolvedVideoKey<T extends { apiKey: string }>(
  config: T | null,
): Promise<T | null> {
  return config ? { ...config, apiKey: (await resolveSecretValue(config.apiKey)) ?? "" } : null;
}

function aspectRatioAndResolutionToVideoSize(
  aspectRatio: VideoAspectRatio,
  resolution?: VideoResolution,
):
  | "480x480"
  | "720x720"
  | "1080x1080"
  | "480x854"
  | "854x480"
  | "720x1280"
  | "1280x720"
  | "1080x1920"
  | "1920x1080" {
  if (aspectRatio === "1:1") {
    if (resolution === "1080p") return "1080x1080";
    if (resolution === "480p") return "480x480";
    return "720x720";
  }

  if (aspectRatio === "9:16") {
    if (resolution === "1080p") return "1080x1920";
    if (resolution === "480p") return "480x854";
    return "720x1280";
  }

  if (resolution === "1080p") return "1920x1080";
  if (resolution === "480p") return "854x480";
  return "1280x720";
}

function imageMimeTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

/** The Videos API takes `seconds` as a string; each service documents its own range. */
function normalizeVideoSeconds(seconds?: number): string {
  const value = Number.isFinite(seconds) ? Math.max(1, Math.round(seconds as number)) : 5;
  return String(value);
}

function mapVideosApiStatus(status?: string): VideoGenerationJobStatus["status"] {
  const s = status?.trim().toLowerCase();
  if (s === "completed" || s === "succeeded" || s === "success" || s === "done") return "succeeded";
  if (s === "failed" || s === "error") return "failed";
  if (s === "cancelled" || s === "canceled") return "cancelled";
  if (s === "in_progress" || s === "running" || s === "processing") return "running";
  return "pending";
}

/** A finished job may link its file directly instead of serving `/content`. */
function findVideoUrlInStatus(data: Record<string, unknown>): string | undefined {
  const candidates: unknown[] = [
    data.url,
    data.video_url,
    (data.output as Record<string, unknown> | undefined)?.url,
    (data.data as Array<Record<string, unknown>> | undefined)?.[0]?.url,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && /^https?:\/\//i.test(candidate)) return candidate;
  }
  return undefined;
}

function describeVideosApiError(data: Record<string, unknown>): string | undefined {
  const error = data.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return undefined;
}

async function generateWithOpenAICompatible(args: AdapterArgs): Promise<AdapterResult> {
  const config = await withResolvedVideoKey(resolveOpenAICompatibleVideoConfig(args.settings));
  if (!config) {
    return {
      success: false,
      error:
        "OpenAI-compatible video service is not configured (base URL and API key are required).",
    };
  }

  const vCfg = args.settings.videoGeneration?.openaiCompatible;
  const model = args.request.model?.trim() || vCfg?.model?.trim();
  if (!model) {
    return {
      success: false,
      error: "OpenAI-compatible video model is not configured. Set the model name in Settings.",
    };
  }

  const mode = args.request.mode ?? "text_to_video";
  if (mode !== "text_to_video" && mode !== "image_to_video") {
    return { success: false, error: `OpenAI-compatible video does not support mode "${mode}".` };
  }

  const url = `${config.baseUrl}/videos`;
  const duration = args.request.duration ?? vCfg?.defaultDuration ?? 5;
  const aspectRatio = args.request.aspectRatio ?? vCfg?.defaultAspectRatio ?? "16:9";
  const resolution = args.request.resolution ?? vCfg?.defaultResolution ?? "720p";
  const size = aspectRatioAndResolutionToVideoSize(aspectRatio, resolution);
  const seconds = normalizeVideoSeconds(duration);

  const body: Record<string, unknown> = {
    model,
    prompt: args.request.prompt,
    size,
    seconds,
  };

  let requestInit: RequestInit;
  if (mode === "image_to_video" && args.request.referenceImagePath) {
    // The first frame goes as a multipart `input_reference` file whose
    // dimensions must equal `size`, so the picture is center-cropped to fit.
    const [width, height] = size.split("x").map(Number);
    const fitted = coverImageToSize(args.request.referenceImagePath, width, height);
    const referencePath = args.request.referenceImagePath;
    const reference = fitted
      ? { buffer: fitted.buffer, mimeType: fitted.mimeType, name: "reference.jpg" }
      : {
          buffer: fs.readFileSync(referencePath),
          mimeType: imageMimeTypeForPath(referencePath),
          name: path.basename(referencePath),
        };
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", args.request.prompt);
    form.append("size", size);
    form.append("seconds", seconds);
    form.append(
      "input_reference",
      new Blob([new Uint8Array(reference.buffer)], { type: reference.mimeType }),
      reference.name,
    );
    console.log(
      `[VideoGenerator][OpenAI-compatible] POST ${url}`,
      JSON.stringify({
        ...body,
        input_reference: `${reference.name} (${reference.buffer.length} bytes)`,
      }),
    );
    // fetch sets the multipart boundary itself.
    requestInit = {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: form,
    };
  } else {
    console.log(`[VideoGenerator][OpenAI-compatible] POST ${url}`, JSON.stringify(body));
    requestInit = {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
  }

  args.networkPolicyGuard?.(url, "generate_video");
  const response = await fetch(url, requestInit);

  if (!response.ok) {
    const errText = await response.text().catch(() => String(response.status));
    return {
      success: false,
      error: `OpenAI-compatible video error ${response.status}: ${errText} — URL: ${url}`,
    };
  }

  const data = (await response.json()) as Record<string, unknown> & {
    id?: string;
    status?: string;
  };
  const jobId = typeof data.id === "string" ? data.id : undefined;
  if (!jobId) {
    return {
      success: false,
      error: `OpenAI-compatible video: no job ID in response: ${JSON.stringify(data)}`,
    };
  }

  if (mapVideosApiStatus(data.status) === "succeeded") {
    const finished = await pollOpenAICompatibleJob(
      jobId,
      args.settings,
      args.outputDir,
      args.request.filename,
      args.outputPathGuard,
      args.networkPolicyGuard,
    );
    if (finished.status === "succeeded") {
      return { success: true, jobId, outputPaths: finished.outputPaths, model };
    }
  }

  return { success: true, jobId, pending: true, model };
}

async function pollOpenAICompatibleJob(
  jobId: string,
  settings: ReturnType<typeof LLMProviderFactory.loadSettings>,
  outputDir: string,
  filename?: string,
  outputPathGuard?: OutputPathGuard,
  networkPolicyGuard?: NetworkPolicyGuard,
): Promise<VideoGenerationJobStatus & { outputPaths?: string[] }> {
  const provider: VideoProvider = "openai-compatible";
  const config = await withResolvedVideoKey(resolveOpenAICompatibleVideoConfig(settings));
  if (!config) {
    return {
      jobId,
      provider,
      status: "failed",
      error: "OpenAI-compatible video service is not configured.",
    };
  }

  const authHeaders = { Authorization: `Bearer ${config.apiKey}` };
  const statusUrl = `${config.baseUrl}/videos/${encodeURIComponent(jobId)}`;
  console.log(`[VideoGenerator][OpenAI-compatible] GET ${statusUrl}`);

  networkPolicyGuard?.(statusUrl, "get_video_generation_job");
  const response = await fetch(statusUrl, { headers: authHeaders });
  if (!response.ok) {
    return {
      jobId,
      provider,
      status: "failed",
      error: `HTTP ${response.status} polling ${statusUrl}`,
    };
  }

  const data = (await response.json()) as Record<string, unknown> & {
    status?: string;
    progress?: unknown;
  };
  const status = mapVideosApiStatus(data.status);
  const progressPercent = typeof data.progress === "number" ? data.progress : undefined;

  if (status === "succeeded") {
    const outputPath = buildOutputPath(outputDir, filename, "mp4");
    outputPathGuard?.(outputPath);
    const directUrl = findVideoUrlInStatus(data);
    if (directUrl) {
      await downloadUrlToFile(directUrl, outputPath, outputPathGuard, networkPolicyGuard);
      return { jobId, provider, status: "succeeded", outputPaths: [outputPath] };
    }

    const contentUrl = `${statusUrl}/content?variant=video`;
    console.log(`[VideoGenerator][OpenAI-compatible] Downloading video from ${contentUrl}`);
    networkPolicyGuard?.(contentUrl, "video_output_download");
    const videoResponse = await fetch(contentUrl, {
      headers: { ...authHeaders, Accept: "video/mp4, application/octet-stream;q=0.9, */*;q=0.8" },
    });
    if (!videoResponse.ok) {
      return {
        jobId,
        provider,
        status: "failed",
        error: `Failed to download video: HTTP ${videoResponse.status}`,
      };
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, Buffer.from(await videoResponse.arrayBuffer()));
    return { jobId, provider, status: "succeeded", outputPaths: [outputPath] };
  }

  if (status === "failed" || status === "cancelled") {
    return {
      jobId,
      provider,
      status,
      error: describeVideosApiError(data) ?? `Video generation ${status}.`,
    };
  }

  return { jobId, provider, status, progressPercent };
}

// ── Gemini Veo 3.1 ───────────────────────────────────────────────────────────

async function generateWithGemini(args: AdapterArgs): Promise<AdapterResult> {
  const apiKey = await resolveSecretValue(args.settings.gemini?.apiKey?.trim());
  if (!apiKey) return { success: false, error: "Gemini API key not configured." };

  const vCfg = args.settings.videoGeneration?.gemini;
  const modelId = args.request.model || GEMINI_VIDEO_MODEL_MAP[vCfg?.defaultModel ?? "veo-3.1"];
  const duration = args.request.duration ?? vCfg?.defaultDuration ?? 5;
  const aspectRatio = args.request.aspectRatio ?? vCfg?.defaultAspectRatio ?? "16:9";

  const mode = args.request.mode ?? "text_to_video";
  if (mode !== "text_to_video" && mode !== "image_to_video") {
    return { success: false, error: `Gemini Veo does not support mode "${mode}".` };
  }

  const contents: unknown[] = [];
  if (mode === "image_to_video" && args.request.referenceImagePath) {
    const imgData = fs.readFileSync(args.request.referenceImagePath);
    contents.push({
      role: "user",
      parts: [
        { inlineData: { mimeType: "image/jpeg", data: imgData.toString("base64") } },
        { text: args.request.prompt },
      ],
    });
  } else {
    contents.push({ role: "user", parts: [{ text: args.request.prompt }] });
  }

  const body = {
    model: modelId,
    contents,
    generationConfig: {
      responseModalities: ["video"],
      videoConfig: {
        durationSeconds: duration,
        aspectRatio: aspectRatio.replace(":", "x"),
      },
    },
  };

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`;
  args.networkPolicyGuard?.(endpoint, "generate_video");
  const response = await fetch(`${endpoint}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => String(response.status));
    // Gemini may return a long-running operation instead
    if (response.status === 200 || response.status === 202) {
      // handled below
    } else {
      return { success: false, error: `Gemini Veo error ${response.status}: ${errText}` };
    }
  }

  const data = (await response.json()) as {
    name?: string; // long-running operation name
    done?: boolean;
    response?: {
      candidates?: Array<{
        content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> };
      }>;
    };
    error?: { message?: string };
  };

  // Long-running operation
  if (data.name && !data.done) {
    return { success: true, jobId: data.name, pending: true, model: modelId };
  }

  if (data.done && data.response) {
    const part = data.response.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
    if (part?.inlineData?.data) {
      const outputPath = buildOutputPath(args.outputDir, args.request.filename, "mp4");
      args.outputPathGuard(outputPath);
      const videoBuffer = Buffer.from(part.inlineData.data, "base64");
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, videoBuffer);
      return { success: true, outputPaths: [outputPath], model: modelId };
    }
  }

  return { success: false, error: data.error?.message ?? "No video data in Gemini response." };
}

const GEMINI_VIDEO_MODEL_MAP: Record<string, string> = {
  "veo-3.1": "veo-3.1-generate-preview",
  "veo-3.1-fast-preview": "veo-3.1-generate-fast-preview",
  "veo-3.0": "veo-3.0-generate-preview",
};

async function pollGeminiOperation(
  operationName: string,
  apiKey: string,
  outputDir: string,
  filename?: string,
  outputPathGuard?: OutputPathGuard,
  networkPolicyGuard?: NetworkPolicyGuard,
): Promise<VideoGenerationJobStatus & { outputPaths?: string[] }> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/${operationName}`;
  networkPolicyGuard?.(endpoint, "get_video_generation_job");
  const response = await fetch(`${endpoint}?key=${apiKey}`);
  if (!response.ok) {
    return {
      jobId: operationName,
      provider: "gemini",
      status: "failed",
      error: `HTTP ${response.status}`,
    };
  }
  const data = (await response.json()) as {
    done?: boolean;
    response?: {
      candidates?: Array<{
        content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> };
      }>;
    };
    error?: { message?: string };
  };
  if (data.error) {
    return {
      jobId: operationName,
      provider: "gemini",
      status: "failed",
      error: data.error.message,
    };
  }
  if (!data.done) {
    return { jobId: operationName, provider: "gemini", status: "running" };
  }
  const part = data.response?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
  if (part?.inlineData?.data) {
    const outputPath = buildOutputPath(outputDir, filename, "mp4");
    outputPathGuard?.(outputPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, Buffer.from(part.inlineData.data, "base64"));
    return {
      jobId: operationName,
      provider: "gemini",
      status: "succeeded",
      outputPaths: [outputPath],
    };
  }
  return {
    jobId: operationName,
    provider: "gemini",
    status: "failed",
    error: "No video data in completed operation.",
  };
}

// ── Vertex AI Veo ─────────────────────────────────────────────────────────────

async function generateWithVertex(args: AdapterArgs): Promise<AdapterResult> {
  const vxCfg = args.settings.videoGeneration?.vertex;
  const projectId = vxCfg?.projectId?.trim();
  const location = vxCfg?.location?.trim() || "us-central1";
  const accessToken = vxCfg?.accessToken?.trim();
  const outputGcsUri = vxCfg?.outputGcsUri?.trim();

  if (!projectId || !accessToken) {
    return {
      success: false,
      error: "Vertex AI project ID and access token are required for video generation.",
    };
  }

  const model = args.request.model || vxCfg?.model || "veo-3";
  const duration = args.request.duration ?? vxCfg?.defaultDuration ?? 5;
  const aspectRatio = args.request.aspectRatio ?? vxCfg?.defaultAspectRatio ?? "16:9";

  const mode = args.request.mode ?? "text_to_video";
  if (mode !== "text_to_video" && mode !== "image_to_video") {
    return { success: false, error: `Vertex AI Veo does not support mode "${mode}".` };
  }

  const instance: Record<string, unknown> = {
    prompt: args.request.prompt,
  };

  if (mode === "image_to_video" && args.request.referenceImagePath) {
    const imgData = fs.readFileSync(args.request.referenceImagePath);
    instance.image = { bytesBase64Encoded: imgData.toString("base64"), mimeType: "image/jpeg" };
  }

  const parameters: Record<string, unknown> = {
    durationSeconds: duration,
    aspectRatio,
    sampleCount: 1,
  };
  if (outputGcsUri) {
    parameters.storageUri = outputGcsUri;
  }

  const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:predictLongRunning`;

  args.networkPolicyGuard?.(endpoint, "generate_video");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ instances: [instance], parameters }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => String(response.status));
    return { success: false, error: `Vertex AI Veo error ${response.status}: ${errText}` };
  }

  const data = (await response.json()) as { name?: string };
  if (data.name) {
    return { success: true, jobId: data.name, pending: true, model };
  }

  return { success: false, error: "No operation name in Vertex AI response." };
}

async function pollVertexOperation(
  operationName: string,
  accessToken: string,
  outputDir: string,
  filename?: string,
  outputPathGuard?: OutputPathGuard,
  networkPolicyGuard?: NetworkPolicyGuard,
  location = "us-central1",
): Promise<VideoGenerationJobStatus & { outputPaths?: string[] }> {
  const endpoint = `https://${location}-aiplatform.googleapis.com/v1/${operationName}`;
  networkPolicyGuard?.(endpoint, "get_video_generation_job");
  const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) {
    return {
      jobId: operationName,
      provider: "vertex",
      status: "failed",
      error: `HTTP ${response.status}`,
    };
  }
  const data = (await response.json()) as {
    done?: boolean;
    response?: {
      predictions?: Array<{
        bytesBase64Encoded?: string;
        mimeType?: string;
        gcsUri?: string;
      }>;
    };
    error?: { message?: string };
  };

  if (data.error) {
    return {
      jobId: operationName,
      provider: "vertex",
      status: "failed",
      error: data.error.message,
    };
  }
  if (!data.done) {
    return { jobId: operationName, provider: "vertex", status: "running" };
  }

  const pred = data.response?.predictions?.[0];
  if (pred?.gcsUri) {
    // GCS URI — caller should handle download separately; return as-is
    return {
      jobId: operationName,
      provider: "vertex",
      status: "succeeded",
      outputPaths: [pred.gcsUri],
    };
  }
  if (pred?.bytesBase64Encoded) {
    const ext = pred.mimeType?.includes("mp4") ? "mp4" : "mp4";
    const outputPath = buildOutputPath(outputDir, filename, ext);
    outputPathGuard?.(outputPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, Buffer.from(pred.bytesBase64Encoded, "base64"));
    return {
      jobId: operationName,
      provider: "vertex",
      status: "succeeded",
      outputPaths: [outputPath],
    };
  }

  return {
    jobId: operationName,
    provider: "vertex",
    status: "failed",
    error: "No prediction data.",
  };
}

// ── Kling ─────────────────────────────────────────────────────────────────────

async function generateWithKling(args: AdapterArgs): Promise<AdapterResult> {
  const kCfg = args.settings.videoGeneration?.kling;
  const apiKey = await resolveSecretValue(kCfg?.apiKey?.trim());
  const baseUrl = (kCfg?.baseUrl?.trim() || "https://api.klingai.com").replace(/\/$/, "");

  if (!apiKey) {
    return { success: false, error: "Kling API key not configured." };
  }

  const model = args.request.model || kCfg?.model || "kling-v2";
  const duration = args.request.duration ?? kCfg?.defaultDuration ?? 5;
  const aspectRatio = args.request.aspectRatio ?? kCfg?.defaultAspectRatio ?? "16:9";
  const mode = args.request.mode ?? "text_to_video";

  if (mode === "video_to_video" || mode === "extend_video") {
    return { success: false, error: `Kling does not support mode "${mode}".` };
  }

  const endpoint =
    mode === "image_to_video"
      ? `${baseUrl}/v1/videos/image2video`
      : `${baseUrl}/v1/videos/text2video`;

  const body: Record<string, unknown> = {
    model,
    prompt: args.request.prompt,
    duration: String(duration),
    aspect_ratio: aspectRatio,
    cfg_scale: 0.5,
  };

  if (mode === "image_to_video" && args.request.referenceImagePath) {
    const imgData = fs.readFileSync(args.request.referenceImagePath);
    body.image = imgData.toString("base64");
  }

  args.networkPolicyGuard?.(endpoint, "generate_video");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => String(response.status));
    return { success: false, error: `Kling error ${response.status}: ${errText}` };
  }

  const data = (await response.json()) as {
    data?: { task_id?: string };
    code?: number;
    message?: string;
  };

  if (data.code !== 0 && data.code !== undefined) {
    return { success: false, error: `Kling API error: ${data.message}` };
  }

  const taskId = data.data?.task_id;
  if (!taskId) {
    return { success: false, error: "No task_id in Kling response." };
  }

  return { success: true, jobId: taskId, pending: true, model };
}

async function pollKlingJob(
  taskId: string,
  kCfg: NonNullable<ReturnType<typeof LLMProviderFactory.loadSettings>["videoGeneration"]>["kling"],
  outputDir: string,
  filename?: string,
  outputPathGuard?: OutputPathGuard,
  networkPolicyGuard?: NetworkPolicyGuard,
): Promise<VideoGenerationJobStatus & { outputPaths?: string[] }> {
  const apiKey = (await resolveSecretValue(kCfg?.apiKey?.trim())) ?? "";
  const baseUrl = (kCfg?.baseUrl?.trim() || "https://api.klingai.com").replace(/\/$/, "");

  const statusUrl = `${baseUrl}/v1/videos/text2video/${taskId}`;
  networkPolicyGuard?.(statusUrl, "get_video_generation_job");
  const response = await fetch(statusUrl, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!response.ok) {
    return { jobId: taskId, provider: "kling", status: "failed", error: `HTTP ${response.status}` };
  }

  const data = (await response.json()) as {
    data?: {
      task_status?: string;
      task_status_msg?: string;
      task_result?: {
        videos?: Array<{ url?: string; duration?: string }>;
      };
    };
  };

  const taskStatus = data.data?.task_status;
  if (taskStatus === "succeed") {
    const videos = data.data?.task_result?.videos ?? [];
    const outputPaths: string[] = [];
    for (let i = 0; i < videos.length; i++) {
      const videoUrl = videos[i].url;
      if (videoUrl) {
        const outputPath = buildOutputPath(
          outputDir,
          filename ? `${filename}_${i}` : undefined,
          "mp4",
        );
        outputPathGuard?.(outputPath);
        await downloadUrlToFile(videoUrl, outputPath, outputPathGuard, networkPolicyGuard);
        outputPaths.push(outputPath);
      }
    }
    return { jobId: taskId, provider: "kling", status: "succeeded", outputPaths };
  }

  if (taskStatus === "failed") {
    return {
      jobId: taskId,
      provider: "kling",
      status: "failed",
      error: data.data?.task_status_msg,
    };
  }

  return { jobId: taskId, provider: "kling", status: "running" };
}

// ── Shared utilities ──────────────────────────────────────────────────────────

async function downloadUrlToFile(
  url: string,
  outputPath: string,
  outputPathGuard?: OutputPathGuard,
  networkPolicyGuard?: NetworkPolicyGuard,
): Promise<void> {
  outputPathGuard?.(outputPath);
  networkPolicyGuard?.(url, "video_output_download");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download video: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buffer);
}

export function buildOutputPath(outputDir: string, filename?: string, ext = "mp4"): string {
  if (!filename?.trim()) return path.join(outputDir, `video_${Date.now()}.${ext}`);

  const rawFilename = filename.trim().replaceAll("\\", "/");
  if (
    rawFilename.includes("\0") ||
    path.posix.isAbsolute(rawFilename) ||
    path.win32.isAbsolute(rawFilename) ||
    /^[A-Za-z]:/.test(rawFilename)
  ) {
    throw new Error("Video filename must be a relative path inside the output directory.");
  }

  const segments = rawFilename.split("/").filter((segment) => segment && segment !== ".");
  if (segments.length === 0 || segments.some((segment) => segment === "..")) {
    throw new Error("Video filename must not contain parent-directory traversal.");
  }

  const sanitizedSegments = segments.map((segment) => {
    const sanitized = segment.replace(/[^\p{L}\p{N}._-]/gu, "_");
    return /^\.+$/.test(sanitized) ? "_" : sanitized || "_";
  });
  const lastIndex = sanitizedSegments.length - 1;
  const stem = sanitizedSegments[lastIndex].replace(/\.[^.]+$/, "") || "video";
  return path.join(outputDir, ...sanitizedSegments.slice(0, lastIndex), `${stem}.${ext}`);
}

function buildSetupHint(provider: VideoProvider): { type: string; label: string; target: string } {
  if (provider === "gemini")
    return { type: "open_settings", label: "Set up Gemini API key", target: "gemini" };
  if (provider === "vertex")
    return { type: "open_settings", label: "Set up Vertex AI project/access token", target: "llm" };
  if (provider === "kling")
    return { type: "open_settings", label: "Set up Kling API key", target: "llm" };
  if (provider === "local")
    return { type: "open_settings", label: "Set up the local video model", target: "llm" };
  return {
    type: "open_settings",
    label: "Set up an OpenAI-compatible video service",
    target: "llm",
  };
}

// ── Provider availability check ───────────────────────────────────────────────

function getConfiguredVideoProviders(
  settings: ReturnType<typeof LLMProviderFactory.loadSettings>,
): VideoProvider[] {
  const providers: VideoProvider[] = [];
  if (resolveOpenAICompatibleVideoConfig(settings)) providers.push("openai-compatible");
  if (settings.gemini?.apiKey?.trim()) providers.push("gemini");
  if (
    settings.videoGeneration?.vertex?.projectId?.trim() &&
    settings.videoGeneration?.vertex?.accessToken?.trim()
  )
    providers.push("vertex");
  if (settings.videoGeneration?.kling?.apiKey?.trim()) providers.push("kling");
  if (resolveLocalVideoConfig(settings.videoGeneration?.local)) providers.push("local");
  return providers;
}

function selectVideoProviderOrder(
  settings: ReturnType<typeof LLMProviderFactory.loadSettings>,
  providerOverride?: VideoProvider | "auto",
): VideoProvider[] {
  const configured = getConfiguredVideoProviders(settings);
  if (!configured.length) return [];

  const vCfg = settings.videoGeneration;
  const order: VideoProvider[] = [];
  const pushConfigured = (provider?: VideoProvider) => {
    if (!provider || !configured.includes(provider) || order.includes(provider)) return;
    order.push(provider);
  };

  if (providerOverride && providerOverride !== "auto") {
    if (configured.includes(providerOverride)) {
      order.push(providerOverride);
    } else {
      console.warn(
        `[VideoGenerator] Ignoring unconfigured provider override "${providerOverride}" and using configured provider order.`,
      );
    }
  }

  // Use explicit default/fallback from settings
  pushConfigured(vCfg?.defaultProvider);
  for (const p of configured) {
    pushConfigured(p);
  }
  pushConfigured(vCfg?.fallbackProvider);
  return order;
}

// ── VideoGenerator ────────────────────────────────────────────────────────────

/**
 * Provider-agnostic video generation service.
 * Parallel to ImageGenerator — dispatches to the best configured provider with fallback.
 */
export class VideoGenerator {
  constructor(
    private workspace: Workspace,
    private filesystemApprovalHandlers: WorkspaceFilesystemApprovalHandlers = {},
  ) {}

  /** Check the concrete provider/download destination against profile rules. */
  private assertNetworkAccess(url: string, toolName = "generate_video"): void {
    const decision = evaluateNetworkPolicy({
      url,
      toolName,
      networkEnabled: this.workspace.permissions.network,
      accessNetworkMode: this.workspace.permissions.accessNetworkMode,
      profileDomainRules: this.workspace.permissions.accessDomainRules,
    });
    if (decision.action !== "allow") {
      throw new Error(`Network access denied for ${decision.url}: ${decision.reason}`);
    }
  }

  private getProviderNetworkEndpoint(
    provider: VideoProvider,
    settings: ReturnType<typeof LLMProviderFactory.loadSettings>,
  ): string | null {
    switch (provider) {
      case "openai-compatible":
        return resolveOpenAICompatibleVideoConfig(settings)?.baseUrl ?? null;
      case "gemini":
        return "https://generativelanguage.googleapis.com/v1beta";
      case "vertex": {
        const location = settings.videoGeneration?.vertex?.location?.trim() || "us-central1";
        return `https://${location}-aiplatform.googleapis.com/v1`;
      }
      case "kling":
        return (
          settings.videoGeneration?.kling?.baseUrl?.trim() || "https://api.klingai.com"
        ).replace(/\/+$/, "");
      case "local":
        // Runs on this machine; no network endpoint to check.
        return null;
    }
  }

  private async normalizeReferencePaths(
    request: VideoGenerationRequest,
  ): Promise<VideoGenerationRequest> {
    const normalized = { ...request };
    if (request.referenceImagePath) {
      normalized.referenceImagePath = await this.validateReferencePath(
        this.workspace,
        request.referenceImagePath,
        "Video reference image",
        25 * 1024 * 1024,
      );
    }
    if (request.referenceVideoPath) {
      normalized.referenceVideoPath = await this.validateReferencePath(
        this.workspace,
        request.referenceVideoPath,
        "Video reference video",
        500 * 1024 * 1024,
      );
    }
    return normalized;
  }

  private async validateReferencePath(
    workspace: Workspace,
    rawPath: string,
    label: string,
    maxBytes: number,
  ): Promise<string> {
    const resolvedPath = await assertWorkspaceReadableFileAccessWithApproval(
      workspace,
      rawPath,
      label,
      this.filesystemApprovalHandlers,
    );
    const stats = await fs.promises.stat(resolvedPath);
    if (stats.size > maxBytes) {
      throw new Error(
        `${label} is too large (${stats.size} bytes). Max allowed is ${maxBytes} bytes.`,
      );
    }
    const extension = path.extname(rawPath).toLowerCase();
    const allowedExtensions =
      label === "Video reference image"
        ? new Set([".png", ".jpg", ".jpeg", ".webp"])
        : new Set([".mp4", ".mov", ".m4v", ".webm"]);
    if (!allowedExtensions.has(extension)) {
      throw new Error(
        `${label} type "${extension || "(none)"}" is not supported. ` +
          `Allowed: ${Array.from(allowedExtensions.values()).join(", ")}`,
      );
    }
    return resolvedPath;
  }

  private assertOutputPathAllowed(outputPath: string): void {
    if (this.workspace.permissions.write === false) {
      throw new Error("Write permission not granted for video generation");
    }
    const access = evaluateWorkspaceFilesystemAccess(this.workspace, outputPath, "write");
    if (access.decision !== "allow") {
      if (access.reason === "profile_filesystem_denied") {
        throw new Error(`Path is denied by the active access profile: ${outputPath}`);
      }
      throw new Error(
        `Video output path is outside the active access profile boundary: ${outputPath}`,
      );
    }
  }

  async generate(request: VideoGenerationRequest): Promise<VideoGenerationResult> {
    const settings = LLMProviderFactory.loadSettings();
    const outputDir = this.workspace.path;
    const providerOrder = selectVideoProviderOrder(settings, request.provider);
    console.log(
      `[VideoGenerator] request.provider=${request.provider ?? "undefined"}, providerOrder=[${providerOrder.join(", ")}], defaultProvider=${settings.videoGeneration?.defaultProvider ?? "unset"}`,
    );

    if (providerOrder.length === 0) {
      return {
        success: false,
        error:
          "No video generation provider configured. Configure an OpenAI-compatible video service, Gemini, Vertex AI, Kling or the local model in Settings → AI Models → Video Generation.",
        actionHint: buildSetupHint("openai-compatible"),
      };
    }

    // VideoTools validates references at the tool boundary; repeat the check
    // here because VideoGenerator is also exported and can be called directly
    // by an integration or a future provider adapter.
    const safeRequest = await this.normalizeReferencePaths(request);

    let bestError: { error: string; actionHint: ReturnType<typeof buildSetupHint> } | null = null;

    for (const provider of providerOrder) {
      const args: AdapterArgs = {
        request: safeRequest,
        settings,
        outputDir,
        outputPathGuard: this.assertOutputPathAllowed.bind(this),
        networkPolicyGuard: this.assertNetworkAccess.bind(this),
      };
      let result: AdapterResult;

      try {
        if (provider === "openai-compatible") result = await generateWithOpenAICompatible(args);
        else if (provider === "gemini") result = await generateWithGemini(args);
        else if (provider === "vertex") result = await generateWithVertex(args);
        else if (provider === "kling") result = await generateWithKling(args);
        else if (provider === "local") result = generateWithLocal(args);
        else continue;
      } catch (err) {
        result = { success: false, error: err instanceof Error ? err.message : String(err) };
      }

      if (result.success) {
        return {
          success: true,
          jobId: result.jobId,
          outputPaths: result.outputPaths,
          provider,
          model: result.model,
          pending: result.pending,
        };
      }

      console.error(`[VideoGenerator] Provider "${provider}" failed:`, result.error);
      if (!bestError) {
        bestError = {
          error: result.error ?? "Unknown error",
          actionHint: buildSetupHint(provider),
        };
      }
    }

    return {
      success: false,
      error: bestError?.error ?? "All video providers failed.",
      actionHint: bestError?.actionHint ?? buildSetupHint("openai-compatible"),
    };
  }

  async pollJob(
    jobId: string,
    provider: VideoProvider,
    filename?: string,
  ): Promise<VideoGenerationJobStatus & { outputPaths?: string[] }> {
    const normalizedJobId = jobId?.trim();
    if (!normalizedJobId) {
      return {
        jobId: jobId ?? "",
        provider,
        status: "failed",
        error: "Video generation job ID is required.",
      };
    }

    const settings = LLMProviderFactory.loadSettings();
    const outputDir = this.workspace.path;

    try {
      const providerEndpoint = this.getProviderNetworkEndpoint(provider, settings);
      if (providerEndpoint) {
        this.assertNetworkAccess(providerEndpoint, "get_video_generation_job");
      }
      if (provider === "openai-compatible") {
        return await pollOpenAICompatibleJob(
          normalizedJobId,
          settings,
          outputDir,
          filename,
          this.assertOutputPathAllowed.bind(this),
          this.assertNetworkAccess.bind(this),
        );
      }
      if (provider === "gemini") {
        const apiKey = (await resolveSecretValue(settings.gemini?.apiKey?.trim())) ?? "";
        return await pollGeminiOperation(
          normalizedJobId,
          apiKey,
          outputDir,
          filename,
          this.assertOutputPathAllowed.bind(this),
          this.assertNetworkAccess.bind(this),
        );
      }
      if (provider === "vertex") {
        const accessToken = settings.videoGeneration?.vertex?.accessToken?.trim() ?? "";
        return await pollVertexOperation(
          normalizedJobId,
          accessToken,
          outputDir,
          filename,
          this.assertOutputPathAllowed.bind(this),
          this.assertNetworkAccess.bind(this),
        );
      }
      if (provider === "local") {
        const job = await waitForLocalVideoJob(normalizedJobId, LOCAL_VIDEO_POLL_WAIT_MS);
        if (!job) {
          return {
            jobId: normalizedJobId,
            provider,
            status: "failed",
            error: "Unknown local video job (the app may have restarted since it started).",
          };
        }
        return {
          jobId: normalizedJobId,
          provider,
          status: job.status,
          ...(job.status === "succeeded" ? { outputPaths: [job.outputPath] } : {}),
          ...(job.error ? { error: job.error } : {}),
          ...(job.status === "running"
            ? {
                error: `Still rendering after ${job.elapsedSeconds}s (a local clip usually takes 5-15 minutes). Call get_video_generation_job again; do not start another clip or finish the step yet.`,
              }
            : {}),
        };
      }
      if (provider === "kling") {
        return await pollKlingJob(
          normalizedJobId,
          settings.videoGeneration?.kling,
          outputDir,
          filename,
          this.assertOutputPathAllowed.bind(this),
          this.assertNetworkAccess.bind(this),
        );
      }
    } catch (err) {
      return {
        jobId: normalizedJobId,
        provider,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    return {
      jobId: normalizedJobId,
      provider,
      status: "failed",
      error: `Unknown provider: ${provider}`,
    };
  }

  async cancelJob(
    jobId: string,
    provider: VideoProvider,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      if (provider === "local") {
        return cancelLocalVideoJob(jobId)
          ? { success: true }
          : { success: false, error: "No running local video job with that ID." };
      }
      // Other providers do not expose a cancel endpoint; return unsupported.
      return { success: false, error: `Cancel not supported for provider "${provider}".` };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  static isAvailable(): boolean {
    const settings = LLMProviderFactory.loadSettings();
    return getConfiguredVideoProviders(settings).length > 0;
  }
}
