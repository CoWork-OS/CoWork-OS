import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from "react";
import {
  Activity,
  AlertCircle,
  AppWindow,
  Bell,
  CheckCircle2,
  Circle,
  Clock,
  Clock3,
  Cpu,
  Hash,
  HardDrive,
  Laptop,
  MessageCircle,
  Mic,
  SlidersHorizontal,
  PauseCircle,
  Plus,
  Plug2,
  RefreshCw,
  Monitor,
  Send,
  Server,
  ShieldCheck,
  Unplug,
  Wifi,
  X,
  XCircle,
  Trash2,
  Zap,
} from "lucide-react";
import type {
  ControlPlaneSettingsData,
  ExecutionMode,
  ManagedDevice,
  ManagedDeviceSummary,
  MultiLlmConfig,
  RemoteGatewayConfig,
  RemoteGatewayStatus,
  SavedRemoteGatewayDevice,
  Task,
  TaskDomain,
  Workspace,
} from "../../shared/types";
import { isTempWorkspaceId, LOCAL_MANAGED_DEVICE_ID } from "../../shared/types";
import { isActiveSessionStatus, isAwaitingSessionStatus } from "./Sidebar";
import { getPlatformVisualIcon } from "./DeviceIcons";
import { RemoteFilePicker } from "./RemoteFilePicker";
import { RemoteDeviceControlVisual } from "./RemoteDeviceControlVisual";

export interface DeviceTaskOptions {
  shellAccess?: boolean;
  autonomousMode?: boolean;
  collaborativeMode?: boolean;
  multiLlmMode?: boolean;
  multiLlmConfig?: MultiLlmConfig;
  executionMode?: ExecutionMode;
  taskDomain?: TaskDomain;
  chronicleMode?: "inherit" | "enabled" | "disabled";
}

interface DevicesPanelProps {
  onOpenTask: (taskId: string, remote?: { deviceId: string; deviceName: string }) => void;
  onNewTaskForDevice?: (nodeId: string, prompt: string, options?: DeviceTaskOptions) => Promise<void>;
  onCreateTaskHere?: (prompt: string, options?: DeviceTaskOptions) => Promise<void>;
  workspace?: Workspace | null;
  onOpenSettings?: (tab?: string) => void;
  availableProviders?: { configured: boolean }[];
}

type TaskFilter = "selected" | "all" | "attention";
type PanelOverlay =
  | { type: "pairing" }
  | { type: "details"; deviceId: string }
  | { type: "apps"; deviceId: string }
  | { type: "storage"; deviceId: string }
  | { type: "observer"; deviceId: string }
  | null;

type TestResult = {
  success: boolean;
  message: string;
  latencyMs?: number;
};

