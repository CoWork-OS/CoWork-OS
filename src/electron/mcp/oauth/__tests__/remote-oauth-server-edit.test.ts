/**
 * Editing a Remote (OAuth) server in place: stored secrets survive a blank field,
 * identity changes sign the server out and void earlier approvals, and a pending
 * sign-in can be cancelled by server ID.
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  stored: undefined as Record<string, unknown> | undefined,
  blocked: [] as string[],
  connected: new Set<string>(),
  disconnect: vi.fn(),
  connect: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn().mockReturnValue("/mock/user/data") },
  safeStorage: {
    isEncryptionAvailable: vi.fn().mockReturnValue(false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

vi.mock("../../../database/SecureSettingsRepository", () => ({
  SecureSettingsRepository: {
    isInitialized: () => true,
    getInstance: () => ({
      save: (_category: string, settings: Record<string, unknown>) => {
        state.stored = structuredClone(settings);
      },
      load: () => (state.stored ? structuredClone(state.stored) : undefined),
      exists: () => state.stored !== undefined,
      checkHealth: () => "ok",
    }),
  },
}));

vi.mock("../../../admin/policies", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../admin/policies")>()),
  loadPolicies: vi.fn(() => ({ connectors: { blocked: [...state.blocked] } })),
}));

vi.mock("../../client/MCPClientManager", () => ({
  MCPClientManager: {
    getInstance: () => ({
      getServerStatus: (id: string) => (state.connected.has(id) ? { id } : null),
      disconnectServer: async (id: string) => {
        state.connected.delete(id);
        state.disconnect(id);
      },
      connectServer: async (id: string) => {
        state.connected.add(id);
        state.connect(id);
      },
    }),
  },
}));

import { mcpConfigurationCurrent } from "../../configuration-authority";
import { MASKED_VALUE, MCPSettingsManager } from "../../settings";
import type { MCPServerConfig } from "../../types";
import { isMcpSignInCancelled } from "../mcp-oauth";
import {
  addRemoteOAuthServer,
  authorizeMcpServer,
  cancelMcpServerSignIn,
  RemoteOAuthServerUpdateSchema,
  updateRemoteOAuthServer,
} from "../mcp-server-authorization";

const workday = {
  name: "Workday",
  kind: "workday",
  region: "us",
  tenant: "acme_dev1",
  grant: "authorization_code",
  clientId: "wrong-client",
  clientSecret: "secret-1",
};

/** Adds the server and records a completed sign-in on it. */
function addSignedIn(input: Record<string, unknown> = workday): MCPServerConfig {
  const added = addRemoteOAuthServer(input);
  MCPSettingsManager.updateServer(added.id, {
    auth: {
      ...added.auth!,
      token: "access-1",
      refreshToken: "refresh-1",
      expiresAt: Date.now() + 3_600_000,
    },
  });
  state.connected.add(added.id);
  return structuredClone(MCPSettingsManager.getServer(added.id)!);
}

beforeEach(() => {
  state.stored = undefined;
  state.blocked = [];
  state.connected.clear();
  state.disconnect.mockClear();
  state.connect.mockClear();
  MCPSettingsManager.clearCache();
});

