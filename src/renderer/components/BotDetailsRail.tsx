import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Bell,
  Check,
  ClipboardList,
  Copy,
  MessagesSquare,
  PanelRightClose,
  Settings2,
} from "lucide-react";
import { BotWorkDialog, type BotWorkDialogTab } from "./BotWorkDialog";
import { BOT_NOTIFICATION_POLICY_UPDATED_EVENT } from "./BotNotificationPanel";
import { hasHostMethods } from "../host/browser-capabilities";
import { BotMascot } from "./bot-mascot/BotMascot";
import {
  mascotExpressionForConversation,
  mascotExpressionForTaskStatus,
} from "./bot-mascot/mascot-expressions";
import { resolveBotMascot } from "../../shared/bot-mascots";
import { DEFAULT_BOT_COLOR } from "../utils/bot-colors";
import type { BotNotificationPolicy, BotWorkView, Task, TaskStatus } from "../../shared/types";
import type { BotConversationProjection } from "../../shared/bot-lifecycle";
import type { AgentRoleData } from "../../electron/preload";
import "./BotDetailsRail.css";

export interface BotDetailsRailProps {
  task: Task;
  /**
   * Bot conversations have a durable collaboration projection that can be
   * ahead of the compatibility task row (for example, a completed-looking
   * row while a teammate reply is still pending). Keep the inspector on that
   * same projection as the conversation header when it is available.
   */
  conversationProjection?: Pick<
    BotConversationProjection,
    "state" | "stateLabel" | "stateDetail" | "activityLabel"
  > | null;
  onEdit?: () => void;
  onOpenHistory?: () => void;
  onClose?: () => void;
  /** Opens a task from the bot's work view. */
  onSelectTask?: (taskId: string | null) => void;
}

/**
 * The status pill used a single hard-coded green, which read as "healthy" even
 * for failures. Map each status onto a tone so the colour matches the meaning.
 */
export function getBotStatusTone(status: TaskStatus | string): "busy" | "good" | "bad" | "idle" {
  switch (status) {
    case "working":
    case "waiting":
    case "planning":
    case "executing":
      return "busy";
    case "completed":
      return "good";
    case "failed":
    case "blocked":
    case "needs_input":
    case "interrupted":
      return "bad";
    default:
      return "idle";
  }
}

export function getBotStatusLabel(status: TaskStatus | string): string {
  switch (status) {
    case "working":
      return "Working with the team";
    case "waiting":
      return "Waiting on a teammate";
    case "needs_input":
      return "Needs your input";
    case "pending":
    case "queued":
      return "Ready to start";
    case "planning":
    case "executing":
      return "Working";
    case "paused":
    case "blocked":
    case "interrupted":
      return "Needs input";
    case "completed":
      return "Finished";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return "Ready";
  }
}

export function getBotConversationStatusLabel(
  taskStatus: TaskStatus | string,
  projection?:
    | (Pick<BotConversationProjection, "state" | "stateLabel"> &
        Partial<Pick<BotConversationProjection, "activityLabel">>)
    | null,
): string {
  const activityLabel = projection?.activityLabel?.trim();
  if (
    activityLabel &&
    (projection?.state === "working" ||
      projection?.state === "waiting" ||
      projection?.state === "needs_input" ||
      projection?.state === "failed")
  ) {
    return activityLabel;
  }
  return projection?.stateLabel || getBotStatusLabel(taskStatus);
}