function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) return "Just now";
  const diff = Date.now() - timestamp;
  const minutes = Math.max(1, Math.round(diff / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function formatBytes(value?: number): string {
  if (!value || !Number.isFinite(value) || value <= 0) return "Unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let next = value;
  let index = 0;
  while (next >= 1024 && index < units.length - 1) {
    next /= 1024;
    index += 1;
  }
  return `${next.toFixed(next >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function purposeLabel(purpose?: ManagedDevice["purpose"]): string {
  switch (purpose) {
    case "primary":
      return "Primary";
    case "work":
      return "Work";
    case "personal":
      return "Personal";
    case "automation":
      return "Automation";
    case "archive":
      return "Archive";
    case "general":
    default:
      return "General";
  }
}

function deviceConnectionLabel(device: ManagedDevice): string {
  if (device.role === "local") return "Local";
  switch (device.status) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "authenticating":
      return "Authenticating";
    case "reconnecting":
      return "Reconnecting";
    case "error":
      return "Needs attention";
    default:
      return "Saved";
  }
}

function deviceAttentionLabel(level?: ManagedDevice["attentionState"]): string | null {
  switch (level) {
    case "critical":
      return "Critical";
    case "warning":
      return "Attention";
    case "info":
      return "Info";
    default:
      return null;
  }
}

function inferTransport(config: RemoteGatewayConfig): ManagedDevice["transport"] {
  if (config.sshTunnel?.enabled) return "ssh";
  try {
    const url = new URL(config.url);
    if (url.hostname.endsWith(".ts.net")) return "tailscale";
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return "direct";
    return "direct";
  } catch {
    return "unknown";
  }
}

function normalizeGatewayUrl(url?: string): string {
  return (url || "").trim().replace(/\/+$/, "");
}

function reconcileRemoteDeviceNamesFromSettings(
  devices: ManagedDevice[],
  settingsData: ControlPlaneSettingsData | null | undefined,
): ManagedDevice[] {
  const remoteConfig = settingsData?.remote;
  const persistedName = remoteConfig?.deviceName?.trim();
  if (!remoteConfig?.url || !persistedName) return devices;

  const activeManagedDeviceId = settingsData?.activeManagedDeviceId;
  const activeRemoteDeviceId = settingsData?.activeRemoteDeviceId;
  const normalizedRemoteUrl = normalizeGatewayUrl(remoteConfig.url);

  return devices.map((device) => {
    if (device.role !== "remote") return device;
    const matchesActiveId =
      device.id === activeManagedDeviceId || device.id === activeRemoteDeviceId;
    const matchesUrl = normalizeGatewayUrl(device.config?.url) === normalizedRemoteUrl;
    if (!matchesActiveId && !matchesUrl) return device;

    return {
      ...device,
      name: persistedName,
      config: device.config
        ? {
            ...device.config,
            deviceName: persistedName,
          }
        : device.config,
    };
  });
}

function isTaskAttention(task: Task): boolean {
  return (
    task.status === "blocked" ||
    task.terminalStatus === "needs_user_action" ||
    task.terminalStatus === "awaiting_approval"
  );
}

function toSavedRemoteDevice(device: ManagedDevice): SavedRemoteGatewayDevice | null {
  if (device.role !== "remote" || !device.config) return null;
  return {
    id: device.id,
    name: device.name,
    config: device.config,
    clientId: device.clientId,
    connectedAt: device.connectedAt,
    lastActivityAt: device.lastSeenAt,
  };
}

function upsertManagedRemoteDevice(
  devices: ManagedDevice[],
  nextDevice: ManagedDevice,
): ManagedDevice[] {
  return [
    ...devices.filter((device) => device.id !== nextDevice.id),
    nextDevice,
  ].sort((a, b) => {
    if (a.id === LOCAL_MANAGED_DEVICE_ID) return -1;
    if (b.id === LOCAL_MANAGED_DEVICE_ID) return 1;
    return (a.name || "").localeCompare(b.name || "");
  });
}

function getTaskBadge(task: Task) {
  if (task.status === "completed") {
    return { className: "done", label: "Completed", icon: <CheckCircle2 size={12} /> };
  }
  if (task.status === "failed" || task.status === "cancelled") {
    return {
      className: "failed",
      label: task.status === "failed" ? "Failed" : "Cancelled",
      icon: <XCircle size={12} />,
    };
  }
  if (isTaskAttention(task)) {
    return {
      className: "attention",
      label:
        task.terminalStatus === "awaiting_approval" ? "Approval needed" : "Needs input",
      icon: <AlertCircle size={12} />,
    };
  }
  if (task.status === "paused" || isAwaitingSessionStatus(task.status)) {
    return { className: "paused", label: "Paused", icon: <PauseCircle size={12} /> };
  }
  if (task.status === "queued" || task.status === "pending" || task.status === "planning") {
    return {
      className: "pending",
      label: task.status === "planning" ? "Planning" : task.status === "queued" ? "Queued" : "Pending",
      icon: <Clock3 size={12} />,
    };
  }
  if (isActiveSessionStatus(task.status) || task.status === "interrupted") {
    return { className: "running", label: "Running", icon: <Circle size={12} className="dp-pulse" /> };
  }
  return { className: "pending", label: task.status, icon: <Clock3 size={12} /> };
}

function isTerminalDeviceTask(task: Task): boolean {
  return task.status === "completed" || task.status === "failed" || task.status === "cancelled";
}

const EXECUTION_MODE_ORDER: ExecutionMode[] = ["chat", "execute", "plan", "analyze", "debug", "verified"];
const TASK_DOMAIN_ORDER: TaskDomain[] = [
  "auto",
  "code",
  "research",
  "operations",
  "writing",
  "general",
];
const EXECUTION_MODE_LABEL: Record<ExecutionMode, string> = {
  chat: "Chat",
  execute: "Execute",
  plan: "Plan",
  analyze: "Analyze",
  debug: "Debug",
  verified: "Verified",
};
const TASK_DOMAIN_LABEL: Record<TaskDomain, string> = {
  auto: "Auto",
  code: "Code",
  research: "Research",
  operations: "Operations",
  writing: "Writing",
  general: "General",
  media: "Video",
};

const APP_NAME = "CoWork";

const DISPATCH_CHANNELS = [
  { type: "whatsapp" as const, label: "WhatsApp", icon: MessageCircle, settingsTab: "whatsapp" },
  { type: "telegram" as const, label: "Telegram", icon: Send, settingsTab: "telegram" },
  { type: "slack" as const, label: "Slack", icon: Hash, settingsTab: "slack" },
];

export function DevicesPanel({
  onOpenTask,
  onNewTaskForDevice,
  onCreateTaskHere,
  workspace,
  onOpenSettings,
  availableProviders = [],
}: DevicesPanelProps) {
  const overviewRef = useRef<HTMLDivElement | null>(null);
  const tasksRef = useRef<HTMLDivElement | null>(null);
  const devicesRef = useRef<HTMLDivElement | null>(null);
  const appsRef = useRef<HTMLElement | null>(null);
  const storageRef = useRef<HTMLElement | null>(null);
  const alertsRef = useRef<HTMLElement | null>(null);
  const [devices, setDevices] = useState<ManagedDevice[]>([]);
  const [summaries, setSummaries] = useState<Record<string, ManagedDeviceSummary>>({});
  const [deviceTasks, setDeviceTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [taskPrompt, setTaskPrompt] = useState("");
  const [submittingTask, setSubmittingTask] = useState(false);
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("selected");
  const [overlay, setOverlay] = useState<PanelOverlay>(null);
  const [busyActionKey, setBusyActionKey] = useState<string | null>(null);
  const [showOverflowMenu, setShowOverflowMenu] = useState(false);
  const [overflowSubmenu, setOverflowSubmenu] = useState<"mode" | "domain" | null>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);

  const [shellAccess, setShellAccess] = useState(false);
  const [autonomousModeEnabled, setAutonomousModeEnabled] = useState(false);
  const [collaborativeModeEnabled, setCollaborativeModeEnabled] = useState(false);
  const [multiLlmModeEnabled, setMultiLlmModeEnabled] = useState(false);
  const [chronicleEnabledForTask, setChronicleEnabledForTask] = useState(true);
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("execute");
  const [taskDomain, setTaskDomain] = useState<TaskDomain>("auto");
  const [pendingAttachments, setPendingAttachments] = useState<
    Array<{ path: string; name: string; source: "local" | "remote" }>
  >([]);
  const [showRemoteFilePicker, setShowRemoteFilePicker] = useState(false);
  const [remoteFilePickerContext, setRemoteFilePickerContext] = useState<{
    deviceName: string;
    workspaces: Array<{ id: string; name: string }>;
  } | null>(null);
  const [dispatchChannels, setDispatchChannels] = useState<{ id: string; type: string; name: string; status: string }[]>([]);
  const [dispatchLoading, setDispatchLoading] = useState(true);

  const setAutonomousModeSelection = useCallback((enabled: boolean) => {
    setAutonomousModeEnabled(enabled);
    if (enabled) {
      setCollaborativeModeEnabled(false);
      setMultiLlmModeEnabled(false);
    }
  }, []);
  const setCollaborativeModeSelection = useCallback((enabled: boolean) => {
    setCollaborativeModeEnabled(enabled);
    if (enabled) {
      setAutonomousModeEnabled(false);
      setMultiLlmModeEnabled(false);
    }
  }, []);
  const setMultiLlmModeSelection = useCallback((enabled: boolean) => {
    setMultiLlmModeEnabled(enabled);
    if (enabled) {
      setAutonomousModeEnabled(false);
      setCollaborativeModeEnabled(false);
    }
  }, []);

  const showMultiLlmOption = availableProviders.filter((p) => p.configured).length >= 2;

  const loadSummaries = useCallback(async (managedDevices: ManagedDevice[]) => {
    const results = await Promise.all(
      managedDevices.map(async (device) => {
        try {
          const result = await window.electronAPI?.getDeviceSummary?.(device.id);
          return result?.ok && result.summary ? [device.id, result.summary] : null;
        } catch (error) {
          console.error(`Failed to load summary for ${device.id}:`, error);
          return null;
        }
      }),
    );
    const nextEntries = results.filter((entry): entry is [string, ManagedDeviceSummary] => !!entry);
    if (nextEntries.length === 0) return;
    setSummaries((current) => {
      const next = { ...current };
      for (const [deviceId, summary] of nextEntries) {
        next[deviceId] = summary;
      }
      return next;
    });
    setDevices((current) =>
      current.map((device) => {
        const summary = nextEntries.find(([deviceId]) => deviceId === device.id)?.[1];
        return summary?.device || device;
      }),
    );
  }, []);

  const loadDevices = useCallback(async () => {
    try {
      const [devicesResult, settingsData] = await Promise.all([
        window.electronAPI?.listManagedDevices?.(),
        window.electronAPI?.getControlPlaneSettings?.(),
      ]);
      const listedDevices =
        devicesResult?.ok && Array.isArray(devicesResult.devices)
          ? (devicesResult.devices as ManagedDevice[])
          : [];
      const nextDevices = reconcileRemoteDeviceNamesFromSettings(
        listedDevices,
        settingsData as ControlPlaneSettingsData | null | undefined,
      );
      setDevices(nextDevices);
      setSelectedDeviceId((current) => {
        const nextRemoteDevices = nextDevices.filter((device) => device.role === "remote");
        if (current && nextRemoteDevices.some((device) => device.id === current)) return current;
        const preferredId =
          (settingsData as ControlPlaneSettingsData | null)?.activeManagedDeviceId || null;
        if (preferredId && nextRemoteDevices.some((device) => device.id === preferredId)) {
          return preferredId;
        }
        return nextRemoteDevices[0]?.id || null;
      });
      await loadSummaries(nextDevices);
    } catch (error) {
      console.error("Failed to load managed devices:", error);
      setDevices([]);
      setSummaries({});
    } finally {
      setLoading(false);
    }
  }, [loadSummaries]);

  useEffect(() => {
    void loadDevices();

    const unsubscribe = window.electronAPI?.onRemoteGatewayEvent?.((event) => {
      if (
        event.type === "stateChange" ||
        event.type === "event" ||
        event.type === "sshTunnelStateChange"
      ) {
        void loadDevices();
      }
    });

    const interval = window.setInterval(() => {
      void loadDevices();
    }, 12000);

    return () => {
      unsubscribe?.();
      window.clearInterval(interval);
    };
  }, [loadDevices]);

  useEffect(() => {
    if (!selectedDeviceId) return;
    window.electronAPI
      ?.saveControlPlaneSettings?.({ activeManagedDeviceId: selectedDeviceId })
      ?.catch((error) => {
        console.error("Failed to persist selected device:", error);
      });
  }, [selectedDeviceId]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (showOverflowMenu && overflowMenuRef.current && !overflowMenuRef.current.contains(e.target as Node)) {
        setShowOverflowMenu(false);
        setOverflowSubmenu(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showOverflowMenu]);

  useEffect(() => {
    const handleNavigate = (event: Event) => {
      const detail = (event as CustomEvent<{ section?: string }>).detail;
      const section = detail?.section;
      const refMap: Record<string, { current: HTMLElement | HTMLDivElement | null }> = {
        overview: overviewRef,
        tasks: tasksRef,
        devices: devicesRef,
        apps: appsRef,
        storage: storageRef,
        alerts: alertsRef,
      };
      const targetRef = section ? refMap[section] : null;
      targetRef?.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    };

    window.addEventListener("devices:navigate", handleNavigate as EventListener);
    return () => window.removeEventListener("devices:navigate", handleNavigate as EventListener);
  }, []);

  useEffect(() => {
    const handleAction = (event: Event) => {
      const detail = (event as CustomEvent<{ action?: string }>).detail;
      if (detail?.action === "pairing") {
        setOverlay({ type: "pairing" });
      }
    };

    window.addEventListener("devices:action", handleAction as EventListener);
    return () => window.removeEventListener("devices:action", handleAction as EventListener);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadDispatchChannels() {
      try {
        const list = await window.electronAPI.getGatewayChannels();
        if (!cancelled) {
          setDispatchChannels(
            (list || []).map((c: { id: string; type: string; name: string; status: string }) => ({
              id: c.id,
              type: c.type,
              name: c.name,
              status: c.status || "disconnected",
            })),
          );
        }
      } catch {
        if (!cancelled) setDispatchChannels([]);
      } finally {
        if (!cancelled) setDispatchLoading(false);
      }
    }
    loadDispatchChannels();
    return () => {
      cancelled = true;
    };
  }, []);

  const deviceMap = useMemo(
    () => new Map(devices.map((device) => [device.id, device])),
    [devices],
  );

  const activeDevice = useMemo(
    () => (selectedDeviceId ? deviceMap.get(selectedDeviceId) || null : null),
    [deviceMap, selectedDeviceId],
  );

  const activeSummary = useMemo(
    () => (activeDevice ? summaries[activeDevice.id] || null : null),
    [activeDevice, summaries],
  );

  const remoteDevices = useMemo(
    () => devices.filter((device) => device.role === "remote"),
    [devices],
  );

  const loadTaskFeed = useCallback(async () => {
    if (remoteDevices.length === 0) {
      setDeviceTasks([]);
      return;
    }

    const targetDevices =
      taskFilter === "selected"
        ? activeDevice
          ? [activeDevice]
          : []
        : remoteDevices.filter((device) => !!device.taskNodeId);

    if (targetDevices.length === 0) {
      setDeviceTasks([]);
      return;
    }

    const results = await Promise.all(
      targetDevices.map(async (device) => {
        if (!device.taskNodeId) return [];
        try {
          const result = await window.electronAPI?.deviceListTasks?.(device.taskNodeId);
          return result?.ok && Array.isArray(result.tasks) ? (result.tasks as Task[]) : [];
        } catch (error) {
          console.error(`Failed to load tasks for ${device.id}:`, error);
          return [];
        }
      }),
    );

    const merged = new Map<string, Task>();
    for (const task of results.flat()) {
      const existing = merged.get(task.id);
      if (!existing || (task.updatedAt || 0) > (existing.updatedAt || 0)) {
        merged.set(task.id, task);
      }
    }

    const sorted = Array.from(merged.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const visible = sorted.filter((task) => {
      const taskNodeId = typeof task.targetNodeId === "string" ? task.targetNodeId : "";
      const taskDevice = remoteDevices.find((device) => device.taskNodeId === taskNodeId);
      if (!taskDevice || taskDevice.role !== "remote") return true;
      if (taskDevice.status === "connected") return true;
      return isTerminalDeviceTask(task);
    });
    setDeviceTasks(taskFilter === "attention" ? visible.filter((task) => isTaskAttention(task)) : visible);
  }, [activeDevice, remoteDevices, taskFilter]);

  useEffect(() => {
    void loadTaskFeed();
    const interval = window.setInterval(() => {
      void loadTaskFeed();
    }, 4000);
    return () => window.clearInterval(interval);
  }, [loadTaskFeed]);

  const resolveTaskDevice = useCallback(
    (task: Task): ManagedDevice | null => {
      if (!task.targetNodeId) return null;
      for (const device of devices) {
        if (device.taskNodeId === task.targetNodeId) return device;
      }
      return null;
    },
    [devices],
  );

  const buildTaskOptions = useCallback((): DeviceTaskOptions => {
    const opts: DeviceTaskOptions = {
      shellAccess,
      executionMode,
      taskDomain,
      chronicleMode: chronicleEnabledForTask ? "inherit" : "disabled",
    };
    if (multiLlmModeEnabled) {
      opts.multiLlmMode = true;
    } else if (collaborativeModeEnabled) {
      opts.collaborativeMode = true;
    } else if (autonomousModeEnabled) {
      opts.autonomousMode = true;
    }
    return opts;
  }, [autonomousModeEnabled, chronicleEnabledForTask, collaborativeModeEnabled, executionMode, multiLlmModeEnabled, shellAccess, taskDomain]);

  const buildPromptWithAttachments = useCallback(
    (basePrompt: string): string => {
      if (pendingAttachments.length === 0) return basePrompt;
      const lines = basePrompt.trim() ? [basePrompt.trim()] : [];
      lines.push("");
      lines.push("Please review these files:");
      for (const att of pendingAttachments) {
        lines.push(`- ${att.path} (${att.name})`);
      }
      return lines.join("\n");
    },
    [pendingAttachments],
  );

  const handleRunTask = useCallback(async () => {
    if (!activeDevice || !taskPrompt.trim() || submittingTask) return;
    setSubmittingTask(true);
    const options = buildTaskOptions();
    const prompt = buildPromptWithAttachments(taskPrompt.trim());
    try {
      if (activeDevice.role === "local") {
        await onCreateTaskHere?.(prompt, options);
      } else if (activeDevice.taskNodeId) {
        await onNewTaskForDevice?.(activeDevice.taskNodeId, prompt, options);
      }
      setTaskPrompt("");
      setPendingAttachments([]);
      setShellAccess(false);
      setAutonomousModeEnabled(false);
      setCollaborativeModeEnabled(false);
      setMultiLlmModeEnabled(false);
      await loadDevices();
      await loadTaskFeed();
    } catch (error) {
      console.error("Failed to run task from devices panel:", error);
    } finally {
      setSubmittingTask(false);
    }
  }, [activeDevice, buildPromptWithAttachments, buildTaskOptions, loadDevices, loadTaskFeed, onCreateTaskHere, onNewTaskForDevice, pendingAttachments, submittingTask, taskPrompt]);

  const handleAttachFiles = useCallback(async () => {
    if (!activeDevice) return;
    if (activeDevice.role === "local") {
      try {
        const files = await window.electronAPI?.selectFiles?.();
        if (files?.length) {
          const workspacePath = workspace?.path ? workspace.path.replace(/\/$/, "") + "/" : "";
          setPendingAttachments((prev) => {
            const next = [...prev];
            for (const f of files) {
              const relPath =
                workspacePath && f.path.startsWith(workspacePath)
                  ? f.path.slice(workspacePath.length).replace(/^\/+/, "")
                  : f.path;
              if (!next.some((a) => a.path === relPath)) {
                next.push({ path: relPath, name: f.name, source: "local" });
              }
            }
            return next.slice(0, 10);
          });
        }
      } catch (err) {
        console.error("Failed to select files:", err);
      }
    } else if (activeDevice.taskNodeId) {
      try {
        const res = await window.electronAPI?.deviceListRemoteWorkspaces?.(activeDevice.taskNodeId);
        if (res?.ok && res.workspaces?.length) {
          setRemoteFilePickerContext({
            deviceName: activeDevice.name || "Remote device",
            workspaces: res.workspaces,
          });
          setShowRemoteFilePicker(true);
        }
      } catch (err) {
        console.error("Failed to fetch remote workspaces:", err);
      }
    }
  }, [activeDevice, workspace?.path]);

  const handleConnectDevice = useCallback(
    async (deviceId: string) => {
      setBusyActionKey(`connect:${deviceId}`);
      try {
        await window.electronAPI?.connectDevice?.(deviceId);
        await loadDevices();
      } catch (error) {
        console.error(`Failed to connect ${deviceId}:`, error);
      } finally {
        setBusyActionKey(null);
      }
    },
    [loadDevices],
  );

  const handleDisconnectDevice = useCallback(
    async (deviceId: string) => {
      setBusyActionKey(`disconnect:${deviceId}`);
      try {
        await window.electronAPI?.disconnectDevice?.(deviceId);
        await loadDevices();
      } catch (error) {
        console.error(`Failed to disconnect ${deviceId}:`, error);
      } finally {
        setBusyActionKey(null);
      }
    },
    [loadDevices],
  );

  const handleRemoveDevice = useCallback(
    async (deviceId: string) => {
      try {
        const settings = (await window.electronAPI?.getControlPlaneSettings?.()) as
          | ControlPlaneSettingsData
          | null;
        const nextManagedDevices = (settings?.managedDevices || []).filter(
          (device) => device.id !== deviceId,
        );
        const nextSavedDevices = (settings?.savedRemoteDevices || []).filter(
          (device) => device.id !== deviceId,
        );
        await window.electronAPI?.disconnectDevice?.(deviceId);
        await window.electronAPI?.saveControlPlaneSettings?.({
          managedDevices: nextManagedDevices,
          savedRemoteDevices: nextSavedDevices,
          activeManagedDeviceId:
            selectedDeviceId === deviceId ? LOCAL_MANAGED_DEVICE_ID : settings?.activeManagedDeviceId,
          activeRemoteDeviceId:
            settings?.activeRemoteDeviceId === deviceId ? undefined : settings?.activeRemoteDeviceId,
        });
        if (selectedDeviceId === deviceId) {
          setSelectedDeviceId(LOCAL_MANAGED_DEVICE_ID);
        }
        await loadDevices();
      } catch (error) {
        console.error(`Failed to remove device ${deviceId}:`, error);
      }
    },
    [loadDevices, selectedDeviceId],
  );

  const taskCountLabel =
    taskFilter === "selected"
      ? activeDevice
        ? `${activeDevice.name}`
        : "Selected"
      : taskFilter === "attention"
        ? "Needs attention"
        : "All devices";

  const handleRemoteFilesSelected = useCallback((paths: string[]) => {
    setPendingAttachments((prev) => {
      const next = [...prev];
      for (const p of paths) {
        const name = p.split("/").pop() || p;
        if (!next.some((a) => a.path === p)) {
          next.push({ path: p, name, source: "remote" });
        }
      }
      return next.slice(0, 10);
    });
    setShowRemoteFilePicker(false);
    setRemoteFilePickerContext(null);
  }, []);

  if (loading) {
    return (
      <div className="devices-panel">
        <div className="devices-loading">Loading devices...</div>
      </div>
    );
  }

  return (
    <div className="devices-panel">
      <div className="dp-header">
        <h1 className="dp-title">Devices</h1>
      </div>

      <div
        ref={overviewRef}
        className={`dp-input-box${!activeDevice ? " disabled" : ""}${showOverflowMenu ? " dropdown-open" : ""}`}
      >
        <div className="dp-input-toolbar">
          <div className="dp-toolbar-primary">
            <span className="dp-device-pill">
              {activeDevice?.role === "local" ? <Laptop size={14} /> : <Server size={14} />}
              {activeDevice?.name || "No device selected"}
            </span>
            <span className="dp-purpose-chip">{purposeLabel(activeDevice?.purpose)}</span>
            <span className="dp-run-chip">
              {activeDevice?.role === "local" ? "Run here" : "Run on selected remote"}
            </span>
          </div>
          <select
            className="dp-device-switcher"
            value={activeDevice?.id || ""}
            onChange={(event) => setSelectedDeviceId(event.target.value)}
          >
            <option value="" disabled>
              Select managed device
            </option>
            {remoteDevices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name} ({purposeLabel(device.purpose)})
              </option>
            ))}
          </select>
        </div>

        {pendingAttachments.length > 0 && (
          <div className="dp-attachments-row">
            {pendingAttachments.map((att) => (
              <span key={att.path} className="dp-attachment-chip">
                {att.name}
                <button
                  type="button"
                  className="dp-attachment-remove"
                  onClick={() =>
                    setPendingAttachments((prev) => prev.filter((a) => a.path !== att.path))
                  }
                  aria-label={`Remove ${att.name}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="dp-input-row">
          <Monitor size={20} className="dp-input-icon" />
          <input
            className="dp-input"
            placeholder={
              !activeDevice
                ? "Select a device to start a task..."
                : submittingTask
                  ? "Starting task..."
                  : `Start a task on ${activeDevice.name}...`
            }
            value={taskPrompt}
            disabled={submittingTask || !activeDevice}
            onChange={(event) => setTaskPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void handleRunTask();
              }
            }}
          />
        </div>

        <div className="dp-input-actions">
          <button
            className="dp-input-action-btn"
            onClick={() => void handleAttachFiles()}
            disabled={!activeDevice || submittingTask}
            aria-label="Attach files"
            title="Attach files from this device"
          >
            <Plus size={20} />
          </button>
          <div className="overflow-menu-container dp-overflow-menu" ref={overflowMenuRef}>
            <button
              type="button"
              className={`overflow-menu-btn dp-input-action-btn ${showOverflowMenu ? "active" : ""}`}
              onClick={() => setShowOverflowMenu((v) => !v)}
              disabled={!activeDevice}
              aria-haspopup="menu"
              aria-expanded={showOverflowMenu}
              aria-label="Task options"
            >
              <SlidersHorizontal size={20} />
            </button>
            {showOverflowMenu && (
              <div
                className="overflow-menu-dropdown dp-overflow-dropdown dp-overflow-dropdown-solid"
                role="menu"
                aria-label="Task options"
              >
                <div className="overflow-menu-item" role="none">
                  <button
                    className="folder-selector"
                    onClick={() => {
                      setOverflowSubmenu(null);
                      setShowOverflowMenu(false);
                      onOpenSettings?.("controlplane");
                    }}
                    role="menuitem"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                    </svg>
                    <span>{workspace?.isTemp || isTempWorkspaceId(workspace?.id) ? "Work in a folder" : workspace?.name || "Work in a folder"}</span>
                  </button>
                </div>
                <div className="overflow-menu-item" role="none">
                  <button
                    className={`shell-toggle ${shellAccess ? "enabled" : ""}`}
                    onClick={() => {
                      setOverflowSubmenu(null);
                      setShellAccess((v) => !v);
                    }}
                    role="menuitemcheckbox"
                    aria-checked={shellAccess}
                    aria-label={`Shell ${shellAccess ? "on" : "off"}`}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M4 17l6-6-6-6M12 19h8" />
                    </svg>
                    <span>Shell</span>
                    <span className={`goal-mode-switch-track ${shellAccess ? "on" : ""}`} aria-hidden="true">
                      <span className="goal-mode-switch-thumb" />
                    </span>
                  </button>
                </div>
                <div className="overflow-menu-item" role="none">
                  <button
                    className="skills-menu-btn"
                    onClick={() => {
                      setOverflowSubmenu(null);
                      setShowOverflowMenu(false);
                      onOpenSettings?.("customize");
                    }}
                    role="menuitem"
                  >
                    <span>/</span>
                    <span>Skills</span>
                    <Zap size={14} className="dp-overflow-zap" />
                  </button>
                </div>
                <div className="overflow-menu-item" role="none">
                  <button
                    className="goal-mode-toggle goal-mode-toggle-switch-row"
                    onClick={() => setAutonomousModeSelection(!autonomousModeEnabled)}
                    role="menuitemcheckbox"
                    aria-checked={autonomousModeEnabled}
                  >
                    <span className="goal-mode-toggle-switch-content">
                      <span className="goal-mode-toggle-text">
                        <span className="goal-mode-label">Autonomous</span>
                      </span>
                      <span className={`goal-mode-switch-track ${autonomousModeEnabled ? "on" : ""}`} aria-hidden="true">
                        <span className="goal-mode-switch-thumb" />
                      </span>
                    </span>
                  </button>
                </div>
                <div className="overflow-menu-item" role="none">
                  <button
                    className="goal-mode-toggle goal-mode-toggle-switch-row"
                    onClick={() => setCollaborativeModeSelection(!collaborativeModeEnabled)}
                    role="menuitemcheckbox"
                    aria-checked={collaborativeModeEnabled}
                  >
                    <span className="goal-mode-toggle-switch-content">
                      <span className="goal-mode-toggle-text">
                        <span className="goal-mode-label">Collab</span>
                      </span>
                      <span className={`goal-mode-switch-track ${collaborativeModeEnabled ? "on" : ""}`} aria-hidden="true">
                        <span className="goal-mode-switch-thumb" />
                      </span>
                    </span>
                  </button>
                </div>
                {showMultiLlmOption && (
                  <div className="overflow-menu-item" role="none">
                    <button
                      className="goal-mode-toggle goal-mode-toggle-switch-row"
                      onClick={() => setMultiLlmModeSelection(!multiLlmModeEnabled)}
                      role="menuitemcheckbox"
                      aria-checked={multiLlmModeEnabled}
                    >
                      <span className="goal-mode-toggle-switch-content">
                        <span className="goal-mode-toggle-text">
                          <span className="goal-mode-label">Multi-LLM</span>
                        </span>
                        <span className={`goal-mode-switch-track ${multiLlmModeEnabled ? "on" : ""}`} aria-hidden="true">
                          <span className="goal-mode-switch-thumb" />
                        </span>
                      </span>
                    </button>
                  </div>
                )}
                <div className="overflow-menu-item" role="none">
                  <button
                    className="goal-mode-toggle goal-mode-toggle-switch-row"
                    onClick={() => setChronicleEnabledForTask(!chronicleEnabledForTask)}
                    role="menuitemcheckbox"
                    aria-checked={chronicleEnabledForTask}
                  >
                    <span className="goal-mode-toggle-switch-content">
                      <span className="goal-mode-toggle-text">
                        <span className="goal-mode-label">Chronicle</span>
                      </span>
                      <span className={`goal-mode-switch-track ${chronicleEnabledForTask ? "on" : ""}`} aria-hidden="true">
                        <span className="goal-mode-switch-thumb" />
                      </span>
                    </span>
                  </button>
                </div>
                <div className="overflow-menu-item" role="none">
                  <button
                    className={`goal-mode-toggle overflow-submenu-trigger ${overflowSubmenu === "mode" ? "active" : ""}`}
                    onClick={() => setOverflowSubmenu((c) => (c === "mode" ? null : "mode"))}
                    role="menuitem"
                    aria-haspopup="menu"
                    aria-expanded={overflowSubmenu === "mode"}
                  >
                    <span className="overflow-submenu-trigger-content">
                      <span className="goal-mode-toggle-text">
                        <span className="goal-mode-label">Mode: {EXECUTION_MODE_LABEL[executionMode]}</span>
                      </span>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="overflow-submenu-chevron">
                        <path d="M9 6l6 6-6 6" />
                      </svg>
                    </span>
                  </button>
                </div>
                <div className="overflow-menu-item" role="none">
                  <button
                    className={`goal-mode-toggle overflow-submenu-trigger ${overflowSubmenu === "domain" ? "active" : ""}`}
                    onClick={() => setOverflowSubmenu((c) => (c === "domain" ? null : "domain"))}
                    role="menuitem"
                    aria-haspopup="menu"
                    aria-expanded={overflowSubmenu === "domain"}
                  >
                    <span className="overflow-submenu-trigger-content">
                      <span className="goal-mode-toggle-text">
                        <span className="goal-mode-label">Domain: {TASK_DOMAIN_LABEL[taskDomain]}</span>
                      </span>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="overflow-submenu-chevron">
                        <path d="M9 6l6 6-6 6" />
                      </svg>
                    </span>
                  </button>
                </div>
                {overflowSubmenu && (
                  <div className="overflow-submenu-panel dp-overflow-submenu dp-overflow-dropdown-solid" role="menu">
                    <div className="overflow-submenu-header">
                      <span className="overflow-submenu-title">{overflowSubmenu === "mode" ? "Mode" : "Domain"}</span>
                    </div>
                    {(overflowSubmenu === "mode" ? EXECUTION_MODE_ORDER : TASK_DOMAIN_ORDER).map((value) => {
                      const label = overflowSubmenu === "mode"
                        ? EXECUTION_MODE_LABEL[value as ExecutionMode]
                        : TASK_DOMAIN_LABEL[value as TaskDomain];
                      const selected = overflowSubmenu === "mode" ? executionMode === value : taskDomain === value;
                      return (
                        <button
                          key={value}
                          type="button"
                          className={`overflow-submenu-option ${selected ? "active" : ""}`}
                          onClick={() => {
                            if (overflowSubmenu === "mode") setExecutionMode(value as ExecutionMode);
                            else setTaskDomain(value as TaskDomain);
                            setOverflowSubmenu(null);
                          }}
                          role="menuitemradio"
                          aria-checked={selected}
                        >
                          <span>{label}</span>
                          {selected && (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="check-icon">
                              <path d="M20 6L9 17l-5-5" />
                            </svg>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
          <span className="dp-input-spacer" />
          <button className="dp-input-action-btn" disabled>
            <Mic size={20} />
          </button>
          <button
            type="button"
            className="dp-input-action-btn"
            onClick={() => void handleRunTask()}
            disabled={!activeDevice || submittingTask || !taskPrompt.trim()}
            aria-label="Send task"
            title="Send task"
          >
            <Send size={20} />
          </button>
        </div>
      </div>

      {showRemoteFilePicker &&
        activeDevice?.taskNodeId &&
        remoteFilePickerContext && (
          <RemoteFilePicker
            nodeId={activeDevice.taskNodeId}
            deviceName={remoteFilePickerContext.deviceName}
            workspaces={remoteFilePickerContext.workspaces}
            onSelect={handleRemoteFilesSelected}
            onCancel={() => {
              setShowRemoteFilePicker(false);
              setRemoteFilePickerContext(null);
            }}
          />
        )}

      <div ref={tasksRef} className="dp-section">
        <div className="dp-section-header">
          <span className="dp-section-label">Running Tasks</span>
          <div className="dp-filter-row">
            <button
              className={`dp-filter-chip${taskFilter === "selected" ? " active" : ""}`}
              onClick={() => setTaskFilter("selected")}
            >
              Selected
            </button>
            <button
              className={`dp-filter-chip${taskFilter === "all" ? " active" : ""}`}
              onClick={() => setTaskFilter("all")}
            >
              All devices
            </button>
            <button
              className={`dp-filter-chip${taskFilter === "attention" ? " active" : ""}`}
              onClick={() => setTaskFilter("attention")}
            >
              Needs attention
            </button>
          </div>
        </div>

        {deviceTasks.length > 0 ? (
          <div className="dp-tasks-container expanded">
            <div className="dp-task-feed-meta">Showing {taskCountLabel}</div>
            <div className="dp-tasks-grid">
              {deviceTasks.map((task) => {
                const badge = getTaskBadge(task);
                const taskDevice = resolveTaskDevice(task);
                return (
                  <button
                    key={task.id}
                    className="dp-task-card"
                    onClick={() =>
                      onOpenTask(
                        task.id,
                        taskDevice
                          ? { deviceId: taskDevice.id, deviceName: taskDevice.name }
                          : undefined,
                      )
                    }
                  >
                    <span className="dp-task-title">{task.title || task.prompt}</span>
                    <div className="dp-task-detail-row">
                      <span className="dp-task-device-badge">{taskDevice?.name || "This device"}</span>
                      {isTaskAttention(task) ? (
                        <span className="dp-task-inline-alert">
                          {task.terminalStatus === "awaiting_approval" ? "Approval blocked" : "Waiting for input"}
                        </span>
                      ) : null}
                    </div>
                    <div className="dp-task-meta">
                      <span className={`dp-task-badge ${badge.className}`}>
                        {badge.icon}
                        {badge.label}
                      </span>
                      <span className="dp-task-time">{formatRelativeTime(task.updatedAt)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="dp-placeholder">
            {taskFilter === "attention"
              ? "No tasks need attention right now."
              : activeDevice
                ? "No tasks have been run for this selection yet."
                : "Select a device to view its tasks."}
          </div>
        )}
      </div>

      <div ref={devicesRef} className="dp-section">
        <div className="dp-section-header">
          <span className="dp-section-label">Devices</span>
          <button className="dp-section-link" onClick={() => setOverlay({ type: "pairing" })}>
            Add new device &gt;
          </button>
        </div>
        {remoteDevices.length > 0 ? (
          <div className="dp-devices-list">
            {remoteDevices.map((device) => {
              const summary = summaries[device.id];
              const isActive = device.id === activeDevice?.id;
              const actionBusy = busyActionKey?.endsWith(device.id);
              const attentionLabel = deviceAttentionLabel(device.attentionState);
              return (
                <div
                  key={device.id}
                  className={`dp-device-card${isActive ? " active" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedDeviceId(device.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelectedDeviceId(device.id);
                    }
                  }}
                >
                  <div className="dp-device-icon">
                    {getPlatformVisualIcon(device.platform, "dp-device-svg", undefined, device.name)}
                  </div>
                  <div className="dp-device-content">
                    <div className="dp-device-topline">
                      <div className="dp-device-heading">
                        <span className="dp-device-name">{device.name}</span>
                        <div className="dp-device-chip-row">
                          <span className="dp-purpose-chip subtle">{purposeLabel(device.purpose)}</span>
                          <span className="dp-device-chip">{device.transport}</span>
                          {attentionLabel ? (
                            <span className={`dp-device-chip attention-${device.attentionState}`}>
                              {attentionLabel}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <div className="dp-device-status-wrapper">
                        <span className={`dp-status-dot ${device.status === "connected" || device.role === "local" ? "online" : "off"}`} />
                        <span
                          className={`dp-device-status ${device.status === "connected" || device.role === "local" ? "online" : "off"}`}
                        >
                          {device.role === "local" ? "This device" : deviceConnectionLabel(device)}
                        </span>
                      </div>
                    </div>
                    <div className="dp-device-stats">
                      <div className="dp-device-stat">
                        <strong>{device.activeRunCount || 0}</strong>
                        <span>Active runs</span>
                      </div>
                      <div className="dp-device-stat">
                        <strong>{device.storageSummary?.workspaceCount || 0}</strong>
                        <span>Workspaces</span>
                      </div>
                      <div className="dp-device-stat">
                        <strong>{device.appsSummary?.channelsEnabled || 0}</strong>
                        <span>Apps on</span>
                      </div>
                      <div className="dp-device-stat">
                        <strong>{device.lastSeenAt ? formatRelativeTime(device.lastSeenAt) : "No sync"}</strong>
                        <span>Last seen</span>
                      </div>
                    </div>
                    <div className="dp-device-footer">
                      {summary?.alerts?.length ? (
                        <div className="dp-device-alert-strip">{summary.alerts[0].title}</div>
                      ) : (
                        <div className="dp-device-hint">Select this device to run tasks or inspect activity.</div>
                      )}
                      <div className="dp-device-actions">
                      {device.role === "remote" ? (
                        device.status === "connected" ? (
                          <button
                            type="button"
                            className="dp-ghost-btn"
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleDisconnectDevice(device.id);
                            }}
                            disabled={actionBusy}
                          >
                            <Unplug size={14} />
                            Disconnect
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="dp-ghost-btn"
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleConnectDevice(device.id);
                            }}
                            disabled={actionBusy}
                          >
                            <Plug2 size={14} />
                            Connect
                          </button>
                        )
                      ) : null}
                      <button
                        type="button"
                        className="dp-ghost-btn"
                        onClick={(event) => {
                          event.stopPropagation();
                          setOverlay({ type: "apps", deviceId: device.id });
                        }}
                      >
                        <AppWindow size={14} />
                        Open Apps
                      </button>
                      <button
                        type="button"
                        className="dp-ghost-btn"
                        onClick={(event) => {
                          event.stopPropagation();
                          setOverlay({ type: "storage", deviceId: device.id });
                        }}
                      >
                        <HardDrive size={14} />
                        Storage
                      </button>
                      <button
                        type="button"
                        className="dp-ghost-btn"
                        onClick={(event) => {
                          event.stopPropagation();
                          setOverlay({ type: "details", deviceId: device.id });
                        }}
                      >
                          <Activity size={14} />
                          Details
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="dp-placeholder">
            No managed devices added yet. Use "Add new device &gt;" to save or connect one.
          </div>
        )}
      </div>

      <div className="dp-support-grid">
        <section ref={appsRef} className="dp-support-card">
          <div className="dp-support-header">
            <div>
              <span className="dp-support-eyebrow">Apps &amp; Accounts</span>
              <h3>{activeDevice?.name || "Select a device"}</h3>
            </div>
            <button
              className="dp-section-link"
              disabled={!activeDevice}
              onClick={() => activeDevice && setOverlay({ type: "apps", deviceId: activeDevice.id })}
            >
              Manage &gt;
            </button>
          </div>
          {activeSummary ? (
            <>
              <div className="dp-support-stats">
                <div>
                  <strong>{activeSummary.apps.channelsEnabled}</strong>
                  <span>Enabled apps</span>
                </div>
                <div>
                  <strong>{activeSummary.apps.channelsTotal}</strong>
                  <span>Total apps</span>
                </div>
                <div>
                  <strong>{activeSummary.apps.accounts?.length || 0}</strong>
                  <span>Accounts</span>
                </div>
              </div>
              <div className="dp-support-list">
                {(activeSummary.apps.channels || []).slice(0, 3).map((channel: any) => (
                  <div key={channel.id} className="dp-support-row">
                    <div>
                      <strong>{channel.name}</strong>
                      <span>{channel.type}</span>
                    </div>
                    <span className={`dp-inline-status ${channel.enabled ? "ok" : "muted"}`}>
                      {channel.status || (channel.enabled ? "enabled" : "disabled")}
                    </span>
                  </div>
                ))}
                {(activeSummary.apps.channels || []).length === 0 ? (
                  <div className="dp-placeholder compact">No apps configured for this device yet.</div>
                ) : null}
              </div>
            </>
          ) : (
            <div className="dp-placeholder compact">Load a device summary to inspect its apps.</div>
          )}
        </section>

        <section ref={storageRef} className="dp-support-card">
          <div className="dp-support-header">
            <div>
              <span className="dp-support-eyebrow">Alerts &amp; Updates</span>
              <h3>{activeDevice?.name || "Select a device"}</h3>
            </div>
            <button
              className="dp-section-link"
              disabled={!activeDevice}
              onClick={() => activeDevice && setOverlay({ type: "observer", deviceId: activeDevice.id })}
            >
              Monitor &gt;
            </button>
          </div>
          {activeSummary ? (
            <div className="dp-support-list">
              {activeSummary.alerts.slice(0, 4).map((alert) => (
                <div key={alert.id} className="dp-support-row">
                  <div>
                    <strong>{alert.title}</strong>
                    <span>{alert.description || alert.kind}</span>
                  </div>
                  <span className={`dp-inline-status level-${alert.level}`}>{alert.level}</span>
                </div>
              ))}
              {activeSummary.alerts.length === 0 ? (
                <div className="dp-placeholder compact">No diagnostic issues reported.</div>
              ) : null}
            </div>
          ) : (
            <div className="dp-placeholder compact">Load a device summary to inspect alerts.</div>
          )}
        </section>

        <section ref={alertsRef} className="dp-support-card">
          <div className="dp-support-header">
            <div>
              <span className="dp-support-eyebrow">Storage &amp; Files</span>
              <h3>{activeDevice?.name || "Select a device"}</h3>
            </div>
            <button
              className="dp-section-link"
              disabled={!activeDevice}
              onClick={() => activeDevice && setOverlay({ type: "storage", deviceId: activeDevice.id })}
            >
              Inspect &gt;
            </button>
          </div>
          {activeSummary ? (
            <>
              <div className="dp-support-stats">
                <div>
                  <strong>{activeSummary.storage.workspaceCount}</strong>
                  <span>Workspaces</span>
                </div>
                <div>
                  <strong>{activeSummary.storage.artifactCount}</strong>
                  <span>Artifacts</span>
                </div>
                <div>
                  <strong>{formatBytes(activeSummary.storage.freeBytes)}</strong>
                  <span>Free space</span>
                </div>
              </div>
              <div className="dp-support-list">
                {activeSummary.storage.workspaceRoots.slice(0, 3).map((root) => (
                  <div key={root.id} className="dp-support-row">
                    <div>
                      <strong>{root.name}</strong>
                      <span>{root.path}</span>
                    </div>
                  </div>
                ))}
                {activeSummary.storage.workspaceRoots.length === 0 ? (
                  <div className="dp-placeholder compact">No workspace roots reported yet.</div>
                ) : null}
              </div>
            </>
          ) : (
            <div className="dp-placeholder compact">Load a device summary to inspect storage.</div>
          )}
        </section>

        <section className="dp-support-card">
          <div className="dp-support-header">
            <div>
              <span className="dp-support-eyebrow">Resource Health</span>
              <h3>{activeDevice?.name || "Select a device"}</h3>
            </div>
            <button
              className="dp-section-link"
              disabled={!activeDevice}
              onClick={() => activeDevice && setOverlay({ type: "details", deviceId: activeDevice.id })}
            >
              Hardware &gt;
            </button>
          </div>
          {activeSummary ? (
            <div className="dp-support-stats">
              <div>
                <strong>{(activeSummary.device as any).cpuUsage?.toFixed(0) || 0}%</strong>
                <span>CPU Load</span>
              </div>
              <div>
                <strong>{(activeSummary.device as any).memoryUsage?.toFixed(0) || 0}%</strong>
                <span>Memory</span>
              </div>
              <div>
                <strong>{(activeSummary.device as any).loadAverage?.[0]?.toFixed(1) || 0}</strong>
                <span>Load Avg</span>
              </div>
            </div>
          ) : (
            <div className="dp-placeholder compact">Load a device summary to inspect resources.</div>
          )}
        </section>
      </div>

      <div className="dp-section">
        <div className="dp-section-header">
          <span className="dp-section-label">Dispatch</span>
        </div>
        {dispatchLoading ? (
          <div className="dispatch-loading">Loading…</div>
        ) : (() => {
          const connectedChannels = dispatchChannels.filter((c) => c.status === "connected");
          const hasConnections = connectedChannels.length > 0;
          if (!hasConnections) {
            return (
              <div className="dispatch-onboarding">
                <div className="dispatch-illustration">
                  <svg
                    width="160"
                    height="80"
                    viewBox="0 0 160 80"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <rect x="8" y="20" width="36" height="56" rx="4" />
                    <rect x="116" y="8" width="36" height="64" rx="4" />
                    <path
                      d="M44 48 Q80 24 116 48"
                      stroke="var(--color-error)"
                      strokeWidth="2"
                      strokeDasharray="4 3"
                    />
                  </svg>
                </div>
                <h2 className="dispatch-onboarding-title">{APP_NAME} on the go</h2>
                <p className="dispatch-onboarding-subtitle">
                  Dispatch tasks to {APP_NAME} from WhatsApp, Telegram, Slack, and other messaging apps—in one
                  continuous conversation.
                </p>
                <div className="dispatch-feature-cards">
                  <div className="dispatch-feature-card">
                    <MessageCircle size={20} strokeWidth={2} className="dispatch-feature-icon" />
                    <p>
                      Your messaging apps act like a walkie-talkie that can communicate with {APP_NAME} on your
                      computer.
                    </p>
                  </div>
                  <div className="dispatch-feature-card">
                    <Send size={20} strokeWidth={2} className="dispatch-feature-icon" />
                    <p>
                      Just send {APP_NAME} a message from WhatsApp, Telegram, or Slack, and it will work on tasks
                      using your computer.
                    </p>
                  </div>
                  <div className="dispatch-feature-card">
                    <Clock size={20} strokeWidth={2} className="dispatch-feature-icon" />
                    <p>
                      {APP_NAME} can also run tasks on a schedule or whenever you need them.
                    </p>
                  </div>
                  <div className="dispatch-feature-card">
                    <Monitor size={20} strokeWidth={2} className="dispatch-feature-icon" />
                    <p>
                      Remember to keep your computer awake so {APP_NAME} can keep working.{" "}
                      <button
                        type="button"
                        className="dispatch-link"
                        onClick={() => onOpenSettings?.("system")}
                      >
                        Learn more
                      </button>
                    </p>
                  </div>
                </div>
                <span className="dispatch-section-label">Connect at least one channel to get started</span>
                <div className="dispatch-setup-cards">
                  {DISPATCH_CHANNELS.map(({ type, label, icon: Icon, settingsTab }) => {
                    const ch = dispatchChannels.find((c) => c.type === type);
                    const isConnected = ch?.status === "connected";
                    return (
                      <button
                        key={type}
                        type="button"
                        className="dispatch-setup-card"
                        onClick={() => onOpenSettings?.(settingsTab)}
                      >
                        <Icon size={20} strokeWidth={2} className="dispatch-setup-icon" />
                        <div className="dispatch-setup-card-content">
                          <strong>
                            {isConnected ? `Connected to ${label}` : `Connect to ${label}`}
                          </strong>
                          <span>
                            {isConnected
                              ? "Send tasks from " + label + " anytime"
                              : `Link your ${label} account to dispatch tasks`}
                          </span>
                        </div>
                        {isConnected ? (
                          <span className="dispatch-setup-badge connected">●</span>
                        ) : (
                          <span className="dispatch-setup-badge">+</span>
                        )}
                      </button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  className="dispatch-get-started-btn"
                  onClick={() => onOpenSettings?.("telegram")}
                >
                  Get started
                </button>
                <p className="dispatch-disclaimer">
                  {APP_NAME} will access your desktop (files, apps, and browser) to complete tasks you send from
                  messaging apps. This may have security risks. Only connect devices and accounts that you own and
                  trust.{" "}
                  <button
                    type="button"
                    className="dispatch-link"
                    onClick={() => onOpenSettings?.("system")}
                  >
                    Learn how to use this safely
                  </button>
                </p>
              </div>
            );
          }
          return (
            <div className="dispatch-connected">
              <div className="dispatch-info-card">
                <p>
                  <strong>Dispatch</strong> from your connected apps—seamless task handoff from WhatsApp,
                  Telegram, Slack, and more.
                </p>
              </div>
              <div className="dispatch-settings-list">
                <div className="dispatch-settings-item">
                  <Monitor size={18} strokeWidth={2} />
                  <div>
                    <strong>Keep this computer awake</strong>
                    <span>Prevents sleep while Dispatch is running.</span>
                  </div>
                  <label className="dispatch-toggle">
                    <input type="checkbox" defaultChecked={false} />
                    <span className="dispatch-toggle-slider" />
                  </label>
                </div>
              </div>
              <div className="dp-section">
                <span className="dp-section-label">Outputs</span>
                <div className="dp-placeholder">
                  Files {APP_NAME} shares will appear here.
                </div>
              </div>
            </div>
          );
        })()}
      </div>

      {overlay?.type === "pairing" ? (
        <DeviceConnectionOverlay onClose={() => setOverlay(null)} onRefresh={loadDevices} />
      ) : null}
      {overlay?.type === "details" && summaries[overlay.deviceId] ? (
        <DeviceDetailsDrawer
          summary={summaries[overlay.deviceId]}
          onClose={() => setOverlay(null)}
          onConnect={handleConnectDevice}
          onDisconnect={handleDisconnectDevice}
          onRemove={async (deviceId) => {
            await handleRemoveDevice(deviceId);
            setOverlay(null);
          }}
        />
      ) : null}
      {overlay?.type === "apps" && summaries[overlay.deviceId] ? (
        <AppsManagerModal
          summary={summaries[overlay.deviceId]}
          onClose={() => setOverlay(null)}
          onRefresh={loadDevices}
        />
      ) : null}
      {overlay?.type === "storage" && summaries[overlay.deviceId] ? (
        <StorageModal summary={summaries[overlay.deviceId]} onClose={() => setOverlay(null)} />
      ) : null}
      {overlay?.type === "observer" && summaries[overlay.deviceId] ? (
        <ObserverModal summary={summaries[overlay.deviceId]} onClose={() => setOverlay(null)} />
      ) : null}
    </div>
  );
}

function ModalShell({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="devices-onboarding-overlay" onClick={onClose}>
      <div className="devices-remote-modal" onClick={(event) => event.stopPropagation()}>
        <div className="devices-remote-header">
          <div>
            <h2>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <button className="devices-remote-close" onClick={onClose} aria-label="Close popup">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function DeviceConnectionOverlay({
  onClose,
  onRefresh,
}: {
  onClose: () => void;
  onRefresh: () => Promise<void>;
}) {
  const [remoteDevices, setRemoteDevices] = useState<ManagedDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [isCreatingNewDevice, setIsCreatingNewDevice] = useState(false);
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState("ws://127.0.0.1:18789");
  const [remoteToken, setRemoteToken] = useState("");
  const [remoteDeviceName, setRemoteDeviceName] = useState("CoWork Remote Client");
  const [purpose, setPurpose] = useState<ManagedDevice["purpose"]>("general");
  const [deviceStatus, setDeviceStatus] = useState<Record<string, RemoteGatewayStatus>>({});
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const populateForm = useCallback((device: ManagedDevice) => {
    setIsCreatingNewDevice(false);
    setSelectedDeviceId(device.id);
    setRemoteUrl(device.config?.url || "ws://127.0.0.1:18789");
    setRemoteToken(device.config?.token || "");
    setRemoteDeviceName(device.name || device.config?.deviceName || "CoWork Remote Client");
    setPurpose(device.purpose || "general");
    setTestResult(null);
  }, []);

  const loadRemoteDevices = useCallback(async () => {
    try {
      const [devicesResult, settingsData] = await Promise.all([
        window.electronAPI?.listManagedDevices?.(),
        window.electronAPI?.getControlPlaneSettings?.(),
      ]);
      const managedDevices =
        devicesResult?.ok && Array.isArray(devicesResult.devices)
          ? (devicesResult.devices as ManagedDevice[])
          : [];
      const remotes = reconcileRemoteDeviceNamesFromSettings(
        managedDevices,
        settingsData as ControlPlaneSettingsData | null | undefined,
      ).filter((device) => device.role === "remote");
      setRemoteDevices(remotes);
      setDeviceStatus(
        Object.fromEntries(remotes.map((device) => [device.id, { state: device.status as RemoteGatewayStatus["state"] }])) as Record<string, RemoteGatewayStatus>,
      );
      if (!selectedDeviceId && remotes[0]) {
        populateForm(remotes[0]);
      }
    } catch (error) {
      console.error("Failed to load managed remote devices:", error);
    } finally {
      setLoadingConfig(false);
    }
  }, [populateForm, selectedDeviceId]);

  useEffect(() => {
    void loadRemoteDevices();
  }, [loadRemoteDevices]);

  const buildConfig = useCallback(
    (): RemoteGatewayConfig => ({
      url: remoteUrl.trim(),
      token: remoteToken.trim(),
      deviceName: remoteDeviceName.trim() || "CoWork Remote Client",
      autoReconnect: true,
      reconnectIntervalMs: 5000,
      maxReconnectAttempts: 10,
    }),
    [remoteDeviceName, remoteToken, remoteUrl],
  );

  const buildManagedDevice = useCallback(
    (id: string): ManagedDevice => ({
      id,
      name: remoteDeviceName.trim() || "CoWork Remote Client",
      role: "remote",
      purpose,
      transport: inferTransport(buildConfig()),
      status: deviceStatus[id]?.state || "disconnected",
      platform: "linux",
      taskNodeId: `remote-gateway:${id}`,
      config: buildConfig(),
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
    [buildConfig, deviceStatus, purpose, remoteDeviceName],
  );

  const saveDevice = useCallback(
    async (connectAfterSave: boolean) => {
      setSaving(true);
      setTestResult(null);
      try {
        const settings = (await window.electronAPI?.getControlPlaneSettings?.()) as
          | ControlPlaneSettingsData
          | null;
        const nextId = selectedDeviceId || `remote-device:${Date.now()}`;
        const existingManaged = (settings?.managedDevices || []).filter(
          (device) => device.id !== LOCAL_MANAGED_DEVICE_ID,
        );
        const nextDevice = buildManagedDevice(nextId);
        const nextManagedDevices = upsertManagedRemoteDevice(existingManaged, nextDevice);
        const nextSavedDevices = nextManagedDevices
          .map((device) => toSavedRemoteDevice(device))
          .filter((device): device is SavedRemoteGatewayDevice => !!device);

        await window.electronAPI?.saveControlPlaneSettings?.({
          managedDevices: nextManagedDevices,
          savedRemoteDevices: nextSavedDevices,
          activeManagedDeviceId: nextId,
          activeRemoteDeviceId: nextId,
          remote: nextDevice.config,
        });

        if (connectAfterSave) {
          const result = await window.electronAPI?.connectDevice?.(nextId);
          if (!result?.ok) {
            throw new Error(result?.error || "Unable to connect device");
          }
          await onRefresh();
          onClose();
          return;
        }

        await onRefresh();
        setSelectedDeviceId(nextId);
        setIsCreatingNewDevice(false);
        await loadRemoteDevices();
      } catch (error) {
        console.error("Failed to save remote device:", error);
        setTestResult({
          success: false,
          message: error instanceof Error ? error.message : "Unable to save device",
        });
      } finally {
        setSaving(false);
      }
    },
    [buildManagedDevice, loadRemoteDevices, onClose, onRefresh, selectedDeviceId],
  );

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await window.electronAPI?.testRemoteGatewayConnection?.(buildConfig());
      setTestResult(
        result?.ok
          ? {
              success: true,
              message: "Connection successful",
              latencyMs: result.latencyMs,
            }
          : {
              success: false,
              message: result?.error || "Unable to connect",
            },
      );
    } catch (error) {
      console.error("Failed to test remote gateway connection:", error);
      setTestResult({ success: false, message: "Unable to test connection" });
    } finally {
      setTesting(false);
    }
  };

  return (
    <ModalShell
      title="Add new device"
      subtitle="Pair a remote CoWork OS once, then manage it from here."
      onClose={onClose}
    >
      {loadingConfig ? (
        <div className="devices-remote-loading">
          <RefreshCw size={18} className="dp-spin" />
          <span>Loading saved devices...</span>
        </div>
      ) : (
        <>
          <RemoteDeviceControlVisual />

          {remoteDevices.length > 0 ? (
            <div className="devices-remote-saved">
              <div className="devices-remote-saved-header">
                <h3>Saved devices</h3>
                <button
                  type="button"
                  className="devices-remote-link-btn"
                  onClick={() => {
                    setIsCreatingNewDevice(true);
                    setSelectedDeviceId(null);
                    setRemoteUrl("");
                    setRemoteToken("");
                    setRemoteDeviceName("");
                    setPurpose("general");
                    setTestResult(null);
                  }}
                >
                  New device
                </button>
              </div>
              <div className="devices-remote-card-list">
                {remoteDevices.map((device) => (
                  <button
                    key={device.id}
                    type="button"
                    className={`devices-remote-card${device.id === selectedDeviceId ? " active" : ""}`}
                    onClick={() => populateForm(device)}
                  >
                    <div className="devices-remote-card-top">
                      <strong>{device.name}</strong>
                      <span
                        className={`devices-remote-card-badge ${
                          device.status === "connected" ? "connected" : "saved"
                        }`}
                      >
                        {deviceConnectionLabel(device)}
                      </span>
                    </div>
                    <span>{device.config?.url}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="devices-remote-form-card">
            <div className="devices-remote-saved-header">
              <h3>{selectedDeviceId && !isCreatingNewDevice ? "Device details" : "New device"}</h3>
            </div>

            <div className="devices-remote-field">
              <label htmlFor="devices-remote-name">Device name</label>
              <input
                id="devices-remote-name"
                type="text"
                value={remoteDeviceName}
                onChange={(event) => setRemoteDeviceName(event.target.value)}
                placeholder="Work Mac Mini"
              />
            </div>

            <div className="devices-remote-field">
              <label htmlFor="devices-purpose">Purpose</label>
              <select
                id="devices-purpose"
                value={purpose}
                onChange={(event) => setPurpose(event.target.value as ManagedDevice["purpose"])}
              >
                <option value="general">General</option>
                <option value="work">Work</option>
                <option value="personal">Personal</option>
                <option value="automation">Automation</option>
                <option value="archive">Archive</option>
                <option value="primary">Primary</option>
              </select>
            </div>

            <div className="devices-remote-field">
              <label htmlFor="devices-remote-url">Gateway URL</label>
              <input
                id="devices-remote-url"
                type="text"
                value={remoteUrl}
                onChange={(event) => setRemoteUrl(event.target.value)}
                placeholder="wss://your-remote-host:18789"
              />
            </div>

            <div className="devices-remote-field">
              <label htmlFor="devices-remote-token">Token</label>
              <div className="devices-remote-token-row">
                <input
                  id="devices-remote-token"
                  type={showToken ? "text" : "password"}
                  value={remoteToken}
                  onChange={(event) => setRemoteToken(event.target.value)}
                  placeholder="Remote auth token"
                />
                <button
                  type="button"
                  className="devices-remote-inline-btn"
                  onClick={() => setShowToken((value) => !value)}
                >
                  {showToken ? "Hide" : "Show"}
                </button>
              </div>
            </div>

            {testResult ? (
              <div className={`devices-remote-feedback ${testResult.success ? "success" : "error"}`}>
                {testResult.success
                  ? `Connection successful${testResult.latencyMs ? ` (${testResult.latencyMs}ms)` : ""}`
                  : testResult.message}
              </div>
            ) : null}

            <div className="devices-remote-actions">
              <button
                className="dp-secondary-btn"
                onClick={handleTestConnection}
                disabled={testing || !remoteUrl.trim() || !remoteToken.trim()}
              >
                {testing ? "Testing..." : "Test Connection"}
              </button>
              <button
                className="dp-secondary-btn"
                onClick={() => void saveDevice(false)}
                disabled={saving || !remoteUrl.trim() || !remoteToken.trim()}
              >
                {saving ? "Saving..." : selectedDeviceId ? "Update Device" : "Add Device"}
              </button>
              <button
                className="dp-primary-btn"
                onClick={() => void saveDevice(true)}
                disabled={saving || !remoteUrl.trim() || !remoteToken.trim()}
              >
                {saving ? "Working..." : "Connect Device"}
              </button>
            </div>
          </div>
        </>
      )}
    </ModalShell>
  );
}

function DeviceDetailsDrawer({
  summary,
  onClose,
  onConnect,
  onDisconnect,
  onRemove,
}: {
  summary: ManagedDeviceSummary;
  onClose: () => void;
  onConnect: (deviceId: string) => Promise<void>;
  onDisconnect: (deviceId: string) => Promise<void>;
  onRemove: (deviceId: string) => Promise<void>;
}) {
  const { device } = summary;
  return (
    <div className="dp-drawer-overlay" onClick={onClose}>
      <aside className="dp-drawer" onClick={(event) => event.stopPropagation()}>
        <div className="dp-drawer-header">
          <div>
            <span className="dp-support-eyebrow">Device details</span>
            <h2>{device.name}</h2>
          </div>
          <button className="devices-remote-close" onClick={onClose} aria-label="Close drawer">
            <X size={18} />
          </button>
        </div>

        <div className="dp-drawer-actions">
          {device.role === "remote" ? (
            device.status === "connected" ? (
              <button className="dp-secondary-btn" onClick={() => void onDisconnect(device.id)}>
                <Unplug size={14} />
                Disconnect
              </button>
            ) : (
              <button className="dp-primary-btn" onClick={() => void onConnect(device.id)}>
                <Plug2 size={14} />
                Connect
              </button>
            )
          ) : null}
          {device.role === "remote" ? (
            <button className="dp-secondary-btn danger" onClick={() => void onRemove(device.id)}>
              <Trash2 size={14} />
              Remove device
            </button>
          ) : null}
        </div>

        <div className="dp-detail-grid">
          <DetailBlock icon={<Wifi size={14} />} label="Status" value={deviceConnectionLabel(device)} />
          <DetailBlock icon={<ShieldCheck size={14} />} label="Purpose" value={purposeLabel(device.purpose)} />
          <DetailBlock icon={<Server size={14} />} label="Transport" value={device.transport} />
          <DetailBlock icon={<Activity size={14} />} label="Version" value={device.version || "Unknown"} />
          <DetailBlock icon={<Cpu size={14} />} label="Platform" value={device.platform} />
          <DetailBlock
            icon={<Bell size={14} />}
            label="Last seen"
            value={device.lastSeenAt ? formatRelativeTime(device.lastSeenAt) : "Not yet"}
          />
        </div>

        <div className="dp-drawer-section">
          <h3>Runtime</h3>
          <div className="dp-code-list">
            <code>{summary.runtime?.cwd || "No runtime snapshot yet"}</code>
            <code>{summary.runtime?.userDataDir || "No user data path reported"}</code>
            <code>{`profile:${summary.runtime?.activeProfileId || "default"}`}</code>
            <code>{device.config?.url || "Local device"}</code>
          </div>
        </div>

        <div className="dp-drawer-section">
          <h3>Diagnostics</h3>
          <div className="dp-support-list">
            <div className="dp-support-row">
              <div>
                <strong>{summary.tasks.active}</strong>
                <span>Active runs</span>
              </div>
            </div>
            <div className="dp-support-row">
              <div>
                <strong>{summary.apps.approvalsPending}</strong>
                <span>Approvals pending</span>
              </div>
            </div>
            <div className="dp-support-row">
              <div>
                <strong>{summary.apps.inputRequestsPending}</strong>
                <span>Input requests pending</span>
              </div>
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}

function DetailBlock({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="dp-detail-block">
      <span className="dp-detail-label">
        {icon}
        {label}
      </span>
      <strong>{value}</strong>
    </div>
  );
}

type AppsChannelType = "whatsapp" | "telegram" | "slack" | "teams" | "email";
type SecurityModeOption = "pairing" | "allowlist" | "open";

type ChannelDraftState = {
  name: string;
  securityMode: SecurityModeOption;
  telegramBotToken: string;
  whatsappAllowedNumbers: string;
  whatsappSelfChatMode: boolean;
  whatsappResponsePrefix: string;
  slackBotToken: string;
  slackAppToken: string;
  slackSigningSecret: string;
  teamsAppId: string;
  teamsAppPassword: string;
  teamsTenantId: string;
  teamsWebhookPort: string;
  emailProtocol: "imap-smtp" | "loom";
  emailAddress: string;
  emailPassword: string;
  emailImapHost: string;
  emailImapPort: string;
  emailSmtpHost: string;
  emailSmtpPort: string;
  emailDisplayName: string;
  emailLoomBaseUrl: string;
  emailLoomAccessToken: string;
  emailLoomIdentity: string;
  emailLoomMailboxFolder: string;
};

const EMPTY_CHANNEL_DRAFT: ChannelDraftState = {
  name: "",
  securityMode: "pairing",
  telegramBotToken: "",
  whatsappAllowedNumbers: "",
  whatsappSelfChatMode: true,
  whatsappResponsePrefix: "🤖",
  slackBotToken: "",
  slackAppToken: "",
  slackSigningSecret: "",
  teamsAppId: "",
  teamsAppPassword: "",
  teamsTenantId: "",
  teamsWebhookPort: "3978",
  emailProtocol: "imap-smtp",
  emailAddress: "",
  emailPassword: "",
  emailImapHost: "",
  emailImapPort: "993",
  emailSmtpHost: "",
  emailSmtpPort: "587",
  emailDisplayName: "",
  emailLoomBaseUrl: "",
  emailLoomAccessToken: "",
  emailLoomIdentity: "",
  emailLoomMailboxFolder: "INBOX",
};

function defaultChannelName(type: AppsChannelType): string {
  switch (type) {
    case "whatsapp":
      return "WhatsApp";
    case "telegram":
      return "Telegram";
    case "slack":
      return "Slack Bot";
    case "teams":
      return "Teams Bot";
    case "email":
      return "Email";
  }
}

function buildChannelDraft(type: AppsChannelType): ChannelDraftState {
  return {
    ...EMPTY_CHANNEL_DRAFT,
    name: defaultChannelName(type),
  };
}

function parseListInput(value: string): string[] | undefined {
  const values = value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function toOptionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getChannelSetupHint(type: AppsChannelType, draft: ChannelDraftState): string {
  switch (type) {
    case "whatsapp":
      return "Create the WhatsApp connection here, then finish pairing from the remote device QR flow.";
    case "telegram":
      return "Paste the Telegram bot token from BotFather. The remote device will host the bot.";
    case "slack":
      return "Use the Slack bot token and app-level token from your Slack app. Socket Mode is required.";
    case "teams":
      return "Use your Azure Bot registration credentials. The remote device will run the Teams endpoint.";
    case "email":
      return draft.emailProtocol === "loom"
        ? "Connect a Loom mailbox endpoint on the remote device."
        : "Connect IMAP/SMTP credentials so the remote device can isolate your email session.";
  }
}

function validateChannelDraft(type: AppsChannelType, draft: ChannelDraftState): string | null {
  if (!draft.name.trim()) return "Connection name is required.";
  switch (type) {
    case "telegram":
      return draft.telegramBotToken.trim() ? null : "Telegram bot token is required.";
    case "slack":
      if (!draft.slackBotToken.trim()) return "Slack bot token is required.";
      if (!draft.slackAppToken.trim()) return "Slack app token is required.";
      return null;
    case "teams":
      if (!draft.teamsAppId.trim()) return "Teams app ID is required.";
      if (!draft.teamsAppPassword.trim()) return "Teams app password is required.";
      return null;
    case "email":
      if (draft.emailProtocol === "loom") {
        if (!draft.emailLoomBaseUrl.trim()) return "Loom base URL is required.";
        if (!draft.emailLoomAccessToken.trim()) return "Loom access token is required.";
        return null;
      }
      if (!draft.emailAddress.trim()) return "Email address is required.";
      if (!draft.emailPassword.trim()) return "Email password is required.";
      if (!draft.emailImapHost.trim()) return "IMAP host is required.";
      if (!draft.emailSmtpHost.trim()) return "SMTP host is required.";
      return null;
    case "whatsapp":
    default:
      return null;
  }
}

function buildChannelCreateParams(type: AppsChannelType, draft: ChannelDraftState) {
  const securityConfig = { mode: draft.securityMode };

  switch (type) {
    case "whatsapp":
      return {
        type,
        name: draft.name.trim(),
        enabled: true,
        securityConfig,
        config: {
          allowedNumbers: parseListInput(draft.whatsappAllowedNumbers),
          selfChatMode: draft.whatsappSelfChatMode,
          responsePrefix: draft.whatsappResponsePrefix.trim() || "🤖",
        },
      };
    case "telegram":
      return {
        type,
        name: draft.name.trim(),
        enabled: true,
        securityConfig,
        config: { botToken: draft.telegramBotToken.trim() },
      };
    case "slack":
      return {
        type,
        name: draft.name.trim(),
        enabled: true,
        securityConfig,
        config: {
          botToken: draft.slackBotToken.trim(),
          appToken: draft.slackAppToken.trim(),
          ...(draft.slackSigningSecret.trim()
            ? { signingSecret: draft.slackSigningSecret.trim() }
            : {}),
        },
      };
    case "teams":
      return {
        type,
        name: draft.name.trim(),
        enabled: true,
        securityConfig,
        config: {
          appId: draft.teamsAppId.trim(),
          appPassword: draft.teamsAppPassword.trim(),
          ...(draft.teamsTenantId.trim() ? { tenantId: draft.teamsTenantId.trim() } : {}),
          ...(toOptionalNumber(draft.teamsWebhookPort) !== undefined
            ? { webhookPort: toOptionalNumber(draft.teamsWebhookPort) }
            : {}),
        },
      };
    case "email":
      if (draft.emailProtocol === "loom") {
        return {
          type,
          name: draft.name.trim(),
          enabled: true,
          securityConfig,
          config: {
            protocol: "loom",
            loomBaseUrl: draft.emailLoomBaseUrl.trim(),
            loomAccessToken: draft.emailLoomAccessToken.trim(),
            ...(draft.emailLoomIdentity.trim()
              ? { loomIdentity: draft.emailLoomIdentity.trim() }
              : {}),
            ...(draft.emailLoomMailboxFolder.trim()
              ? { mailbox: draft.emailLoomMailboxFolder.trim() }
              : {}),
            ...(draft.emailDisplayName.trim()
              ? { displayName: draft.emailDisplayName.trim() }
              : {}),
          },
        };
      }
      return {
        type,
        name: draft.name.trim(),
        enabled: true,
        securityConfig,
        config: {
          protocol: "imap-smtp",
          email: draft.emailAddress.trim(),
          password: draft.emailPassword.trim(),
          imapHost: draft.emailImapHost.trim(),
          smtpHost: draft.emailSmtpHost.trim(),
          ...(toOptionalNumber(draft.emailImapPort) !== undefined
            ? { imapPort: toOptionalNumber(draft.emailImapPort) }
            : {}),
          ...(toOptionalNumber(draft.emailSmtpPort) !== undefined
            ? { smtpPort: toOptionalNumber(draft.emailSmtpPort) }
            : {}),
          ...(draft.emailDisplayName.trim()
            ? { displayName: draft.emailDisplayName.trim() }
            : {}),
        },
      };
  }
}

function AppsManagerModal({
  summary,
  onClose,
  onRefresh,
}: {
  summary: ManagedDeviceSummary;
  onClose: () => void;
  onRefresh: () => Promise<void>;
}) {
  const { device } = summary;
  const [channels, setChannels] = useState<any[]>(summary.apps.channels || []);
  const [accounts, setAccounts] = useState<any[]>(summary.apps.accounts || []);
  const [loading, setLoading] = useState(false);
  const [workingKey, setWorkingKey] = useState<string | null>(null);
  const [newChannelType, setNewChannelType] = useState<AppsChannelType>("whatsapp");
  const [draft, setDraft] = useState<ChannelDraftState>(() => buildChannelDraft("whatsapp"));
  const [formError, setFormError] = useState<string | null>(null);

  const loadApps = useCallback(async () => {
    setLoading(true);
    try {
      const [channelsResult, accountsResult] = await Promise.all([
        window.electronAPI?.deviceProxyRequest?.({
          deviceId: device.id,
          method: "channel.list",
        }),
        window.electronAPI?.deviceProxyRequest?.({
          deviceId: device.id,
          method: "account.list",
          params: { includeSecrets: false },
        }),
      ]);
      if (channelsResult?.ok) {
        const payload = channelsResult.payload as { channels?: any[] } | undefined;
        setChannels(Array.isArray(payload?.channels) ? payload.channels : []);
      }
      if (accountsResult?.ok) {
        const payload = accountsResult.payload as { accounts?: any[] } | undefined;
        setAccounts(Array.isArray(payload?.accounts) ? payload.accounts : []);
      }
    } catch (error) {
      console.error(`Failed to load apps for ${device.id}:`, error);
    } finally {
      setLoading(false);
    }
  }, [device.id]);

  useEffect(() => {
    void loadApps();
  }, [loadApps]);

  const runChannelAction = useCallback(
    async (channelId: string, method: string, params?: unknown) => {
      setWorkingKey(`${method}:${channelId}`);
      try {
        await window.electronAPI?.deviceProxyRequest?.({
          deviceId: device.id,
          method,
          params: params || { channelId },
        });
        await loadApps();
        await onRefresh();
      } catch (error) {
        console.error(`Failed to run ${method} on ${channelId}:`, error);
      } finally {
        setWorkingKey(null);
      }
    },
    [device.id, loadApps, onRefresh],
  );

  const handleAddChannel = async () => {
    const validationError = validateChannelDraft(newChannelType, draft);
    if (validationError) {
      setFormError(validationError);
      return;
    }
    setWorkingKey("channel:create");
    setFormError(null);
    try {
      await window.electronAPI?.deviceProxyRequest?.({
        deviceId: device.id,
        method: "channel.create",
        params: buildChannelCreateParams(newChannelType, draft),
      });
      setDraft(buildChannelDraft(newChannelType));
      await loadApps();
      await onRefresh();
    } catch (error) {
      console.error("Failed to add channel:", error);
      setFormError(error instanceof Error ? error.message : "Failed to add connection.");
    } finally {
      setWorkingKey(null);
    }
  };

  return (
    <ModalShell
      title={`${device.name} apps`}
      subtitle="Manage channels, connectors, and linked accounts without leaving Devices."
      onClose={onClose}
    >
      <div className="dp-modal-section">
        <div className="devices-remote-saved-header">
          <h3>Connections</h3>
          <button className="devices-remote-link-btn" onClick={() => void loadApps()}>
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        <div className="dp-channel-builder">
          <div className="dp-inline-form dp-channel-builder-top">
            <select
              value={newChannelType}
              onChange={(event) => {
                const nextType = event.target.value as AppsChannelType;
                setNewChannelType(nextType);
                setDraft(buildChannelDraft(nextType));
                setFormError(null);
              }}
            >
              <option value="whatsapp">WhatsApp</option>
              <option value="telegram">Telegram</option>
              <option value="slack">Slack</option>
              <option value="teams">Teams</option>
              <option value="email">Email</option>
            </select>
            <input
              type="text"
              value={draft.name}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
              placeholder="Connection name"
            />
            <select
              value={draft.securityMode}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  securityMode: event.target.value as SecurityModeOption,
                }))
              }
            >
              <option value="pairing">Pairing mode</option>
              <option value="allowlist">Allowlist</option>
              <option value="open">Open</option>
            </select>
          </div>

          <p className="dp-channel-builder-hint">{getChannelSetupHint(newChannelType, draft)}</p>

          {newChannelType === "whatsapp" ? (
            <div className="dp-channel-fields">
              <label className="devices-remote-field">
                <span>Allowed numbers</span>
                <textarea
                  value={draft.whatsappAllowedNumbers}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      whatsappAllowedNumbers: event.target.value,
                    }))
                  }
                  placeholder="+15551234567, +905551112233"
                  rows={3}
                />
              </label>
              <label className="devices-remote-field">
                <span>Response prefix</span>
                <input
                  type="text"
                  value={draft.whatsappResponsePrefix}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      whatsappResponsePrefix: event.target.value,
                    }))
                  }
                  placeholder="🤖"
                />
              </label>
              <label className="dp-checkbox-row">
                <input
                  type="checkbox"
                  checked={draft.whatsappSelfChatMode}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      whatsappSelfChatMode: event.target.checked,
                    }))
                  }
                />
                <span>Enable self-chat mode</span>
              </label>
            </div>
          ) : null}

          {newChannelType === "telegram" ? (
            <div className="dp-channel-fields">
              <label className="devices-remote-field">
                <span>Bot token</span>
                <input
                  type="password"
                  value={draft.telegramBotToken}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      telegramBotToken: event.target.value,
                    }))
                  }
                  placeholder="123456:ABC..."
                />
              </label>
            </div>
          ) : null}

          {newChannelType === "slack" ? (
            <div className="dp-channel-fields">
              <label className="devices-remote-field">
                <span>Bot token</span>
                <input
                  type="password"
                  value={draft.slackBotToken}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, slackBotToken: event.target.value }))
                  }
                  placeholder="xoxb-..."
                />
              </label>
              <label className="devices-remote-field">
                <span>App token</span>
                <input
                  type="password"
                  value={draft.slackAppToken}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, slackAppToken: event.target.value }))
                  }
                  placeholder="xapp-..."
                />
              </label>
              <label className="devices-remote-field">
                <span>Signing secret</span>
                <input
                  type="password"
                  value={draft.slackSigningSecret}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      slackSigningSecret: event.target.value,
                    }))
                  }
                  placeholder="Optional"
                />
              </label>
            </div>
          ) : null}

          {newChannelType === "teams" ? (
            <div className="dp-channel-fields">
              <label className="devices-remote-field">
                <span>App ID</span>
                <input
                  type="text"
                  value={draft.teamsAppId}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, teamsAppId: event.target.value }))
                  }
                  placeholder="Microsoft app ID"
                />
              </label>
              <label className="devices-remote-field">
                <span>App password</span>
                <input
                  type="password"
                  value={draft.teamsAppPassword}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      teamsAppPassword: event.target.value,
                    }))
                  }
                  placeholder="Microsoft app password"
                />
              </label>
              <label className="devices-remote-field">
                <span>Tenant ID</span>
                <input
                  type="text"
                  value={draft.teamsTenantId}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, teamsTenantId: event.target.value }))
                  }
                  placeholder="Optional"
                />
              </label>
              <label className="devices-remote-field">
                <span>Webhook port</span>
                <input
                  type="text"
                  value={draft.teamsWebhookPort}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, teamsWebhookPort: event.target.value }))
                  }
                  placeholder="3978"
                />
              </label>
            </div>
          ) : null}

          {newChannelType === "email" ? (
            <div className="dp-channel-fields">
              <label className="devices-remote-field">
                <span>Protocol</span>
                <select
                  value={draft.emailProtocol}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      emailProtocol: event.target.value as "imap-smtp" | "loom",
                    }))
                  }
                >
                  <option value="imap-smtp">IMAP / SMTP</option>
                  <option value="loom">Loom</option>
                </select>
              </label>
              <label className="devices-remote-field">
                <span>Display name</span>
                <input
                  type="text"
                  value={draft.emailDisplayName}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, emailDisplayName: event.target.value }))
                  }
                  placeholder="Optional"
                />
              </label>

              {draft.emailProtocol === "imap-smtp" ? (
                <>
                  <label className="devices-remote-field">
                    <span>Email address</span>
                    <input
                      type="text"
                      value={draft.emailAddress}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, emailAddress: event.target.value }))
                      }
                      placeholder="bot@example.com"
                    />
                  </label>
                  <label className="devices-remote-field">
                    <span>Password</span>
                    <input
                      type="password"
                      value={draft.emailPassword}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, emailPassword: event.target.value }))
                      }
                      placeholder="App password"
                    />
                  </label>
                  <label className="devices-remote-field">
                    <span>IMAP host</span>
                    <input
                      type="text"
                      value={draft.emailImapHost}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, emailImapHost: event.target.value }))
                      }
                      placeholder="imap.gmail.com"
                    />
                  </label>
                  <label className="devices-remote-field">
                    <span>IMAP port</span>
                    <input
                      type="text"
                      value={draft.emailImapPort}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, emailImapPort: event.target.value }))
                      }
                      placeholder="993"
                    />
                  </label>
                  <label className="devices-remote-field">
                    <span>SMTP host</span>
                    <input
                      type="text"
                      value={draft.emailSmtpHost}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, emailSmtpHost: event.target.value }))
                      }
                      placeholder="smtp.gmail.com"
                    />
                  </label>
                  <label className="devices-remote-field">
                    <span>SMTP port</span>
                    <input
                      type="text"
                      value={draft.emailSmtpPort}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, emailSmtpPort: event.target.value }))
                      }
                      placeholder="587"
                    />
                  </label>
                </>
              ) : (
                <>
                  <label className="devices-remote-field">
                    <span>Loom base URL</span>
                    <input
                      type="text"
                      value={draft.emailLoomBaseUrl}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          emailLoomBaseUrl: event.target.value,
                        }))
                      }
                      placeholder="https://loom.example.com"
                    />
                  </label>
                  <label className="devices-remote-field">
                    <span>Loom access token</span>
                    <input
                      type="password"
                      value={draft.emailLoomAccessToken}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          emailLoomAccessToken: event.target.value,
                        }))
                      }
                      placeholder="Access token"
                    />
                  </label>
                  <label className="devices-remote-field">
                    <span>Loom identity</span>
                    <input
                      type="text"
                      value={draft.emailLoomIdentity}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          emailLoomIdentity: event.target.value,
                        }))
                      }
                      placeholder="Optional"
                    />
                  </label>
                  <label className="devices-remote-field">
                    <span>Mailbox folder</span>
                    <input
                      type="text"
                      value={draft.emailLoomMailboxFolder}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          emailLoomMailboxFolder: event.target.value,
                        }))
                      }
                      placeholder="INBOX"
                    />
                  </label>
                </>
              )}
            </div>
          ) : null}

          {formError ? <div className="devices-remote-feedback error">{formError}</div> : null}

          <div className="devices-remote-actions">
            <button
              className="dp-primary-btn"
              onClick={() => void handleAddChannel()}
              disabled={workingKey === "channel:create"}
            >
              {workingKey === "channel:create" ? "Adding..." : "Add connection"}
            </button>
          </div>
        </div>

        <div className="dp-support-list">
          {channels.map((channel) => (
            <div key={channel.id} className="dp-channel-row">
              <div>
                <strong>{channel.name}</strong>
                <span>
                  {channel.type} • {channel.status || "unknown"}
                </span>
              </div>
              <div className="dp-channel-actions">
                <button
                  className="dp-ghost-btn"
                  onClick={() =>
                    void runChannelAction(
                      channel.id,
                      channel.enabled ? "channel.disable" : "channel.enable",
                    )
                  }
                  disabled={workingKey === `channel.enable:${channel.id}` || workingKey === `channel.disable:${channel.id}`}
                >
                  {channel.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  className="dp-ghost-btn"
                  onClick={() => void runChannelAction(channel.id, "channel.test")}
                  disabled={workingKey === `channel.test:${channel.id}`}
                >
                  Test
                </button>
                <button
                  className="dp-ghost-btn danger"
                  onClick={() => void runChannelAction(channel.id, "channel.remove")}
                  disabled={workingKey === `channel.remove:${channel.id}`}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
          {channels.length === 0 ? (
            <div className="dp-placeholder compact">No connections configured yet.</div>
          ) : null}
        </div>
      </div>

      <div className="dp-modal-section">
        <h3>Accounts</h3>
        <div className="dp-support-list">
          {accounts.map((account) => (
            <div key={account.id} className="dp-support-row">
              <div>
                <strong>{account.label || account.provider}</strong>
                <span>{account.provider}</span>
              </div>
              <span className={`dp-inline-status ${account.status === "active" ? "ok" : "muted"}`}>
                {account.status || "draft"}
              </span>
            </div>
          ))}
          {accounts.length === 0 ? (
            <div className="dp-placeholder compact">No managed accounts linked to this device.</div>
          ) : null}
        </div>
      </div>
    </ModalShell>
  );
}

function StorageModal({
  summary,
  onClose,
}: {
  summary: ManagedDeviceSummary;
  onClose: () => void;
}) {
  return (
    <ModalShell
      title={`${summary.device.name} storage`}
      subtitle="Workspace roots, artifact volume, and safe storage indicators."
      onClose={onClose}
    >
      <div className="dp-support-stats">
        <div>
          <strong>{summary.storage.workspaceCount}</strong>
          <span>Workspace roots</span>
        </div>
        <div>
          <strong>{summary.storage.artifactCount}</strong>
          <span>Artifacts</span>
        </div>
        <div>
          <strong>{formatBytes(summary.storage.freeBytes)}</strong>
          <span>Free disk</span>
        </div>
      </div>
      <div className="dp-support-list">
        {summary.storage.workspaceRoots.map((root) => (
          <div key={root.id} className="dp-support-row">
            <div>
              <strong>{root.name}</strong>
              <span>{root.path}</span>
            </div>
          </div>
        ))}
        {summary.storage.workspaceRoots.length === 0 ? (
          <div className="dp-placeholder compact">No workspace roots reported yet.</div>
        ) : null}
      </div>
    </ModalShell>
  );
}

function ObserverModal({
  summary,
  onClose,
}: {
  summary: ManagedDeviceSummary;
  onClose: () => void;
}) {
  return (
    <ModalShell
      title={`${summary.device.name} observer`}
      subtitle="Alerts, approvals, and connection events for the selected device."
      onClose={onClose}
    >
      <div className="dp-modal-section">
        <h3>Alerts</h3>
        <div className="dp-support-list">
          {summary.alerts.map((alert) => (
            <div key={alert.id} className="dp-support-row">
              <div>
                <strong>{alert.title}</strong>
                <span>{alert.description || alert.kind}</span>
              </div>
              <span className={`dp-inline-status level-${alert.level}`}>{alert.level}</span>
            </div>
          ))}
          {summary.alerts.length === 0 ? (
            <div className="dp-placeholder compact">No active alerts.</div>
          ) : null}
        </div>
      </div>
      <div className="dp-modal-section">
        <h3>Observer feed</h3>
        <div className="dp-observer-list">
          {summary.observer.map((entry) => (
            <div key={entry.id} className="dp-observer-row">
              <div className={`dp-observer-dot level-${entry.level}`} />
              <div>
                <strong>{entry.title}</strong>
                <span>
                  {entry.detail || "No additional detail"} • {formatRelativeTime(entry.timestamp)}
                </span>
              </div>
            </div>
          ))}
          {summary.observer.length === 0 ? (
            <div className="dp-placeholder compact">No observer events recorded yet.</div>
          ) : null}
        </div>
      </div>
    </ModalShell>
  );
}
