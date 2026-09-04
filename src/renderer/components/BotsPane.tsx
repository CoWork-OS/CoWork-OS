import { useMemo, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, Bot, CircleDashed, LoaderCircle, Plus, Search, X } from "lucide-react";
import type { Task } from "../../shared/types";
import { stripAllEmojis } from "../utils/emoji-replacer";
import { LUCIDE_TWIN_ICONS, TWIN_ICON_KEYS, type TwinIconKey } from "../utils/twin-icons";

export interface BotRole {
  id: string;
  name?: string;
  displayName: string;
  description?: string;
  roleKind?: string;
  sourceTemplateId?: string;
  color?: string;
  icon?: string;
  isActive?: boolean;
  isSystem?: boolean;
  sortOrder?: number;
  updatedAt?: number;
}

interface BotsPaneProps {
  roles: BotRole[];
  tasks: Task[];
  selectedTaskId: string | null;
  isLoading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onSelectTask: (id: string | null) => void;
  onOpenBot?: (bot: BotRole) => void | Promise<void>;
  onOpenAgents?: () => void;
  onBotCreated?: (bot: BotRole) => void | Promise<void>;
}

const ACTIVE_BOT_STATUSES: ReadonlySet<Task["status"]> = new Set([
  "executing",
  "planning",
  "interrupted",
]);

const AWAITING_BOT_STATUSES: ReadonlySet<Task["status"]> = new Set(["paused", "blocked"]);

const DEFAULT_BOT_COLOR = "#6366f1";
const DEFAULT_BOT_ICON: TwinIconKey = "Bot";
const MAX_BOT_PREVIEW_LENGTH = 140;

export function isBotConversationTask(task: Task): boolean {
  return task.agentConfig?.botConversation === true;
}

function normalizeBotHandle(value: string): string {
  const normalized = stripAllEmojis(value)
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "bot";
}

function flattenTaskText(value: string | undefined): string {
  return stripAllEmojis(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function getBotLatestTask(tasks: Task[], roleId: string): Task | undefined {
  return tasks
    .filter((task) => task.assignedAgentRoleId === roleId && isBotConversationTask(task))
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))[0];
}

export function getBotPreview(task: Task | undefined): string {
  if (!task) return "No sessions yet";
  const preview =
    flattenTaskText(task.resultSummary) ||
    flattenTaskText(task.sidebarPromptPreview) ||
    flattenTaskText(task.userPrompt) ||
    "No messages yet";
  return preview.length > MAX_BOT_PREVIEW_LENGTH
    ? `${preview.slice(0, MAX_BOT_PREVIEW_LENGTH - 1).trimEnd()}…`
    : preview;
}

export function getBotHandle(bot: BotRole): string {
  return normalizeBotHandle(bot.name || bot.displayName || bot.id);
}

