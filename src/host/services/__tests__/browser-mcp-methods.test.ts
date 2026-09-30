import { describe, expect, it, vi } from "vitest";
import type { WebRequestContext } from "../../web/WebApplication";
import type {
  MCPServerConfig,
  MCPServerStatus,
  MCPSettings,
  MCPRegistryEntry,
} from "../../../electron/mcp/types";
import type { Workspace } from "../../../shared/types";
import { createBrowserMCPDefinitions } from "../browser-mcp-methods";

const PROFILE_ID = "profile-owner";
const WORKSPACE_ID = "workspace-one";
const SERVER_ID = "00000000-0000-4000-8000-000000000001";
const ENTRY_ID = "browser-qa-echo";
const APPROVAL_TOKEN = "00000000-0000-4000-8000-000000000002";
const OWNER: WebRequestContext = {
  audience: "web-access",
  identity: {
    installationId: "installation-one",
    profileId: PROFILE_ID,
    generation: "generation-one",
    runtime: "node",
    platform: "linux",
    appVersion: "test",
  },
  sessionId: "session-one",
};

function server(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    id: SERVER_ID,
    name: "QA Echo",
    description: "Disposable MCP fixture",
    enabled: true,
    transport: "stdio",
    command: "node",
    args: ["scripts/qa/fixtures/browser-qa-mcp.mjs"],
    env: { FIXTURE_API_KEY: "fixture-secret-value" },
    auth: { type: "bearer", token: "server-auth-secret-value" },
    installedAt: 1_758_000_000_000,
    ...overrides,
  };
}

function registryEntry(overrides: Partial<MCPRegistryEntry> = {}): MCPRegistryEntry {
  return {
    id: ENTRY_ID,
    name: "Browser QA Echo",
    description: "A disposable first-party fixture",
    version: "1.0.0",
    author: "CoWork QA",
    installMethod: "manual",
    transport: "stdio",
    defaultCommand: "node",
    defaultArgs: ["scripts/qa/fixtures/browser-qa-mcp.mjs"],
    defaultEnv: { FIXTURE_TOKEN: "registry-default-secret" },
    tools: [{ name: "qa_echo", description: "Echo a bounded test message." }],
    tags: ["qa"],
    category: "testing",
    verified: true,
    ...overrides,
  };
}

function confirmationRequest(entry: MCPRegistryEntry) {
  return {
    entryId: entry.id,
    name: entry.name,
    publisher: entry.author,
    transport: entry.transport,
    command: entry.defaultCommand || entry.installCommand,
    args: [...(entry.defaultArgs ?? [])],
    envKeys: Object.keys(entry.defaultEnv ?? {}),
    url: entry.defaultUrl,
  };
}

