import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Bell,
  Check,
  Copy,
  Monitor,
  MessagesSquare,
  PanelRightClose,
  RefreshCw,
  Settings2,
} from "lucide-react";
import { BotGlyph } from "./BotGlyph";
import { DEFAULT_BOT_COLOR } from "../utils/bot-colors";
import type { BotNotificationPolicy, Task, TaskStatus, Workspace } from "../../shared/types";
import type { AgentRoleData } from "../../electron/preload";
import "./BotDetailsRail.css";

export interface BotDetailsRailProps {
  task: Task;
  workspace: Workspace | null;
  onEdit?: () => void;
  onOpenHistory?: () => void;
  onOpenComputerSettings?: () => void;
  onClose?: () => void;
}

export interface HostComputerStatusSnapshot {
  platform?: string;
  installed?: boolean;
  accessibilityTrusted?: boolean;
  screenCaptureStatus?: string;
  error?: string | null;
}

export function isHostComputerReady(
  status: HostComputerStatusSnapshot | null | undefined,
): boolean {
  if (!status?.installed || status.error) return false;
  if (status.platform !== "darwin" && status.platform !== "win32") return false;
  return status.accessibilityTrusted === true && status.screenCaptureStatus === "granted";
}

export function getHostComputerStatusLabel(
  activeTaskId: string | null | undefined,
  currentTaskId: string,
  ready = true,
): string {
  if (activeTaskId === currentTaskId) return "In use by this conversation";
  if (activeTaskId) return "In use by another task";
  if (!ready) return "Needs setup on this computer";
  return "Available when this bot needs it";
}

/**
 * The status pill used a single hard-coded green, which read as "healthy" even
 * for failures. Map each status onto a tone so the colour matches the meaning.
 */
export function getBotStatusTone(status: TaskStatus | string): "busy" | "good" | "bad" | "idle" {
  switch (status) {
    case "planning":
    case "executing":
      return "busy";
    case "completed":
      return "good";
    case "failed":
    case "blocked":
      return "bad";
    default:
      return "idle";
  }
}

export function BotDetailsRail({
  task,
  workspace,
  onEdit,
  onOpenHistory,
  onOpenComputerSettings,
  onClose,
}: BotDetailsRailProps) {
  const [role, setRole] = useState<AgentRoleData | null>(null);
  const [policy, setPolicy] = useState<BotNotificationPolicy | null>(null);
  const [computerStatus, setComputerStatus] = useState<Awaited<
    ReturnType<typeof window.electronAPI.getComputerUseStatus>
  > | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const roleId = task.assignedAgentRoleId || "";
  const botName = role?.displayName || task.assignedAgentRoleId || "Bot";
  const description = role?.description?.trim() || "";
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
      window.electronAPI.getComputerUseStatus().catch(() => null),
    ])
      .then(([loadedRole, loadedPolicy, loadedComputerStatus]) => {
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
        setComputerStatus(loadedComputerStatus || null);
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

  const refreshComputerStatus = async () => {
    setRefreshing(true);
    try {
      setComputerStatus(await window.electronAPI.getComputerUseStatus());
    } catch {
      // The rail still renders the last known status when the helper is unavailable.
    } finally {
      setRefreshing(false);
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
          <span className={`bot-details-status ${getBotStatusTone(task.status)}`}>
            {task.status}
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

      <section className="bot-details-section">
        <h3 className="bot-details-section-heading">
          <Monitor size={13} />
          <span>This computer</span>
        </h3>
        <div className="bot-details-computer-status">
          <span
            className={`bot-details-status-dot ${computerStatus?.activeTaskId ? "active" : ""}`}
            aria-hidden="true"
          />
          <span>
            {getHostComputerStatusLabel(
              computerStatus?.activeTaskId,
              task.id,
              isHostComputerReady(computerStatus),
            )}
          </span>
        </div>
        <small className="bot-details-computer-note">
          Uses the computer running CoWork OS{workspace?.name ? ` in ${workspace.name}` : ""}.
          Desktop access follows your local permissions.
        </small>
        {computerStatus?.error ? (
          <small className="bot-details-computer-note bot-details-computer-note-warning">
            {computerStatus.error}
          </small>
        ) : null}
        <div className="bot-details-computer-actions">
          {onOpenComputerSettings && (
            <button
              type="button"
              className="bot-details-secondary-button"
              onClick={onOpenComputerSettings}
            >
              <Settings2 size={13} /> Computer use settings
            </button>
          )}
          <button
            type="button"
            className="bot-details-icon-button"
            onClick={() => void refreshComputerStatus()}
            aria-label="Refresh computer status"
            title="Refresh status"
          >
            <RefreshCw size={14} className={refreshing ? "bot-details-spin" : undefined} />
          </button>
        </div>
      </section>

      {error ? (
        <div className="bot-details-error" role="alert">
          {error}
        </div>
      ) : null}
    </aside>
  );
}
