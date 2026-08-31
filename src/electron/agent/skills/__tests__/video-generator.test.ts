import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOutputPath, VideoGenerator } from "../video-generator";
import { LLMProviderFactory } from "../../llm/provider-factory";

const fetchMock = vi.fn();
(global as Any).fetch = fetchMock;

let tempDir = "";

function jsonResponse(data: Any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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

  it("uses Azure Sora 2 videos API, ignores stray overrides, and writes the completed MP4 to the requested output path", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-video-"));

    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "azure",
      modelKey: "gpt-4o-mini",
      openai: {},
      gemini: {},
      azure: {
        apiKey: "azure-key",
        endpoint: "https://example.openai.azure.com/openai/v1/videos",
      },
      videoGeneration: {
        defaultProvider: "azure",
        azure: {
          videoDeployment: "sora",
          videoApiVersion: "2025-04-01-preview",
        },
      },
    } as Any);

    fetchMock.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);

      if (target.includes("/openai/v1/videos?api-version=preview")) {
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe("sora-2");
        expect(body.prompt).toContain("armadillo");
        expect(body.size).toBe("1280x720");
        expect(body.seconds).toBe("4");
        return jsonResponse({ id: "job-123", status: "queued" });
      }

      if (target.includes("/openai/v1/videos/job-123?api-version=preview")) {
        return jsonResponse({ id: "job-123", status: "completed" });
      }

      if (target.includes("/openai/v1/videos/job-123/content?api-version=preview&variant=video")) {
        return new Response(Uint8Array.from([0, 1, 2, 3]), {
          status: 200,
          headers: { "Content-Type": "video/mp4" },
        });
      }

      throw new Error(`Unexpected fetch URL: ${target}`);
    });

    const generator = new VideoGenerator({
      path: tempDir,
      permissions: { write: true },
    } as Any);

    const submitted = await generator.generate({
      prompt: "A realistic armadillo walking through a sunlit desert.",
      provider: "gemini",
      model: "kling-v2",
      filename: "outputs/armadillo.mp4",
    });

    expect(submitted.success).toBe(true);
    expect(submitted.pending).toBe(true);
    expect(submitted.jobId).toBe("job-123");
    expect(submitted.provider).toBe("azure");
    expect(submitted.model).toBe("sora-2");

    const status = await generator.pollJob("job-123", "azure", "outputs/armadillo.mp4");

    expect(status.status).toBe("succeeded");
    expect(status.outputPaths).toEqual([path.join(tempDir, "outputs", "armadillo.mp4")]);
    expect(fs.existsSync(path.join(tempDir, "outputs", "armadillo.mp4"))).toBe(true);
  });

  it("fails fast when polling without a job id", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-video-"));

    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "azure",
      modelKey: "gpt-4o-mini",
      openai: {},
      gemini: {},
      azure: {
        apiKey: "azure-key",
        endpoint: "https://example.openai.azure.com",
      },
      videoGeneration: {
        defaultProvider: "azure",
      },
    } as Any);

    const generator = new VideoGenerator({
      path: tempDir,
      permissions: { write: true },
    } as Any);

    const status = await generator.pollJob("", "azure", "outputs/armadillo.mp4");

    expect(status.status).toBe("failed");
    expect(status.error).toContain("job ID is required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not log during provider availability checks", () => {
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "azure",
      modelKey: "gpt-4o-mini",
      openai: {},
      gemini: {},
      azure: {
        apiKey: "azure-key",
        endpoint: "https://example.openai.azure.com/openai/v1/videos",
      },
      videoGeneration: {
        defaultProvider: "azure",
      },
    } as Any);

    expect(VideoGenerator.isAvailable()).toBe(true);
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });
});
