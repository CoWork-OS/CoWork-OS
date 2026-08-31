import { useCallback, useMemo, useState } from "react";
import { Check, Loader2, MessageSquare, X } from "lucide-react";
import type {
  ImageAttachment,
  IntegrationMentionSelection,
  InputRequest,
  LLMModelInfo,
  LLMProviderInfo,
  LLMProviderType,
  LLMReasoningEffort,
  PermissionMode,
  QuotedAssistantMessage,
  Task,
  TaskEvent,
  Workspace,
} from "../../shared/types";
import { MainContent } from "./MainContent";
import { resolveSpawnedAgentSidebarTask } from "../utils/spawned-agent-sidebar";

type SpawnedAgentSidebarProps = {
  parentTask: Task;
  childTasks: Task[];
  childEvents: TaskEvent[];
  selectedTaskId: string | null;
  workspace: Workspace | null;
  selectedModel: string;
  selectedProvider: LLMProviderType;
  selectedReasoningEffort?: LLMReasoningEffort;
  availableModels: LLMModelInfo[];
  availableProviders: LLMProviderInfo[];
  uiDensity: "focused" | "full" | "power";
  rendererPerfLoggingEnabled?: boolean;
  inputRequest?: InputRequest | null;
  onSelectTask: (taskId: string) => void;
  onClose: () => void;
  onCancelTask?: (taskId: string) => void;
  onTasksChanged?: () => void | Promise<void>;
  onOpenSettings?: (tab?: string) => void;
  onModelChange: (selection: {
    providerType?: LLMProviderType;
    modelKey: string;
    reasoningEffort?: LLMReasoningEffort;
  }) => void;
  onOpenSpreadsheetArtifact?: (path: string) => void;
  onOpenDocumentArtifact?: (path: string) => void;
  onOpenPresentationArtifact?: (path: string) => void;
  onOpenWebArtifact?: (path: string) => void;
  showTranscript?: boolean;
};

function isWorkingTask(task: Task): boolean {
  return task.status === "executing" || task.status === "planning" || task.status === "interrupted";
}

