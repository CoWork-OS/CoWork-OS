import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  ManagedAccountManager,
  type ManagedAccountStatus,
} from "../../electron/accounts/managed-account-manager";
import {
  ApprovalRepository,
  ArtifactRepository,
  ChannelRepository,
  DeviceProfileRepository,
  InputRequestRepository,
  TaskRepository,
  WorkspaceRepository,
} from "../../electron/database/repository-facades";
import type { Channel } from "../../electron/database/repositories";
import type { ChannelGateway } from "../../electron/gateway";
import { Methods } from "../../electron/control-plane/protocol";
import {
  ControlPlaneSettingsManager,
  DEFAULT_REMOTE_GATEWAY_CONFIG,
  type ControlPlaneSettings,
} from "../../electron/control-plane/settings";
import {
  getFleetConnectionManager,
  initFleetConnectionManager,
  type FleetConnectionManager,
} from "../../electron/control-plane/fleet-manager";
import { RemoteGatewayClient } from "../../electron/control-plane/remote-client";
import {
  isTempWorkspaceId,
  LOCAL_MANAGED_DEVICE_ID,
  LOCAL_MANAGED_DEVICE_NODE_ID,
  type ControlPlaneSettingsData,
  type ManagedDevice,
  type ManagedDeviceAlert,
  type ManagedDeviceSummary,
  type RemoteGatewayConfig,
  type RemoteGatewayStatus,
  type SavedRemoteGatewayDevice,
  type SSHTunnelConfig,
  type Task,
  type Workspace,
} from "../../shared/types";
import type { HostIdentity } from "../../shared/host-api/contracts";
import { WebApplicationError } from "../web/WebApplication";
import type { BrowserDesktopDefinitions } from "./browser-desktop-rpc";

const ID = z
  .string()
  .trim()
  .min(1)
  .max(180)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const SHORT_TEXT = z.string().trim().min(1).max(256);
const DEVICE_PURPOSES = [
  "primary",
  "work",
  "personal",
  "automation",
  "archive",
  "general",
] as const;
const NODE_PLATFORMS = ["ios", "android", "macos", "linux", "windows"] as const;
const TASK_ACTIVE = new Set(["pending", "queued", "planning", "executing", "paused"]);
const TASK_ATTENTION = new Set([
  "blocked",
  "needs_user_action",
  "awaiting_approval",
  "awaiting_verification",
]);
const AUTH_QUERY_KEYS = new Set([
  "key",
  "apikey",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "subscriptiontoken",
  "bearertoken",
  "authorization",
  "password",
  "secret",
  "clientsecret",
  "credential",
]);

function isAuthQueryKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    AUTH_QUERY_KEYS.has(normalized) ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("token") ||
    normalized.endsWith("authorization") ||
    normalized.endsWith("password") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("credential")
  );
}

function redactUrlQueryCredentials(raw: string): string {
  try {
    const parsed = new URL(raw);
    let changed = false;
    for (const key of [...parsed.searchParams.keys()]) {
      if (!isAuthQueryKey(key)) continue;
      parsed.searchParams.delete(key);
      changed = true;
    }
    return changed ? parsed.toString() : raw;
  } catch {
    return raw;
  }
}

function hasUrlQueryCredentials(raw: string): boolean {
  try {
    return [...new URL(raw).searchParams.keys()].some(isAuthQueryKey);
  } catch {
    return false;
  }
}

function urlTargetWithoutQueryCredentials(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    for (const key of [...parsed.searchParams.keys()]) {
      if (isAuthQueryKey(key)) parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function sameGatewayTarget(left: string, right: string): boolean {
  const leftTarget = urlTargetWithoutQueryCredentials(left);
  return leftTarget !== null && leftTarget === urlTargetWithoutQueryCredentials(right);
}

function restoreSameTargetUrlQueryCredentials(incoming: string, current?: string): string {
  if (!current || hasUrlQueryCredentials(incoming)) return incoming;
  const incomingTarget = urlTargetWithoutQueryCredentials(incoming);
  if (!incomingTarget || incomingTarget !== urlTargetWithoutQueryCredentials(current)) {
    return incoming;
  }
  try {
    const restored = new URL(incoming);
    for (const [key, value] of new URL(current).searchParams) {
      if (isAuthQueryKey(key)) restored.searchParams.append(key, value);
    }
    return restored.toString();
  } catch {
    return incoming;
  }
}

function invalid(message = "Invalid browser action arguments."): never {
  throw new WebApplicationError("INVALID_REQUEST", message, 400);
}

function parseOne<T extends z.ZodTypeAny>(schema: T, args: unknown[]): z.infer<T> {
  if (args.length !== 1) return invalid();
  const parsed = schema.safeParse(args[0]);
  if (!parsed.success) return invalid();
  return parsed.data;
}

function rejectBrowserSshKeyPath(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) rejectBrowserSshKeyPath(entry);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "keyPath") return invalid("SSH key paths can only be configured on the host.");
    rejectBrowserSshKeyPath(entry);
  }
}

function parsePositional<T extends z.ZodTypeAny[]>(schemas: T, args: unknown[]): unknown[] {
  if (args.length < schemas.length - 1 || args.length > schemas.length) return invalid();
  return args.map((arg, index) => {
    if (arg === undefined && index === schemas.length - 1) return undefined;
    const parsed = schemas[index].safeParse(arg);
    if (!parsed.success) return invalid();
    return parsed.data;
  });
}

const SshTunnelSchema = z
  .object({
    enabled: z.boolean(),
    host: z.string().trim().max(253).optional(),
    sshPort: z.number().int().min(1).max(65535).optional(),
    username: z.string().trim().max(128).optional(),
    // Accepted for UI compatibility but deliberately discarded below. The host's
    // saved path is retained for an existing device; new devices use SSH defaults.
    keyPath: z.string().max(2048).optional(),
    keyConfigured: z.boolean().optional(),
    localPort: z.number().int().min(1).max(65535).optional(),
    remotePort: z.number().int().min(1).max(65535).optional(),
    remoteBindAddress: z.string().trim().max(253).optional(),
    autoReconnect: z.boolean().optional(),
    reconnectDelayMs: z.number().int().min(100).max(120_000).optional(),
    maxReconnectAttempts: z.number().int().min(0).max(100).optional(),
    connectionTimeoutMs: z.number().int().min(500).max(120_000).optional(),
  })
  .strip();

const RemoteConfigSchema = z
  .object({
    url: z.string().trim().min(1).max(2048),
    token: z.string().max(4096).optional(),
    tokenConfigured: z.boolean().optional(),
    tlsFingerprint: z.string().trim().max(256).optional(),
    deviceName: z.string().trim().max(200).optional(),
    autoReconnect: z.boolean().optional(),
    reconnectIntervalMs: z.number().int().min(250).max(120_000).optional(),
    maxReconnectAttempts: z.number().int().min(0).max(100).optional(),
    sshTunnel: SshTunnelSchema.optional(),
  })
  .strip();

const ManagedDeviceSchema = z
  .object({
    id: ID,
    name: SHORT_TEXT,
    role: z.literal("remote").optional(),
    purpose: z.enum(DEVICE_PURPOSES).optional(),
    transport: z.enum(["local", "direct", "ssh", "tailscale", "unknown"]).optional(),
    status: z
      .enum([
        "disconnected",
        "connecting",
        "authenticating",
        "connected",
        "reconnecting",
        "error",
        "local",
      ])
      .optional(),
    platform: z.enum(NODE_PLATFORMS).optional(),
    version: z.string().max(128).optional(),
    modelIdentifier: z.string().max(256).optional(),
    clientId: z.string().max(256).optional(),
    connectedAt: z.number().finite().optional(),
    lastSeenAt: z.number().finite().optional(),
    taskNodeId: z.string().max(256).nullable().optional(),
    tags: z.array(z.string().max(128)).max(32).optional(),
    config: RemoteConfigSchema,
    autoConnect: z.boolean().optional(),
    attentionState: z.enum(["none", "info", "warning", "critical"]).optional(),
    activeRunCount: z.number().int().min(0).max(100_000).optional(),
    storageSummary: z.record(z.string(), z.unknown()).optional(),
    appsSummary: z.record(z.string(), z.unknown()).optional(),
  })
  .strip();

const SavedDeviceSchema = z
  .object({
    id: ID,
    name: SHORT_TEXT,
    config: RemoteConfigSchema,
    clientId: z.string().max(256).optional(),
    connectedAt: z.number().finite().optional(),
    lastActivityAt: z.number().finite().optional(),
    autoConnect: z.boolean().optional(),
  })
  .strip();

