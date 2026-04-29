/**
 * Control Plane IPC Handlers
 *
 * IPC handlers for managing the WebSocket control plane from the renderer.
 */

import { app, ipcMain, BrowserWindow } from "electron";
import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import os from "os";
import path from "path";
import { z } from "zod";
import {
  IPC_CHANNELS,
  isTempWorkspaceId,
  LOCAL_MANAGED_DEVICE_ID,
  LOCAL_MANAGED_DEVICE_NODE_ID,
} from "../../shared/types";
import type {
  ControlPlaneSettingsData,
  ControlPlaneStatus,
  TailscaleAvailability,
  TailscaleMode,
  DeviceProxyRequest,
  ImageAttachment,
  ManagedDevice,
  ManagedDeviceAlert,
  ManagedDeviceAttentionState,
  ManagedDeviceSummary,
  NodeInfo,
  NodePlatform,
  RemoteGatewayConfig,
  RemoteGatewayStatus,
  SSHTunnelConfig,
  SSHTunnelStatus,
  Task,
} from "../../shared/types";
import { ControlPlaneServer, ControlPlaneSettingsManager } from "./index";
import { Methods, Events, ErrorCodes } from "./protocol";
import type { AgentConfig } from "../../shared/types";
import type { AgentDaemon } from "../agent/daemon";
import type { DatabaseManager } from "../database/schema";
import type { ChannelGateway } from "../gateway";
import type { RoutineService } from "../routines/service";
import {
  ApprovalRepository,
  ArtifactRepository,
  ChannelRepository,
  InputRequestRepository,
  TaskEventRepository,
  TaskRepository,
  WorkspaceRepository,
} from "../database/repositories";
import { SearchProviderFactory } from "../agent/search";
import { configureLlmFromControlPlaneParams, getControlPlaneLlmStatus } from "./llm-configure";
import { checkTailscaleAvailability, getExposureStatus } from "../tailscale";
import { registerACPMethods, shutdownACP, type ACPHandlerDeps } from "../acp";
import { AgentRoleRepository } from "../agents/AgentRoleRepository";
import { TailscaleSettingsManager } from "../tailscale/settings";
import {
  RemoteGatewayClient,
} from "./remote-client";
import {
  SSHTunnelManager,
  initSSHTunnelManager,
  getSSHTunnelManager,
  shutdownSSHTunnelManager,
} from "./ssh-tunnel";
import {
  getEnvSettingsImportModeFromArgsOrEnv,
  isHeadlessMode,
  shouldImportEnvSettingsFromArgsOrEnv,
} from "../utils/runtime-mode";
import { getActiveProfileId, getUserDataDir } from "../utils/user-data-dir";
import { CanvasManager } from "../canvas/canvas-manager";
import { TASK_EVENT_BRIDGE_ALLOWLIST } from "./task-event-bridge-contract";
import { registerControlPlaneCoreMethods } from "./registerControlPlaneCoreMethods";
import { registerStrategicPlannerMethods } from "./registerStrategicPlannerMethods";
import { getStrategicPlannerService } from "./StrategicPlannerService";
import { registerSymphonyMethods } from "./registerSymphonyMethods";
import { getSymphonyService } from "./SymphonyService";
import {
  getFleetConnectionManager,
  initFleetConnectionManager,
  shutdownFleetConnectionManager,
} from "./fleet-manager";
import { ManagedAccountManager } from "../accounts/managed-account-manager";
import { ManagedSessionService } from "../managed/ManagedSessionService";
import {
  normalizeImagesForRemote,
  sanitizeTaskMessageParams,
} from "./sanitize";
import { AgentConfigSchema, validateInput } from "../utils/validation";
import {
  buildTaskEventHistoryForTransport,
  serializeTaskEventForTransport,
} from "./task-event-transport";

// Server instance
let controlPlaneServer: ControlPlaneServer | null = null;

// Reference to main window for sending events
let mainWindowRef: BrowserWindow | null = null;

export interface ControlPlaneMethodDeps {
  agentDaemon: AgentDaemon;
  dbManager: DatabaseManager;
  channelGateway?: ChannelGateway;
  getRoutineService?: () => RoutineService | null;
}

let controlPlaneDeps: ControlPlaneMethodDeps | null = null;
let detachAgentDaemonBridge: (() => void) | null = null;
let managedSessionService: ManagedSessionService | null = null;

function getManagedSessionService(deps: ControlPlaneMethodDeps): ManagedSessionService {
  if (!managedSessionService) {
    managedSessionService = new ManagedSessionService(deps.dbManager.getDatabase(), deps.agentDaemon, {
      getRoutineService: deps.getRoutineService,
    });
  }
  return managedSessionService;
}

function toNodePlatform(platform?: string): "ios" | "android" | "macos" | "linux" | "windows" {
  switch (platform) {
    case "darwin":
    case "macos":
      return "macos";
    case "win32":
    case "windows":
      return "windows";
    case "android":
      return "android";
    case "ios":
      return "ios";
    case "linux":
    default:
      return "linux";
  }
}

async function getRemoteGatewayNodeInfo():
  Promise<import("../../shared/types").NodeInfo | null> {
  const settings = ControlPlaneSettingsManager.loadSettings();
  const activeRemoteId =
    settings.activeManagedDeviceId && settings.activeManagedDeviceId !== LOCAL_MANAGED_DEVICE_ID
      ? settings.activeManagedDeviceId
      : settings.activeRemoteDeviceId;
  if (!activeRemoteId) return null;
  const device = findManagedDeviceById(activeRemoteId);
  if (!device || device.role !== "remote") return null;
  return getManagedRemoteNodeInfo(device);
}

/**
 * Get the current control plane server instance
 */
export function getControlPlaneServer(): ControlPlaneServer | null {
  return controlPlaneServer;
}

export function getStartupAutoConnectRemoteDeviceIds(
  devices: Array<Pick<ManagedDevice, "id" | "autoConnect">>,
): string[] {
  return devices.filter((device) => device.autoConnect === true).map((device) => device.id);
}

function requireScope(client: any, scope: "admin" | "read" | "write" | "operator"): void {
  if (!client?.hasScope?.(scope)) {
    throw { code: ErrorCodes.UNAUTHORIZED, message: `Missing required scope: ${scope}` };
  }
}

export function redactManagedEnvironmentForRead(environment: any) {
  if (!environment) return environment;
  return {
    ...environment,
    config: environment?.config
      ? {
          ...environment.config,
          credentialRefs: undefined,
          managedAccountRefs: undefined,
        }
      : environment?.config,
  };
}

const ACTIVE_TASK_STATUSES = new Set([
  "queued",
  "pending",
  "planning",
  "executing",
  "interrupted",
  "paused",
]);
const ATTENTION_LEVEL_ORDER: ManagedDeviceAttentionState[] = [
  "none",
  "info",
  "warning",
  "critical",
];

function isLocalManagedDeviceIdentifier(deviceId?: string | null): boolean {
  return (
    !deviceId ||
    deviceId === LOCAL_MANAGED_DEVICE_ID ||
    deviceId === LOCAL_MANAGED_DEVICE_NODE_ID
  );
}

function getHostnameFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

function normalizeGatewayUrl(url?: string): string {
  return typeof url === "string" ? url.trim().replace(/\/+$/, "") : "";
}

function getLegacyRemoteNodeId(url?: string): string | undefined {
  const hostname = getHostnameFromUrl(url);
  if (hostname) return `remote-gateway:${hostname}`;
  return url ? `remote-gateway:${url}` : undefined;
}

function inferManagedTransport(config?: RemoteGatewayConfig): ManagedDevice["transport"] {
  if (config?.sshTunnel?.enabled) return "ssh";
  const hostname = getHostnameFromUrl(config?.url);
  if (hostname?.endsWith(".ts.net")) return "tailscale";
  if (hostname === "127.0.0.1" || hostname === "localhost") return "direct";
  return hostname ? "direct" : "unknown";
}

function normalizeManagedRemoteDevice(device: ManagedDevice): ManagedDevice {
  return {
    ...device,
    role: "remote",
    autoConnect: device.autoConnect === true,
    transport: device.transport || inferManagedTransport(device.config),
    status: device.status || "disconnected",
    platform: device.platform || "linux",
    name: device.name || device.config?.deviceName || "Remote Device",
    taskNodeId: device.taskNodeId || `remote-gateway:${device.id}`,
    config: device.config
      ? {
          autoReconnect: true,
          reconnectIntervalMs: 5000,
          maxReconnectAttempts: 10,
          deviceName: "CoWork Remote Client",
          ...device.config,
        }
      : undefined,
    attentionState: device.attentionState || "none",
    activeRunCount: device.activeRunCount || 0,
    storageSummary: {
      workspaceCount: device.storageSummary?.workspaceCount || 0,
      artifactCount: device.storageSummary?.artifactCount || 0,
      ...(device.storageSummary?.freeBytes !== undefined
        ? { freeBytes: device.storageSummary.freeBytes }
        : {}),
      ...(device.storageSummary?.usedBytes !== undefined
        ? { usedBytes: device.storageSummary.usedBytes }
        : {}),
      ...(device.storageSummary?.totalBytes !== undefined
        ? { totalBytes: device.storageSummary.totalBytes }
        : {}),
    },
    appsSummary: {
      channelsTotal: device.appsSummary?.channelsTotal || 0,
      channelsEnabled: device.appsSummary?.channelsEnabled || 0,
      workspacesTotal: device.appsSummary?.workspacesTotal || 0,
      approvalsPending: device.appsSummary?.approvalsPending || 0,
      inputRequestsPending: device.appsSummary?.inputRequestsPending || 0,
    },
    tags: Array.isArray(device.tags) ? device.tags : [],
  };
}

function toManagedDeviceFromSaved(settings: ControlPlaneSettingsData, saved: Any): ManagedDevice {
  const config = saved?.config as RemoteGatewayConfig | undefined;
  return normalizeManagedRemoteDevice({
    id: typeof saved?.id === "string" ? saved.id : `remote:${config?.url || Date.now()}`,
    name:
      (typeof saved?.name === "string" && saved.name.trim()) ||
      config?.deviceName ||
      "Remote Device",
    role: "remote",
    purpose: "general",
    transport: inferManagedTransport(config),
    status: "disconnected",
    platform: "linux",
    clientId: typeof saved?.clientId === "string" ? saved.clientId : undefined,
    connectedAt: typeof saved?.connectedAt === "number" ? saved.connectedAt : undefined,
    lastSeenAt:
      typeof saved?.lastActivityAt === "number"
        ? saved.lastActivityAt
        : typeof saved?.connectedAt === "number"
          ? saved.connectedAt
          : undefined,
    taskNodeId: `remote-gateway:${typeof saved?.id === "string" ? saved.id : "remote"}`,
    config,
    autoConnect: saved?.autoConnect === true,
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
  });
}

function listStoredManagedDevices(): ManagedDevice[] {
  const settings = ControlPlaneSettingsManager.loadSettings() as ControlPlaneSettingsData;
  const byId = new Map<string, ManagedDevice>();

  for (const raw of settings.managedDevices || []) {
    if (!raw || raw.role !== "remote") continue;
    byId.set(raw.id, normalizeManagedRemoteDevice(raw));
  }

  for (const saved of settings.savedRemoteDevices || []) {
    if (!saved?.id) continue;
    if (!byId.has(saved.id)) {
      byId.set(saved.id, toManagedDeviceFromSaved(settings, saved));
    }
  }

  if (settings.remote?.url && settings.remote?.token) {
    const legacyId =
      (settings.activeManagedDeviceId && settings.activeManagedDeviceId !== LOCAL_MANAGED_DEVICE_ID
        ? settings.activeManagedDeviceId
        : settings.activeRemoteDeviceId) || `remote:${settings.remote.url}`;
    if (!byId.has(legacyId)) {
      byId.set(
        legacyId,
        normalizeManagedRemoteDevice({
          id: legacyId,
          name: settings.remote.deviceName || "CoWork Remote Client",
          role: "remote",
          purpose: "general",
          transport: inferManagedTransport(settings.remote),
          status: "disconnected",
          platform: "linux",
          taskNodeId: `remote-gateway:${legacyId}`,
          config: settings.remote,
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
        }),
      );
    }
  }

  return Array.from(byId.values());
}

function buildLocalManagedDevice(): ManagedDevice {
  return {
    id: LOCAL_MANAGED_DEVICE_ID,
    name: "This device",
    role: "local",
    purpose: "primary",
    transport: "local",
    status: "local",
    platform: toNodePlatform(process.platform),
    version: typeof app.getVersion === "function" ? app.getVersion() : undefined,
    modelIdentifier: os.hostname(),
    taskNodeId: LOCAL_MANAGED_DEVICE_NODE_ID,
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

function findManagedDeviceById(deviceId?: string | null): ManagedDevice | null {
  if (isLocalManagedDeviceIdentifier(deviceId)) {
    return buildLocalManagedDevice();
  }
  return listStoredManagedDevices().find((device) => device.id === deviceId) || null;
}

async function getManagedRemoteNodeInfo(device: ManagedDevice): Promise<NodeInfo | null> {
  const fleetManager = getFleetConnectionManager();
  const client = fleetManager?.getClient(device.id);
  const status = fleetManager?.getStatus(device.id);
  if (!client || status?.state !== "connected") {
    return null;
  }

  let configSnapshot: Any = null;
  try {
    configSnapshot = await client.request(Methods.CONFIG_GET, undefined, 5000);
  } catch {
    configSnapshot = null;
  }

  const runtime = configSnapshot?.runtime || {};
  const hostname = getHostnameFromUrl(device.config?.url) || device.modelIdentifier;
  return {
    id: device.taskNodeId || `remote-gateway:${device.id}`,
    displayName: device.name || "Remote Device",
    platform: toNodePlatform(runtime.platform || device.platform),
    version:
      typeof runtime.coworkVersion === "string"
        ? runtime.coworkVersion
        : device.version || "unknown",
    deviceId: status.clientId,
    modelIdentifier: hostname,
    capabilities: [],
    commands: [],
    permissions: {},
    connectedAt: status.connectedAt || Date.now(),
    lastActivityAt: status.lastActivityAt || status.connectedAt || Date.now(),
    isForeground: false,
  };
}

async function listManagedRemoteNodes(): Promise<NodeInfo[]> {
  const remoteDevices = listStoredManagedDevices();
  const nodes = await Promise.all(remoteDevices.map((device) => getManagedRemoteNodeInfo(device)));
  return nodes.filter((node): node is NodeInfo => !!node);
}

async function getManagedRemoteNodeAliases(device: ManagedDevice, nodeId?: string): Promise<string[]> {
  const aliases = new Set<string>();
  if (typeof nodeId === "string" && nodeId.trim()) {
    aliases.add(nodeId.trim());
  }
  aliases.add(device.taskNodeId || `remote-gateway:${device.id}`);
  const legacyRemoteNodeId = getLegacyRemoteNodeId(device.config?.url);
  if (legacyRemoteNodeId) aliases.add(legacyRemoteNodeId);
  if (device.clientId) aliases.add(device.clientId);

  const remoteNode = await getManagedRemoteNodeInfo(device);
  if (remoteNode) {
    aliases.add(remoteNode.id);
    if (remoteNode.deviceId) aliases.add(remoteNode.deviceId);
  }

  return Array.from(aliases);
}

async function findManagedRemoteDeviceByNodeId(nodeId: string): Promise<ManagedDevice | null> {
  const normalized = nodeId.trim();
  if (!normalized || isLocalManagedDeviceIdentifier(normalized)) {
    return null;
  }
  const remoteDevices = listStoredManagedDevices();
  for (const device of remoteDevices) {
    const aliases = await getManagedRemoteNodeAliases(device, normalized);
    if (aliases.includes(normalized)) {
      return device;
    }
  }
  return null;
}

function getDefaultLocalWorkspaceId(db: Any): string | undefined {
  const workspaceRepo = new WorkspaceRepository(db);
  return workspaceRepo.findAll()[0]?.id;
}

/** Normalize path for cross-machine comparison (trim, unify slashes, remove trailing slash). */
function normalizePathForMatch(p: string): string {
  return path.normalize(String(p || "").trim().replace(/\\/g, "/")).replace(/\/+$/, "") || "";
}

/** Case-insensitive path equality for cross-platform workspace matching (macOS/Windows). */
function pathsMatch(a: string, b: string): boolean {
  const na = normalizePathForMatch(a);
  const nb = normalizePathForMatch(b);
  if (na === nb) return true;
  if (process.platform === "darwin" || process.platform === "win32") {
    return na.toLowerCase() === nb.toLowerCase();
  }
  return false;
}

/**
 * Resolve the local workspace ID for a remote task by matching remote workspace path to a local workspace.
 * Falls back to the default (most recently used) local workspace when no path match is found.
 */
function resolveLocalWorkspaceIdForRemoteTask(
  db: Any,
  remoteWorkspaces: Array<{ id?: string; path?: string }>,
  remoteTask: { workspaceId?: string },
  fallbackWorkspaceId: string | undefined,
): string | undefined {
  const workspaceRepo = new WorkspaceRepository(db);
  const remoteWorkspaceId = remoteTask?.workspaceId;
  if (!remoteWorkspaceId) return fallbackWorkspaceId;

  const remoteWorkspace = remoteWorkspaces.find((w) => w.id === remoteWorkspaceId);
  const remotePath = remoteWorkspace?.path;
  if (!remotePath || typeof remotePath !== "string") return fallbackWorkspaceId;

  const normalizedRemote = normalizePathForMatch(remotePath);
  if (!normalizedRemote) return fallbackWorkspaceId;

  const localWorkspaces = workspaceRepo
    .findAll()
    .filter((w) => !w.isTemp && !isTempWorkspaceId(w.id));
  const match = localWorkspaces.find((w) => pathsMatch(w.path, remotePath));
  return match?.id ?? fallbackWorkspaceId;
}

function isActiveTaskStatus(status?: string): boolean {
  return !!status && ACTIVE_TASK_STATUSES.has(status);
}

function isTaskAttention(task: Partial<Task> | null | undefined): boolean {
  if (!task) return false;
  return (
    task.status === "blocked" ||
    task.terminalStatus === "needs_user_action" ||
    task.terminalStatus === "awaiting_approval"
  );
}

function maxAttentionLevel(
  ...levels: Array<ManagedDeviceAttentionState | undefined>
): ManagedDeviceAttentionState {
  let currentIndex = 0;
  for (const level of levels) {
    if (!level) continue;
    const nextIndex = ATTENTION_LEVEL_ORDER.indexOf(level);
    if (nextIndex > currentIndex) currentIndex = nextIndex;
  }
  return ATTENTION_LEVEL_ORDER[currentIndex] || "none";
}

async function getLocalConfigSnapshot(): Promise<Any> {
  if (!controlPlaneDeps?.dbManager) {
    return {
      runtime: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        electron: process.versions.electron,
        coworkVersion: typeof app.getVersion === "function" ? app.getVersion() : undefined,
        headless: isHeadlessMode(),
        cwd: process.cwd(),
        userDataDir: getUserDataDir(),
        activeProfileId: getActiveProfileId(),
      },
      workspaces: { count: 0, workspaces: [] },
      tasks: { total: 0, byStatus: {} },
      channels: { count: 0, enabled: 0, channels: [] },
    };
  }

  const db = controlPlaneDeps.dbManager.getDatabase();
  const workspaceRepo = new WorkspaceRepository(db);
  const taskRepo = new TaskRepository(db);
  const channelRepo = new ChannelRepository(db);

  const allWorkspaces = workspaceRepo
    .findAll()
    .filter((workspace) => !workspace.isTemp && !isTempWorkspaceId(workspace.id));
  const allLocalTasks = taskRepo
    .findAll(250, 0)
    .filter((task) => !task.targetNodeId || isLocalManagedDeviceIdentifier(task.targetNodeId));
  const byStatus = allLocalTasks.reduce(
    (acc: Record<string, number>, task) => {
      const key = task.status || "unknown";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
  const channels = channelRepo.findAll();

  return {
    runtime: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      electron: process.versions.electron,
      coworkVersion: typeof app.getVersion === "function" ? app.getVersion() : undefined,
      headless: isHeadlessMode(),
      cwd: process.cwd(),
      userDataDir: getUserDataDir(),
      activeProfileId: getActiveProfileId(),
    },
    workspaces: {
      count: allWorkspaces.length,
      workspaces: allWorkspaces,
    },
    tasks: {
      total: allLocalTasks.length,
      byStatus,
    },
    channels: {
      count: channels.length,
      enabled: channels.filter((channel) => channel.enabled).length,
      channels,
    },
  };
}

async function getLocalStorageSummary(db: Any): Promise<{
  storage: ManagedDeviceSummary["storage"];
  workspaceRoots: Array<{ id: string; name: string; path: string }>;
}> {
  const workspaceRepo = new WorkspaceRepository(db);
  const artifactRepo = new ArtifactRepository(db);
  const workspaces = workspaceRepo
    .findAll()
    .filter((workspace) => !workspace.isTemp && !isTempWorkspaceId(workspace.id));
  const workspaceRoots = workspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    path: workspace.path,
  }));

  let totalBytes: number | undefined;
  let freeBytes: number | undefined;
  const probePath = workspaceRoots[0]?.path || getUserDataDir();
  if (typeof fs.statfs === "function") {
    try {
      const stat = await fs.statfs(probePath);
      const blockSize = Number((stat as Any).bsize || (stat as Any).frsize || 0);
      const blocks = Number((stat as Any).blocks || 0);
      const availableBlocks = Number((stat as Any).bavail || (stat as Any).bfree || 0);
      if (Number.isFinite(blockSize) && blockSize > 0 && Number.isFinite(blocks) && blocks > 0) {
        totalBytes = blockSize * blocks;
        freeBytes = blockSize * availableBlocks;
      }
    } catch (err) {
      console.warn("[ControlPlane] statfs failed (disk stats unavailable):", probePath, err);
    }
  }

  const artifactCount = db.prepare("SELECT COUNT(1) AS count FROM artifacts").get() as Any;
  return {
    storage: {
      workspaceCount: workspaceRoots.length,
      artifactCount: Number(artifactCount?.count || 0),
      ...(totalBytes !== undefined ? { totalBytes } : {}),
      ...(freeBytes !== undefined ? { freeBytes } : {}),
      ...(totalBytes !== undefined && freeBytes !== undefined
        ? { usedBytes: totalBytes - freeBytes }
        : {}),
      workspaceRoots,
    },
    workspaceRoots,
  };
}

