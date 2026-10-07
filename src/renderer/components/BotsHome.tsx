import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, MessageSquare, Plus, Settings2 } from "lucide-react";
import type { AgentTemplate, BotWorkView } from "../../shared/types";
import { resolveBotMascot, type BotMascotId } from "../../shared/bot-mascots";
import { BotMascot } from "./bot-mascot/BotMascot";
import type { MascotExpression } from "./bot-mascot/mascot-eyes";
import { CreateBotDialog, type BotRole, type CreateBotPrefill } from "./BotsPane";
import { BotWorkDialog } from "./BotWorkDialog";
import {
  BOT_PROFILE_DELETED_EVENT,
  BOT_PROFILE_UPDATED_EVENT,
  BotProfileDialog,
} from "./BotProfileDialog";
import { isUserCreatedBotRole } from "./Sidebar";
import { hasHostMethods } from "../host/browser-capabilities";
import {
  BOT_PROFILE_DESCRIPTION_MAX_LENGTH,
  BOT_PROFILE_INSTRUCTIONS_MAX_LENGTH,
} from "../utils/bot-profile";
import { formatNextRun } from "../utils/next-run";
import "./bots-home.css";

export interface BotsHomeProps {
  workspaceId?: string;
  /** Templates offered as starting points; picking one opens New bot prefilled. */
  templates: AgentTemplate[];
  onOpenBot: (bot: BotRole) => void | Promise<void>;
  onSelectTask: (taskId: string | null) => void;
  onOpenBotMemory?: (workspaceId: string, botName: string) => void;
}

interface BotSummary {
  counts: Record<BotWorkView, number> | null;
  /** Earliest run that will actually start (paused schedules excluded). */
  nextRunAt?: number;
  futurePaused: boolean;
  responsibilities: number | null;
}

type StatFilter = "needs_you" | "working" | "scheduled" | "paused";

const TEMPLATE_MASCOTS: Readonly<Record<string, BotMascotId>> = {
  "team-chat-qna": "assist",
  "morning-planner": "plan",
  "bug-triage": "code",
  "chief-of-staff": "organize",
  "customer-reply-drafter": "write",
  "research-analyst": "research",
  "inbox-follow-up-assistant": "focus",
};

const CATEGORY_MASCOTS: Readonly<Record<AgentTemplate["category"], BotMascotId>> = {
  operations: "organize",
  support: "assist",
  planning: "plan",
  research: "research",
  engineering: "code",
  finance: "analyze",
};

/** The character a template's bot starts as. */
export function templateMascot(template: Pick<AgentTemplate, "id" | "category">): BotMascotId {
  return TEMPLATE_MASCOTS[template.id] ?? CATEGORY_MASCOTS[template.category] ?? "assist";
}

const VISIBLE_TEMPLATES = 6;
const REFRESH_DEBOUNCE_MS = 1500;

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** One status per bot, in the order a person would act on it. */
export function botHomeStatus(summary: BotSummary | undefined): {
  label: string;
  tone: "attention" | "active" | "paused" | "quiet";
  expression: MascotExpression;
} | null {
  if (!summary) return null;
  const needsYou = summary.counts?.needs_you ?? 0;
  if (needsYou > 0) {
    return { label: `Needs you · ${needsYou}`, tone: "attention", expression: "attention" };
  }
  if ((summary.counts?.working ?? 0) > 0) {
    return { label: "Working", tone: "active", expression: "working" };
  }
  if (summary.futurePaused) return { label: "Paused", tone: "paused", expression: "sleeping" };
  return { label: "Ready", tone: "quiet", expression: "idle" };
}

function matchesFilter(summary: BotSummary | undefined, filter: StatFilter): boolean {
  if (!summary) return false;
  if (filter === "paused") return summary.futurePaused;
  return (summary.counts?.[filter] ?? 0) > 0;
}

