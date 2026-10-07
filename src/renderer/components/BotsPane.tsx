import { BotWorkDialog } from "./BotWorkDialog";
import { useMemo, useState } from "react";
import { AlertCircle, ClipboardList, LoaderCircle, Plus, RefreshCw, Search, X } from "lucide-react";
import { BotGlyph } from "./BotGlyph";
import { UseCasesGallery } from "./UseCasesGallery";
import type { Task } from "../../shared/types";
import { normalizeBotDisplayName, normalizeBotProfileText } from "../utils/bot-profile";
import { stripAllEmojis } from "../utils/emoji-replacer";
import { DEFAULT_BOT_COLOR } from "../utils/bot-colors";
import {
  BOT_MASCOT_IDS,
  botMascotIcon,
  resolveBotMascot,
  type BotMascotId,
} from "../../shared/bot-mascots";
import { BotMascot } from "./bot-mascot/BotMascot";
import { BotFormDialog, type BotFormValues } from "./BotFormDialog";
import "./bot-roster.css";
import type { MascotExpression } from "./bot-mascot/mascot-eyes";
import { BOT_PROFILE_UPDATED_EVENT, BotProfileDialog } from "./BotProfileDialog";
import {
  isBotConversationSeedPrompt,
  selectLatestBotConversation,
  selectLatestMessagedBotConversation,
} from "../utils/bot-conversations";
import { parseAgentMessageProtocolResult } from "../utils/agent-message-receipt";
import type {
  BotConversationProjection,
  BotConversationRosterProjection,
} from "../../shared/bot-lifecycle";

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
  workspaceId?: string;
  roles: BotRole[];
  tasks: Task[];
  selectedTaskId: string | null;
  isLoading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onSelectTask: (id: string | null) => void;
  onOpenBot?: (bot: BotRole) => void | Promise<void>;
  onReopenBot?: (task: Task) => void | Promise<void>;
  onOpenAgents?: () => void;
  onOpenBotMemory?: (workspaceId: string, botName: string) => void;
  selectedConversationProjection?: BotConversationRosterProjection | null;
  conversationProjections?: Readonly<Record<string, BotConversationRosterProjection>>;
  onBotCreated?: (bot: BotRole) => void | Promise<void>;
  onBotUpdated?: (bot: BotRole) => void | Promise<void>;
  onBotDeleted?: (botId: string) => void | Promise<void>;
  /** Lets the host open the create dialog from its own button (controlled with the next prop). */
  createOpen?: boolean;
  onCreateOpenChange?: (open: boolean) => void;
}

const ACTIVE_BOT_STATUSES: ReadonlySet<Task["status"]> = new Set(["executing", "planning"]);

const AWAITING_BOT_STATUSES: ReadonlySet<Task["status"]> = new Set(["paused", "blocked"]);
const UNAVAILABLE_BOT_STATUSES: ReadonlySet<Task["status"]> = new Set(["failed", "cancelled"]);

const MAX_BOT_PREVIEW_LENGTH = 140;
const BOT_WAITING_FOR_REPLY_RE =
  /^waiting for (.+?) to reply(?: before finishing this conversation)?\.?$/i;

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

function getHumanBotPreview(value: string | undefined): string {
  const protocolResult = value ? parseAgentMessageProtocolResult(value) : null;
  return protocolResult ? protocolResult.label : flattenBotPreviewText(value);
}

export function getBotLatestTask(tasks: Task[], roleId: string): Task | undefined {
  return selectLatestBotConversation(tasks, roleId);
}

export type BotConversationReadiness =
  | "ready"
  | "working"
  | "waiting"
  | "attention"
  | "unavailable";

function hasPendingTeammateReply(task: Pick<Task, "status" | "error"> | undefined): boolean {
  if (!task || !["blocked", "paused", "interrupted"].includes(task.status)) return false;
  return (
    typeof task.error === "string" && BOT_WAITING_FOR_REPLY_RE.test(flattenTaskText(task.error))
  );
}

