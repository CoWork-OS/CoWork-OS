import { useState, useEffect, useRef } from 'react';
import { Sidebar } from './components/Sidebar';
import { MainContent } from './components/MainContent';
import { RightPanel } from './components/RightPanel';
import { Settings } from './components/Settings';
import { DisclaimerModal } from './components/DisclaimerModal';
// TaskQueuePanel moved to RightPanel
import { ToastContainer } from './components/Toast';
import { QuickTaskFAB } from './components/QuickTaskFAB';
import { NotificationPanel } from './components/NotificationPanel';
import { Task, Workspace, TaskEvent, LLMModelInfo, LLMProviderInfo, SuccessCriteria, UpdateInfo, ThemeMode, AccentColor, QueueStatus, ToastNotification } from '../shared/types';


// Helper to get effective theme based on system preference
function getEffectiveTheme(themeMode: ThemeMode): 'light' | 'dark' {
  if (themeMode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return themeMode;
}

type AppView = 'main' | 'settings';

export function App() {
  const [currentWorkspace, setCurrentWorkspace] = useState<Workspace | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [currentView, setCurrentView] = useState<AppView>('main');
  const [settingsTab, setSettingsTab] = useState<'appearance' | 'llm' | 'search' | 'telegram' | 'discord' | 'updates' | 'guardrails' | 'queue' | 'skills' | 'scheduled'>('appearance');
  const [events, setEvents] = useState<TaskEvent[]>([]);

  // Model selection state
  const [selectedModel, setSelectedModel] = useState<string>('opus-4-5');
  const [availableModels, setAvailableModels] = useState<LLMModelInfo[]>([]);
  const [_availableProviders, setAvailableProviders] = useState<LLMProviderInfo[]>([]);

  // Update notification state
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);

  // Theme state (loaded from main process on mount)
  const [themeMode, setThemeMode] = useState<ThemeMode>('dark');
  const [accentColor, setAccentColor] = useState<AccentColor>('cyan');

  // Queue state
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);
  const [toasts, setToasts] = useState<ToastNotification[]>([]);

  // Sidebar collapse state
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(false);
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = useState(false);

  // Ref to track current tasks for use in event handlers (avoids stale closure)
  const tasksRef = useRef<Task[]>([]);

  // Disclaimer state (null = loading)
  const [disclaimerAccepted, setDisclaimerAccepted] = useState<boolean | null>(null);

  const handleDisclaimerAccept = (dontShowAgain: boolean) => {
    // Save to main process for persistence
    window.electronAPI.saveAppearanceSettings({ disclaimerAccepted: dontShowAgain });
    setDisclaimerAccepted(true);
  };

  // Load LLM config status
  const loadLLMConfig = async () => {
    try {
      const config = await window.electronAPI.getLLMConfigStatus();
      setSelectedModel(config.currentModel);
      setAvailableModels(config.models);
      setAvailableProviders(config.providers);
    } catch (error) {
      console.error('Failed to load LLM config:', error);
    }
  };

  // Load LLM config on mount
  useEffect(() => {
    loadLLMConfig();
  }, []);

  // Load appearance settings on mount
  useEffect(() => {
    const loadAppearanceSettings = async () => {
      try {
        const settings = await window.electronAPI.getAppearanceSettings();
        setThemeMode(settings.themeMode);
        setAccentColor(settings.accentColor);
        setDisclaimerAccepted(settings.disclaimerAccepted ?? false);
      } catch (error) {
        console.error('Failed to load appearance settings:', error);
        setDisclaimerAccepted(false);
      }
    };
    loadAppearanceSettings();
  }, []);

  // Check for migration status and show one-time notification if needed
  // This handles the case where the app was renamed from cowork-oss to cowork-os
  // and encrypted credentials (API keys) need to be re-entered
  const migrationCheckDone = useRef(false);
  useEffect(() => {
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
            type: 'info',
            title: 'Welcome to CoWork OS',
            message: 'Your data was migrated successfully. Due to macOS security, API keys need to be re-entered.',
            action: {
              label: 'Open Settings',
              callback: () => {
                setCurrentView('settings');
                setSettingsTab('llm');
              },
            },
          };
          setToasts(prev => [...prev, toast]);

          // Longer auto-dismiss for this important notification (30 seconds)
          setTimeout(() => {
            setToasts(prev => prev.filter(t => t.id !== id));
          }, 30000);

          // Mark notification as dismissed so it only shows once
          await window.electronAPI.dismissMigrationNotification();
        }
      } catch (error) {
        console.error('Failed to check migration status:', error);
      }
    };
    checkMigrationStatus();
  }, []);

  // Load queue status and subscribe to updates
  useEffect(() => {
    const loadQueueStatus = async () => {
      try {
        const status = await window.electronAPI.getQueueStatus();
        setQueueStatus(status);
      } catch (error) {
        console.error('Failed to load queue status:', error);
      }
    };

    loadQueueStatus();

    const unsubscribe = window.electronAPI.onQueueUpdate((status) => {
      setQueueStatus(status);
    });

    return unsubscribe;
  }, []);

  // Check for updates on mount
  useEffect(() => {
    const checkUpdates = async () => {
      try {
        const info = await window.electronAPI.checkForUpdates();
        if (info.available) {
          setUpdateInfo(info);
        }
      } catch (error) {
        // Silently ignore update check failures
        console.log('Update check skipped:', error);
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
    root.classList.remove('theme-light', 'theme-dark');

    // Apply theme class (only light needs explicit class, dark is default)
    if (effectiveTheme === 'light') {
      root.classList.add('theme-light');
    }

    // Remove existing accent classes
    root.classList.remove('accent-cyan', 'accent-blue', 'accent-purple', 'accent-pink', 'accent-rose', 'accent-orange', 'accent-green', 'accent-teal');

    // Apply accent class
    root.classList.add(`accent-${accentColor}`);
  }, [themeMode, accentColor]);

  // Listen for system theme changes when in 'system' mode
  useEffect(() => {
    if (themeMode !== 'system') return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      const root = document.documentElement;
      root.classList.remove('theme-light', 'theme-dark');
      if (!mediaQuery.matches) {
        root.classList.add('theme-light');
      }
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [themeMode]);

  useEffect(() => {
    console.log('App mounted');
    console.log('window.electronAPI available:', !!window.electronAPI);
    if (window.electronAPI) {
      console.log('electronAPI methods:', Object.keys(window.electronAPI));
    }
  }, []);

  // Auto-load temp workspace on mount if no workspace is selected
  useEffect(() => {
    const initWorkspace = async () => {
      if (!currentWorkspace) {
        try {
          const tempWorkspace = await window.electronAPI.getTempWorkspace();
          setCurrentWorkspace(tempWorkspace);
        } catch (error) {
          console.error('Failed to initialize temp workspace:', error);
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

  // Toast helper functions
  const addToast = (toast: Omit<ToastNotification, 'id'>) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newToast: ToastNotification = { ...toast, id };
    setToasts(prev => [...prev, newToast]);
    // Auto-dismiss after 5 seconds
    setTimeout(() => dismissToast(id), 5000);
  };

  const dismissToast = (id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  // Keep tasksRef in sync with tasks state
  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  // Subscribe to all task events to update task status
  useEffect(() => {
    const unsubscribe = window.electronAPI.onTaskEvent((event: TaskEvent) => {
      // Update task status based on event type
      const statusMap: Record<string, Task['status']> = {
        'task_created': 'pending',
        'task_queued': 'queued',
        'task_dequeued': 'planning',
        'executing': 'executing',
        'step_started': 'executing',
        'step_completed': 'executing',
        'task_completed': 'completed',
        'follow_up_completed': 'completed',
        'error': 'failed',
        'task_cancelled': 'cancelled',
      };

      // Check if this is a new task we don't know about (e.g., sub-agent created)
      const isNewTask = !tasksRef.current.some(t => t.id === event.taskId);
      if (isNewTask && event.type === 'task_created') {
        // Refresh task list to include the new sub-agent task
        loadTasks();
        return;
      }

      const newStatus = statusMap[event.type];
      if (newStatus) {
        setTasks(prev => prev.map(t =>
          t.id === event.taskId ? { ...t, status: newStatus } : t
        ));
      }

      // Show toast notifications for task completion/failure
      if (event.type === 'task_completed') {
        const task = tasksRef.current.find(t => t.id === event.taskId);
        addToast({
          type: 'success',
          title: '✅ Task Done!',
          message: task?.title || 'Task finished successfully',
          taskId: event.taskId,
        });
      } else if (event.type === 'error') {
        const task = tasksRef.current.find(t => t.id === event.taskId);
        addToast({
          type: 'error',
          title: 'Task Failed',
          message: task?.title || 'Task encountered an error',
          taskId: event.taskId,
        });
      }

      // Add event to events list if it's for the selected task
      if (event.taskId === selectedTaskId) {
        setEvents(prev => [...prev, event]);
      }
    });

    return unsubscribe;
  }, [selectedTaskId]);

  // Load historical events when task is selected
  useEffect(() => {
    if (!selectedTaskId) {
      setEvents([]);
      return;
    }

    // Load historical events from database
    const loadHistoricalEvents = async () => {
      try {
        const historicalEvents = await window.electronAPI.getTaskEvents(selectedTaskId);
        setEvents(historicalEvents);
      } catch (error) {
        console.error('Failed to load historical events:', error);
        setEvents([]);
      }
    };

    loadHistoricalEvents();
  }, [selectedTaskId]);

  const loadTasks = async () => {
    try {
      const loadedTasks = await window.electronAPI.listTasks();
      setTasks(loadedTasks);
    } catch (error) {
      console.error('Failed to load tasks:', error);
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
      const folderName = folderPath.split('/').pop() || 'Workspace';
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
      console.error('Failed to change workspace:', error);
    }
  };

  const handleCreateTask = async (title: string, prompt: string, options?: { successCriteria?: SuccessCriteria; maxAttempts?: number }) => {
    if (!currentWorkspace) return;

    try {
      const task = await window.electronAPI.createTask({
        title,
        prompt,
        workspaceId: currentWorkspace.id,
        ...(options?.successCriteria && { successCriteria: options.successCriteria }),
        ...(options?.maxAttempts && { maxAttempts: options.maxAttempts }),
      });

      setTasks(prev => [task, ...prev]);
      setSelectedTaskId(task.id);
    } catch (error: unknown) {
      console.error('Failed to create task:', error);
      // Check if it's an API key error and prompt user to configure settings
      const errorMessage = error instanceof Error ? error.message : 'Failed to create task';
      if (errorMessage.includes('API key') || errorMessage.includes('credentials')) {
        const openSettings = window.confirm(
          `${errorMessage}\n\nWould you like to open Settings to configure your LLM provider?`
        );
        if (openSettings) {
          setCurrentView('settings');
        }
      } else {
        alert(`Error: ${errorMessage}`);
      }
    }
  };

  const selectedTask = tasks.find(t => t.id === selectedTaskId);

  const handleSendMessage = async (message: string) => {
    if (!selectedTaskId) return;

    try {
      await window.electronAPI.sendMessage(selectedTaskId, message);
    } catch (error: unknown) {
      console.error('Failed to send message:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to send message';
      alert(`Error: ${errorMessage}`);
    }
  };

  const handleCancelTask = async () => {
    if (!selectedTaskId) return;

    try {
      await window.electronAPI.cancelTask(selectedTaskId);
    } catch (error: unknown) {
      console.error('Failed to cancel task:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to cancel task';
      alert(`Error: ${errorMessage}`);
    }
  };

  const handleCancelTaskById = async (taskId: string) => {
    try {
      await window.electronAPI.cancelTask(taskId);
    } catch (error: unknown) {
      console.error('Failed to cancel task:', error);
    }
  };

  const handleQuickTask = async (prompt: string) => {
    if (!currentWorkspace) return;

    const title = prompt.slice(0, 50) + (prompt.length > 50 ? '...' : '');
    await handleCreateTask(title, prompt);
  };

  const handleModelChange = (modelKey: string) => {
    setSelectedModel(modelKey);
    // When model changes during a task, clear the current task to start fresh
    if (selectedTaskId) {
      setSelectedTaskId(null);
      setEvents([]);
    }
  };

  const handleThemeChange = (theme: ThemeMode) => {
    setThemeMode(theme);
    // Persist to main process
    window.electronAPI.saveAppearanceSettings({ themeMode: theme, accentColor });
  };

  const handleAccentChange = (accent: AccentColor) => {
    setAccentColor(accent);
    // Persist to main process
    window.electronAPI.saveAppearanceSettings({ themeMode, accentColor: accent });
  };

  // Show loading state while checking disclaimer status
  if (disclaimerAccepted === null) {
    return (
      <div className="app">
        <div className="title-bar" />
      </div>
    );
  }

  // Show disclaimer modal on first launch
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
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '32px',
              height: '32px',
              borderRadius: '6px',
              backgroundColor: 'transparent',
              border: 'none',
              cursor: 'pointer',
              position: 'relative',
              zIndex: 1,
              // @ts-expect-error - webkit property for Electron
              WebkitAppRegion: 'no-drag',
            }}
            onClick={() => setLeftSidebarCollapsed(!leftSidebarCollapsed)}
            title={leftSidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </button>
        </div>
        <div className="title-bar-actions">
          <button
            type="button"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '32px',
              height: '32px',
              borderRadius: '6px',
              backgroundColor: 'transparent',
              border: 'none',
              cursor: 'pointer',
              position: 'relative',
              zIndex: 1,
              // @ts-expect-error - webkit property for Electron
              WebkitAppRegion: 'no-drag',
            }}
            onClick={() => {
              const effectiveTheme = getEffectiveTheme(themeMode);
              handleThemeChange(effectiveTheme === 'dark' ? 'light' : 'dark');
            }}
            title={`Switch to ${getEffectiveTheme(themeMode) === 'dark' ? 'light' : 'dark'} mode`}
          >
            {getEffectiveTheme(themeMode) === 'dark' ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
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
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>
          <NotificationPanel
            onNotificationClick={(notification) => {
              // Prioritize taskId to show the completed task result
              if (notification.taskId) {
                const task = tasks.find(t => t.id === notification.taskId);
                if (task) {
                  setSelectedTaskId(task.id);
                  setCurrentView('main');
                  return;
                }
              }
              // Fall back to scheduled tasks settings if only cronJobId
              if (notification.cronJobId) {
                setSettingsTab('scheduled');
                setCurrentView('settings');
              }
            }}
          />
          <button
            type="button"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '32px',
              height: '32px',
              borderRadius: '6px',
              backgroundColor: 'transparent',
              border: 'none',
              cursor: 'pointer',
              position: 'relative',
              zIndex: 1,
              // @ts-expect-error - webkit property for Electron
              WebkitAppRegion: 'no-drag',
            }}
            onClick={() => setRightSidebarCollapsed(!rightSidebarCollapsed)}
            title={rightSidebarCollapsed ? 'Show panel' : 'Hide panel'}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
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
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
            </svg>
            <span>
              New version <strong>v{updateInfo.latestVersion}</strong> is available!
            </span>
            <button
              className="update-banner-link"
              onClick={() => {
                setSettingsTab('updates');
                setCurrentView('settings');
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
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
      {currentView === 'main' && (
        <>
          <div className={`app-layout ${leftSidebarCollapsed ? 'left-collapsed' : ''} ${rightSidebarCollapsed ? 'right-collapsed' : ''}`}>
            {!leftSidebarCollapsed && (
              <Sidebar
                workspace={currentWorkspace}
                tasks={tasks}
                selectedTaskId={selectedTaskId}
                onSelectTask={setSelectedTaskId}
                onOpenSettings={() => setCurrentView('settings')}
                onTasksChanged={loadTasks}
              />
            )}
            <MainContent
              task={selectedTask}
              selectedTaskId={selectedTaskId}
              workspace={currentWorkspace}
              events={events}
              onSendMessage={handleSendMessage}
              onCreateTask={handleCreateTask}
              onChangeWorkspace={handleChangeWorkspace}
              onSelectWorkspace={(workspace) => setCurrentWorkspace(workspace)}
              onOpenSettings={(tab) => {
                setSettingsTab(tab || 'appearance');
                setCurrentView('settings');
              }}
              onStopTask={handleCancelTask}
              selectedModel={selectedModel}
              availableModels={availableModels}
              onModelChange={handleModelChange}
            />
            {!rightSidebarCollapsed && (
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
          {currentWorkspace && (
            <QuickTaskFAB onCreateTask={handleQuickTask} />
          )}

          {/* Toast Notifications */}
          <ToastContainer
            toasts={toasts}
            onDismiss={dismissToast}
            onTaskClick={setSelectedTaskId}
          />
        </>
      )}
      {currentView === 'settings' && (
        <Settings
          onBack={() => setCurrentView('main')}
          onSettingsChanged={loadLLMConfig}
          themeMode={themeMode}
          accentColor={accentColor}
          onThemeChange={handleThemeChange}
          onAccentChange={handleAccentChange}
          initialTab={settingsTab}
        />
      )}
    </div>
  );
}