export function getBotRelativeTime(timestamp?: number, now = Date.now()): string {
  if (!timestamp) return "";
  const diff = Math.max(0, now - timestamp);
  const minutes = Math.max(1, Math.round(diff / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.round(days / 7);
  if (weeks < 4) return `${weeks}w`;
  const months = Math.round(days / 30);
  if (months < 12) return `${Math.max(1, months)}mo`;
  return `${Math.max(1, Math.round(days / 365))}y`;
}

export function filterBots(roles: BotRole[], tasks: Task[], query: string): BotRole[] {
  const normalizedQuery = flattenTaskText(query).toLocaleLowerCase();
  if (!normalizedQuery) return roles;

  return roles.filter((bot) => {
    const latestTask = getBotLatestTask(tasks, bot.id);
    const searchableText = [
      bot.displayName,
      bot.name,
      bot.description,
      getBotHandle(bot),
      getBotPreview(latestTask),
    ]
      .map((value) => flattenTaskText(value).toLocaleLowerCase())
      .join(" ");
    return searchableText.includes(normalizedQuery);
  });
}

function getSafeBotIcon(icon: string | undefined) {
  if (icon && TWIN_ICON_KEYS.includes(icon as TwinIconKey)) {
    return LUCIDE_TWIN_ICONS[icon as TwinIconKey];
  }
  return Bot;
}

function getBotTimestamp(bot: BotRole, task: Task | undefined): number {
  return task?.updatedAt || task?.createdAt || bot.updatedAt || 0;
}

function sortBots(roles: BotRole[], tasks: Task[]): BotRole[] {
  return [...roles].sort((a, b) => {
    const aTask = getBotLatestTask(tasks, a.id);
    const bTask = getBotLatestTask(tasks, b.id);
    const aActive = aTask && ACTIVE_BOT_STATUSES.has(aTask.status) ? 1 : 0;
    const bActive = bTask && ACTIVE_BOT_STATUSES.has(bTask.status) ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;

    const activityDifference = getBotTimestamp(b, bTask) - getBotTimestamp(a, aTask);
    if (activityDifference !== 0) return activityDifference;
    return (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.displayName.localeCompare(b.displayName);
  });
}

function BotRow({
  bot,
  latestTask,
  selected,
  onSelect,
  onOpenBot,
  onOpenAgents,
}: {
  bot: BotRole;
  latestTask?: Task;
  selected: boolean;
  onSelect: () => void;
  onOpenBot?: () => void | Promise<void>;
  onOpenAgents?: () => void;
}) {
  const Icon = getSafeBotIcon(bot.icon);
  const isActive = latestTask ? ACTIVE_BOT_STATUSES.has(latestTask.status) : false;
  const isAwaiting = latestTask ? AWAITING_BOT_STATUSES.has(latestTask.status) : false;
  const displayName = flattenTaskText(bot.displayName) || "Unnamed bot";
  const handle = getBotHandle(bot);
  const preview = getBotPreview(latestTask);
  const age = getBotRelativeTime(latestTask?.updatedAt || latestTask?.createdAt || bot.updatedAt);

  return (
    <button
      type="button"
      className={[
        "sidebar-bot-row",
        selected ? "selected" : null,
        bot.isActive === false ? "inactive" : null,
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={onOpenBot || (latestTask ? onSelect : onOpenAgents)}
      aria-current={selected ? "page" : undefined}
      aria-label={`${displayName}, @${handle}${latestTask ? `, ${preview}` : ", no sessions yet"}`}
      title={latestTask ? preview : "Open bot chat"}
    >
      <span
        className="sidebar-bot-avatar"
        style={{ backgroundColor: bot.color || DEFAULT_BOT_COLOR }}
        aria-hidden="true"
      >
        <Icon size={18} strokeWidth={2.1} />
        <span
          className={`sidebar-bot-status ${isActive ? "active" : ""} ${isAwaiting ? "awaiting" : ""}`}
        />
      </span>
      <span className="sidebar-bot-copy">
        <span className="sidebar-bot-primary-line">
          <span className="sidebar-bot-identity">
            <span className="sidebar-bot-name">{displayName}</span>
            <span className="sidebar-bot-handle">@{handle}</span>
          </span>
          {age && <span className="sidebar-bot-age">{age}</span>}
        </span>
        <span className="sidebar-bot-secondary-line">
          <span className="sidebar-bot-preview">{preview}</span>
        </span>
      </span>
    </button>
  );
}

function CreateBotDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (bot: BotRole) => void | Promise<void>;
}) {
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState<TwinIconKey>(DEFAULT_BOT_ICON);
  const [color, setColor] = useState(DEFAULT_BOT_COLOR);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanName = flattenTaskText(displayName);
    if (!cleanName) {
      setError("Enter a name for this bot.");
      return;
    }

    const api = window.electronAPI;
    if (!api?.createAgentRole) {
      setError("Bot creation is unavailable in this session.");
      return;
    }

    setIsCreating(true);
    setError(null);
    try {
      const created = await api.createAgentRole({
        name: normalizeBotHandle(cleanName),
        displayName: cleanName,
        description: flattenTaskText(description) || undefined,
        icon,
        color,
        capabilities: ["code"],
      });
      await onCreated(created);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create this bot.");
    } finally {
      setIsCreating(false);
    }
  };

  return createPortal(
    <div className="sidebar-bot-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <form
        className="sidebar-bot-dialog"
        onSubmit={handleSubmit}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sidebar-create-bot-title"
      >
        <div className="sidebar-bot-dialog-header">
          <div>
            <span className="sidebar-bot-dialog-eyebrow">New bot</span>
            <h3 id="sidebar-create-bot-title">Create a bot</h3>
          </div>
          <button
            type="button"
            className="sidebar-bot-dialog-close"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <label className="sidebar-bot-field">
          <span>Name</span>
          <input
            autoFocus
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="Research bot"
            maxLength={80}
          />
        </label>
        <label className="sidebar-bot-field">
          <span>Description</span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What should this bot help with?"
            maxLength={240}
            rows={2}
          />
        </label>
        <div className="sidebar-bot-field-row">
          <label className="sidebar-bot-field">
            <span>Icon</span>
            <select value={icon} onChange={(event) => setIcon(event.target.value as TwinIconKey)}>
              {TWIN_ICON_KEYS.map((iconKey) => (
                <option key={iconKey} value={iconKey}>
                  {iconKey}
                </option>
              ))}
            </select>
          </label>
          <label className="sidebar-bot-field sidebar-bot-color-field">
            <span>Color</span>
            <input
              type="color"
              value={color}
              onChange={(event) => setColor(event.target.value)}
              aria-label="Bot color"
            />
          </label>
        </div>

        {error && (
          <div className="sidebar-bot-dialog-error" role="alert">
            <AlertCircle size={14} />
            <span>{error}</span>
          </div>
        )}

        <div className="sidebar-bot-dialog-actions">
          <button type="button" className="sidebar-bot-secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="sidebar-bot-primary-button" disabled={isCreating}>
            {isCreating ? <LoaderCircle className="spinning" size={14} /> : <Plus size={14} />}
            {isCreating ? "Creating" : "Create bot"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

export function BotsPane({
  roles,
  tasks,
  selectedTaskId,
  isLoading = false,
  error = null,
  onRetry,
  onSelectTask,
  onOpenBot,
  onOpenAgents,
  onBotCreated,
}: BotsPaneProps) {
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  const visibleBots = useMemo(
    () => sortBots(filterBots(roles, tasks, query), tasks),
    [roles, tasks, query],
  );

  return (
    <div className="sidebar-bots-pane">
      <div className="sidebar-bots-header">
        <div className="sidebar-bots-title-group">
          <Bot size={15} strokeWidth={2.1} aria-hidden="true" />
          <h2>Bots</h2>
          {!isLoading && roles.length > 0 && (
            <span className="sidebar-bots-count">{roles.length}</span>
          )}
        </div>
        <div className="sidebar-bots-actions">
          {onOpenAgents && (
            <button
              type="button"
              className="sidebar-session-action"
              onClick={onOpenAgents}
              title="Manage agents"
              aria-label="Manage agents"
            >
              <CircleDashed size={15} strokeWidth={1.9} />
            </button>
          )}
          <button
            type="button"
            className="sidebar-session-action sidebar-bot-add"
            onClick={() => setCreateOpen(true)}
            title="Create bot"
            aria-label="Create bot"
          >
            <Plus size={17} strokeWidth={2} />
          </button>
        </div>
      </div>

      <label className="sidebar-bots-search">
        <Search size={15} strokeWidth={2} aria-hidden="true" />
        <input
          type="search"
          aria-label="Search bots"
          placeholder="Search bots..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query && (
          <button type="button" onClick={() => setQuery("")} aria-label="Clear bot search">
            <X size={14} />
          </button>
        )}
      </label>

      {isLoading ? (
        <div className="sidebar-bots-state" aria-label="Loading bots" aria-busy="true">
          <LoaderCircle className="spinning" size={22} />
          <span>Loading bots...</span>
        </div>
      ) : error ? (
        <div className="sidebar-bots-state sidebar-bots-error" role="alert">
          <AlertCircle size={22} />
          <span>{error}</span>
          {onRetry && (
            <button type="button" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      ) : roles.length === 0 ? (
        <div className="sidebar-bots-state">
          <Bot size={25} />
          <strong>No bots yet</strong>
          <span>Create a bot to give recurring work a stable identity.</span>
          <button
            type="button"
            className="sidebar-bot-empty-action"
            onClick={() => setCreateOpen(true)}
          >
            <Plus size={14} />
            Create bot
          </button>
        </div>
      ) : visibleBots.length === 0 ? (
        <div className="sidebar-bots-state">
          <Search size={22} />
          <strong>No matching bots</strong>
          <span>Try a different name or recent task.</span>
        </div>
      ) : (
        <div className="sidebar-bots-list" role="list" aria-label="Bots">
          {visibleBots.map((bot) => (
            <BotRow
              key={bot.id}
              bot={bot}
              latestTask={getBotLatestTask(tasks, bot.id)}
              selected={getBotLatestTask(tasks, bot.id)?.id === selectedTaskId}
              onSelect={() => {
                const latestTask = getBotLatestTask(tasks, bot.id);
                if (latestTask) onSelectTask(latestTask.id);
              }}
              onOpenBot={onOpenBot ? () => onOpenBot(bot) : undefined}
              onOpenAgents={onOpenAgents}
            />
          ))}
        </div>
      )}

      {createOpen && onBotCreated && (
        <CreateBotDialog onClose={() => setCreateOpen(false)} onCreated={onBotCreated} />
      )}
    </div>
  );
}