function validateWebSocketUrl(raw: string): string {
  if (!/^wss?:\/\//i.test(raw)) {
    return invalid("Remote gateway URL must be a valid ws:// or wss:// URL.");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw, "ws://localhost");
  } catch {
    return invalid("Remote gateway URL must be a valid ws:// or wss:// URL.");
  }
  if (
    !["ws:", "wss:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    return invalid("Remote gateway URL must be a valid ws:// or wss:// URL.");
  }
  return parsed.toString();
}

function safeConfigInput(value: z.infer<typeof RemoteConfigSchema>): RemoteGatewayConfig {
  const url = validateWebSocketUrl(value.url);
  if (hasUrlQueryCredentials(url)) {
    return invalid("Remote gateway URLs cannot include credentials in query parameters.");
  }
  const ssh = value.sshTunnel;
  const { sshTunnel: _sshInput, tokenConfigured: _tokenConfigured, ...configInput } = value;
  if (ssh?.enabled && (!ssh.host?.trim() || !ssh.username?.trim())) {
    return invalid("SSH host and username are required when an SSH tunnel is enabled.");
  }
  if (
    ssh?.remoteBindAddress &&
    !["127.0.0.1", "localhost", "::1"].includes(ssh.remoteBindAddress)
  ) {
    return invalid("SSH tunnels must bind to the remote loopback interface.");
  }
  const sshTunnel: SSHTunnelConfig | undefined = ssh
    ? {
        enabled: ssh.enabled,
        host: ssh.host ?? "",
        sshPort: ssh.sshPort ?? 22,
        username: ssh.username ?? "",
        localPort: ssh.localPort ?? 18789,
        remotePort: ssh.remotePort ?? 18789,
        ...(ssh.remoteBindAddress ? { remoteBindAddress: ssh.remoteBindAddress } : {}),
        ...(ssh.autoReconnect !== undefined ? { autoReconnect: ssh.autoReconnect } : {}),
        ...(ssh.reconnectDelayMs ? { reconnectDelayMs: ssh.reconnectDelayMs } : {}),
        ...(ssh.maxReconnectAttempts !== undefined
          ? { maxReconnectAttempts: ssh.maxReconnectAttempts }
          : {}),
        ...(ssh.connectionTimeoutMs ? { connectionTimeoutMs: ssh.connectionTimeoutMs } : {}),
      }
    : undefined;
  return {
    ...DEFAULT_REMOTE_GATEWAY_CONFIG,
    ...configInput,
    url,
    token: typeof value.token === "string" ? value.token.trim() : "",
    ...(sshTunnel ? { sshTunnel } : {}),
  };
}

function redactConfig(
  config: RemoteGatewayConfig | undefined,
): Record<string, unknown> | undefined {
  if (!config) return undefined;
  const { token, sshTunnel, ...safe } = config;
  const ssh = sshTunnel
    ? (({ keyPath, ...safeTunnel }) => ({
        ...safeTunnel,
        keyConfigured: Boolean(keyPath),
      }))(sshTunnel)
    : undefined;
  return {
    ...safe,
    url: redactUrlQueryCredentials(safe.url),
    token: "",
    tokenConfigured: Boolean(token),
    ...(ssh ? { sshTunnel: ssh } : {}),
  };
}

function redactRemoteConfig(
  config: RemoteGatewayConfig | undefined,
): RemoteGatewayConfig | undefined {
  const safe = redactConfig(config);
  return safe ? (safe as unknown as RemoteGatewayConfig) : undefined;
}

function redactManagedDevice(device: ManagedDevice): ManagedDevice {
  return {
    ...device,
    config: redactRemoteConfig(device.config),
  };
}