function getPendingTeammateReplyPreview(task: Pick<Task, "status" | "error">): string | null {
  if (!hasPendingTeammateReply(task) || typeof task.error !== "string") return null;
  const match = flattenTaskText(task.error).match(BOT_WAITING_FOR_REPLY_RE);
  return match?.[1] ? `Waiting for ${match[1]} to reply` : "Waiting for a teammate to reply";
}

function getProjectionPreview(
  projection?:
    | (Pick<BotConversationProjection, "state"> &
        Partial<Pick<BotConversationProjection, "activityLabel">>)
    | null,
): string | null {
  const activityLabel = projection?.activityLabel?.trim();
  switch (projection?.state) {
    case "working":
      return activityLabel || "Working on latest message";
    case "waiting":
      return activityLabel || "Waiting on a teammate";
    case "needs_input":
      return activityLabel || "Needs your input";
    case "failed":
      return activityLabel || "Unavailable — reopen to retry";
    default:
      return null;
  }
}

/** Persistent readiness is intentionally separate from the last run result. */
export function getBotConversationReadiness(
  task: Pick<Task, "status" | "error"> | undefined,
  projection?: Pick<BotConversationProjection, "state"> | null,
): BotConversationReadiness {
  if (projection?.state === "waiting") return "waiting";
  if (projection?.state === "working") return "working";
  if (projection?.state === "needs_input") return "attention";
  if (projection?.state === "failed") return "unavailable";
  if (projection?.state === "completed") return "ready";
  if (!task) return "ready";
  if (hasPendingTeammateReply(task)) return "waiting";
  if (ACTIVE_BOT_STATUSES.has(task.status)) return "working";
  if (AWAITING_BOT_STATUSES.has(task.status) || task.status === "interrupted") {
    return "attention";
  }
  if (UNAVAILABLE_BOT_STATUSES.has(task.status)) return "unavailable";
  return "ready";
}

export function getBotConversationReadinessLabel(readiness: BotConversationReadiness): string {
  switch (readiness) {
    case "working":
      return "Working on latest message";
    case "waiting":
      return "Waiting on a teammate";
    case "attention":
      return "Needs attention";
    case "unavailable":
      return "Unavailable — reopen to retry";
    default:
      return "Ready for another message";
  }
}

