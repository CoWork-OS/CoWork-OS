import { useMemo, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, CircleDashed, LoaderCircle, Plus, Search, X } from "lucide-react";
import { BotGlyph } from "./BotGlyph";
import type { Task } from "../../shared/types";
import {
  BOT_PROFILE_DESCRIPTION_MAX_LENGTH,
  BOT_PROFILE_INSTRUCTIONS_MAX_LENGTH,
  normalizeBotProfileText,
} from "../utils/bot-profile";
import { stripAllEmojis } from "../utils/emoji-replacer";
import { LUCIDE_TWIN_ICONS, TWIN_ICON_KEYS, type TwinIconKey } from "../utils/twin-icons";
import { DEFAULT_BOT_COLOR } from "../utils/bot-colors";
import { BotProfileDialog } from "./BotProfileDialog";
import { selectLatestBotConversation } from "../utils/bot-conversations";

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
  onBotUpdated?: (bot: BotRole) => void | Promise<void>;
  onBotDeleted?: (botId: string) => void | Promise<void>;
}

const ACTIVE_BOT_STATUSES: ReadonlySet<Task["status"]> = new Set([
  "executing",
  "planning",
  "interrupted",
]);

const AWAITING_BOT_STATUSES: ReadonlySet<Task["status"]> = new Set(["paused", "blocked"]);

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

