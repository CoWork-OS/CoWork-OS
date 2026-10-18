import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// Exercise the real orchestration functions with isolated dependencies. The
// direct-run entrypoint normally initializes a live application/data profile.
function directFunctions(names: string[], bindings: Record<string, unknown>) {
  const fileName = path.resolve("src/cli/direct-run.ts");
  const source = fs.readFileSync(fileName, "utf8");
  const ast = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const declarations = ast.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text),
  );
  expect(declarations).toHaveLength(names.length);
  const payloadGuards = ast.statements.filter(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          ["isPayload", "payloadRecord"].includes(declaration.name.text),
      ),
  );
  expect(payloadGuards).toHaveLength(2);
  const javascript = ts.transpileModule(
    [...payloadGuards, ...declarations].map((node) => node.getText(ast)).join("\n"),
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    },
  ).outputText;
  return vm.runInNewContext(`${javascript}\n({${names.join(",")}})`, bindings);
}

describe("adversarial CLI regressions", () => {
  it("restores redacted provider metadata without replacing working API or OAuth secrets", async () => {
    const current = {
      openai: {
        apiKey: "working-key",
        accessToken: "working-access",
        refreshToken: "working-refresh",
      },
      azure: { apiKey: "azure-key" },
    };
    const backup = {
      type: "cowork_backup",
      providers: {
        openai: {
          apiKey: "[redacted]",
          accessToken: "[redacted]",
          refreshToken: "[redacted]",
          model: "restored-model",
        },
        azure: { apiKey: "[redacted]" },
      },
    };
    const saveSettings = vi.fn();
    const { restoreBackup } = directFunctions(["restoreBackup", "preserveRedactedSecrets"], {
      fs: { readFile: async () => JSON.stringify(backup) },
      path,
      LLMProviderFactory: { loadSettings: () => current, saveSettings },
      LLMSettingsSchema: { parse: (value: unknown) => value },
      writeEvent: vi.fn(),
    });
    expect(await restoreBackup({ output: "synthetic-backup.json", yes: true })).toBe(0);
    expect(saveSettings).toHaveBeenCalledWith({
      openai: { ...current.openai, model: "restored-model" },
      azure: current.azure,
    });
    expect(current.openai.apiKey).toBe("working-key");
  });

  it("restores MCP redactions by server ID while retaining only compatible secrets", async () => {
    const firstId = "11111111-1111-4111-8111-111111111111";
    const secondId = "22222222-2222-4222-8222-222222222222";
    const unmatchedId = "33333333-3333-4333-8333-333333333333";
    const changedEndpointId = "44444444-4444-4444-8444-444444444444";
    const current = {
      servers: [
        {
          id: secondId,
          name: "second",
          enabled: true,
          transport: "streamable-http",
          url: "https://second.example/mcp",
          auth: {
            type: "bearer",
            token: "second-token",
            refreshToken: "second-refresh",
          },
          env: { SECOND_SECRET: "second-env" },
          headers: { Authorization: "second-header" },
        },
        {
          id: firstId,
          name: "first",
          enabled: true,
          transport: "stdio",
          command: "first",
          auth: { type: "basic", password: "first-password" },
          env: { FIRST_SECRET: "first-env" },
          headers: { "X-First-Secret": "first-header" },
        },
        {
          id: changedEndpointId,
          name: "changed endpoint",
          enabled: true,
          transport: "streamable-http",
          url: "https://old.example/mcp",
          auth: { type: "bearer", token: "old-token" },
          env: { CHANGED_SECRET: "old-env" },
          headers: { Authorization: "old-header" },
        },
      ],
      autoConnect: true,
      toolNamePrefix: "mcp_",
      maxReconnectAttempts: 5,
      reconnectDelayMs: 1000,
      registryEnabled: true,
      hostEnabled: false,
    };
    const backup = {
      type: "cowork_backup",
      mcp: {
        ...current,
        servers: [
          {
            ...current.servers[1],
            name: "restored first",
            auth: { type: "bearer", token: "***configured***", username: "restored-user" },
            env: { FIRST_SECRET: "[redacted]" },
            headers: { "X-First-Secret": "[redacted]" },
          },
          {
            ...current.servers[0],
            name: "restored second",
            auth: {
              type: "bearer",
              token: "[redacted]",
              refreshToken: "[redacted]",
              clientSecret: "[redacted]",
            },
            env: { SECOND_SECRET: "[redacted]", EXPLICIT: "explicit-env" },
            headers: { Authorization: "[redacted]", "X-Explicit": "explicit-header" },
          },
          {
            id: unmatchedId,
            name: "unmatched",
            enabled: true,
            transport: "stdio",
            command: "unmatched",
            auth: { type: "bearer", token: "[redacted]" },
            env: { UNMATCHED_SECRET: "[redacted]" },
            headers: { Authorization: "[redacted]" },
          },
          {
            ...current.servers[2],
            url: "https://new.example/mcp",
            auth: { type: "bearer", token: "[redacted]" },
            env: { CHANGED_SECRET: "[redacted]" },
            headers: { Authorization: "[redacted]" },
          },
        ],
      },
    };
    const saveSettings = vi.fn();
    const { restoreBackup } = directFunctions(
      [
        "restoreBackup",
        "preserveRedactedMcpSecrets",
        "isMcpRedactedValue",
        "restoreMcpSecretMap",
        "mcpServerSecretCompatibility",
      ],
      {
        fs: { readFile: async () => JSON.stringify(backup) },
        path,
        MCPSettingsManager: { loadSettings: () => current, saveSettings },
        MCPSettingsSchema: { parse: (value: unknown) => value },
        MCP_AUTH_SECRET_KEYS: ["token", "apiKey", "password", "refreshToken", "clientSecret"],
        MCP_REDACTED_VALUES: new Set(["[redacted]", "***configured***"]),
        disableRestoredMcpServers: (settings: Any) => ({
          ...settings,
          servers: settings.servers.map((server: Any) => ({ ...server, enabled: false })),
        }),
        writeEvent: vi.fn(),
      },
    );
    expect(await restoreBackup({ output: "synthetic-mcp-backup.json", yes: true })).toBe(0);
    const restored = saveSettings.mock.calls[0][0];
    expect(restored.servers.map((server: Any) => server.id)).toEqual([
      firstId,
      secondId,
      unmatchedId,
      changedEndpointId,
    ]);
    const restoredFirst = restored.servers.find((server: Any) => server.id === firstId);
    const restoredSecond = restored.servers.find((server: Any) => server.id === secondId);
    const restoredUnmatched = restored.servers.find((server: Any) => server.id === unmatchedId);
    const restoredChanged = restored.servers.find((server: Any) => server.id === changedEndpointId);
    expect(restoredSecond).toMatchObject({
      enabled: false,
      auth: { token: "second-token", refreshToken: "second-refresh" },
      env: { SECOND_SECRET: "second-env", EXPLICIT: "explicit-env" },
      headers: { Authorization: "second-header", "X-Explicit": "explicit-header" },
    });
    expect(restoredFirst).toMatchObject({
      enabled: false,
      auth: { type: "bearer", username: "restored-user" },
      env: { FIRST_SECRET: "first-env" },
      headers: { "X-First-Secret": "first-header" },
    });
    expect(restoredFirst.auth).not.toHaveProperty("token");
    expect(JSON.stringify(restored)).not.toMatch(/\[redacted\]|\*\*\*configured\*\*\*/);
    expect(restoredUnmatched.auth).toEqual({ type: "bearer" });
    expect(restoredUnmatched.env).toEqual({});
    expect(restoredUnmatched.headers).toEqual({});
    expect(restoredChanged.auth).toEqual({ type: "bearer" });
    expect(restoredChanged.env).toEqual({});
    expect(restoredChanged.headers).toEqual({});
  });
});