describe("editing a Remote (OAuth) server", () => {
  it("keeps the stored client secret when the field is blank or masked", async () => {
    const before = addSignedIn();
    for (const clientSecret of [undefined, "", "   ", MASKED_VALUE]) {
      const { server } = await updateRemoteOAuthServer({
        serverId: before.id,
        server: { ...workday, clientId: "right-client", clientSecret },
      });
      expect(server.auth?.clientSecret).toBe("secret-1");
      expect(server.auth?.clientId).toBe("right-client");
    }
    // Saved through the same settings store as on add, never as the mask.
    const saved = (state.stored!.servers as MCPServerConfig[])[0];
    expect(saved.auth?.clientSecret).toBe("secret-1");
  });

  it("replaces the stored secret when a new one is given", async () => {
    const before = addSignedIn();
    const { server, signedOut } = await updateRemoteOAuthServer({
      serverId: before.id,
      server: { ...workday, clientSecret: "secret-2" },
    });
    expect(server.auth?.clientSecret).toBe("secret-2");
    expect(signedOut).toBe(true);
  });

  it("signs the server out and voids earlier approvals when the client ID changes", async () => {
    const admitted = addSignedIn();
    const { server, signedOut } = await updateRemoteOAuthServer({
      serverId: admitted.id,
      server: { ...workday, clientId: "right-client" },
    });
    expect(signedOut).toBe(true);
    expect(server.auth).not.toHaveProperty("token");
    expect(server.auth).not.toHaveProperty("refreshToken");
    expect(server.auth).not.toHaveProperty("expiresAt");
    expect(server.auth?.oauth?.redirectUri).toBe("https://127.0.0.1:18768/oauth/callback");
    expect(state.disconnect).toHaveBeenCalledWith(admitted.id);
    // A tool call approved against the old configuration must ask again.
    expect(mcpConfigurationCurrent(admitted, MCPSettingsManager.getServer(admitted.id))).toBe(
      false,
    );
    // Settings that are not part of the identity are untouched.
    expect(server.enabled).toBe(true);
    expect(server.defaultToolsApprovalMode).toBe("writes");
  });

  it("signs out on an endpoint change too", async () => {
    const before = addSignedIn();
    const { server, signedOut } = await updateRemoteOAuthServer({
      serverId: before.id,
      server: { ...workday, tenant: "acme_prod" },
    });
    expect(signedOut).toBe(true);
    expect(server.url).toBe("https://us.agent.workday.com/acme_prod/mcp");
    expect(server.auth?.token).toBeUndefined();
  });

  it("keeps the sign-in on a rename or an unchanged save", async () => {
    const before = addSignedIn();
    const same = await updateRemoteOAuthServer({ serverId: before.id, server: workday });
    expect(same.signedOut).toBe(false);
    expect(mcpConfigurationCurrent(before, MCPSettingsManager.getServer(before.id))).toBe(true);

    const renamed = await updateRemoteOAuthServer({
      serverId: before.id,
      server: { ...workday, name: "Workday (dev)" },
    });
    expect(renamed.signedOut).toBe(false);
    expect(renamed.server.name).toBe("Workday (dev)");
    expect(renamed.server.auth).toMatchObject({ token: "access-1", refreshToken: "refresh-1" });
    expect(state.disconnect).not.toHaveBeenCalled();
  });

  it("keeps a stored agent key when the private key is left blank", async () => {
    const custom = {
      name: "Agent",
      kind: "custom",
      url: "https://a.example/mcp",
      tokenUrl: "https://a.example/token",
      grant: "jwt_bearer",
      clientId: "agent-client",
      jwtSubject: "agent-1",
      jwtKeyId: "key-1",
      privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
    };
    const before = addSignedIn(custom);
    const { privateKey: _key, jwtKeyId: _kid, ...withoutSecrets } = custom;
    const { server } = await updateRemoteOAuthServer({
      serverId: before.id,
      server: { ...withoutSecrets, jwtSubject: "agent-2" },
    });
    expect(server.auth?.privateKey).toBe(custom.privateKey);
    expect(server.auth?.oauth?.jwt).toEqual({ subject: "agent-2", keyId: "key-1" });
    // Without a stored key, a blank key is refused.
    const fresh = addRemoteOAuthServer({ ...workday, name: "Other" });
    await expect(
      updateRemoteOAuthServer({ serverId: fresh.id, server: { ...withoutSecrets } }),
    ).rejects.toThrow(/private key/);
  });

  it("rejects invalid redirects, URLs, IDs and unknown fields", async () => {
    const before = addSignedIn();
    const custom = {
      name: "C",
      kind: "custom",
      grant: "authorization_code",
      clientId: "c",
      url: "https://a.example/mcp",
      tokenUrl: "https://a.example/token",
      authorizationUrl: "https://a.example/authorize",
    };
    for (const server of [
      { ...custom, url: "http://insecure.example/mcp" },
      { ...custom, tokenUrl: "not a url" },
      { ...custom, redirectUri: "not a url" },
      // Only a loopback listener with an explicit port can receive the code.
      { ...custom, redirectUri: "https://example.com/cb" },
      { ...custom, redirectUri: "http://127.0.0.1/cb" },
      { ...custom, extra: true },
      { ...workday, region: undefined },
    ])
      await expect(updateRemoteOAuthServer({ serverId: before.id, server })).rejects.toThrow();
    // Nothing invalid was saved.
    expect(MCPSettingsManager.getServer(before.id)?.auth?.clientId).toBe("wrong-client");
    expect(
      RemoteOAuthServerUpdateSchema.safeParse({ serverId: "not-a-uuid", server: workday }).success,
    ).toBe(false);
    await expect(
      updateRemoteOAuthServer({ serverId: crypto.randomUUID(), server: workday }),
    ).rejects.toThrow(/not found/);
  });

  it("refuses to edit a server other than a Remote (OAuth) one", async () => {
    const local = MCPSettingsManager.addServer({
      name: "Local",
      enabled: true,
      transport: "stdio",
      command: "node",
    });
    await expect(updateRemoteOAuthServer({ serverId: local.id, server: workday })).rejects.toThrow(
      /Remote \(OAuth\)/,
    );
  });

  it("enforces admin connector policy like add", async () => {
    const before = addSignedIn();
    state.blocked = ["Blocked Workday"];
    await expect(
      updateRemoteOAuthServer({
        serverId: before.id,
        server: { ...workday, name: "Blocked Workday" },
      }),
    ).rejects.toThrow(/blocked by your administrator/);
    expect(MCPSettingsManager.getServer(before.id)?.name).toBe("Workday");
    expect(() => addRemoteOAuthServer({ ...workday, name: "Blocked Workday" })).toThrow(
      /blocked by your administrator/,
    );
  });
});

