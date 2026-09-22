import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Bell, Check, Copy, MessagesSquare, PanelRightClose, Settings2 } from "lucide-react";
import { BotGlyph } from "./BotGlyph";
import { DEFAULT_BOT_COLOR } from "../utils/bot-colors";
import type { BotNotificationPolicy, Task, TaskStatus } from "../../shared/types";
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
    "state" | "stateLabel" | "stateDetail"
  > | null;
  onEdit?: () => void;
  onOpenHistory?: () => void;
  onClose?: () => void;
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

export function BotDetailsRail({
  task,
  conversationProjection,
  onEdit,
  onOpenHistory,
  onClose,
}: BotDetailsRailProps) {
  const [role, setRole] = useState<AgentRoleData | null>(null);
  const [policy, setPolicy] = useState<BotNotificationPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const roleId = task.assignedAgentRoleId || "";
  const botName = role?.displayName || task.assignedAgentRoleId || "Bot";
  const description = role?.description?.trim() || "";
  const conversationStatusLabel =
    conversationProjection?.stateLabel || getBotStatusLabel(task.status);
  const conversationStatusTone = conversationProjection
    ? getBotStatusTone(conversationProjection.state)
    : getBotStatusTone(task.status);
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
      window.electronAPI.getBotNotificationPolicy(roleId).catch(() => null),
    ])
      .then(([loadedRole, loadedPolicy]) => {
        if (cancelled) return;
        setRole(loadedRole || null);
        setPolicy(
          loadedPolicy || {
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
        new CustomEvent("cowork:bot-notification-policy-updated", { detail: updated }),
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
          className="bot-details-rail-icon"
          /* Role colours are data, so they have to reach CSS as a variable. */
          style={{ "--bot-role-color": role?.color || DEFAULT_BOT_COLOR } as CSSProperties}
          aria-hidden="true"
        >
          <BotGlyph size={17} weight="fill" />
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
            checked={policy?.onFinish ?? true}
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
            checked={policy?.onInputRequired ?? true}
            disabled={savingPolicy || !policy}
            onChange={(event) => void updatePolicy({ onInputRequired: event.target.checked })}
          />
        </label>
      </section>

      {error ? (
        <div className="bot-details-error" role="alert">
          {error}
        </div>
      ) : null}
    </aside>
  );
}