function displayStatus(status: RemoteGatewayStatus): RemoteGatewayStatus {
  let url: string | undefined;
  if (status.url) {
    try {
      url = redactUrlQueryCredentials(validateWebSocketUrl(status.url));
    } catch {
      url = undefined;
    }
  }
  return {
    state: status.state,
    ...(url ? { url } : {}),
    ...(status.connectedAt ? { connectedAt: status.connectedAt } : {}),
    ...(status.clientId ? { clientId: status.clientId } : {}),
    ...(status.scopes
      ? { scopes: status.scopes.filter((scope) => /^[A-Za-z0-9._:-]{1,100}$/.test(scope)) }
      : {}),
    ...(status.error ? { error: "Connection failed. Check the saved device configuration." } : {}),
    ...(status.reconnectAttempts !== undefined
      ? { reconnectAttempts: status.reconnectAttempts }
      : {}),
    ...(status.lastActivityAt ? { lastActivityAt: status.lastActivityAt } : {}),
    ...(status.sshTunnel
      ? {
          sshTunnel: {
            state: status.sshTunnel.state,
            ...(status.sshTunnel.connectedAt ? { connectedAt: status.sshTunnel.connectedAt } : {}),
            ...(status.sshTunnel.reconnectAttempts !== undefined
              ? { reconnectAttempts: status.sshTunnel.reconnectAttempts }
              : {}),
            ...(status.sshTunnel.error ? { error: "SSH tunnel failed." } : {}),
          },
        }
      : {}),
  };
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sanitizeChannel(channel: unknown): Record<string, unknown> {
  const input = objectRecord(channel);
  return {
    id: typeof input.id === "string" ? input.id.slice(0, 180) : "",
    type: typeof input.type === "string" ? input.type.slice(0, 80) : "unknown",
    name: typeof input.name === "string" ? input.name.slice(0, 200) : "Connection",
    enabled: input.enabled === true,
    status: typeof input.status === "string" ? input.status.slice(0, 80) : "unknown",
  };
}

function sanitizeAccount(account: unknown): Record<string, unknown> {
  const input = objectRecord(account);
  const safe: Record<string, unknown> = {
    id: typeof input.id === "string" ? input.id.slice(0, 180) : "",
    provider: typeof input.provider === "string" ? input.provider.slice(0, 128) : "unknown",
    label: typeof input.label === "string" ? input.label.slice(0, 160) : undefined,
    status: typeof input.status === "string" ? input.status.slice(0, 40) : "unknown",
    secretCount:
      typeof input.secretCount === "number" && Number.isFinite(input.secretCount)
        ? Math.max(0, Math.min(64, Math.floor(input.secretCount)))
        : Array.isArray(input.secretKeys)
          ? Math.min(64, input.secretKeys.length)
          : 0,
  };
  for (const key of ["signupUrl", "dashboardUrl", "docsUrl"]) {
    if (typeof input[key] !== "string") continue;
    try {
      const url = new URL(input[key] as string);
      if (url.protocol === "https:" && !url.username && !url.password) safe[key] = url.toString();
    } catch {
      // Invalid links are omitted.
    }
  }
  return safe;
}

function listStoredDevices(settings: ControlPlaneSettings): ManagedDevice[] {
  const devices = new Map<string, ManagedDevice>();
  for (const device of settings.managedDevices ?? []) {
    if (device?.id && device.role === "remote" && device.config) devices.set(device.id, device);
  }
  for (const saved of settings.savedRemoteDevices ?? []) {
    if (!saved?.id || !saved.config || devices.has(saved.id)) continue;
    devices.set(saved.id, savedToManagedDevice(saved));
  }
  if (settings.remote?.url && settings.remote.token) {
    const id =
      (settings.activeManagedDeviceId && settings.activeManagedDeviceId !== LOCAL_MANAGED_DEVICE_ID
        ? settings.activeManagedDeviceId
        : settings.activeRemoteDeviceId) || `remote:${settings.remote.url}`;
    if (!devices.has(id)) {
      devices.set(
        id,
        savedToManagedDevice({
          id,
          name: settings.remote.deviceName || "CoWork Remote Client",
          config: settings.remote,
        }),
      );
    }
  }
  return [...devices.values()];
}

function savedToManagedDevice(saved: SavedRemoteGatewayDevice): ManagedDevice {
  let transport: ManagedDevice["transport"] = "direct";
  try {
    const hostname = new URL(saved.config.url).hostname;
    if (saved.config.sshTunnel?.enabled) transport = "ssh";
    else if (hostname.endsWith(".ts.net")) transport = "tailscale";
    else if (["127.0.0.1", "localhost", "::1"].includes(hostname)) transport = "direct";
  } catch {
    transport = "unknown";
  }
  return {
    id: saved.id,
    name: saved.name || saved.config.deviceName || "Remote Device",
    role: "remote",
    purpose: "general",
    transport,
    status: "disconnected",
    platform: "linux",
    clientId: saved.clientId,
    connectedAt: saved.connectedAt,
    lastSeenAt: saved.lastActivityAt || saved.connectedAt,
    taskNodeId: `remote-gateway:${saved.id}`,
    config: { ...DEFAULT_REMOTE_GATEWAY_CONFIG, ...saved.config },
    autoConnect: saved.autoConnect === true,
    attentionState: "none",
    activeRunCount: 0,
    storageSummary: { workspaceCount: 0, artifactCount: 0 },
    appsSummary: {
      channelsTotal: 0,
      channelsEnabled: 0,
      workspacesTotal: 0,
      approvalsPending: 0,
      inputRequestsPending: 0,
    },
  };
}

function mergeRemoteConfig(
  incoming: RemoteGatewayConfig,
  current: RemoteGatewayConfig | undefined,
): RemoteGatewayConfig {
  const merged = { ...DEFAULT_REMOTE_GATEWAY_CONFIG, ...current, ...incoming };
  merged.url = restoreSameTargetUrlQueryCredentials(incoming.url, current?.url);
  if (!incoming.token?.trim() && current?.token && sameGatewayTarget(incoming.url, current.url)) {
    merged.token = current.token;
  }
  if (current?.sshTunnel?.keyPath || merged.sshTunnel) {
    const base = merged.sshTunnel ?? current?.sshTunnel;
    merged.sshTunnel = {
      enabled: base?.enabled ?? false,
      host: base?.host ?? "",
      sshPort: base?.sshPort ?? 22,
      username: base?.username ?? "",
      localPort: base?.localPort ?? 18789,
      remotePort: base?.remotePort ?? 18789,
      ...(base?.remoteBindAddress ? { remoteBindAddress: base.remoteBindAddress } : {}),
      ...(base?.autoReconnect !== undefined ? { autoReconnect: base.autoReconnect } : {}),
      ...(base?.reconnectDelayMs !== undefined ? { reconnectDelayMs: base.reconnectDelayMs } : {}),
      ...(base?.maxReconnectAttempts !== undefined
        ? { maxReconnectAttempts: base.maxReconnectAttempts }
        : {}),
      ...(base?.connectionTimeoutMs !== undefined
        ? { connectionTimeoutMs: base.connectionTimeoutMs }
        : {}),
      ...(current?.sshTunnel?.keyPath ? { keyPath: current.sshTunnel.keyPath } : {}),
    };
  }
  return merged;
}

function mergeConfigFromSettings(
  config: RemoteGatewayConfig,
  settings: ControlPlaneSettings,
  deviceId?: string,
): RemoteGatewayConfig {
  const sameDevice = deviceId
    ? listStoredDevices(settings).find((device) => device.id === deviceId)?.config
    : undefined;
  const current =
    sameDevice ||
    listStoredDevices(settings).find(
      (device) => device.config?.url && sameGatewayTarget(device.config.url, config.url),
    )?.config ||
    (settings.remote?.url && sameGatewayTarget(settings.remote.url, config.url)
      ? settings.remote
      : undefined);
  return mergeRemoteConfig(config, current);
}

function normalizeManagedDevice(
  raw: z.infer<typeof ManagedDeviceSchema>,
  oldById: Map<string, ManagedDevice>,
): ManagedDevice {
  const previous = oldById.get(raw.id);
  const parsedConfig = safeConfigInput(raw.config);
  const config = mergeRemoteConfig(parsedConfig, previous?.config);
  let transport = raw.transport ?? "direct";
  if (config.sshTunnel?.enabled) transport = "ssh";
  return {
    id: raw.id,
    name: raw.name,
    role: "remote",
    purpose: raw.purpose ?? previous?.purpose ?? "general",
    transport,
    status: previous?.status ?? "disconnected",
    platform: raw.platform ?? previous?.platform ?? "linux",
    ...((raw.version ?? previous?.version) ? { version: raw.version ?? previous?.version } : {}),
    ...((raw.modelIdentifier ?? previous?.modelIdentifier)
      ? { modelIdentifier: raw.modelIdentifier ?? previous?.modelIdentifier }
      : {}),
    ...(previous?.clientId ? { clientId: previous.clientId } : {}),
    ...(previous?.connectedAt ? { connectedAt: previous.connectedAt } : {}),
    ...(previous?.lastSeenAt ? { lastSeenAt: previous.lastSeenAt } : {}),
    taskNodeId: `remote-gateway:${raw.id}`,
    ...(raw.tags ? { tags: raw.tags } : {}),
    config,
    autoConnect: raw.autoConnect ?? previous?.autoConnect ?? false,
    attentionState: previous?.attentionState ?? "none",
    activeRunCount: previous?.activeRunCount ?? 0,
    storageSummary: previous?.storageSummary ?? { workspaceCount: 0, artifactCount: 0 },
    appsSummary: previous?.appsSummary ?? {
      channelsTotal: 0,
      channelsEnabled: 0,
      workspacesTotal: 0,
      approvalsPending: 0,
      inputRequestsPending: 0,
    },
  };
}

function normalizeSavedDevice(
  raw: z.infer<typeof SavedDeviceSchema>,
  oldById: Map<string, ManagedDevice>,
): SavedRemoteGatewayDevice {
  const previous = oldById.get(raw.id);
  return {
    id: raw.id,
    name: raw.name,
    config: mergeRemoteConfig(safeConfigInput(raw.config), previous?.config),
    ...(previous?.clientId ? { clientId: previous.clientId } : {}),
    ...(previous?.connectedAt ? { connectedAt: previous.connectedAt } : {}),
    ...(previous?.lastSeenAt ? { lastActivityAt: previous.lastSeenAt } : {}),
    autoConnect: raw.autoConnect ?? previous?.autoConnect ?? false,
  };
}

function redactSettings(settings: ControlPlaneSettings): ControlPlaneSettingsData & {
  tokenConfigured: boolean;
} {
  const devices = listStoredDevices(settings).map(redactManagedDevice);
  const safeById = new Map(devices.map((device) => [device.id, device]));
  const savedRemoteDevices = (settings.savedRemoteDevices ?? []).flatMap((saved) => {
    const config = safeById.get(saved.id)?.config;
    if (!config) return [];
    return [
      {
        id: saved.id,
        name: saved.name,
        config: redactRemoteConfig(config) as RemoteGatewayConfig,
        ...(saved.clientId ? { clientId: saved.clientId } : {}),
        ...(saved.connectedAt ? { connectedAt: saved.connectedAt } : {}),
        ...(saved.lastActivityAt ? { lastActivityAt: saved.lastActivityAt } : {}),
        autoConnect: saved.autoConnect === true,
      },
    ];
  });
  return {
    enabled: settings.enabled,
    port: settings.port,
    host: settings.host,
    token: "",
    tokenConfigured: Boolean(settings.token),
    handshakeTimeoutMs: settings.handshakeTimeoutMs,
    heartbeatIntervalMs: settings.heartbeatIntervalMs,
    maxPayloadBytes: settings.maxPayloadBytes,
    tailscale: { ...settings.tailscale },
    connectionMode: settings.connectionMode,
    ...(settings.remote
      ? { remote: redactRemoteConfig(settings.remote) as RemoteGatewayConfig }
      : {}),
    savedRemoteDevices,
    activeRemoteDeviceId: settings.activeRemoteDeviceId,
    managedDevices: devices,
    activeManagedDeviceId: settings.activeManagedDeviceId,
  };
}

function safeTask(task: Task): Partial<Task> {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    workspaceId: task.workspaceId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.completedAt !== undefined ? { completedAt: task.completedAt } : {}),
    ...(task.terminalStatus ? { terminalStatus: task.terminalStatus } : {}),
    ...(task.targetNodeId ? { targetNodeId: task.targetNodeId } : {}),
    ...(task.error ? { error: "Task reported an error." } : {}),
  };
}

function safeAlert(alert: ManagedDeviceAlert): ManagedDeviceAlert {
  return {
    id: alert.id.slice(0, 180),
    level: alert.level,
    title: alert.title.slice(0, 160),
    kind: alert.kind,
  };
}