function setup(options: { workspace?: Partial<Workspace>; now?: () => number } = {}) {
  let stored: MCPSettings = {
    servers: [server()],
    autoConnect: true,
    toolNamePrefix: "mcp_",
    maxReconnectAttempts: 5,
    reconnectDelayMs: 1000,
    registryEnabled: true,
    registryUrl: "https://registry.modelcontextprotocol.io/servers.json",
    hostEnabled: false,
  };
  const settings = {
    loadSettings: vi.fn(() => stored),
    getSettingsForDisplay: vi.fn(() => ({ ...stored, storageStatus: "success" })),
    saveSettings: vi.fn((value: MCPSettings) => {
      stored = value;
    }),
    addServer: vi.fn((config: Omit<MCPServerConfig, "id">) => {
      const added = { ...config, id: SERVER_ID, installedAt: Date.now() };
      stored.servers.push(added);
      return added;
    }),
    updateServer: vi.fn((id: string, updates: Partial<MCPServerConfig>) => {
      const index = stored.servers.findIndex((item) => item.id === id);
      if (index < 0) return null;
      stored.servers[index] = { ...stored.servers[index], ...updates };
      return stored.servers[index];
    }),
    removeServer: vi.fn((id: string) => {
      const before = stored.servers.length;
      stored.servers = stored.servers.filter((item) => item.id !== id);
      return stored.servers.length < before;
    }),
    getServer: vi.fn((id: string) => stored.servers.find((item) => item.id === id)),
  };
  let currentEntry = registryEntry();
  const client = {
    getStatus: vi.fn(() => [
      {
        id: SERVER_ID,
        name: "QA Echo",
        status: "error",
        error: "server-auth-secret-value leaked in stdout",
        tools: [{ name: "qa_echo", description: "server-auth-secret-value" }],
      } satisfies MCPServerStatus,
    ]),
    getServerStatus: vi.fn(() => null),
    getServerTools: vi.fn(() => []),
    getAllTools: vi.fn(() => []),
    connectServer: vi.fn(async () => undefined),
    disconnectServer: vi.fn(async () => undefined),
    testServer: vi.fn(async () => ({ success: false, error: "server-auth-secret-value" })),
  };
  const registry = {
    fetchRegistry: vi.fn(async () => ({
      version: "2026-09-30",
      lastUpdated: "today",
      servers: [currentEntry],
    })),
    getServer: vi.fn(async (id: string) => (id === currentEntry.id ? currentEntry : null)),
    searchServers: vi.fn(async () => [currentEntry]),
    getCategories: vi.fn(async () => ["testing"]),
    installServer: vi.fn(
      async (
        id: string,
        _extraArgs?: string[],
        approve?: (request: ReturnType<typeof confirmationRequest>) => Promise<boolean>,
      ) => {
        const entry = id === currentEntry.id ? currentEntry : null;
        if (!entry) throw new Error("entry not found");
        if (approve && !(await approve(confirmationRequest(entry)))) {
          throw new Error("Installation declined: launch plan changed");
        }
        return server({ id: "00000000-0000-4000-8000-000000000003", registryId: id });
      },
    ),
    uninstallServer: vi.fn(async () => undefined),
    checkForUpdates: vi.fn(async () => []),
    updateServer: vi.fn(
      async (
        id: string,
        approve?: (request: ReturnType<typeof confirmationRequest>) => Promise<boolean>,
      ) => {
        const entry = id === SERVER_ID ? currentEntry : null;
        if (!entry) throw new Error("server not found");
        if (approve && !(await approve(confirmationRequest(entry)))) {
          throw new Error("Launch plan declined");
        }
        return server({ version: "2.0.0" });
      },
    ),
  };
  const resolveWorkspace = vi.fn(async (id: string) => {
    if (id !== WORKSPACE_ID) return null;
    return {
      id,
      isTemp: false,
      permissions: { read: true, write: true, delete: true },
      ...options.workspace,
    } as Workspace;
  });
  const definitions = createBrowserMCPDefinitions({
    profileId: PROFILE_ID,
    resolveWorkspace,
    settings,
    client,
    registry,
    now: options.now,
    makeApprovalToken: () => APPROVAL_TOKEN,
  });
  const call = async (name: string, params: unknown, context: WebRequestContext = OWNER) => {
    const definition = definitions[name];
    if (!definition) throw new Error(`Missing MCP method ${name}`);
    const args = definition.validate?.([params]) ?? [params];
    return definition.handler(args, context);
  };
  return {
    definitions,
    call,
    client,
    registry,
    settings,
    resolveWorkspace,
    setRegistryEntry: (entry: MCPRegistryEntry) => {
      currentEntry = entry;
    },
    getStoredSettings: () => stored,
  };
}

