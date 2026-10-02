import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LLMProviderFactory } from "../../../electron/agent/llm";
import { MCPSettingsManager } from "../../../electron/mcp/settings";
import { GuardrailManager } from "../../../electron/guardrails/guardrail-manager";
import { BuiltinToolsSettingsManager } from "../../../electron/agent/tools/builtin-settings";
import { RelationshipMemoryService } from "../../../electron/memory/RelationshipMemoryService";
import { UserProfileService } from "../../../electron/memory/UserProfileService";
import { PermissionSettingsManager } from "../../../electron/security/permission-settings-manager";
import { GoogleWorkspaceSettingsManager } from "../../../electron/settings/google-workspace-manager";
import { WebApplicationError } from "../../web/WebApplication";
import { createBrowserSettingsDefinitions } from "../browser-settings-methods";
import { createLLMSettingsPatch } from "../../../shared/host-api/llm-settings-patch";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

beforeEach(() => {
  vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
    providerType: "openai",
    modelKey: "gpt-4o",
  } as never);
});

const context = {} as never;

function call(name: string, args: unknown[] = []) {
  const method = createBrowserSettingsDefinitions()[name];
  if (!method) throw new Error(`Missing method ${name}`);
  return method.handler(method.validate?.(args) ?? args, context);
}

async function getProviderSettingsRevision(): Promise<string> {
  const snapshot = (await call("getLLMSettings")) as { revision: string };
  return snapshot.revision;
}

afterEach(() => vi.restoreAllMocks());

