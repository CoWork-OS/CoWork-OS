import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Calendar, Tag, X, Zap } from "lucide-react";
import { ActivityFeed } from "../ActivityFeed";
import { MentionInput } from "../MentionInput";
import { MentionList } from "../MentionList";
import { BOARD_COLUMNS, TASK_PRIORITY_OPTIONS } from "./useMissionControlData";
import type { MissionControlData } from "./useMissionControlData";
import type {
  EvidenceRef,
  TaskLearningProgress,
  UnifiedRecallResult,
  UnifiedRecallSourceType,
} from "../../../shared/types";

interface MCTaskDetailProps {
  data: MissionControlData;
  taskId: string;
}

const UNIFIED_RECALL_SOURCES: Array<{ value: UnifiedRecallSourceType; label: string }> = [
  { value: "task", label: "Tasks" },
  { value: "message", label: "Messages" },
  { value: "file", label: "Files" },
  { value: "workspace_note", label: "Workspace notes" },
  { value: "memory", label: "Memory" },
  { value: "screen_context", label: "Screen context" },
  { value: "knowledge_graph", label: "Knowledge graph" },
];

const ESTIMATE_OPTIONS = [
  { value: "", label: "No estimate" },
  { value: "15", label: "15 min" },
  { value: "30", label: "30 min" },
  { value: "60", label: "1 hour" },
  { value: "120", label: "2 hours" },
  { value: "240", label: "4 hours" },
  { value: "480", label: "1 day" },
  { value: "960", label: "2 days" },
  { value: "2400", label: "1 week" },
];

function statusTone(status: string): string {
  return `status-${status.replace(/[^a-z0-9_-]/gi, "-")}`;
}

function renderEvidenceLabel(ref: EvidenceRef): string {
  const prefix =
    ref.sourceType === "file"
      ? "File"
      : ref.sourceType === "url"
        ? "Link"
        : ref.sourceType === "screen_context"
          ? "Screen context"
          : "Evidence";
  return ref.snippet ? `${prefix}: ${ref.snippet}` : `${prefix}: ${ref.sourceUrlOrPath}`;
}

