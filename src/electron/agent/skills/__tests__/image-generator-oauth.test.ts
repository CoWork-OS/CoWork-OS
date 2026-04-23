import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadSettingsMock = vi.fn();
const saveSettingsMock = vi.fn();
const clearCacheMock = vi.fn();
const getApiKeyFromTokensMock = vi.fn();
const loadPiAiModuleMock = vi.fn();

let openAIConfigs: Any[] = [];
let responseStreamParams: Any[] = [];
let streamFactory: () => Any;

vi.mock("../../llm/provider-factory", () => ({
  LLMProviderFactory: {
    loadSettings: (...args: Any[]) => loadSettingsMock(...args),
    saveSettings: (...args: Any[]) => saveSettingsMock(...args),
    clearCache: (...args: Any[]) => clearCacheMock(...args),
  },
}));

vi.mock("../../llm/openai-oauth", () => ({
  OpenAIOAuth: {
    getApiKeyFromTokens: (...args: Any[]) => getApiKeyFromTokensMock(...args),
  },
}));

vi.mock("../../llm/pi-ai-loader", () => ({
  loadPiAiModule: (...args: Any[]) => loadPiAiModuleMock(...args),
}));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    responses = {
      stream: (params: Any) => {
        responseStreamParams.push(params);
        return streamFactory();
      },
    };

    constructor(config: Any) {
      openAIConfigs.push(config);
    }
  },
}));

import { ImageGenerator } from "../image-generator";

function createAccessToken(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url");
  return `${header}.${payload}.signature`;
}

describe("ImageGenerator OpenAI OAuth", () => {
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    openAIConfigs = [];
    responseStreamParams = [];
    streamFactory = () => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: "response.output_item.done",
          item: {
            type: "image_generation_call",
            result: Buffer.from("oauth-image").toString("base64"),
          },
        };
      },
      finalResponse: vi.fn().mockResolvedValue({ output: [] }),
    });
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-image-oauth-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("treats OpenAI OAuth as an available image provider", () => {
    loadSettingsMock.mockReturnValue({
      openai: {
        accessToken: "oauth-access-token",
        refreshToken: "oauth-refresh-token",
        authMethod: "oauth",
      },
    } as Any);

    expect(ImageGenerator.isAvailable()).toBe(true);
  });

  it("generates images through the Codex/ChatGPT Responses backend", async () => {
    const refreshedAccessToken = createAccessToken("acct_test_oauth");
    loadSettingsMock.mockReturnValue({
      providerType: "openai",
      openai: {
        accessToken: "stale-access-token",
        refreshToken: "oauth-refresh-token",
        tokenExpiresAt: 0,
        authMethod: "oauth",
      },
    } as Any);
    getApiKeyFromTokensMock.mockResolvedValue({
      apiKey: "derived-api-key",
      newTokens: {
        access_token: refreshedAccessToken,
        refresh_token: "oauth-refresh-token-2",
        expires_at: 123456789,
      },
    });
    loadPiAiModuleMock.mockResolvedValue({
      getModels: () => [{ id: "gpt-5.2" }],
    });

    const generator = new ImageGenerator({ path: tempDir } as Any);
    const result = await generator.generate({
      prompt: "draw a poster of a lighthouse in fog",
      provider: "openai-codex",
      model: "gpt-image-1.5",
      filename: "poster",
      imageSize: "1K",
    });

    expect(result.success).toBe(true);
    expect(result.provider).toBe("openai-codex");
    expect(result.model).toBe("gpt-image-1.5");
    expect(result.images).toHaveLength(1);
    expect(fs.readFileSync(path.join(tempDir, "poster.png")).toString()).toBe("oauth-image");

    expect(openAIConfigs[0]).toMatchObject({
      apiKey: "derived-api-key",
      baseURL: "https://chatgpt.com/backend-api/codex",
      defaultHeaders: expect.objectContaining({
        "chatgpt-account-id": "acct_test_oauth",
        "OpenAI-Beta": "responses=experimental",
        originator: "cowork-os",
      }),
    });

    expect(responseStreamParams[0]).toMatchObject({
      model: "gpt-5.2",
      instructions:
        "You are an assistant that must fulfill image generation requests by using the image_generation tool when provided.",
      tools: [
        expect.objectContaining({
          type: "image_generation",
          model: "gpt-image-1.5",
          action: "generate",
          output_format: "png",
        }),
      ],
    });
    expect(responseStreamParams[0].tools[0]).not.toHaveProperty("quality");

    expect(saveSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        openai: expect.objectContaining({
          accessToken: refreshedAccessToken,
          refreshToken: "oauth-refresh-token-2",
          tokenExpiresAt: 123456789,
          authMethod: "oauth",
        }),
      }),
    );
    expect(clearCacheMock).toHaveBeenCalled();
  });

  it("removes already-written OAuth images when a later image fails", async () => {
    const accessToken = createAccessToken("acct_test_oauth");
    let calls = 0;
    streamFactory = () => {
      calls += 1;
      const call = calls;
      return {
        async *[Symbol.asyncIterator]() {
          if (call === 1) {
            yield {
              type: "response.output_item.done",
              item: {
                type: "image_generation_call",
                result: Buffer.from("first-image").toString("base64"),
              },
            };
          }
        },
        finalResponse: vi.fn().mockResolvedValue({ output: [] }),
      };
    };
    loadSettingsMock.mockReturnValue({
      providerType: "openai",
      openai: {
        accessToken,
        tokenExpiresAt: Date.now() + 60_000,
        authMethod: "oauth",
      },
    } as Any);
    loadPiAiModuleMock.mockResolvedValue({
      getModels: () => [{ id: "gpt-5.2" }],
    });

    const generator = new ImageGenerator({ path: tempDir } as Any);
    const result = await generator.generate({
      prompt: "draw two posters",
      provider: "openai-codex",
      model: "gpt-image-1.5",
      filename: "poster",
      imageSize: "1K",
      numberOfImages: 2,
    });

    expect(result.success).toBe(false);
    expect(fs.existsSync(path.join(tempDir, "poster_1.png"))).toBe(false);
    expect(fs.existsSync(path.join(tempDir, "poster_2.png"))).toBe(false);
  });
});
