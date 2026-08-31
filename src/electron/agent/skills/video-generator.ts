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

// ── Provider & model types ────────────────────────────────────────────────────

export type VideoProvider = "openai" | "azure" | "gemini" | "vertex" | "kling";

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

// ── OpenAI Sora 2 ─────────────────────────────────────────────────────────────

async function generateWithOpenAI(args: AdapterArgs): Promise<AdapterResult> {
  console.log("[VideoGenerator] generateWithOpenAI called");
  const apiKey = args.settings.openai?.apiKey?.trim();
  if (!apiKey) return { success: false, error: "OpenAI API key not configured." };

  const vCfg = args.settings.videoGeneration?.openai;
  const model = args.request.model || vCfg?.defaultModel || "sora-2";
  const duration = args.request.duration ?? vCfg?.defaultDuration ?? 5;
  const aspectRatio = args.request.aspectRatio ?? vCfg?.defaultAspectRatio ?? "16:9";

  const mode = args.request.mode ?? "text_to_video";
  if (mode !== "text_to_video" && mode !== "image_to_video") {
    return { success: false, error: `OpenAI Sora does not support mode "${mode}".` };
  }

  const body: Record<string, unknown> = {
    model,
    prompt: args.request.prompt,
    n: 1,
    size: aspectRatioToSoraSize(aspectRatio),
    duration,
  };

  if (mode === "image_to_video" && args.request.referenceImagePath) {
    const imgData = fs.readFileSync(args.request.referenceImagePath);
    body.image = { b64_json: imgData.toString("base64") };
  }

  args.networkPolicyGuard?.("https://api.openai.com/v1/video/generations", "generate_video");
  const response = await fetch("https://api.openai.com/v1/video/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => String(response.status));
    return { success: false, error: `OpenAI Sora error ${response.status}: ${errText}` };
  }

  const data = (await response.json()) as {
    id?: string;
    status?: string;
    data?: Array<{ url?: string; b64_json?: string }>;
  };

  const jobId = data.id;

  if (data.status === "queued" || data.status === "running" || (!data.data && jobId)) {
    return { success: true, jobId, pending: true, model };
  }

  if (data.data && data.data.length > 0) {
    const outputPaths = await downloadVideoItems(
      data.data,
      args.outputDir,
      args.request.filename,
      args.outputPathGuard,
      args.networkPolicyGuard,
    );
    return { success: true, jobId, outputPaths, model };
  }

  return { success: false, jobId, error: "No video data in OpenAI response." };
}