export function getBotPreview(
  task: Task | undefined,
  projection?:
    | (Pick<BotConversationProjection, "state"> &
        Partial<Pick<BotConversationProjection, "activityLabel">>)
    | null,
): string {
  if (!task) return getProjectionPreview(projection) || "No messages yet";
  if (task.status === "failed" || task.status === "cancelled") {
    const failurePreview = getHumanBotPreview(task.error || undefined);
    const preview = failurePreview
      ? `Failed: ${failurePreview}`
      : "Conversation unavailable — reopen to retry";
    return preview.length > MAX_BOT_PREVIEW_LENGTH
      ? `${preview.slice(0, MAX_BOT_PREVIEW_LENGTH - 1).trimEnd()}…`
      : preview;
  }
  const projectionPreview = getProjectionPreview(projection);
  if (projectionPreview) return projectionPreview;
  const pendingReplyPreview = getPendingTeammateReplyPreview(task);
  if (pendingReplyPreview) return pendingReplyPreview;
  const promptPreview = getHumanBotPreview(task.userPrompt);
  const sidebarPreview = getHumanBotPreview(task.sidebarPromptPreview);
  const resultPreview = getHumanBotPreview(task.resultSummary);
  const preview =
    (!isBotConversationSeedPrompt(resultPreview) ? resultPreview : "") ||
    (!isBotConversationSeedPrompt(sidebarPreview) ? sidebarPreview : "") ||
    (!isBotConversationSeedPrompt(promptPreview) ? promptPreview : "") ||
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

export function filterBots(
  roles: BotRole[],
  tasks: Task[],
  query: string,
  projections?: Readonly<Record<string, BotConversationRosterProjection>>,
): BotRole[] {
  const normalizedQuery = flattenTaskText(query).toLocaleLowerCase();
  if (!normalizedQuery) return roles;

  return roles.filter((bot) => {
    const searchableText = [
      bot.displayName,
      bot.name,
      bot.description,
      getBotHandle(bot),
      getBotRosterSummary(bot, tasks, projections?.[bot.id]).preview,
    ]
      .map((value) => flattenTaskText(value).toLocaleLowerCase())
      .join(" ");
    return searchableText.includes(normalizedQuery);
  });
}

/** The roster mascot mirrors the readiness label beside it. */
export function getBotMascotExpression(
  readiness: BotConversationReadiness,
  isActive = true,
): MascotExpression {
  if (!isActive) return "sleeping";
  switch (readiness) {
    case "working":
      return "working";
    case "waiting":
      return "thinking";
    case "attention":
      return "attention";
    case "unavailable":
      return "error";
    default:
      return "idle";
  }
}

/** New bots start as a character no other bot is using yet. */
export function pickDefaultBotMascot(roles: ReadonlyArray<Pick<BotRole, "icon">>): BotMascotId {
  const taken = new Set(roles.map((role) => resolveBotMascot(role.icon)));
  return (
    BOT_MASCOT_IDS.find((id) => !taken.has(id)) ??
    BOT_MASCOT_IDS[roles.length % BOT_MASCOT_IDS.length]
  );
}

export function getBotTimestamp(
  bot: BotRole,
  task: Task | undefined,
  projection?: Pick<BotConversationProjection, "lastActivityAt"> | null,
): number {
  return Math.max(
    task?.updatedAt || task?.createdAt || bot.updatedAt || 0,
    projection?.lastActivityAt || 0,
  );
}

/**
 * What the roster shows for a bot. The conversation it opens can be a fresh branch with
 * nothing said yet; the preview and age then come from the latest conversation with messages.
 */
export function getBotRosterSummary(
  bot: BotRole,
  tasks: Task[],
  projection?: BotConversationRosterProjection | null,
): { latestTask: Task | undefined; preview: string; timestamp: number } {
  const latestTask = getBotLatestTask(tasks, bot.id);
  const latestPreview = getBotPreview(latestTask, projection);
  if (latestPreview === "No messages yet") {
    const messagedTask = selectLatestMessagedBotConversation(tasks, bot.id);
    if (messagedTask && messagedTask.id !== latestTask?.id) {
      return {
        latestTask,
        preview: getBotPreview(messagedTask),
        timestamp: Math.max(getBotTimestamp(bot, messagedTask), projection?.lastActivityAt || 0),
      };
    }
  }
  return {
    latestTask,
    preview: latestPreview,
    timestamp: getBotTimestamp(bot, latestTask, projection),
  };
}

function sortBots(
  roles: BotRole[],
  tasks: Task[],
  projections?: Readonly<Record<string, BotConversationRosterProjection>>,
): BotRole[] {
  const summaries = new Map(
    roles.map((bot) => [bot.id, getBotRosterSummary(bot, tasks, projections?.[bot.id])]),
  );
  return [...roles].sort((a, b) => {
    const aSummary = summaries.get(a.id)!;
    const bSummary = summaries.get(b.id)!;
    const aActive = aSummary.latestTask && ACTIVE_BOT_STATUSES.has(aSummary.latestTask.status);
    const bActive = bSummary.latestTask && ACTIVE_BOT_STATUSES.has(bSummary.latestTask.status);
    if (aActive !== bActive) return Number(Boolean(bActive)) - Number(Boolean(aActive));

    const activityDifference = bSummary.timestamp - aSummary.timestamp;
    if (activityDifference !== 0) return activityDifference;
    return (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.displayName.localeCompare(b.displayName);
  });
}

function BotRow({
  bot,
  latestTask,
  preview,
  timestamp,
  conversationProjection,
  selected,
  onSelect,
  onOpenBot,
  onReopenBot,
  onOpenAgents,
  onEditBot,
  onViewWork,
}: {
  bot: BotRole;
  latestTask?: Task;
  preview: string;
  timestamp: number;
  conversationProjection?: BotConversationRosterProjection | null;
  selected: boolean;
  onSelect: () => void;
  onOpenBot?: () => void | Promise<void>;
  onReopenBot?: (task: Task) => void | Promise<void>;
  onOpenAgents?: () => void;
  onEditBot?: () => void;
  onViewWork?: () => void;
}) {
  const [isReopening, setIsReopening] = useState(false);
  const mascot = resolveBotMascot(bot.icon);
  const readiness = getBotConversationReadiness(latestTask, conversationProjection);
  const isActive = readiness === "working";
  const isAwaiting =
    readiness === "waiting" || readiness === "attention" || readiness === "unavailable";
  const readinessLabel = getBotConversationReadinessLabel(readiness);
  const displayName = flattenTaskText(bot.displayName) || "Unnamed bot";
  const age = getBotRelativeTime(timestamp);

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
        aria-label={`${displayName}, ${readinessLabel}, ${preview}`}
        title={latestTask ? preview : "Open bot chat"}
      >
        <span className="sidebar-bot-avatar sidebar-bot-avatar-mascot" aria-hidden="true">
          <BotMascot
            mascot={mascot}
            size={36}
            expression={getBotMascotExpression(readiness, bot.isActive !== false)}
          />
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
            <span
              className={`sidebar-bot-readiness sidebar-bot-readiness-${readiness}`}
              title={readinessLabel}
            >
              {readinessLabel}
            </span>
            <span className="sidebar-bot-preview">{preview}</span>
          </span>
        </span>
      </button>
      {onViewWork && (
        <button
          type="button"
          className="sidebar-bot-work-button"
          onClick={onViewWork}
          aria-label={`View work for ${displayName}`}
          title="View bot work"
        >
          <ClipboardList size={16} />
        </button>
      )}
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
      {onReopenBot && latestTask && readiness === "unavailable" && (
        <button
          type="button"
          className="sidebar-bot-reopen-button"
          onClick={async (event) => {
            event.stopPropagation();
            if (isReopening) return;
            setIsReopening(true);
            try {
              await onReopenBot(latestTask);
            } finally {
              setIsReopening(false);
            }
          }}
          aria-label={`Reopen ${displayName} conversation`}
          title="Reopen conversation"
          disabled={isReopening}
        >
          <RefreshCw size={13} className={isReopening ? "spinning" : undefined} />
        </button>
      )}
    </div>
  );
}

/** Starting values for a new bot, e.g. from a template. */
export interface CreateBotPrefill {
  displayName?: string;
  description?: string;
  systemPrompt?: string;
  mascot?: BotMascotId;
}

export function CreateBotDialog({
  existingBots,
  prefill,
  onClose,
  onCreated,
}: {
  existingBots: ReadonlyArray<Pick<BotRole, "icon">>;
  prefill?: CreateBotPrefill;
  onClose: () => void;
  onCreated: (bot: BotRole) => void | Promise<void>;
}) {
  const [values, setValues] = useState<BotFormValues>(() => ({
    displayName: prefill?.displayName ?? "",
    description: prefill?.description ?? "",
    systemPrompt: prefill?.systemPrompt ?? "",
    icon: botMascotIcon(prefill?.mascot ?? pickDefaultBotMascot(existingBots)),
  }));
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    const cleanName = normalizeBotDisplayName(values.displayName);
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
      const baseHandle = normalizeBotHandle(cleanName);
      const createWithHandle = (name: string) =>
        api.createAgentRole({
          name,
          displayName: cleanName,
          description: normalizeBotProfileText(values.description) || undefined,
          systemPrompt: normalizeBotProfileText(values.systemPrompt) || undefined,
          icon: values.icon,
          color: DEFAULT_BOT_COLOR,
          capabilities: ["code"],
        });
      // The handle is internal and stays taken by deleted bots (deletion keeps the row), so
      // a name used before, or one with no latin letters ("bot"), gets a numbered handle.
      let created: BotRole | undefined;
      for (let attempt = 0; !created; attempt += 1) {
        try {
          created = await createWithHandle(
            attempt === 0 ? baseHandle : `${baseHandle}-${attempt + 1}`,
          );
        } catch (cause) {
          const taken = cause instanceof Error && /already exists/i.test(cause.message);
          if (!taken || attempt >= 49) throw cause;
        }
      }
      await onCreated(created);
      // Other bot surfaces (the roster, the Bots page) reload their list.
      window.dispatchEvent(new CustomEvent(BOT_PROFILE_UPDATED_EVENT, { detail: created }));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create this bot.");
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <BotFormDialog
      title="New bot"
      subtitle="Pick a character and tell it what to help with."
      values={values}
      onChange={setValues}
      onSubmit={() => void create()}
      onClose={onClose}
      submitLabel="Create bot"
      busyLabel="Creating…"
      submitIcon={<Plus size={14} />}
      footnote="You can change all of this later."
      busy={isCreating}
      error={error}
    />
  );
}

