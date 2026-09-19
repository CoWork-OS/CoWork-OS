import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, MessageSquare, Pause, Play, Square, X } from "lucide-react";
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

function isPauseAvailable(task: Task): boolean {
  return task.status === "executing" || task.status === "planning";
}

function isResumeAvailable(task: Task): boolean {
  return task.status === "paused" || task.status === "interrupted";
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
  const [sendStatus, setSendStatus] = useState<string | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const draftsByTaskRef = useRef<Map<string, string>>(new Map());
  const [sendMode, setSendMode] = useState<"message" | "follow_up">("follow_up");
  const [failedRequest, setFailedRequest] = useState<{
    message: string;
    images?: ImageAttachment[];
    quotedAssistantMessage?: QuotedAssistantMessage;
    options?: {
      permissionMode?: PermissionMode;
      shellAccess?: boolean;
      integrationMentions?: IntegrationMentionSelection[];
      deliveryMode?: "message" | "follow_up";
      messageId?: string;
    };
  } | null>(null);
  const selectedTask = resolveSpawnedAgentSidebarTask(childTasks, selectedTaskId);
  useEffect(() => {
    setSendError(null);
    setSendStatus(null);
    setControlError(null);
    setFailedRequest(null);
    setSendMode(selectedTask && isWorkingTask(selectedTask) ? "message" : "follow_up");
  }, [selectedTask?.id]);
  const selectedDraft = selectedTask ? (draftsByTaskRef.current.get(selectedTask.id) ?? "") : "";

  const runTaskControl = useCallback(
    async (action: "pause" | "resume") => {
      if (!selectedTask) return;
      setControlError(null);
      try {
        if (action === "pause") {
          await window.electronAPI.pauseTask(selectedTask.id);
        } else {
          await window.electronAPI.resumeTask(selectedTask.id);
        }
        await onTasksChanged?.();
      } catch (error) {
        setControlError(error instanceof Error ? error.message : `Failed to ${action} worker`);
      }
    },
    [onTasksChanged, selectedTask],
  );

  const handleDraftChange = useCallback(
    (value: string) => {
      if (selectedTask) draftsByTaskRef.current.set(selectedTask.id, value);
    },
    [selectedTask],
  );
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
        deliveryMode?: "message" | "follow_up";
        messageId?: string;
      },
    ): Promise<boolean> => {
      if (!selectedTask) return false;
      setSendError(null);
      setSendStatus(null);
      const deliveryMode = options?.deliveryMode || sendMode;
      const messageId =
        deliveryMode === "message"
          ? options?.messageId || globalThis.crypto?.randomUUID?.()
          : options?.messageId;
      const requestOptions = {
        ...options,
        deliveryMode,
        ...(messageId ? { messageId } : {}),
      };
      try {
        const result = (await window.electronAPI.sendMessage(
          selectedTask.id,
          message,
          images,
          quotedAssistantMessage,
          requestOptions,
        )) as
          | {
              queued?: boolean;
              duplicate?: boolean;
            }
          | undefined;
        setFailedRequest(null);
        setSendStatus(
          result?.duplicate
            ? result.queued
              ? "Already queued; duplicate ignored"
              : "Already delivered; duplicate ignored"
            : result?.queued
              ? deliveryMode === "message"
                ? "Queued without starting work"
                : "Queued for the next turn"
              : "Message delivered",
        );
        return true;
      } catch (error) {
        const messageText = error instanceof Error ? error.message : "Failed to send message";
        setSendError(messageText);
        setFailedRequest({
          message,
          images,
          quotedAssistantMessage,
          options: requestOptions,
        });
        console.error("Failed to send spawned-agent follow-up:", error);
        return false;
      }
    },
    [selectedTask, sendMode],
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
          {isWorkingTask(selectedTask) || isResumeAvailable(selectedTask) ? (
            <div
              className="spawned-agent-sidebar-controls"
              role="group"
              aria-label="Worker controls"
            >
              {isPauseAvailable(selectedTask) ? (
                <button type="button" onClick={() => void runTaskControl("pause")}>
                  <Pause size={12} /> Pause
                </button>
              ) : null}
              {isResumeAvailable(selectedTask) ? (
                <button type="button" onClick={() => void runTaskControl("resume")}>
                  <Play size={12} /> Resume
                </button>
              ) : null}
              {onCancelTask && isWorkingTask(selectedTask) ? (
                <button
                  type="button"
                  className="danger"
                  onClick={() => onCancelTask(selectedTask.id)}
                >
                  <Square size={12} /> Stop
                </button>
              ) : null}
            </div>
          ) : null}
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

      <div className="spawned-agent-sidebar-send-mode" role="group" aria-label="Worker action">
        <span className="spawned-agent-sidebar-send-mode-label">When you send</span>
        <button
          type="button"
          className={sendMode === "message" ? "active" : ""}
          onClick={() => setSendMode("message")}
          title="Queue the instruction without starting a new worker turn"
        >
          Message
        </button>
        <button
          type="button"
          className={sendMode === "follow_up" ? "active" : ""}
          onClick={() => setSendMode("follow_up")}
          title="Start or continue a worker turn"
        >
          Start follow-up
        </button>
      </div>

      {sendError ? (
        <div className="spawned-agent-sidebar-error" role="alert">
          <MessageSquare size={14} />
          <span>{sendError}</span>
          {failedRequest ? (
            <button
              type="button"
              className="spawned-agent-sidebar-retry"
              onClick={() => {
                const request = failedRequest;
                void sendChildMessage(
                  request.message,
                  request.images,
                  request.quotedAssistantMessage,
                  request.options,
                );
              }}
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
      {controlError ? (
        <div className="spawned-agent-sidebar-control-error" role="alert">
          {controlError}
        </div>
      ) : null}
      {sendStatus ? (
        <div className="spawned-agent-sidebar-send-status" role="status">
          <MessageSquare size={14} />
          <span>{sendStatus}</span>
        </div>
      ) : null}

      {showTranscript ? (
        <div className="spawned-agent-sidebar-transcript">
          <MainContent
            task={selectedTask}
            selectedTaskId={selectedTask.id}
            draftValue={selectedDraft}
            onDraftValueChange={handleDraftChange}
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