export function MCTaskDetail({ data, taskId }: MCTaskDetailProps) {
  const {
    tasks,
    agents,
    taskLabels,
    selectedWorkspaceId,
    handleAssignTask,
    handleMoveTask,
    handleSetTaskPriority,
    handleSetTaskDueDate,
    handleSetTaskEstimate,
    handleAddTaskLabel,
    handleRemoveTaskLabel,
    handleTriggerHeartbeat,
    getMissionColumnForTask,
    getTaskLabels,
    getTaskAttentionReason,
    getTaskNextMissionColumn,
    getTaskDueInfo,
    getTaskPriorityMeta,
    getAgentStatus,
    formatTaskEstimate,
    isTaskStale,
    isTaskTerminal,
    commentText,
    setCommentText,
    postingComment,
    handlePostComment,
    formatRelativeTime,
    agentContext,
    isAllWorkspacesSelected,
    getWorkspaceName,
  } = data;

  const task = tasks.find((t) => t.id === taskId);
  const [learningProgress, setLearningProgress] = useState<TaskLearningProgress[]>([]);
  const [learningLoading, setLearningLoading] = useState(false);
  const [learningError, setLearningError] = useState<string | null>(null);
  const [recallQuery, setRecallQuery] = useState("");
  const [recallSource, setRecallSource] = useState<UnifiedRecallSourceType | "">("");
  const [recallResults, setRecallResults] = useState<UnifiedRecallResult[]>([]);
  const [recallLoading, setRecallLoading] = useState(false);
  const [recallError, setRecallError] = useState<string | null>(null);
  const [labelToAdd, setLabelToAdd] = useState("");

  const taskWorkspaceId = task?.workspaceId || selectedWorkspaceId || undefined;

  const loadLearningProgress = useCallback(async () => {
    if (!task?.id || !window.electronAPI?.getTaskLearningProgress) return;
    setLearningLoading(true);
    try {
      const progress = await window.electronAPI.getTaskLearningProgress(task.id);
      setLearningProgress(progress || []);
      setLearningError(null);
    } catch (error) {
      console.error("Failed to load task learning progress:", error);
      setLearningError("Unable to load learning progress.");
    } finally {
      setLearningLoading(false);
    }
  }, [task?.id]);

  const loadRecall = useCallback(async () => {
    if (!window.electronAPI?.queryUnifiedRecall) return;
    const query = recallQuery.trim();
    if (!query) {
      setRecallResults([]);
      setRecallError(null);
      return;
    }

    setRecallLoading(true);
    try {
      const response = await window.electronAPI.queryUnifiedRecall({
        workspaceId: taskWorkspaceId,
        query,
        limit: 12,
        ...(recallSource ? { sourceTypes: [recallSource] } : {}),
      });
      setRecallResults(response.results || []);
      setRecallError(null);
    } catch (error) {
      console.error("Failed to query unified recall:", error);
      setRecallError("Unable to search Cowork memory.");
    } finally {
      setRecallLoading(false);
    }
  }, [recallQuery, recallSource, taskWorkspaceId]);

  useEffect(() => {
    void loadLearningProgress();
  }, [loadLearningProgress]);

  useEffect(() => {
    setLabelToAdd("");
  }, [taskId]);

  useEffect(() => {
    if (!window.electronAPI?.onTaskLearningEvent || !task?.id) return;

    const unsubscribe = window.electronAPI.onTaskLearningEvent((event) => {
      if (event.taskId !== task.id) return;
      setLearningProgress((prev) => {
        const withoutEvent = prev.filter((item) => item.id !== event.id);
        return [event, ...withoutEvent].sort((a, b) => b.completedAt - a.completedAt);
      });
      setLearningError(null);
    });

    return unsubscribe;
  }, [task?.id]);

  if (!task) return <div className="mc-v2-empty">{agentContext.getUiCopy("mcTaskEmpty")}</div>;

  const visibleLearningProgress = [...learningProgress].sort((a, b) => b.completedAt - a.completedAt);
  const assignedAgent = task.assignedAgentRoleId
    ? agents.find((agent) => agent.id === task.assignedAgentRoleId) || null
    : null;
  const currentLabels = getTaskLabels(task);
  const availableLabels = taskLabels.filter((label) => !task.labels?.includes(label.id));
  const attentionReason = getTaskAttentionReason(task);
  const dueInfo = getTaskDueInfo(task.dueDate);
  const priority = getTaskPriorityMeta(task.priority);
  const estimate = formatTaskEstimate(task.estimatedMinutes);
  const stale = isTaskStale(task);
  const terminal = isTaskTerminal(task);
  const nextMissionColumn = getTaskNextMissionColumn(task);
  const nextMissionLabel = BOARD_COLUMNS.find((column) => column.id === nextMissionColumn)?.label || "Done";
  const ownerStatus = assignedAgent ? getAgentStatus(assignedAgent.id) : "offline";

  return (
    <>
      <div>
        <div className="mc-v2-task-detail-title">
          <h3>{task.title}</h3>
          {isAllWorkspacesSelected && (
            <span className="mc-v2-workspace-tag">{getWorkspaceName(task.workspaceId)}</span>
          )}
          <span className={`mc-v2-status-pill status-${task.status}`}>{task.status.replace("_", " ")}</span>
        </div>
        <div className="mc-v2-detail-updated">
          {agentContext.getUiCopy("mcTaskUpdatedAt", { time: formatRelativeTime(task.updatedAt) })}
        </div>
        {attentionReason && <div className="mc-v2-task-reason">{attentionReason}</div>}
      </div>

      <div className="mc-v2-task-action-row">
        {assignedAgent && !terminal && (
          <button className="mc-v2-task-primary-action" onClick={() => handleTriggerHeartbeat(assignedAgent.id)}>
            <Zap size={14} />
            Wake owner
          </button>
        )}
        {!terminal && getMissionColumnForTask(task) !== "done" && (
          <button className="mc-v2-task-primary-action" onClick={() => handleMoveTask(task.id, nextMissionColumn)}>
            <ArrowRight size={14} />
            Move to {nextMissionLabel}
          </button>
        )}
        {!terminal && (
          <button
            className="mc-v2-task-primary-action"
            onClick={() => {
              const dueDate = new Date();
              dueDate.setHours(23, 59, 59, 999);
              handleSetTaskDueDate(task.id, dueDate.getTime());
            }}
          >
            <Calendar size={14} />
            Due today
          </button>
        )}
      </div>

      <div className="mc-v2-task-summary-grid">
        <div className="mc-v2-task-summary-item">
          <span>Owner</span>
          <strong>{assignedAgent ? assignedAgent.displayName : "Unassigned"}</strong>
          {assignedAgent && <small className={`mc-v2-summary-status ${ownerStatus}`}>{ownerStatus}</small>}
        </div>
        <div className="mc-v2-task-summary-item">
          <span>Priority</span>
          <strong>{priority.label}</strong>
        </div>
        <div className="mc-v2-task-summary-item">
          <span>Due</span>
          <strong>{dueInfo?.label || "Not set"}</strong>
        </div>
        <div className="mc-v2-task-summary-item">
          <span>Estimate</span>
          <strong>{estimate || "Not set"}</strong>
        </div>
        <div className="mc-v2-task-summary-item">
          <span>Health</span>
          <strong>{stale ? "Stale" : terminal ? "Closed" : "Active"}</strong>
        </div>
        <div className="mc-v2-task-summary-item">
          <span>Labels</span>
          <strong>{currentLabels.length > 0 ? currentLabels.length : "None"}</strong>
        </div>
      </div>

      <div className="mc-v2-detail-meta mc-v2-detail-meta-wide">
        <label>
          {agentContext.getUiCopy("mcTaskAssigneeLabel")}
          <select
            value={task.assignedAgentRoleId || ""}
            onChange={(e) => handleAssignTask(task.id, e.target.value || null)}
          >
            <option value="">{agentContext.getUiCopy("mcTaskUnassigned")}</option>
            {agents.filter((agent) => agent.isActive).map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          {agentContext.getUiCopy("mcTaskStageLabel")}
          <select value={getMissionColumnForTask(task)} onChange={(e) => handleMoveTask(task.id, e.target.value)}>
            {BOARD_COLUMNS.map((column) => (
              <option key={column.id} value={column.id}>
                {column.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Priority
          <select
            value={String(task.priority ?? 0)}
            onChange={(e) => handleSetTaskPriority(task.id, Number(e.target.value))}
          >
            {TASK_PRIORITY_OPTIONS.map((option) => (
              <option key={option.value} value={String(option.value)}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Estimate
          <select
            value={task.estimatedMinutes ? String(task.estimatedMinutes) : ""}
            onChange={(e) => handleSetTaskEstimate(task.id, e.target.value ? Number(e.target.value) : null)}
          >
            {ESTIMATE_OPTIONS.map((option) => (
              <option key={option.label} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Due date
          <input
            type="date"
            value={task.dueDate ? new Date(task.dueDate).toISOString().slice(0, 10) : ""}
            onChange={(e) => {
              if (!e.target.value) {
                handleSetTaskDueDate(task.id, null);
                return;
              }
              const dueDate = new Date(e.target.value);
              dueDate.setHours(23, 59, 59, 999);
              handleSetTaskDueDate(task.id, dueDate.getTime());
            }}
          />
        </label>
        <label className="mc-v2-detail-label-manager">
          <span>
            <Tag size={12} />
            Labels
          </span>
          <div className="mc-v2-detail-label-controls">
            <select value={labelToAdd} onChange={(e) => setLabelToAdd(e.target.value)}>
              <option value="">Add label</option>
              {availableLabels.map((label) => (
                <option key={label.id} value={label.id}>
                  {label.name}
                </option>
              ))}
            </select>
            <button
              className="mc-v2-task-secondary-btn"
              onClick={() => {
                if (!labelToAdd) return;
                handleAddTaskLabel(task.id, labelToAdd);
                setLabelToAdd("");
              }}
              disabled={!labelToAdd}
            >
              Add
            </button>
          </div>
        </label>
      </div>

      <div className="mc-v2-detail-section">
        <div className="mc-v2-section-header">
          <h4>Task controls</h4>
          <span className="mc-v2-section-hint">Move it forward without leaving the detail panel.</span>
        </div>
        <div className="mc-v2-label-list">
          {currentLabels.length === 0 ? (
            <span className="mc-v2-empty-inline">No labels yet.</span>
          ) : (
            currentLabels.map((label) => (
              <span
                key={label.id}
                className="mc-v2-label-pill"
                style={{ backgroundColor: `${label.color}22`, borderColor: `${label.color}44`, color: label.color }}
              >
                {label.name}
                <button
                  className="mc-v2-label-remove"
                  onClick={() => handleRemoveTaskLabel(task.id, label.id)}
                  title={`Remove ${label.name}`}
                >
                  <X size={10} />
                </button>
              </span>
            ))
          )}
        </div>
      </div>

      <div className="mc-v2-detail-section mc-v2-detail-section-brief">
        <h4 className="mc-v2-detail-brief-title">{agentContext.getUiCopy("mcTaskBriefTitle")}</h4>
        <div className="mc-v2-detail-brief-scroll">
          <p className="mc-v2-detail-brief">{task.prompt}</p>
        </div>
      </div>

      <div className="mc-v2-detail-section mc-v2-learning-section">
        <div className="mc-v2-section-header">
          <h4>What Cowork learned</h4>
          <span className="mc-v2-section-hint">
            Memory, playbook, and skill promotion are tracked here after every task.
          </span>
        </div>
        {learningLoading && learningProgress.length === 0 ? (
          <div className="mc-v2-empty">Loading task learning progress...</div>
        ) : learningError ? (
          <div className="mc-v2-error">{learningError}</div>
        ) : visibleLearningProgress.length > 0 ? (
          <div className="mc-v2-learning-list">
            {visibleLearningProgress.map((progress) => (
              <article key={progress.id} className="mc-v2-learning-card">
                <div className="mc-v2-learning-card-header">
                  <div>
                    <div className="mc-v2-learning-outcome">
                      <span className={`mc-v2-status-pill ${statusTone(progress.outcome)}`}>{progress.outcome.replace("_", " ")}</span>
                      <span className="mc-v2-learning-time">{formatRelativeTime(progress.completedAt)}</span>
                    </div>
                    <h5>{progress.summary}</h5>
                  </div>
                  <div className="mc-v2-learning-next">
                    <span>Next</span>
                    <strong>{progress.nextAction || "No follow-up required"}</strong>
                  </div>
                </div>

                <div className="mc-v2-learning-steps">
                  {progress.steps.map((step) => (
                    <section key={`${progress.id}:${step.stage}`} className={`mc-v2-learning-step mc-v2-learning-step-${step.status}`}>
                      <div className="mc-v2-learning-step-header">
                        <strong>{step.title}</strong>
                        <span className={`mc-v2-status-pill ${statusTone(step.status)}`}>{step.status}</span>
                      </div>
                      <p>{step.summary}</p>
                      {step.relatedIds && (
                        <div className="mc-v2-learning-related">
                          {step.relatedIds.memoryId && <span>Memory: {step.relatedIds.memoryId}</span>}
                          {step.relatedIds.proposalId && <span>Proposal: {step.relatedIds.proposalId}</span>}
                          {step.relatedIds.skillId && <span>Skill: {step.relatedIds.skillId}</span>}
                        </div>
                      )}
                      {step.evidenceRefs.length > 0 && (
                        <ul className="mc-v2-learning-evidence">
                          {step.evidenceRefs.map((ref) => (
                            <li key={ref.evidenceId}>
                              <span className="mc-v2-learning-evidence-source">{ref.sourceType}</span>
                              <span>{renderEvidenceLabel(ref)}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                  ))}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="mc-v2-empty">No learning progress has been recorded for this task yet.</div>
        )}
      </div>

      <div className="mc-v2-detail-section mc-v2-recall-section">
        <div className="mc-v2-section-header">
          <h4>Search everything</h4>
          <span className="mc-v2-section-hint">
            Tasks, messages, files, workspace notes, memory, screen context, and knowledge graph.
          </span>
        </div>
        <form
          className="mc-v2-recall-search"
          onSubmit={(event) => {
            event.preventDefault();
            void loadRecall();
          }}
        >
          <input
            type="search"
            className="mc-v2-recall-input"
            placeholder="Search Cowork memory, tasks, messages, and files"
            value={recallQuery}
            onChange={(e) => setRecallQuery(e.target.value)}
          />
          <select
            className="mc-v2-recall-source"
            value={recallSource}
            onChange={(e) => setRecallSource(e.target.value as UnifiedRecallSourceType | "")}
          >
            <option value="">All sources</option>
            {UNIFIED_RECALL_SOURCES.map((source) => (
              <option key={source.value} value={source.value}>
                {source.label}
              </option>
            ))}
          </select>
          <button type="submit" className="mc-v2-recall-submit" disabled={recallLoading}>
            {recallLoading ? "Searching..." : "Search"}
          </button>
        </form>
        {recallError && <div className="mc-v2-error">{recallError}</div>}
        {recallResults.length > 0 ? (
          <div className="mc-v2-recall-results">
            {recallResults.map((result) => (
              <article key={`${result.sourceType}:${result.objectId}`} className="mc-v2-recall-result">
                <div className="mc-v2-recall-result-header">
                  <div>
                    <strong>{result.title || result.sourceLabel || result.sourceType}</strong>
                    <div className="mc-v2-recall-result-meta">
                      <span>{result.sourceLabel || result.sourceType}</span>
                      <span>{formatRelativeTime(result.timestamp)}</span>
                      {typeof result.rank === "number" && <span>Rank {result.rank.toFixed(2)}</span>}
                    </div>
                  </div>
                  <span className="mc-v2-status-pill status-info">{result.sourceType}</span>
                </div>
                <p>{result.snippet}</p>
                {result.workspaceId && (
                  <div className="mc-v2-recall-result-foot">
                    Workspace: {getWorkspaceName(result.workspaceId)}
                  </div>
                )}
              </article>
            ))}
          </div>
        ) : (
          <div className="mc-v2-empty">
            {recallLoading
              ? "Searching Cowork memory..."
              : "Search everything to pull a single unified result list across tasks, messages, files, notes, memory, screen context, and the knowledge graph."}
          </div>
        )}
      </div>

      <div className="mc-v2-detail-section">
        <h4>{agentContext.getUiCopy("mcTaskUpdatesTitle")}</h4>
        {taskWorkspaceId && (
          <ActivityFeed workspaceId={taskWorkspaceId} taskId={task.id} compact maxItems={20} showFilters={false} />
        )}
        <div className="mc-v2-comment-box">
          <textarea
            placeholder={agentContext.getUiCopy("mcTaskUpdatePlaceholder")}
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            rows={3}
          />
          <button
            className="mc-v2-comment-submit"
            onClick={handlePostComment}
            disabled={postingComment || commentText.trim().length === 0}
          >
            {postingComment ? agentContext.getUiCopy("mcTaskPosting") : agentContext.getUiCopy("mcTaskPostUpdate")}
          </button>
        </div>
      </div>

      <div className="mc-v2-detail-section">
        <h4>{agentContext.getUiCopy("mcTaskMentionsTitle")}</h4>
        {taskWorkspaceId && (
          <>
            <MentionInput
              workspaceId={taskWorkspaceId}
              taskId={task.id}
              placeholder={agentContext.getUiCopy("mcTaskMentionPlaceholder")}
            />
            <MentionList workspaceId={taskWorkspaceId} taskId={task.id} />
          </>
        )}
      </div>
    </>
  );
}