function alertForPending(
  kind: "approval" | "input_request",
  count: number,
): ManagedDeviceAlert | null {
  if (!count) return null;
  return {
    id: `${kind}:pending`,
    level: "warning",
    title: `${count} ${kind === "approval" ? "approval" : "input request"}${count === 1 ? "" : "s"} pending`,
    kind,
  };
}

function accountList(params?: unknown): unknown {
  const input = objectRecord(params);
  return {
    accounts: ManagedAccountManager.list({
      provider: typeof input.provider === "string" ? input.provider : undefined,
      status: typeof input.status === "string" ? (input.status as ManagedAccountStatus) : undefined,
    }).map((account) => sanitizeAccount(ManagedAccountManager.toPublicView(account, false))),
  };
}

function channelList(channels: unknown[]): unknown {
  return { channels: channels.map(sanitizeChannel) };
}

function safeRpcResult(method: string, result: unknown): unknown {
  const payload = objectRecord(result);
  if (method === Methods.CHANNEL_LIST) {
    return channelList(Array.isArray(payload.channels) ? payload.channels : []);
  }
  if (method === Methods.ACCOUNT_LIST) {
    return {
      accounts: Array.isArray(payload.accounts) ? payload.accounts.map(sanitizeAccount) : [],
    };
  }
  if (method === Methods.CHANNEL_CREATE) {
    return {
      channelId: typeof payload.channelId === "string" ? payload.channelId.slice(0, 180) : "",
    };
  }
  if (method === Methods.CHANNEL_TEST) {
    return {
      success: payload.success === true || payload.ok === true,
      ...(payload.success === false || payload.ok === false
        ? { error: "Connection test failed." }
        : {}),
    };
  }
  return { ok: true, ...(payload.restartRequired === true ? { restartRequired: true } : {}) };
}

const AccountListParamsSchema = z
  .object({
    includeSecrets: z.literal(false).optional(),
    provider: z.string().trim().max(128).optional(),
    status: z
      .enum([
        "draft",
        "pending_signup",
        "pending_verification",
        "active",
        "blocked",
        "disabled",
        "error",
      ])
      .optional(),
  })
  .strict();
