import type { MissionControlItem } from "../../../shared/types";
import type { MissionControlData } from "./useMissionControlData";

interface MCOverviewTabProps {
  data: MissionControlData;
}

const CATEGORY_LABELS: Record<string, string> = {
  attention: "Attention",
  work: "Work",
  reviews: "Reviews",
  learnings: "Learnings",
  awareness: "Awareness",
  evidence: "Evidence",
};

function itemTone(item: MissionControlItem): string {
  if (item.severity === "failed") return "danger";
  if (item.severity === "action_needed") return "attention";
  if (item.severity === "successful") return "healthy";
  return "";
}

function BriefItem({
  item,
  formatRelativeTime,
  onOpenTask,
}: {
  item: MissionControlItem;
  formatRelativeTime: MissionControlData["formatRelativeTime"];
  onOpenTask: (taskId: string) => void;
}) {
  return (
    <article
      className={`mc-v2-brief-item ${itemTone(item)}`}
      onClick={() => {
        if (item.taskId) onOpenTask(item.taskId);
      }}
      style={item.taskId ? { cursor: "pointer" } : undefined}
    >
      <div className="mc-v2-brief-item-top">
        <span className="mc-v2-brief-kicker">{CATEGORY_LABELS[item.category]}</span>
        <span className="mc-v2-feed-time">{formatRelativeTime(item.timestamp)}</span>
      </div>
      <h3>{item.title}</h3>
      <p>{item.summary}</p>
      {(item.decision || item.nextStep) && (
        <div className="mc-v2-brief-disposition">
          {item.decision && <span>{item.decision}</span>}
          {item.nextStep && <strong>{item.nextStep}</strong>}
        </div>
      )}
    </article>
  );
}