export function stripMarkdownForBotPreview(value: string | undefined): string {
  return (value || "")
    .replace(/\\([\\`*_\[\]{}()#+.!~-])/g, "$1")
    .replace(/!\[([^\]]*)\]\([^\)\n]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^\)\n]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/```[ \t]*[A-Za-z0-9_+-]*[ \t]*(?:\r?\n|$)/g, "")
    .replace(/```/g, "")
    .replace(/(^|\n)\s{0,3}(?:[-+*]|\d+[.)])\s+/gm, "$1")
    .replace(/(^|\n)\s{0,3}>\s?/gm, "$1")
    .replace(/(^|\n)\s{0,3}(?:([-*_])\s*){3,}(?=\n|$)/gm, "$1")
    .replace(/(^|[\s])#{1,6}(?=[\s]|$)/g, "$1")
    .replace(/(\*\*|__)([\s\S]*?)\1/g, "$2")
    .replace(/~~([\s\S]*?)~~/g, "$1")
    .replace(/(^|[^\p{L}\p{N}])([*_])(?=\S)([\s\S]*?\S)\2(?=$|[^\p{L}\p{N}])/gu, "$1$3")
    .replace(/(^|[\s([{])[*_~`]+(?=\S)/g, "$1")
    .replace(/[*_~`]+(?=$|[\s)\]}.,!?;:])/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function flattenBotPreviewText(value: string | undefined): string {
  return stripAllEmojis(stripMarkdownForBotPreview(value));
}

export function getBotLatestTask(tasks: Task[], roleId: string): Task | undefined {
  return selectLatestBotConversation(tasks, roleId);
}

export function getBotPreview(task: Task | undefined): string {
  if (!task) return "No messages yet";
  const promptPreview = flattenBotPreviewText(task.userPrompt);
  const sidebarPreview = flattenBotPreviewText(task.sidebarPromptPreview);
  const resultPreview = flattenBotPreviewText(task.resultSummary);
  const isDormantSeed = (value: string) =>
    /^start (?:a )?(?:conversation|chatting) with /i.test(value);
  const preview =
    (!isDormantSeed(resultPreview) ? resultPreview : "") ||
    (!isDormantSeed(sidebarPreview) ? sidebarPreview : "") ||
    (!isDormantSeed(promptPreview) ? promptPreview : "") ||
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
  return BotGlyph;
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
  onEditBot,
}: {
  bot: BotRole;
  latestTask?: Task;
  selected: boolean;
  onSelect: () => void;
  onOpenBot?: () => void | Promise<void>;
  onOpenAgents?: () => void;
  onEditBot?: () => void;
}) {
  const Icon = getSafeBotIcon(bot.icon);
  const isActive = latestTask ? ACTIVE_BOT_STATUSES.has(latestTask.status) : false;
  const isAwaiting = latestTask ? AWAITING_BOT_STATUSES.has(latestTask.status) : false;
  const displayName = flattenTaskText(bot.displayName) || "Unnamed bot";
  const preview = getBotPreview(latestTask);
  const age = getBotRelativeTime(latestTask?.updatedAt || latestTask?.createdAt || bot.updatedAt);

  return (
    <div className="sidebar-bot-row-wrap">
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
        aria-label={`${displayName}, ${preview}`}
        title={latestTask ? preview : "Open bot chat"}
      >
        <span
          className="sidebar-bot-avatar"
          style={{ backgroundColor: bot.color || DEFAULT_BOT_COLOR }}
          aria-hidden="true"
        >
          <Icon size={18} />
          <span
            className={`sidebar-bot-status ${isActive ? "active" : ""} ${isAwaiting ? "awaiting" : ""}`}
          />
        </span>
        <span className="sidebar-bot-copy">
          <span className="sidebar-bot-primary-line">
            <span className="sidebar-bot-identity">
              <span className="sidebar-bot-name">{displayName}</span>
            </span>
            {age && <span className="sidebar-bot-age">{age}</span>}
          </span>
          <span className="sidebar-bot-secondary-line">
            <span className="sidebar-bot-preview">{preview}</span>
          </span>
        </span>
      </button>
      {onEditBot && (
        <button
          type="button"
          className="sidebar-bot-edit-button"
          onClick={onEditBot}
          aria-label={`Edit ${displayName}`}
          title="Edit bot"
        >
          <span aria-hidden="true">⋯</span>
        </button>
      )}
    </div>
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
  const [systemPrompt, setSystemPrompt] = useState("");
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
        description: normalizeBotProfileText(description) || undefined,
        systemPrompt: normalizeBotProfileText(systemPrompt) || undefined,
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
            maxLength={BOT_PROFILE_DESCRIPTION_MAX_LENGTH}
            rows={4}
          />
          <small>Line breaks are preserved.</small>
        </label>
        <label className="sidebar-bot-field">
          <span>Instructions</span>
          <textarea
            value={systemPrompt}
            onChange={(event) => setSystemPrompt(event.target.value)}
            placeholder="How should this bot work?"
            maxLength={BOT_PROFILE_INSTRUCTIONS_MAX_LENGTH}
            rows={4}
          />
          <small>Used when this bot starts its next run.</small>
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
  onBotUpdated,
  onBotDeleted,
}: BotsPaneProps) {
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editingBot, setEditingBot] = useState<BotRole | null>(null);

  const visibleBots = useMemo(
    () => sortBots(filterBots(roles, tasks, query), tasks),
    [roles, tasks, query],
  );

  return (
    <div className="sidebar-bots-pane">
      <div className="sidebar-bots-header">
        <div className="sidebar-bots-title-group">
          <BotGlyph size={16} weight="regular" />
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
          <BotGlyph size={26} />
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
              selected={tasks.some(
                (task) =>
                  task.id === selectedTaskId &&
                  task.assignedAgentRoleId === bot.id &&
                  isBotConversationTask(task),
              )}
              onSelect={() => {
                const latestTask = getBotLatestTask(tasks, bot.id);
                if (latestTask) onSelectTask(latestTask.id);
              }}
              onOpenBot={onOpenBot ? () => onOpenBot(bot) : undefined}
              onOpenAgents={onOpenAgents}
              onEditBot={() => setEditingBot(bot)}
            />
          ))}
        </div>
      )}

      {createOpen && onBotCreated && (
        <CreateBotDialog onClose={() => setCreateOpen(false)} onCreated={onBotCreated} />
      )}
      {editingBot && (
        <BotProfileDialog
          botId={editingBot.id}
          onClose={() => setEditingBot(null)}
          onSaved={async (bot) => {
            await onBotUpdated?.(bot as BotRole);
            setEditingBot(null);
          }}
          onDeleted={async (botId) => {
            await onBotDeleted?.(botId);
            setEditingBot(null);
          }}
        />
      )}
    </div>
  );
}
