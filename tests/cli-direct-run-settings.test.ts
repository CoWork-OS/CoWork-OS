import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { LLM_PROVIDER_TYPES, type LLMProviderType } from "../src/shared/types";
import { MCPSettingsSchema } from "../src/electron/utils/validation";
import { DEFAULT_MCP_SETTINGS, type MCPSettings } from "../src/electron/mcp/types";
import { normalizeProviderType, resolveSupportedProviderType } from "../src/cli/run-model-pin";

interface SettingsFunctions {
  resolveSupportedProviderType(provider: string): LLMProviderType;
  configureLocalProvider(args: {
    providerType?: string;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  }): { providerType: LLMProviderType; model?: string };
  providerFallbackCommand(args: { command: string; providerType?: string; model?: string }): number;
  restoreBackup(args: { output: string; yes: boolean }): Promise<number>;
  disableRestoredMcpServers(settings: ReturnType<typeof MCPSettingsSchema.parse>): MCPSettings;
}

// As in cli-backup-restore-regressions, exercise real CLI functions without
// starting the application's live profile, providers or background workers.
function settingsFunctions(bindings: Record<string, unknown> = {}): SettingsFunctions {
  const fileName = path.resolve("src/cli/direct-run.ts");
  const source = fs.readFileSync(fileName, "utf8");
  const ast = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const names = [
    "isPayload",
    "payloadRecord",
    "configureLocalProvider",
    "providerFallbackCommand",
    "restoreBackup",
    "disableRestoredMcpServers",
    "preserveRedactedMcpSecrets",
    "isMcpRedactedValue",
    "restoreMcpSecretMap",
    "mcpServerSecretCompatibility",
    "MCP_AUTH_SECRET_KEYS",
    "MCP_REDACTED_VALUES",
  ];
  const declarations = ast.statements.filter((node) => {
    if (ts.isFunctionDeclaration(node)) return !!node.name && names.includes(node.name.text);
    return (
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (declaration) => ts.isIdentifier(declaration.name) && names.includes(declaration.name.text),
      )
    );
  });
  expect(declarations).toHaveLength(names.length);
  const javascript = ts.transpileModule(declarations.map((node) => node.getText(ast)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return vm.runInNewContext(
    `${javascript}\n({resolveSupportedProviderType, configureLocalProvider, providerFallbackCommand, restoreBackup, disableRestoredMcpServers})`,
    {
      LLM_PROVIDER_TYPES,
      // Shared with `cowork run --provider`, so they live in run-model-pin.ts.
      normalizeProviderType,
      resolveSupportedProviderType,
      MCPSettingsSchema,
      DEFAULT_MCP_SETTINGS,
      path,
      writeEvent: vi.fn(),
      ...bindings,
    },
  ) as SettingsFunctions;
}

describe("CLI provider settings contracts", () => {
  it.each(LLM_PROVIDER_TYPES)("keeps supported provider %s", (providerType) => {
    expect(settingsFunctions().resolveSupportedProviderType(providerType)).toBe(providerType);
  });

  it.each([
    ["claude", "anthropic"],
    ["azure_anthropic", "azure-anthropic"],
    ["openai_compatible", "openai-compatible"],
    ["kimi-coding", "kimi-coding"],
    ["hf-agents", "hf-agents"],
    ["omlx", "omlx"],
  ])("configures supported provider/alias %s as %s", (input, providerType) => {
    const settings = { providerType: "openai", modelKey: "old-model" };
    const saveSettings = vi.fn();
    const functions = settingsFunctions({
      LLMProviderFactory: {
        loadSettings: () => settings,
        getConfigStatus: () => ({ providers: [] }),
        saveSettings,
      },
    });

    expect(
      functions.configureLocalProvider({
        providerType: input,
        apiKey: "synthetic-key",
        model: "synthetic-model",
        baseUrl: "https://provider.example/v1",
      }),
    ).toEqual({ providerType, model: "synthetic-model" });
    expect(saveSettings).toHaveBeenCalledOnce();
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ providerType, modelKey: "synthetic-model" }),
    );
  });

  it.each(["not-a-provider", "OPENAI", "provider-with-a-custom-url"])(
    "rejects unsupported provider %s before persisting configure or fallback settings",
    (providerType) => {
      const saveSettings = vi.fn();
      const settings = { providerType: "openai", fallbackProviders: [] };
      const functions = settingsFunctions({
        LLMProviderFactory: {
          loadSettings: () => settings,
          getConfigStatus: () => ({ providers: [] }),
          saveSettings,
        },
      });

      expect(() =>
        functions.configureLocalProvider({ providerType, apiKey: "synthetic-key" }),
      ).toThrow(/Unknown provider type/);
      expect(() =>
        functions.providerFallbackCommand({ command: "providers-fallback-add", providerType }),
      ).toThrow(/Unknown provider type/);
      expect(saveSettings).not.toHaveBeenCalled();
      expect(settings).toEqual({ providerType: "openai", fallbackProviders: [] });
    },
  );

  it("keeps alias normalization and existing fallback order", () => {
    const settings = {
      providerType: "openai",
      fallbackProviders: [{ providerType: "gemini", modelKey: "existing-model" }],
    };
    const saveSettings = vi.fn();
    const functions = settingsFunctions({
      LLMProviderFactory: { loadSettings: () => settings, saveSettings },
    });

    expect(
      functions.providerFallbackCommand({
        command: "providers-fallback-add",
        providerType: "claude",
        model: "fallback-model",
      }),
    ).toBe(0);
    expect(settings.fallbackProviders).toEqual([
      { providerType: "gemini", modelKey: "existing-model" },
      { providerType: "anthropic", modelKey: "fallback-model" },
    ]);
    expect(
      functions.providerFallbackCommand({
        command: "providers-fallback-remove",
        providerType: "claude",
      }),
    ).toBe(0);
    expect(settings.fallbackProviders).toEqual([
      { providerType: "gemini", modelKey: "existing-model" },
    ]);
  });

  it("can remove an unsupported fallback left by an older CLI", () => {
    const settings = {
      providerType: "openai",
      fallbackProviders: [
        { providerType: "legacy-unsupported-provider" },
        { providerType: "gemini" },
      ],
    };
    const saveSettings = vi.fn();
    const functions = settingsFunctions({
      LLMProviderFactory: { loadSettings: () => settings, saveSettings },
    });

    expect(
      functions.providerFallbackCommand({
        command: "providers-fallback-remove",
        providerType: "legacy-unsupported-provider",
      }),
    ).toBe(0);
    expect(settings.fallbackProviders).toEqual([{ providerType: "gemini" }]);
    expect(saveSettings).toHaveBeenCalledOnce();
  });
});