function upsertRemoteShadowTask(db: Any, workspaceId: string, nodeId: string, task: Any): void {
  const id = task?.id || randomUUID();
  const now = Date.now();
  const nextUpdatedAt =
    typeof task?.updatedAt === "number" && Number.isFinite(task.updatedAt) ? task.updatedAt : now;
  db.prepare(
    `INSERT INTO tasks (id, title, prompt, status, workspace_id, target_node_id, terminal_status, error, completed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       prompt = excluded.prompt,
       status = excluded.status,
       workspace_id = excluded.workspace_id,
       target_node_id = excluded.target_node_id,
       terminal_status = excluded.terminal_status,
       error = excluded.error,
       completed_at = excluded.completed_at,
       updated_at = excluded.updated_at`
  ).run(
    id,
    task?.title || task?.prompt || "Remote task",
    task?.prompt || task?.title || "",
    task?.status || "pending",
    workspaceId,
    nodeId,
    task?.terminalStatus || null,
    task?.error || null,
    task?.completedAt || null,
    typeof task?.createdAt === "number" && Number.isFinite(task.createdAt) ? task.createdAt : now,
    nextUpdatedAt,
  );
}

const REMOTE_TASK_SYNC_LIMIT = 200;

async function syncRemoteShadowTasksForNode(nodeId: string): Promise<void> {
  if (!controlPlaneDeps?.dbManager) return;
  const remoteDevice = await findManagedRemoteDeviceByNodeId(nodeId);
  if (!remoteDevice) return;

  const fleetManager = getFleetConnectionManager();
  const remoteClient = fleetManager?.getClient(remoteDevice.id);
  const status = fleetManager?.getStatus(remoteDevice.id);
  if (!remoteClient || status?.state !== "connected") return;

  const db = controlPlaneDeps.dbManager.getDatabase();
  const fallbackWorkspaceId = getDefaultLocalWorkspaceId(db);
  if (!fallbackWorkspaceId) return;

  try {
    const [taskRes, workspaceRes] = await Promise.all([
      remoteClient.request(Methods.TASK_LIST, { limit: REMOTE_TASK_SYNC_LIMIT, offset: 0 }),
      remoteClient.request(Methods.WORKSPACE_LIST, undefined, 5000),
    ]);
    const remoteTasks = Array.isArray((taskRes as Any)?.tasks) ? (taskRes as Any).tasks : [];
    const remoteWorkspaces = Array.isArray((workspaceRes as Any)?.workspaces)
      ? (workspaceRes as Any).workspaces
      : [];
    const repo = new TaskRepository(db);
    const targetNodeId = remoteDevice.taskNodeId || `remote-gateway:${remoteDevice.id}`;
    const targetNodeAliases = await getManagedRemoteNodeAliases(remoteDevice, nodeId);
    const remoteTaskIds: string[] = [];
    let oldestFetchedCreatedAt: number | undefined;
    for (const remoteTask of remoteTasks) {
      if (typeof remoteTask?.id === "string" && remoteTask.id.trim()) {
        remoteTaskIds.push(remoteTask.id.trim());
      }
      if (typeof remoteTask?.createdAt === "number" && Number.isFinite(remoteTask.createdAt)) {
        oldestFetchedCreatedAt =
          oldestFetchedCreatedAt === undefined
            ? remoteTask.createdAt
            : Math.min(oldestFetchedCreatedAt, remoteTask.createdAt);
      }
      const workspaceId = resolveLocalWorkspaceIdForRemoteTask(
        db,
        remoteWorkspaces,
        remoteTask,
        fallbackWorkspaceId,
      );
      if (workspaceId) {
        upsertRemoteShadowTask(db, workspaceId, targetNodeId, remoteTask);
      }
    }

    // Only prune rows that are guaranteed to be covered by the first page of remote tasks.
    if (remoteTasks.length === 0) {
      repo.pruneByTargetNodeIds(targetNodeAliases, []);
    } else if (oldestFetchedCreatedAt !== undefined) {
      repo.pruneByTargetNodeIds(targetNodeAliases, remoteTaskIds, oldestFetchedCreatedAt);
    }
  } catch (error) {
    console.warn(`[ControlPlane] Failed to sync remote task list for ${remoteDevice.id}:`, error);
  }
}

function listLocalDeviceTasks(taskRepo: TaskRepository, limit = 50): Task[] {
  return taskRepo
    .findAll(Math.max(limit * 3, limit), 0)
    .filter((task) => !task.targetNodeId || isLocalManagedDeviceIdentifier(task.targetNodeId))
    .slice(0, limit);
}

async function listTasksForNode(nodeId: string): Promise<Task[]> {
  if (!controlPlaneDeps?.dbManager) return [];
  const db = controlPlaneDeps.dbManager.getDatabase();
  const taskRepo = new TaskRepository(db);

  if (isLocalManagedDeviceIdentifier(nodeId)) {
    return listLocalDeviceTasks(taskRepo, 50);
  }

  await syncRemoteShadowTasksForNode(nodeId);
  const remoteDevice = await findManagedRemoteDeviceByNodeId(nodeId);
  if (!remoteDevice) return [];
  const aliases = await getManagedRemoteNodeAliases(remoteDevice, nodeId);
  return taskRepo.findByTargetNodeIds(aliases, 50);
}

function buildAlertsFromSummaryParts(params: {
  device: ManagedDevice;
  recentTasks: Task[];
  channels?: Any[];
  approvalsPending?: number;
  inputRequestsPending?: number;
  freeBytes?: number;
}): ManagedDeviceAlert[] {
  const alerts: ManagedDeviceAlert[] = [];
  const connectionState = params.device.status;
  if (params.device.role === "remote" && connectionState !== "connected") {
    alerts.push({
      id: `${params.device.id}:connection`,
      level:
        connectionState === "error" ? "critical" : connectionState === "reconnecting" ? "warning" : "info",
      title:
        connectionState === "disconnected" ? "Device offline" : `Connection ${connectionState}`,
      description:
        connectionState === "disconnected"
          ? "Saved for later. Connect this device to run or inspect live work."
          : undefined,
      kind: "connection",
    });
  }

  if ((params.approvalsPending || 0) > 0) {
    alerts.push({
      id: `${params.device.id}:approvals`,
      level: "warning",
      title: `${params.approvalsPending} approval${params.approvalsPending === 1 ? "" : "s"} pending`,
      description: "A task is waiting for a decision.",
      kind: "approval",
    });
  }

  if ((params.inputRequestsPending || 0) > 0) {
    alerts.push({
      id: `${params.device.id}:input`,
      level: "warning",
      title: `${params.inputRequestsPending} input request${params.inputRequestsPending === 1 ? "" : "s"} pending`,
      description: "A task is waiting for user input.",
      kind: "input_request",
    });
  }

  const failingChannels = (params.channels || []).filter(
    (channel) => channel?.enabled && channel?.status === "error",
  );
  if (failingChannels.length > 0) {
    alerts.push({
      id: `${params.device.id}:channels`,
      level: "warning",
      title: `${failingChannels.length} app connection${failingChannels.length === 1 ? "" : "s"} need attention`,
      description: "One or more enabled channels are in an error state.",
      kind: "channel",
    });
  }

  if (
    params.freeBytes !== undefined &&
    Number.isFinite(params.freeBytes) &&
    params.freeBytes < 5 * 1024 * 1024 * 1024
  ) {
    alerts.push({
      id: `${params.device.id}:storage`,
      level: "warning",
      title: "Low disk space",
      description: "Less than 5 GB is available for tasks and artifacts.",
      kind: "storage",
    });
  }

  for (const task of params.recentTasks) {
    if (!isTaskAttention(task)) continue;
    alerts.push({
      id: `${params.device.id}:task:${task.id}`,
      level: "warning",
      title: task.title || task.prompt || "Task needs attention",
      description:
        task.terminalStatus === "awaiting_approval"
          ? "Awaiting approval"
          : task.terminalStatus === "needs_user_action"
            ? "Awaiting user input"
            : "Task is blocked",
      kind: "status",
    });
  }

  return alerts.slice(0, 10);
}

function attentionFromAlerts(alerts: ManagedDeviceAlert[]): ManagedDeviceAttentionState {
  return alerts.reduce<ManagedDeviceAttentionState>(
    (current, alert) => maxAttentionLevel(current, alert.level),
    "none",
  );
}

async function buildLocalManagedDeviceSummary(): Promise<ManagedDeviceSummary> {
  const device = buildLocalManagedDevice();
  const configSnapshot = await getLocalConfigSnapshot();
  if (!controlPlaneDeps?.dbManager) {
    return {
      device,
      runtime: configSnapshot.runtime,
      tasks: { total: 0, active: 0, attention: 0, recent: [] },
      apps: {
        channelsTotal: 0,
        channelsEnabled: 0,
        workspacesTotal: 0,
        approvalsPending: 0,
        inputRequestsPending: 0,
        channels: [],
        workspaces: [],
        accounts: [],
      },
      storage: { workspaceCount: 0, artifactCount: 0, workspaceRoots: [] },
      alerts: [],
      observer: [],
    };
  }

  const db = controlPlaneDeps.dbManager.getDatabase();
  const taskRepo = new TaskRepository(db);
  const inputRequestRepo = new InputRequestRepository(db);
  const recentTasks = listLocalDeviceTasks(taskRepo, 12);
  const approvalsPendingRow = db
    .prepare("SELECT COUNT(1) AS count FROM approvals WHERE status = 'pending'")
    .get() as Any;
  const approvalsPending = Number(approvalsPendingRow?.count || 0);
  const inputRequestsPending = inputRequestRepo.list({
    limit: 100,
    offset: 0,
    status: "pending",
  }).length;
  const accounts = ManagedAccountManager.list().map((account) =>
    ManagedAccountManager.toPublicView(account, false),
  );
  const storageRes = await getLocalStorageSummary(db);
  const alerts = buildAlertsFromSummaryParts({
    device,
    recentTasks,
    channels: configSnapshot.channels.channels,
    approvalsPending,
    inputRequestsPending,
    freeBytes: storageRes.storage.freeBytes,
  });
  const active = Object.entries(configSnapshot.tasks.byStatus || {}).reduce((count, [status, value]) => {
    return count + (isActiveTaskStatus(status) ? Number(value || 0) : 0);
  }, 0);

  const hydratedDevice: ManagedDevice = {
    ...device,
    activeRunCount: active,
    appsSummary: {
      channelsTotal: Number(configSnapshot.channels.count || 0),
      channelsEnabled: Number(configSnapshot.channels.enabled || 0),
      workspacesTotal: Number(configSnapshot.workspaces.count || 0),
      approvalsPending,
      inputRequestsPending,
    },
    storageSummary: {
      workspaceCount: storageRes.storage.workspaceCount,
      artifactCount: storageRes.storage.artifactCount,
      ...(storageRes.storage.totalBytes !== undefined
        ? { totalBytes: storageRes.storage.totalBytes }
        : {}),
      ...(storageRes.storage.freeBytes !== undefined
        ? { freeBytes: storageRes.storage.freeBytes }
        : {}),
      ...(storageRes.storage.usedBytes !== undefined
        ? { usedBytes: storageRes.storage.usedBytes }
        : {}),
    },
    attentionState: attentionFromAlerts(alerts),
  };

  return {
    device: hydratedDevice,
    runtime: configSnapshot.runtime,
    tasks: {
      total: Number(configSnapshot.tasks.total || 0),
      active,
      attention: recentTasks.filter((task) => isTaskAttention(task)).length,
      recent: recentTasks,
    },
    apps: {
      channelsTotal: hydratedDevice.appsSummary?.channelsTotal || 0,
      channelsEnabled: hydratedDevice.appsSummary?.channelsEnabled || 0,
      workspacesTotal: hydratedDevice.appsSummary?.workspacesTotal || 0,
      approvalsPending,
      inputRequestsPending,
      channels: configSnapshot.channels.channels || [],
      workspaces: configSnapshot.workspaces.workspaces || [],
      accounts,
    },
    storage: storageRes.storage,
    alerts,
    observer: alerts.map((alert) => ({
      id: alert.id,
      timestamp: Date.now(),
      title: alert.title,
      detail: alert.description,
      level: alert.level,
    })),
  };
}

async function buildRemoteManagedDeviceSummary(device: ManagedDevice): Promise<ManagedDeviceSummary> {
  const fleetManager = getFleetConnectionManager();
  const client = fleetManager?.getClient(device.id);
  const status = fleetManager?.getStatus(device.id) || { state: "disconnected" as const };
  const connected = status.state === "connected";
  const db = controlPlaneDeps?.dbManager?.getDatabase() || null;
  const taskRepo = db ? new TaskRepository(db) : null;
  const aliases = await getManagedRemoteNodeAliases(device, device.taskNodeId || device.id);
  const fallbackTasks = taskRepo ? taskRepo.findByTargetNodeIds(aliases, 12) : [];

  let configSnapshot: Any = null;
  let taskSnapshot: Task[] = fallbackTasks;
  let channels: Any[] = [];
  let workspaces: Any[] = [];
  let approvals: Any[] = [];
  let inputRequests: Any[] = [];
  let accounts: Any[] = [];

  if (connected && client) {
    const [
      configResult,
      taskResult,
      channelResult,
      workspaceResult,
      approvalResult,
      inputResult,
      accountResult,
    ] = await Promise.allSettled([
      client.request(Methods.CONFIG_GET, undefined, 5000),
      client.request(Methods.TASK_LIST, { limit: 12, offset: 0 }, 5000),
      client.request(Methods.CHANNEL_LIST, undefined, 5000),
      client.request(Methods.WORKSPACE_LIST, undefined, 5000),
      client.request(Methods.APPROVAL_LIST, { limit: 20, offset: 0 }, 5000),
      client.request(Methods.INPUT_REQUEST_LIST, { limit: 20, offset: 0, status: "pending" }, 5000),
      client.request(Methods.ACCOUNT_LIST, { includeSecrets: false }, 5000),
    ]);

    if (configResult.status === "fulfilled") configSnapshot = configResult.value;
    if (taskResult.status === "fulfilled" && Array.isArray((taskResult.value as Any)?.tasks)) {
      taskSnapshot = (taskResult.value as Any).tasks as Task[];
    }
    if (channelResult.status === "fulfilled") {
      channels = Array.isArray((channelResult.value as Any)?.channels)
        ? (channelResult.value as Any).channels
        : [];
    }
    if (workspaceResult.status === "fulfilled") {
      workspaces = Array.isArray((workspaceResult.value as Any)?.workspaces)
        ? (workspaceResult.value as Any).workspaces
        : [];
    }
    if (approvalResult.status === "fulfilled") {
      approvals = Array.isArray((approvalResult.value as Any)?.approvals)
        ? (approvalResult.value as Any).approvals
        : [];
    }
    if (inputResult.status === "fulfilled") {
      inputRequests = Array.isArray((inputResult.value as Any)?.inputRequests)
        ? (inputResult.value as Any).inputRequests
        : [];
    }
    if (accountResult.status === "fulfilled") {
      accounts = Array.isArray((accountResult.value as Any)?.accounts)
        ? (accountResult.value as Any).accounts
        : [];
    }

    if (db) {
      const fallbackWorkspaceId = getDefaultLocalWorkspaceId(db);
      const targetNodeId = device.taskNodeId || `remote-gateway:${device.id}`;
      for (const task of taskSnapshot) {
        const workspaceId = resolveLocalWorkspaceIdForRemoteTask(
          db,
          workspaces,
          task,
          fallbackWorkspaceId,
        );
        if (workspaceId) {
          upsertRemoteShadowTask(db, workspaceId, targetNodeId, task);
        }
      }
    }
  }

  const total =
    Number(configSnapshot?.tasks?.total || 0) ||
    (taskRepo ? taskRepo.findByTargetNodeIds(aliases, 200).length : taskSnapshot.length);
  const active =
    configSnapshot?.tasks?.byStatus
      ? Object.entries(configSnapshot.tasks.byStatus).reduce((count, [state, value]) => {
          return count + (isActiveTaskStatus(state) ? Number(value || 0) : 0);
        }, 0)
      : taskSnapshot.filter((task) => isActiveTaskStatus(task.status)).length;
  const storage = {
    workspaceCount: workspaces.length || device.storageSummary?.workspaceCount || 0,
    artifactCount: device.storageSummary?.artifactCount || 0,
    workspaceRoots: workspaces
      .filter((workspace) => typeof workspace?.path === "string" && workspace.path.trim())
      .map((workspace) => ({
        id: String(workspace.id || ""),
        name: String(workspace.name || workspace.path || "Workspace"),
        path: String(workspace.path || ""),
      })),
  };
  const alerts = buildAlertsFromSummaryParts({
    device: { ...device, status: status.state, lastSeenAt: status.lastActivityAt || device.lastSeenAt },
    recentTasks: taskSnapshot,
    channels,
    approvalsPending: approvals.length,
    inputRequestsPending: inputRequests.length,
  });

  const hydratedDevice: ManagedDevice = {
    ...device,
    status: status.state,
    clientId: status.clientId || device.clientId,
    connectedAt: status.connectedAt || device.connectedAt,
    lastSeenAt: status.lastActivityAt || status.connectedAt || device.lastSeenAt,
    version:
      typeof configSnapshot?.runtime?.coworkVersion === "string"
        ? configSnapshot.runtime.coworkVersion
        : device.version,
    platform: toNodePlatform(configSnapshot?.runtime?.platform || device.platform),
    activeRunCount: active,
    attentionState: attentionFromAlerts(alerts),
    appsSummary: {
      channelsTotal: Number(configSnapshot?.channels?.count || channels.length || 0),
      channelsEnabled: Number(configSnapshot?.channels?.enabled || channels.filter((channel) => channel?.enabled).length || 0),
      workspacesTotal: Number(configSnapshot?.workspaces?.count || workspaces.length || 0),
      approvalsPending: approvals.length,
      inputRequestsPending: inputRequests.length,
    },
    storageSummary: {
      workspaceCount: storage.workspaceCount,
      artifactCount: storage.artifactCount,
    },
  };

  return {
    device: hydratedDevice,
    runtime: configSnapshot?.runtime,
    tasks: {
      total,
      active,
      attention: taskSnapshot.filter((task) => isTaskAttention(task)).length,
      recent: taskSnapshot,
    },
    apps: {
      channelsTotal: hydratedDevice.appsSummary?.channelsTotal || 0,
      channelsEnabled: hydratedDevice.appsSummary?.channelsEnabled || 0,
      workspacesTotal: hydratedDevice.appsSummary?.workspacesTotal || 0,
      approvalsPending: approvals.length,
      inputRequestsPending: inputRequests.length,
      channels,
      workspaces,
      accounts,
    },
    storage,
    alerts,
    observer: fleetManager?.getObserver(device.id) || [],
  };
}