describe("cancelling a server's sign-in", () => {
  it("ends a pending sign-in quietly, releases the port and makes no token request", async () => {
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const tokenServer = http.createServer((_req, res) => res.writeHead(500).end());
    const tokenRequests = vi.fn();
    tokenServer.on("request", tokenRequests);
    await new Promise<void>((resolve) => tokenServer.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(tokenServer.address() as AddressInfo).port}`;
    try {
      const server = addRemoteOAuthServer({
        name: "Local",
        kind: "custom",
        grant: "authorization_code",
        clientId: "c",
        url: `${base}/mcp`,
        tokenUrl: `${base}/token`,
        authorizationUrl: `${base}/authorize`,
        redirectUri: `http://127.0.0.1:${port}/oauth/callback`,
      });
      let opened!: () => void;
      const openedPromise = new Promise<void>((resolve) => (opened = resolve));
      const pending = authorizeMcpServer(server.id, { openUrl: () => opened() }).catch(
        (error: unknown) => error,
      );
      await openedPromise;
      expect(cancelMcpServerSignIn(server.id)).toBe(true);
      const error = await pending;
      expect(isMcpSignInCancelled(error)).toBe(true);
      expect(cancelMcpServerSignIn(server.id)).toBe(false);
      expect(tokenRequests).not.toHaveBeenCalled();
      expect(state.connect).not.toHaveBeenCalled();
      expect(MCPSettingsManager.getServer(server.id)?.auth?.token).toBeUndefined();
      // The port is free again for the next sign-in.
      const reuse = http.createServer();
      await new Promise<void>((resolve, reject) => {
        reuse.once("error", reject);
        reuse.listen(port, "127.0.0.1", resolve);
      });
      await new Promise<void>((resolve) => reuse.close(() => resolve()));
    } finally {
      await new Promise<void>((resolve) => tokenServer.close(() => resolve()));
    }
  });
});
