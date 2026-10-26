import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOutputPath,
  normalizeOpenAICompatibleVideoBaseUrl,
  VideoGenerator,
} from "../video-generator";
import { LLMProviderFactory } from "../../llm/provider-factory";

const fetchMock = vi.fn();
(global as Any).fetch = fetchMock;

let tempDir = "";

const COMPAT_BASE = "https://video.example.com/v1";
const COMPAT = {
  apiKey: "compat-key",
  baseUrl: COMPAT_BASE,
  model: "demo-video-1",
};

function jsonResponse(data: Any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mp4Response(): Response {
  return new Response(Uint8Array.from([0, 1, 2, 3]), {
    status: 200,
    headers: { "Content-Type": "video/mp4" },
  });
}

function mockSettings(videoGeneration: Any, extra: Any = {}): void {
  vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
    providerType: "anthropic",
    modelKey: "claude-sonnet-5-5",
    openai: {},
    gemini: {},
    ...extra,
    videoGeneration,
  } as Any);
}

function makeGenerator(permissions: Record<string, boolean> = { write: true }): VideoGenerator {
  return new VideoGenerator({ path: tempDir, permissions } as Any);
}

afterEach(() => {
  vi.restoreAllMocks();
  fetchMock.mockReset();
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

describe("VideoGenerator", () => {
  it("rejects absolute and parent-directory output paths while preserving safe subdirectories", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-video-"));

    expect(() => buildOutputPath(tempDir, "../../outside.mp4")).toThrow(
      /relative path|parent-directory traversal/i,
    );
    expect(() => buildOutputPath(tempDir, "/tmp/outside.mp4")).toThrow(/relative path/i);
    expect(buildOutputPath(tempDir, "outputs/armadillo.mp4")).toBe(
      path.join(tempDir, "outputs", "armadillo.mp4"),
    );
  });

  it("normalizes the OpenAI-compatible base URL to the API root", () => {
    expect(normalizeOpenAICompatibleVideoBaseUrl(`${COMPAT_BASE}/`)).toBe(COMPAT_BASE);
    expect(normalizeOpenAICompatibleVideoBaseUrl(`${COMPAT_BASE}/videos`)).toBe(COMPAT_BASE);
    expect(normalizeOpenAICompatibleVideoBaseUrl(` ${COMPAT_BASE}/videos/ `)).toBe(COMPAT_BASE);
    expect(normalizeOpenAICompatibleVideoBaseUrl("https://video.example.com")).toBe(
      "https://video.example.com",
    );
  });

  it("submits text-to-video to the Videos API, ignores an unconfigured override, and writes the completed MP4", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-video-"));
    mockSettings({
      defaultProvider: "openai-compatible",
      openaiCompatible: { ...COMPAT, baseUrl: `${COMPAT_BASE}/videos/` },
    });

    fetchMock.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer compat-key");

      if (target === `${COMPAT_BASE}/videos`) {
        expect(init?.method).toBe("POST");
        expect(headers["Content-Type"]).toBe("application/json");
        expect(JSON.parse(String(init?.body))).toEqual({
          model: "demo-video-1",
          prompt: expect.stringContaining("armadillo"),
          size: "1280x720",
          seconds: "5",
        });
        return jsonResponse({ id: "job-123", status: "queued" });
      }
      if (target === `${COMPAT_BASE}/videos/job-123`) {
        return jsonResponse({ id: "job-123", status: "completed" });
      }
      if (target === `${COMPAT_BASE}/videos/job-123/content?variant=video`) {
        return mp4Response();
      }
      throw new Error(`Unexpected fetch URL: ${target}`);
    });

    const generator = makeGenerator();
    const submitted = await generator.generate({
      prompt: "A realistic armadillo walking through a sunlit desert.",
      provider: "gemini",
      filename: "outputs/armadillo.mp4",
    });

    expect(submitted.success).toBe(true);
    expect(submitted.pending).toBe(true);
    expect(submitted.jobId).toBe("job-123");
    expect(submitted.provider).toBe("openai-compatible");
    expect(submitted.model).toBe("demo-video-1");

    const status = await generator.pollJob("job-123", "openai-compatible", "outputs/armadillo.mp4");

    expect(status.status).toBe("succeeded");
    expect(status.outputPaths).toEqual([path.join(tempDir, "outputs", "armadillo.mp4")]);
    expect(fs.existsSync(path.join(tempDir, "outputs", "armadillo.mp4"))).toBe(true);
  });

  it("sends image-to-video as a multipart input_reference with bearer auth", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-video-"));
    fs.writeFileSync(path.join(tempDir, "scene.png"), Uint8Array.from([0x89, 0x50, 0x4e, 0x47]));
    mockSettings({ defaultProvider: "openai-compatible", openaiCompatible: COMPAT });

    let form: FormData | undefined;
    let headers: Record<string, string> = {};
    fetchMock.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe(`${COMPAT_BASE}/videos`);
      form = init?.body as FormData;
      headers = (init?.headers ?? {}) as Record<string, string>;
      return jsonResponse({ id: "job-i2v", status: "queued" });
    });

    const generator = makeGenerator({ read: true, write: true });
    const submitted = await generator.generate({
      prompt: "Slow push in; mist drifts over the river.",
      provider: "openai-compatible",
      model: "demo-i2v",
      mode: "image_to_video",
      referenceImagePath: "scene.png",
      duration: 8,
      aspectRatio: "9:16",
    });

    expect(submitted.success).toBe(true);
    expect(submitted.jobId).toBe("job-i2v");
    expect(submitted.model).toBe("demo-i2v");
    expect(form).toBeInstanceOf(FormData);
    expect(form!.get("model")).toBe("demo-i2v");
    expect(form!.get("size")).toBe("720x1280");
    expect(form!.get("seconds")).toBe("8");
    expect(String(form!.get("prompt"))).toContain("mist");
    const reference = form!.get("input_reference") as File;
    expect(reference).toBeInstanceOf(Blob);
    expect(reference.size).toBeGreaterThan(0);
    expect(headers.Authorization).toBe("Bearer compat-key");
    // fetch must set the multipart boundary itself.
    expect(headers["Content-Type"]).toBeUndefined();
  });

  it("downloads from the file link when a finished job carries one", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-video-"));
    mockSettings({ openaiCompatible: COMPAT });

    fetchMock.mockImplementation(async (url: RequestInfo | URL) => {
      const target = String(url);
      if (target === `${COMPAT_BASE}/videos/job-url`) {
        return jsonResponse({
          id: "job-url",
          status: "succeeded",
          url: "https://cdn.example.com/out/job-url.mp4",
        });
      }
      if (target === "https://cdn.example.com/out/job-url.mp4") return mp4Response();
      throw new Error(`Unexpected fetch URL: ${target}`);
    });

    const status = await makeGenerator().pollJob("job-url", "openai-compatible", "clip");

    expect(status.status).toBe("succeeded");
    expect(status.outputPaths).toEqual([path.join(tempDir, "clip.mp4")]);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain(
      `${COMPAT_BASE}/videos/job-url/content?variant=video`,
    );
  });

  it("reports progress while running and the service's message when a job fails", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-video-"));
    mockSettings({ openaiCompatible: COMPAT });

    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "in_progress", progress: 42 }));
    const running = await makeGenerator().pollJob("job-run", "openai-compatible");
    expect(running.status).toBe("running");
    expect(running.progressPercent).toBe(42);
    expect(running.error).toBeUndefined();

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: "failed", error: { message: "prompt rejected by moderation" } }),
    );
    const failed = await makeGenerator().pollJob("job-bad", "openai-compatible");
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("prompt rejected by moderation");
  });

  it("fails fast when polling without a job id", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-video-"));
    mockSettings({ defaultProvider: "openai-compatible", openaiCompatible: COMPAT });

    const status = await makeGenerator().pollJob("", "openai-compatible", "outputs/armadillo.mp4");

    expect(status.status).toBe("failed");
    expect(status.error).toContain("job ID is required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no longer treats an OpenAI chat key or saved Sora settings as a video provider", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-video-"));
    mockSettings(
      { defaultProvider: "openai", openai: { defaultModel: "sora-2" } },
      { openai: { apiKey: "sk-chat" }, azure: { apiKey: "az", endpoint: "https://x.azure.com" } },
    );

    expect(VideoGenerator.isAvailable()).toBe(false);

    const result = await makeGenerator().generate({ prompt: "A kite over a bay." });

    expect(result.success).toBe(false);
    expect(result.error).toContain("No video generation provider configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not log during provider availability checks", () => {
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockSettings({ defaultProvider: "openai-compatible", openaiCompatible: COMPAT });

    expect(VideoGenerator.isAvailable()).toBe(true);
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });
});