async function buildManagedDeviceSummary(deviceId: string): Promise<ManagedDeviceSummary> {
  if (isLocalManagedDeviceIdentifier(deviceId)) {
    return buildLocalManagedDeviceSummary();
  }
  const device = findManagedDeviceById(deviceId);
  if (!device || device.role !== "remote") {
    throw new Error(`Managed device not found: ${deviceId}`);
  }
  return buildRemoteManagedDeviceSummary(device);
}

async function listManagedDevicesForRenderer(): Promise<ManagedDevice[]> {
  let local = buildLocalManagedDevice();
  try {
    local = (await buildLocalManagedDeviceSummary()).device;
  } catch {
    // Best effort only.
  }

  const fleetManager = ensureFleetManager();
  const remotes = listStoredManagedDevices()
    .map((device) => {
      const status = fleetManager.getStatus(device.id);
      return {
        ...device,
        status: status.state,
        clientId: status.clientId || device.clientId,
        connectedAt: status.connectedAt || device.connectedAt,
        lastSeenAt: status.lastActivityAt || status.connectedAt || device.lastSeenAt,
      };
    })
    .sort((a, b) => {
      if (a.status === "connected" && b.status !== "connected") return -1;
      if (b.status === "connected" && a.status !== "connected") return 1;
      return (a.name || "").localeCompare(b.name || "");
    });
  return [local, ...remotes];
}

function forwardRemoteTaskEvent(deviceId: string, payload: unknown): void {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) return;
  const taskEvent = payload as Any;
  const taskId = taskEvent?.taskId;
  if (!taskId) return;

  mainWindowRef.webContents.send(IPC_CHANNELS.TASK_EVENT, {
    ...taskEvent,
    deviceId,
  });

  if (!controlPlaneDeps?.dbManager) return;
  const status = taskEvent?.status || taskEvent?.payload?.status;
  if (!status) return;
  try {
    const db = controlPlaneDeps.dbManager.getDatabase();
    const repo = new TaskRepository(db);
    const existing = repo.findById(taskId);
    if (!existing) return;
    const remoteNodeId = listStoredManagedDevices().find((d) => d.id === deviceId)?.taskNodeId;
    const isRemoteShadow =
      remoteNodeId &&
      (existing.targetNodeId === remoteNodeId ||
        existing.targetNodeId === `remote-gateway:${deviceId}`);
    if (!isRemoteShadow) return;
    repo.update(taskId, { status });
  } catch (error) {
    console.error(`[RemoteGateway] Failed to update local task ${taskId}:`, error);
  }
}

function ensureFleetManager() {
  return initFleetConnectionManager({
    onStateChange: ({ deviceId, state, error, status }) => {
      if (mainWindowRef && !mainWindowRef.isDestroyed()) {
        mainWindowRef.webContents.send(IPC_CHANNELS.REMOTE_GATEWAY_EVENT, {
          type: "stateChange",
          deviceId,
          state,
          error,
          status,
        });
      }
    },
    onEvent: ({ deviceId, event, payload, status }) => {
      if (mainWindowRef && !mainWindowRef.isDestroyed()) {
        mainWindowRef.webContents.send(IPC_CHANNELS.REMOTE_GATEWAY_EVENT, {
          type: "event",
          deviceId,
          event,
          payload,
          status,
        });
      }
      if (event === Events.TASK_EVENT) {
        forwardRemoteTaskEvent(deviceId, payload);
      }
    },
    onTunnelStateChange: ({ deviceId, status, error }) => {
      if (mainWindowRef && !mainWindowRef.isDestroyed()) {
        mainWindowRef.webContents.send(IPC_CHANNELS.REMOTE_GATEWAY_EVENT, {
          type: "sshTunnelStateChange",
          deviceId,
          state: status.state,
          error: error || status.error,
          payload: { status },
        });
      }
    },
  });
}

function getLegacyActiveRemoteDeviceId(): string | null {
  const settings = ControlPlaneSettingsManager.loadSettings();
  if (
    settings.activeManagedDeviceId &&
    settings.activeManagedDeviceId !== LOCAL_MANAGED_DEVICE_ID
  ) {
    return settings.activeManagedDeviceId;
  }
  if (settings.activeRemoteDeviceId) {
    return settings.activeRemoteDeviceId;
  }
  return listStoredManagedDevices()[0]?.id || null;
}

async function connectManagedRemoteDevice(deviceId: string): Promise<RemoteGatewayStatus> {
  const device = findManagedDeviceById(deviceId);
  if (!device || device.role !== "remote") {
    throw new Error(`Managed device not found: ${deviceId}`);
  }
  const fleetManager = ensureFleetManager();
  const status = await fleetManager.connectDevice(device);
  ControlPlaneSettingsManager.updateSettings({
    activeManagedDeviceId: device.id,
    activeRemoteDeviceId: device.id,
    remote: device.config,
  });
  return status;
}

function disconnectManagedRemoteDevice(deviceId: string): RemoteGatewayStatus {
  const fleetManager = ensureFleetManager();
  fleetManager.disconnectDevice(deviceId);
  return fleetManager.getStatus(deviceId);
}

