import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMProviderFactory } from "../../../electron/agent/llm";
import { MCPSettingsManager } from "../../../electron/mcp/settings";
import { PermissionSettingsManager } from "../../../electron/security/permission-settings-manager";
import { createBrowserSettingsDefinitions } from "../browser-settings-methods";

const context = {} as never;

function call(name: string, args: unknown[] = []) {
  const method = createBrowserSettingsDefinitions()[name];
  if (!method) throw new Error(`Missing method ${name}`);
  return method.handler(args, context);
}

afterEach(() => vi.restoreAllMocks());

describe("browser Settings definitions", () => {
  it("redacts saved provider credentials while retaining presence flags", async () => {
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "openai",
      modelKey: "gpt-4o",
      openai: { apiKey: "sk-live-secret", accessToken: "oauth-secret", authMethod: "oauth" },
      openaiCompatible: {
        baseUrl:
          "http://127.0.0.1:7788/v1?tenant=team&api_key=query-api-secret&key=query-key-secret&token=query-token-secret&access_token=query-access-secret&authorization=query-auth-secret&password=query-password-secret&X-Client-Secret=query-client-secret&view=compact",
      },
      customProviders: {
        "custom-test": {
          apiKey: "custom-secret",
          baseUrl: "https://models.example/v1?access_token=query-access-secret&region=eu",
        },
      },
    } as never);

    const settings = (await call("getLLMSettings")) as {
      openai: Record<string, unknown>;
      openaiCompatible: Record<string, unknown>;
      customProviders: Record<string, Record<string, unknown>>;
    };

    expect(settings.openai).not.toHaveProperty("apiKey");
    expect(settings.openai).not.toHaveProperty("accessToken");
    expect(settings.openai.apiKeyConfigured).toBe(true);
    expect(settings.openai.accessTokenConfigured).toBe(true);
    expect(settings.openaiCompatible.baseUrl).toBe(
      "http://127.0.0.1:7788/v1?tenant=team&view=compact",
    );
    expect(settings.customProviders["custom-test"]).not.toHaveProperty("apiKey");
    expect(settings.customProviders["custom-test"].baseUrl).toBe(
      "https://models.example/v1?region=eu",
    );
    expect(JSON.stringify(settings)).not.toContain("secret");
  });

  it("preserves blank and omitted credentials on save while accepting explicit replacements", async () => {
    const old = {
      providerType: "openai",
      modelKey: "gpt-4o",
      openai: {
        apiKey: "sk-existing",
        accessToken: "oauth-existing",
        refreshToken: "refresh-existing",
        authMethod: "oauth",
      },
      cachedOpenAIModels: [{ key: "gpt-4o", displayName: "GPT-4o", description: "cached" }],
    };
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue(old as never);
    const save = vi.spyOn(LLMProviderFactory, "saveSettings").mockImplementation(() => undefined);

    await call("saveLLMSettings", [
      { providerType: "openai", modelKey: "gpt-4o", openai: { apiKey: "" } },
    ]);
    const blankSaved = save.mock.calls[0][0] as {
      openai?: { apiKey?: string; accessToken?: string; refreshToken?: string };
      cachedOpenAIModels?: unknown[];
    };
    expect(blankSaved.openai.apiKey).toBe("sk-existing");
    expect(blankSaved.openai.accessToken).toBe("oauth-existing");
    expect(blankSaved.openai.refreshToken).toBe("refresh-existing");
    expect(blankSaved.cachedOpenAIModels).toEqual(old.cachedOpenAIModels);

    save.mockClear();
    await call("saveLLMSettings", [
      { providerType: "openai", modelKey: "gpt-4o", openai: { apiKey: "sk-replacement" } },
    ]);
    expect((save.mock.calls[0][0] as { openai?: { apiKey?: string } }).openai?.apiKey).toBe(
      "sk-replacement",
    );
  });

  it("restores hidden URL credentials only when saving the same redacted URL target", async () => {
    const old = {
      providerType: "openai-compatible",
      modelKey: "local-model",
      openaiCompatible: {
        baseUrl: "http://127.0.0.1:7788/v1?tenant=team&api_key=saved-url-key&mode=chat",
      },
      customProviders: {
        local: {
          baseUrl: "http://localhost:8899/v1?tenant=dev&client_secret=saved-client-secret",
        },
      },
    };
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue(old as never);
    const save = vi.spyOn(LLMProviderFactory, "saveSettings").mockImplementation(() => undefined);

    await call("saveLLMSettings", [
      {
        providerType: "openai-compatible",
        modelKey: "local-model",
        openaiCompatible: { baseUrl: "http://127.0.0.1:7788/v1?tenant=team&mode=chat" },
        customProviders: { local: { baseUrl: "http://localhost:8899/v1?tenant=dev" } },
      },
    ]);

    const saved = save.mock.calls[0][0] as typeof old;
    expect(saved.openaiCompatible.baseUrl).toBe(
      "http://127.0.0.1:7788/v1?tenant=team&mode=chat&api_key=saved-url-key",
    );
    expect(saved.customProviders.local.baseUrl).toBe(
      "http://localhost:8899/v1?tenant=dev&client_secret=saved-client-secret",
    );

    save.mockClear();
    await call("saveLLMSettings", [
      {
        providerType: "openai-compatible",
        modelKey: "local-model",
        openaiCompatible: { baseUrl: "http://127.0.0.1:7788/other?tenant=team&mode=chat" },
        customProviders: { local: { baseUrl: "http://localhost:8899/other?tenant=dev" } },
      },
    ]);
    const changed = save.mock.calls[0][0] as typeof old;
    expect(changed.openaiCompatible.baseUrl).toBe(
      "http://127.0.0.1:7788/other?tenant=team&mode=chat",
    );
    expect(changed.customProviders.local.baseUrl).toBe("http://localhost:8899/other?tenant=dev");
  });

  it("rejects new provider URLs with credential query parameters", async () => {
    const save = vi.spyOn(LLMProviderFactory, "saveSettings").mockImplementation(() => undefined);

    await expect(
      call("saveLLMSettings", [
        {
          providerType: "openai-compatible",
          modelKey: "local-model",
          openaiCompatible: {
            baseUrl: "http://127.0.0.1:7788/v1?tenant=team&client_secret=must-not-save",
          },
        },
      ]),
    ).rejects.toThrow(/credentials in query parameters/i);
    expect(save).not.toHaveBeenCalled();
  });

  it("uses hidden saved URL credentials for provider tests only at the same target", async () => {
    const old = {
      providerType: "openai-compatible",
      modelKey: "local-model",
      openaiCompatible: {
        baseUrl: "http://127.0.0.1:7788/v1?tenant=team&api_key=saved-url-key",
      },
    };
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue(old as never);
    vi.spyOn(LLMProviderFactory, "getModelId").mockReturnValue("local-model" as never);
    const testProvider = vi
      .spyOn(LLMProviderFactory, "testProvider")
      .mockResolvedValue({ success: true });

    await call("testLLMProvider", [
      {
        providerType: "openai-compatible",
        modelKey: "local-model",
        openaiCompatible: { baseUrl: "http://127.0.0.1:7788/v1?tenant=team" },
      },
    ]);
    expect(testProvider.mock.calls[0][0].openaiCompatibleBaseUrl).toBe(
      "http://127.0.0.1:7788/v1?tenant=team&api_key=saved-url-key",
    );

    testProvider.mockClear();
    await call("testLLMProvider", [
      {
        providerType: "openai-compatible",
        modelKey: "local-model",
        openaiCompatible: { baseUrl: "http://127.0.0.1:7788/other?tenant=team" },
      },
    ]);
    expect(testProvider.mock.calls[0][0].openaiCompatibleBaseUrl).toBe(
      "http://127.0.0.1:7788/other?tenant=team",
    );
  });

  it("blocks provider model discovery against private hosts", async () => {
    const listModels = vi
      .spyOn(LLMProviderFactory, "getOpenRouterModels")
      .mockResolvedValue([] as never);

    await expect(call("getOpenRouterModels", ["", "http://10.2.3.4/v1"])).rejects.toThrow(
      /private or metadata/,
    );
    expect(listModels).not.toHaveBeenCalled();
  });

  it("scrubs unsaved API keys from provider results and the persisted model cache", async () => {
    vi.spyOn(LLMProviderFactory, "getOpenAIModels").mockResolvedValue([
      { id: "sk-temporary-secret", name: "Echoed key", description: "provider response" },
    ] as never);
    const cache = vi
      .spyOn(LLMProviderFactory, "saveCachedModels")
      .mockImplementation(() => undefined);

    const models = await call("getOpenAIModels", ["sk-temporary-secret"]);

    expect(JSON.stringify(models)).not.toContain("sk-temporary-secret");
    expect(JSON.stringify(cache.mock.calls[0][1])).not.toContain("sk-temporary-secret");
  });

  it("keeps AgentHub bootstrap reads narrow and free of MCP commands and credentials", async () => {
    vi.spyOn(PermissionSettingsManager, "loadSettings").mockReturnValue({
      defaultAccessProfileId: "ask_for_approval",
      accessProfiles: [
        {
          id: "team",
          label: "Team",
          description: "safe",
          sandbox: "workspace-write",
          approval: "on-request",
          reviewer: "user",
          network: "on-request",
          workspaceRoots: ["/private/root"],
        },
      ],
      rules: [{ id: "rule", path: "/private/rule" }],
    } as never);
    vi.spyOn(MCPSettingsManager, "getSettingsForDisplay").mockReturnValue({
      storageStatus: "ok",
      servers: [
        {
          id: "server-1",
          name: "Search",
          description: "safe",
          enabled: true,
          transport: "stdio",
          command: "secret-command",
          args: ["private"],
          env: { TOKEN: "mcp-secret" },
          auth: { type: "bearer", token: "masked-secret" },
        },
      ],
    } as never);

    const permissions = (await call("getPermissionSettings")) as {
      defaultAccessProfileId: string;
      accessProfiles: Array<Record<string, unknown>>;
    };
    const mcp = (await call("getMCPSettings")) as {
      servers: Array<Record<string, unknown>>;
    };

    expect(permissions).toEqual({
      defaultAccessProfileId: "ask_for_approval",
      accessProfiles: [
        {
          id: "team",
          label: "Team",
          description: "safe",
          sandbox: "workspace-write",
          approval: "on-request",
          reviewer: "user",
          network: "on-request",
        },
      ],
    });
    expect(mcp.servers).toEqual([
      {
        id: "server-1",
        name: "Search",
        description: "safe",
        enabled: true,
        transport: "stdio",
        registryId: undefined,
      },
    ]);
    expect(JSON.stringify(mcp)).not.toContain("mcp-secret");
    expect(JSON.stringify(permissions)).not.toContain("/private/root");
    expect(mcp.servers[0]).not.toHaveProperty("command");
    expect(mcp.servers[0]).not.toHaveProperty("env");
  });
});