describe("CLI MCP restore identities", () => {
  const existingId = "11111111-1111-4111-8111-111111111111";
  const generatedIds = [
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
  ];

  it("assigns omitted IDs once, preserves existing IDs and compatible secrets, and disables every server", async () => {
    const current = MCPSettingsSchema.parse({
      servers: [
        {
          id: existingId,
          name: "Existing connector",
          transport: "stdio",
          command: "node",
          args: ["connector.js"],
          auth: { type: "bearer", token: "working-token" },
          env: { API_KEY: "working-env" },
        },
      ],
    });
    const redactedServer = {
      ...current.servers[0],
      auth: { type: "bearer", token: "[redacted]" },
      env: { API_KEY: "[redacted]" },
    };
    const { id: _existingId, ...unidentified } = redactedServer;
    const backup = {
      type: "cowork_backup",
      mcp: {
        ...current,
        servers: [
          redactedServer,
          { ...unidentified, name: "Legacy one" },
          { ...unidentified, name: "Legacy two" },
        ],
      },
    };
    const randomUUID = vi
      .fn()
      .mockReturnValueOnce(generatedIds[0])
      .mockReturnValueOnce(generatedIds[1]);
    const saveSettings = vi.fn<(settings: MCPSettings) => void>();
    const functions = settingsFunctions({
      fs: { readFile: async () => JSON.stringify(backup) },
      MCPSettingsManager: { loadSettings: () => current, saveSettings },
      randomUUID,
    });

    expect(await functions.restoreBackup({ output: "synthetic-backup.json", yes: true })).toBe(0);
    expect(saveSettings).toHaveBeenCalledOnce();
    const restored = saveSettings.mock.calls[0][0];
    expect(restored.registryUrl).toBe(DEFAULT_MCP_SETTINGS.registryUrl);
    expect(restored.servers.map((server) => server.id)).toEqual([existingId, ...generatedIds]);
    expect(randomUUID).toHaveBeenCalledTimes(2);
    for (const server of restored.servers) {
      expect(server.enabled).toBe(false);
      expect(server.lastError).toMatch(/disabled until re-enabled/);
    }
    expect(restored.servers[0]).toMatchObject({
      auth: { token: "working-token" },
      env: { API_KEY: "working-env" },
    });
    for (const server of restored.servers.slice(1)) {
      expect(server.auth).toEqual({ type: "bearer" });
      expect(server.env).toEqual({});
    }
    expect(JSON.stringify(restored)).not.toContain("[redacted]");
    expect(current.servers[0].enabled).toBe(true);
    expect(
      functions
        .disableRestoredMcpServers(MCPSettingsSchema.parse(restored))
        .servers.map((server) => server.id),
    ).toEqual([existingId, ...generatedIds]);
    expect(randomUUID).toHaveBeenCalledTimes(2);
  });

  it("retains an explicitly configured MCP registry URL", () => {
    const registryUrl = "https://registry.example/servers.json";
    const restored = settingsFunctions().disableRestoredMcpServers(
      MCPSettingsSchema.parse({ servers: [], registryUrl }),
    );
    expect(restored.registryUrl).toBe(registryUrl);
  });

  it.each(["", "invalid-id", null])(
    "rejects malformed explicit ID %s before saving",
    async (id) => {
      const saveSettings = vi.fn();
      const randomUUID = vi.fn();
      const functions = settingsFunctions({
        fs: {
          readFile: async () =>
            JSON.stringify({
              type: "cowork_backup",
              mcp: { servers: [{ id, name: "Invalid", transport: "stdio", command: "node" }] },
            }),
        },
        MCPSettingsManager: { loadSettings: () => ({ servers: [] }), saveSettings },
        randomUUID,
      });

      await expect(
        functions.restoreBackup({ output: "invalid-backup.json", yes: true }),
      ).rejects.toThrow();
      expect(saveSettings).not.toHaveBeenCalled();
      expect(randomUUID).not.toHaveBeenCalled();
    },
  );
});
