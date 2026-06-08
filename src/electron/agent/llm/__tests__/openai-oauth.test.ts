import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAIOAuth, type OpenAIOAuthTokens } from "../openai-oauth";

const refreshOpenAICodexTokenMock = vi.fn();

vi.mock("../pi-ai-loader", () => ({
  loadPiAiOAuthModule: vi.fn().mockResolvedValue({
    refreshOpenAICodexToken: (...args: Any[]) => refreshOpenAICodexTokenMock(...args),
  }),
}));

function makeTokens(overrides: Partial<OpenAIOAuthTokens> = {}): OpenAIOAuthTokens {
  return {
    access_token: "old-access",
    refresh_token: "old-refresh",
    expires_at: Date.now() + 10 * 60_000,
    ...overrides,
  };
}

describe("OpenAIOAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the stored ChatGPT access token while it is still valid", async () => {
    const result = await OpenAIOAuth.getApiKeyFromTokens(makeTokens());

    expect(result).toEqual({ apiKey: "old-access" });
    expect(refreshOpenAICodexTokenMock).not.toHaveBeenCalled();
  });

  it("refreshes expired ChatGPT OAuth tokens directly and preserves refreshed credentials", async () => {
    refreshOpenAICodexTokenMock.mockResolvedValue({
      access: "new-access",
      refresh: "new-refresh",
      expires: Date.now() + 120_000,
      email: "user@example.com",
    });

    const result = await OpenAIOAuth.getApiKeyFromTokens(
      makeTokens({ expires_at: Date.now() - 1_000 }),
    );

    expect(refreshOpenAICodexTokenMock).toHaveBeenCalledWith("old-refresh");
    expect(result.apiKey).toBe("new-access");
    expect(result.newTokens).toMatchObject({
      access_token: "new-access",
      refresh_token: "new-refresh",
      email: "user@example.com",
    });
  });

  it("keeps direct refresh error details for retry classification and user diagnostics", async () => {
    refreshOpenAICodexTokenMock.mockRejectedValue(
      new Error("OpenAI Codex token refresh error: fetch failed"),
    );

    await expect(
      OpenAIOAuth.getApiKeyFromTokens(makeTokens({ expires_at: Date.now() - 1_000 })),
    ).rejects.toThrow("OpenAI Codex token refresh error: fetch failed");
  });
});
