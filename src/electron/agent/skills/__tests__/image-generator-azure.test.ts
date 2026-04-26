import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadSettingsMock = vi.fn();

vi.mock("../../llm/provider-factory", () => ({
  LLMProviderFactory: {
    loadSettings: (...args: Any[]) => loadSettingsMock(...args),
  },
}));

import { ImageGenerator } from "../image-generator";

describe("ImageGenerator Azure", () => {
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-image-azure-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("falls back from gpt-image-2 to gpt-image-1.5 only after the configured timeout", async () => {
    vi.useFakeTimers();
    loadSettingsMock.mockReturnValue({
      imageGeneration: {
        defaultModel: "gpt-image-2",
        timeouts: { azure: 45 },
      },
      azure: {
        apiKey: "azure-key",
        endpoint: "https://example.openai.azure.com",
        deployments: ["gpt-image-2", "gpt-image-1.5"],
      },
    });
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (String(url).includes("gpt-image-2")) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })),
            { once: true },
          );
        });
      }
      return Promise.resolve({
        ok: true,
        json: vi.fn().mockResolvedValue({
          data: [{ b64_json: Buffer.from("fallback-image").toString("base64") }],
        }),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const generator = new ImageGenerator({ path: tempDir } as Any);
    const progress: Any[] = [];
    const resultPromise = generator.generate({
      prompt: "snow leopard avatar",
      onProgress: (event) => progress.push(event),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("gpt-image-2");
    await vi.advanceTimersByTimeAsync(44_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("gpt-image-1.5");
    expect(progress.some((event) => event.type === "image_generation_fallback")).toBe(true);
    vi.useRealTimers();
  });

  it("falls back from gpt-image-2 to gpt-image-1.5 on transient fetch failure", async () => {
    loadSettingsMock.mockReturnValue({
      imageGeneration: {
        defaultModel: "gpt-image-2",
        timeouts: { azure: 300 },
      },
      azure: {
        apiKey: "azure-key",
        endpoint: "https://example.openai.azure.com",
        deployments: ["gpt-image-2", "gpt-image-1.5"],
      },
    });
    const fetchMock = vi.fn((url: string) => {
      if (String(url).includes("gpt-image-2")) {
        return Promise.reject(
          Object.assign(new TypeError("fetch failed"), {
            cause: { code: "UND_ERR_SOCKET", message: "other side closed" },
          }),
        );
      }
      return Promise.resolve({
        ok: true,
        json: vi.fn().mockResolvedValue({
          data: [{ b64_json: Buffer.from("fallback-image").toString("base64") }],
        }),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const generator = new ImageGenerator({ path: tempDir } as Any);
    const progress: Any[] = [];
    const result = await generator.generate({
      prompt: "snow leopard avatar",
      onProgress: (event) => progress.push(event),
    });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("gpt-image-2");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("gpt-image-1.5");
    expect(
      progress.some(
        (event) =>
          event.type === "image_generation_fallback" &&
          String(event.message).includes("transient provider error"),
      ),
    ).toBe(true);
  });

  it("passes the abort signal into Azure image fetches", async () => {
    loadSettingsMock.mockReturnValue({
      imageGeneration: {
        defaultModel: "gpt-image-2",
      },
      azure: {
        apiKey: "azure-key",
        endpoint: "https://example.openai.azure.com",
        deployments: ["gpt-image-2"],
      },
    });
    let capturedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          capturedSignal = init?.signal || undefined;
          capturedSignal?.addEventListener(
            "abort",
            () =>
              reject(
                Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
              ),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    const generator = new ImageGenerator({ path: tempDir } as Any);
    const promise = generator.generate({
      prompt: "snow leopard avatar",
      signal: controller.signal,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(capturedSignal?.aborted).toBe(false);
    controller.abort();

    const result = await promise;
    expect(result.success).toBe(false);
    expect(capturedSignal?.aborted).toBe(true);
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });
});