async function routeLocalDeviceProxyRequest(method: string, params?: unknown): Promise<Any> {
  if (!controlPlaneDeps?.dbManager) {
    throw new Error("No database");
  }
  const db = controlPlaneDeps.dbManager.getDatabase();
  const taskRepo = new TaskRepository(db);
  const eventRepo = new TaskEventRepository(db);
  const workspaceRepo = new WorkspaceRepository(db);
  const channelRepo = new ChannelRepository(db);
  const inputRequestRepo = new InputRequestRepository(db);
  const approvalRepo = new ApprovalRepository(db);
  const channelGateway = controlPlaneDeps.channelGateway;

  switch (method) {
    case Methods.CONFIG_GET:
      return getLocalConfigSnapshot();
    case Methods.WORKSPACE_LIST: {
      const workspaces = workspaceRepo
        .findAll()
        .filter((workspace) => !workspace.isTemp && !isTempWorkspaceId(workspace.id));
      return { workspaces };
    }
    case Methods.TASK_LIST: {
      const { limit, offset, workspaceId } = sanitizeTaskListParams(params);
      const tasks = listLocalDeviceTasks(taskRepo, limit + offset).slice(offset);
      return {
        tasks: workspaceId ? tasks.filter((task) => task.workspaceId === workspaceId) : tasks,
      };
    }
    case Methods.TASK_GET: {
      const { taskId } = sanitizeTaskIdParams(params);
      return { task: taskRepo.findById(taskId) || null };
    }
    case Methods.TASK_EVENTS: {
      const { taskId, limit } = sanitizeTaskEventsParams(params);
      const events = buildTaskEventHistoryForTransport({
        taskId,
        limit,
        taskRepo,
        eventRepo,
      }).map((event) => serializeTaskEventForTransport(event, sanitizeForBroadcast));
      return { events };
    }
    case Methods.TASK_CANCEL: {
      const { taskId } = sanitizeTaskIdParams(params);
      await controlPlaneDeps.agentDaemon.cancelTask(taskId);
      return { ok: true };
    }
    case Methods.TASK_SEND_MESSAGE: {
      const { taskId, message, images, quotedAssistantMessage } = sanitizeTaskMessageParams(params);
      await controlPlaneDeps.agentDaemon.sendMessage(taskId, message, images, quotedAssistantMessage);
      return { ok: true };
    }
    case Methods.APPROVAL_LIST: {
      const { limit, offset, taskId } = sanitizeApprovalListParams(params);
      const approvals = taskId
        ? approvalRepo.findPendingByTaskId(taskId).slice(offset, offset + limit)
        : (() => {
            const stmt = db.prepare(`
              SELECT * FROM approvals
              WHERE status = 'pending'
              ORDER BY requested_at ASC
              LIMIT ? OFFSET ?
            `);
            return stmt.all(limit, offset) as Any[];
          })();
      return { approvals };
    }
    case Methods.APPROVAL_RESPOND: {
      const { approvalId, approved } = sanitizeApprovalRespondParams(params);
      const status = await controlPlaneDeps.agentDaemon.respondToApproval(approvalId, approved);
      return { status };
    }
    case Methods.INPUT_REQUEST_LIST: {
      const p = (params ?? {}) as Any;
      return {
        inputRequests: inputRequestRepo.list({
          limit:
            typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.max(1, p.limit) : 50,
          offset:
            typeof p.offset === "number" && Number.isFinite(p.offset) ? Math.max(0, p.offset) : 0,
          ...(typeof p.taskId === "string" && p.taskId.trim() ? { taskId: p.taskId.trim() } : {}),
          ...(typeof p.status === "string" && p.status.trim() ? { status: p.status.trim() } : {}),
        }),
      };
    }
    case Methods.INPUT_REQUEST_RESPOND:
      return controlPlaneDeps.agentDaemon.respondToInputRequest(params as Any);
    case Methods.CHANNEL_LIST:
      return { channels: channelRepo.findAll() };
    case Methods.CHANNEL_GET: {
      const { channelId } = sanitizeChannelIdParams(params);
      return { channel: channelRepo.findById(channelId) || null };
    }
    case Methods.CHANNEL_CREATE: {
      const validated = sanitizeChannelCreateParams(params);
      const existing = channelRepo.findByType(validated.type);
      if (existing?.id) {
        throw new Error(`Channel type "${validated.type}" already exists`);
      }
      const id = randomUUID();
      db.prepare(`
        INSERT INTO channels (id, type, name, enabled, config, security_config, status, bot_username, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        validated.type,
        validated.name,
        validated.enabled ? 1 : 0,
        JSON.stringify(validated.config || {}),
        JSON.stringify(validated.securityConfig || { mode: "pairing" }),
        "disconnected",
        null,
        Date.now(),
        Date.now(),
      );
      if (validated.enabled && channelGateway) {
        await channelGateway.enableChannel(id);
      }
      return { channelId: id };
    }
    case Methods.CHANNEL_UPDATE: {
      const { channelId, updates } = sanitizeChannelUpdateParams(params);
      if (channelGateway) {
        channelGateway.updateChannel(channelId, updates as Any);
        return { ok: true };
      }
      // Gateway not initialized: persist to DB; gateway will pick up on restart
      channelRepo.update(channelId, updates as Any);
      return { ok: true, restartRequired: true };
    }
    case Methods.CHANNEL_ENABLE: {
      const { channelId } = sanitizeChannelIdParams(params);
      if (!channelGateway) {
        channelRepo.update(channelId, { enabled: true });
        return { ok: true, restartRequired: true };
      }
      await channelGateway.enableChannel(channelId);
      return { ok: true };
    }
    case Methods.CHANNEL_DISABLE: {
      const { channelId } = sanitizeChannelIdParams(params);
      if (!channelGateway) {
        channelRepo.update(channelId, { enabled: false, status: "disconnected" as Any });
        return { ok: true, restartRequired: true };
      }
      await channelGateway.disableChannel(channelId);
      return { ok: true };
    }
    case Methods.CHANNEL_TEST: {
      const { channelId } = sanitizeChannelIdParams(params);
      if (!channelGateway) {
        return { success: false, error: "Channel gateway not available (restart required)" };
      }
      return channelGateway.testChannel(channelId);
    }
    case Methods.CHANNEL_REMOVE: {
      const { channelId } = sanitizeChannelIdParams(params);
      if (!channelGateway) {
        channelRepo.delete(channelId);
        return { ok: true, restartRequired: true };
      }
      await channelGateway.removeChannel(channelId);
      return { ok: true };
    }
    case Methods.ACCOUNT_LIST: {
      const payload = params && typeof params === "object" ? (params as Any) : {};
      const accounts = ManagedAccountManager.list({
        provider: typeof payload.provider === "string" ? payload.provider : undefined,
        status: typeof payload.status === "string" ? payload.status : undefined,
      });
      return {
        accounts: accounts.map((account) =>
          ManagedAccountManager.toPublicView(account, payload.includeSecrets === true),
        ),
      };
    }
    case Methods.ACCOUNT_GET: {
      const payload = params && typeof params === "object" ? (params as Any) : {};
      const accountId = typeof payload.accountId === "string" ? payload.accountId.trim() : "";
      if (!accountId) throw new Error("accountId is required");
      const account = ManagedAccountManager.getById(accountId);
      return {
        account: account
          ? ManagedAccountManager.toPublicView(account, payload.includeSecrets === true)
          : null,
      };
    }
    case Methods.ACCOUNT_UPSERT: {
      const account = ManagedAccountManager.upsert((params ?? {}) as Any);
      return { account: ManagedAccountManager.toPublicView(account, false) };
    }
    case Methods.ACCOUNT_REMOVE: {
      const payload = params && typeof params === "object" ? (params as Any) : {};
      const accountId = typeof payload.accountId === "string" ? payload.accountId.trim() : "";
      if (!accountId) throw new Error("accountId is required");
      return { removed: ManagedAccountManager.remove(accountId) };
    }
    default:
      throw new Error(`Unsupported local proxy method: ${method}`);
  }
}

function sanitizeTaskCreateParams(params: unknown): {
  title: string;
  prompt: string;
  workspaceId: string;
  assignedAgentRoleId?: string;
  agentConfig?: AgentConfig;
  budgetTokens?: number;
  budgetCost?: number;
  shellAccess?: boolean;
} {
  const p = (params ?? {}) as any;
  const title = typeof p.title === "string" ? p.title.trim() : "";
  const prompt = typeof p.prompt === "string" ? p.prompt.trim() : "";
  const workspaceId = typeof p.workspaceId === "string" ? p.workspaceId.trim() : "";
  const assignedAgentRoleId =
    typeof p.assignedAgentRoleId === "string" ? p.assignedAgentRoleId.trim() : "";

  const budgetTokens =
    typeof p.budgetTokens === "number" && Number.isFinite(p.budgetTokens)
      ? Math.max(0, Math.floor(p.budgetTokens))
      : undefined;
  const budgetCost =
    typeof p.budgetCost === "number" && Number.isFinite(p.budgetCost)
      ? Math.max(0, p.budgetCost)
      : undefined;
  const shellAccess = p.shellAccess === true;

  const agentConfig: AgentConfig | undefined = (() => {
    if (!p.agentConfig || typeof p.agentConfig !== "object") return undefined;
    const parsed = AgentConfigSchema.safeParse(p.agentConfig);
    if (!parsed.success) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: "agentConfig is invalid" };
    }
    return parsed.data;
  })();

  if (!title) throw { code: ErrorCodes.INVALID_PARAMS, message: "title is required" };
  if (!prompt) throw { code: ErrorCodes.INVALID_PARAMS, message: "prompt is required" };
  if (!workspaceId) throw { code: ErrorCodes.INVALID_PARAMS, message: "workspaceId is required" };

  return {
    title,
    prompt,
    workspaceId,
    ...(assignedAgentRoleId ? { assignedAgentRoleId } : {}),
    ...(agentConfig ? { agentConfig } : {}),
    ...(budgetTokens !== undefined ? { budgetTokens } : {}),
    ...(budgetCost !== undefined ? { budgetCost } : {}),
    ...(shellAccess ? { shellAccess } : {}),
  };
}

function sanitizeTaskIdParams(params: unknown): { taskId: string } {
  const p = (params ?? {}) as any;
  const taskId = typeof p.taskId === "string" ? p.taskId.trim() : "";
  if (!taskId) throw { code: ErrorCodes.INVALID_PARAMS, message: "taskId is required" };
  return { taskId };
}

function sanitizeApprovalRespondParams(params: unknown): { approvalId: string; approved: boolean } {
  const p = (params ?? {}) as any;
  const approvalId = typeof p.approvalId === "string" ? p.approvalId.trim() : "";
  const approved = p.approved;
  if (!approvalId) throw { code: ErrorCodes.INVALID_PARAMS, message: "approvalId is required" };
  if (typeof approved !== "boolean")
    throw { code: ErrorCodes.INVALID_PARAMS, message: "approved is required (boolean)" };
  return { approvalId, approved };
}

function sanitizeTaskListParams(params: unknown): {
  limit: number;
  offset: number;
  workspaceId?: string;
} {
  const p = (params ?? {}) as any;
  const rawLimit =
    typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.floor(p.limit) : 100;
  const rawOffset =
    typeof p.offset === "number" && Number.isFinite(p.offset) ? Math.floor(p.offset) : 0;
  const limit = Math.min(Math.max(rawLimit, 1), 500);
  const offset = Math.max(rawOffset, 0);
  const workspaceId = typeof p.workspaceId === "string" ? p.workspaceId.trim() : "";
  return { limit, offset, ...(workspaceId ? { workspaceId } : {}) };
}

function sanitizeApprovalListParams(params: unknown): {
  limit: number;
  offset: number;
  taskId?: string;
} {
  const p = (params ?? {}) as any;
  const rawLimit =
    typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.floor(p.limit) : 100;
  const rawOffset =
    typeof p.offset === "number" && Number.isFinite(p.offset) ? Math.floor(p.offset) : 0;
  const limit = Math.min(Math.max(rawLimit, 1), 500);
  const offset = Math.max(rawOffset, 0);
  const taskId = typeof p.taskId === "string" ? p.taskId.trim() : "";
  return { limit, offset, ...(taskId ? { taskId } : {}) };
}

function sanitizeTaskEventsParams(params: unknown): { taskId: string; limit: number } {
  const p = (params ?? {}) as any;
  const { taskId } = sanitizeTaskIdParams(params);
  const rawLimit =
    typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.floor(p.limit) : 200;
  const limit = Math.min(Math.max(rawLimit, 1), 2000);
  return { taskId, limit };
}

function sanitizeWorkspaceIdParams(params: unknown): { workspaceId: string } {
  const p = (params ?? {}) as any;
  const workspaceId = typeof p.workspaceId === "string" ? p.workspaceId.trim() : "";
  if (!workspaceId) throw { code: ErrorCodes.INVALID_PARAMS, message: "workspaceId is required" };
  return { workspaceId };
}

const ManagedAgentModelSchema = z.object({
  providerType: z.string().trim().min(1).max(120).optional(),
  modelKey: z.string().trim().min(1).max(200).optional(),
  llmProfile: z.enum(["strong", "cheap"]).optional(),
}).strict();

const ManagedAgentRuntimeDefaultsSchema = z.object({
  autonomousMode: z.boolean().optional(),
  requireWorktree: z.boolean().optional(),
  allowUserInput: z.boolean().optional(),
  allowedTools: z.array(z.string().trim().min(1).max(200)).max(120).optional(),
  toolRestrictions: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  maxTurns: z.number().int().min(1).max(250).optional(),
  webSearchMode: z.enum(["disabled", "cached", "live"]).optional(),
}).strict();

const ManagedAgentTeamTemplateSchema = z.object({
  leadAgentRoleId: z.string().trim().min(1).max(200).optional(),
  memberAgentRoleIds: z.array(z.string().trim().min(1).max(200)).max(25).optional(),
  maxParallelAgents: z.number().int().min(1).max(25).optional(),
  collaborativeMode: z.boolean().optional(),
  multiLlmMode: z.boolean().optional(),
}).strict();

const ManagedAgentBaseSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  systemPrompt: z.string().trim().min(1).max(100_000),
  executionMode: z.enum(["solo", "team"]).default("solo"),
  model: ManagedAgentModelSchema.optional(),
  runtimeDefaults: ManagedAgentRuntimeDefaultsSchema.optional(),
  skills: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  mcpServers: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  teamTemplate: ManagedAgentTeamTemplateSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

const ManagedEnvironmentConfigSchema = z.object({
  workspaceId: z.string().trim().min(1).max(200),
  requireWorktree: z.boolean().optional(),
  enableShell: z.boolean().optional(),
  enableBrowser: z.boolean().optional(),
  enableComputerUse: z.boolean().optional(),
  allowedMcpServerIds: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  skillPackIds: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  credentialRefs: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  managedAccountRefs: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
}).strict();

const ManagedEnvironmentPatchSchema = ManagedEnvironmentConfigSchema.partial().extend({
  workspaceId: z.string().trim().min(1).max(200).optional(),
}).strict();

const ManagedSessionInitialEventSchema = z.object({
  type: z.literal("user.message"),
  content: z.array(z.union([
    z.object({
      type: z.literal("text"),
      text: z.string().trim().min(1).max(50_000),
    }).strict(),
    z.object({
      type: z.literal("file"),
      artifactId: z.string().trim().min(1).max(200),
    }).strict(),
  ])).min(1).max(20),
}).strict();

function sanitizeManagedAgentCreateParams(params: unknown): Any {
  return validateInput(ManagedAgentBaseSchema, params, "managed agent");
}

function sanitizeManagedAgentUpdateParams(params: unknown): Any {
  const parsed = validateInput(
    z.object({
      agentId: z.string().trim().min(1).max(200),
      name: z.string().trim().min(1).max(200).optional(),
      description: z.string().trim().max(2000).optional(),
      systemPrompt: z.string().trim().min(1).max(100_000).optional(),
      executionMode: z.enum(["solo", "team"]).optional(),
      model: ManagedAgentModelSchema.optional(),
      runtimeDefaults: ManagedAgentRuntimeDefaultsSchema.optional(),
      skills: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
      mcpServers: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
      teamTemplate: ManagedAgentTeamTemplateSchema.optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }).strict(),
    params,
    "managed agent update",
  );
  return parsed;
}

function sanitizeManagedAgentIdParams(params: unknown): { agentId: string } {
  const p = (params ?? {}) as Any;
  const agentId = typeof p.agentId === "string" ? p.agentId.trim() : "";
  if (!agentId) throw { code: ErrorCodes.INVALID_PARAMS, message: "agentId is required" };
  return { agentId };
}

function sanitizeManagedAgentVersionParams(params: unknown): { agentId: string; version: number } {
  const p = (params ?? {}) as Any;
  const { agentId } = sanitizeManagedAgentIdParams(params);
  const version =
    typeof p.version === "number" && Number.isFinite(p.version) ? Math.max(1, Math.floor(p.version)) : 0;
  if (!version) throw { code: ErrorCodes.INVALID_PARAMS, message: "version is required" };
  return { agentId, version };
}

function sanitizeManagedEnvironmentCreateParams(params: unknown): Any {
  return validateInput(
    z.object({
      name: z.string().trim().min(1).max(200),
      kind: z.literal("cowork_local").default("cowork_local"),
      config: ManagedEnvironmentConfigSchema,
    }).strict(),
    params,
    "managed environment",
  );
}

function sanitizeManagedEnvironmentUpdateParams(params: unknown): Any {
  return validateInput(
    z.object({
      environmentId: z.string().trim().min(1).max(200),
      name: z.string().trim().min(1).max(200).optional(),
      config: ManagedEnvironmentPatchSchema.optional(),
    }).strict(),
    params,
    "managed environment update",
  );
}

function sanitizeManagedEnvironmentIdParams(params: unknown): { environmentId: string } {
  const p = (params ?? {}) as Any;
  const environmentId = typeof p.environmentId === "string" ? p.environmentId.trim() : "";
  if (!environmentId) {
    throw { code: ErrorCodes.INVALID_PARAMS, message: "environmentId is required" };
  }
  return { environmentId };
}

function sanitizeManagedSessionCreateParams(params: unknown): Any {
  return validateInput(
    z.object({
      agentId: z.string().trim().min(1).max(200),
      environmentId: z.string().trim().min(1).max(200),
      title: z.string().trim().min(1).max(500),
      initialEvent: ManagedSessionInitialEventSchema.optional(),
    }).strict(),
    params,
    "managed session",
  );
}

function sanitizeManagedSessionIdParams(params: unknown): { sessionId: string } {
  const p = (params ?? {}) as Any;
  const sessionId = typeof p.sessionId === "string" ? p.sessionId.trim() : "";
  if (!sessionId) throw { code: ErrorCodes.INVALID_PARAMS, message: "sessionId is required" };
  return { sessionId };
}

function sanitizeManagedSessionListParams(params: unknown): Any {
  const p = (params ?? {}) as Any;
  const rawLimit =
    typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.floor(p.limit) : 100;
  const rawOffset =
    typeof p.offset === "number" && Number.isFinite(p.offset) ? Math.floor(p.offset) : 0;
  return {
    limit: Math.min(Math.max(rawLimit, 1), 500),
    offset: Math.max(rawOffset, 0),
    workspaceId: typeof p.workspaceId === "string" ? p.workspaceId.trim() || undefined : undefined,
    status: typeof p.status === "string" ? p.status.trim() || undefined : undefined,
  };
}

function sanitizeManagedSessionEventsParams(params: unknown): { sessionId: string; limit: number } {
  const p = (params ?? {}) as Any;
  const { sessionId } = sanitizeManagedSessionIdParams(params);
  const rawLimit =
    typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.floor(p.limit) : 500;
  return { sessionId, limit: Math.min(Math.max(rawLimit, 1), 5000) };
}

function sanitizeManagedSessionSendEventParams(params: unknown): Any {
  const p = (params ?? {}) as Any;
  const { sessionId } = sanitizeManagedSessionIdParams(params);
  const event = p.event;
  if (!event || typeof event !== "object") {
    throw { code: ErrorCodes.INVALID_PARAMS, message: "event is required" };
  }
  const type = (event as Any).type;
  if (type === "user.message") {
    return {
      sessionId,
      event: {
        type,
        content: Array.isArray((event as Any).content) ? (event as Any).content : [],
      },
    };
  }
  if (type === "input.received") {
    const requestId =
      typeof (event as Any).requestId === "string" ? (event as Any).requestId.trim() : "";
    if (!requestId) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: "event.requestId is required" };
    }
    return {
      sessionId,
      event: {
        type,
        requestId,
        answers:
          (event as Any).answers && typeof (event as Any).answers === "object"
            ? (event as Any).answers
            : undefined,
        status:
          (event as Any).status === "dismissed" || (event as Any).status === "submitted"
            ? (event as Any).status
            : "submitted",
      },
    };
  }
  throw { code: ErrorCodes.INVALID_PARAMS, message: "Unsupported managed session event type" };
}

function sanitizeWorkspaceCreateParams(params: unknown): { name: string; path: string } {
  const p = (params ?? {}) as any;
  const name = typeof p.name === "string" ? p.name.trim() : "";
  const rawPath = typeof p.path === "string" ? p.path.trim() : "";
  if (!name) throw { code: ErrorCodes.INVALID_PARAMS, message: "name is required" };
  if (!rawPath) throw { code: ErrorCodes.INVALID_PARAMS, message: "path is required" };

  const homeDir = process.env.HOME || process.env.USERPROFILE;
  const expanded =
    rawPath.startsWith("~/") && homeDir
      ? path.join(homeDir, rawPath.slice(2))
      : rawPath;
  if (!path.isAbsolute(expanded)) {
    throw {
      code: ErrorCodes.INVALID_PARAMS,
      message: "path must be an absolute path (or start with ~/)",
    };
  }

  return { name, path: path.resolve(expanded) };
}

function sanitizeChannelIdParams(params: unknown): { channelId: string } {
  const p = (params ?? {}) as any;
  const channelId = typeof p.channelId === "string" ? p.channelId.trim() : "";
  if (!channelId) throw { code: ErrorCodes.INVALID_PARAMS, message: "channelId is required" };
  return { channelId };
}

function sanitizeChannelCreateParams(params: unknown): {
  type: string;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  securityConfig: Record<string, unknown>;
} {
  const p = (params ?? {}) as any;
  const type = typeof p.type === "string" ? p.type.trim() : "";
  const name = typeof p.name === "string" ? p.name.trim() : "";
  const enabled = typeof p.enabled === "boolean" ? p.enabled : false;
  const config =
    p.config && typeof p.config === "object" ? (p.config as Record<string, unknown>) : {};
  const securityConfigRaw =
    p.securityConfig && typeof p.securityConfig === "object"
      ? (p.securityConfig as Record<string, unknown>)
      : {};

  if (!type) throw { code: ErrorCodes.INVALID_PARAMS, message: "type is required" };
  if (!name) throw { code: ErrorCodes.INVALID_PARAMS, message: "name is required" };

  // Provide safe defaults for security config if not specified.
  const defaults = {
    mode: "pairing",
    pairingCodeTTL: 300,
    maxPairingAttempts: 5,
    rateLimitPerMinute: 30,
  };

  const mode = typeof securityConfigRaw.mode === "string" ? securityConfigRaw.mode : undefined;
  const normalizedMode =
    mode === "open" || mode === "allowlist" || mode === "pairing" ? mode : defaults.mode;
  const allowedUsers = Array.isArray(securityConfigRaw.allowedUsers)
    ? securityConfigRaw.allowedUsers.filter((x) => typeof x === "string")
    : undefined;

  const securityConfig = {
    ...defaults,
    ...securityConfigRaw,
    mode: normalizedMode,
    ...(allowedUsers ? { allowedUsers } : {}),
  };

  return { type, name, enabled, config, securityConfig };
}

function sanitizeChannelUpdateParams(params: unknown): {
  channelId: string;
  updates: {
    name?: string;
    config?: Record<string, unknown>;
    securityConfig?: Record<string, unknown>;
  };
} {
  const p = (params ?? {}) as any;
  const channelId = typeof p.channelId === "string" ? p.channelId.trim() : "";
  if (!channelId) throw { code: ErrorCodes.INVALID_PARAMS, message: "channelId is required" };

  const updates: any = {};
  if (p.name !== undefined) {
    const name = typeof p.name === "string" ? p.name.trim() : "";
    if (!name)
      throw { code: ErrorCodes.INVALID_PARAMS, message: "name must be a non-empty string" };
    updates.name = name;
  }
  if (p.config !== undefined) {
    if (!p.config || typeof p.config !== "object") {
      throw { code: ErrorCodes.INVALID_PARAMS, message: "config must be an object" };
    }
    updates.config = p.config as Record<string, unknown>;
  }
  if (p.securityConfig !== undefined) {
    if (!p.securityConfig || typeof p.securityConfig !== "object") {
      throw { code: ErrorCodes.INVALID_PARAMS, message: "securityConfig must be an object" };
    }
    updates.securityConfig = p.securityConfig as Record<string, unknown>;
  }

  return { channelId, updates };
}

function maskSecretString(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 8) return "[redacted]";
  return `${trimmed.slice(0, 2)}...${trimmed.slice(-4)}`;
}

function redactObjectSecrets(input: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (input === null || input === undefined) return input;
  if (typeof input === "string") return input;
  if (typeof input !== "object") return input;
  if (Array.isArray(input)) return input.map((x) => redactObjectSecrets(x, depth + 1));

  const obj = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const secretKeyRe = /(token|secret|password|apiKey|accessKey|privateKey|signing|oauth)/i;
  for (const [k, v] of Object.entries(obj)) {
    if (secretKeyRe.test(k) && typeof v === "string") {
      out[k] = maskSecretString(v);
      continue;
    }
    out[k] = redactObjectSecrets(v, depth + 1);
  }
  return out;
}

const MAX_BROADCAST_STRING_CHARS = 2000;
const MAX_BROADCAST_ARRAY_ITEMS = 50;
const MAX_BROADCAST_OBJECT_KEYS = 50;
const MAX_BROADCAST_DEPTH = 3;
const SENSITIVE_KEY_RE = /(token|api[_-]?key|secret|password|authorization)/i;

function truncateForBroadcast(value: string): string {
  if (value.length <= MAX_BROADCAST_STRING_CHARS) return value;
  return (
    value.slice(0, MAX_BROADCAST_STRING_CHARS) + `\n\n[... truncated (${value.length} chars) ...]`
  );
}

const ALWAYS_REDACT_KEY_RE = /^(prompt|systemPrompt)$/i;

function truncateForBroadcastKey(value: string, key?: string): string {
  // Allow longer message bodies, but keep other fields short by default.
  const maxChars = key === "message" ? 12000 : MAX_BROADCAST_STRING_CHARS;
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars) + `\n\n[... truncated (${value.length} chars) ...]`;
}

function sanitizeForBroadcast(value: unknown, depth = 0, key?: string): unknown {
  if (depth > MAX_BROADCAST_DEPTH) {
    return "[... truncated ...]";
  }

  if (value === null || value === undefined) return value;
  if (typeof value === "string") return truncateForBroadcastKey(value, key);
  if (typeof value === "number" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    const next = value
      .slice(0, MAX_BROADCAST_ARRAY_ITEMS)
      .map((item) => sanitizeForBroadcast(item, depth + 1));
    if (value.length > MAX_BROADCAST_ARRAY_ITEMS) {
      next.push(`[... ${value.length - MAX_BROADCAST_ARRAY_ITEMS} more items truncated ...]`);
    }
    return next;
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    const out: Record<string, unknown> = {};

    for (const key of keys.slice(0, MAX_BROADCAST_OBJECT_KEYS)) {
      if (ALWAYS_REDACT_KEY_RE.test(key)) {
        out[key] = "[REDACTED]";
        continue;
      }
      if (SENSITIVE_KEY_RE.test(key)) {
        out[key] = "[REDACTED]";
        continue;
      }
      out[key] = sanitizeForBroadcast(obj[key], depth + 1, key);
    }

    if (keys.length > MAX_BROADCAST_OBJECT_KEYS) {
      out.__truncated_keys__ = keys.length - MAX_BROADCAST_OBJECT_KEYS;
    }

    return out;
  }

  try {
    return truncateForBroadcast(String(value));
  } catch {
    return "[unserializable]";
  }
}

function attachAgentDaemonTaskBridge(
  server: ControlPlaneServer,
  daemon: AgentDaemon,
  managedSessions?: ManagedSessionService,
): () => void {
  const allowlist = TASK_EVENT_BRIDGE_ALLOWLIST;

  const unsubscribes: Array<() => void> = [];

  for (const eventType of allowlist) {
    const handler = (evt: any) => {
      try {
        const taskId = typeof evt?.taskId === "string" ? evt.taskId : "";
        if (!taskId) return;

        const payload =
          evt?.payload && typeof evt.payload === "object" && !Array.isArray(evt.payload)
            ? ({ ...evt.payload } as any)
            : {};

        if (eventType === "timeline_step_updated" && typeof payload.message === "string") {
          payload.message = truncateForBroadcastKey(payload.message, "message");
        }

        if (eventType === "timeline_command_output" && typeof payload.output === "string") {
          payload.output = truncateForBroadcastKey(payload.output, "message");
        }

        if (eventType === "timeline_evidence_attached" && Array.isArray(payload.evidenceRefs)) {
          payload.evidenceRefs = payload.evidenceRefs.slice(0, 20).map((ref: any) => ({
            evidenceId:
              typeof ref?.evidenceId === "string" && ref.evidenceId.trim().length > 0
                ? ref.evidenceId.trim()
                : "evidence",
            sourceType:
              typeof ref?.sourceType === "string" && ref.sourceType.trim().length > 0
                ? ref.sourceType.trim()
                : "other",
            sourceUrlOrPath:
              typeof ref?.sourceUrlOrPath === "string"
                ? truncateForBroadcastKey(ref.sourceUrlOrPath, "sourceUrlOrPath")
                : "",
            snippet:
              typeof ref?.snippet === "string"
                ? truncateForBroadcastKey(ref.snippet, "snippet")
                : undefined,
          }));
        }

        const sanitizedPayload = sanitizeForBroadcast(payload);

        server.broadcastToOperators(Events.TASK_EVENT, {
          taskId,
          type: eventType,
          payload: sanitizedPayload,
          timestamp:
            typeof evt?.timestamp === "number" && Number.isFinite(evt.timestamp)
              ? evt.timestamp
              : Date.now(),
          schemaVersion: 2,
          eventId: typeof evt?.eventId === "string" ? evt.eventId : undefined,
          seq: typeof evt?.seq === "number" ? evt.seq : undefined,
          ts: typeof evt?.ts === "number" ? evt.ts : undefined,
          status: typeof evt?.status === "string" ? evt.status : undefined,
          stepId: typeof evt?.stepId === "string" ? evt.stepId : undefined,
          groupId: typeof evt?.groupId === "string" ? evt.groupId : undefined,
          actor: typeof evt?.actor === "string" ? evt.actor : undefined,
        });

        if (managedSessions) {
          const bridged = managedSessions.bridgeTaskEventNotification(taskId, {
            eventId: typeof evt?.eventId === "string" ? evt.eventId : undefined,
            timestamp:
              typeof evt?.timestamp === "number" && Number.isFinite(evt.timestamp)
                ? evt.timestamp
                : Date.now(),
            type: eventType,
            payload: sanitizedPayload,
            status: typeof evt?.status === "string" ? evt.status : undefined,
          });
          if (bridged.session) {
            server.broadcastToOperators(Events.MANAGED_SESSION_UPDATED, {
              sessionId: bridged.session.id,
              session: bridged.session,
            });
            if (bridged.appended) {
              server.broadcastToOperators(Events.MANAGED_SESSION_EVENT, {
                sessionId: bridged.session.id,
                event: bridged.appended,
              });
            }
            if (bridged.session.status === "completed") {
              server.broadcastToOperators(Events.MANAGED_SESSION_COMPLETED, {
                sessionId: bridged.session.id,
                session: bridged.session,
              });
            } else if (bridged.session.status === "failed") {
              server.broadcastToOperators(Events.MANAGED_SESSION_FAILED, {
                sessionId: bridged.session.id,
                session: bridged.session,
              });
            }
          }
        }
      } catch (error) {
        console.error("[ControlPlane] Failed to broadcast task event:", error);
      }
    };

    daemon.on(eventType, handler);
    unsubscribes.push(() => daemon.off(eventType, handler));
  }

  return () => {
    for (const off of unsubscribes) off();
  };
}

export async function startControlPlaneFromSettings(
  options: {
    deps?: ControlPlaneMethodDeps;
    forceEnable?: boolean;
    onEvent?: (event: any) => void;
  } = {},
): Promise<{
  ok: boolean;
  skipped?: boolean;
  address?: { host: string; port: number; wsUrl: string };
  tailscale?: { httpsUrl?: string; wssUrl?: string };
  error?: string;
}> {
  try {
    ControlPlaneSettingsManager.initialize();
    TailscaleSettingsManager.initialize();

    if (options.deps) {
      controlPlaneDeps = options.deps;
    }

    const settings = options.forceEnable
      ? ControlPlaneSettingsManager.enable()
      : ControlPlaneSettingsManager.loadSettings();

    const autoConnectDeviceIds = new Set(
      getStartupAutoConnectRemoteDeviceIds(listStoredManagedDevices()),
    );

    if (!settings.enabled && autoConnectDeviceIds.size === 0) {
      return { ok: true, skipped: true };
    }

    if (settings.enabled && !settings.token) {
      return { ok: false, error: "No authentication token configured" };
    }

    if (settings.enabled && controlPlaneServer?.isRunning) {
      for (const deviceId of autoConnectDeviceIds) {
        try {
          const status = ensureFleetManager().getStatus(deviceId);
          if (status.state !== "connected") {
            await connectManagedRemoteDevice(deviceId);
          }
        } catch (error) {
          console.warn(`[ControlPlane] Failed to auto-connect ${deviceId}:`, error);
        }
      }
      const addr = controlPlaneServer.getAddress();
      const tailscale = getExposureStatus();
      return {
        ok: true,
        address: addr || undefined,
        tailscale: tailscale.active
          ? { httpsUrl: tailscale.httpsUrl, wssUrl: tailscale.wssUrl }
          : undefined,
      };
    }

    // Cleanup a previous failed/partial server instance.
    if (controlPlaneServer && !controlPlaneServer.isRunning) {
      if (detachAgentDaemonBridge) {
        detachAgentDaemonBridge();
        detachAgentDaemonBridge = null;
      }
      controlPlaneServer = null;
    }

    let tailscaleResult:
      | {
          success?: boolean;
          httpsUrl?: string;
          wssUrl?: string;
        }
      | null
      | undefined;

    if (settings.enabled) {
      const server = new ControlPlaneServer({
        port: settings.port,
        host: settings.host,
        token: settings.token,
        handshakeTimeoutMs: settings.handshakeTimeoutMs,
        heartbeatIntervalMs: settings.heartbeatIntervalMs,
        maxPayloadBytes: settings.maxPayloadBytes,
        onEvent: (event) => {
          options.onEvent?.(event);
          if (mainWindowRef && !mainWindowRef.isDestroyed()) {
            mainWindowRef.webContents.send(IPC_CHANNELS.CONTROL_PLANE_EVENT, event);
          }
        },
      });

      controlPlaneServer = server;

      try {
        if (controlPlaneDeps) {
          registerTaskAndWorkspaceMethods(server, controlPlaneDeps);
          registerCompanyOpsMethods(server, controlPlaneDeps);
          registerACPMethodsOnServer(server, controlPlaneDeps);
          detachAgentDaemonBridge = attachAgentDaemonTaskBridge(
            server,
            controlPlaneDeps.agentDaemon,
            getManagedSessionService(controlPlaneDeps),
          );
        } else {
          console.warn("[ControlPlane] No deps provided; task/workspace methods are disabled");
        }
        registerCanvasMethods(server);

        tailscaleResult = await server.startWithTailscale();
      } catch (error) {
        if (detachAgentDaemonBridge) {
          detachAgentDaemonBridge();
          detachAgentDaemonBridge = null;
        }
        try {
          await server.stop();
        } catch (stopError) {
          console.error("[ControlPlane] Failed to cleanup server after start error:", stopError);
        }
        if (controlPlaneServer === server) {
          controlPlaneServer = null;
        }
        throw error;
      }
    }

    for (const deviceId of autoConnectDeviceIds) {
      try {
        const status = ensureFleetManager().getStatus(deviceId);
        if (status.state !== "connected") {
          await connectManagedRemoteDevice(deviceId);
        }
      } catch (error) {
        console.warn(`[ControlPlane] Failed to auto-connect ${deviceId}:`, error);
      }
    }

    const address = controlPlaneServer?.getAddress();
    return {
      ok: true,
      address: address || undefined,
      tailscale: tailscaleResult?.success
        ? { httpsUrl: tailscaleResult.httpsUrl, wssUrl: tailscaleResult.wssUrl }
        : undefined,
    };
  } catch (error: any) {
    console.error("[ControlPlane] Auto-start error:", error);
    return { ok: false, error: error?.message || String(error) };
  }
}

/**
 * Register ACP (Agent Client Protocol) methods on the server.
 * Bridges local AgentRoles and external agents into the ACP discovery and messaging system.
 */
function registerACPMethodsOnServer(
  server: ControlPlaneServer,
  deps: ControlPlaneMethodDeps,
): void {
  const db = deps.dbManager.getDatabase();
  const roleRepo = new AgentRoleRepository(db);
  const taskRepo = new TaskRepository(db);

  const acpDeps: ACPHandlerDeps = {
    db,
    requireScope,
    getActiveRoles: () => roleRepo.findActive(),
    createTask: async (params) => {
      // Find a workspace — use the provided one or fall back to the first available
      let workspaceId = params.workspaceId;
      if (!workspaceId) {
        const workspaceRepo = new WorkspaceRepository(db);
        const workspaces = workspaceRepo.findAll().filter((w: any) => !w.isTemp);
        if (workspaces.length > 0) {
          workspaceId = workspaces[0].id;
        } else {
          throw new Error("No workspace available for ACP task delegation");
        }
      }
      const task = taskRepo.create({
        title: params.title,
        prompt: params.prompt,
        status: "pending",
        workspaceId,
        assignedAgentRoleId: params.assignedAgentRoleId,
      } as any);
      await deps.agentDaemon.startTask(task);
      return { taskId: task.id };
    },
    createDelegatedGraphTask: async (params) => {
      let workspaceId = params.workspaceId;
      if (!workspaceId) {
        const workspaceRepo = new WorkspaceRepository(db);
        const workspaces = workspaceRepo.findAll().filter((w: any) => !w.isTemp);
        if (workspaces.length > 0) {
          workspaceId = workspaces[0].id;
        } else {
          throw new Error("No workspace available for ACP task delegation");
        }
      }
      const snapshot = await deps.agentDaemon.createOrchestrationGraphRun({
        rootTaskId: `acp:${params.acpTaskId}`,
        workspaceId,
        kind: "acp",
        maxParallel: 1,
        metadata: { acpTaskId: params.acpTaskId, assigneeId: params.assigneeId },
        nodes: [
          {
            key: params.acpTaskId,
            title: params.title,
            prompt: params.prompt,
            kind: "acp_task",
            dispatchTarget: params.remote ? "remote_acp" : "local_role",
            assignedAgentRoleId: params.assignedAgentRoleId,
            acpAgentId: params.remote ? params.assigneeId : undefined,
            acpTaskId: params.acpTaskId,
            metadata: { source: "acp" },
          },
        ],
      });
      const node = snapshot.nodes[0];
      return {
        status: node.status,
        coworkTaskId: node.taskId,
        remoteTaskId: node.remoteTaskId,
        result: node.output || node.summary,
        error: node.error,
      };
    },
    getDelegatedGraphStatus: (acpTaskId) => {
      const node = deps.agentDaemon.getOrchestrationGraphRepository().findNodeByAcpTaskId(acpTaskId);
      if (!node) return undefined;
      return {
        status: node.status,
        coworkTaskId: node.taskId,
        remoteTaskId: node.remoteTaskId,
        result: node.output || node.summary,
        error: node.error,
      };
    },
    cancelDelegatedGraphTask: async (acpTaskId) => {
      const node = deps.agentDaemon.getOrchestrationGraphRepository().findNodeByAcpTaskId(acpTaskId);
      if (!node?.publicHandle) return;
      const rootTaskId = node.parentTaskId || `acp:${acpTaskId}`;
      await deps.agentDaemon.cancelDelegatedNode(rootTaskId, node.publicHandle);
    },
    getTask: (taskId) => {
      const task = taskRepo.findById(taskId);
      if (!task) return undefined;
      return { id: task.id, status: task.status, error: (task as any).error };
    },
    cancelTask: async (taskId) => {
      await deps.agentDaemon.cancelTask(taskId);
    },
  };

  registerACPMethods(server, acpDeps);
}

function registerCompanyOpsMethods(server: ControlPlaneServer, deps: ControlPlaneMethodDeps): void {
  const db = deps.dbManager.getDatabase();
  registerControlPlaneCoreMethods({
    server,
    db,
    requireScope,
  });
  registerStrategicPlannerMethods({
    server,
    plannerService: getStrategicPlannerService(),
    requireScope,
  });
  registerSymphonyMethods({
    server,
    getSymphonyService,
    requireScope,
  });
}

/**
 * Register Canvas methods on the Control Plane server.
 * Enables cross-device canvas rendering: remote clients can list sessions,
 * fetch content, push content, take snapshots, and manage checkpoints.
 */
function registerCanvasMethods(server: ControlPlaneServer): void {
  let manager: CanvasManager;
  try {
    manager = CanvasManager.getInstance();
  } catch {
    console.log("[ControlPlane] Canvas not available (headless mode) — skipping canvas methods");
    return;
  }

  const requireAuth = (client: any) => {
    if (!client.isAuthenticated) {
      throw { code: ErrorCodes.UNAUTHORIZED, message: "Authentication required" };
    }
  };

  const requireString = (value: unknown, field: string): string => {
    if (typeof value !== "string" || !value.trim()) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: `${field} is required` };
    }
    return value.trim();
  };

  // canvas.list — list all active canvas sessions
  server.registerMethod(Methods.CANVAS_LIST, async (client, params) => {
    requireAuth(client);
    const p = (params || {}) as { taskId?: string };
    let sessions = manager.listAllSessions();
    if (p.taskId) {
      sessions = sessions.filter((s) => s.taskId === p.taskId);
    }
    return {
      sessions: sessions.map((s) => ({
        id: s.id,
        taskId: s.taskId,
        title: s.title,
        mode: s.mode,
        status: s.status,
        createdAt: s.createdAt,
        lastUpdatedAt: s.lastUpdatedAt,
      })),
    };
  });

  // canvas.get — get session details
  server.registerMethod(Methods.CANVAS_GET, async (client, params) => {
    requireAuth(client);
    const p = params as { sessionId?: string } | undefined;
    const sessionId = requireString(p?.sessionId, "sessionId");
    const session = manager.getSession(sessionId);
    if (!session) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: `Canvas session not found: ${sessionId}` };
    }
    return {
      session: {
        id: session.id,
        taskId: session.taskId,
        title: session.title,
        mode: session.mode,
        url: session.url,
        status: session.status,
        createdAt: session.createdAt,
        lastUpdatedAt: session.lastUpdatedAt,
      },
    };
  });

  // canvas.snapshot — take a screenshot of a canvas session
  server.registerMethod(Methods.CANVAS_SNAPSHOT, async (client, params) => {
    requireAuth(client);
    const p = params as { sessionId?: string } | undefined;
    const sessionId = requireString(p?.sessionId, "sessionId");
    const snapshot = await manager.takeSnapshot(sessionId);
    return { snapshot };
  });

  // canvas.content — get the HTML/CSS/JS files of a canvas session
  server.registerMethod(Methods.CANVAS_CONTENT, async (client, params) => {
    requireAuth(client);
    const p = params as { sessionId?: string } | undefined;
    const sessionId = requireString(p?.sessionId, "sessionId");
    const files = await manager.getSessionContent(sessionId);
    return { files };
  });

  // canvas.push — push content to a canvas session
  server.registerMethod(Methods.CANVAS_PUSH, async (client, params) => {
    requireAuth(client);
    const p = (params || {}) as { sessionId?: string; content?: string; filename?: string };
    const sessionId = requireString(p.sessionId, "sessionId");
    const content = requireString(p.content, "content");
    await manager.pushContent(sessionId, content, p.filename || "index.html");
    server.broadcast(Events.CANVAS_CONTENT_PUSHED, { sessionId });
    return { ok: true };
  });

  // canvas.eval — execute JavaScript in a canvas session
  server.registerMethod(Methods.CANVAS_EVAL, async (client, params) => {
    requireAuth(client);
    const p = (params || {}) as { sessionId?: string; script?: string };
    const sessionId = requireString(p.sessionId, "sessionId");
    const script = requireString(p.script, "script");
    const result = await manager.evalScript(sessionId, script);
    return { result };
  });

  // canvas.checkpoint.save — save a named checkpoint
  server.registerMethod(Methods.CANVAS_CHECKPOINT_SAVE, async (client, params) => {
    requireAuth(client);
    const p = (params || {}) as { sessionId?: string; label?: string };
    const sessionId = requireString(p.sessionId, "sessionId");
    const checkpoint = await manager.saveCheckpoint(sessionId, p.label);
    return {
      checkpoint: {
        id: checkpoint.id,
        label: checkpoint.label,
        createdAt: checkpoint.createdAt,
      },
    };
  });

  // canvas.checkpoint.list — list checkpoints for a session
  server.registerMethod(Methods.CANVAS_CHECKPOINT_LIST, async (client, params) => {
    requireAuth(client);
    const p = params as { sessionId?: string } | undefined;
    const sessionId = requireString(p?.sessionId, "sessionId");
    const checkpoints = manager.listCheckpoints(sessionId);
    return {
      checkpoints: checkpoints.map((cp) => ({
        id: cp.id,
        label: cp.label,
        createdAt: cp.createdAt,
      })),
    };
  });

  // canvas.checkpoint.restore — restore a session to a checkpoint
  server.registerMethod(Methods.CANVAS_CHECKPOINT_RESTORE, async (client, params) => {
    requireAuth(client);
    const p = (params || {}) as { sessionId?: string; checkpointId?: string };
    const sessionId = requireString(p.sessionId, "sessionId");
    const checkpointId = requireString(p.checkpointId, "checkpointId");
    const checkpoint = await manager.restoreCheckpoint(sessionId, checkpointId);
    return {
      checkpoint: {
        id: checkpoint.id,
        label: checkpoint.label,
        createdAt: checkpoint.createdAt,
      },
    };
  });

  // canvas.checkpoint.delete — delete a checkpoint
  server.registerMethod(Methods.CANVAS_CHECKPOINT_DELETE, async (client, params) => {
    requireAuth(client);
    const p = (params || {}) as { sessionId?: string; checkpointId?: string };
    const sessionId = requireString(p.sessionId, "sessionId");
    const checkpointId = requireString(p.checkpointId, "checkpointId");
    const removed = manager.deleteCheckpoint(sessionId, checkpointId);
    if (!removed) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: `Checkpoint not found: ${checkpointId}` };
    }
    return { ok: true };
  });

  console.log("[ControlPlane] Registered 10 canvas methods");
}

function registerTaskAndWorkspaceMethods(
  server: ControlPlaneServer,
  deps: ControlPlaneMethodDeps,
): void {
  const db = deps.dbManager.getDatabase();
  const taskRepo = new TaskRepository(db);
  const workspaceRepo = new WorkspaceRepository(db);
  const approvalRepo = new ApprovalRepository(db);
  const eventRepo = new TaskEventRepository(db);
  const managedSessions = getManagedSessionService(deps);
  const agentDaemon = deps.agentDaemon;
  const channelGateway = deps.channelGateway;
  const isAdminClient = (client: any) => !!client?.hasScope?.("admin");

  const redactWorkspaceForRead = (workspace: any) => ({
    id: workspace.id,
    name: workspace.name,
    createdAt: workspace.createdAt,
    lastUsedAt: workspace.lastUsedAt,
  });

  const redactTaskForRead = (task: any) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    workspaceId: task.workspaceId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
    parentTaskId: task.parentTaskId,
    agentType: task.agentType,
    depth: task.depth,
    assignedAgentRoleId: task.assignedAgentRoleId,
    boardColumn: task.boardColumn,
    priority: task.priority,
    labels: task.labels,
    dueDate: task.dueDate,
  });

  const redactChannelForRead = (channel: any) => ({
    id: channel.id,
    type: channel.type,
    name: channel.name,
    enabled: channel.enabled,
    status: channel.status,
    botUsername: channel.botUsername,
    securityConfig: channel.securityConfig ? { mode: channel.securityConfig.mode } : undefined,
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
  });

  // Workspaces
  server.registerMethod(Methods.WORKSPACE_LIST, async (client) => {
    requireScope(client, "read");
    const all = workspaceRepo.findAll();
    const workspaces = all.filter((w) => !w.isTemp && !isTempWorkspaceId(w.id));
    return {
      workspaces: isAdminClient(client) ? workspaces : workspaces.map(redactWorkspaceForRead),
    };
  });

  server.registerMethod(Methods.WORKSPACE_GET, async (client, params) => {
    requireScope(client, "read");
    const { workspaceId } = sanitizeWorkspaceIdParams(params);
    const workspace = workspaceRepo.findById(workspaceId);
    if (!workspace) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: `Workspace not found: ${workspaceId}` };
    }
    return { workspace: isAdminClient(client) ? workspace : redactWorkspaceForRead(workspace) };
  });

  server.registerMethod(Methods.WORKSPACE_CREATE, async (client, params) => {
    requireScope(client, "admin");
    const validated = sanitizeWorkspaceCreateParams(params);

    if (workspaceRepo.existsByPath(validated.path)) {
      throw {
        code: ErrorCodes.INVALID_PARAMS,
        message: `A workspace with path "${validated.path}" already exists`,
      };
    }

    try {
      await fs.mkdir(validated.path, { recursive: true });
    } catch (error: any) {
      throw {
        code: ErrorCodes.METHOD_FAILED,
        message: error?.message || `Failed to create workspace directory: ${validated.path}`,
      };
    }

    const defaultPermissions = {
      read: true,
      write: true,
      delete: false,
      network: true,
      shell: false,
    };

    const workspace = workspaceRepo.create(
      validated.name,
      validated.path,
      defaultPermissions as any,
    );
    return { workspace };
  });

  // File operations (for remote file selection)
  server.registerMethod(Methods.FILE_LIST_DIRECTORY, async (client, params) => {
    requireScope(client, "read");
    const p = (params ?? {}) as any;
    const workspaceId = typeof p.workspaceId === "string" ? p.workspaceId.trim() : "";
    const relativePath = typeof p.path === "string" ? p.path.trim() || "." : ".";
    if (!workspaceId) throw { code: ErrorCodes.INVALID_PARAMS, message: "workspaceId is required" };

    const workspace = workspaceRepo.findById(workspaceId);
    if (!workspace) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: `Workspace not found: ${workspaceId}` };
    }

    const fullPath = path.join(workspace.path, relativePath);
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(path.resolve(workspace.path))) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: "Path escapes workspace" };
    }

    try {
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      const files = await Promise.all(
        entries.slice(0, 200).map(async (entry) => {
          try {
            const entryPath = path.join(resolved, entry.name);
            const stat = await fs.stat(entryPath);
            return {
              name: entry.name,
              type: stat.isDirectory() ? ("directory" as const) : ("file" as const),
              size: stat.isFile() ? stat.size : 0,
            };
          } catch {
            return { name: entry.name, type: "file" as const, size: 0 };
          }
        }),
      );
      return { files };
    } catch (error: any) {
      throw {
        code: ErrorCodes.METHOD_FAILED,
        message: error?.message || `Failed to list directory: ${relativePath}`,
      };
    }
  });

  server.registerMethod(Methods.MANAGED_AGENT_LIST, async (client, params) => {
    requireScope(client, "read");
    const p = sanitizeManagedSessionListParams(params);
    return {
      agents: managedSessions.listAgents({
        limit: p.limit,
        offset: p.offset,
        status: p.status,
      }),
    };
  });

  server.registerMethod(Methods.MANAGED_AGENT_GET, async (client, params) => {
    requireScope(client, "read");
    const { agentId } = sanitizeManagedAgentIdParams(params);
    const result = managedSessions.getAgent(agentId);
    if (!result) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: `Managed agent not found: ${agentId}` };
    }
    return result;
  });

  server.registerMethod(Methods.MANAGED_AGENT_CREATE, async (client, params) => {
    requireScope(client, "admin");
    return managedSessions.createAgent(sanitizeManagedAgentCreateParams(params));
  });

  server.registerMethod(Methods.MANAGED_AGENT_UPDATE, async (client, params) => {
    requireScope(client, "admin");
    const validated = sanitizeManagedAgentUpdateParams(params);
    return managedSessions.updateAgent(validated.agentId, validated);
  });

  server.registerMethod(Methods.MANAGED_AGENT_ARCHIVE, async (client, params) => {
    requireScope(client, "admin");
    const { agentId } = sanitizeManagedAgentIdParams(params);
    return { agent: (await managedSessions.archiveAgent(agentId)) || null };
  });

  server.registerMethod(Methods.MANAGED_AGENT_VERSION_LIST, async (client, params) => {
    requireScope(client, "read");
    const { agentId } = sanitizeManagedAgentIdParams(params);
    return { versions: managedSessions.listAgentVersions(agentId) };
  });

  server.registerMethod(Methods.MANAGED_AGENT_VERSION_GET, async (client, params) => {
    requireScope(client, "read");
    const { agentId, version } = sanitizeManagedAgentVersionParams(params);
    return { version: managedSessions.getAgentVersion(agentId, version) || null };
  });

  server.registerMethod(Methods.MANAGED_ENVIRONMENT_LIST, async (client, params) => {
    requireScope(client, "read");
    const p = sanitizeManagedSessionListParams(params);
    return {
      environments: managedSessions.listEnvironments({
        limit: p.limit,
        offset: p.offset,
        status: p.status,
      }).map(redactManagedEnvironmentForRead),
    };
  });

  server.registerMethod(Methods.MANAGED_ENVIRONMENT_GET, async (client, params) => {
    requireScope(client, "read");
    const { environmentId } = sanitizeManagedEnvironmentIdParams(params);
    const environment = managedSessions.getEnvironment(environmentId);
    if (!environment) {
      throw {
        code: ErrorCodes.INVALID_PARAMS,
        message: `Managed environment not found: ${environmentId}`,
      };
    }
    return { environment: redactManagedEnvironmentForRead(environment) };
  });

  server.registerMethod(Methods.MANAGED_ENVIRONMENT_CREATE, async (client, params) => {
    requireScope(client, "admin");
    return {
      environment: redactManagedEnvironmentForRead(
        managedSessions.createEnvironment(sanitizeManagedEnvironmentCreateParams(params)),
      ),
    };
  });

  server.registerMethod(Methods.MANAGED_ENVIRONMENT_UPDATE, async (client, params) => {
    requireScope(client, "admin");
    const validated = sanitizeManagedEnvironmentUpdateParams(params);
    return {
      environment: redactManagedEnvironmentForRead(
        managedSessions.updateEnvironment(validated.environmentId, validated) || null,
      ),
    };
  });

  server.registerMethod(Methods.MANAGED_ENVIRONMENT_ARCHIVE, async (client, params) => {
    requireScope(client, "admin");
    const { environmentId } = sanitizeManagedEnvironmentIdParams(params);
    return {
      environment: redactManagedEnvironmentForRead(
        managedSessions.archiveEnvironment(environmentId) || null,
      ),
    };
  });

  server.registerMethod(Methods.MANAGED_SESSION_LIST, async (client, params) => {
    requireScope(client, "read");
    return { sessions: managedSessions.listSessions(sanitizeManagedSessionListParams(params)) };
  });

  server.registerMethod(Methods.MANAGED_SESSION_GET, async (client, params) => {
    requireScope(client, "read");
    const { sessionId } = sanitizeManagedSessionIdParams(params);
    const session = managedSessions.getSession(sessionId);
    if (!session) {
      throw {
        code: ErrorCodes.INVALID_PARAMS,
        message: `Managed session not found: ${sessionId}`,
      };
    }
    return { session };
  });

  server.registerMethod(Methods.MANAGED_SESSION_CREATE, async (client, params) => {
    requireScope(client, "admin");
    const session = await managedSessions.createSession(sanitizeManagedSessionCreateParams(params));
    server.broadcastToOperators(Events.MANAGED_SESSION_CREATED, { sessionId: session.id, session });
    return { session };
  });

  server.registerMethod(Methods.MANAGED_SESSION_CANCEL, async (client, params) => {
    requireScope(client, "admin");
    const { sessionId } = sanitizeManagedSessionIdParams(params);
    const session = await managedSessions.cancelSession(sessionId);
    server.broadcastToOperators(Events.MANAGED_SESSION_UPDATED, { sessionId, session });
    return { session: session || null };
  });

  server.registerMethod(Methods.MANAGED_SESSION_RESUME, async (client, params) => {
    requireScope(client, "admin");
    const { sessionId } = sanitizeManagedSessionIdParams(params);
    const result = await managedSessions.resumeSession(sessionId);
    if (result.session) {
      server.broadcastToOperators(Events.MANAGED_SESSION_UPDATED, {
        sessionId,
        session: result.session,
      });
    }
    return result;
  });

  server.registerMethod(Methods.MANAGED_SESSION_SEND_EVENT, async (client, params) => {
    requireScope(client, "admin");
    const validated = sanitizeManagedSessionSendEventParams(params);
    const session = await managedSessions.sendEvent(validated.sessionId, validated.event);
    server.broadcastToOperators(Events.MANAGED_SESSION_UPDATED, {
      sessionId: validated.sessionId,
      session,
    });
    return { session: session || null };
  });

  server.registerMethod(Methods.MANAGED_SESSION_EVENTS_LIST, async (client, params) => {
    requireScope(client, "read");
    const { sessionId, limit } = sanitizeManagedSessionEventsParams(params);
    return {
      events: managedSessions.listSessionEvents(sessionId, limit).map((event) => ({
        ...event,
        payload: sanitizeForBroadcast(event.payload),
      })),
    };
  });

  // Tasks
  server.registerMethod(Methods.TASK_CREATE, async (client, params) => {
    requireScope(client, "admin");
    const validated = sanitizeTaskCreateParams(params);

    const workspace = workspaceRepo.findById(validated.workspaceId);
    if (!workspace) {
      throw {
        code: ErrorCodes.INVALID_PARAMS,
        message: `Workspace not found: ${validated.workspaceId}`,
      };
    }

    if (validated.shellAccess && !workspace.permissions?.shell) {
      workspaceRepo.updatePermissions(validated.workspaceId, {
        ...workspace.permissions,
        shell: true,
      });
    }

    // Create task record
    const normalizedAgentConfig = validated.agentConfig
      ? {
          ...validated.agentConfig,
          ...(validated.agentConfig.autonomousMode ? { allowUserInput: false } : {}),
        }
      : undefined;

    const task = taskRepo.create({
      title: validated.title,
      prompt: validated.prompt,
      rawPrompt: validated.prompt,
      userPrompt: validated.prompt,
      status: "pending",
      workspaceId: validated.workspaceId,
      agentConfig: normalizedAgentConfig,
      budgetTokens: validated.budgetTokens,
      budgetCost: validated.budgetCost,
    });

    // Apply assignment metadata (update DB + in-memory object before starting).
    const initialUpdates: any = {};
    if (validated.assignedAgentRoleId) {
      initialUpdates.assignedAgentRoleId = validated.assignedAgentRoleId;
      initialUpdates.boardColumn = "todo";
    }
    if (Object.keys(initialUpdates).length > 0) {
      taskRepo.update(task.id, initialUpdates);
      Object.assign(task, initialUpdates);
    }

    if (!isTempWorkspaceId(validated.workspaceId) && !workspace?.isTemp) {
      try {
        workspaceRepo.updateLastUsedAt(validated.workspaceId);
      } catch (error) {
        console.warn("[ControlPlane] Failed to update workspace last used time:", error);
      }
    }

    try {
      await agentDaemon.startTask(task);
    } catch (error: any) {
      agentDaemon.failTask(task.id, error?.message || "Failed to start task");
      throw {
        code: ErrorCodes.METHOD_FAILED,
        message: error?.message || "Failed to start task. Check LLM provider settings.",
      };
    }

    return { taskId: task.id, task };
  });

  server.registerMethod(Methods.TASK_EVENTS, async (client, params) => {
    requireScope(client, "admin");
    const { taskId, limit } = sanitizeTaskEventsParams(params);
    const events = buildTaskEventHistoryForTransport({
      taskId,
      limit,
      taskRepo,
      eventRepo,
    }).map((event) => serializeTaskEventForTransport(event, sanitizeForBroadcast));
    return { events };
  });

  server.registerMethod(Methods.TASK_GET, async (client, params) => {
    requireScope(client, "read");
    const { taskId } = sanitizeTaskIdParams(params);
    const task = taskRepo.findById(taskId);
    if (!task) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: `Task not found: ${taskId}` };
    }
    return { task: isAdminClient(client) ? task : redactTaskForRead(task) };
  });

  server.registerMethod(Methods.TASK_LIST, async (client, params) => {
    requireScope(client, "read");
    const { limit, offset, workspaceId } = sanitizeTaskListParams(params);

    if (workspaceId) {
      const total = taskRepo.countByWorkspace(workspaceId);
      const tasks = taskRepo.findByWorkspace(workspaceId, limit, offset);
      return {
        tasks: isAdminClient(client) ? tasks : tasks.map(redactTaskForRead),
        total,
        limit,
        offset,
      };
    }

    const tasks = taskRepo.findAll(limit, offset);
    return { tasks: isAdminClient(client) ? tasks : tasks.map(redactTaskForRead), limit, offset };
  });

  server.registerMethod(Methods.TASK_CANCEL, async (client, params) => {
    requireScope(client, "admin");
    const { taskId } = sanitizeTaskIdParams(params);
    await agentDaemon.cancelTask(taskId);
    return { ok: true };
  });

  server.registerMethod(Methods.TASK_SEND_MESSAGE, async (client, params) => {
    requireScope(client, "admin");
    const { taskId, message, images, quotedAssistantMessage } = sanitizeTaskMessageParams(params);
    await agentDaemon.sendMessage(taskId, message, images, quotedAssistantMessage);
    return { ok: true };
  });

  // Approvals
  server.registerMethod(Methods.APPROVAL_LIST, async (client, params) => {
    requireScope(client, "admin");
    const { limit, offset, taskId } = sanitizeApprovalListParams(params);

    const approvals = taskId
      ? approvalRepo.findPendingByTaskId(taskId).slice(offset, offset + limit)
      : (() => {
          // The repository only has findPendingByTaskId; implement global listing here.
          const stmt = db.prepare(`
            SELECT * FROM approvals
            WHERE status = 'pending'
            ORDER BY requested_at ASC
            LIMIT ? OFFSET ?
          `);
          const rows = stmt.all(limit, offset) as any[];
          return rows.map((row) => ({
            id: String(row.id ?? ""),
            taskId: String(row.task_id ?? ""),
            type: row.type,
            description: row.description,
            details: (() => {
              try {
                return row.details ? JSON.parse(String(row.details)) : {};
              } catch {
                return {};
              }
            })(),
            status: row.status,
            requestedAt: Number(row.requested_at ?? 0),
            resolvedAt: row.resolved_at ? Number(row.resolved_at) : undefined,
          }));
        })();

    const enriched = approvals.map((a: any) => {
      const t = a.taskId ? taskRepo.findById(a.taskId) : undefined;
      return {
        ...a,
        ...(t ? { taskTitle: t.title, workspaceId: t.workspaceId, taskStatus: t.status } : {}),
        details: sanitizeForBroadcast(a.details),
      };
    });

    return { approvals: enriched };
  });

  server.registerMethod(Methods.APPROVAL_RESPOND, async (client, params) => {
    requireScope(client, "admin");
    const { approvalId, approved } = sanitizeApprovalRespondParams(params);
    const status = await agentDaemon.respondToApproval(approvalId, approved);
    return { status };
  });

  // Channels (gateway)
  server.registerMethod(Methods.CHANNEL_LIST, async (client) => {
    requireScope(client, "read");
    const rows = db.prepare("SELECT * FROM channels ORDER BY created_at ASC").all() as any[];
    const channels = rows.map((row) => ({
      id: String(row.id ?? ""),
      type: String(row.type ?? ""),
      name: String(row.name ?? ""),
      enabled: row.enabled === 1,
      config: (() => {
        try {
          return row.config ? JSON.parse(String(row.config)) : {};
        } catch {
          return {};
        }
      })(),
      securityConfig: (() => {
        try {
          return row.security_config
            ? JSON.parse(String(row.security_config))
            : { mode: "pairing" };
        } catch {
          return { mode: "pairing" };
        }
      })(),
      status: String(row.status ?? ""),
      botUsername: row.bot_username ? String(row.bot_username) : undefined,
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    }));

    if (!isAdminClient(client)) {
      return { channels: channels.map(redactChannelForRead) };
    }

    return {
      channels: channels.map((c) => ({
        ...redactChannelForRead(c),
        config: redactObjectSecrets(c.config),
        securityConfig: {
          mode: c.securityConfig?.mode,
          allowedUsersCount: Array.isArray(c.securityConfig?.allowedUsers)
            ? c.securityConfig.allowedUsers.length
            : 0,
        },
      })),
    };
  });

  server.registerMethod(Methods.CHANNEL_GET, async (client, params) => {
    requireScope(client, "read");
    const { channelId } = sanitizeChannelIdParams(params);
    const row = db.prepare("SELECT * FROM channels WHERE id = ?").get(channelId) as any;
    if (!row) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: `Channel not found: ${channelId}` };
    }

    const channel = {
      id: String(row.id ?? ""),
      type: String(row.type ?? ""),
      name: String(row.name ?? ""),
      enabled: row.enabled === 1,
      config: (() => {
        try {
          return row.config ? JSON.parse(String(row.config)) : {};
        } catch {
          return {};
        }
      })(),
      securityConfig: (() => {
        try {
          return row.security_config
            ? JSON.parse(String(row.security_config))
            : { mode: "pairing" };
        } catch {
          return { mode: "pairing" };
        }
      })(),
      status: String(row.status ?? ""),
      botUsername: row.bot_username ? String(row.bot_username) : undefined,
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    };

    if (!isAdminClient(client)) return { channel: redactChannelForRead(channel) };

    return {
      channel: {
        ...redactChannelForRead(channel),
        config: redactObjectSecrets(channel.config),
        securityConfig: {
          mode: channel.securityConfig?.mode,
          allowedUsersCount: Array.isArray(channel.securityConfig?.allowedUsers)
            ? channel.securityConfig.allowedUsers.length
            : 0,
        },
      },
    };
  });

  server.registerMethod(Methods.CHANNEL_CREATE, async (client, params) => {
    requireScope(client, "admin");
    const validated = sanitizeChannelCreateParams(params);

    // Enforce one channel per type (router registers by type).
    const existing = db
      .prepare("SELECT id FROM channels WHERE type = ? LIMIT 1")
      .get(validated.type) as any;
    if (existing?.id) {
      throw {
        code: ErrorCodes.INVALID_PARAMS,
        message: `Channel type "${validated.type}" already exists (id=${existing.id})`,
      };
    }

    const now = Date.now();
    const id = randomUUID();
    db.prepare(`
      INSERT INTO channels (id, type, name, enabled, config, security_config, status, bot_username, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      validated.type,
      validated.name,
      validated.enabled ? 1 : 0,
      JSON.stringify(validated.config || {}),
      JSON.stringify(validated.securityConfig || { mode: "pairing" }),
      "disconnected",
      null,
      now,
      now,
    );

    // If the gateway is running, optionally connect immediately when enabled.
    if (validated.enabled && channelGateway) {
      try {
        await channelGateway.enableChannel(id);
      } catch (error: any) {
        // Keep the channel record but surface the connection error.
        db.prepare("UPDATE channels SET enabled = 0, status = ?, updated_at = ? WHERE id = ?").run(
          "disconnected",
          Date.now(),
          id,
        );
        throw {
          code: ErrorCodes.METHOD_FAILED,
          message: error?.message || "Failed to enable channel",
        };
      }
    }

    return { channelId: id };
  });

  server.registerMethod(Methods.CHANNEL_UPDATE, async (client, params) => {
    requireScope(client, "admin");
    const { channelId, updates } = sanitizeChannelUpdateParams(params);

    if (channelGateway) {
      channelGateway.updateChannel(channelId, updates as any);
      return { ok: true };
    }

    // Fallback: update DB only (restart required to take effect).
    const fields: string[] = [];
    const values: any[] = [];
    if (updates.name !== undefined) {
      fields.push("name = ?");
      values.push(updates.name);
    }
    if (updates.config !== undefined) {
      fields.push("config = ?");
      values.push(JSON.stringify(updates.config));
    }
    if (updates.securityConfig !== undefined) {
      fields.push("security_config = ?");
      values.push(JSON.stringify(updates.securityConfig));
    }
    if (fields.length === 0) return { ok: true };
    fields.push("updated_at = ?");
    values.push(Date.now());
    values.push(channelId);
    db.prepare(`UPDATE channels SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return { ok: true, restartRequired: true };
  });

  server.registerMethod(Methods.CHANNEL_TEST, async (client, params) => {
    requireScope(client, "admin");
    const { channelId } = sanitizeChannelIdParams(params);
    if (!channelGateway) {
      return { success: false, error: "Channel gateway not available (restart required)" };
    }
    return await channelGateway.testChannel(channelId);
  });

  server.registerMethod(Methods.CHANNEL_ENABLE, async (client, params) => {
    requireScope(client, "admin");
    const { channelId } = sanitizeChannelIdParams(params);
    if (!channelGateway) {
      db.prepare("UPDATE channels SET enabled = 1, updated_at = ? WHERE id = ?").run(
        Date.now(),
        channelId,
      );
      return { ok: true, restartRequired: true };
    }
    await channelGateway.enableChannel(channelId);
    return { ok: true };
  });

  server.registerMethod(Methods.CHANNEL_DISABLE, async (client, params) => {
    requireScope(client, "admin");
    const { channelId } = sanitizeChannelIdParams(params);
    if (!channelGateway) {
      db.prepare("UPDATE channels SET enabled = 0, status = ?, updated_at = ? WHERE id = ?").run(
        "disconnected",
        Date.now(),
        channelId,
      );
      return { ok: true, restartRequired: true };
    }
    await channelGateway.disableChannel(channelId);
    return { ok: true };
  });

  server.registerMethod(Methods.CHANNEL_REMOVE, async (client, params) => {
    requireScope(client, "admin");
    const { channelId } = sanitizeChannelIdParams(params);
    if (!channelGateway) {
      // Best-effort delete only the channel row. (Associated rows may remain.)
      db.prepare("DELETE FROM channels WHERE id = ?").run(channelId);
      return { ok: true, restartRequired: true };
    }
    await channelGateway.removeChannel(channelId);
    return { ok: true };
  });

  // LLM setup (headless-friendly credential/provider configuration).
  server.registerMethod(Methods.LLM_CONFIGURE, async (client, params) => {
    requireScope(client, "admin");
    return configureLlmFromControlPlaneParams(params);
  });

  // Config/health (sanitized; no secrets).
  server.registerMethod(Methods.CONFIG_GET, async (client) => {
    requireScope(client, "read");
    const isAdmin = isAdminClient(client);

    const allWorkspaces = workspaceRepo
      .findAll()
      .filter((w) => !w.isTemp && !isTempWorkspaceId(w.id));
    const workspacesForClient = isAdmin ? allWorkspaces : allWorkspaces.map(redactWorkspaceForRead);

    const taskStatusRows = db
      .prepare(`SELECT status, COUNT(1) AS count FROM tasks GROUP BY status`)
      .all() as Array<{ status: string; count: number }>;

    const tasksByStatus: Record<string, number> = {};
    let taskTotal = 0;
    for (const row of taskStatusRows) {
      const status = String(row.status || "");
      const count = typeof row.count === "number" ? row.count : Number(row.count);
      const safeCount = Number.isFinite(count) ? count : 0;
      if (status) tasksByStatus[status] = safeCount;
      taskTotal += safeCount;
    }

    const llm = getControlPlaneLlmStatus();
    const anyLlmConfigured = llm.providers.some((p) => p.configured);
    const currentProviderConfigured =
      llm.providers.find((p) => p.type === llm.currentProvider)?.configured || false;

    const searchStatus = SearchProviderFactory.getConfigStatus();

    const controlPlane = ControlPlaneSettingsManager.getSettingsForDisplay();
    const envImport = {
      enabled: shouldImportEnvSettingsFromArgsOrEnv(),
      mode: getEnvSettingsImportModeFromArgsOrEnv(),
    };

    const runtime = {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      electron: process.versions.electron,
      coworkVersion: typeof app.getVersion === "function" ? app.getVersion() : undefined,
      headless: isHeadlessMode(),
      cwd: process.cwd(),
      userDataDir: getUserDataDir(),
      activeProfileId: getActiveProfileId(),
      importEnvSettings: envImport,
    };

    const warnings: string[] = [];
    if (controlPlane.host === "0.0.0.0" || controlPlane.host === "::") {
      warnings.push(
        "Control Plane is bound to all interfaces (host=0.0.0.0/::). This is unsafe unless you have strong network controls (prefer loopback + SSH tunnel/Tailscale).",
      );
    }
    if (allWorkspaces.length === 0) {
      warnings.push(
        "No workspaces configured. Set COWORK_BOOTSTRAP_WORKSPACE_PATH on startup or create one via workspace.create.",
      );
    }
    if (!anyLlmConfigured) {
      warnings.push(
        "No LLM provider credentials configured. Configure one via Control Plane (LLM Setup / llm.configure), or use COWORK_IMPORT_ENV_SETTINGS=1 with provider env vars and restart.",
      );
    } else if (!currentProviderConfigured) {
      warnings.push(
        `Selected LLM provider "${llm.currentProvider}" is not configured. Either switch provider or configure its credentials.`,
      );
    }
    if (!envImport.enabled && !anyLlmConfigured) {
      warnings.push(
        "Tip: enable env import with COWORK_IMPORT_ENV_SETTINGS=1 (or --import-env-settings) so provider env vars are persisted into Secure Settings at boot.",
      );
    }
    if (!searchStatus.isConfigured) {
      warnings.push(
        "No search provider configured (optional). Set TAVILY_API_KEY/BRAVE_API_KEY/SERPAPI_API_KEY if you want web search.",
      );
    }

    // Channels summary (no secrets).
    const channelRows = db
      .prepare(
        `SELECT id, type, name, enabled, status, bot_username, security_config, created_at, updated_at FROM channels ORDER BY created_at ASC`,
      )
      .all() as any[];
    const channels = channelRows.map((row) => ({
      id: String(row.id ?? ""),
      type: String(row.type ?? ""),
      name: String(row.name ?? ""),
      enabled: row.enabled === 1,
      status: String(row.status ?? ""),
      botUsername: row.bot_username ? String(row.bot_username) : undefined,
      securityConfig: (() => {
        try {
          return row.security_config
            ? JSON.parse(String(row.security_config))
            : { mode: "pairing" };
        } catch {
          return { mode: "pairing" };
        }
      })(),
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    }));
    const channelsEnabled = channels.filter((c) => c.enabled).length;

    return {
      runtime,
      controlPlane,
      workspaces: { count: allWorkspaces.length, workspaces: workspacesForClient },
      tasks: { total: taskTotal, byStatus: tasksByStatus },
      channels: {
        count: channels.length,
        enabled: channelsEnabled,
        channels: channels.map(redactChannelForRead),
      },
      llm,
      search: searchStatus,
      warnings,
    };
  });
}

/**
 * Initialize control plane IPC handlers
 */
export function setupControlPlaneHandlers(
  mainWindow: BrowserWindow,
  deps?: ControlPlaneMethodDeps,
): void {
  mainWindowRef = mainWindow;
  controlPlaneDeps = deps ?? null;

  // Initialize settings managers
  ControlPlaneSettingsManager.initialize();
  TailscaleSettingsManager.initialize();
  ensureFleetManager();

  // Get settings (with masked token)
  ipcMain.handle(
    IPC_CHANNELS.CONTROL_PLANE_GET_SETTINGS,
    async (): Promise<ControlPlaneSettingsData> => {
      return ControlPlaneSettingsManager.getSettingsForDisplay();
    },
  );

  // Save settings
  ipcMain.handle(
    IPC_CHANNELS.CONTROL_PLANE_SAVE_SETTINGS,
    async (
      _,
      settings: Partial<ControlPlaneSettingsData>,
    ): Promise<{ ok: boolean; error?: string }> => {
      try {
        ControlPlaneSettingsManager.updateSettings(settings);
        return { ok: true };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  // Enable control plane
  ipcMain.handle(
    IPC_CHANNELS.CONTROL_PLANE_ENABLE,
    async (): Promise<{
      ok: boolean;
      token?: string;
      error?: string;
    }> => {
      try {
        const settings = ControlPlaneSettingsManager.enable();
        return { ok: true, token: settings.token };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  // Disable control plane
  ipcMain.handle(
    IPC_CHANNELS.CONTROL_PLANE_DISABLE,
    async (): Promise<{ ok: boolean; error?: string }> => {
      try {
        // Stop server if running
        if (controlPlaneServer) {
          if (detachAgentDaemonBridge) {
            detachAgentDaemonBridge();
            detachAgentDaemonBridge = null;
          }
          await controlPlaneServer.stop();
          controlPlaneServer = null;
        }
        ControlPlaneSettingsManager.disable();
        return { ok: true };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  // Start control plane server
  ipcMain.handle(
    IPC_CHANNELS.CONTROL_PLANE_START,
    async (): Promise<{
      ok: boolean;
      address?: { host: string; port: number; wsUrl: string };
      tailscale?: { httpsUrl?: string; wssUrl?: string };
      error?: string;
    }> => {
      try {
        if (controlPlaneServer?.isRunning) {
          const addr = controlPlaneServer.getAddress();
          const tailscale = getExposureStatus();
          return {
            ok: true,
            address: addr || undefined,
            tailscale: tailscale.active
              ? {
                  httpsUrl: tailscale.httpsUrl,
                  wssUrl: tailscale.wssUrl,
                }
              : undefined,
          };
        }

        // Cleanup a previous failed/partial server instance.
        if (controlPlaneServer && !controlPlaneServer.isRunning) {
          if (detachAgentDaemonBridge) {
            detachAgentDaemonBridge();
            detachAgentDaemonBridge = null;
          }
          controlPlaneServer = null;
        }

        const settings = ControlPlaneSettingsManager.loadSettings();

        if (!settings.token) {
          return { ok: false, error: "No authentication token configured" };
        }

        // Create server instance
        const server = new ControlPlaneServer({
          port: settings.port,
          host: settings.host,
          token: settings.token,
          handshakeTimeoutMs: settings.handshakeTimeoutMs,
          heartbeatIntervalMs: settings.heartbeatIntervalMs,
          maxPayloadBytes: settings.maxPayloadBytes,
          onEvent: (event) => {
            // Forward events to renderer
            if (mainWindowRef && !mainWindowRef.isDestroyed()) {
              mainWindowRef.webContents.send(IPC_CHANNELS.CONTROL_PLANE_EVENT, event);
            }
          },
        });
        controlPlaneServer = server;

        try {
          // Register task/workspace methods + event bridge (enables multi-Mac orchestration).
          if (controlPlaneDeps) {
            registerTaskAndWorkspaceMethods(server, controlPlaneDeps);
            registerCompanyOpsMethods(server, controlPlaneDeps);
            detachAgentDaemonBridge = attachAgentDaemonTaskBridge(
              server,
              controlPlaneDeps.agentDaemon,
              getManagedSessionService(controlPlaneDeps),
            );
          } else {
            console.warn("[ControlPlane] No deps provided; task/workspace methods are disabled");
          }
          registerCanvasMethods(server);

          // Start with Tailscale if configured
          const tailscaleResult = await server.startWithTailscale();

          const address = server.getAddress();

          return {
            ok: true,
            address: address || undefined,
            tailscale: tailscaleResult?.success
              ? {
                  httpsUrl: tailscaleResult.httpsUrl,
                  wssUrl: tailscaleResult.wssUrl,
                }
              : undefined,
          };
        } catch (error) {
          if (detachAgentDaemonBridge) {
            detachAgentDaemonBridge();
            detachAgentDaemonBridge = null;
          }
          try {
            await server.stop();
          } catch (stopError) {
            console.error("[ControlPlane] Failed to cleanup server after start error:", stopError);
          }
          if (controlPlaneServer === server) {
            controlPlaneServer = null;
          }
          throw error;
        }
      } catch (error: any) {
        console.error("[ControlPlane Handlers] Start error:", error);
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  // Stop control plane server
  ipcMain.handle(
    IPC_CHANNELS.CONTROL_PLANE_STOP,
    async (): Promise<{ ok: boolean; error?: string }> => {
      try {
        if (controlPlaneServer) {
          if (detachAgentDaemonBridge) {
            detachAgentDaemonBridge();
            detachAgentDaemonBridge = null;
          }
          await controlPlaneServer.stop();
          controlPlaneServer = null;
        }
        return { ok: true };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  // Get control plane status
  ipcMain.handle(IPC_CHANNELS.CONTROL_PLANE_GET_STATUS, async (): Promise<ControlPlaneStatus> => {
    const settings = ControlPlaneSettingsManager.loadSettings();
    const tailscale = getExposureStatus();

    if (!controlPlaneServer || !controlPlaneServer.isRunning) {
      return {
        enabled: settings.enabled,
        running: false,
        clients: {
          total: 0,
          authenticated: 0,
          pending: 0,
          list: [],
        },
        tailscale: {
          active: tailscale.active,
          mode: tailscale.mode,
          hostname: tailscale.hostname,
          httpsUrl: tailscale.httpsUrl,
          wssUrl: tailscale.wssUrl,
        },
      };
    }

    const serverStatus = controlPlaneServer.getStatus();

    return {
      enabled: settings.enabled,
      running: serverStatus.running,
      address: serverStatus.address || undefined,
      clients: {
        total: serverStatus.clients.total,
        authenticated: serverStatus.clients.authenticated,
        pending: serverStatus.clients.pending,
        list: serverStatus.clients.clients,
      },
      tailscale: {
        active: serverStatus.tailscale.active,
        mode: serverStatus.tailscale.mode,
        hostname: serverStatus.tailscale.hostname,
        httpsUrl: serverStatus.tailscale.httpsUrl,
        wssUrl: serverStatus.tailscale.wssUrl,
      },
    };
  });

  // Get raw token for local display/copy actions
  ipcMain.handle(
    IPC_CHANNELS.CONTROL_PLANE_GET_TOKEN,
    async (): Promise<{ ok: boolean; token?: string; remoteToken?: string; error?: string }> => {
      try {
        const settings = ControlPlaneSettingsManager.loadSettings();
        return {
          ok: true,
          token: settings.token || "",
          remoteToken: settings.remote?.token || "",
        };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  // Regenerate token
  ipcMain.handle(
    IPC_CHANNELS.CONTROL_PLANE_REGENERATE_TOKEN,
    async (): Promise<{
      ok: boolean;
      token?: string;
      error?: string;
    }> => {
      try {
        const newToken = ControlPlaneSettingsManager.regenerateToken();

        // If server is running, we need to restart it with new token
        if (controlPlaneServer?.isRunning) {
          if (detachAgentDaemonBridge) {
            detachAgentDaemonBridge();
            detachAgentDaemonBridge = null;
          }
          await controlPlaneServer.stop();
          const settings = ControlPlaneSettingsManager.loadSettings();

          controlPlaneServer = new ControlPlaneServer({
            port: settings.port,
            host: settings.host,
            token: settings.token,
            handshakeTimeoutMs: settings.handshakeTimeoutMs,
            heartbeatIntervalMs: settings.heartbeatIntervalMs,
            maxPayloadBytes: settings.maxPayloadBytes,
            onEvent: (event) => {
              if (mainWindowRef && !mainWindowRef.isDestroyed()) {
                mainWindowRef.webContents.send(IPC_CHANNELS.CONTROL_PLANE_EVENT, event);
              }
            },
          });

          if (controlPlaneDeps) {
            registerTaskAndWorkspaceMethods(controlPlaneServer, controlPlaneDeps);
            registerCompanyOpsMethods(controlPlaneServer, controlPlaneDeps);
            registerACPMethodsOnServer(controlPlaneServer, controlPlaneDeps);
            detachAgentDaemonBridge = attachAgentDaemonTaskBridge(
              controlPlaneServer,
              controlPlaneDeps.agentDaemon,
              getManagedSessionService(controlPlaneDeps),
            );
          }
          registerCanvasMethods(controlPlaneServer);

          await controlPlaneServer.startWithTailscale();
        }

        return { ok: true, token: newToken };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  // ===== Tailscale Handlers =====

  // Check Tailscale availability
  ipcMain.handle(
    IPC_CHANNELS.TAILSCALE_CHECK_AVAILABILITY,
    async (): Promise<TailscaleAvailability> => {
      return await checkTailscaleAvailability();
    },
  );

  // Get Tailscale status
  ipcMain.handle(IPC_CHANNELS.TAILSCALE_GET_STATUS, async () => {
    const settings = TailscaleSettingsManager.loadSettings();
    const exposure = getExposureStatus();

    return {
      settings,
      exposure,
    };
  });

  // Set Tailscale mode
  ipcMain.handle(
    IPC_CHANNELS.TAILSCALE_SET_MODE,
    async (_, mode: TailscaleMode): Promise<{ ok: boolean; error?: string }> => {
      try {
        // Update settings
        ControlPlaneSettingsManager.updateSettings({
          tailscale: { mode, resetOnExit: true },
        });

        // If server is running, restart to apply new mode
        if (controlPlaneServer?.isRunning) {
          if (detachAgentDaemonBridge) {
            detachAgentDaemonBridge();
            detachAgentDaemonBridge = null;
          }
          await controlPlaneServer.stop();
          const settings = ControlPlaneSettingsManager.loadSettings();

          controlPlaneServer = new ControlPlaneServer({
            port: settings.port,
            host: settings.host,
            token: settings.token,
            handshakeTimeoutMs: settings.handshakeTimeoutMs,
            heartbeatIntervalMs: settings.heartbeatIntervalMs,
            maxPayloadBytes: settings.maxPayloadBytes,
            onEvent: (event) => {
              if (mainWindowRef && !mainWindowRef.isDestroyed()) {
                mainWindowRef.webContents.send(IPC_CHANNELS.CONTROL_PLANE_EVENT, event);
              }
            },
          });

          if (controlPlaneDeps) {
            registerTaskAndWorkspaceMethods(controlPlaneServer, controlPlaneDeps);
            registerCompanyOpsMethods(controlPlaneServer, controlPlaneDeps);
            detachAgentDaemonBridge = attachAgentDaemonTaskBridge(
              controlPlaneServer,
              controlPlaneDeps.agentDaemon,
              getManagedSessionService(controlPlaneDeps),
            );
          }
          registerCanvasMethods(controlPlaneServer);

          await controlPlaneServer.startWithTailscale();
        }

        return { ok: true };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  // ===== Remote Gateway Handlers =====

  // Connect to remote gateway
  ipcMain.handle(
    IPC_CHANNELS.REMOTE_GATEWAY_CONNECT,
    async (_, config?: RemoteGatewayConfig): Promise<{ ok: boolean; error?: string }> => {
      try {
        const settings = ControlPlaneSettingsManager.loadSettings();
        let targetDeviceId = getLegacyActiveRemoteDeviceId();
        let remoteConfig = config || settings.remote;

        if (!remoteConfig?.url || !remoteConfig?.token) {
          return { ok: false, error: "Remote gateway URL and token are required" };
        }

        if (config) {
          const managedDevices = listStoredManagedDevices();
          const existing =
            (targetDeviceId ? managedDevices.find((device) => device.id === targetDeviceId) : null) ||
            managedDevices.find(
              (device) =>
                normalizeGatewayUrl(device.config?.url) === normalizeGatewayUrl(remoteConfig?.url),
            );
          targetDeviceId = existing?.id || targetDeviceId || `remote-device:${Date.now()}`;
          const nextDevice = normalizeManagedRemoteDevice({
            ...(existing || {
              id: targetDeviceId,
              role: "remote",
              purpose: "general",
              platform: "linux",
              status: "disconnected",
            }),
            id: targetDeviceId,
            name: existing?.name || remoteConfig.deviceName || "CoWork Remote Client",
            transport: inferManagedTransport(remoteConfig),
            taskNodeId: `remote-gateway:${targetDeviceId}`,
            config: remoteConfig,
          } as ManagedDevice);
          const nextManagedDevices = [
            ...managedDevices.filter((device) => device.id !== targetDeviceId),
            nextDevice,
          ];
          const nextSavedDevices = [
            ...(settings.savedRemoteDevices || []).filter((device) => device.id !== targetDeviceId),
            {
              id: targetDeviceId,
              name: nextDevice.name,
              config: remoteConfig,
              autoConnect: nextDevice.autoConnect === true,
            },
          ];
          ControlPlaneSettingsManager.updateSettings({
            connectionMode: "remote",
            remote: remoteConfig,
            activeManagedDeviceId: targetDeviceId,
            activeRemoteDeviceId: targetDeviceId,
            managedDevices: nextManagedDevices,
            savedRemoteDevices: nextSavedDevices,
          });
        }

        if (!targetDeviceId) {
          return { ok: false, error: "No managed remote device is selected" };
        }

        await connectManagedRemoteDevice(targetDeviceId);

        return { ok: true };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  // Disconnect from remote gateway
  ipcMain.handle(
    IPC_CHANNELS.REMOTE_GATEWAY_DISCONNECT,
    async (): Promise<{ ok: boolean; error?: string }> => {
      try {
        const activeRemoteId = getLegacyActiveRemoteDeviceId();
        if (activeRemoteId) {
          disconnectManagedRemoteDevice(activeRemoteId);
        }
        ControlPlaneSettingsManager.updateSettings({
          connectionMode: "local",
        });
        return { ok: true };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  // Get remote gateway status
  ipcMain.handle(IPC_CHANNELS.REMOTE_GATEWAY_GET_STATUS, async (): Promise<RemoteGatewayStatus> => {
    const activeRemoteId = getLegacyActiveRemoteDeviceId();
    if (!activeRemoteId) {
      return {
        state: "disconnected",
        sshTunnel: getSSHTunnelManager()?.getStatus(),
      };
    }
    return ensureFleetManager().getStatus(activeRemoteId);
  });

  // Save remote gateway config
  ipcMain.handle(
    IPC_CHANNELS.REMOTE_GATEWAY_SAVE_CONFIG,
    async (_, config: RemoteGatewayConfig): Promise<{ ok: boolean; error?: string }> => {
      try {
        const settings = ControlPlaneSettingsManager.loadSettings();
        const managedDevices = listStoredManagedDevices();
        const activeManagedDeviceId =
          settings.activeManagedDeviceId &&
          settings.activeManagedDeviceId !== LOCAL_MANAGED_DEVICE_ID
            ? settings.activeManagedDeviceId
            : undefined;
        const targetDevice =
          (activeManagedDeviceId
            ? managedDevices.find((device) => device.id === activeManagedDeviceId)
            : null) ||
          (settings.activeRemoteDeviceId
            ? managedDevices.find((device) => device.id === settings.activeRemoteDeviceId)
            : null) ||
          managedDevices.find(
            (device) => normalizeGatewayUrl(device.config?.url) === normalizeGatewayUrl(config.url),
          );
        const targetDeviceId =
          targetDevice?.id ||
          activeManagedDeviceId ||
          settings.activeRemoteDeviceId ||
          `remote:${config.url}`;
        const updatedDevice = normalizeManagedRemoteDevice({
          ...(targetDevice || {
            id: targetDeviceId,
            role: "remote",
            purpose: "general",
            platform: "linux",
            status: "disconnected",
          }),
          id: targetDeviceId,
          name: config.deviceName || targetDevice?.name || "CoWork Remote Client",
          transport: inferManagedTransport(config),
          taskNodeId: `remote-gateway:${targetDeviceId}`,
          config,
        } as ManagedDevice);
        const nextManagedDevices = [
          ...managedDevices.filter((device) => device.id !== targetDeviceId),
          updatedDevice,
        ];
        const nextSavedRemoteDevices = [
          ...(settings.savedRemoteDevices || []).filter((device) => device.id !== targetDeviceId),
          {
            id: targetDeviceId,
            name: updatedDevice.name,
            config,
            clientId: targetDevice?.clientId,
            connectedAt: targetDevice?.connectedAt,
            lastActivityAt: targetDevice?.lastSeenAt,
            autoConnect: updatedDevice.autoConnect === true,
          },
        ];

        ControlPlaneSettingsManager.updateSettings({
          remote: config,
          managedDevices: nextManagedDevices,
          savedRemoteDevices: nextSavedRemoteDevices,
          activeManagedDeviceId: targetDeviceId,
          activeRemoteDeviceId: targetDeviceId,
        });
        return { ok: true };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  // Test remote gateway connection
  ipcMain.handle(
    IPC_CHANNELS.REMOTE_GATEWAY_TEST_CONNECTION,
    async (
      _,
      config: RemoteGatewayConfig,
    ): Promise<{
      ok: boolean;
      latencyMs?: number;
      error?: string;
    }> => {
      try {
        const client = new RemoteGatewayClient(config);
        const result = await client.testConnection();
        return {
          ok: result.success,
          latencyMs: result.latencyMs,
          error: result.error,
        };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  // ===== SSH Tunnel Handlers =====

  // Connect SSH tunnel
  ipcMain.handle(
    IPC_CHANNELS.SSH_TUNNEL_CONNECT,
    async (_, config?: SSHTunnelConfig): Promise<{ ok: boolean; error?: string }> => {
      try {
        // Get config from settings if not provided
        const settings = ControlPlaneSettingsManager.loadSettings();
        const tunnelConfig = config || settings.remote?.sshTunnel;

        if (!tunnelConfig?.host || !tunnelConfig?.username) {
          return { ok: false, error: "SSH host and username are required" };
        }

        // Initialize and connect SSH tunnel
        const tunnel = initSSHTunnelManager({
          ...tunnelConfig,
          enabled: true,
        });

        // Setup event forwarding to renderer
        tunnel.on("stateChange", (state: string, error?: string) => {
          if (mainWindowRef && !mainWindowRef.isDestroyed()) {
            mainWindowRef.webContents.send(IPC_CHANNELS.SSH_TUNNEL_EVENT, {
              type: "stateChange",
              state,
              error,
            });
          }
        });

        tunnel.on("connected", () => {
          if (mainWindowRef && !mainWindowRef.isDestroyed()) {
            mainWindowRef.webContents.send(IPC_CHANNELS.SSH_TUNNEL_EVENT, {
              type: "connected",
            });
          }
        });

        tunnel.on("disconnected", (reason: string) => {
          if (mainWindowRef && !mainWindowRef.isDestroyed()) {
            mainWindowRef.webContents.send(IPC_CHANNELS.SSH_TUNNEL_EVENT, {
              type: "disconnected",
              reason,
            });
          }
        });

        tunnel.on("error", (error: Error) => {
          if (mainWindowRef && !mainWindowRef.isDestroyed()) {
            mainWindowRef.webContents.send(IPC_CHANNELS.SSH_TUNNEL_EVENT, {
              type: "error",
              error: error.message,
            });
          }
        });

        await tunnel.connect();

        // Save SSH tunnel config to settings
        if (config) {
          ControlPlaneSettingsManager.updateSettings({
            remote: {
              ...settings.remote,
              url: tunnel.getLocalUrl(),
              token: settings.remote?.token || "",
              sshTunnel: config,
            } as any,
          });
        }

        return { ok: true };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  // Disconnect SSH tunnel
  ipcMain.handle(
    IPC_CHANNELS.SSH_TUNNEL_DISCONNECT,
    async (): Promise<{ ok: boolean; error?: string }> => {
      try {
        shutdownSSHTunnelManager();
        return { ok: true };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  // Get SSH tunnel status
  ipcMain.handle(IPC_CHANNELS.SSH_TUNNEL_GET_STATUS, async (): Promise<SSHTunnelStatus> => {
    const tunnel = getSSHTunnelManager();
    if (!tunnel) {
      return { state: "disconnected" };
    }
    return tunnel.getStatus();
  });

  // Save SSH tunnel config
  ipcMain.handle(
    IPC_CHANNELS.SSH_TUNNEL_SAVE_CONFIG,
    async (_, config: SSHTunnelConfig): Promise<{ ok: boolean; error?: string }> => {
      try {
        const settings = ControlPlaneSettingsManager.loadSettings();
        ControlPlaneSettingsManager.updateSettings({
          remote: {
            ...settings.remote,
            url: settings.remote?.url || "",
            token: settings.remote?.token || "",
            sshTunnel: config,
          } as any,
        });
        return { ok: true };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  // Test SSH tunnel connection
  ipcMain.handle(
    IPC_CHANNELS.SSH_TUNNEL_TEST_CONNECTION,
    async (
      _,
      config: SSHTunnelConfig,
    ): Promise<{
      ok: boolean;
      latencyMs?: number;
      error?: string;
    }> => {
      try {
        const tunnel = new SSHTunnelManager(config);
        const result = await tunnel.testConnection();
        return {
          ok: result.success,
          latencyMs: result.latencyMs,
          error: result.error,
        };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  // ===== Node (Mobile Companion) Handlers =====

  // List connected nodes
  ipcMain.handle(
    IPC_CHANNELS.NODE_LIST,
    async (): Promise<{
      ok: boolean;
      nodes?: import("../../shared/types").NodeInfo[];
      error?: string;
    }> => {
      try {
        const localNodes = controlPlaneServer?.isRunning
          ? ((controlPlaneServer as any).clients.getNodeInfoList() as NodeInfo[])
          : [];
        const remoteNodes = await listManagedRemoteNodes();
        return { ok: true, nodes: [...localNodes, ...remoteNodes] };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  // Get a specific node
  ipcMain.handle(
    IPC_CHANNELS.NODE_GET,
    async (
      _,
      nodeId: string,
    ): Promise<{
      ok: boolean;
      node?: import("../../shared/types").NodeInfo;
      error?: string;
    }> => {
      try {
        if (controlPlaneServer?.isRunning) {
          const client = (controlPlaneServer as any).clients.getNodeByIdOrName(nodeId);
          if (client) {
            return { ok: true, node: client.getNodeInfo() };
          }
        }

        const remoteNodes = await listManagedRemoteNodes();
        const remoteNode = remoteNodes.find(
          (candidate) => candidate.id === nodeId || candidate.displayName === nodeId,
        );
        if (remoteNode) {
          return { ok: true, node: remoteNode };
        }
        return { ok: false, error: `Node not found: ${nodeId}` };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  // Invoke a command on a node
  ipcMain.handle(
    IPC_CHANNELS.NODE_INVOKE,
    async (
      _,
      params: import("../../shared/types").NodeInvokeParams,
    ): Promise<import("../../shared/types").NodeInvokeResult> => {
      try {
        if (!controlPlaneServer || !controlPlaneServer.isRunning) {
          return {
            ok: false,
            error: { code: "SERVER_NOT_RUNNING", message: "Control Plane is not running" },
          };
        }

        const { nodeId, command, params: commandParams, timeoutMs = 30000 } = params;

        // Find the node
        const client = (controlPlaneServer as any).clients.getNodeByIdOrName(nodeId);
        if (!client) {
          return {
            ok: false,
            error: { code: "NODE_NOT_FOUND", message: `Node not found: ${nodeId}` },
          };
        }

        const nodeInfo = client.getNodeInfo();
        if (!nodeInfo) {
          return {
            ok: false,
            error: { code: "NODE_NOT_FOUND", message: `Node not found: ${nodeId}` },
          };
        }

        // Check if node supports the command
        if (!nodeInfo.commands.includes(command)) {
          return {
            ok: false,
            error: {
              code: "COMMAND_NOT_SUPPORTED",
              message: `Node does not support command: ${command}`,
            },
          };
        }

        // Forward to the server's internal method
        const result = await (controlPlaneServer as any).invokeNodeCommand(
          client,
          command,
          commandParams,
          timeoutMs,
        );
        return result;
      } catch (error: any) {
        return {
          ok: false,
          error: { code: "INVOKE_FAILED", message: error.message || String(error) },
        };
      }
    },
  );

  // ── Device management IPC handlers ──

  ipcMain.handle(IPC_CHANNELS.DEVICE_LIST_TASKS, async (_, nodeId: string) => {
    try {
      return { ok: true, tasks: await listTasksForNode(nodeId) };
    } catch (error: any) {
      return { ok: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.DEVICE_LIST_FILES,
    async (
      _,
      params: { nodeId: string; workspaceId: string; path?: string },
    ): Promise<{ ok: boolean; files?: Array<{ name: string; type: "file" | "directory"; size: number }>; error?: string }> => {
      try {
        if (isLocalManagedDeviceIdentifier(params.nodeId)) {
          return { ok: false, error: "Use local file selection for this device" };
        }
        const remoteDevice = await findManagedRemoteDeviceByNodeId(params.nodeId);
        if (!remoteDevice) {
          return { ok: false, error: `Remote device not found for node ${params.nodeId}` };
        }
        const fleetManager = ensureFleetManager();
        const remoteClient = fleetManager.getClient(remoteDevice.id);
        const remoteStatus = fleetManager.getStatus(remoteDevice.id);
        if (!remoteClient || remoteStatus.state !== "connected") {
          return { ok: false, error: "Remote device is not connected" };
        }
        const res = (await remoteClient.request(
          Methods.FILE_LIST_DIRECTORY,
          { workspaceId: params.workspaceId, path: params.path || "." },
          10000,
        )) as { files?: Array<{ name: string; type: "file" | "directory"; size: number }> };
        return { ok: true, files: res?.files || [] };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.DEVICE_LIST_REMOTE_WORKSPACES,
    async (
      _,
      nodeId: string,
    ): Promise<{ ok: boolean; workspaces?: Array<{ id: string; name: string }>; error?: string }> => {
      try {
        if (isLocalManagedDeviceIdentifier(nodeId)) {
          return { ok: false, error: "Use local workspace for this device" };
        }
        const remoteDevice = await findManagedRemoteDeviceByNodeId(nodeId);
        if (!remoteDevice) {
          return { ok: false, error: `Remote device not found for node ${nodeId}` };
        }
        const fleetManager = ensureFleetManager();
        const remoteClient = fleetManager.getClient(remoteDevice.id);
        const remoteStatus = fleetManager.getStatus(remoteDevice.id);
        if (!remoteClient || remoteStatus.state !== "connected") {
          return { ok: false, error: "Remote device is not connected" };
        }
        const res = (await remoteClient.request(Methods.WORKSPACE_LIST, undefined, 5000)) as {
          workspaces?: Array<{ id: string; name: string }>;
        };
        const workspaces = (res?.workspaces || []).map((w) => ({
          id: w.id,
          name: w.name || w.id,
        }));
        return { ok: true, workspaces };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.DEVICE_ASSIGN_TASK,
    async (
      _,
      params: {
        nodeId: string;
        prompt: string;
        workspaceId?: string;
        agentConfig?: Any;
        shellAccess?: boolean;
      },
    ) => {
      try {
        if (!controlPlaneDeps?.dbManager) return { ok: false, error: "No database" };
        if (isLocalManagedDeviceIdentifier(params.nodeId)) {
          return { ok: false, error: "Use the local task creation flow for this device" };
        }
        const db = controlPlaneDeps.dbManager.getDatabase();
        const workspaceRepo = new WorkspaceRepository(db);
        const requestedLocalWorkspace = params.workspaceId
          ? workspaceRepo.findById(params.workspaceId)
          : undefined;
        const fallbackLocalWorkspace = workspaceRepo.findAll()[0];
        const localWorkspaceId = requestedLocalWorkspace?.id || fallbackLocalWorkspace?.id;
        if (!localWorkspaceId) {
          return { ok: false, error: "No local workspace available for remote task shadow record" };
        }
        const remoteDevice = await findManagedRemoteDeviceByNodeId(params.nodeId);
        if (!remoteDevice) {
          return { ok: false, error: `Remote device not found for node ${params.nodeId}` };
        }
        const fleetManager = ensureFleetManager();
        const remoteClient = fleetManager.getClient(remoteDevice.id);
        const remoteStatus = fleetManager.getStatus(remoteDevice.id);
        if (!remoteClient || remoteStatus.state !== "connected") {
          return { ok: false, error: "Remote device is not connected" };
        }

        let remoteTaskRes: Any;
        try {
          const workspacesRes = (await remoteClient.request(Methods.WORKSPACE_LIST, undefined, 5000)) as Any;
          const remoteWorkspaces = Array.isArray(workspacesRes?.workspaces)
            ? workspacesRes.workspaces
            : [];

          let targetWorkspaceId = params.workspaceId;
          const remoteHasWorkspace = remoteWorkspaces.some((workspace: Any) => workspace.id === targetWorkspaceId);
          if (!remoteHasWorkspace) {
            if (remoteWorkspaces.length === 0) {
              throw new Error("No workspaces available on the remote device");
            }
            targetWorkspaceId = remoteWorkspaces[0].id;
          }

          const taskCreateParams: Any = {
            title: params.prompt.slice(0, 50) + (params.prompt.length > 50 ? "..." : ""),
            prompt: params.prompt,
            workspaceId: targetWorkspaceId,
          };
          if (params.agentConfig && Object.keys(params.agentConfig).length > 0) {
            taskCreateParams.agentConfig = params.agentConfig;
          }
          if (params.shellAccess === true) {
            taskCreateParams.shellAccess = true;
          }
          remoteTaskRes = await remoteClient.request(Methods.TASK_CREATE, taskCreateParams, 15000);
        } catch (error: Any) {
          console.error("[ControlPlane] Remote task execution failed:", error);
          return { ok: false, error: error?.message || "Remote execution failed" };
        }

        const remoteTask = remoteTaskRes?.task;
        const id = remoteTaskRes?.taskId || remoteTask?.id || randomUUID();
        upsertRemoteShadowTask(
          db,
          localWorkspaceId,
          remoteDevice.taskNodeId || `remote-gateway:${remoteDevice.id}`,
          {
            ...remoteTask,
            id,
            prompt: params.prompt,
            title: remoteTask?.title || params.prompt.slice(0, 80),
          },
        );

        return { ok: true, taskId: id };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  ipcMain.handle(IPC_CHANNELS.DEVICE_LIST_MANAGED, async () => {
    try {
      return { ok: true, devices: await listManagedDevicesForRenderer() };
    } catch (error: any) {
      return { ok: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.DEVICE_GET_SUMMARY, async (_, deviceId: string) => {
    try {
      return { ok: true, summary: await buildManagedDeviceSummary(deviceId) };
    } catch (error: any) {
      return { ok: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.DEVICE_CONNECT, async (_, deviceId: string) => {
    try {
      const status = await connectManagedRemoteDevice(deviceId);
      return { ok: true, status };
    } catch (error: any) {
      return { ok: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.DEVICE_DISCONNECT, async (_, deviceId: string) => {
    try {
      const status = disconnectManagedRemoteDevice(deviceId);
      return { ok: true, status };
    } catch (error: any) {
      return { ok: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.DEVICE_PROXY_REQUEST, async (_, request: DeviceProxyRequest) => {
    try {
      if (!request?.deviceId || !request?.method) {
        return { ok: false, error: "deviceId and method are required" };
      }
      if (isLocalManagedDeviceIdentifier(request.deviceId)) {
        return { ok: true, payload: await routeLocalDeviceProxyRequest(request.method, request.params) };
      }
      const device = findManagedDeviceById(request.deviceId);
      if (!device || device.role !== "remote") {
        return { ok: false, error: `Managed device not found: ${request.deviceId}` };
      }
      const fleetManager = ensureFleetManager();
      const client = fleetManager.getClient(device.id);
      const status = fleetManager.getStatus(device.id);
      if (!client || status.state !== "connected") {
        return { ok: false, error: "Remote device is not connected" };
      }
      const params =
        request.method === Methods.TASK_SEND_MESSAGE
          ? await normalizeImagesForRemote(request.params)
          : request.params;
      const payload = await client.request(request.method, params, 15000);
      return { ok: true, payload };
    } catch (error: any) {
      return { ok: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.DEVICE_GET_PROFILES, async () => {
    try {
      if (!controlPlaneDeps?.dbManager) return { ok: false, error: "No database" };
      const { DeviceProfileRepository } = await import("../database/DeviceProfileRepository");
      const repo = new DeviceProfileRepository(controlPlaneDeps.dbManager.getDatabase());
      return { ok: true, profiles: repo.list() };
    } catch (error: any) {
      return { ok: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.DEVICE_UPDATE_PROFILE,
    async (_, deviceId: string, data: { customName?: string; platform?: string; modelIdentifier?: string }) => {
      try {
        if (!controlPlaneDeps?.dbManager) return { ok: false, error: "No database" };
        const { DeviceProfileRepository } = await import("../database/DeviceProfileRepository");
        const repo = new DeviceProfileRepository(controlPlaneDeps.dbManager.getDatabase());
        repo.upsert(deviceId, data);
        return { ok: true };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  console.log("[ControlPlane] IPC handlers initialized");
}

/**
 * Shutdown the control plane server, remote client, and SSH tunnel
 * Call this during app quit
 */
export async function shutdownControlPlane(): Promise<void> {
  // Shutdown SSH tunnel
  shutdownSSHTunnelManager();

  // Shutdown fleet-managed remote clients
  shutdownFleetConnectionManager();

  // Shutdown ACP registry
  shutdownACP();

  // Shutdown local server
  if (controlPlaneServer) {
    console.log("[ControlPlane] Shutting down server...");
    if (detachAgentDaemonBridge) {
      detachAgentDaemonBridge();
      detachAgentDaemonBridge = null;
    }
    await controlPlaneServer.stop();
    controlPlaneServer = null;
  }
}
