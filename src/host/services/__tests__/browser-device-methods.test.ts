import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ControlPlaneSettingsManager,
  type ControlPlaneSettings,
} from "../../../electron/control-plane/settings";
import * as fleetManagerModule from "../../../electron/control-plane/fleet-manager";
import type {
  ManagedDevice,
  ManagedDeviceSummary,
  RemoteGatewayConfig,
  Workspace,
} from "../../../shared/types";
import { createBrowserDeviceDefinitions } from "../browser-device-methods";

const dbData = vi.hoisted(() => ({
  workspaces: [] as unknown[],
  tasks: [] as unknown[],
  channels: [] as unknown[],
  approvals: [] as unknown[],
  inputs: [] as unknown[],
  artifacts: new Map<string, unknown[]>(),
  profiles: [] as unknown[],
}));

vi.mock("../../../electron/database/repository-facades", () => {
  class WorkspaceRepository {
    async findAll() {
      return dbData.workspaces;
    }
  }
  class TaskRepository {
    async findAll(limit = 250) {
      return dbData.tasks.slice(0, limit);
    }
  }
  class ChannelRepository {
    async findAll() {
      return dbData.channels;
    }
  }
  class ApprovalRepository {
    async findAllPending() {
      return dbData.approvals;
    }
  }
  class InputRequestRepository {
    async list() {
      return dbData.inputs;
    }
  }
  class ArtifactRepository {
    async findByTaskId(taskId: string) {
      return dbData.artifacts.get(taskId) ?? [];
    }
  }
  class DeviceProfileRepository {
    async list() {
      return dbData.profiles;
    }
    async upsert() {
      return undefined;
    }
  }
  return {
    WorkspaceRepository,
    TaskRepository,
    ChannelRepository,
    ApprovalRepository,
    InputRequestRepository,
    ArtifactRepository,
    DeviceProfileRepository,
  };
});

const identity = {
  installationId: "install-1",
  profileId: "profile-1",
  generation: "generation-1",
  runtime: "node",
  platform: "linux",
  appVersion: "1.2.3",
} as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function createDefinitions() {
  return createBrowserDeviceDefinitions({
    db: {} as never,
    identity,
    resolveWorkspace: async (id) => {
      const workspace = dbData.workspaces.map(asRecord).find((entry) => entry.id === id);
      return workspace
        ? ({
            ...workspace,
            permissions: { ...asRecord(workspace.permissions) },
          } as unknown as Workspace)
        : null;
    },
  }).definitions;
}

function call(name: string, args: unknown[] = []) {
  const definition = createDefinitions()[name];
  if (!definition) throw new Error(`Missing method ${name}`);
  const validated = definition.validate ? definition.validate(args) : args;
  return definition.handler(validated, {} as never);
}

afterEach(() => {
  vi.restoreAllMocks();
  dbData.workspaces = [];
  dbData.tasks = [];
  dbData.channels = [];
  dbData.approvals = [];
  dbData.inputs = [];
  dbData.artifacts = new Map();
  dbData.profiles = [];
});

function settingsFixture(): ControlPlaneSettings {
  const config: RemoteGatewayConfig = {
    url: "wss://gateway.example.com/connect?tenant=production&api_key=url-api-secret&key=url-key-secret&token=url-token-secret&access_token=url-access-secret&authorization=url-auth-secret&password=url-password-secret&client_secret=url-client-secret",
    token: "remote-secret-token",
    deviceName: "Build host",
    sshTunnel: {
      enabled: true,
      host: "gateway.example.com",
      sshPort: 22,
      username: "cowork",
      keyPath: "/Users/private/.ssh/id_ed25519",
      localPort: 18789,
      remotePort: 18789,
    },
  };
  const device: ManagedDevice = {
    id: "device-1",
    name: "Build host",
    role: "remote",
    purpose: "work",
    transport: "ssh",
    status: "disconnected",
    platform: "linux",
    taskNodeId: "remote-gateway:device-1",
    config,
  } as const;
  return {
    enabled: true,
    port: 18789,
    host: "127.0.0.1",
    token: "host-only-token",
    handshakeTimeoutMs: 10000,
    heartbeatIntervalMs: 30000,
    maxPayloadBytes: 1024 * 1024,
    trustProxy: false,
    allowedOrigins: [],
    tailscale: { mode: "off", resetOnExit: true },
    connectionMode: "local",
    remote: config,
    managedDevices: [device],
    savedRemoteDevices: [{ id: "device-1", name: "Build host", config }],
    activeManagedDeviceId: "device-1",
    activeRemoteDeviceId: "device-1",
  };
}

