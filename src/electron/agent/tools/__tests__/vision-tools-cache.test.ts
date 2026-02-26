import { describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../../../shared/types";
import { VisionTools } from "../vision-tools";
import { LLMProviderFactory } from "../../llm/provider-factory";

function createVisionTools() {
  const workspace: Workspace = {
    id: "w1",
    name: "Test",
    path: "/tmp",
    createdAt: Date.now(),
    permissions: {
      read: true,
      write: true,
      delete: true,
      network: true,
      shell: true,
    },
    isTemp: true,
  };
  const daemon = { logEvent: vi.fn() } as Any;
  return new VisionTools(workspace, daemon, "task-1") as Any;
}

describe("VisionTools cache and page range guards", () => {
  it("uses request-specific cache keys (prompt changes should not collide)", () => {
    const vision = createVisionTools();
    const keyA = vision.buildCacheKey({
      tool: "read_pdf_visual",
      absPath: "/tmp/a.pdf",
      mtimeMs: 100,
      pages: "1-2",
      prompt: "describe layout",
      provider: "bedrock",
    });
    const keyB = vision.buildCacheKey({
      tool: "read_pdf_visual",
      absPath: "/tmp/a.pdf",
      mtimeMs: 100,
      pages: "1-2",
      prompt: "extract typography only",
      provider: "bedrock",
    });

    expect(keyA).not.toBe(keyB);
  });

  it("evicts oldest entries once cache exceeds configured max", () => {
    const vision = createVisionTools();

    for (let i = 0; i < 140; i++) {
      vision.setCachedResult(`k-${i}`, { ok: true, i });
    }

    expect(vision.visionCache.size).toBeLessThanOrEqual(128);
    expect(vision.visionCache.has("k-0")).toBe(false);
    expect(vision.visionCache.has("k-139")).toBe(true);
  });

  it("normalizes reversed page ranges", () => {
    const vision = createVisionTools();

    expect(vision.parsePageRange("5-1")).toEqual({ firstPage: 1, lastPage: 5 });
    expect(vision.parsePageRange("1-20")).toEqual({ firstPage: 1, lastPage: 5 });
  });

  it("retries only transient vision errors", () => {
    const vision = createVisionTools();

    expect(vision.shouldRetryVisionError("OpenAI API key not configured")).toBe(false);
    expect(vision.shouldRetryVisionError("401 Unauthorized")).toBe(false);
    expect(vision.shouldRetryVisionError({ status: 401, message: "Unauthorized" })).toBe(false);
    expect(vision.shouldRetryVisionError("429 rate limit exceeded")).toBe(true);
    expect(vision.shouldRetryVisionError({ statusCode: 503, message: "Service Unavailable" })).toBe(
      true,
    );
    expect(vision.shouldRetryVisionError("503 Service Unavailable")).toBe(true);
    expect(vision.shouldRetryVisionError("network timeout while calling provider")).toBe(true);
  });

  it("emits both tool_result and tool_error for aggregate PDF failures", () => {
    const vision = createVisionTools();
    const daemon = vision.daemon;

    vision.logReadPdfVisualFailure("p1 failed", { pagesAnalyzed: 0, pagesFailed: 1 });

    expect(daemon.logEvent).toHaveBeenCalledWith(
      "task-1",
      "tool_result",
      expect.objectContaining({
        tool: "read_pdf_visual",
        success: false,
        error: "p1 failed",
        pagesAnalyzed: 0,
        pagesFailed: 1,
      }),
    );
    expect(daemon.logEvent).toHaveBeenCalledWith(
      "task-1",
      "tool_error",
      expect.objectContaining({
        tool: "read_pdf_visual",
        error: "p1 failed",
        pagesAnalyzed: 0,
        pagesFailed: 1,
      }),
    );
  });

  it("can suppress per-page tool_error emission when aggregate handling is used", async () => {
    const vision = createVisionTools();
    const daemon = vision.daemon;
    const loadSettingsSpy = vi
      .spyOn(LLMProviderFactory, "loadSettings")
      .mockReturnValue({ providerType: "openai", openai: { apiKey: "" } } as Any);

    try {
      const result = await vision.analyzeBuffer({
        base64: "AA==",
        mimeType: "image/png",
        prompt: "test",
        maxTokens: 64,
        providerOverride: "openai",
        toolName: "read_pdf_visual",
        emitToolError: false,
      });
      expect(result.success).toBe(false);
      const emittedToolError = daemon.logEvent.mock.calls.some((call: Any[]) => call[1] === "tool_error");
      expect(emittedToolError).toBe(false);
    } finally {
      loadSettingsSpy.mockRestore();
    }
  });
});