async function pollOpenAIJob(
  jobId: string,
  apiKey: string,
  outputDir: string,
  filename?: string,
  outputPathGuard?: OutputPathGuard,
  networkPolicyGuard?: NetworkPolicyGuard,
): Promise<VideoGenerationJobStatus & { outputPaths?: string[] }> {
  networkPolicyGuard?.(
    `https://api.openai.com/v1/video/generations/${jobId}`,
    "get_video_generation_job",
  );
  const response = await fetch(`https://api.openai.com/v1/video/generations/${jobId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    return { jobId, provider: "openai", status: "failed", error: `HTTP ${response.status}` };
  }
  const data = (await response.json()) as {
    id?: string;
    status?: string;
    data?: Array<{ url?: string; b64_json?: string }>;
    error?: { message?: string };
  };
  const status = mapOpenAIStatus(data.status);
  if (status === "succeeded" && data.data?.length) {
    const outputPaths = await downloadVideoItems(
      data.data,
      outputDir,
      filename,
      outputPathGuard,
      networkPolicyGuard,
    );
    return { jobId, provider: "openai", status, outputPaths };
  }
  return {
    jobId,
    provider: "openai",
    status,
    error: data.error?.message,
  };
}

function mapOpenAIStatus(s?: string): VideoGenerationJobStatus["status"] {
  if (s === "succeeded") return "succeeded";
  if (s === "failed") return "failed";
  if (s === "cancelled") return "cancelled";
  if (s === "running") return "running";
  return "pending";
}

function aspectRatioToSoraSize(ar: VideoAspectRatio): string {
  if (ar === "9:16") return "480x854";
  if (ar === "1:1") return "480x480";
  return "854x480"; // 16:9
}

// ── Azure OpenAI Sora 2 ───────────────────────────────────────────────────────
// Current Azure Sora 2 overview docs use the OpenAI-style v1 video API:
//   POST   {base}/openai/v1/videos?api-version=preview
//   GET    {base}/openai/v1/videos/{videoId}?api-version=preview
//   GET    {base}/openai/v1/videos/{videoId}/content?api-version=preview&variant=video
//
// Notes:
// - Azure's preview REST reference still documents an older
//   `/openai/v1/video/generations/jobs` flow, but Sora 2 itself currently uses
//   `/openai/v1/videos`.
// - The live Sora 2 endpoint is strict about payload types: `seconds` must be
//   one of "4", "8", or "12" as a string.

/**
 * Normalize any Azure endpoint the user may have entered to the base URL.
 * e.g. "https://foo.openai.azure.com/openai/v1/videos" → "https://foo.openai.azure.com"
 * e.g. "https://foo.openai.azure.com" → "https://foo.openai.azure.com"
 */
function normalizeAzureBaseEndpoint(endpoint: string): string {
  const idx = endpoint.indexOf("/openai/");
  if (idx !== -1) return endpoint.slice(0, idx);
  return endpoint.replace(/\/$/, "");
}

function normalizeAzureVideoModel(
  model?: string,
  configuredModel?: string,
): "sora-2" | "sora-2-pro" {
  const raw = model?.trim() || configuredModel?.trim() || "";
  const lowered = raw.toLowerCase();

  if (lowered === "sora-2-pro") return "sora-2-pro";
  if (lowered === "sora" || lowered === "sora-2") return "sora-2";

  if (raw) {
    console.warn(
      `[VideoGenerator] Ignoring incompatible Azure video model override "${raw}" and using Sora 2.`,
    );
  }
  return "sora-2";
}

function normalizeAzureVideoApiVersion(apiVersion?: string): string {
  const raw = apiVersion?.trim();
  if (!raw) return "preview";

  // Azure Sora's video endpoint expects the preview label rather than the
  // dated preview API versions commonly used by chat/completions settings.
  if (/^\d{4}-\d{2}-\d{2}-preview$/i.test(raw)) return "preview";
  return raw;
}

function aspectRatioAndResolutionToAzureVideoSize(
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

function normalizeAzureVideoSeconds(seconds?: number): "4" | "8" | "12" {
  const value = Number.isFinite(seconds) ? Math.max(1, Math.round(seconds as number)) : 4;
  if (value <= 6) return "4";
  if (value <= 10) return "8";
  return "12";
}

function mapAzureVideoStatus(status?: string): VideoGenerationJobStatus["status"] {
  if (status === "completed") return "succeeded";
  if (status === "failed") return "failed";
  if (status === "in_progress") return "running";
  return "pending";
}

async function generateWithAzure(args: AdapterArgs): Promise<AdapterResult> {
  const azCfg = args.settings.azure;
  const vCfg = args.settings.videoGeneration?.azure;
  // Prefer dedicated video credentials; fall back to main Azure chat credentials
  const apiKey = vCfg?.videoApiKey?.trim() || azCfg?.apiKey?.trim();
  const rawEndpoint = vCfg?.videoEndpoint?.trim() || azCfg?.endpoint?.trim();
  const model = normalizeAzureVideoModel(args.request.model, vCfg?.videoDeployment);
  const apiVersion = normalizeAzureVideoApiVersion(vCfg?.videoApiVersion);

  if (!apiKey || !rawEndpoint) {
    return {
      success: false,
      error: "Azure OpenAI API key and endpoint are required for video generation.",
    };
  }

  const base = normalizeAzureBaseEndpoint(rawEndpoint);
  const url = `${base}/openai/v1/videos?api-version=${encodeURIComponent(apiVersion)}`;

  const duration = args.request.duration ?? vCfg?.defaultDuration ?? 5;
  const aspectRatio = args.request.aspectRatio ?? vCfg?.defaultAspectRatio ?? "16:9";
  const resolution = args.request.resolution ?? vCfg?.defaultResolution ?? "720p";
  const size = aspectRatioAndResolutionToAzureVideoSize(aspectRatio, resolution);
  const seconds = normalizeAzureVideoSeconds(duration);

  const mode = args.request.mode ?? "text_to_video";
  if (mode !== "text_to_video" && mode !== "image_to_video") {
    return { success: false, error: `Azure Sora does not support mode "${mode}".` };
  }

  const body: Record<string, unknown> = {
    prompt: args.request.prompt,
    model,
    size,
    seconds,
  };

  if (mode === "image_to_video" && args.request.referenceImagePath) {
    return {
      success: false,
      error:
        "Azure Sora 2 image-to-video is not implemented in this build yet. Use text_to_video for now.",
    };
  }

  console.log(`[VideoGenerator][Azure] POST ${url}`, JSON.stringify(body));

  args.networkPolicyGuard?.(url, "generate_video");
  const response = await fetch(url, {
    method: "POST",
    headers: { "api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => String(response.status));
    return {
      success: false,
      error: `Azure Sora error ${response.status}: ${errText} — URL: ${url}`,
    };
  }

  const data = (await response.json()) as { id?: string; status?: string };
  const jobId = data.id;
  if (!jobId) {
    return { success: false, error: `Azure Sora: no job ID in response: ${JSON.stringify(data)}` };
  }

  return { success: true, jobId, pending: true, model };
}

async function pollAzureJob(
  jobId: string,
  settings: ReturnType<typeof LLMProviderFactory.loadSettings>,
  outputDir: string,
  filename?: string,
  outputPathGuard?: OutputPathGuard,
  networkPolicyGuard?: NetworkPolicyGuard,
): Promise<VideoGenerationJobStatus & { outputPaths?: string[] }> {
  const azCfg = settings.azure;
  const vCfg = settings.videoGeneration?.azure;
  const apiKey = (vCfg?.videoApiKey?.trim() || azCfg?.apiKey?.trim()) ?? "";
  const rawEndpoint = (vCfg?.videoEndpoint?.trim() || azCfg?.endpoint?.trim()) ?? "";
  const apiVersion = normalizeAzureVideoApiVersion(vCfg?.videoApiVersion);
  const base = normalizeAzureBaseEndpoint(rawEndpoint);

  const statusUrl = `${base}/openai/v1/videos/${jobId}?api-version=${encodeURIComponent(apiVersion)}`;
  console.log(`[VideoGenerator][Azure] GET ${statusUrl}`);

  networkPolicyGuard?.(statusUrl, "get_video_generation_job");
  const response = await fetch(statusUrl, { headers: { "api-key": apiKey } });
  if (!response.ok) {
    return {
      jobId,
      provider: "azure",
      status: "failed",
      error: `HTTP ${response.status} polling ${statusUrl}`,
    };
  }

  const data = (await response.json()) as {
    status?: string;
    error?: { message?: string; code?: string };
  };

  const status = mapAzureVideoStatus(data.status);

  if (status === "succeeded") {
    const videoUrl = `${base}/openai/v1/videos/${jobId}/content?api-version=${encodeURIComponent(apiVersion)}&variant=video`;
    console.log(`[VideoGenerator][Azure] Downloading video from ${videoUrl}`);
    networkPolicyGuard?.(videoUrl, "video_output_download");
    const videoResponse = await fetch(videoUrl, {
      headers: { "api-key": apiKey, Accept: "application/binary" },
    });
    if (!videoResponse.ok) {
      return {
        jobId,
        provider: "azure",
        status: "failed",
        error: `Failed to download video: HTTP ${videoResponse.status}`,
      };
    }

    const outputPath = buildOutputPath(outputDir, filename, "mp4");
    outputPathGuard?.(outputPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const buffer = Buffer.from(await videoResponse.arrayBuffer());
    fs.writeFileSync(outputPath, buffer);

    return { jobId, provider: "azure", status: "succeeded", outputPaths: [outputPath] };
  }

  return { jobId, provider: "azure", status, error: data.error?.message };
}

// ── Gemini Veo 3.1 ───────────────────────────────────────────────────────────

async function generateWithGemini(args: AdapterArgs): Promise<AdapterResult> {
  const apiKey = args.settings.gemini?.apiKey?.trim();
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
  const apiKey = kCfg?.apiKey?.trim();
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
  const apiKey = kCfg?.apiKey?.trim() ?? "";
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

async function downloadVideoItems(
  items: Array<{ url?: string; b64_json?: string }>,
  outputDir: string,
  filename?: string,
  outputPathGuard?: OutputPathGuard,
  networkPolicyGuard?: NetworkPolicyGuard,
): Promise<string[]> {
  const outputPaths: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const outputPath = buildOutputPath(outputDir, filename ? `${filename}_${i}` : undefined, "mp4");
    outputPathGuard?.(outputPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    if (item.url) {
      await downloadUrlToFile(item.url, outputPath, outputPathGuard, networkPolicyGuard);
    } else if (item.b64_json) {
      fs.writeFileSync(outputPath, Buffer.from(item.b64_json, "base64"));
    }
    outputPaths.push(outputPath);
  }
  return outputPaths;
}

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
  if (provider === "azure")
    return {
      type: "open_settings",
      label: "Set up Azure OpenAI video deployment",
      target: "azure",
    };
  if (provider === "vertex")
    return { type: "open_settings", label: "Set up Vertex AI project/access token", target: "llm" };
  if (provider === "kling")
    return { type: "open_settings", label: "Set up Kling API key", target: "llm" };
  return { type: "open_settings", label: "Set up OpenAI API key", target: "openai" };
}

// ── Provider availability check ───────────────────────────────────────────────

function getConfiguredVideoProviders(
  settings: ReturnType<typeof LLMProviderFactory.loadSettings>,
): VideoProvider[] {
  const providers: VideoProvider[] = [];
  if (settings.openai?.apiKey?.trim()) providers.push("openai");
  const azureVideoApiKey =
    settings.videoGeneration?.azure?.videoApiKey?.trim() || settings.azure?.apiKey?.trim();
  const azureVideoEndpoint =
    settings.videoGeneration?.azure?.videoEndpoint?.trim() || settings.azure?.endpoint?.trim();
  if (azureVideoApiKey && azureVideoEndpoint) providers.push("azure");
  if (settings.gemini?.apiKey?.trim()) providers.push("gemini");
  if (
    settings.videoGeneration?.vertex?.projectId?.trim() &&
    settings.videoGeneration?.vertex?.accessToken?.trim()
  )
    providers.push("vertex");
  if (settings.videoGeneration?.kling?.apiKey?.trim()) providers.push("kling");
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
      case "openai":
        return "https://api.openai.com/v1/video/generations";
      case "azure": {
        const endpoint =
          settings.videoGeneration?.azure?.videoEndpoint?.trim() ||
          settings.azure?.endpoint?.trim();
        return endpoint ? normalizeAzureBaseEndpoint(endpoint) : null;
      }
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
          "No video generation provider configured. Configure OpenAI / Azure / Gemini / Vertex / Kling in Settings → AI Models → Video Generation.",
        actionHint: buildSetupHint("openai"),
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
        if (provider === "openai") result = await generateWithOpenAI(args);
        else if (provider === "azure") result = await generateWithAzure(args);
        else if (provider === "gemini") result = await generateWithGemini(args);
        else if (provider === "vertex") result = await generateWithVertex(args);
        else if (provider === "kling") result = await generateWithKling(args);
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
      actionHint: bestError?.actionHint ?? buildSetupHint("openai"),
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
      if (provider === "openai") {
        const apiKey = settings.openai?.apiKey?.trim() ?? "";
        return await pollOpenAIJob(
          normalizedJobId,
          apiKey,
          outputDir,
          filename,
          this.assertOutputPathAllowed.bind(this),
          this.assertNetworkAccess.bind(this),
        );
      }
      if (provider === "azure") {
        return await pollAzureJob(
          normalizedJobId,
          settings,
          outputDir,
          filename,
          this.assertOutputPathAllowed.bind(this),
          this.assertNetworkAccess.bind(this),
        );
      }
      if (provider === "gemini") {
        const apiKey = settings.gemini?.apiKey?.trim() ?? "";
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
    const settings = LLMProviderFactory.loadSettings();

    try {
      if (provider === "openai") {
        const apiKey = settings.openai?.apiKey?.trim() ?? "";
        this.assertNetworkAccess(
          `https://api.openai.com/v1/video/generations/${jobId}/cancel`,
          "cancel_video_generation_job",
        );
        const response = await fetch(
          `https://api.openai.com/v1/video/generations/${jobId}/cancel`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}` },
          },
        );
        return { success: response.ok, error: response.ok ? undefined : `HTTP ${response.status}` };
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