async function loadBotSummary(workspaceId: string, botId: string): Promise<BotSummary> {
  const api = window.electronAPI;
  const scope = { workspaceId, agentRoleId: botId };
  const [page, future, responsibilities] = await Promise.all([
    hasHostMethods("listBotWork")
      ? api.listBotWork({ ...scope, view: "scheduled", limit: 20 }).catch(() => null)
      : null,
    hasHostMethods("getBotFutureControl") && typeof api.getBotFutureControl === "function"
      ? api.getBotFutureControl({ scope }).catch(() => null)
      : null,
    hasHostMethods("listBotResponsibilities") && typeof api.listBotResponsibilities === "function"
      ? api.listBotResponsibilities(scope).catch(() => null)
      : null,
  ]);
  const runs = (page?.items ?? [])
    .filter((item) => !item.schedulePaused && item.nextWakeAt)
    .map((item) => item.nextWakeAt as number);
  return {
    counts: page?.counts ?? null,
    nextRunAt: runs.length > 0 ? Math.min(...runs) : undefined,
    futurePaused: future?.futurePaused === true,
    responsibilities: responsibilities ? responsibilities.length : null,
  };
}

export function BotsHome({
  workspaceId,
  templates,
  onOpenBot,
  onSelectTask,
  onOpenBotMemory,
}: BotsHomeProps) {
  const [bots, setBots] = useState<BotRole[] | null>(null);
  const [rolesError, setRolesError] = useState<string | null>(null);
  const [summaries, setSummaries] = useState<Record<string, BotSummary>>({});
  const [filter, setFilter] = useState<StatFilter | null>(null);
  const [createPrefill, setCreatePrefill] = useState<CreateBotPrefill | null>(null);
  const [workBot, setWorkBot] = useState<BotRole | null>(null);
  const [editingBot, setEditingBot] = useState<BotRole | null>(null);
  const [showAllTemplates, setShowAllTemplates] = useState(false);
  const [summaryToken, setSummaryToken] = useState(0);
  const templatesRef = useRef<HTMLElement>(null);

  const loadBots = useCallback(async () => {
    if (typeof window.electronAPI?.getAgentRoles !== "function") {
      setBots([]);
      return;
    }
    try {
      const roles = (await window.electronAPI.getAgentRoles(false)) as BotRole[];
      setBots((roles ?? []).filter(isUserCreatedBotRole));
      setRolesError(null);
    } catch (cause) {
      setRolesError(cause instanceof Error ? cause.message : "Could not load bots.");
      setBots((current) => current ?? []);
    }
  }, []);

  useEffect(() => {
    void loadBots();
    window.addEventListener(BOT_PROFILE_UPDATED_EVENT, loadBots);
    window.addEventListener(BOT_PROFILE_DELETED_EVENT, loadBots);
    return () => {
      window.removeEventListener(BOT_PROFILE_UPDATED_EVENT, loadBots);
      window.removeEventListener(BOT_PROFILE_DELETED_EVENT, loadBots);
    };
  }, [loadBots]);

  // Task activity changes what bots need and do; refresh the counts, debounced.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setSummaryToken((value) => value + 1), REFRESH_DEBOUNCE_MS);
    };
    const unsubscribe = window.electronAPI?.onTaskEvent?.(schedule);
    window.addEventListener("focus", schedule);
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe?.();
      window.removeEventListener("focus", schedule);
    };
  }, []);

  useEffect(() => {
    if (!workspaceId || !bots || bots.length === 0) return;
    let cancelled = false;
    void Promise.all(
      bots.map(async (bot) => [bot.id, await loadBotSummary(workspaceId, bot.id)] as const),
    ).then((entries) => {
      if (!cancelled) setSummaries(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [bots, workspaceId, summaryToken]);

  const totals = useMemo(() => {
    const values = Object.values(summaries);
    const sum = (view: BotWorkView) =>
      values.reduce((total, summary) => total + (summary.counts?.[view] ?? 0), 0);
    return {
      needs_you: sum("needs_you"),
      working: sum("working"),
      scheduled: sum("scheduled"),
      paused: values.filter((summary) => summary.futurePaused).length,
    };
  }, [summaries]);
  const summariesLoaded = Boolean(bots && bots.every((bot) => summaries[bot.id]));

  const visibleBots = useMemo(() => {
    const list = bots ?? [];
    const filtered = filter ? list.filter((bot) => matchesFilter(summaries[bot.id], filter)) : list;
    // Bots that need a person first, then running ones, then by name.
    const rank = (bot: BotRole) => {
      const summary = summaries[bot.id];
      if ((summary?.counts?.needs_you ?? 0) > 0) return 0;
      if ((summary?.counts?.working ?? 0) > 0) return 1;
      return 2;
    };
    return [...filtered].sort(
      (a, b) => rank(a) - rank(b) || a.displayName.localeCompare(b.displayName),
    );
  }, [bots, filter, summaries]);

  const stats: Array<{ id: StatFilter; label: string; value: number }> = [
    { id: "needs_you", label: "Needs you", value: totals.needs_you },
    { id: "working", label: "Working", value: totals.working },
    { id: "scheduled", label: "Scheduled", value: totals.scheduled },
    { id: "paused", label: "Paused bots", value: totals.paused },
  ];

  const orderedTemplates = useMemo(
    () => [...templates].sort((a, b) => Number(Boolean(b.featured)) - Number(Boolean(a.featured))),
    [templates],
  );
  const shownTemplates = showAllTemplates
    ? orderedTemplates
    : orderedTemplates.slice(0, VISIBLE_TEMPLATES);

  const startFromTemplate = (template: AgentTemplate) =>
    setCreatePrefill({
      displayName: template.name,
      description: template.description.slice(0, BOT_PROFILE_DESCRIPTION_MAX_LENGTH),
      systemPrompt: template.systemPrompt.slice(0, BOT_PROFILE_INSTRUCTIONS_MAX_LENGTH),
      mascot: templateMascot(template),
    });

  const renderRow = (bot: BotRole) => {
    const summary = summaries[bot.id];
    const status = botHomeStatus(summary);
    const meta: string[] = [];
    if (summary?.nextRunAt && !summary.futurePaused) {
      meta.push(`Next run ${formatNextRun(summary.nextRunAt)}`);
    }
    if (summary?.responsibilities)
      meta.push(plural(summary.responsibilities, "responsibility", "responsibilities"));
    return (
      <div key={bot.id} className="bots-home-row" role="listitem">
        <BotMascot
          mascot={resolveBotMascot(bot.icon)}
          size={44}
          expression={status?.expression ?? "idle"}
        />
        <div className="bots-home-row-copy">
          <div className="bots-home-row-title">
            <strong>{bot.displayName}</strong>
            {status ? (
              <span className={`bots-home-chip bots-home-chip-${status.tone}`}>{status.label}</span>
            ) : (
              <LoaderCircle
                className="spinning bots-home-row-loading"
                size={13}
                aria-label="Loading"
              />
            )}
          </div>
          {bot.description ? <p className="bots-home-row-description">{bot.description}</p> : null}
          {meta.length > 0 ? <span className="bots-home-row-meta">{meta.join(" · ")}</span> : null}
        </div>
        <div className="bots-home-row-actions">
          <button
            type="button"
            className="bots-home-row-button"
            onClick={() => void onOpenBot(bot)}
          >
            <MessageSquare size={14} aria-hidden="true" />
            Chat
          </button>
          {workspaceId ? (
            <button type="button" className="bots-home-row-button" onClick={() => setWorkBot(bot)}>
              Work
            </button>
          ) : null}
          <button
            type="button"
            className="bots-home-row-icon"
            onClick={() => setEditingBot(bot)}
            aria-label={`Edit ${bot.displayName}`}
            title="Edit bot"
          >
            <Settings2 size={15} />
          </button>
        </div>
      </div>
    );
  };

  return (
    <section className="bots-home" aria-labelledby="bots-home-title">
      <header className="bots-home-header">
        <div>
          <h1 id="bots-home-title">Bots</h1>
          <p>Your bots, what they need from you, and what's next.</p>
        </div>
        <div className="bots-home-actions">
          {templates.length > 0 ? (
            <button
              type="button"
              className="agents-secondary-btn"
              onClick={() => templatesRef.current?.scrollIntoView({ behavior: "smooth" })}
            >
              Templates
            </button>
          ) : null}
          <button type="button" className="agents-primary-btn" onClick={() => setCreatePrefill({})}>
            <Plus size={16} aria-hidden="true" />
            New bot
          </button>
        </div>
      </header>

      {bots && bots.length > 0 ? (
        <div className="bots-home-stats" role="group" aria-label="Across your bots">
          {stats.map((stat) => (
            <button
              key={stat.id}
              type="button"
              className={`bots-home-stat${filter === stat.id ? " active" : ""}${stat.id === "needs_you" && stat.value > 0 ? " attention" : ""}`}
              aria-pressed={filter === stat.id}
              onClick={() => setFilter((current) => (current === stat.id ? null : stat.id))}
            >
              <span>{stat.label}</span>
              <strong>{summariesLoaded ? stat.value : "–"}</strong>
            </button>
          ))}
        </div>
      ) : null}

      <section className="bots-home-section" aria-labelledby="bots-home-list-title">
        <div className="bots-home-section-head">
          <h2 id="bots-home-list-title">
            {filter ? stats.find((stat) => stat.id === filter)?.label : "Your bots"}
          </h2>
          {filter ? (
            <button type="button" className="bots-home-link" onClick={() => setFilter(null)}>
              Show all bots
            </button>
          ) : null}
        </div>
        {rolesError ? (
          <div className="bots-home-empty" role="alert">
            <span>{rolesError}</span>
            <button type="button" className="bots-home-link" onClick={() => void loadBots()}>
              Try again
            </button>
          </div>
        ) : bots === null ? (
          <div className="bots-home-empty" aria-busy="true">
            <LoaderCircle className="spinning" size={18} />
            <span>Loading bots…</span>
          </div>
        ) : bots.length === 0 ? (
          <div className="bots-home-empty bots-home-first">
            <BotMascot mascot="assist" size={72} expression="happy" />
            <strong>Create your first bot</strong>
            <span>
              A bot keeps its own chat, work, and responsibilities, and asks you before acting.
            </span>
            <button
              type="button"
              className="agents-primary-btn"
              onClick={() => setCreatePrefill({})}
            >
              <Plus size={16} aria-hidden="true" />
              New bot
            </button>
          </div>
        ) : visibleBots.length === 0 ? (
          <div className="bots-home-empty">
            <span>No bots here right now.</span>
          </div>
        ) : (
          <div className="bots-home-list" role="list">
            {visibleBots.map(renderRow)}
          </div>
        )}
      </section>

      {orderedTemplates.length > 0 ? (
        <section
          ref={templatesRef}
          className="bots-home-section"
          aria-labelledby="bots-home-templates-title"
        >
          <div className="bots-home-section-head">
            <h2 id="bots-home-templates-title">Start from a template</h2>
            {orderedTemplates.length > VISIBLE_TEMPLATES ? (
              <button
                type="button"
                className="bots-home-link"
                onClick={() => setShowAllTemplates((value) => !value)}
              >
                {showAllTemplates ? "Show fewer" : `Show all ${orderedTemplates.length}`}
              </button>
            ) : null}
          </div>
          <div className="bots-home-templates">
            {shownTemplates.map((template) => (
              <button
                key={template.id}
                type="button"
                className="bots-home-template"
                onClick={() => startFromTemplate(template)}
              >
                <BotMascot mascot={templateMascot(template)} size={40} animated={false} />
                <span className="bots-home-template-copy">
                  <strong>{template.name}</strong>
                  <span>{template.description}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {createPrefill ? (
        <CreateBotDialog
          existingBots={bots ?? []}
          prefill={createPrefill}
          onClose={() => setCreatePrefill(null)}
          onCreated={() => undefined}
        />
      ) : null}
      {workspaceId && workBot ? (
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
                  setWorkBot(null);
                }
              : undefined
          }
          onClose={() => {
            setWorkBot(null);
            setSummaryToken((value) => value + 1);
          }}
          onSelectTask={onSelectTask}
        />
      ) : null}
      {editingBot ? (
        <BotProfileDialog
          botId={editingBot.id}
          onClose={() => setEditingBot(null)}
          onSaved={() => setEditingBot(null)}
          onDeleted={() => setEditingBot(null)}
        />
      ) : null}
    </section>
  );
}
