import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Workspace } from "../../../../shared/types";
import { LLMProviderFactory } from "../../llm/provider-factory";
import { ImageGenerator } from "../image-generator";

describe("ImageGenerator OpenRouter image API", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    const directories = temporaryDirectories.splice(0);
    await Promise.all(
      directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses the dedicated API and sends only parameters supported by Muse Image", async () => {
    const outputDir = await mkdtemp("/tmp/cowork-image-");
    temporaryDirectories.push(outputDir);
    const png = Buffer.from("png").toString("base64");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          data: [
            {
              id: "meta/muse-image",
              supported_parameters: {},
              endpoints: "/api/v1/images/models/meta/muse-image/endpoints",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          data: [],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          data: [{ b64_json: png }],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "openrouter",
      modelKey: "meta/muse-image",
      openrouter: {
        apiKey: "test-key",
        baseUrl: "https://openrouter.example/api/v1",
      },
      imageGeneration: {
        openrouter: { model: "meta/muse-image" },
      },
    } as Any);

    const result = await new ImageGenerator({
      path: outputDir,
      permissions: { read: true, write: true, allowedPaths: [] },
    } as Workspace).generate({
      prompt: "a paper boat",
      provider: "openrouter",
      model: "meta/muse-image",
      imageSize: "2K",
      numberOfImages: 4,
    });

    expect(result.success).toBe(true);
    expect(result.images[0]?.mimeType).toBe("image/png");
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://openrouter.example/api/v1/images/models/meta/muse-image/endpoints",
      expect.anything(),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://openrouter.example/api/v1/images",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ model: "meta/muse-image", prompt: "a paper boat" }),
      }),
    );
  });

  it("maps supported resolution/count capabilities and preserves vector media types", async () => {
    const outputDir = await mkdtemp("/tmp/cowork-image-");
    temporaryDirectories.push(outputDir);
    const svg = Buffer.from("<svg/>").toString("base64");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          data: [
            {
              id: "recraft/recraft-v4-vector",
              supported_parameters: {
                resolution: { type: "enum", values: ["1K", "2K"] },
                n: { type: "range", min: 1, max: 2 },
              },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          data: [
            {
              provider_tag: "recraft",
              supported_parameters: {
                resolution: { type: "enum", values: ["1K", "2K"] },
                n: { type: "range", min: 1, max: 2 },
              },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          data: [
            { b64_json: svg, media_type: "image/svg+xml" },
            { b64_json: svg, media_type: "image/svg+xml" },
          ],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "openrouter",
      modelKey: "recraft/recraft-v4-vector",
      openrouter: { apiKey: "test-key", baseUrl: "https://vector.example/api/v1" },
      imageGeneration: {
        openrouter: { model: "recraft/recraft-v4-vector" },
      },
    } as Any);

    const result = await new ImageGenerator({
      path: outputDir,
      permissions: { read: true, write: true, allowedPaths: [] },
    } as Workspace).generate({
      prompt: "a vector sailboat logo",
      provider: "openrouter",
      model: "recraft/recraft-v4-vector",
      imageSize: "2K",
      numberOfImages: 4,
    });

    const request = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(request).toMatchObject({
      model: "recraft/recraft-v4-vector",
      prompt: "a vector sailboat logo",
      resolution: "2K",
      n: 2,
    });
    expect(result.images).toHaveLength(2);
    expect(result.images[0]?.filename).toMatch(/\.svg$/);
    expect(result.images[0]?.mimeType).toBe("image/svg+xml");
  });

  it("passes supported options and workspace-safe reference images to one endpoint", async () => {
    const outputDir = await mkdtemp("/tmp/cowork-image-");
    temporaryDirectories.push(outputDir);
    await writeFile(`${outputDir}/reference.png`, Buffer.from("reference"));
    const png = Buffer.from("png").toString("base64");
    const supportedParameters = {
      input_references: { type: "range", min: 1, max: 2 },
      aspect_ratio: { type: "enum", values: ["1:1", "16:9"] },
      quality: { type: "enum", values: ["high"] },
      output_format: { type: "enum", values: ["png"] },
      output_compression: { type: "range", min: 0, max: 100 },
      seed: { type: "range", min: 0, max: 1000 },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          data: [{ id: "meta/muse-image", supported_parameters: supportedParameters }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          data: [{ provider_tag: "meta", supported_parameters: supportedParameters }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ data: [{ b64_json: png }] }),
      });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "openrouter",
      openrouter: { apiKey: "test-key", baseUrl: "https://options.example/api/v1" },
      imageGeneration: { openrouter: { model: "meta/muse-image" } },
    } as Any);

    const result = await new ImageGenerator({
      path: outputDir,
      permissions: { read: true, write: true, allowedPaths: [] },
    } as Workspace).generate({
      prompt: "a paper boat",
      provider: "openrouter",
      model: "meta/muse-image",
      filename: "../../outside",
      aspectRatio: "16:9",
      quality: "high",
      outputFormat: "png",
      outputCompression: 80,
      seed: 42,
      referenceImages: ["reference.png"],
    });

    expect(result.success).toBe(true);
    expect(result.images[0]?.path.startsWith(outputDir)).toBe(true);
    const request = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(request).toMatchObject({
      model: "meta/muse-image",
      aspect_ratio: "16:9",
      quality: "high",
      output_format: "png",
      output_compression: 80,
      seed: 42,
      provider: { only: ["meta"], allow_fallbacks: false },
    });
    expect(request.input_references[0]).toEqual({
      type: "image_url",
      image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) },
    });
  });

  it("rejects references outside the workspace before generation", async () => {
    const outputDir = await mkdtemp("/tmp/cowork-image-");
    temporaryDirectories.push(outputDir);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          data: [
            {
              id: "meta/muse-image",
              supported_parameters: { input_references: { type: "range", min: 1, max: 2 } },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          data: [{ supported_parameters: { input_references: { type: "range", min: 1, max: 2 } } }],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "openrouter",
      openrouter: { apiKey: "test-key", baseUrl: "https://outside.example/api/v1" },
      imageGeneration: { openrouter: { model: "meta/muse-image" } },
    } as Any);

    const result = await new ImageGenerator({
      path: outputDir,
      permissions: { read: true, write: true, allowedPaths: [] },
    } as Workspace).generate({
      prompt: "a paper boat",
      provider: "openrouter",
      model: "meta/muse-image",
      referenceImages: ["/tmp/not-a-workspace-reference.png"],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Reference image was not found");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("allows remote references without local read permission and honors an unavailable provider tag", async () => {
    const outputDir = await mkdtemp("/tmp/cowork-image-");
    temporaryDirectories.push(outputDir);
    const png = Buffer.from("png").toString("base64");
    const supportedParameters = { input_references: { type: "range", min: 1, max: 2 } };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          data: [{ id: "meta/muse-image", supported_parameters: supportedParameters }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          data: [{ provider_tag: null, provider_slug: "meta", supported_parameters: supportedParameters }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ data: [{ b64_json: png }] }),
      });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "openrouter",
      openrouter: { apiKey: "test-key", baseUrl: "https://remote-reference.example/api/v1" },
      imageGeneration: { openrouter: { model: "meta/muse-image" } },
    } as Any);

    const result = await new ImageGenerator({
      path: outputDir,
      permissions: { read: false, write: true, allowedPaths: [] },
    } as Workspace).generate({
      prompt: "a paper boat",
      provider: "openrouter",
      model: "meta/muse-image",
      referenceImages: ["https://example.com/reference.png"],
    });

    expect(result.success).toBe(true);
    const request = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(request.provider).toBeUndefined();
    expect(request.input_references).toEqual([
      { type: "image_url", image_url: { url: "https://example.com/reference.png" } },
    ]);
  });

  it("rejects oversized data URL references before generation", async () => {
    const outputDir = await mkdtemp("/tmp/cowork-image-");
    temporaryDirectories.push(outputDir);
    const supportedParameters = { input_references: { type: "range", min: 1, max: 2 } };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          data: [{ id: "meta/muse-image", supported_parameters: supportedParameters }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          data: [{ supported_parameters: supportedParameters }],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "openrouter",
      openrouter: { apiKey: "test-key", baseUrl: "https://oversized-reference.example/api/v1" },
      imageGeneration: { openrouter: { model: "meta/muse-image" } },
    } as Any);
    const oversizedDataUrl = `data:image/png;base64,${"A".repeat(
      Math.ceil((20 * 1024 * 1024 + 1) / 3) * 4,
    )}`;

    const result = await new ImageGenerator({
      path: outputDir,
      permissions: { read: false, write: true, allowedPaths: [] },
    } as Workspace).generate({
      prompt: "a paper boat",
      provider: "openrouter",
      model: "meta/muse-image",
      referenceImages: [oversizedDataUrl],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("valid non-empty image data");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back from a transient OpenRouter failure when provider selection is automatic", async () => {
    const outputDir = await mkdtemp("/tmp/cowork-image-");
    temporaryDirectories.push(outputDir);
    const png = Buffer.from("png").toString("base64");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          data: [{ id: "meta/muse-image", supported_parameters: {} }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ data: [] }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        text: vi.fn().mockResolvedValue("provider returned error"),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: png } }] } }],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "openrouter",
      openrouter: { apiKey: "test-key", baseUrl: "https://fallback.example/api/v1" },
      gemini: { apiKey: "gemini-key" },
      imageGeneration: {
        defaultProvider: "openrouter",
        backupProvider: "gemini",
        openrouter: { model: "meta/muse-image" },
      },
    } as Any);

    const result = await new ImageGenerator({
      path: outputDir,
      permissions: { read: true, write: true, allowedPaths: [] },
    } as Workspace).generate({
      prompt: "a paper boat",
      provider: "auto",
      model: "meta/muse-image",
    });

    expect(result.success).toBe(true);
    expect(result.provider).toBe("gemini");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not fall back and silently drop OpenRouter-specific options", async () => {
    const outputDir = await mkdtemp("/tmp/cowork-image-");
    temporaryDirectories.push(outputDir);
    const supportedParameters = { input_references: { type: "range", min: 1, max: 2 } };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          data: [{ id: "meta/muse-image", supported_parameters: supportedParameters }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          data: [{ provider_tag: "meta", supported_parameters: supportedParameters }],
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        text: vi.fn().mockResolvedValue("provider returned error"),
      });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "openrouter",
      openrouter: { apiKey: "test-key", baseUrl: "https://no-fallback.example/api/v1" },
      gemini: { apiKey: "gemini-key" },
      imageGeneration: {
        defaultProvider: "openrouter",
        backupProvider: "gemini",
        openrouter: { model: "meta/muse-image" },
      },
    } as Any);

    const result = await new ImageGenerator({
      path: outputDir,
      permissions: { read: false, write: true, allowedPaths: [] },
    } as Workspace).generate({
      prompt: "a paper boat",
      provider: "auto",
      model: "meta/muse-image",
      referenceImages: ["data:image/png;base64,cG5n"],
    });

    expect(result.success).toBe(false);
    expect(result.provider).toBe("openrouter");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
