import { useState, useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { MainContent } from './components/MainContent';
import { RightPanel } from './components/RightPanel';
import { WorkspaceSelector } from './components/WorkspaceSelector';
import { Settings } from './components/Settings';
import { Task, Workspace, TaskEvent, LLMModelInfo, LLMProviderInfo } from '../shared/types';

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

  const handleCreateTask = async (title: string, prompt: string) => {
    if (!currentWorkspace) return;

    try {
      const task = await window.electronAPI.createTask({
        title,
        prompt,
        workspaceId: currentWorkspace.id,
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

  const handleModelChange = (modelKey: string) => {
    setSelectedModel(modelKey);
    // When model changes during a task, clear the current task to start fresh
    if (selectedTaskId) {
      setSelectedTaskId(null);
      setEvents([]);
    }
  };

  return (
    <div className="app">
      <div className="title-bar" />
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
            selectedModel={selectedModel}
            availableModels={availableModels}
            onModelChange={handleModelChange}
          />
          <RightPanel task={selectedTask} workspace={currentWorkspace} events={events} />
        </div>
      )}
      {currentView === 'settings' && (
        <Settings onBack={() => setCurrentView('main')} onSettingsChanged={loadLLMConfig} />
      )}
    </div>
  );
}