const ChannelIdParamsSchema = z.object({ channelId: ID }).strict();
const ChannelCreateSchemas: Record<string, z.ZodTypeAny> = {
  whatsapp: z
    .object({
      type: z.literal("whatsapp"),
      name: SHORT_TEXT,
      enabled: z.boolean().optional(),
      securityConfig: z
        .object({ mode: z.enum(["open", "allowlist", "pairing"]) })
        .strict()
        .optional(),
      config: z
        .object({
          allowedNumbers: z.array(z.string().max(128)).max(500).optional(),
          selfChatMode: z.boolean().optional(),
          responsePrefix: z.string().max(128).optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  telegram: z
    .object({
      type: z.literal("telegram"),
      name: SHORT_TEXT,
      enabled: z.boolean().optional(),
      securityConfig: z
        .object({ mode: z.enum(["open", "allowlist", "pairing"]) })
        .strict()
        .optional(),
      config: z
        .object({ botToken: z.string().max(4096).optional() })
        .strict()
        .optional(),
    })
    .strict(),
  slack: z
    .object({
      type: z.literal("slack"),
      name: SHORT_TEXT,
      enabled: z.boolean().optional(),
      securityConfig: z
        .object({ mode: z.enum(["open", "allowlist", "pairing"]) })
        .strict()
        .optional(),
      config: z
        .object({
          botToken: z.string().max(4096).optional(),
          appToken: z.string().max(4096).optional(),
          signingSecret: z.string().max(4096).optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  teams: z
    .object({
      type: z.literal("teams"),
      name: SHORT_TEXT,
      enabled: z.boolean().optional(),
      securityConfig: z
        .object({ mode: z.enum(["open", "allowlist", "pairing"]) })
        .strict()
        .optional(),
      config: z
        .object({
          appId: z.string().max(256).optional(),
          appPassword: z.string().max(4096).optional(),
          tenantId: z.string().max(256).optional(),
          webhookPort: z.number().int().min(1).max(65535).optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  email: z
    .object({
      type: z.literal("email"),
      name: SHORT_TEXT,
      enabled: z.boolean().optional(),
      securityConfig: z
        .object({ mode: z.enum(["open", "allowlist", "pairing"]) })
        .strict()
        .optional(),
      config: z
        .union([
          z
            .object({
              protocol: z.literal("imap-smtp"),
              email: z.string().max(320).optional(),
              password: z.string().max(4096).optional(),
              imapHost: z.string().max(253).optional(),
              smtpHost: z.string().max(253).optional(),
              imapPort: z.number().int().min(1).max(65535).optional(),
              smtpPort: z.number().int().min(1).max(65535).optional(),
              displayName: z.string().max(200).optional(),
            })
            .strict(),
          z
            .object({
              protocol: z.literal("loom"),
              loomBaseUrl: z.string().max(2048).optional(),
              loomAccessToken: z.string().max(4096).optional(),
              loomIdentity: z.string().max(320).optional(),
              mailboxFolder: z.string().max(256).optional(),
            })
            .strict(),
        ])
        .optional(),
    })
    .strict(),
};

function parseChannelCreate(value: unknown): Record<string, unknown> {
  const record = objectRecord(value);
  const type = record.type;
  const schema = typeof type === "string" ? ChannelCreateSchemas[type] : undefined;
  if (!schema) return invalid("This channel type cannot be configured from the browser.");
  const parsed = schema.safeParse(value);
  if (!parsed.success) return invalid();
  const result = parsed.data as Record<string, unknown>;
  const security = objectRecord(result.securityConfig);
  return {
    ...result,
    enabled: result.enabled === true,
    securityConfig: { mode: security.mode ?? "pairing" },
    config: objectRecord(result.config),
  };
}

function validateProxyRequest(value: unknown): {
  deviceId: string;
  method: string;
  params?: unknown;
} {
  const record = objectRecord(value);
  if (Object.keys(record).some((key) => !["deviceId", "method", "params"].includes(key)))
    return invalid();
  const deviceId = ID.safeParse(record.deviceId);
  const method = SHORT_TEXT.safeParse(record.method);
  if (!deviceId.success || !method.success) return invalid();
  if (record.method === Methods.CHANNEL_LIST) {
    if (record.params !== undefined) return invalid();
    return { deviceId: deviceId.data, method: method.data };
  }
  if (record.method === Methods.ACCOUNT_LIST) {
    const params = AccountListParamsSchema.safeParse(record.params ?? {});
    if (!params.success) return invalid();
    return {
      deviceId: deviceId.data,
      method: method.data,
      params: { ...params.data, includeSecrets: false },
    };
  }
  if (record.method === Methods.CHANNEL_CREATE) {
    return {
      deviceId: deviceId.data,
      method: method.data,
      params: parseChannelCreate(record.params),
    };
  }
  if (
    [
      Methods.CHANNEL_ENABLE,
      Methods.CHANNEL_DISABLE,
      Methods.CHANNEL_TEST,
      Methods.CHANNEL_REMOVE,
    ].includes(record.method as never)
  ) {
    const params = ChannelIdParamsSchema.safeParse(record.params);
    if (!params.success) return invalid();
    return { deviceId: deviceId.data, method: method.data, params: params.data };
  }
  return invalid("This device operation is not available from the browser.");
}

function isLocalDevice(deviceId: string): boolean {
  return deviceId === LOCAL_MANAGED_DEVICE_ID || deviceId === LOCAL_MANAGED_DEVICE_NODE_ID;
}

function getSettings(): ControlPlaneSettings {
  return ControlPlaneSettingsManager.loadSettings();
}

function getFleet(create = false): FleetConnectionManager | null {
  return getFleetConnectionManager() ?? (create ? initFleetConnectionManager() : null);
}

function findDevice(settings: ControlPlaneSettings, deviceId: string): ManagedDevice | undefined {
  return listStoredDevices(settings).find(
    (device) => device.id === deviceId || device.taskNodeId === deviceId,
  );
}

function getActiveRemoteDeviceId(settings: ControlPlaneSettings): string | undefined {
  if (
    settings.activeManagedDeviceId &&
    settings.activeManagedDeviceId !== LOCAL_MANAGED_DEVICE_ID
  ) {
    return settings.activeManagedDeviceId;
  }
  return settings.activeRemoteDeviceId || listStoredDevices(settings)[0]?.id;
}

function requireRemoteDevice(settings: ControlPlaneSettings, deviceId: string): ManagedDevice {
  const device = findDevice(settings, deviceId);
  if (!device || device.role !== "remote") {
    throw new WebApplicationError("INVALID_REQUEST", "Remote device was not found.", 404);
  }
  return device;
}

function safeError(): { ok: false; error: string } {
  return { ok: false, error: "The device operation failed. Check the saved device configuration." };
}

function mergeSettingsDevices(
  input: Record<string, unknown>,
  current: ControlPlaneSettings,
): Pick<
  ControlPlaneSettings,
  "managedDevices" | "savedRemoteDevices" | "activeManagedDeviceId" | "activeRemoteDeviceId"
> {
  const oldDevices = listStoredDevices(current);
  const oldById = new Map(oldDevices.map((device) => [device.id, device]));
  let managedDevices = current.managedDevices ?? oldDevices;
  let savedRemoteDevices = current.savedRemoteDevices ?? [];
  if (Array.isArray(input.managedDevices)) {
    managedDevices = input.managedDevices.map((device) => {
      const parsed = ManagedDeviceSchema.safeParse(device);
      if (!parsed.success) return invalid();
      return normalizeManagedDevice(parsed.data, oldById);
    });
    if (managedDevices.length > 128) return invalid();
  }
  if (Array.isArray(input.savedRemoteDevices)) {
    savedRemoteDevices = input.savedRemoteDevices.map((device) => {
      const parsed = SavedDeviceSchema.safeParse(device);
      if (!parsed.success) return invalid();
      return normalizeSavedDevice(parsed.data, oldById);
    });
    if (savedRemoteDevices.length > 128) return invalid();
  }
  if (Array.isArray(input.managedDevices) && !Array.isArray(input.savedRemoteDevices)) {
    savedRemoteDevices = managedDevices.map((device) => ({
      id: device.id,
      name: device.name,
      config: device.config as RemoteGatewayConfig,
      autoConnect: device.autoConnect,
      ...(device.clientId ? { clientId: device.clientId } : {}),
      ...(device.connectedAt ? { connectedAt: device.connectedAt } : {}),
      ...(device.lastSeenAt ? { lastActivityAt: device.lastSeenAt } : {}),
    }));
  }
  if (Array.isArray(input.savedRemoteDevices) && !Array.isArray(input.managedDevices)) {
    managedDevices = savedRemoteDevices.map(savedToManagedDevice);
  }
  const managedIds = new Set(managedDevices.map((device) => device.id));
  const requestedManagedId =
    input.activeManagedDeviceId === undefined
      ? current.activeManagedDeviceId
      : input.activeManagedDeviceId;
  const activeManagedDeviceId =
    typeof requestedManagedId === "string" && managedIds.has(requestedManagedId)
      ? requestedManagedId
      : LOCAL_MANAGED_DEVICE_ID;
  const requestedRemoteId =
    input.activeRemoteDeviceId === undefined
      ? current.activeRemoteDeviceId
      : input.activeRemoteDeviceId;
  const activeRemoteDeviceId =
    typeof requestedRemoteId === "string" && managedIds.has(requestedRemoteId)
      ? requestedRemoteId
      : undefined;
  return { managedDevices, savedRemoteDevices, activeManagedDeviceId, activeRemoteDeviceId };
}

function saveRemoteDevice(
  settings: ControlPlaneSettings,
  input: RemoteGatewayConfig,
  preferredId?: string,
  updateLegacyRemote = false,
): ManagedDevice {
  const current = listStoredDevices(settings);
  const match =
    (preferredId ? current.find((device) => device.id === preferredId) : undefined) ||
    current.find((device) => device.config?.url && sameGatewayTarget(device.config.url, input.url));
  const id = match?.id || preferredId || `remote-device:${randomUUID()}`;
  const config = mergeConfigFromSettings(input, settings, match?.id);
  const name = config.deviceName?.trim() || match?.name || "CoWork Remote Client";
  const device: ManagedDevice = {
    ...(match ?? savedToManagedDevice({ id, name, config })),
    id,
    name,
    role: "remote",
    config,
    purpose: match?.purpose ?? "general",
    transport: config.sshTunnel?.enabled ? "ssh" : (match?.transport ?? "direct"),
    status: getFleet()?.getStatus(id).state ?? "disconnected",
    taskNodeId: `remote-gateway:${id}`,
  };
  const managedDevices = current.filter((entry) => entry.id !== id).concat(device);
  const savedRemoteDevices = managedDevices.map((entry) => ({
    id: entry.id,
    name: entry.name,
    config: entry.config as RemoteGatewayConfig,
    autoConnect: entry.autoConnect === true,
    ...(entry.clientId ? { clientId: entry.clientId } : {}),
    ...(entry.connectedAt ? { connectedAt: entry.connectedAt } : {}),
    ...(entry.lastSeenAt ? { lastActivityAt: entry.lastSeenAt } : {}),
  }));
  ControlPlaneSettingsManager.updateSettings({
    ...(updateLegacyRemote ? { remote: config } : {}),
    managedDevices,
    savedRemoteDevices,
    activeManagedDeviceId: id,
    activeRemoteDeviceId: id,
  });
  return device;
}

function sanitizeDeviceProfile(profile: Record<string, unknown>): Record<string, unknown> {
  return {
    deviceId: typeof profile.deviceId === "string" ? profile.deviceId : "",
    customName: typeof profile.customName === "string" ? profile.customName : null,
    platform: typeof profile.platform === "string" ? profile.platform : null,
    modelIdentifier: typeof profile.modelIdentifier === "string" ? profile.modelIdentifier : null,
    lastSeenAt: typeof profile.lastSeenAt === "number" ? profile.lastSeenAt : null,
    createdAt: typeof profile.createdAt === "number" ? profile.createdAt : 0,
    updatedAt: typeof profile.updatedAt === "number" ? profile.updatedAt : 0,
  };
}

export interface BrowserDeviceOptions {
  db: Database.Database;
  identity: HostIdentity;
  resolveWorkspace: (workspaceId: string) => Promise<Workspace | null>;
  channelGateway?: Pick<
    ChannelGateway,
    "getChannels" | "enableChannel" | "disableChannel" | "removeChannel" | "testChannel"
  >;
}

export function createBrowserDeviceDefinitions(options: BrowserDeviceOptions): {
  definitions: BrowserDesktopDefinitions;
  dispose: () => void;
} {
  const { db, identity } = options;
  const workspaces = new WorkspaceRepository(db);
  const tasks = new TaskRepository(db);
  const channels = new ChannelRepository(db);
  const approvals = new ApprovalRepository(db);
  const inputs = new InputRequestRepository(db);
  const artifactRepository = new ArtifactRepository(db);
  const profileRepository = new DeviceProfileRepository(db);

  const workspaceSnapshot = async () => {
    const all = await workspaces.findAll();
    const resolved = await Promise.all(
      all
        .filter((workspace) => !workspace.isTemp && !isTempWorkspaceId(workspace.id))
        .map((workspace) => options.resolveWorkspace(workspace.id)),
    );
    return resolved.filter((workspace): workspace is Workspace =>
      Boolean(
        workspace?.permissions?.read && !workspace.isTemp && !isTempWorkspaceId(workspace.id),
      ),
    );
  };

  const localChannels = async (): Promise<unknown[]> => {
    const list = options.channelGateway
      ? await options.channelGateway.getChannels()
      : await channels.findAll();
    return list.map(sanitizeChannel);
  };

  const localSummary = async (): Promise<ManagedDeviceSummary> => {
    const [visibleWorkspaces, taskRows, channelRows, approvalRows, inputRows] = await Promise.all([
      workspaceSnapshot(),
      tasks.findAll(250, 0),
      channels.findAll(),
      approvals.findAllPending(),
      inputs.list({ limit: 100, offset: 0, status: "pending" }),
    ]);
    const workspaceById = new Map(visibleWorkspaces.map((workspace) => [workspace.id, workspace]));
    const localTasks = taskRows
      .filter(
        (task) =>
          (!task.targetNodeId || isLocalDevice(task.targetNodeId)) &&
          workspaceById.has(task.workspaceId),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const channelList = channelRows.map(sanitizeChannel);
    const active = localTasks.filter((task) => TASK_ACTIVE.has(task.status)).length;
    const pendingApprovals = Math.min(100, approvalRows.length);
    const pendingInputs = Math.min(100, inputRows.length);
    const alertItems = [
      alertForPending("approval", pendingApprovals),
      alertForPending("input_request", pendingInputs),
      ...localTasks
        .filter((task) => TASK_ATTENTION.has(String(task.terminalStatus || task.status)))
        .slice(0, 8)
        .map((task) => ({
          id: `task:${task.id}`,
          level: "warning" as const,
          title: "Task needs attention",
          kind: "status" as const,
        })),
    ].filter((alert): alert is ManagedDeviceAlert => alert !== null);
    const artifactCount = await countVisibleArtifacts(artifactRepository, localTasks);
    const localDevice: ManagedDevice = {
      id: LOCAL_MANAGED_DEVICE_ID,
      name: "This device",
      role: "local",
      purpose: "primary",
      transport: "local",
      status: "local",
      platform:
        identity.platform === "darwin"
          ? "macos"
          : identity.platform === "win32"
            ? "windows"
            : identity.platform === "linux"
              ? "linux"
              : "linux",
      version: identity.appVersion,
      taskNodeId: LOCAL_MANAGED_DEVICE_NODE_ID,
      attentionState: alertItems.length ? "warning" : "none",
      activeRunCount: active,
      storageSummary: { workspaceCount: visibleWorkspaces.length, artifactCount },
      appsSummary: {
        channelsTotal: channelList.length,
        channelsEnabled: channelList.filter((channel) => channel.enabled === true).length,
        workspacesTotal: visibleWorkspaces.length,
        approvalsPending: pendingApprovals,
        inputRequestsPending: pendingInputs,
      },
    };
    const bytes = await getDiskSummary(visibleWorkspaces[0]?.path);
    const storage = {
      workspaceCount: visibleWorkspaces.length,
      artifactCount,
      ...(bytes ? { ...bytes } : {}),
      workspaceRoots: visibleWorkspaces.map(({ id, name, path }) => ({ id, name, path })),
    };
    const safeRecent = localTasks.slice(0, 12).map((task) => safeTask(task) as Task);
    const accounts = ManagedAccountManager.list().map((account) =>
      sanitizeAccount(ManagedAccountManager.toPublicView(account, false)),
    );
    const alerts = alertItems.map(safeAlert);
    return {
      device: localDevice,
      runtime: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        ...(identity.appVersion ? { coworkVersion: identity.appVersion } : {}),
        activeProfileId: identity.profileId,
        headless: identity.runtime === "node",
      },
      tasks: {
        total: localTasks.length,
        active,
        attention: localTasks.filter((task) =>
          TASK_ATTENTION.has(String(task.terminalStatus || task.status)),
        ).length,
        recent: safeRecent,
      },
      apps: {
        channelsTotal: channelList.length,
        channelsEnabled: channelList.filter((channel) => channel.enabled === true).length,
        workspacesTotal: visibleWorkspaces.length,
        approvalsPending: pendingApprovals,
        inputRequestsPending: pendingInputs,
        channels: channelList,
        workspaces: visibleWorkspaces.map(({ id, name }) => ({ id, name })),
        accounts,
      },
      storage,
      alerts,
      observer: alerts.map((alert) => ({
        id: alert.id,
        timestamp: Date.now(),
        title: alert.title,
        level: alert.level,
      })),
    };
  };

  const remoteSummary = async (device: ManagedDevice): Promise<ManagedDeviceSummary> => {
    const manager = getFleet();
    const status = manager?.getStatus(device.id) ?? { state: "disconnected" as const };
    const connected = status.state === "connected";
    const client = connected ? manager?.getClient(device.id) : null;
    let taskRows: unknown[] = [];
    let channelRows: unknown[] = [];
    let accountRows: unknown[] = [];
    let workspaceRows: unknown[] = [];
    let approvalRows: unknown[] = [];
    let inputRows: unknown[] = [];
    if (client) {
      const results = await Promise.allSettled([
        client.request(Methods.TASK_LIST, { limit: 12, offset: 0 }, 5000),
        client.request(Methods.CHANNEL_LIST, undefined, 5000),
        client.request(Methods.ACCOUNT_LIST, { includeSecrets: false }, 5000),
        client.request(Methods.WORKSPACE_LIST, undefined, 5000),
        client.request(Methods.APPROVAL_LIST, { limit: 100, offset: 0 }, 5000),
        client.request(
          Methods.INPUT_REQUEST_LIST,
          { limit: 100, offset: 0, status: "pending" },
          5000,
        ),
      ]);
      const payload = results.map((result) =>
        result.status === "fulfilled" ? objectRecord(result.value) : {},
      );
      taskRows = Array.isArray(payload[0].tasks) ? payload[0].tasks : [];
      channelRows = Array.isArray(payload[1].channels) ? payload[1].channels : [];
      accountRows = Array.isArray(payload[2].accounts) ? payload[2].accounts : [];
      workspaceRows = Array.isArray(payload[3].workspaces) ? payload[3].workspaces : [];
      approvalRows = Array.isArray(payload[4].approvals) ? payload[4].approvals : [];
      inputRows = Array.isArray(payload[5].inputRequests) ? payload[5].inputRequests : [];
    }
    const recent = taskRows.map((task) => safeTask(objectRecord(task) as unknown as Task) as Task);
    const active = recent.filter((task) => TASK_ACTIVE.has(task.status || "")).length;
    const pendingApprovals = Math.min(100, approvalRows.length);
    const pendingInputs = Math.min(100, inputRows.length);
    const channelsSafe = channelRows.map(sanitizeChannel);
    const accountsSafe = accountRows.map(sanitizeAccount);
    const workspaceSafe = workspaceRows.slice(0, 100).map((workspace) => {
      const input = objectRecord(workspace);
      return {
        id: typeof input.id === "string" ? input.id.slice(0, 180) : "",
        name: typeof input.name === "string" ? input.name.slice(0, 200) : "Workspace",
      };
    });
    const alerts = [
      alertForPending("approval", pendingApprovals),
      alertForPending("input_request", pendingInputs),
    ].filter((alert): alert is ManagedDeviceAlert => alert !== null);
    const hydrated: ManagedDevice = {
      ...redactManagedDevice(device),
      status: status.state,
      ...(status.clientId ? { clientId: status.clientId } : {}),
      ...(status.connectedAt ? { connectedAt: status.connectedAt } : {}),
      ...(status.lastActivityAt ? { lastSeenAt: status.lastActivityAt } : {}),
      activeRunCount: active,
      attentionState: alerts.length ? "warning" : "none",
      appsSummary: {
        channelsTotal: channelsSafe.length,
        channelsEnabled: channelsSafe.filter((channel) => channel.enabled === true).length,
        workspacesTotal: workspaceSafe.length,
        approvalsPending: pendingApprovals,
        inputRequestsPending: pendingInputs,
        accountsTotal: accountsSafe.length,
      },
      storageSummary: {
        ...(device.storageSummary ?? { workspaceCount: workspaceSafe.length, artifactCount: 0 }),
        workspaceCount: workspaceSafe.length,
      },
    };
    return {
      device: hydrated,
      runtime: {
        platform: hydrated.platform,
        ...(hydrated.version ? { coworkVersion: hydrated.version } : {}),
      },
      tasks: {
        total: taskRows.length,
        active,
        attention: recent.filter((task) =>
          TASK_ATTENTION.has(String(task.terminalStatus || task.status)),
        ).length,
        recent,
      },
      apps: {
        channelsTotal: channelsSafe.length,
        channelsEnabled: channelsSafe.filter((channel) => channel.enabled === true).length,
        workspacesTotal: workspaceSafe.length,
        approvalsPending: pendingApprovals,
        inputRequestsPending: pendingInputs,
        accountsTotal: accountsSafe.length,
        channels: channelsSafe,
        workspaces: workspaceSafe,
        accounts: accountsSafe,
      },
      storage: {
        workspaceCount: workspaceSafe.length,
        artifactCount: device.storageSummary?.artifactCount ?? 0,
        workspaceRoots: workspaceSafe.map(({ id, name }) => ({ id, name, path: "" })),
      },
      alerts,
      observer: (manager?.getObserver(device.id) ?? []).slice(0, 20).map((entry) => ({
        id: entry.id.slice(0, 180),
        timestamp: entry.timestamp,
        title: entry.title.slice(0, 160),
        level: entry.level,
      })),
    };
  };

  const definitions: BrowserDesktopDefinitions = {
    getControlPlaneSettings: {
      capability: "devices.manage",
      handler: () => redactSettings(getSettings()),
    },
    saveControlPlaneSettings: {
      capability: "devices.manage",
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: (args) => {
        rejectBrowserSshKeyPath(args);
        return [parseOne(ControlPlaneSaveSchema, args)];
      },
      handler: ([input]) => {
        const current = getSettings();
        const updates = mergeSettingsDevices(input as Record<string, unknown>, current);
        ControlPlaneSettingsManager.updateSettings(updates);
        return { ok: true };
      },
    },
    listManagedDevices: {
      capability: "devices.manage",
      handler: async () => {
        const settings = getSettings();
        const manager = getFleet();
        const remote = listStoredDevices(settings).map((device) => {
          const state = manager?.getStatus(device.id);
          return redactManagedDevice({
            ...device,
            ...(state
              ? {
                  status: state.state,
                  ...(state.clientId ? { clientId: state.clientId } : {}),
                  ...(state.connectedAt ? { connectedAt: state.connectedAt } : {}),
                  ...(state.lastActivityAt ? { lastSeenAt: state.lastActivityAt } : {}),
                }
              : {}),
          });
        });
        const local: ManagedDevice = {
          id: LOCAL_MANAGED_DEVICE_ID,
          name: "This device",
          role: "local",
          purpose: "primary",
          transport: "local",
          status: "local",
          platform:
            identity.platform === "darwin"
              ? "macos"
              : identity.platform === "win32"
                ? "windows"
                : identity.platform === "linux"
                  ? "linux"
                  : "linux",
          version: identity.appVersion,
          taskNodeId: LOCAL_MANAGED_DEVICE_NODE_ID,
        };
        return { ok: true, devices: [local, ...remote] };
      },
    },
    getDeviceSummary: {
      capability: "devices.manage",
      minArgs: 1,
      maxArgs: 1,
      validate: (args) => parsePositional([ID], args),
      handler: async ([deviceId]) => {
        if (isLocalDevice(deviceId as string)) return { ok: true, summary: await localSummary() };
        const device = requireRemoteDevice(getSettings(), deviceId as string);
        return { ok: true, summary: await remoteSummary(device) };
      },
    },
    connectDevice: {
      capability: "devices.manage",
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: (args) => parsePositional([ID], args),
      handler: async ([deviceId]) => {
        try {
          const settings = getSettings();
          const device = requireRemoteDevice(settings, deviceId as string);
          const status = await (getFleet(true) as FleetConnectionManager).connectDevice(device);
          return { ok: true, status: displayStatus(status) };
        } catch {
          return safeError();
        }
      },
    },
    disconnectDevice: {
      capability: "devices.manage",
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: (args) => parsePositional([ID], args),
      handler: ([deviceId]) => {
        try {
          const device = requireRemoteDevice(getSettings(), deviceId as string);
          const manager = getFleet();
          manager?.disconnectDevice(device.id);
          return {
            ok: true,
            status: displayStatus(manager?.getStatus(device.id) ?? { state: "disconnected" }),
          };
        } catch {
          return safeError();
        }
      },
    },
    getRemoteGatewayStatus: {
      capability: "devices.manage",
      handler: () => {
        const settings = getSettings();
        const activeId = getActiveRemoteDeviceId(settings);
        const device = activeId ? findDevice(settings, activeId) : undefined;
        const status = device ? getFleet()?.getStatus(device.id) : undefined;
        return displayStatus(status ?? { state: "disconnected", url: settings.remote?.url });
      },
    },
    saveRemoteGatewayConfig: {
      capability: "devices.manage",
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: (args) => {
        rejectBrowserSshKeyPath(args);
        return [safeConfigInput(parseOne(RemoteConfigSchema, args))];
      },
      handler: ([config]) => {
        try {
          const settings = getSettings();
          saveRemoteDevice(
            settings,
            config as RemoteGatewayConfig,
            getActiveRemoteDeviceId(settings),
            true,
          );
          return { ok: true };
        } catch {
          return safeError();
        }
      },
    },
    testRemoteGatewayConnection: {
      capability: "devices.manage",
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: (args) => {
        rejectBrowserSshKeyPath(args);
        return [safeConfigInput(parseOne(RemoteConfigSchema, args))];
      },
      handler: async ([config]) => {
        const settings = getSettings();
        const merged = mergeConfigFromSettings(config as RemoteGatewayConfig, settings);
        if (!merged.token)
          return { ok: false, error: "A remote authentication token is required." };
        const result = await new RemoteGatewayClient(merged).testConnection();
        return result.success
          ? { ok: true, latencyMs: result.latencyMs }
          : { ok: false, error: "Connection test failed. Check the remote URL and credentials." };
      },
    },
    connectRemoteGateway: {
      capability: "devices.manage",
      mutation: true,
      minArgs: 0,
      maxArgs: 1,
      validate: (args) => {
        if (args.length === 0) return [];
        rejectBrowserSshKeyPath(args);
        return [safeConfigInput(parseOne(RemoteConfigSchema, args))];
      },
      handler: async ([config]) => {
        try {
          const settings = getSettings();
          const activeId = getActiveRemoteDeviceId(settings);
          const device = config
            ? saveRemoteDevice(settings, config as RemoteGatewayConfig, activeId, true)
            : requireRemoteDevice(settings, activeId || "");
          if (!device.config?.token)
            return { ok: false, error: "A remote authentication token is required." };
          const status = await (getFleet(true) as FleetConnectionManager).connectDevice(device);
          ControlPlaneSettingsManager.updateSettings({
            connectionMode: "remote",
            activeManagedDeviceId: device.id,
            activeRemoteDeviceId: device.id,
            remote: device.config,
          });
          return { ok: true, status: displayStatus(status) };
        } catch {
          return safeError();
        }
      },
    },
    disconnectRemoteGateway: {
      capability: "devices.manage",
      mutation: true,
      handler: () => {
        try {
          const settings = getSettings();
          const deviceId = getActiveRemoteDeviceId(settings);
          if (deviceId) getFleet()?.disconnectDevice(deviceId);
          ControlPlaneSettingsManager.updateSettings({ connectionMode: "local" });
          return { ok: true };
        } catch {
          return safeError();
        }
      },
    },
    deviceProxyRequest: {
      capability: "devices.manage",
      mutation: true,
      minArgs: 1,
      maxArgs: 1,
      validate: (args) => [validateProxyRequest(parseOne(DeviceProxyEnvelopeSchema, args))],
      handler: async ([request]) =>
        runProxyRequest(request as ReturnType<typeof validateProxyRequest>),
    },
    deviceListTasks: {
      capability: "devices.manage",
      minArgs: 1,
      maxArgs: 1,
      validate: (args) => parsePositional([ID], args),
      handler: async ([nodeId]) => {
        try {
          if (isLocalDevice(nodeId as string)) {
            const visible = new Set((await workspaceSnapshot()).map((workspace) => workspace.id));
            const found = await tasks.findAll(300, 0);
            const filtered = found.filter(
              (task) =>
                (!task.targetNodeId || isLocalDevice(task.targetNodeId)) &&
                visible.has(task.workspaceId),
            );
            return { ok: true, tasks: filtered.slice(0, 100).map((task) => safeTask(task)) };
          }
          const settings = getSettings();
          const device = requireRemoteDevice(settings, nodeId as string);
          const client = requireConnectedClient(device.id);
          const result = objectRecord(
            await client.request(Methods.TASK_LIST, { limit: 100, offset: 0 }, 10_000),
          );
          const remoteTasks = Array.isArray(result.tasks) ? result.tasks : [];
          return {
            ok: true,
            tasks: remoteTasks
              .slice(0, 100)
              .map((task) => safeTask(objectRecord(task) as unknown as Task)),
          };
        } catch {
          return safeError();
        }
      },
    },
    deviceListRemoteWorkspaces: {
      capability: "devices.manage",
      minArgs: 1,
      maxArgs: 1,
      validate: (args) => parsePositional([ID], args),
      handler: async ([nodeId]) => {
        try {
          if (isLocalDevice(nodeId as string))
            return { ok: false, error: "Use local workspace selection for this device." };
          const device = requireRemoteDevice(getSettings(), nodeId as string);
          const result = objectRecord(
            await requireConnectedClient(device.id).request(
              Methods.WORKSPACE_LIST,
              undefined,
              5000,
            ),
          );
          const remoteWorkspaces = Array.isArray(result.workspaces) ? result.workspaces : [];
          return {
            ok: true,
            workspaces: remoteWorkspaces.slice(0, 100).map((workspace) => {
              const value = objectRecord(workspace);
              return {
                id: typeof value.id === "string" ? value.id.slice(0, 180) : "",
                name: typeof value.name === "string" ? value.name.slice(0, 200) : "Workspace",
              };
            }),
          };
        } catch {
          return safeError();
        }
      },
    },
    deviceListFiles: {
      capability: "devices.manage",
      minArgs: 1,
      maxArgs: 1,
      validate: (args) => [parseOne(DeviceFilesSchema, args)],
      handler: async ([params]) => {
        try {
          const value = params as z.infer<typeof DeviceFilesSchema>;
          if (isLocalDevice(value.nodeId))
            return { ok: false, error: "Use local file selection for this device." };
          const device = requireRemoteDevice(getSettings(), value.nodeId);
          const response = objectRecord(
            await requireConnectedClient(device.id).request(
              Methods.FILE_LIST_DIRECTORY,
              { workspaceId: value.workspaceId, path: value.path || "." },
              10_000,
            ),
          );
          const files = Array.isArray(response.files) ? response.files : [];
          return {
            ok: true,
            files: files.slice(0, 1000).flatMap((file) => {
              const item = objectRecord(file);
              if (
                typeof item.name !== "string" ||
                item.name.includes("/") ||
                item.name.includes("\\") ||
                item.name === ".."
              )
                return [];
              return [
                {
                  name: item.name.slice(0, 512),
                  type: item.type === "directory" ? "directory" : "file",
                  size:
                    typeof item.size === "number" && Number.isFinite(item.size)
                      ? Math.max(0, item.size)
                      : 0,
                },
              ];
            }),
          };
        } catch {
          return safeError();
        }
      },
    },
    deviceGetProfiles: {
      capability: "devices.manage",
      handler: async () => ({
        ok: true,
        profiles: (await profileRepository.list()).map((profile) =>
          sanitizeDeviceProfile(profile as unknown as Record<string, unknown>),
        ),
      }),
    },
    deviceUpdateProfile: {
      capability: "devices.manage",
      mutation: true,
      minArgs: 2,
      maxArgs: 2,
      validate: (args) => parsePositional([ID, DeviceProfileUpdateSchema], args),
      handler: async ([deviceId, input]) => {
        const target = deviceId as string;
        if (!isLocalDevice(target) && !findDevice(getSettings(), target))
          return invalid("Device was not found.");
        await profileRepository.upsert(target, input as Record<string, unknown>);
        return { ok: true };
      },
    },
  };

  async function runProxyRequest(
    request: ReturnType<typeof validateProxyRequest>,
  ): Promise<unknown> {
    const { deviceId, method, params } = request;
    if (method === Methods.CHANNEL_LIST || method === Methods.ACCOUNT_LIST) {
      if (isLocalDevice(deviceId)) {
        if (method === Methods.CHANNEL_LIST)
          return { ok: true, payload: channelList(await localChannels()) };
        return { ok: true, payload: accountList(params) };
      }
      try {
        const device = requireRemoteDevice(getSettings(), deviceId);
        const response = await requireConnectedClient(device.id).request(method, params, 10_000);
        return { ok: true, payload: safeRpcResult(method, response) };
      } catch {
        return safeError();
      }
    }
    try {
      if (!isLocalDevice(deviceId)) {
        const device = requireRemoteDevice(getSettings(), deviceId);
        const response = await requireConnectedClient(device.id).request(method, params, 15_000);
        return { ok: true, payload: safeRpcResult(method, response) };
      }
      return { ok: true, payload: await runLocalChannelAction(method, objectRecord(params)) };
    } catch {
      return safeError();
    }
  }

  async function runLocalChannelAction(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (method === Methods.CHANNEL_CREATE) {
      const input = parseChannelCreate(params);
      const created = await channels.createIfTypeAbsent({
        type: input.type as string,
        name: input.name as string,
        enabled: input.enabled === true,
        config: objectRecord(input.config),
        securityConfig: input.securityConfig as Channel["securityConfig"],
        status: "disconnected",
      });
      if (!created) throw new Error("Channel already exists");
      if (input.enabled && options.channelGateway) {
        await options.channelGateway.enableChannel(created.id);
      }
      return { channelId: created.id };
    }
    const channelId = ChannelIdParamsSchema.parse(params).channelId;
    if (method === Methods.CHANNEL_ENABLE) {
      if (options.channelGateway) await options.channelGateway.enableChannel(channelId);
      else await channels.update(channelId, { enabled: true });
      return { ok: true, ...(options.channelGateway ? {} : { restartRequired: true }) };
    }
    if (method === Methods.CHANNEL_DISABLE) {
      if (options.channelGateway) await options.channelGateway.disableChannel(channelId);
      else await channels.update(channelId, { enabled: false, status: "disconnected" });
      return { ok: true, ...(options.channelGateway ? {} : { restartRequired: true }) };
    }
    if (method === Methods.CHANNEL_TEST) {
      if (!options.channelGateway)
        return { success: false, error: "Channel gateway is unavailable." };
      const result = objectRecord(await options.channelGateway.testChannel(channelId));
      return {
        success: result.success === true || result.ok === true,
        ...(result.success === false || result.ok === false
          ? { error: "Connection test failed." }
          : {}),
      };
    }
    if (method === Methods.CHANNEL_REMOVE) {
      if (options.channelGateway) await options.channelGateway.removeChannel(channelId);
      else await channels.delete(channelId);
      return { ok: true, ...(options.channelGateway ? {} : { restartRequired: true }) };
    }
    return invalid();
  }

  function requireConnectedClient(deviceId: string) {
    const manager = getFleet();
    const client = manager?.getClient(deviceId);
    if (!client || manager?.getStatus(deviceId).state !== "connected") {
      throw new WebApplicationError("INVALID_REQUEST", "Remote device is not connected.", 409);
    }
    return client;
  }

  return { definitions, dispose: () => undefined };
}

const ControlPlaneSaveSchema = z
  .object({
    managedDevices: z.array(ManagedDeviceSchema).max(128).optional(),
    savedRemoteDevices: z.array(SavedDeviceSchema).max(128).optional(),
    activeManagedDeviceId: z.union([ID, z.null()]).optional(),
    activeRemoteDeviceId: z.union([ID, z.null()]).optional(),
    // Older DevicesPanel builds include this redundant config when saving its
    // device arrays. It is ignored; remote config is taken from each saved device.
    remote: RemoteConfigSchema.optional(),
  })
  .strict();

const DeviceProxyEnvelopeSchema = z
  .object({
    deviceId: ID,
    method: SHORT_TEXT,
    params: z.unknown().optional(),
  })
  .strict();

const DeviceFilesSchema = z
  .object({
    nodeId: ID,
    workspaceId: ID,
    path: z.string().trim().max(2048).optional(),
  })
  .strict()
  .refine((value) => {
    const path = value.path || ".";
    return (
      !path.startsWith("/") &&
      !path.startsWith("\\") &&
      !/^[A-Za-z]:/.test(path) &&
      !path.split(/[\\/]/).includes("..")
    );
  });

const DeviceProfileUpdateSchema = z
  .object({
    customName: z.string().trim().max(128).optional(),
    platform: z.enum(NODE_PLATFORMS).optional(),
    modelIdentifier: z.string().trim().max(256).optional(),
  })
  .strict();

async function getDiskSummary(
  workspacePath?: string,
): Promise<{ totalBytes?: number; freeBytes?: number; usedBytes?: number } | null> {
  if (!workspacePath || typeof fs.statfs !== "function") return null;
  try {
    const stats = await fs.statfs(workspacePath);
    const blockSize = Number(stats.bsize || 0);
    const blocks = Number(stats.blocks || 0);
    const available = Number(stats.bavail || stats.bfree || 0);
    if (!Number.isFinite(blockSize) || blockSize <= 0 || !Number.isFinite(blocks) || blocks <= 0)
      return null;
    const totalBytes = blockSize * blocks;
    const freeBytes = blockSize * available;
    return { totalBytes, freeBytes, usedBytes: Math.max(0, totalBytes - freeBytes) };
  } catch {
    return null;
  }
}

async function countVisibleArtifacts(
  repository: InstanceType<typeof ArtifactRepository>,
  tasks: Task[],
): Promise<number> {
  let count = 0;
  for (const task of tasks.slice(0, 100)) {
    try {
      count += (await repository.findByTaskId(task.id)).length;
    } catch {
      // Artifact counts are best-effort summary data; an unavailable partition is not fatal.
    }
  }
  return count;
}
