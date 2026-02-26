import { useState, useEffect, useCallback } from "react";
import {
  ActivityData,
  ActivityType,
  ActivityActorType,
  ActivityEvent,
} from "../../electron/preload";
import { ActivityFeedItem } from "./ActivityFeedItem";
import { useAgentContext } from "../hooks/useAgentContext";

interface ActivityFeedProps {
  workspaceId: string;
  taskId?: string;
  compact?: boolean;
  maxItems?: number;
  showFilters?: boolean;
}

const ACTIVITY_TYPE_LABELS: Partial<Record<ActivityType, string>> = {
  task_created: "Task Created",
  task_started: "Task Started",
  task_completed: "Task Completed",
  task_failed: "Task Failed",
  task_paused: "Decision checkpoint",
  task_resumed: "Task resumed",
  comment: "Comment",
  file_created: "File Created",
  file_modified: "File Modified",
  command_executed: "Command",
  tool_used: "Tool Used",
  mention: "Mention",
  agent_assigned: "Agent Assigned",
  error: "Error",
  info: "Info",
};

export function ActivityFeed({
  workspaceId,
  taskId,
  compact = false,
  maxItems = 50,
  showFilters = true,
}: ActivityFeedProps) {
  const [activities, setActivities] = useState<ActivityData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<ActivityType | "">("");
  const [filterActor, setFilterActor] = useState<ActivityActorType | "">("");
  const [showUnreadOnly, setShowUnreadOnly] = useState(false);
  const agentContext = useAgentContext();

  const loadActivities = useCallback(async () => {
    try {
      setLoading(true);
      const query: Any = {
        workspaceId,
        limit: maxItems,
      };

      if (taskId) {
        query.taskId = taskId;
      }

      if (filterType) {
        query.activityType = filterType;
      }

      if (filterActor) {
        query.actorType = filterActor;
      }

      if (showUnreadOnly) {
        query.isRead = false;
      }

      const result = await window.electronAPI.listActivities(query);
      setActivities(result);
      setError(null);
    } catch (err: Any) {
      setError(err.message || "Failed to load activities");
      console.error("Failed to load activities:", err);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, taskId, maxItems, filterType, filterActor, showUnreadOnly]);

  useEffect(() => {
    loadActivities();
  }, [loadActivities]);

  // Subscribe to real-time activity events
  useEffect(() => {
    const unsubscribe = window.electronAPI.onActivityEvent((event: ActivityEvent) => {
      switch (event.type) {
        case "created":
          if (event.activity && event.activity.workspaceId === workspaceId) {
            setActivities((prev) => [event.activity!, ...prev].slice(0, maxItems));
          }
          break;
        case "read":
          setActivities((prev) =>
            prev.map((a) => (a.id === event.id ? { ...a, isRead: true } : a)),
          );
          break;
        case "all_read":
          if (event.workspaceId === workspaceId) {
            setActivities((prev) => prev.map((a) => ({ ...a, isRead: true })));
          }
          break;
        case "pinned":
          if (event.activity) {
            setActivities((prev) =>
              prev.map((a) => (a.id === event.activity!.id ? event.activity! : a)),
            );
          }
          break;
        case "deleted":
          setActivities((prev) => prev.filter((a) => a.id !== event.id));
          break;
      }
    });

    return () => unsubscribe();
  }, [workspaceId, maxItems]);

  const handleMarkRead = async (id: string) => {
    try {
      await window.electronAPI.markActivityRead(id);
    } catch (err) {
      console.error("Failed to mark activity as read:", err);
    }
  };

  const handlePin = async (id: string) => {
    try {
      await window.electronAPI.pinActivity(id);
    } catch (err) {
      console.error("Failed to pin activity:", err);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await window.electronAPI.deleteActivity(id);
    } catch (err) {
      console.error("Failed to delete activity:", err);
    }
  };

  const handleMarkAllRead = async () => {
    try {
      await window.electronAPI.markAllActivitiesRead(workspaceId);
    } catch (err) {
      console.error("Failed to mark all as read:", err);
    }
  };

  const unreadCount = activities.filter((a) => !a.isRead).length;

  // Separate pinned and regular activities
  const pinnedActivities = activities.filter((a) => a.isPinned);
  const regularActivities = activities.filter((a) => !a.isPinned);

  if (loading && activities.length === 0) {
    return <div className="activity-loading">{agentContext.getUiCopy("activityLoading")}</div>;
  }

  return (
    <div className="activity-feed">
      {showFilters && (
        <div className="activity-feed-header">
          <div className="activity-feed-title">
            <h4>{agentContext.getUiCopy("activityTitle")}</h4>
            {unreadCount > 0 && <span className="unread-badge">{unreadCount}</span>}
          </div>
          <div className="activity-feed-actions">
            {unreadCount > 0 && (
              <button className="btn-text" onClick={handleMarkAllRead}>
                {agentContext.getUiCopy("activityMarkAllRead")}
              </button>
            )}
          </div>
        </div>
      )}

      {showFilters && (
        <div className="activity-filters">
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value as ActivityType | "")}
          >
            <option value="">{agentContext.getUiCopy("activityAllTypes")}</option>
            {Object.entries(ACTIVITY_TYPE_LABELS).map(([type, label]) => (
              <option key={type} value={type}>
                {label}
              </option>
            ))}
          </select>

          <select
            value={filterActor}
            onChange={(e) => setFilterActor(e.target.value as ActivityActorType | "")}
          >
            <option value="">{agentContext.getUiCopy("activityAllActors")}</option>
            <option value="agent">{agentContext.getUiCopy("activityActorAgent")}</option>
            <option value="user">{agentContext.getUiCopy("activityActorUser")}</option>
            <option value="system">{agentContext.getUiCopy("activityActorSystem")}</option>
          </select>

          <label className="filter-checkbox">
            <input
              type="checkbox"
              checked={showUnreadOnly}
              onChange={(e) => setShowUnreadOnly(e.target.checked)}
            />
            {agentContext.getUiCopy("activityUnreadOnly")}
          </label>
        </div>
      )}

      {error && <div className="activity-error">{error}</div>}

      <div className="activity-list">
        {pinnedActivities.length > 0 && (
          <div className="activity-group">
            <div className="activity-group-title">{agentContext.getUiCopy("activityPinned")}</div>
            {pinnedActivities.map((activity) => (
              <ActivityFeedItem
                key={activity.id}
                activity={activity}
                onMarkRead={handleMarkRead}
                onPin={handlePin}
                onDelete={handleDelete}
                compact={compact}
              />
            ))}
          </div>
        )}

        {regularActivities.length > 0 ? (
          <div className="activity-group">
            {pinnedActivities.length > 0 && (
              <div className="activity-group-title">{agentContext.getUiCopy("activityRecent")}</div>
            )}
            {regularActivities.map((activity) => (
              <ActivityFeedItem
                key={activity.id}
                activity={activity}
                onMarkRead={handleMarkRead}
                onPin={handlePin}
                onDelete={handleDelete}
                compact={compact}
              />
            ))}
          </div>
        ) : (
          pinnedActivities.length === 0 && (
            <div className="activity-empty">
              <p>{agentContext.getUiCopy("activityEmptyTitle")}</p>
              <p className="activity-empty-hint">{agentContext.getUiCopy("activityEmptyHint")}</p>
            </div>
          )
        )}
      </div>

      <style>{`
        .activity-feed {
          display: flex;
          flex-direction: column;
          height: 100%;
        }

        .activity-feed-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 16px;
          border-bottom: 1px solid var(--color-border);
        }

        .activity-feed-title {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .activity-feed-title h4 {
          margin: 0;
          font-size: 14px;
          font-weight: 600;
        }

        .unread-badge {
          background: var(--color-accent);
          color: white;
          font-size: 11px;
          font-weight: 600;
          padding: 2px 6px;
          border-radius: 10px;
          min-width: 18px;
          text-align: center;
        }

        .btn-text {
          background: none;
          border: none;
          color: var(--color-accent);
          font-size: 12px;
          cursor: pointer;
          padding: 4px 8px;
          border-radius: 4px;
        }

        .btn-text:hover {
          background: var(--color-bg-secondary);
        }

        .activity-filters {
          display: flex;
          gap: 8px;
          padding: 12px 16px;
          border-bottom: 1px solid var(--color-border);
        }

        .activity-filters select {
          padding: 6px 10px;
          border: 1px solid var(--color-border);
          border-radius: 6px;
          background: var(--color-bg-primary);
          color: var(--color-text-primary);
          font-size: 12px;
          cursor: pointer;
        }

        .filter-checkbox {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          color: var(--color-text-secondary);
          cursor: pointer;
        }

        .activity-list {
          flex: 1;
          overflow-y: auto;
          padding: 12px 16px;
        }

        .activity-group {
          margin-bottom: 16px;
        }

        .activity-group-title {
          font-size: 11px;
          font-weight: 600;
          color: var(--color-text-muted);
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 8px;
        }

        .activity-group > .activity-feed-item {
          margin-bottom: 8px;
        }

        .activity-empty {
          text-align: center;
          padding: 40px 20px;
          color: var(--color-text-secondary);
        }

        .activity-empty p {
          margin: 0;
        }

        .activity-empty-hint {
          font-size: 12px;
          color: var(--color-text-muted);
          margin-top: 8px !important;
        }

        .activity-error {
          padding: 12px 16px;
          background: color-mix(in srgb, var(--color-error) 10%, var(--color-bg-secondary));
          color: var(--color-error);
          font-size: 13px;
        }

        .activity-loading {
          padding: 40px;
          text-align: center;
          color: var(--color-text-secondary);
        }
      `}</style>
    </div>
  );
}
