import { beforeEach, describe, expect, it, vi } from "vitest";
import { XSearchTools } from "../x-search-tools";
import { LLMProviderFactory } from "../../llm/provider-factory";

const xaiOAuthMocks = vi.hoisted(() => ({
  refreshTokens: vi.fn(),
  isExpiring: vi.fn(() => false),
}));

vi.mock("../../llm/provider-factory", () => ({
  LLMProviderFactory: {
    loadSettings: vi.fn(),
    saveSettings: vi.fn(),
    clearCache: vi.fn(),
  },
}));

vi.mock("../../llm/xai-oauth", () => ({
  DEFAULT_XAI_OAUTH_BASE_URL: "https://api.x.ai/v1",
  XAIOAuth: {
    refreshTokens: (...args: Any[]) => xaiOAuthMocks.refreshTokens(...args),
  },
  isXAIAccessTokenExpiring: (...args: Any[]) => xaiOAuthMocks.isExpiring(...args),
}));

const workspace = {
  id: "workspace-1",
  name: "Workspace",
  path: "/workspace",
  permissions: { shell: false },
  createdAt: new Date().toISOString(),
  lastAccessed: new Date().toISOString(),
} as Any;

const daemon = {
  logEvent: vi.fn(),
} as Any;

function setSettings(settings: Any): void {
  vi.mocked(LLMProviderFactory.loadSettings).mockReturnValue(settings);
}

describe("XSearchTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    setSettings({ providerType: "xai", modelKey: "grok-4.3", xai: {} });
    global.fetch = vi.fn() as Any;
    xaiOAuthMocks.isExpiring.mockReturnValue(false);
  });

  it("detects xAI credentials from settings or environment", () => {
    expect(XSearchTools.hasCredentials()).toBe(false);

    setSettings({ providerType: "xai", modelKey: "grok-4.3", xai: { apiKey: "xai-key" } });
    expect(XSearchTools.hasCredentials()).toBe(true);

    setSettings({
      providerType: "xai-oauth",
      modelKey: "grok-4.3",
      xai: { accessToken: "access", refreshToken: "refresh" },
    });
    expect(XSearchTools.hasCredentials()).toBe(true);

    setSettings({ providerType: "xai", modelKey: "grok-4.3", xai: {} });
    vi.stubEnv("XAI_API_KEY", "env-key");
    expect(XSearchTools.hasCredentials()).toBe(true);
  });

  it("blocks X search before resolving credentials when networking is disabled", async () => {
    const tools = new XSearchTools(
      {
        ...workspace,
        permissions: { shell: false, network: false, accessNetworkMode: "disabled" },
      },
      daemon,
      "task-1",
    );

    const result = await tools.search({ query: "should not leave the workspace" });

    expect(result.success).toBe(false);
    expect(result.error_type).toBe("NetworkPolicyError");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("blocks the xAI endpoint when a custom profile denies its domain", async () => {
    setSettings({
      providerType: "xai",
      modelKey: "grok-4.3",
      xai: { apiKey: "xai-key" },
    });
    const tools = new XSearchTools(
      {
        ...workspace,
        permissions: {
          shell: false,
          network: true,
          accessDomainRules: [{ pattern: "api.x.ai", access: "deny" }],
        },
      },
      daemon,
      "task-1",
    );

    const result = await tools.search({ query: "should not leave the workspace" });

    expect(result.success).toBe(false);
    expect(result.error_type).toBe("NetworkPolicyError");
    expect(result.policyReason).toBe("profile_domain_denied");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("calls the xAI Responses API with the built-in x_search tool", async () => {
    setSettings({
      providerType: "xai",
      modelKey: "grok-4.3",
      xai: { apiKey: "xai-key", baseUrl: "https://api.x.ai/v1/" },
    });
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          output_text: "Answer",
          citations: [{ url: "https://x.com/a/status/1", title: "Post" }],
        }),
        { status: 200 },
      ),
    );

    const tools = new XSearchTools(workspace, daemon, "task-1");
    const result = await tools.search({
      query: "latest agent reactions",
      allowed_x_handles: ["@nousresearch"],
      from_date: "2026-05-16",
      enable_image_understanding: true,
    });

    expect(result.success).toBe(true);
    expect(result.answer).toBe("Answer");
    expect(result.credential_source).toBe("xai");
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.x.ai/v1/responses",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer xai-key" }),
      }),
    );
    const body = JSON.parse(String(vi.mocked(global.fetch).mock.calls[0][1]?.body));
    expect(body.store).toBe(false);
    expect(body.tools).toEqual([
      {
        type: "x_search",
        allowed_x_handles: ["nousresearch"],
        from_date: "2026-05-16",
        enable_image_understanding: true,
      },
    ]);
  });

  it("rejects simultaneous allowed and excluded handle filters", async () => {
    setSettings({ providerType: "xai", modelKey: "grok-4.3", xai: { apiKey: "xai-key" } });

    const tools = new XSearchTools(workspace, daemon, "task-1");
    const result = await tools.search({
      query: "test",
      allowed_x_handles: ["a"],
      excluded_x_handles: ["b"],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("cannot be used together");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("prefers OAuth credentials and refreshes an expiring access token", async () => {
    setSettings({
      providerType: "xai-oauth",
      modelKey: "grok-4.3",
      xai: {
        accessToken: "old-access",
        refreshToken: "refresh",
        tokenExpiresAt: Date.now() - 1,
      },
    });
    xaiOAuthMocks.isExpiring.mockReturnValue(true);
    xaiOAuthMocks.refreshTokens.mockResolvedValue({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_at: Date.now() + 60_000,
      token_endpoint: "https://auth.x.ai/token",
    });
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(JSON.stringify({ output_text: "OAuth answer" }), { status: 200 }),
    );

    const tools = new XSearchTools(workspace, daemon, "task-1");
    const result = await tools.search({ query: "test" });

    expect(result.success).toBe(true);
    expect(result.credential_source).toBe("xai-oauth");
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.x.ai/v1/responses",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer new-access" }),
      }),
    );
    expect(LLMProviderFactory.saveSettings).toHaveBeenCalled();
    expect(LLMProviderFactory.clearCache).toHaveBeenCalled();
  });
});