export function BotsPane({
  workspaceId,
  roles,
  tasks,
  selectedTaskId,
  isLoading = false,
  error = null,
  onRetry,
  onSelectTask,
  onOpenBot,
  onReopenBot,
  onOpenAgents,
  onOpenBotMemory,
  selectedConversationProjection,
  conversationProjections,
  onBotCreated,
  onBotUpdated,
  onBotDeleted,
  createOpen: createOpenProp,
  onCreateOpenChange,
}: BotsPaneProps) {
  const [workBotId, setWorkBotId] = useState<string | null>(null);
  const workBot = roles.find((bot) => bot.id === workBotId);
  const [query, setQuery] = useState("");
  const [ownCreateOpen, setOwnCreateOpen] = useState(false);
  const createOpen = createOpenProp ?? ownCreateOpen;
  const [useCasesOpen, setUseCasesOpen] = useState(false);
  const setCreateOpen = onCreateOpenChange ?? setOwnCreateOpen;
  const [editingBot, setEditingBot] = useState<BotRole | null>(null);

  const visibleBots = useMemo(
    () =>
      sortBots(
        filterBots(roles, tasks, query, conversationProjections),
        tasks,
        conversationProjections,
      ),
    [conversationProjections, roles, tasks, query],
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
        {/* Managing agents is the rail's Agents destination. When the host owns
            the create dialog it also offers the button (the panel's New bot). */}
        {!onCreateOpenChange && (
          <div className="sidebar-bots-actions">
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
        )}
      </div>

      <UseCasesGallery
        open={useCasesOpen}
        initialCategory="bots"
        onClose={() => setUseCasesOpen(false)}
      />

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
          <button type="button" className="use-cases-link" onClick={() => setUseCasesOpen(true)}>
            See how people use bots
          </button>
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
          {visibleBots.map((bot) => {
            const selected = tasks.some(
              (task) =>
                task.id === selectedTaskId &&
                task.assignedAgentRoleId === bot.id &&
                isBotConversationTask(task),
            );
            const conversationProjection = selected
              ? (selectedConversationProjection ?? conversationProjections?.[bot.id] ?? null)
              : (conversationProjections?.[bot.id] ?? null);
            const { latestTask, preview, timestamp } = getBotRosterSummary(
              bot,
              tasks,
              conversationProjection,
            );
            return (
              <BotRow
                key={bot.id}
                bot={bot}
                latestTask={latestTask}
                preview={preview}
                timestamp={timestamp}
                conversationProjection={conversationProjection}
                selected={selected}
                onSelect={() => {
                  if (latestTask) onSelectTask(latestTask.id);
                }}
                onOpenBot={onOpenBot ? () => onOpenBot(bot) : undefined}
                onReopenBot={onReopenBot}
                onOpenAgents={onOpenAgents}
                onEditBot={() => setEditingBot(bot)}
                onViewWork={workspaceId ? () => setWorkBotId(bot.id) : undefined}
              />
            );
          })}
        </div>
      )}

      {workspaceId && workBot && (
        <BotWorkDialog
          key={`${workspaceId}:${workBot.id}`}
          workspaceId={workspaceId}
          botId={workBot.id}
          botName={workBot.displayName}
          botIcon={workBot.icon}
          onOpenContext={
            onOpenBotMemory
              ? (memoryWorkspaceId) => {
                  onOpenBotMemory(memoryWorkspaceId, workBot.displayName);
                  setWorkBotId(null);
                }
              : undefined
          }
          onClose={() => setWorkBotId(null)}
          onSelectTask={onSelectTask}
        />
      )}
      {createOpen && onBotCreated && (
        <CreateBotDialog
          existingBots={roles}
          onClose={() => setCreateOpen(false)}
          onCreated={onBotCreated}
        />
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