describe("browser Settings definitions", () => {
  it("validates portable built-in tool preferences and preserves storage failures", async () => {
    const settings = BuiltinToolsSettingsManager.getDefaultSettings();
    const save = vi.spyOn(BuiltinToolsSettingsManager, "saveSettings").mockImplementation(() => {});
    vi.spyOn(BuiltinToolsSettingsManager, "clearCache").mockImplementation(() => {});
    expect(await call("saveBuiltinToolsSettings", [settings])).toEqual({ success: true });
    expect(save).toHaveBeenCalledOnce();
    expect(() =>
      call("saveBuiltinToolsSettings", [{ ...settings, toolTimeouts: { read_file: -1 } }]),
    ).toThrow();
    save.mockImplementation(() => {
      throw new Error("Storage refused");
    });
    expect(() => call("saveBuiltinToolsSettings", [settings])).toThrow("Storage refused");
  });
  it("persists validated guardrails and refuses to claim success when storage fails", async () => {
    const settings = GuardrailManager.getDefaults();
    const save = vi.spyOn(GuardrailManager, "saveSettings").mockImplementation(() => {});
    const clear = vi.spyOn(GuardrailManager, "clearCache").mockImplementation(() => {});
    expect(await call("saveGuardrailSettings", [settings])).toEqual({ success: true });
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokensPerTask: settings.maxTokensPerTask }),
    );
    expect(clear).toHaveBeenCalledTimes(1);
    save.mockImplementation(() => {
      throw new Error("Storage refused");
    });
    expect(() => call("saveGuardrailSettings", [settings])).toThrow("Storage refused");
    expect(clear).toHaveBeenCalledTimes(1);
    expect(() => call("saveGuardrailSettings", [{ ...settings, unknownSetting: true }])).toThrow();
  });

  it("saves complete permission settings and refreshes active executors after persistence", async () => {
    const settings = {
      version: 2,
      defaultMode: "default",
      defaultShellEnabled: false,
      defaultPermissionAccess: "default",
      accessProfiles: [],
      rules: [],
    };
    const save = vi.spyOn(PermissionSettingsManager, "saveSettings").mockImplementation(() => {});
    vi.spyOn(PermissionSettingsManager, "clearCache").mockImplementation(() => {});
    vi.spyOn(PermissionSettingsManager, "loadSettings").mockReturnValue(settings as never);
    const refresh = vi.fn();
    const definitions = createBrowserSettingsDefinitions({ refreshAccessProfiles: refresh });
    const method = definitions.savePermissionSettings;
    expect(await method.handler(method.validate!([settings]), context)).toEqual({ success: true });
    expect(save).toHaveBeenCalledWith(expect.objectContaining(settings));
    expect(refresh).toHaveBeenCalledOnce();
    expect(await call("getPermissionSettings")).toMatchObject(settings);
    save.mockImplementation(() => {
      throw new Error("Storage refused");
    });
    expect(() => method.handler(method.validate!([settings]), context)).toThrow("Storage refused");
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("exposes guarded read-only workspace safety and profile summaries", async () => {
    const guardrails = { blockDangerousCommands: true, customBlockedPatterns: [] };
    const profile = { facts: [{ id: "fact-1", category: "preference", value: "Concise" }] };
    const commitments = [{ id: "commitment-1", text: "Send the recap" }];
    vi.spyOn(GuardrailManager, "loadSettings").mockReturnValue(guardrails as never);
    vi.spyOn(UserProfileService, "getProfile").mockReturnValue(profile as never);
    vi.spyOn(RelationshipMemoryService, "listOpenCommitments").mockReturnValue(
      commitments as never,
    );

    const definitions = createBrowserSettingsDefinitions();
    expect(definitions.getGuardrailSettings.capability).toBe("agents.manage");
    expect(await call("getGuardrailSettings")).toEqual(guardrails);
    expect(await call("getUserProfile")).toEqual(profile);
    expect(await call("getOpenCommitments", [5])).toEqual(commitments);
    expect(RelationshipMemoryService.listOpenCommitments).toHaveBeenCalledWith(5);
    expect(definitions.getPermissionRuntimeInfo.capability).toBe("agents.manage");
    expect(definitions.getAdminPolicies.capability).toBe("agents.manage");
    expect(definitions.getPersonalitySettingsChangeSignal.capability).toBe("agents.manage");
  });

  it("bounds browser commitment reads before accessing profile memory", async () => {
    const list = vi.spyOn(RelationshipMemoryService, "listOpenCommitments");
    const definition = createBrowserSettingsDefinitions().getOpenCommitments;
    expect(() => definition.validate?.([201])).toThrow();
    expect(list).not.toHaveBeenCalled();
  });

  it("returns Google Workspace readiness without exposing OAuth tokens", async () => {
    vi.spyOn(GoogleWorkspaceSettingsManager, "loadSettings").mockReturnValue({
      enabled: true,
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    } as never);

    const settings = (await call("getGoogleWorkspaceSettings")) as Record<string, unknown>;
    expect(settings).toEqual({
      enabled: true,
      credentialsConfigured: true,
      scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    });
    expect(JSON.stringify(settings)).not.toContain("secret");
  });

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

    const snapshot = (await call("getLLMSettings")) as {
      settings: {
        openai: Record<string, unknown>;
        openaiCompatible: Record<string, unknown>;
        customProviders: Record<string, Record<string, unknown>>;
      };
      revision: string;
    };
    const settings = snapshot.settings;

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
    expect(snapshot.revision).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(snapshot.revision).not.toContain("sk-live-secret");
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
    const revision = await getProviderSettingsRevision();

    await call("saveLLMSettings", [
      createLLMSettingsPatch(
        { providerType: "openai", modelKey: "gpt-4o", openai: { apiKey: "" } },
        {
          providerType: "openai",
          modelKey: "gpt-4o",
          openai: { apiKeyConfigured: true, accessTokenConfigured: true },
        },
      ),
      revision,
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
      createLLMSettingsPatch(
        { providerType: "openai", modelKey: "gpt-4o", openai: { apiKey: "sk-replacement" } },
        {
          providerType: "openai",
          modelKey: "gpt-4o",
          openai: { apiKeyConfigured: true, accessTokenConfigured: true },
        },
      ),
      revision,
    ]);
    expect((save.mock.calls[0][0] as { openai?: { apiKey?: string } }).openai?.apiKey).toBe(
      "sk-replacement",
    );
  });

  it("rejects unprotected provider credential writes and malformed patches", async () => {
    const old = {
      providerType: "openai",
      modelKey: "gpt-4o",
      openai: { apiKey: "sk-existing", accessToken: "oauth-existing" },
    };
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue(old as never);
    const save = vi.spyOn(LLMProviderFactory, "saveSettings").mockImplementation(() => undefined);
    const revision = await getProviderSettingsRevision();
    const invalidPatches: unknown[] = [
      {
        set: [{ path: ["openai", "apiKey"], value: "sk-unprotected" }],
        remove: [],
        replaceSecrets: [],
      },
      {
        set: [{ path: ["openai", "accessToken"], value: "oauth-unprotected" }],
        remove: [],
        replaceSecrets: [],
      },
      {
        set: [{ path: ["openai", "apiKeyConfigured"], value: false }],
        remove: [],
        replaceSecrets: [],
      },
      { set: [], remove: [["openai", "apiKeyConfigured"]], replaceSecrets: [] },
      {
        set: [],
        remove: [],
        replaceSecrets: [{ path: ["openai", "apiKey"], value: "   " }],
      },
      { set: [{ path: ["modelKey"] }], remove: [], replaceSecrets: [] },
      {
        set: [{ path: ["modelKey"], value: "gpt-4.1" }],
        remove: [["modelKey"]],
        replaceSecrets: [],
      },
    ];

    for (const patch of invalidPatches) {
      await expect(
        Promise.resolve().then(() => call("saveLLMSettings", [patch, revision])),
      ).rejects.toThrow();
    }

    expect(save).not.toHaveBeenCalled();
  });

  it("rejects stale provider settings writes before saving or resetting credentials", async () => {
    let current = {
      providerType: "openai",
      modelKey: "gpt-4o",
      openai: { apiKey: "sk-existing" },
    };
    vi.spyOn(LLMProviderFactory, "loadSettings").mockImplementation(() => current as never);
    const save = vi.spyOn(LLMProviderFactory, "saveSettings").mockImplementation(() => undefined);
    const clearCache = vi
      .spyOn(LLMProviderFactory, "clearCache")
      .mockImplementation(() => undefined);
    const revision = await getProviderSettingsRevision();
    current = { ...current, modelKey: "gpt-4.1" };

    const staleWrites: Array<[string, unknown[]]> = [
      [
        "saveLLMSettings",
        [
          {
            set: [{ path: ["modelKey"], value: "gpt-4o" }],
            remove: [],
            replaceSecrets: [],
          },
          revision,
        ],
      ],
      ["resetLLMProviderCredentials", ["openai", revision]],
      ["setLLMModel", [{ providerType: "openai", modelKey: "gpt-4o" }, revision]],
    ];
    for (const [method, args] of staleWrites) {
      await expect(Promise.resolve().then(() => call(method, args))).rejects.toMatchObject({
        code: "CONFLICT",
        statusCode: 409,
        message: expect.stringMatching(/reload AI & Models/i),
      });
    }

    expect(save).not.toHaveBeenCalled();
    expect(clearCache).not.toHaveBeenCalled();
  });

  it("allows saving after model refresh without overwriting the refreshed catalog", async () => {
    let current: Record<string, unknown> = {
      providerType: "openrouter",
      modelKey: "model-a",
      openrouter: { apiKey: "saved-key", model: "model-a" },
    };
    vi.spyOn(LLMProviderFactory, "loadSettings").mockImplementation(() => current as never);
    vi.spyOn(LLMProviderFactory, "saveSettings").mockImplementation((settings) => {
      current = settings as unknown as Record<string, unknown>;
    });
    vi.spyOn(LLMProviderFactory, "getOpenRouterModels").mockResolvedValue([
      { id: "model-b", name: "Model B", context_length: 8192 },
    ] as never);
    vi.spyOn(LLMProviderFactory, "saveCachedModels").mockImplementation((_provider, models) => {
      current = { ...current, cachedOpenRouterModels: models };
    });
    const revision = await getProviderSettingsRevision();
    await call("getOpenRouterModels", []);
    expect(await getProviderSettingsRevision()).toBe(revision);
    await call("saveLLMSettings", [
      {
        set: [{ path: ["openrouter", "model"], value: "model-b" }],
        remove: [],
        replaceSecrets: [],
      },
      revision,
    ]);
    expect(current.cachedOpenRouterModels).toEqual([expect.objectContaining({ key: "model-b" })]);
    expect(current.openrouter).toMatchObject({ apiKey: "saved-key", model: "model-b" });
    expect(await getProviderSettingsRevision()).not.toBe(revision);
  });

  it("ignores nested custom-provider discovery caches but retains endpoint conflicts", async () => {
    let current = {
      customProviders: {
        "custom-test": { baseUrl: "https://models.example/v1", cachedModels: [{ key: "old" }] },
      },
    };
    vi.spyOn(LLMProviderFactory, "loadSettings").mockImplementation(() => current as never);
    const revision = await getProviderSettingsRevision();
    current.customProviders["custom-test"].cachedModels = [{ key: "refreshed" }];
    expect(await getProviderSettingsRevision()).toBe(revision);
    current.customProviders["custom-test"].baseUrl = "https://other.example/v1";
    expect(await getProviderSettingsRevision()).not.toBe(revision);
  });

  it("returns the new provider settings revision after a successful save", async () => {
    let current = { providerType: "openai", modelKey: "gpt-4o" };
    vi.spyOn(LLMProviderFactory, "loadSettings").mockImplementation(() => current as never);
    vi.spyOn(LLMProviderFactory, "saveSettings").mockImplementation((settings) => {
      current = settings as typeof current;
    });
    const revision = await getProviderSettingsRevision();

    const result = (await call("saveLLMSettings", [
      createLLMSettingsPatch(
        { providerType: "openai", modelKey: "gpt-4.1" },
        { providerType: "openai", modelKey: "gpt-4o" },
      ),
      revision,
    ])) as { success: boolean; revision: string };

    expect(result.success).toBe(true);
    expect(result.revision).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.revision).not.toBe(revision);
  });

  it("restores hidden URL credentials only when a patched URL target is unchanged", async () => {
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
    const revision = await getProviderSettingsRevision();
    const sameTargetPatch = {
      set: [
        {
          path: ["openaiCompatible", "baseUrl"],
          value: "http://127.0.0.1:7788/v1?tenant=team&mode=chat",
        },
        {
          path: ["customProviders", "local", "baseUrl"],
          value: "http://localhost:8899/v1?tenant=dev",
        },
      ],
      remove: [],
      replaceSecrets: [],
    };

    await call("saveLLMSettings", [sameTargetPatch, revision]);

    const saved = save.mock.calls[0][0] as typeof old;
    expect([...new URL(saved.openaiCompatible.baseUrl).searchParams.entries()]).toEqual([
      ["tenant", "team"],
      ["mode", "chat"],
      ["api_key", "saved-url-key"],
    ]);
    expect([...new URL(saved.customProviders.local.baseUrl).searchParams.entries()]).toEqual([
      ["tenant", "dev"],
      ["client_secret", "saved-client-secret"],
    ]);

    save.mockClear();
    const changedTargetPatch = {
      set: [
        {
          path: ["openaiCompatible", "baseUrl"],
          value: "http://127.0.0.1:7788/other?tenant=team&mode=chat",
        },
        {
          path: ["customProviders", "local", "baseUrl"],
          value: "http://localhost:8899/other?tenant=dev",
        },
      ],
      remove: [],
      replaceSecrets: [],
    };
    await call("saveLLMSettings", [changedTargetPatch, revision]);
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
        createLLMSettingsPatch(
          {
            providerType: "openai-compatible",
            modelKey: "local-model",
            openaiCompatible: {
              baseUrl: "http://127.0.0.1:7788/v1?tenant=team&client_secret=must-not-save",
            },
          },
          {},
        ),
        await getProviderSettingsRevision(),
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

  it.each(["openrouter", "groq", "xai", "deepseek", "kimi", "ollama", "openaiCompatible"])(
    "rejects preserving a saved %s key when testing or saving another endpoint",
    async (provider) => {
      const old = {
        providerType: provider === "openaiCompatible" ? "openai-compatible" : provider,
        modelKey: "model",
        [provider]: { apiKey: "saved-key", baseUrl: "https://saved.example/v1" },
      };
      vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue(old as never);
      const save = vi.spyOn(LLMProviderFactory, "saveSettings").mockImplementation(() => {});
      const test = vi
        .spyOn(LLMProviderFactory, "testProvider")
        .mockResolvedValue({ success: true });
      const draft = { ...old, [provider]: { baseUrl: "https://changed.example/v1", apiKey: "" } };
      await expect(call("testLLMProvider", [draft])).rejects.toMatchObject({
        code: "INVALID_REQUEST",
        statusCode: 400,
        message: expect.stringMatching(/replacement credential/),
      });
      await expect(
        call("saveLLMSettings", [
          {
            set: [{ path: [provider, "baseUrl"], value: "https://changed.example/v1" }],
            remove: [],
            replaceSecrets: [],
          },
          await getProviderSettingsRevision(),
        ]),
      ).rejects.toThrow(/replacement credential/);
      expect(test).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
      await call("testLLMProvider", [
        { ...draft, [provider]: { ...draft[provider], apiKey: "new-key" } },
      ]);
      expect(test).toHaveBeenCalledOnce();
      expect(JSON.stringify(test.mock.calls)).toContain("new-key");
      expect(JSON.stringify(test.mock.calls)).not.toContain("saved-key");
      await call("saveLLMSettings", [
        {
          set: [{ path: [provider, "baseUrl"], value: "https://changed.example/v1" }],
          remove: [],
          replaceSecrets: [{ path: [provider, "apiKey"], value: "new-key" }],
        },
        await getProviderSettingsRevision(),
      ]);
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          [provider]: expect.objectContaining({
            apiKey: "new-key",
            baseUrl: "https://changed.example/v1",
          }),
        }),
      );
    },
  );

  it("preserves saved keys and hidden query credentials for same-endpoint tests and saves", async () => {
    const old = {
      providerType: "openrouter",
      modelKey: "model",
      openrouter: {
        apiKey: "saved-key",
        baseUrl: "https://saved.example/v1?api_key=hidden&tenant=one",
      },
    };
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue(old as never);
    const test = vi.spyOn(LLMProviderFactory, "testProvider").mockResolvedValue({ success: true });
    const save = vi.spyOn(LLMProviderFactory, "saveSettings").mockImplementation(() => {});
    await call("testLLMProvider", [
      { ...old, openrouter: { apiKey: "", baseUrl: "https://saved.example/v1?tenant=one" } },
    ]);
    expect(test).toHaveBeenCalledWith(expect.objectContaining({ openrouterApiKey: "saved-key" }));
    await call("saveLLMSettings", [
      {
        set: [{ path: ["openrouter", "baseUrl"], value: "https://saved.example/v1?tenant=one" }],
        remove: [],
        replaceSecrets: [],
      },
      await getProviderSettingsRevision(),
    ]);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ openrouter: expect.objectContaining({ apiKey: "saved-key" }) }),
    );
    expect(JSON.stringify(save.mock.calls)).toContain("hidden");
  });

  it.each(["remove", "blank"])(
    "binds saved keys across endpoint %s and default transitions",
    async (operation) => {
      const old = {
        providerType: "openrouter",
        modelKey: "model",
        openrouter: { apiKey: "saved-key", baseUrl: "https://saved.example/v1" },
      };
      vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue(old as never);
      const save = vi.spyOn(LLMProviderFactory, "saveSettings").mockImplementation(() => {});
      const patch = {
        set: operation === "blank" ? [{ path: ["openrouter", "baseUrl"], value: "" }] : [],
        remove: operation === "remove" ? [["openrouter", "baseUrl"]] : [],
        replaceSecrets: [] as Array<{ path: string[]; value: string }>,
      };
      const revision = await getProviderSettingsRevision();
      await expect(call("saveLLMSettings", [patch, revision])).rejects.toThrow(
        /replacement credential/,
      );
      expect(save).not.toHaveBeenCalled();
      patch.replaceSecrets.push({ path: ["openrouter", "apiKey"], value: "default-endpoint-key" });
      await call("saveLLMSettings", [patch, revision]);
      expect(save.mock.calls[0][0].openrouter).toMatchObject({
        apiKey: "default-endpoint-key",
        baseUrl: undefined,
      });
    },
  );

  it.each([
    ["imageGeneration", "openrouter", "baseUrl", "openrouter", "baseUrl"],
    ["imageGeneration", "azure", "imageEndpoint", "azure", "endpoint"],
    ["videoGeneration", "azure", "videoEndpoint", "azure", "endpoint"],
  ])(
    "binds %s %s fallback keys to the saved endpoint",
    async (group, provider, urlField, parent, parentUrl) => {
      const old = {
        providerType: parent,
        modelKey: "model",
        [parent]: { apiKey: "saved-key", [parentUrl]: "https://saved.example/v1" },
      };
      vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue(old as never);
      const save = vi.spyOn(LLMProviderFactory, "saveSettings").mockImplementation(() => {});
      await expect(
        call("saveLLMSettings", [
          {
            set: [{ path: [group, provider, urlField], value: "https://changed.example/v1" }],
            remove: [],
            replaceSecrets: [],
          },
          await getProviderSettingsRevision(),
        ]),
      ).rejects.toThrow(/replacement credential/);
      expect(save).not.toHaveBeenCalled();
    },
  );

  it("binds custom-provider saved keys and host-managed xAI OAuth after final settings merges", async () => {
    const old = {
      providerType: "atomic-chat",
      modelKey: "model",
      customProviders: {
        "atomic-chat": { apiKey: "saved-key", baseUrl: "https://saved.example/v1" },
      },
      xai: {
        authMethod: "oauth",
        accessToken: "saved-access",
        refreshToken: "saved-refresh",
        baseUrl: "https://saved.example/v1",
      },
    };
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue(old as never);
    const save = vi.spyOn(LLMProviderFactory, "saveSettings").mockImplementation(() => {});
    const test = vi.spyOn(LLMProviderFactory, "testProvider").mockResolvedValue({ success: true });
    await expect(
      call("testLLMProvider", [
        {
          providerType: "atomic-chat",
          modelKey: "model",
          customProviders: { "atomic-chat": { baseUrl: "https://changed.example/v1" } },
        },
      ]),
    ).rejects.toThrow(/replacement credential/);
    for (const path of [
      ["customProviders", "atomic-chat", "baseUrl"],
      ["xai", "baseUrl"],
    ]) {
      await expect(
        call("saveLLMSettings", [
          { set: [{ path, value: "https://changed.example/v1" }], remove: [], replaceSecrets: [] },
          await getProviderSettingsRevision(),
        ]),
      ).rejects.toThrow(/replacement credential/);
    }
    expect(save).not.toHaveBeenCalled();
    expect(test).not.toHaveBeenCalled();
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
          workspaceRoots: ["/private/root"],
        },
      ],
      rules: [{ id: "rule", path: "/private/rule" }],
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
    expect(JSON.stringify(permissions)).not.toContain("mcp-secret");
    expect(mcp.servers[0]).not.toHaveProperty("command");
    expect(mcp.servers[0]).not.toHaveProperty("env");
  });
});
