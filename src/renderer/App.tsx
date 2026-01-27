import { useState, useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { MainContent } from './components/MainContent';
import { RightPanel } from './components/RightPanel';
import { WorkspaceSelector } from './components/WorkspaceSelector';
import { Settings } from './components/Settings';
import { Task, Workspace, TaskEvent, LLMModelInfo, LLMProviderInfo, SuccessCriteria, UpdateInfo, ThemeMode, AccentColor } from '../shared/types';

// Theme storage keys
const THEME_STORAGE_KEY = 'cowork-theme-mode';
const ACCENT_STORAGE_KEY = 'cowork-accent-color';

// Helper to get effective theme based on system preference
function getEffectiveTheme(themeMode: ThemeMode): 'light' | 'dark' {
  if (themeMode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return themeMode;
}

type AppView = 'workspace-selector' | 'main' | 'settings';

export function App() {
  const [currentWorkspace, setCurrentWorkspace] = useState<Workspace | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [currentView, setCurrentView] = useState<AppView>('workspace-selector');
  const [events, setEvents] = useState<TaskEvent[]>([]);

  // Model selection state
  const [selectedModel, setSelectedModel] = useState<string>('opus-4-5');
  const [availableModels, setAvailableModels] = useState<LLMModelInfo[]>([]);
  const [_availableProviders, setAvailableProviders] = useState<LLMProviderInfo[]>([]);

  // Update notification state
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);

  // Theme state
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return (saved as ThemeMode) || 'dark';
  });
  const [accentColor, setAccentColor] = useState<AccentColor>(() => {
    const saved = localStorage.getItem(ACCENT_STORAGE_KEY);
    return (saved as AccentColor) || 'cyan';
  });

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

  // Load tasks when workspace is selected
  useEffect(() => {
    if (currentWorkspace) {
      loadTasks();
      setCurrentView('main');
    }
  }, [currentWorkspace]);

  // Subscribe to all task events to update task status
  useEffect(() => {
    const unsubscribe = window.electronAPI.onTaskEvent((event: TaskEvent) => {
      // Update task status based on event type
      const statusMap: Record<string, Task['status']> = {
        'task_created': 'pending',
        'executing': 'executing',
        'step_started': 'executing',
        'step_completed': 'executing',
        'task_completed': 'completed',
        'follow_up_completed': 'completed',
        'error': 'failed',
      };

      const newStatus = statusMap[event.type];
      if (newStatus) {
        setTasks(prev => prev.map(t =>
          t.id === event.taskId ? { ...t, status: newStatus } : t
        ));
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

  const handleWorkspaceSelected = (workspace: Workspace) => {
    setCurrentWorkspace(workspace);
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
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  };

  const handleAccentChange = (accent: AccentColor) => {
    setAccentColor(accent);
    localStorage.setItem(ACCENT_STORAGE_KEY, accent);
  };

  return (
    <div className="app">
      <div className="title-bar" />
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
            {updateInfo.releaseUrl ? (
              <a
                href={updateInfo.releaseUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="update-banner-link"
              >
                View Release
              </a>
            ) : (
              <button
                className="update-banner-link"
                onClick={() => setCurrentView('settings')}
              >
                Update
              </button>
            )}
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
      {currentView === 'workspace-selector' && (
        <WorkspaceSelector onWorkspaceSelected={handleWorkspaceSelected} />
      )}
      {currentView === 'main' && (
        <div className="app-layout">
          <Sidebar
            workspace={currentWorkspace}
            tasks={tasks}
            selectedTaskId={selectedTaskId}
            onSelectTask={setSelectedTaskId}
            onOpenSettings={() => setCurrentView('settings')}
            onTasksChanged={loadTasks}
          />
          <MainContent
            task={selectedTask}
            workspace={currentWorkspace}
            events={events}
            onSendMessage={handleSendMessage}
            onCreateTask={handleCreateTask}
            onChangeWorkspace={() => setCurrentView('workspace-selector')}
            onStopTask={handleCancelTask}
            selectedModel={selectedModel}
            availableModels={availableModels}
            onModelChange={handleModelChange}
          />
          <RightPanel task={selectedTask} workspace={currentWorkspace} events={events} />
        </div>
      )}
      {currentView === 'settings' && (
        <Settings
          onBack={() => setCurrentView('main')}
          onSettingsChanged={loadLLMConfig}
          themeMode={themeMode}
          accentColor={accentColor}
          onThemeChange={handleThemeChange}
          onAccentChange={handleAccentChange}
        />
      )}
    </div>
  );
}