export function BotDetailsRail({
  task,
  conversationProjection,
  onEdit,
  onOpenHistory,
  onClose,
  onSelectTask,
}: BotDetailsRailProps) {
  const [role, setRole] = useState<AgentRoleData | null>(null);
  const [policy, setPolicy] = useState<BotNotificationPolicy | null>(null);
  const [policyUnavailable, setPolicyUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workCounts, setWorkCounts] = useState<Record<BotWorkView, number> | null>(null);
  const [workTab, setWorkTab] = useState<BotWorkDialogTab | null>(null);
  const [workToken, setWorkToken] = useState(0);
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const roleId = task.assignedAgentRoleId || "";
  const botName = role?.displayName || task.assignedAgentRoleId || "Bot";
  const description = role?.description?.trim() || "";
  const conversationStatusLabel = getBotConversationStatusLabel(
    task.status,
    conversationProjection,
  );
  const conversationStatusTone = conversationProjection
    ? getBotStatusTone(conversationProjection.state)
    : getBotStatusTone(task.status);
  const mascot = resolveBotMascot(role?.icon);
  const mascotExpression = conversationProjection
    ? mascotExpressionForConversation(conversationProjection.state)
    : mascotExpressionForTaskStatus(task.status);
  // Only offer the expand affordance for descriptions long enough to be clamped.
  const descriptionIsLong = useMemo(() => description.length > 180, [description]);

  useEffect(() => {
    let cancelled = false;
    if (!roleId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void Promise.all([
      window.electronAPI.getAgentRole(roleId),
      window.electronAPI.getBotNotificationPolicy(roleId).catch(() => "failed" as const),
    ])
      .then(([loadedRole, loadedPolicy]) => {
        if (cancelled) return;
        setRole(loadedRole || null);
        // A failed read must not pose as the defaults: that would show switches the user
        // turned off as on, and let them be saved from a guess.
        setPolicyUnavailable(loadedPolicy === "failed");
        setPolicy(
          loadedPolicy === "failed"
            ? null
            : loadedPolicy || {
                agentRoleId: roleId,
                onFinish: true,
                onInputRequired: true,
                updatedAt: 0,
              },
        );
        setError(null);
      })
      .catch((cause) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : "Could not load bot details.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [roleId, task.id]);

  useEffect(() => {
    setDescriptionExpanded(false);
  }, [roleId]);

  // The bot's work at a glance; the full view opens in the work dialog.
  const workAvailable = Boolean(onSelectTask && task.workspaceId && hasHostMethods("listBotWork"));
  useEffect(() => {
    if (!workAvailable || !roleId) return;
    let cancelled = false;
    void window.electronAPI
      .listBotWork({
        workspaceId: task.workspaceId,
        agentRoleId: roleId,
        view: "needs_you",
        limit: 1,
      })
      .then((page) => {
        if (!cancelled) setWorkCounts(page.counts);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [workAvailable, roleId, task.workspaceId, task.status, workToken]);

  // The Setup tab edits the same toggles; follow its changes.
  useEffect(() => {
    const onUpdated = (event: Event) => {
      const updated = (event as CustomEvent<BotNotificationPolicy>).detail;
      if (updated?.agentRoleId === roleId) setPolicy(updated);
    };
    window.addEventListener(BOT_NOTIFICATION_POLICY_UPDATED_EVENT, onUpdated);
    return () => window.removeEventListener(BOT_NOTIFICATION_POLICY_UPDATED_EVENT, onUpdated);
  }, [roleId]);

  useEffect(() => {
    return () => {
      if (copyResetRef.current) clearTimeout(copyResetRef.current);
    };
  }, []);

  const updatePolicy = async (
    patch: Partial<Pick<BotNotificationPolicy, "onFinish" | "onInputRequired">>,
  ) => {
    if (!roleId || !window.electronAPI.updateBotNotificationPolicy) return;
    setSavingPolicy(true);
    try {
      const updated = await window.electronAPI.updateBotNotificationPolicy({
        agentRoleId: roleId,
        ...patch,
      });
      setPolicy(updated);
      window.dispatchEvent(
        new CustomEvent(BOT_NOTIFICATION_POLICY_UPDATED_EVENT, { detail: updated }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save notification settings.");
    } finally {
      setSavingPolicy(false);
    }
  };

  const copyBotLink = async () => {
    if (!roleId) return;
    try {
      await navigator.clipboard.writeText(`cowork://bots/${roleId}`);
      setCopied(true);
      if (copyResetRef.current) clearTimeout(copyResetRef.current);
      copyResetRef.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("Could not copy the bot link.");
    }
  };

  return (
    <aside className="bot-details-rail" aria-label="Bot details">
      <header className="bot-details-rail-header">
        <span
          className="bot-details-rail-icon bot-details-rail-icon-mascot"
          /* Role colours are data, so they have to reach CSS as a variable. */
          style={{ "--bot-role-color": role?.color || DEFAULT_BOT_COLOR } as CSSProperties}
          aria-hidden="true"
        >
          <BotMascot mascot={mascot} size={34} expression={mascotExpression} />
        </span>
        <div className="bot-details-rail-heading">
          <span className="bot-details-eyebrow">Bot</span>
          <h2 title={botName}>{botName}</h2>
        </div>
        <div className="bot-details-rail-header-actions">
          <button
            type="button"
            className="bot-details-icon-button"
            onClick={() => void copyBotLink()}
            aria-label={copied ? "Bot link copied" : "Copy bot link"}
            title={copied ? "Copied" : "Copy bot link"}
            disabled={!roleId}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
          {onEdit && (
            <button
              type="button"
              className="bot-details-icon-button"
              onClick={onEdit}
              aria-label="Edit bot"
              title="Edit bot"
            >
              <Settings2 size={14} />
            </button>
          )}
          {onClose && (
            <button
              type="button"
              className="bot-details-icon-button"
              onClick={onClose}
              aria-label="Hide bot details"
              title="Hide panel"
            >
              <PanelRightClose size={15} />
            </button>
          )}
        </div>
      </header>

      {loading ? (
        <div className="bot-details-skeleton" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      ) : null}

      {description ? (
        <div className="bot-details-description-block">
          <p className={`bot-details-description${descriptionExpanded ? " expanded" : ""}`}>
            {description}
          </p>
          {descriptionIsLong && (
            <button
              type="button"
              className="bot-details-link"
              aria-expanded={descriptionExpanded}
              onClick={() => setDescriptionExpanded((open) => !open)}
            >
              {descriptionExpanded ? "Show less" : "Show more"}
            </button>
          )}
        </div>
      ) : null}

      {workAvailable && roleId ? (
        <section className="bot-details-section">
          <h3 className="bot-details-section-heading">
            <ClipboardList size={13} />
            <span>Work</span>
          </h3>
          <div className="bot-details-work">
            {(
              [
                ["needs_you", "Needs you"],
                ["working", "Working"],
                ["scheduled", "Scheduled"],
              ] as const
            ).map(([view, label]) => (
              <button
                key={view}
                type="button"
                className={`bot-details-work-count${view === "needs_you" && (workCounts?.needs_you ?? 0) > 0 ? " attention" : ""}`}
                onClick={() => setWorkTab(view)}
              >
                <strong>{workCounts ? workCounts[view] : "–"}</strong>
                <span>{label}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            className="bot-details-link"
            onClick={() => setWorkTab("setup")}
          >
            Responsibilities and setup
          </button>
        </section>
      ) : null}

      <section className="bot-details-section">
        <h3 className="bot-details-section-heading">
          <MessagesSquare size={13} />
          <span>Current conversation</span>
        </h3>
        <div className="bot-details-conversation">
          <strong title={task.title || "Conversation"}>{task.title || "Conversation"}</strong>
          <span
            className={`bot-details-status ${conversationStatusTone}`}
            title={conversationProjection?.stateDetail}
          >
            {conversationStatusLabel}
          </span>
        </div>
        {onOpenHistory && (
          <button type="button" className="bot-details-link" onClick={onOpenHistory}>
            View conversation history
          </button>
        )}
      </section>

      <section className="bot-details-section">
        <h3 className="bot-details-section-heading">
          <Bell size={13} />
          <span>Notifications</span>
        </h3>
        <label className="bot-details-toggle-row">
          <span className="bot-details-toggle-copy">
            <strong>When finished</strong>
            <small>Notify me when this bot completes a run.</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="bot-details-switch"
            checked={policy?.onFinish ?? !policyUnavailable}
            disabled={savingPolicy || !policy}
            onChange={(event) => void updatePolicy({ onFinish: event.target.checked })}
          />
        </label>
        <label className="bot-details-toggle-row">
          <span className="bot-details-toggle-copy">
            <strong>Needs my input</strong>
            <small>Notify me when the bot is blocked or awaiting approval.</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="bot-details-switch"
            checked={policy?.onInputRequired ?? !policyUnavailable}
            disabled={savingPolicy || !policy}
            onChange={(event) => void updatePolicy({ onInputRequired: event.target.checked })}
          />
        </label>
        {policyUnavailable ? (
          <p className="bot-details-hint" role="status">
            Notification settings could not be loaded.
          </p>
        ) : null}
      </section>

      {error ? (
        <div className="bot-details-error" role="alert">
          {error}
        </div>
      ) : null}
      {workTab && onSelectTask && roleId ? (
        <BotWorkDialog
          key={`${task.workspaceId}:${roleId}`}
          workspaceId={task.workspaceId}
          botId={roleId}
          botName={botName}
          botIcon={role?.icon}
          initialTab={workTab}
          onClose={() => {
            setWorkTab(null);
            setWorkToken((value) => value + 1);
          }}
          onSelectTask={onSelectTask}
        />
      ) : null}
    </aside>
  );
}