describe("browser MCP methods", () => {
  it("requires the authenticated profile owner and workspace permissions", async () => {
    const { call, client } = setup();
    await expect(
      call(
        "getMCPSettings",
        { workspaceId: WORKSPACE_ID },
        {
          ...OWNER,
          identity: { ...OWNER.identity, profileId: "other-profile" },
        },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      call(
        "getMCPSettings",
        { workspaceId: WORKSPACE_ID },
        {
          ...OWNER,
          sessionId: "",
        },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const noWrite = setup({
      workspace: { permissions: { read: true, write: false, delete: false } },
    });
    await expect(
      noWrite.call("connectMCPServer", { workspaceId: WORKSPACE_ID, serverId: SERVER_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      noWrite.call("removeMCPServer", { workspaceId: WORKSPACE_ID, serverId: SERVER_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(noWrite.client.connectServer).not.toHaveBeenCalled();
    expect(noWrite.resolveWorkspace).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(client.getStatus).not.toHaveBeenCalled();
  });

  it("rejects unknown fields, invalid transports, and server ids before manager calls", async () => {
    const { call, settings } = setup();
    await expect(
      call("addMCPServer", {
        workspaceId: WORKSPACE_ID,
        config: { name: "bad", transport: "stdio", command: "node", unsupported: true },
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      call("addMCPServer", {
        workspaceId: WORKSPACE_ID,
        config: { name: "bad", transport: "streamable-http", command: "node" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      call("updateMCPServer", {
        workspaceId: WORKSPACE_ID,
        serverId: SERVER_ID,
        updates: { enabled: false, auth: { type: "bearer", unexpected: "x" } },
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(settings.addServer).not.toHaveBeenCalled();
    expect(settings.updateServer).not.toHaveBeenCalled();
  });

  it("returns bounded settings and status projections without credentials or raw errors", async () => {
    const { call } = setup();
    const settings = await call("getMCPSettings", { workspaceId: WORKSPACE_ID });
    const statuses = await call("getMCPStatus", { workspaceId: WORKSPACE_ID });
    const serialized = JSON.stringify({ settings, statuses });
    expect(serialized).not.toContain("server-auth-secret-value");
    expect(serialized).not.toContain("fixture-secret-value");
    expect(serialized).not.toContain("Authorization");
    expect(settings).toMatchObject({
      servers: [{ id: SERVER_ID, hasAuthentication: true, environmentVariableCount: 1 }],
      storageStatus: "success",
    });
    expect(statuses).toMatchObject([
      {
        id: SERVER_ID,
        status: "error",
        error: "MCP operation failed. Review the server configuration on the host.",
        tools: [{ name: "qa_echo", description: "[redacted]" }],
      },
    ]);
    expect(
      JSON.stringify(
        await call("testMCPServer", { workspaceId: WORKSPACE_ID, serverId: SERVER_ID }),
      ),
    ).not.toContain("server-auth-secret-value");
  });

  it("keeps registry launch commands and environment values out of discovery responses", async () => {
    const { call } = setup();
    const registry = await call("fetchMCPRegistry", { workspaceId: WORKSPACE_ID });
    const results = await call("searchMCPRegistry", {
      workspaceId: WORKSPACE_ID,
      query: "echo",
      tags: ["qa"],
    });
    const responseText = JSON.stringify({ registry, results });
    expect(responseText).not.toContain("registry-default-secret");
    expect(responseText).not.toContain("defaultCommand");
    expect(responseText).not.toContain("defaultEnv");
    expect(registry).toMatchObject({
      servers: [{ id: ENTRY_ID, transport: "stdio" }],
      categories: ["testing"],
    });
    expect(results).toMatchObject([{ id: ENTRY_ID, name: "Browser QA Echo" }]);
  });

  it("routes connect, disconnect, test, update, remove, and registry actions through managers", async () => {
    const { call, client, registry, settings } = setup();
    await call("connectMCPServer", { workspaceId: WORKSPACE_ID, serverId: SERVER_ID });
    await call("disconnectMCPServer", { workspaceId: WORKSPACE_ID, serverId: SERVER_ID });
    await call("testMCPServer", { workspaceId: WORKSPACE_ID, serverId: SERVER_ID });
    await call("updateMCPServer", {
      workspaceId: WORKSPACE_ID,
      serverId: SERVER_ID,
      updates: { enabled: false },
    });
    settings.updateServer(SERVER_ID, { registryId: ENTRY_ID });
    const updatePreview = (await call("previewMCPServerUpdate", {
      workspaceId: WORKSPACE_ID,
      serverId: SERVER_ID,
    })) as { approvalToken: string };
    await call("updateMCPServerFromRegistry", {
      workspaceId: WORKSPACE_ID,
      serverId: SERVER_ID,
      approvalToken: updatePreview.approvalToken,
    });
    await call("uninstallMCPServer", { workspaceId: WORKSPACE_ID, serverId: SERVER_ID });

    expect(client.connectServer).toHaveBeenCalledWith(SERVER_ID);
    expect(client.disconnectServer).toHaveBeenCalledTimes(2);
    expect(client.testServer).toHaveBeenCalledWith(SERVER_ID);
    expect(settings.updateServer).toHaveBeenCalledWith(SERVER_ID, { enabled: false });
    expect(registry.updateServer).toHaveBeenCalledWith(SERVER_ID, expect.any(Function));
    expect(registry.uninstallServer).toHaveBeenCalledWith(SERVER_ID);
  });

  it("merges browser-entered environment values without revealing or erasing saved credentials", async () => {
    const { call, getStoredSettings } = setup();
    const updated = await call("updateMCPServer", {
      workspaceId: WORKSPACE_ID,
      serverId: SERVER_ID,
      updates: { env: { NEW_FIXTURE_TOKEN: "browser-entered-secret" } },
    });
    expect(getStoredSettings().servers[0].env).toEqual({
      FIXTURE_API_KEY: "fixture-secret-value",
      NEW_FIXTURE_TOKEN: "browser-entered-secret",
    });
    expect(JSON.stringify(updated)).not.toContain("browser-entered-secret");
    await call("updateMCPServer", {
      workspaceId: WORKSPACE_ID,
      serverId: SERVER_ID,
      updates: { removeEnvKeys: ["FIXTURE_API_KEY"] },
    });
    expect(getStoredSettings().servers[0].env).toEqual({
      NEW_FIXTURE_TOKEN: "browser-entered-secret",
    });
  });

  it("requires a reviewed registry plan or remove-and-add for launch changes", async () => {
    const { call, settings } = setup();
    for (const updates of [
      { command: "node" },
      { args: ["--inspect"] },
      { cwd: "/tmp" },
      { transport: "streamable-http" },
      { url: "https://mcp.example.test" },
    ]) {
      await expect(
        call("updateMCPServer", { workspaceId: WORKSPACE_ID, serverId: SERVER_ID, updates }),
      ).rejects.toMatchObject({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("Remove and add the server again"),
      });
    }
    expect(settings.updateServer).not.toHaveBeenCalled();
  });

  it("supports exact launch-plan preview approval, scoped to one browser session and workspace", async () => {
    const { call, registry } = setup();
    const preview = (await call("previewMCPServerInstall", {
      workspaceId: WORKSPACE_ID,
      entryId: ENTRY_ID,
    })) as {
      approvalToken: string;
      plan: { command: string; args: string[]; envKeys: string[] };
    };
    expect(preview.plan).toMatchObject({
      command: "node",
      args: ["scripts/qa/fixtures/browser-qa-mcp.mjs"],
      envKeys: ["FIXTURE_TOKEN"],
    });
    expect(JSON.stringify(preview)).not.toContain("registry-default-secret");

    await expect(
      call(
        "installMCPServer",
        { workspaceId: WORKSPACE_ID, entryId: ENTRY_ID, approvalToken: preview.approvalToken },
        { ...OWNER, sessionId: "another-session" },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await call("installMCPServer", {
      workspaceId: WORKSPACE_ID,
      entryId: ENTRY_ID,
      approvalToken: preview.approvalToken,
    });
    expect(registry.installServer).toHaveBeenCalledTimes(1);
    expect(registry.installServer.mock.calls[0][2]).toBeTypeOf("function");
    await expect(
      call("installMCPServer", {
        workspaceId: WORKSPACE_ID,
        entryId: ENTRY_ID,
        approvalToken: preview.approvalToken,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses changed or expired launch plans before installing", async () => {
    let now = 10_000;
    const changed = setup({ now: () => now });
    const preview = (await changed.call("previewMCPServerInstall", {
      workspaceId: WORKSPACE_ID,
      entryId: ENTRY_ID,
    })) as { approvalToken: string };
    changed.setRegistryEntry(registryEntry({ defaultArgs: ["scripts/changed.mjs"] }));
    await expect(
      changed.call("installMCPServer", {
        workspaceId: WORKSPACE_ID,
        entryId: ENTRY_ID,
        approvalToken: preview.approvalToken,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(changed.registry.installServer).toHaveBeenCalledTimes(1);

    const expired = setup({ now: () => now });
    const oldPreview = (await expired.call("previewMCPServerInstall", {
      workspaceId: WORKSPACE_ID,
      entryId: ENTRY_ID,
    })) as { approvalToken: string };
    now += 5 * 60_000;
    await expect(
      expired.call("installMCPServer", {
        workspaceId: WORKSPACE_ID,
        entryId: ENTRY_ID,
        approvalToken: oldPreview.approvalToken,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(expired.registry.installServer).not.toHaveBeenCalled();

    const changedUpdate = setup({ now: () => now });
    changedUpdate.settings.updateServer(SERVER_ID, { registryId: ENTRY_ID });
    const updatePreview = (await changedUpdate.call("previewMCPServerUpdate", {
      workspaceId: WORKSPACE_ID,
      serverId: SERVER_ID,
    })) as { approvalToken: string };
    changedUpdate.setRegistryEntry(registryEntry({ defaultArgs: ["scripts/updated.mjs"] }));
    await expect(
      changedUpdate.call("updateMCPServerFromRegistry", {
        workspaceId: WORKSPACE_ID,
        serverId: SERVER_ID,
        approvalToken: updatePreview.approvalToken,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(changedUpdate.registry.updateServer).toHaveBeenCalledTimes(1);
  });

  it("does not approve a preview that contains a saved profile credential", async () => {
    const { call, registry, setRegistryEntry } = setup();
    setRegistryEntry(registryEntry({ defaultArgs: ["--token", "server-auth-secret-value"] }));
    await expect(
      call("previewMCPServerInstall", {
        workspaceId: WORKSPACE_ID,
        entryId: ENTRY_ID,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(registry.installServer).not.toHaveBeenCalled();
  });

  it("does not return credential-shaped values embedded in registry arguments", async () => {
    const { call, setRegistryEntry } = setup();
    setRegistryEntry(registryEntry({ defaultArgs: ["--api-key", "fixture-api-key-12345"] }));
    await expect(
      call("previewMCPServerInstall", {
        workspaceId: WORKSPACE_ID,
        entryId: ENTRY_ID,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});
