import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../../../shared/types";
import { ImageGenerator, type ImageGenerationResult } from "../../skills/image-generator";
import { ImageTools } from "../image-tools";

describe("ImageTools", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const workspace = (): Workspace =>
    ({
      id: "workspace-1",
      name: "workspace",
      path: "/tmp",
      permissions: { read: true, write: true, allowedPaths: [] },
    }) as unknown as Workspace;

  const generatedResult = (): ImageGenerationResult => ({
    success: true,
    images: [
      {
        path: "/tmp/snow-leopard.png",
        filename: "snow-leopard.png",
        mimeType: "image/png",
        size: 1024,
      },
    ],
    provider: "openai",
    model: "gpt-image-1.5",
  });

  it("blocks an identical second image generation request in the same task", async () => {
    const generateSpy = vi
      .spyOn(ImageGenerator.prototype, "generate")
      .mockResolvedValue(generatedResult());
    const daemon = { logEvent: vi.fn() };
    const tools = new ImageTools(workspace(), daemon as Any, "task-1");

    const first = await tools.generateImage({ prompt: "snow leopard avatar" });
    const second = await tools.generateImage({ prompt: "snow leopard avatar" });

    expect(first.success).toBe(true);
    expect(second.success).toBe(false);
    expect(second.error).toContain("same request");
    expect(generateSpy).toHaveBeenCalledTimes(1);
  });

  it("blocks identical duplicate calls while the first generation is still in flight", async () => {
    let resolveGenerate!: (value: ImageGenerationResult) => void;
    const generateSpy = vi.spyOn(ImageGenerator.prototype, "generate").mockImplementation(
      () =>
        new Promise<ImageGenerationResult>((resolve) => {
          resolveGenerate = resolve;
        }),
    );
    const daemon = { logEvent: vi.fn() };
    const tools = new ImageTools(workspace(), daemon as Any, "task-1");

    const firstPromise = tools.generateImage({ prompt: "snow leopard avatar" });
    const second = await tools.generateImage({ prompt: "snow leopard avatar" });
    resolveGenerate(generatedResult());
    const first = await firstPromise;

    expect(first.success).toBe(true);
    expect(second.success).toBe(false);
    expect(second.error).toContain("same request");
    expect(generateSpy).toHaveBeenCalledTimes(1);
  });

  it("allows distinct image prompts in the same task", async () => {
    const generateSpy = vi
      .spyOn(ImageGenerator.prototype, "generate")
      .mockResolvedValue(generatedResult());
    const daemon = { logEvent: vi.fn() };
    const tools = new ImageTools(workspace(), daemon as Any, "task-1");

    const first = await tools.generateImage({ prompt: "snow leopard avatar" });
    const second = await tools.generateImage({ prompt: "wide aurora hero image" });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(generateSpy).toHaveBeenCalledTimes(2);
  });

  it("passes the executor abort signal into image generation", async () => {
    const generateSpy = vi
      .spyOn(ImageGenerator.prototype, "generate")
      .mockResolvedValue(generatedResult());
    const daemon = { logEvent: vi.fn() };
    const tools = new ImageTools(workspace(), daemon as Any, "task-1");
    const controller = new AbortController();

    await tools.generateImage({ prompt: "snow leopard avatar" }, { signal: controller.signal });

    expect(generateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "snow leopard avatar",
        signal: controller.signal,
      }),
    );
  });
});