function BriefSection({
  title,
  items,
  empty,
  formatRelativeTime,
  onOpenTask,
}: {
  title: string;
  items: MissionControlItem[];
  empty: string;
  formatRelativeTime: MissionControlData["formatRelativeTime"];
  onOpenTask: (taskId: string) => void;
}) {
  return (
    <section className="mc-v2-brief-section">
      <div className="mc-v2-brief-section-header">
        <h2>{title}</h2>
        <span>{items.length}</span>
      </div>
      {items.length === 0 ? (
        <div className="mc-v2-empty mc-v2-empty-compact">{empty}</div>
      ) : (
        <div className="mc-v2-brief-list">
          {items.map((item) => (
            <BriefItem
              key={item.id}
              item={item}
              formatRelativeTime={formatRelativeTime}
              onOpenTask={onOpenTask}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function formatRuntimeQueueValue(
  state: MissionControlData["queueStatusState"],
  running: number,
  waiting: number,
  maxConcurrent: number,
): string {
  if (state === "loading") return "Loading";
  if (state === "unavailable" || state === "error") return "Unavailable";
  if (running === 0 && waiting === 0) return "All clear";
  const runningLabel =
    maxConcurrent > 0 ? `${running}/${maxConcurrent} running` : `${running} running`;
  return waiting > 0 ? `${runningLabel} · ${waiting} waiting` : runningLabel;
}

function RuntimeTaskList({
  title,
  taskIds,
  tasks,
  formatRelativeTime,
  onOpenTask,
}: {
  title: string;
  taskIds: string[];
  tasks: MissionControlData["runtimeRunningTasks"];
  formatRelativeTime: MissionControlData["formatRelativeTime"];
  onOpenTask: (taskId: string) => void;
}) {
  if (taskIds.length === 0) return null;
  const taskById = new Map(tasks.map((task) => [task.id, task] as const));

  return (
    <div className="mc-v2-runtime-list-group">
      <h3>{title}</h3>
      <div className="mc-v2-runtime-list">
        {taskIds.slice(0, 4).map((taskId, index) => {
          const task = taskById.get(taskId);
          return (
            <button
              key={taskId}
              className="mc-v2-runtime-task"
              onClick={() => {
                if (task) onOpenTask(task.id);
              }}
              disabled={!task}
              title={
                task
                  ? "Open task details"
                  : "Task is outside the current Mission Control workspace filter"
              }
            >
              <span>
                {title === "Waiting" ? `${index + 1}. ` : ""}
                {task?.title || `Task ${taskId.slice(0, 8)}`}
              </span>
              {task ? (
                <em>{formatRelativeTime(task.updatedAt || task.createdAt)}</em>
              ) : (
                <em>outside scope</em>
              )}
            </button>
          );
        })}
      </div>
      {taskIds.length > 4 && (
        <p className="mc-v2-runtime-more">+{taskIds.length - 4} more in chat queue</p>
      )}
    </div>
  );
}

export function MCOverviewTab({ data }: MCOverviewTabProps) {
  const {
    missionControlBrief,
    missionControlItems,
    activeAgentsCount,
    totalTasksInQueue,
    pendingMentionsCount,
    queueStatusState,
    runtimeRunningCount,
    runtimeQueuedCount,
    runtimeQueueTotal,
    runtimeMaxConcurrent,
    runtimeRunningTaskIds,
    runtimeQueuedTaskIds,
    runtimeRunningTasks,
    runtimeQueuedTasks,
    commandCenterReviewQueue,
    formatRelativeTime,
    setActiveTab,
    setDetailPanel,
    loadMissionControlIntelligence,
    selectedWorkspaceId,
  } = data;

  const brief = missionControlBrief;
  const attention =
    brief?.sections.find((section) => section.title === "Needs attention")?.items || [];
  const decisions = brief?.latestDecisions || [];
  const learnings = brief?.learningChanges || [];
  const awareness = brief?.awarenessClusters || [];
  const work = brief?.activeWork || [];
  const reviews = brief?.upcomingReviews || [];

  const openTask = (taskId: string) => setDetailPanel({ kind: "task", taskId });
  const runtimeQueueReady = queueStatusState === "ready";
  const runtimeQueueValue = formatRuntimeQueueValue(
    queueStatusState,
    runtimeRunningCount,
    runtimeQueuedCount,
    runtimeMaxConcurrent,
  );
  const focusRuntimeQueue = () => {
    document.getElementById("mc-v2-runtime-queue-card")?.scrollIntoView({
      block: "start",
      behavior: "smooth",
    });
  };

  return (
    <div className="mc-v2-brief">
      <div className="mc-v2-brief-hero">
        <div>
          <h1>Command Brief</h1>
          <p>
            {brief
              ? `Updated ${formatRelativeTime(brief.generatedAt)}`
              : "Preparing grouped brief..."}
          </p>
        </div>
        <div className="mc-v2-brief-actions">
          <button
            className="mc-v2-icon-btn"
            onClick={() => void loadMissionControlIntelligence(selectedWorkspaceId)}
          >
            Refresh brief
          </button>
          <button className="mc-v2-icon-btn" onClick={() => setActiveTab("feed")}>
            Evidence Feed
          </button>
        </div>
      </div>

      <div className="mc-v2-brief-metrics">
        <button
          className="mc-v2-brief-metric"
          onClick={focusRuntimeQueue}
          title="Global tasks currently running or waiting for an execution slot. This matches the queue shown in chat."
        >
          <strong>{runtimeQueueReady ? runtimeQueueTotal : "—"}</strong>
          <span>global runtime queue</span>
          <small>{runtimeQueueValue}</small>
        </button>
        <button className="mc-v2-brief-metric attention" onClick={() => setActiveTab("feed")}>
          <strong>{brief?.attentionCount ?? 0}</strong>
          <span>need attention</span>
        </button>
        <button
          className="mc-v2-brief-metric"
          onClick={() => setActiveTab("board")}
          title="Open work items tracked on the Mission Control board. This can differ from the live runtime queue."
        >
          <strong>{brief?.activeWorkCount ?? totalTasksInQueue}</strong>
          <span>open board work</span>
        </button>
        <button className="mc-v2-brief-metric" onClick={() => setActiveTab("intelligence")}>
          <strong>{brief?.learningCount ?? 0}</strong>
          <span>learnings</span>
        </button>
        <button className="mc-v2-brief-metric" onClick={() => setActiveTab("intelligence")}>
          <strong>{brief?.awarenessCount ?? 0}</strong>
          <span>awareness</span>
        </button>
        <button className="mc-v2-brief-metric" onClick={() => setActiveTab("feed")}>
          <strong>{brief?.evidenceCount ?? 0}</strong>
          <span>evidence rows</span>
        </button>
      </div>

      <div className="mc-v2-brief-system-row">
        <span title="Agents enabled for Heartbeat monitoring or automation. They may be idle.">
          {activeAgentsCount} heartbeat agents
        </span>
        <span title="Global runtime queue from the task executor.">
          Global runtime: {runtimeQueueValue}
        </span>
        <span>{pendingMentionsCount} pending mentions</span>
        <span>{commandCenterReviewQueue.length} output reviews</span>
        <span>{missionControlItems.length} grouped items</span>
      </div>

      <section id="mc-v2-runtime-queue-card" className="mc-v2-runtime-card">
        <div>
          <h2>Global Runtime Queue</h2>
          <p>
            {queueStatusState === "loading"
              ? "Loading the runtime queue from the task executor."
              : queueStatusState === "unavailable" || queueStatusState === "error"
                ? "Runtime queue status is unavailable, so Mission Control cannot confirm whether tasks are running or waiting."
                : runtimeQueueTotal === 0
                  ? "No tasks are running or waiting for an execution slot."
                  : `${runtimeRunningCount} running and ${runtimeQueuedCount} waiting globally in the same queue shown in chat.`}
          </p>
        </div>
        <div className="mc-v2-runtime-groups">
          <RuntimeTaskList
            title="Running"
            taskIds={runtimeRunningTaskIds}
            tasks={runtimeRunningTasks}
            formatRelativeTime={formatRelativeTime}
            onOpenTask={openTask}
          />
          <RuntimeTaskList
            title="Waiting"
            taskIds={runtimeQueuedTaskIds}
            tasks={runtimeQueuedTasks}
            formatRelativeTime={formatRelativeTime}
            onOpenTask={openTask}
          />
        </div>
      </section>

      {runtimeQueueReady && totalTasksInQueue === 0 && runtimeQueueTotal > 0 && (
        <div className="mc-v2-context-empty">
          <strong>No open board work.</strong>
          <span>
            Mission Control board work is tracked separately from the global runtime queue. The
            runtime queue currently has {runtimeRunningCount} running and {runtimeQueuedCount}{" "}
            waiting.
          </span>
        </div>
      )}

      {runtimeQueueReady &&
        totalTasksInQueue === 0 &&
        runtimeQueueTotal === 0 &&
        activeAgentsCount > 0 && (
          <div className="mc-v2-context-empty">
            <strong>{activeAgentsCount} Heartbeat agents are enabled and idle.</strong>
            <span>
              They can monitor signals, create suggestions, or dispatch work when configured.
            </span>
          </div>
        )}

      <div className="mc-v2-brief-grid">
        <BriefSection
          title="Needs Attention"
          items={attention}
          empty="No action-needed items right now."
          formatRelativeTime={formatRelativeTime}
          onOpenTask={openTask}
        />
        <BriefSection
          title="Latest Decisions"
          items={decisions}
          empty="No recent decisions have been recorded."
          formatRelativeTime={formatRelativeTime}
          onOpenTask={openTask}
        />
        <BriefSection
          title="Learnings"
          items={learnings}
          empty="No new learnings yet."
          formatRelativeTime={formatRelativeTime}
          onOpenTask={openTask}
        />
        <BriefSection
          title="Awareness"
          items={awareness}
          empty="No grouped awareness signals yet."
          formatRelativeTime={formatRelativeTime}
          onOpenTask={openTask}
        />
        <BriefSection
          title="Active Work"
          items={work}
          empty="No active grouped work items."
          formatRelativeTime={formatRelativeTime}
          onOpenTask={openTask}
        />
        <BriefSection
          title="Upcoming Reviews"
          items={reviews}
          empty="No scheduled review notes yet."
          formatRelativeTime={formatRelativeTime}
          onOpenTask={openTask}
        />
      </div>
    </div>
  );
}