describe("browser Devices definitions", () => {
  it("returns real local device metrics limited to effectively readable workspaces", async () => {
    dbData.workspaces = [
      { id: "allowed", name: "Allowed", path: "/work/allowed", permissions: { read: true } },
      { id: "denied", name: "Denied", path: "/work/denied", permissions: { read: true } },
      { id: "__temp_workspace__", name: "Temp", path: "/tmp/work", permissions: { read: true } },
    ];
    dbData.tasks = [
      {
        id: "visible-task",
        title: "Visible task",
        prompt: "private prompt",
        status: "executing",
        workspaceId: "allowed",
        createdAt: 1,
        updatedAt: 3,
      },
      {
        id: "hidden-task",
        title: "Hidden task",
        prompt: "private prompt",
        status: "executing",
        workspaceId: "denied",
        createdAt: 1,
        updatedAt: 2,
      },
    ];
    dbData.channels = [
      {
        id: "telegram-1",
        type: "telegram",
        name: "Ops",
        enabled: true,
        status: "connected",
        config: { botToken: "channel-secret" },
      },
    ];
    dbData.approvals = [{ id: "approval-1" }];
    dbData.inputs = [{ id: "input-1" }, { id: "input-2" }];
    dbData.artifacts.set("visible-task", [{ id: "artifact-1" }]);
    const definitions = createBrowserDeviceDefinitions({
      db: {} as never,
      identity,
      resolveWorkspace: async (id) => {
        const workspace = dbData.workspaces.map(asRecord).find((entry) => entry.id === id);
        if (!workspace) return null;
        return {
          ...workspace,
          permissions: { read: id === "allowed" },
        } as unknown as Workspace;
      },
    }).definitions;

    const result = (await definitions.getDeviceSummary.handler(
      ["local:this-device"],
      {} as never,
    )) as { ok: boolean; summary: ManagedDeviceSummary };

    expect(result.ok).toBe(true);
    expect(result.summary.tasks).toMatchObject({ total: 1, active: 1 });
    expect(result.summary.tasks.recent).toEqual([
      expect.objectContaining({ id: "visible-task", title: "Visible task" }),
    ]);
    expect(JSON.stringify(result)).not.toContain("private prompt");
    expect(result.summary.storage.workspaceRoots).toEqual([
      { id: "allowed", name: "Allowed", path: "/work/allowed" },
    ]);
    expect(result.summary.apps).toMatchObject({
      channelsTotal: 1,
      channelsEnabled: 1,
      approvalsPending: 1,
      inputRequestsPending: 2,
    });
    expect(JSON.stringify(result)).not.toContain("channel-secret");
  });

  it("redacts control-plane and remote secrets and SSH key paths from every returned config", async () => {
    vi.spyOn(ControlPlaneSettingsManager, "loadSettings").mockReturnValue(settingsFixture());
    vi.spyOn(fleetManagerModule, "getFleetConnectionManager").mockReturnValue(null);

    const settings = (await call("getControlPlaneSettings")) as {
      token: string;
      tokenConfigured: boolean;
      remote: Record<string, unknown>;
      managedDevices: ManagedDevice[];
    };
    const devices = (await call("listManagedDevices")) as { devices: ManagedDevice[] };
    const status = (await call("getRemoteGatewayStatus")) as { url?: string };
    const remoteConfig = settings.managedDevices[0].config as Record<string, unknown>;
    const sshTunnel = asRecord(remoteConfig.sshTunnel);
    const listedRemoteConfig = devices.devices[1].config as Record<string, unknown>;
    const listedSshTunnel = asRecord(listedRemoteConfig.sshTunnel);

    expect(settings.token).toBe("");
    expect(settings.tokenConfigured).toBe(true);
    expect(settings.remote.token).toBe("");
    expect(settings.remote.tokenConfigured).toBe(true);
    expect(settings.remote.url).toBe("wss://gateway.example.com/connect?tenant=production");
    expect(remoteConfig.token).toBe("");
    expect(sshTunnel.keyConfigured).toBe(true);
    expect(sshTunnel).not.toHaveProperty("keyPath");
    expect(listedSshTunnel).not.toHaveProperty("keyPath");
    expect(JSON.stringify({ settings, devices })).not.toContain("host-only-token");
    expect(JSON.stringify({ settings, devices })).not.toContain("remote-secret-token");
    expect(JSON.stringify({ settings, devices })).not.toContain("id_ed25519");
    expect(JSON.stringify({ settings, devices })).not.toContain("url-api-secret");
    expect(JSON.stringify({ settings, devices })).not.toContain("url-client-secret");
    expect(status.url).toBe("wss://gateway.example.com/connect?tenant=production");
    expect(JSON.stringify(status)).not.toContain("url-auth-secret");
  });

  it("preserves saved credentials and host-only SSH key paths while saving device arrays", async () => {
    const current = settingsFixture();
    vi.spyOn(ControlPlaneSettingsManager, "loadSettings").mockReturnValue(current);
    const update = vi.spyOn(ControlPlaneSettingsManager, "updateSettings").mockReturnValue(current);
    const config = {
      url: "wss://gateway.example.com/connect?tenant=production",
      token: "",
      tokenConfigured: true,
      deviceName: "Build host renamed",
      sshTunnel: {
        enabled: true,
        host: "gateway.example.com",
        sshPort: 22,
        username: "cowork",
        keyConfigured: true,
        localPort: 18789,
        remotePort: 18789,
      },
    };

    const result = (await call("saveControlPlaneSettings", [
      {
        managedDevices: [
          {
            id: "device-1",
            name: "Build host renamed",
            role: "remote",
            purpose: "work",
            transport: "ssh",
            status: "connected",
            platform: "linux",
            config,
          },
        ],
        savedRemoteDevices: [{ id: "device-1", name: "Build host renamed", config }],
        activeManagedDeviceId: "device-1",
        activeRemoteDeviceId: "device-1",
        remote: config,
      },
    ])) as { ok: boolean };

    expect(result).toEqual({ ok: true });
    expect(update).toHaveBeenCalledOnce();
    const saved = update.mock.calls[0]?.[0];
    expect(saved).not.toHaveProperty("token");
    expect(saved).not.toHaveProperty("host");
    expect(saved.managedDevices?.[0].config?.token).toBe("remote-secret-token");
    expect(saved.managedDevices?.[0].config?.sshTunnel?.keyPath).toBe(
      "/Users/private/.ssh/id_ed25519",
    );
    expect(saved.savedRemoteDevices?.[0].config.token).toBe("remote-secret-token");
    expect(saved.activeManagedDeviceId).toBe("device-1");
    expect(saved.managedDevices?.[0].config?.url).toBe(current.remote?.url);
    expect(saved.savedRemoteDevices?.[0].config.url).toBe(current.remote?.url);

    update.mockClear();
    const replaceResult = (await call("saveRemoteGatewayConfig", [
      {
        url: "wss://gateway.example.com/connect?tenant=production",
        token: "explicit-replacement",
        deviceName: "Build host",
      },
    ])) as { ok: boolean };
    expect(replaceResult.ok).toBe(true);
    const replacement = update.mock.calls[0]?.[0];
    expect(replacement?.remote?.token).toBe("explicit-replacement");
    expect(replacement?.managedDevices?.[0].config?.sshTunnel?.keyPath).toBe(
      "/Users/private/.ssh/id_ed25519",
    );
    expect(replacement?.remote?.url).toBe(current.remote?.url);
  });

  it("requires a fresh gateway token when changing the active device URL", async () => {
    const current = settingsFixture();
    vi.spyOn(ControlPlaneSettingsManager, "loadSettings").mockReturnValue(current);
    const update = vi.spyOn(ControlPlaneSettingsManager, "updateSettings").mockReturnValue(current);

    const result = (await call("saveRemoteGatewayConfig", [
      { url: "wss://attacker.example.com", token: "", deviceName: "Build host" },
    ])) as { ok: boolean };

    expect(result.ok).toBe(true);
    const saved = update.mock.calls[0]?.[0];
    expect(saved?.remote?.url).toBe("wss://attacker.example.com/");
    expect(saved?.remote?.token).toBe("");
    expect(saved?.managedDevices?.[0].config?.token).toBe("");
    expect(saved?.savedRemoteDevices?.[0].config.token).toBe("");
  });

  it("blocks generic Control Plane methods and requests to return account secrets", async () => {
    expect(() =>
      call("deviceProxyRequest", [{ deviceId: "device-1", method: "task.create", params: {} }]),
    ).toThrow(expect.objectContaining({ code: "INVALID_REQUEST", statusCode: 400 }));
    expect(() =>
      call("deviceProxyRequest", [
        { deviceId: "device-1", method: "account.list", params: { includeSecrets: true } },
      ]),
    ).toThrow(expect.objectContaining({ code: "INVALID_REQUEST", statusCode: 400 }));
    expect(() =>
      call("deviceProxyRequest", [
        {
          deviceId: "device-1",
          method: "channel.update",
          params: { channelId: "channel-1", config: { token: "unsafe" } },
        },
      ]),
    ).toThrow(expect.objectContaining({ code: "INVALID_REQUEST", statusCode: 400 }));
  });

  it("rejects arbitrary SSH key paths and non-WebSocket gateway URLs", async () => {
    expect(() =>
      call("saveRemoteGatewayConfig", [{ url: "https://example.com", token: "secret" }]),
    ).toThrow(expect.objectContaining({ code: "INVALID_REQUEST", statusCode: 400 }));
    expect(() =>
      call("saveRemoteGatewayConfig", [
        {
          url: "wss://example.com",
          token: "secret",
          sshTunnel: { enabled: false, keyPath: "/tmp/untrusted" },
        },
      ]),
    ).toThrow(expect.objectContaining({ code: "INVALID_REQUEST", statusCode: 400 }));
    expect(() =>
      call("saveRemoteGatewayConfig", [
        { url: "wss://new-gateway.example.com/connect?api_key=must-not-be-saved", token: "fresh" },
      ]),
    ).toThrow(expect.objectContaining({ code: "INVALID_REQUEST", statusCode: 400 }));
  });
});
