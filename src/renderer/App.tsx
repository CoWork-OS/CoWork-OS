import { useState, useEffect, useRef, useMemo } from "react";
import { Sidebar } from "./components/Sidebar";
import { MainContent } from "./components/MainContent";
import { RightPanel } from "./components/RightPanel";
import { Settings } from "./components/Settings";
import { DisclaimerModal } from "./components/DisclaimerModal";
import { Onboarding } from "./components/Onboarding";
import { BrowserView } from "./components/BrowserView";
// TaskQueuePanel moved to RightPanel
import { ToastContainer } from "./components/Toast";
import { QuickTaskFAB } from "./components/QuickTaskFAB";
import { NotificationPanel } from "./components/NotificationPanel";
import {
  Task,
  Workspace,
  TaskEvent,
  LLMModelInfo,
  LLMProviderInfo,
  UpdateInfo,
  ThemeMode,
  VisualTheme,
  AccentColor,
  UiDensity,
  QueueStatus,
  ToastNotification,
  ApprovalRequest,
  isTempWorkspaceId,
  ImageAttachment,
  MultiLlmConfig,
} from "../shared/types";
import { TASK_EVENT_STATUS_MAP } from "../shared/task-event-status-map";
import { applyPersistedLanguage } from "./i18n";

// Helper to get effective theme based on system preference
function getEffectiveTheme(themeMode: ThemeMode): "light" | "dark" {
  if (themeMode === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return themeMode;
}

type AppView = "main" | "settings" | "browser";
const MAX_RENDERER_TASK_EVENTS = 600;
const APPROVAL_TOAST_PREFIX = "approval-request-";
const APPROVAL_WARNING_TOAST_ID = "approval-auto-approve-warning";

function capTaskEvents(events: TaskEvent[]): TaskEvent[] {
  if (events.length <= MAX_RENDERER_TASK_EVENTS) return events;
  return events.slice(-MAX_RENDERER_TASK_EVENTS);
}

function getApprovalToastId(approvalId: string): string {
  return `${APPROVAL_TOAST_PREFIX}${approvalId}`;
}

function extractApprovalId(event: TaskEvent): string | null {
  const direct = event.payload?.approvalId;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const nested = event.payload?.approval?.id;
  if (typeof nested === "string" && nested.length > 0) return nested;
  return null;
}

export function App() {
  const [currentWorkspace, setCurrentWorkspace] = useState<Workspace | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [currentView, setCurrentView] = useState<AppView>("main");
  const [browserUrl, setBrowserUrl] = useState<string>("");
  const [settingsTab, setSettingsTab] = useState<
    | "appearance"
    | "llm"
    | "search"
    | "telegram"
    | "slack"
    | "whatsapp"
    | "teams"
    | "x"
    | "morechannels"
    | "integrations"
    | "updates"
    | "guardrails"
    | "queue"
    | "skills"
    | "scheduled"
    | "voice"
    | "missioncontrol"
    | "mcp"
  >("appearance");
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [childEvents, setChildEvents] = useState<TaskEvent[]>([]);

  // Child tasks dispatched from the selected parent task (for DispatchedAgentsPanel)
  const childTasks = useMemo(() => {
    if (!selectedTaskId) return [];
    return tasks.filter((t) => t.parentTaskId === selectedTaskId && t.agentType === "sub");
  }, [tasks, selectedTaskId]);

  const childTaskIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    childTaskIdsRef.current = new Set(childTasks.map((t) => t.id));
  }, [childTasks]);

  // Model selection state
  const [selectedModel, setSelectedModel] = useState<string>("opus-4-5");
  const [availableModels, setAvailableModels] = useState<LLMModelInfo[]>([]);
  const [availableProviders, setAvailableProviders] = useState<LLMProviderInfo[]>([]);

  // Update notification state
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);

  // Theme state (loaded from main process on mount)
  const [themeMode, setThemeMode] = useState<ThemeMode>("dark");
  const [visualTheme, setVisualTheme] = useState<VisualTheme>("warm");
  const [accentColor, setAccentColor] = useState<AccentColor>("cyan");
  const [uiDensity, setUiDensity] = useState<UiDensity>("focused");

  // Queue state
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);
  const [toasts, setToasts] = useState<ToastNotification[]>([]);
  const [sessionAutoApproveAll, setSessionAutoApproveAll] = useState(false);

  // Sidebar collapse state
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(false);
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = useState(false);

  // Ref to track current tasks for use in event handlers (avoids stale closure)
  const tasksRef = useRef<Task[]>([]);
  const sessionAutoApproveAllRef = useRef(false);
  const pendingApprovalsRef = useRef<Map<string, ApprovalRequest>>(new Map());

  // Disclaimer state (null = loading)
  const [disclaimerAccepted, setDisclaimerAccepted] = useState<boolean | null>(null);
  // Onboarding state (null = loading)
  const [onboardingCompleted, setOnboardingCompleted] = useState<boolean | null>(null);
  // Timestamp of when onboarding was completed
  const [onboardingCompletedAt, setOnboardingCompletedAt] = useState<string | undefined>(undefined);
  const hasElectronAPI = typeof window !== "undefined" && !!window.electronAPI;

  const handleDisclaimerAccept = (dontShowAgain: boolean) => {
    // Save to main process for persistence
    window.electronAPI
      ?.saveAppearanceSettings?.({ disclaimerAccepted: dontShowAgain })
      ?.catch((error) => {
        console.error("Failed to save disclaimer setting:", error);
      });
    setDisclaimerAccepted(true);
  };

  const handleOnboardingComplete = (dontShowAgain: boolean) => {
    const timestamp = new Date().toISOString();
    // Save to main process for persistence
    // If dontShowAgain is true, mark as completed with timestamp
    // If false, just save the timestamp but don't mark as completed (user can see it again next time)
    window.electronAPI
      ?.saveAppearanceSettings?.({
        onboardingCompleted: dontShowAgain,
        onboardingCompletedAt: timestamp,
      })
      ?.catch((error) => {
        console.error("Failed to save onboarding state:", error);
      });
    setOnboardingCompleted(true); // Always allow proceeding to main app
    setOnboardingCompletedAt(timestamp);

    // Sync any onboarding-time appearance changes (e.g. light/dark toggle)
    window.electronAPI
      ?.getAppearanceSettings?.()
      .then((settings) => {
        if (!settings) return;
        setThemeMode(settings.themeMode);
        setVisualTheme(settings.visualTheme || "warm");
        setAccentColor(settings.accentColor);
      })
      .catch((error) => {
        console.error("Failed to refresh appearance settings after onboarding:", error);
      });

    // Refresh LLM config after onboarding (user may have configured a provider)
    loadLLMConfig();
  };

  const handleOpenBrowserView = (url?: string) => {
    setBrowserUrl(url || "");
    setCurrentView("browser");
  };

  const handleShowOnboarding = () => {
    // Reset onboarding state to show the wizard again
    setOnboardingCompleted(false);
    // Close settings view if open
    setCurrentView("main");
  };

  // Load LLM config status
  const loadLLMConfig = async () => {
    if (!window.electronAPI?.getLLMConfigStatus) return;
    try {
      const config = await window.electronAPI.getLLMConfigStatus();
      if (!config) return;
      setSelectedModel(config.currentModel);
      setAvailableModels(config.models);
      setAvailableProviders(config.providers);
    } catch (error) {
      console.error("Failed to load LLM config:", error);
    }
  };

  // Load LLM config on mount
  useEffect(() => {
    loadLLMConfig();
  }, []);

  useEffect(() => {
    const handler = () => {
      setSettingsTab("llm");
      setCurrentView("settings");
    };
    window.addEventListener("open-settings", handler as EventListener);
    return () => window.removeEventListener("open-settings", handler as EventListener);
  }, []);

  // Load appearance settings on mount
  useEffect(() => {
    const loadAppearanceSettings = async () => {
      if (!window.electronAPI?.getAppearanceSettings) {
        setDisclaimerAccepted(true);
        setOnboardingCompleted(true);
        setOnboardingCompletedAt(undefined);
        return;
      }
      try {
        const settings = await window.electronAPI.getAppearanceSettings();
        if (!settings) {
          setDisclaimerAccepted(true);
          setOnboardingCompleted(true);
          setOnboardingCompletedAt(undefined);
          return;
        }
        setThemeMode(settings.themeMode);
        setVisualTheme(settings.visualTheme || "warm");
        setAccentColor(settings.accentColor);
        setUiDensity(settings.uiDensity || "focused");
        applyPersistedLanguage(settings.language);
        setDisclaimerAccepted(settings.disclaimerAccepted ?? false);
        setOnboardingCompleted(settings.onboardingCompleted ?? false);
        setOnboardingCompletedAt(settings.onboardingCompletedAt);
      } catch (error) {
        console.error("Failed to load appearance settings:", error);
        setDisclaimerAccepted(false);
        setOnboardingCompleted(false);
        setOnboardingCompletedAt(undefined);
      }
    };
    loadAppearanceSettings();
  }, []);

  // Check for migration status and show one-time notification if needed
  // This handles the case where the app was renamed from cowork-oss to cowork-os
  // and encrypted credentials (API keys) need to be re-entered
  const migrationCheckDone = useRef(false);
  useEffect(() => {
    if (!window.electronAPI?.getMigrationStatus) return;

    // Prevent double execution in React StrictMode
    if (migrationCheckDone.current) return;
    migrationCheckDone.current = true;

    const checkMigrationStatus = async () => {
      try {
        const status = await window.electronAPI.getMigrationStatus();

        // If migration happened but notification hasn't been dismissed, show info toast
        if (status.migrated && !status.notificationDismissed) {
          const id = `migration-notice-${Date.now()}`;
          const toast: ToastNotification = {
            id,
            type: "info",
            title: "Welcome to CoWork OS",
            message:
              "Your data was migrated successfully. Due to macOS security, API keys need to be re-entered.",
            action: {
              label: "Open Settings",
              callback: () => {
                setCurrentView("settings");
                setSettingsTab("llm");
              },
            },
          };
          setToasts((prev) => [...prev, toast]);

          // Longer auto-dismiss for this important notification (30 seconds)
          setTimeout(() => {
            setToasts((prev) => prev.filter((t) => t.id !== id));
          }, 30000);

          // Mark notification as dismissed so it only shows once
          await window.electronAPI.dismissMigrationNotification?.();
        }
      } catch (error) {
        console.error("Failed to check migration status:", error);
      }
    };
    checkMigrationStatus();
  }, []);

  // Load queue status and subscribe to updates
  useEffect(() => {
    if (!window.electronAPI?.getQueueStatus || !window.electronAPI?.onQueueUpdate) return;

    const loadQueueStatus = async () => {
      try {
        const status = await window.electronAPI.getQueueStatus();
        setQueueStatus(status);
      } catch (error) {
        console.error("Failed to load queue status:", error);
      }
    };

    loadQueueStatus();

    const unsubscribe = window.electronAPI.onQueueUpdate((status) => {
      setQueueStatus(status);
    });

    return typeof unsubscribe === "function" ? unsubscribe : undefined;
  }, []);

  // Check for updates on mount
  useEffect(() => {
    if (!window.electronAPI?.checkForUpdates) return;

    const checkUpdates = async () => {
      try {
        const info = await window.electronAPI.checkForUpdates();
        if (info.available) {
          setUpdateInfo(info);
        }
      } catch (error) {
        // Silently ignore update check failures
        console.log("Update check skipped:", error);
      }
    };
    // Delay check to not block app startup
    const timeoutId = setTimeout(checkUpdates, 3000);
    return () => clearTimeout(timeoutId);
  }, []);

  // Apply theme classes to root element
  useEffect(() => {
    const root = document.documentElement;
    const effectiveTheme = getEffectiveTheme(themeMode);

    // Remove existing theme classes
    root.classList.remove("theme-light", "theme-dark");

    // Apply theme mode class
    if (effectiveTheme === "light") {
      root.classList.add("theme-light");
    }
    // dark is default, no class needed unless specified otherwise by visual styles

    // Remove existing visual theme classes
    root.classList.remove("visual-terminal", "visual-warm", "visual-oblivion");
    const resolvedVisualTheme = visualTheme === "warm" ? "oblivion" : visualTheme;
    root.classList.add(`visual-${resolvedVisualTheme}`);

    // Remove existing accent classes
    root.classList.remove(
      "accent-cyan",
      "accent-blue",
      "accent-purple",
      "accent-pink",
      "accent-rose",
      "accent-orange",
      "accent-green",
      "accent-teal",
      "accent-coral",
    );

    // Apply accent class
    root.classList.add(`accent-${accentColor}`);

    // Apply density class
    root.classList.remove("density-focused", "density-full");
    root.classList.add(`density-${uiDensity}`);

    // Cache density in localStorage for instant restore on next startup
    try {
      localStorage.setItem("uiDensity", uiDensity);
    } catch (_) {
      /* ignore */
    }
  }, [themeMode, visualTheme, accentColor, uiDensity]);

  // Listen for system theme changes when in 'system' mode
  useEffect(() => {
    if (themeMode !== "system") return;

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      const root = document.documentElement;
      root.classList.remove("theme-light", "theme-dark");
      if (!mediaQuery.matches) {
        root.classList.add("theme-light");
      }
    };

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [themeMode]);

  useEffect(() => {
    console.log("App mounted");
    console.log("window.electronAPI available:", !!window.electronAPI);
    if (window.electronAPI) {
      console.log("electronAPI methods:", Object.keys(window.electronAPI));
    }
  }, []);

  // Auto-load temp workspace on mount if no workspace is selected
  useEffect(() => {
    if (!window.electronAPI?.getTempWorkspace) return;

    const initWorkspace = async () => {
      if (!currentWorkspace) {
        try {
          const tempWorkspace = await window.electronAPI.getTempWorkspace({ createNew: true });
          setCurrentWorkspace(tempWorkspace);
        } catch (error) {
          console.error("Failed to initialize temp workspace:", error);
        }
      }
    };
    initWorkspace();
  }, []);

  // Load tasks when workspace is set
  useEffect(() => {
    if (currentWorkspace) {
      loadTasks();
    }
  }, [currentWorkspace]);

  // Sync current workspace to the selected task's workspace
  useEffect(() => {
    if (!window.electronAPI?.selectWorkspace || !window.electronAPI?.getTempWorkspace) return;
    if (!selectedTaskId) return;
    const task = tasks.find((t) => t.id === selectedTaskId);
    if (!task) return;
    if (currentWorkspace?.id === task.workspaceId) return;

    let cancelled = false;

    const loadTaskWorkspace = async () => {
      try {
        let resolved: Workspace | null = await window.electronAPI.selectWorkspace(task.workspaceId);
        if (!resolved && isTempWorkspaceId(task.workspaceId)) {
          resolved = await window.electronAPI.getTempWorkspace();
        }
        if (!cancelled && resolved) {
          setCurrentWorkspace(resolved);
        }
      } catch (error) {
        console.error("Failed to load task workspace:", error);
      }
    };

    void loadTaskWorkspace();
    return () => {
      cancelled = true;
    };
  }, [selectedTaskId, tasks, currentWorkspace?.id]);

  // Track recency when the active workspace changes
  useEffect(() => {
    if (!window.electronAPI?.touchWorkspace) return;
    if (!currentWorkspace || currentWorkspace.isTemp || isTempWorkspaceId(currentWorkspace.id))
      return;
    window.electronAPI.touchWorkspace(currentWorkspace.id).catch((error: unknown) => {
      console.error("Failed to update workspace recency:", error);
    });
  }, [currentWorkspace?.id]);

  useEffect(() => {
    sessionAutoApproveAllRef.current = sessionAutoApproveAll;
  }, [sessionAutoApproveAll]);

  // Toast helper functions
  const addToast = (toast: Omit<ToastNotification, "id"> & { id?: string }) => {
    const id = toast.id || `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newToast: ToastNotification = { ...toast, id };
    setToasts((prev) => (prev.some((t) => t.id === id) ? prev : [...prev, newToast]));

    const durationMs = toast.persistent ? null : (toast.durationMs ?? 5000);
    if (durationMs !== null && durationMs > 0) {
      setTimeout(() => dismissToast(id), durationMs);
    }

    return id;
  };

  const dismissToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  const handleApprovalResponse = async (approvalId: string, approved: boolean) => {
    let handled = false;
    try {
      await window.electronAPI.respondToApproval({
        approvalId,
        approved,
      });
      handled = true;
    } catch (error) {
      console.error("Failed to respond to approval:", error);
      addToast({
        type: "error",
        title: "Approval action failed",
        message: "Could not send your approval decision. Please try again.",
      });
    }

    if (handled) {
      pendingApprovalsRef.current.delete(approvalId);
      dismissToast(getApprovalToastId(approvalId));
    }
  };

  const handleSessionApproveAllConfirm = () => {
    setSessionAutoApproveAll(true);
    dismissToast(APPROVAL_WARNING_TOAST_ID);

    // Persist to main process so it survives HMR / renderer state resets
    void window.electronAPI.setSessionAutoApprove(true);

    const pendingApprovalIds = Array.from(pendingApprovalsRef.current.keys());
    for (const approvalId of pendingApprovalIds) {
      void handleApprovalResponse(approvalId, true);
    }

    addToast({
      type: "info",
      title: "Session auto-approve enabled",
      message: "Approvals will be accepted automatically for the rest of this app session.",
      durationMs: 7000,
    });
  };

  const reshowPendingApprovalToasts = () => {
    for (const [id, approval] of pendingApprovalsRef.current) {
      addToast({
        id: getApprovalToastId(id),
        type: "info",
        title: "Approval needed",
        message: approval.description || "A task is waiting for your approval.",
        taskId: approval.taskId,
        approvalId: approval.id,
        persistent: true,
        actions: [
          {
            label: "Approve",
            dismissOnClick: false,
            callback: () => {
              void handleApprovalResponse(approval.id, true);
            },
          },
          {
            label: "Deny",
            variant: "secondary",
            dismissOnClick: false,
            callback: () => {
              void handleApprovalResponse(approval.id, false);
            },
          },
          {
            label: "Approve all",
            variant: "danger",
            dismissOnClick: false,
            callback: () => {
              showApproveAllWarning();
            },
          },
        ],
      });
    }
  };

  const showApproveAllWarning = () => {
    // Dismiss all pending approval toasts so the warning is the only dialog visible
    const pendingApprovalIds = Array.from(pendingApprovalsRef.current.keys());
    for (const id of pendingApprovalIds) {
      dismissToast(getApprovalToastId(id));
    }

    addToast({
      id: APPROVAL_WARNING_TOAST_ID,
      type: "error",
      title: "Warning: approve all requests?",
      message:
        "This will auto-approve every future request in this session. Only enable this if you fully trust the active tasks.",
      persistent: true,
      // Mark as approval-related so it renders centered
      approvalId: "__approve-all-warning__",
      actions: [
        {
          label: "I Understand",
          variant: "danger",
          callback: () => {
            handleSessionApproveAllConfirm();
          },
        },
        {
          label: "Cancel",
          variant: "secondary",
          callback: () => {
            dismissToast(APPROVAL_WARNING_TOAST_ID);
            // Re-show pending approval toasts that were hidden
            reshowPendingApprovalToasts();
          },
        },
      ],
    });
  };

  // Keep tasksRef in sync with tasks state
  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  // Restore session auto-approve state from main process (survives HMR and renderer resets)
  useEffect(() => {
    if (!window.electronAPI?.getSessionAutoApprove) return;

    window.electronAPI
      .getSessionAutoApprove()
      .then((enabled: boolean) => {
        if (enabled) {
          setSessionAutoApproveAll(true);
          sessionAutoApproveAllRef.current = true;
        }
      })
      .catch(() => {
        // Ignore — main process may not support this yet
      });
  }, []);

  // Subscribe to all task events to update task status
  useEffect(() => {
    if (!window.electronAPI?.onTaskEvent) return;

    const unsubscribe = window.electronAPI.onTaskEvent((event: TaskEvent) => {
      // Update task status based on event type
      // Check if this is a new task we don't know about (e.g., sub-agent created)
      const isNewTask = !tasksRef.current.some((t) => t.id === event.taskId);
      if (isNewTask && event.type === "task_created") {
        // Refresh task list to include the new sub-agent task
        loadTasks();
        return;
      }

      const newStatus =
        event.type === "task_status" ? event.payload?.status : TASK_EVENT_STATUS_MAP[event.type];
      const isAutoApprovalRequested =
        event.type === "approval_requested" && event.payload?.autoApproved === true;
      const isSessionAutoApproval =
        event.type === "approval_requested" && sessionAutoApproveAllRef.current;
      const skipBlockedStateForAutoApproval = isAutoApprovalRequested || isSessionAutoApproval;
      if (newStatus && !skipBlockedStateForAutoApproval) {
        setTasks((prev) =>
          prev.map((t) => (t.id === event.taskId ? { ...t, status: newStatus } : t)),
        );
      }

      if (event.type === "approval_requested" && !isAutoApprovalRequested) {
        const approval = event.payload?.approval as ApprovalRequest | undefined;
        if (approval?.id) {
          pendingApprovalsRef.current.set(approval.id, approval);

          if (sessionAutoApproveAllRef.current) {
            void handleApprovalResponse(approval.id, true);
          } else {
            addToast({
              id: getApprovalToastId(approval.id),
              type: "info",
              title: "Approval needed",
              message: approval.description || "A task is waiting for your approval.",
              taskId: event.taskId,
              approvalId: approval.id,
              persistent: true,
              actions: [
                {
                  label: "Approve",
                  dismissOnClick: false,
                  callback: () => {
                    void handleApprovalResponse(approval.id, true);
                  },
                },
                {
                  label: "Deny",
                  variant: "secondary",
                  dismissOnClick: false,
                  callback: () => {
                    void handleApprovalResponse(approval.id, false);
                  },
                },
                {
                  label: "Approve all",
                  variant: "danger",
                  dismissOnClick: false,
                  callback: () => {
                    showApproveAllWarning();
                  },
                },
              ],
            });
          }
        }
      }

      if (event.type === "approval_granted" || event.type === "approval_denied") {
        const approvalId = extractApprovalId(event);
        if (approvalId) {
          pendingApprovalsRef.current.delete(approvalId);
          dismissToast(getApprovalToastId(approvalId));
        }
      }

      if (event.type === "workspace_permissions_updated") {
        const payloadWorkspace = event.payload?.workspace as Workspace | undefined;
        const payloadWorkspaceId = event.payload?.workspaceId as string | undefined;
        const payloadPermissions = event.payload?.permissions as
          | Workspace["permissions"]
          | undefined;
        setCurrentWorkspace((prev) => {
          if (!prev) return prev;
          if (payloadWorkspace && payloadWorkspace.id === prev.id) {
            return payloadWorkspace;
          }
          if (payloadWorkspaceId && payloadWorkspaceId === prev.id && payloadPermissions) {
            return {
              ...prev,
              permissions: {
                ...prev.permissions,
                ...payloadPermissions,
              },
            };
          }
          return prev;
        });
      }

      if (event.type === "approval_granted") {
        void window.electronAPI.resumeTask(event.taskId);
      }

      if (
        event.type === "task_paused" ||
        (event.type === "approval_requested" && !skipBlockedStateForAutoApproval)
      ) {
        const isApproval = event.type === "approval_requested";
        const task = tasksRef.current.find((t) => t.id === event.taskId);
        const baseTitle = isApproval ? "Approval needed" : "Quick check-in";
        const title = task?.title ? `${baseTitle} · ${task.title}` : baseTitle;
        const message =
          (isApproval ? event.payload?.approval?.description : event.payload?.message) ||
          "Quick pause - ready to continue once you respond.";

        void (async () => {
          try {
            const existing = await window.electronAPI.listNotifications();
            const existingForTask = existing.filter(
              (n) => n.type === "input_required" && n.taskId === event.taskId,
            );
            if (existingForTask.length > 0) {
              const removals = await Promise.allSettled(
                existingForTask.map((n) => window.electronAPI.deleteNotification(n.id)),
              );
              if (removals.some((result) => result.status === "rejected")) {
                console.error(
                  "Some stale input-required notifications failed to clear before sending update.",
                );
              }
            }
            await window.electronAPI.addNotification({
              type: "input_required",
              title,
              message,
              taskId: event.taskId,
              workspaceId: task?.workspaceId,
            });
          } catch (error) {
            console.error("Failed to add input-required notification:", error);
          }
        })();
      }

      if (
        event.type === "task_resumed" ||
        event.type === "approval_granted" ||
        event.type === "approval_denied"
      ) {
        void (async () => {
          try {
            const existing = await window.electronAPI.listNotifications();
            const existingForTask = existing.filter(
              (n) => n.type === "input_required" && n.taskId === event.taskId,
            );
            if (existingForTask.length > 0) {
              const removals = await Promise.allSettled(
                existingForTask.map((n) => window.electronAPI.deleteNotification(n.id)),
              );
              if (removals.some((result) => result.status === "rejected")) {
                console.error(
                  "Failed to clear some stale input-required notifications after resume.",
                );
              }
            }
          } catch (error) {
            console.error("Failed to clear input-required notifications after resume:", error);
          }
        })();
      }

      // Show toast notifications for task completion/failure
      if (event.type === "task_completed") {
        const task = tasksRef.current.find((t) => t.id === event.taskId);
        addToast({
          type: "success",
          title: "✅ Task Done!",
          message: task?.title || "Task finished successfully",
          taskId: event.taskId,
        });
      } else if (event.type === "error") {
        const task = tasksRef.current.find((t) => t.id === event.taskId);
        addToast({
          type: "error",
          title: "Task Failed",
          message: task?.title || "Task encountered an error",
          taskId: event.taskId,
        });
      } else if (event.type === "follow_up_failed") {
        const task = tasksRef.current.find((t) => t.id === event.taskId);
        const fallbackMessage = task?.title || "A follow-up message failed";
        const reason = String(event.payload?.userMessage || event.payload?.error || "").trim();
        addToast({
          type: "error",
          title: "Follow-up Failed",
          message: reason ? `${fallbackMessage}: ${reason}` : fallbackMessage,
          taskId: event.taskId,
        });
      }

      // Add event to events list if it's for the selected task
      const isSelectedTask = event.taskId === selectedTaskId;

      // For collaborative/multi-LLM roots, also capture file events from child tasks
      const isChildFileEvent =
        !isSelectedTask &&
        (event.type === "file_created" ||
          event.type === "file_modified" ||
          event.type === "file_deleted") &&
        (() => {
          const childTask = tasksRef.current.find((t) => t.id === event.taskId);
          if (!childTask?.parentTaskId || childTask.parentTaskId !== selectedTaskId) return false;
          const parentTask = tasksRef.current.find((t) => t.id === selectedTaskId);
          return !!(
            parentTask?.agentConfig?.collaborativeMode || parentTask?.agentConfig?.multiLlmMode
          );
        })();

      if (isSelectedTask || isChildFileEvent) {
        if (event.type === "llm_streaming") {
          // Replace the previous streaming event to avoid array bloat
          setEvents((prev) => {
            const lastIdx = prev.length - 1;
            if (lastIdx >= 0 && prev[lastIdx].type === "llm_streaming") {
              const updated = [...prev];
              updated[lastIdx] = event;
              return updated;
            }
            return capTaskEvents([...prev, event]);
          });
        } else {
          setEvents((prev) => capTaskEvents([...prev, event]));
        }
      }

      // Capture events from dispatched child tasks for DispatchedAgentsPanel
      if (!isSelectedTask && childTaskIdsRef.current.has(event.taskId)) {
        if (event.type !== "llm_streaming" && event.type !== "llm_usage") {
          setChildEvents((prev) => [...prev, event]);
        }
      }
    });

    return typeof unsubscribe === "function" ? unsubscribe : undefined;
  }, [selectedTaskId]);

  // Load historical events when task is selected
  useEffect(() => {
    if (!selectedTaskId) {
      setEvents([]);
      return;
    }

    // Load historical events from database
    if (!window.electronAPI?.getTaskEvents) {
      setEvents([]);
      return;
    }

    const loadHistoricalEvents = async () => {
      try {
        const historicalEvents = await window.electronAPI.getTaskEvents(selectedTaskId);
        setEvents(capTaskEvents(historicalEvents));
      } catch (error) {
        console.error("Failed to load historical events:", error);
        setEvents([]);
      }
    };

    loadHistoricalEvents();
  }, [selectedTaskId]);

  // Load historical events from dispatched child tasks
  useEffect(() => {
    if (childTasks.length === 0) {
      setChildEvents([]);
      return;
    }
    if (!window.electronAPI?.getTaskEvents) return;

    const loadChildHistoricalEvents = async () => {
      try {
        const allEvents: TaskEvent[] = [];
        for (const child of childTasks) {
          const evts = await window.electronAPI.getTaskEvents(child.id);
          allEvents.push(...evts);
        }
        allEvents.sort((a, b) => a.timestamp - b.timestamp);
        setChildEvents(allEvents);
      } catch (error) {
        console.error("Failed to load child task events:", error);
      }
    };

    loadChildHistoricalEvents();
    // Re-load when child tasks change (new children appear)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [childTasks.map((c) => c.id).join(",")]);

  const loadTasks = async () => {
    if (!window.electronAPI?.listTasks) {
      setTasks([]);
      return;
    }
    try {
      const loadedTasks = await window.electronAPI.listTasks();
      setTasks(loadedTasks);
    } catch (error) {
      console.error("Failed to load tasks:", error);
    }
  };

  // Handle workspace change - opens folder selection dialog directly
  const handleChangeWorkspace = async () => {
    try {
      // Get list of existing workspaces for reference
      const existingWorkspaces = await window.electronAPI.listWorkspaces();

      // Open folder selection dialog
      const folderPath = await window.electronAPI.selectFolder();
      if (!folderPath) return; // User cancelled

      // Check if this folder is already a workspace
      const existingWorkspace = existingWorkspaces.find((w: Workspace) => w.path === folderPath);
      if (existingWorkspace) {
        setCurrentWorkspace(existingWorkspace);
        return;
      }

      // Create a new workspace for this folder
      const folderName = folderPath.split("/").pop() || "Workspace";
      const workspace = await window.electronAPI.createWorkspace({
        name: folderName,
        path: folderPath,
        permissions: {
          read: true,
          write: true,
          delete: true,
          network: true,
          shell: false,
        },
      });

      setCurrentWorkspace(workspace);
    } catch (error) {
      console.error("Failed to change workspace:", error);
    }
  };

  const handleCreateTask = async (
    title: string,
    prompt: string,
    options?: {
      autonomousMode?: boolean;
      collaborativeMode?: boolean;
      multiLlmMode?: boolean;
      multiLlmConfig?: MultiLlmConfig;
      verificationAgent?: boolean;
    },
    images?: ImageAttachment[],
  ) => {
    if (!currentWorkspace) return;
    const requestedAutonomous = options?.autonomousMode === true;
    const requestedCollaborative = options?.collaborativeMode === true;
    const requestedMultiLlm = options?.multiLlmMode === true;
    const autonomousMode = requestedAutonomous && !requestedCollaborative && !requestedMultiLlm;
    const collaborativeMode = requestedCollaborative && !requestedMultiLlm;
    const multiLlmMode = requestedMultiLlm;

    if (requestedAutonomous && requestedCollaborative) {
      addToast({
        type: "info",
        title: "Collaborative mode selected",
        message: "Autonomous mode is disabled when collaborative mode is enabled.",
      });
    }

    if (autonomousMode) {
      const shouldContinue = window.confirm(
        "Autonomous mode allows the agent to proceed without manual confirmation on gated actions. Continue?",
      );
      if (!shouldContinue) return;
    }

    const verificationAgent = options?.verificationAgent === true;

    const agentConfig =
      autonomousMode || collaborativeMode || multiLlmMode || verificationAgent
        ? {
            ...(autonomousMode ? { allowUserInput: false, autonomousMode: true } : {}),
            ...(collaborativeMode ? { collaborativeMode: true } : {}),
            ...(multiLlmMode
              ? { multiLlmMode: true, multiLlmConfig: options?.multiLlmConfig }
              : {}),
            ...(verificationAgent ? { verificationAgent: true } : {}),
          }
        : undefined;

    try {
      const task = await window.electronAPI.createTask({
        title,
        prompt,
        workspaceId: currentWorkspace.id,
        ...(agentConfig && { agentConfig }),
        ...(images && images.length > 0 && { images }),
      });

      setTasks((prev) => [task, ...prev]);
      setSelectedTaskId(task.id);
    } catch (error: unknown) {
      console.error("Failed to create task:", error);
      // Check if it's an API key error and prompt user to configure settings
      const errorMessage = error instanceof Error ? error.message : "Failed to create task";
      if (errorMessage.includes("API key") || errorMessage.includes("credentials")) {
        addToast({
          type: "error",
          title: "Configuration Required",
          message: errorMessage,
          action: {
            label: "Open Settings",
            callback: () => {
              setSettingsTab("llm");
              setCurrentView("settings");
            },
          },
        });
      } else {
        addToast({ type: "error", title: "Task Error", message: errorMessage });
      }
    }
  };

  const selectedTask = tasks.find((t) => t.id === selectedTaskId);

  const handleSendMessage = async (message: string, images?: ImageAttachment[]) => {
    if (!selectedTaskId) return;

    try {
      const lower = message.toLowerCase().trim();
      const enableShellIntent =
        /^(?:yes|yep|yeah|sure|ok|okay|please do|do it)[.!]?$/.test(lower) ||
        /\b(?:enable|turn on|allow|grant)\b[\s\S]{0,20}\bshell\b/.test(lower) ||
        /\bshell\b[\s\S]{0,20}\b(?:on|enable|enabled)\b/.test(lower);

      if (enableShellIntent && currentWorkspace && !currentWorkspace.permissions.shell) {
        try {
          const updatedWorkspace = await window.electronAPI.updateWorkspacePermissions(
            currentWorkspace.id,
            { shell: true },
          );
          if (updatedWorkspace) {
            setCurrentWorkspace(updatedWorkspace);
          }
        } catch (permissionError) {
          console.error("Failed to pre-enable shell from user message:", permissionError);
        }
      }

      await window.electronAPI.sendMessage(selectedTaskId, message, images);
    } catch (error: unknown) {
      console.error("Failed to send message:", error);
      const errorMessage = error instanceof Error ? error.message : "Failed to send message";
      addToast({ type: "error", title: "Error", message: errorMessage });
    }
  };

  const handleCancelTask = async () => {
    if (!selectedTaskId) return;

    // Optimistic UI update: immediately mark as cancelled so spinner stops
    setTasks((prev) =>
      prev.map((t) =>
        t.id === selectedTaskId ? { ...t, status: "cancelled" as Task["status"] } : t,
      ),
    );

    try {
      await window.electronAPI.cancelTask(selectedTaskId);
    } catch (error: unknown) {
      console.error("Failed to cancel task:", error);
      const errorMessage = error instanceof Error ? error.message : "Failed to cancel task";
      addToast({ type: "error", title: "Error", message: errorMessage });
    }
  };

  const handleWrapUpTask = async () => {
    if (!selectedTaskId) return;

    try {
      const collaborativeRun = await window.electronAPI.findTeamRunByRootTask(selectedTaskId);
      if (collaborativeRun?.collaborativeMode && collaborativeRun.status === "running") {
        await window.electronAPI.wrapUpTeamRun(collaborativeRun.id);
      } else {
        await window.electronAPI.wrapUpTask(selectedTaskId);
      }
    } catch (error: unknown) {
      console.error("Failed to wrap up task:", error);
      const errorMessage = error instanceof Error ? error.message : "Failed to wrap up task";
      addToast({ type: "error", title: "Error", message: errorMessage });
    }
  };

  const handleCancelTaskById = async (taskId: string) => {
    try {
      await window.electronAPI.cancelTask(taskId);
    } catch (error: unknown) {
      console.error("Failed to cancel task:", error);
    }
  };

  const handleQuickTask = async (prompt: string) => {
    if (!currentWorkspace) return;

    const title = prompt.slice(0, 50) + (prompt.length > 50 ? "..." : "");
    await handleCreateTask(title, prompt);
  };

  const handleNewSession = async () => {
    setSelectedTaskId(null);
    setEvents([]);
    try {
      const tempWorkspace = await window.electronAPI.getTempWorkspace({ createNew: true });
      setCurrentWorkspace(tempWorkspace);
    } catch (error) {
      console.error("Failed to switch to temp workspace for new session:", error);
    }
  };

  const handleModelChange = (modelKey: string) => {
    setSelectedModel(modelKey);
    // Persist to main process
    void window.electronAPI?.setLLMModel?.(modelKey);
    // When model changes during a task, clear the current task to start fresh
    if (selectedTaskId) {
      setSelectedTaskId(null);
      setEvents([]);
    }
  };

  const handleThemeChange = (theme: ThemeMode) => {
    setThemeMode(theme);
    // Persist to main process
    void window.electronAPI?.saveAppearanceSettings?.({
      themeMode: theme,
      visualTheme,
      accentColor,
    });
  };

  const handleVisualThemeChange = (visual: VisualTheme) => {
    setVisualTheme(visual);
    // Persist to main process
    void window.electronAPI?.saveAppearanceSettings?.({
      themeMode,
      visualTheme: visual,
      accentColor,
    });
  };

  const handleAccentChange = (accent: AccentColor) => {
    setAccentColor(accent);
    // Persist to main process
    void window.electronAPI?.saveAppearanceSettings?.({
      themeMode,
      visualTheme,
      accentColor: accent,
    });
  };

  const handleUiDensityChange = (density: UiDensity) => {
    setUiDensity(density);
    void window.electronAPI?.saveAppearanceSettings?.({
      themeMode,
      visualTheme,
      accentColor,
      uiDensity: density,
    });
  };

  // Smart right panel visibility: auto-collapse on welcome screen in focused mode
  const effectiveRightCollapsed =
    uiDensity === "full" ? rightSidebarCollapsed : !selectedTaskId ? true : rightSidebarCollapsed;

  if (!hasElectronAPI) {
    return (
      <div className="app">
        <div className="title-bar" />
        <div className="empty-state">
          <h2>Desktop bridge unavailable</h2>
          <p>
            CoWork OS is running without Electron preload APIs. Start it with `npm run dev` (not
            only `npm run dev:react`) or relaunch the desktop app.
          </p>
        </div>
      </div>
    );
  }

  // Show loading state while checking disclaimer/onboarding status
  if (disclaimerAccepted === null || onboardingCompleted === null) {
    return (
      <div className="app">
        <div className="title-bar" />
      </div>
    );
  }

  // Show onboarding on first launch
  if (!onboardingCompleted) {
    return (
      <div className="app">
        <Onboarding onComplete={handleOnboardingComplete} />
      </div>
    );
  }

  // Show disclaimer after onboarding is completed but before main app
  if (!disclaimerAccepted) {
    return (
      <div className="app">
        <div className="title-bar" />
        <DisclaimerModal onAccept={handleDisclaimerAccept} />
      </div>
    );
  }

  return (
    <div className="app">
      <div className="title-bar">
        <div className="title-bar-left">
          <button
            type="button"
            className="title-bar-btn"
            onClick={() => setLeftSidebarCollapsed(!leftSidebarCollapsed)}
            title={leftSidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
            aria-label={leftSidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
          >
            <svg
              aria-hidden="true"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#6b7280"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ display: "block", flexShrink: 0 }}
            >
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </button>
          {leftSidebarCollapsed && (
            <button
              type="button"
              className="title-bar-btn"
              onClick={handleNewSession}
              title="New Session"
              aria-label="New Session"
            >
              <svg
                aria-hidden="true"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#6b7280"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ display: "block", flexShrink: 0 }}
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          )}
        </div>
        <div className="title-bar-actions">
          <button
            type="button"
            className="title-bar-btn title-bar-theme-toggle"
            onClick={() => {
              const effectiveTheme = getEffectiveTheme(themeMode);
              handleThemeChange(effectiveTheme === "dark" ? "light" : "dark");
            }}
            title={`Switch to ${getEffectiveTheme(themeMode) === "dark" ? "light" : "dark"} mode`}
            aria-label={`Switch to ${getEffectiveTheme(themeMode) === "dark" ? "light" : "dark"} mode`}
          >
            {getEffectiveTheme(themeMode) === "dark" ? (
              <svg
                aria-hidden="true"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#6b7280"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ display: "block", flexShrink: 0 }}
              >
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" />
                <line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" />
                <line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
              </svg>
            ) : (
              <svg
                aria-hidden="true"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#6b7280"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ display: "block", flexShrink: 0 }}
              >
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>
          <NotificationPanel
            onNotificationClick={(notification) => {
              // Prioritize taskId to show the completed task result
              if (notification.taskId) {
                const task = tasks.find((t) => t.id === notification.taskId);
                if (task) {
                  setSelectedTaskId(task.id);
                  setCurrentView("main");
                  return;
                }
              }
              // Fall back to scheduled tasks settings if only cronJobId
              if (notification.cronJobId) {
                setSettingsTab("scheduled");
                setCurrentView("settings");
              }
            }}
          />
          <button
            type="button"
            className={`title-bar-btn density-toggle ${uiDensity}`}
            onClick={() => handleUiDensityChange(uiDensity === "focused" ? "full" : "focused")}
            title={uiDensity === "focused" ? "Switch to Full mode" : "Switch to Focused mode"}
            aria-label={uiDensity === "focused" ? "Switch to Full mode" : "Switch to Focused mode"}
          >
            {uiDensity === "focused" ? (
              <svg
                aria-hidden="true"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#6b7280"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ display: "block", flexShrink: 0 }}
              >
                <rect x="4" y="5" width="16" height="14" rx="2" />
                <line x1="4" y1="12" x2="20" y2="12" />
              </svg>
            ) : (
              <svg
                aria-hidden="true"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#6b7280"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ display: "block", flexShrink: 0 }}
              >
                <rect x="4" y="4" width="16" height="16" rx="2" />
                <line x1="4" y1="9" x2="20" y2="9" />
                <line x1="4" y1="14" x2="20" y2="14" />
                <line x1="12" y1="4" x2="12" y2="20" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="title-bar-btn title-bar-panel-toggle"
            onClick={() => setRightSidebarCollapsed(!rightSidebarCollapsed)}
            title={effectiveRightCollapsed ? "Show panel" : "Hide panel"}
            aria-label={effectiveRightCollapsed ? "Show panel" : "Hide panel"}
          >
            <svg
              aria-hidden="true"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#6b7280"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ display: "block", flexShrink: 0 }}
            >
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <line x1="15" y1="3" x2="15" y2="21" />
            </svg>
          </button>
        </div>
      </div>
      {/* Update notification banner */}
      {updateInfo?.available && !updateDismissed && (
        <div className="update-banner">
          <div className="update-banner-content">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
            </svg>
            <span>
              New version <strong>v{updateInfo.latestVersion}</strong> is available!
            </span>
            <button
              className="update-banner-link"
              onClick={() => {
                setSettingsTab("updates");
                setCurrentView("settings");
              }}
            >
              View Release
            </button>
          </div>
          <button
            className="update-banner-dismiss"
            onClick={() => setUpdateDismissed(true)}
            aria-label="Dismiss update notification"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
      {currentView === "main" && (
        <>
          <div
            className={`app-layout ${leftSidebarCollapsed ? "left-collapsed" : ""} ${effectiveRightCollapsed ? "right-collapsed" : ""}`}
          >
            {!leftSidebarCollapsed && (
              <Sidebar
                workspace={currentWorkspace}
                tasks={tasks}
                selectedTaskId={selectedTaskId}
                onSelectTask={setSelectedTaskId}
                onNewSession={handleNewSession}
                onOpenSettings={() => setCurrentView("settings")}
                onOpenMissionControl={() => {
                  setSettingsTab("missioncontrol");
                  setCurrentView("settings");
                }}
                onTasksChanged={loadTasks}
                uiDensity={uiDensity}
              />
            )}
            <MainContent
              task={selectedTask}
              selectedTaskId={selectedTaskId}
              workspace={currentWorkspace}
              events={events}
              childTasks={childTasks}
              childEvents={childEvents}
              onSelectChildTask={setSelectedTaskId}
              onSendMessage={handleSendMessage}
              onCreateTask={handleCreateTask}
              onChangeWorkspace={handleChangeWorkspace}
              onSelectWorkspace={(workspace) => setCurrentWorkspace(workspace)}
              onOpenSettings={(tab) => {
                setSettingsTab(tab || "appearance");
                setCurrentView("settings");
              }}
              onStopTask={handleCancelTask}
              onWrapUpTask={handleWrapUpTask}
              onOpenBrowserView={handleOpenBrowserView}
              selectedModel={selectedModel}
              availableModels={availableModels}
              onModelChange={handleModelChange}
              availableProviders={availableProviders}
              uiDensity={uiDensity}
            />
            {!effectiveRightCollapsed && (
              <RightPanel
                task={selectedTask}
                workspace={currentWorkspace}
                events={events}
                tasks={tasks}
                queueStatus={queueStatus}
                onSelectTask={setSelectedTaskId}
                onCancelTask={handleCancelTaskById}
              />
            )}
          </div>

          {/* Quick Task FAB */}
          {currentWorkspace && <QuickTaskFAB onCreateTask={handleQuickTask} />}

          {/* Toast Notifications */}
          <ToastContainer
            toasts={toasts}
            onDismiss={dismissToast}
            onTaskClick={setSelectedTaskId}
          />
        </>
      )}
      {currentView === "settings" && (
        <Settings
          onBack={() => setCurrentView("main")}
          onSettingsChanged={loadLLMConfig}
          themeMode={themeMode}
          visualTheme={visualTheme}
          accentColor={accentColor}
          onThemeChange={handleThemeChange}
          onVisualThemeChange={handleVisualThemeChange}
          onAccentChange={handleAccentChange}
          uiDensity={uiDensity}
          onUiDensityChange={handleUiDensityChange}
          initialTab={settingsTab}
          onShowOnboarding={handleShowOnboarding}
          onboardingCompletedAt={onboardingCompletedAt}
          workspaceId={currentWorkspace?.id}
        />
      )}
      {currentView === "browser" && (
        <BrowserView initialUrl={browserUrl} onBack={() => setCurrentView("main")} />
      )}
    </div>
  );
}