function formatDuration(startMs?: number, endMs?: number): string | null {
  if (!startMs) return null;
  const end = endMs || Date.now();
  const diffSec = Math.max(0, Math.round((end - startMs) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  const mins = Math.floor(diffSec / 60);
  const secs = diffSec % 60;
  return `${mins}m ${secs}s`;
}

function StatusBadge({ task }: { task: Task }) {
  const working = isWorkingTask(task);
  const failed = task.status === "failed" || task.status === "cancelled";
  return (
    <span
      className={`spawned-agent-sidebar-status ${
        working ? "is-working" : failed ? "is-failed" : "is-terminal"
      }`}
    >
      {working ? (
        <Loader2 size={12} className="spawned-agent-sidebar-status-icon spinning" />
      ) : failed ? (
        <X size={12} className="spawned-agent-sidebar-status-icon" />
      ) : (
        <Check size={12} className="spawned-agent-sidebar-status-icon" />
      )}
      {working
        ? "Running"
        : task.status === "completed"
          ? "Done"
          : task.status === "cancelled"
            ? "Cancelled"
            : task.status}
    </span>
  );
}

export function SpawnedAgentSidebar({
  parentTask,
  childTasks,
  childEvents,
  selectedTaskId,
  workspace,
  selectedModel,
  selectedProvider,
  selectedReasoningEffort,
  availableModels,
  availableProviders,
  uiDensity,
  rendererPerfLoggingEnabled,
  inputRequest,
  onSelectTask,
  onClose,
  onCancelTask,
  onTasksChanged,
  onOpenSettings,
  onModelChange,
  onOpenSpreadsheetArtifact,
  onOpenDocumentArtifact,
  onOpenPresentationArtifact,
  onOpenWebArtifact,
  showTranscript = true,
}: SpawnedAgentSidebarProps) {
  const [sendError, setSendError] = useState<string | null>(null);
  const selectedTask = resolveSpawnedAgentSidebarTask(childTasks, selectedTaskId);
  const selectedEvents = useMemo(
    () =>
      selectedTask
        ? childEvents
            .filter((event) => event.taskId === selectedTask.id)
            .sort((a, b) => a.timestamp - b.timestamp)
        : [],
    [childEvents, selectedTask],
  );
  const durationLabel = selectedTask
    ? formatDuration(
        selectedTask.createdAt,
        selectedTask.completedAt ??
          (isWorkingTask(selectedTask) ? undefined : selectedTask.updatedAt),
      )
    : null;

  const sendChildMessage = useCallback(
    async (
      message: string,
      images?: ImageAttachment[],
      quotedAssistantMessage?: QuotedAssistantMessage,
      options?: {
        permissionMode?: PermissionMode;
        shellAccess?: boolean;
        integrationMentions?: IntegrationMentionSelection[];
      },
    ) => {
      if (!selectedTask) return;
      setSendError(null);
      try {
        await window.electronAPI.sendMessage(
          selectedTask.id,
          message,
          images,
          quotedAssistantMessage,
          options,
        );
      } catch (error) {
        const messageText = error instanceof Error ? error.message : "Failed to send message";
        setSendError(messageText);
        console.error("Failed to send spawned-agent follow-up:", error);
      }
    },
    [selectedTask],
  );

  if (!selectedTask) {
    return (
      <aside className="spawned-agent-sidebar" aria-label="Spawned agents">
        <div className="spawned-agent-sidebar-header">
          <div>
            <div className="spawned-agent-sidebar-kicker">Spawned agents</div>
            <h2>No agents</h2>
          </div>
          <button type="button" className="spawned-agent-sidebar-close" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="spawned-agent-sidebar-empty">No spawned agents are available.</div>
      </aside>
    );
  }

  return (
    <aside className="spawned-agent-sidebar" aria-label="Spawned agents">
      <div className="spawned-agent-sidebar-header">
        <div className="spawned-agent-sidebar-heading">
          <div className="spawned-agent-sidebar-kicker">
            Spawned from {parentTask.title || "parent task"}
          </div>
          <h2>{selectedTask.title}</h2>
          <div className="spawned-agent-sidebar-meta">
            <StatusBadge task={selectedTask} />
            {durationLabel ? <span>{durationLabel}</span> : null}
            <span>
              {selectedEvents.length} event{selectedEvents.length === 1 ? "" : "s"}
            </span>
          </div>
        </div>
        <button type="button" className="spawned-agent-sidebar-close" onClick={onClose}>
          Close
        </button>
      </div>

      {childTasks.length > 1 ? (
        <div className="spawned-agent-sidebar-tabs" role="tablist" aria-label="Spawned agents">
          {childTasks.map((task) => (
            <button
              key={task.id}
              type="button"
              role="tab"
              aria-selected={task.id === selectedTask.id}
              className={`spawned-agent-sidebar-tab ${task.id === selectedTask.id ? "active" : ""}`}
              onClick={() => onSelectTask(task.id)}
            >
              <span className="spawned-agent-sidebar-tab-label">{task.title}</span>
              {isWorkingTask(task) ? (
                <Loader2 size={12} className="spawned-agent-sidebar-tab-icon spinning" />
              ) : task.status === "completed" ? (
                <Check size={12} className="spawned-agent-sidebar-tab-icon" />
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      {sendError ? (
        <div className="spawned-agent-sidebar-error" role="alert">
          <MessageSquare size={14} />
          <span>{sendError}</span>
        </div>
      ) : null}

      {showTranscript ? (
        <div className="spawned-agent-sidebar-transcript">
          <MainContent
            task={selectedTask}
            selectedTaskId={selectedTask.id}
            workspace={workspace}
            events={selectedEvents}
            sharedTaskEventUi={null}
            childTasks={[]}
            childEvents={[]}
            onSendMessage={sendChildMessage}
            onCreateTask={() => undefined}
            onStopTask={
              onCancelTask && isWorkingTask(selectedTask)
                ? () => onCancelTask(selectedTask.id)
                : undefined
            }
            inputRequest={inputRequest?.taskId === selectedTask.id ? inputRequest : null}
            onTasksChanged={onTasksChanged}
            onOpenSettings={onOpenSettings as never}
            selectedModel={selectedModel}
            selectedProvider={selectedProvider}
            selectedReasoningEffort={selectedReasoningEffort}
            availableModels={availableModels}
            availableProviders={availableProviders}
            onModelChange={onModelChange}
            uiDensity={uiDensity}
            rendererPerfLoggingEnabled={rendererPerfLoggingEnabled}
            onOpenSpreadsheetArtifact={onOpenSpreadsheetArtifact}
            onOpenDocumentArtifact={onOpenDocumentArtifact}
            onOpenPresentationArtifact={onOpenPresentationArtifact}
            onOpenWebArtifact={onOpenWebArtifact}
          />
        </div>
      ) : null}
    </aside>
  );
}
