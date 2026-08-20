import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  ArrowLeft,
  Bot,
  CalendarClock,
  ChevronRight,
  CircleAlert,
  LoaderCircle,
  PanelRight,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  UsersRound,
  X,
} from "lucide-react";

import type {
  BotSummary,
  ManagedAgentRoutineRecord,
  ManagedEnvironment,
  ManagedSessionEvent,
} from "../../../shared/types";
import { MarkdownRenderer } from "../MarkdownRenderer";
import {
  latestBotConversationFailure,
  projectBotConversation,
} from "./bot-conversation-projection";
import { useScopedComposerState } from "./useScopedComposerState";
import "./bots.css";
import { BotRoomsPanel } from "./BotRoomsPanel";

interface BotWorkspaceProps {
  onOpenAgents: () => void;
  onExit: () => void;
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "AI"
  );
}

function avatarStyle(name: string): CSSProperties {
  const hue = [...name].reduce((total, character) => total + character.charCodeAt(0), 0) % 360;
  return { "--bot-avatar-hue": String(hue) } as CSSProperties;
}

export function BotWorkspace({ onOpenAgents, onExit }: BotWorkspaceProps) {
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>();
  const [environments, setEnvironments] = useState<ManagedEnvironment[]>([]);
  const [environmentId, setEnvironmentId] = useState("");
  const [events, setEvents] = useState<ManagedSessionEvent[]>([]);
  const [routines, setRoutines] = useState<ManagedAgentRoutineRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [showRooms, setShowRooms] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [search, setSearch] = useState("");
  const conversationRequestRef = useRef(0);
  const messageEndRef = useRef<HTMLDivElement>(null);
  const composer = useScopedComposerState(`bot:${selectedAgentId || "none"}`);
  const { draft: message, setDraft: setMessage, sending, setSending, error, setError } = composer;

  const selected = useMemo(
    () => bots.find((bot) => bot.agent.id === selectedAgentId),
    [bots, selectedAgentId],
  );
  const filteredBots = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return bots;
    return bots.filter((bot) =>
      `${bot.agent.name} ${bot.agent.description || ""}`.toLowerCase().includes(query),
    );
  }, [bots, search]);
  const conversationMessages = useMemo(() => projectBotConversation(events), [events]);
  const conversationFailure = useMemo(() => latestBotConversationFailure(events), [events]);

  const loadBots = useCallback(async () => {
    const [nextBots, nextEnvironments] = await Promise.all([
      window.electronAPI.listBots(),
      window.electronAPI.listManagedEnvironments({ status: "active", limit: 500 }),
    ]);
    setBots(nextBots);
    setEnvironments(nextEnvironments);
    setSelectedAgentId((current) =>
      current && nextBots.some((bot) => bot.agent.id === current) ? current : nextBots[0]?.agent.id,
    );
  }, []);

  const loadConversation = useCallback(async (agentId: string) => {
    const requestId = ++conversationRequestRef.current;
    const [conversation, nextRoutines] = await Promise.all([
      window.electronAPI.getBotConversation(agentId),
      window.electronAPI.listManagedAgentRoutines(agentId),
    ]);
    if (requestId !== conversationRequestRef.current) return;
    setEvents(conversation.flatMap((entry) => entry.events).slice(-1_000));
    setRoutines(nextRoutines);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadBots()
      .catch(
        (cause) => !cancelled && setError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [loadBots]);

  useEffect(() => {
    if (!selectedAgentId) {
      setEvents([]);
      setRoutines([]);
      return;
    }
    setEnvironmentId(selected?.binding.defaultEnvironmentId || environments[0]?.id || "");
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        await loadConversation(selectedAgentId);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) timer = window.setTimeout(poll, 3000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      conversationRequestRef.current += 1;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [environments, loadConversation, selected?.binding.defaultEnvironmentId, selectedAgentId]);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ block: "end" });
  }, [events, selectedAgentId]);

  const sendMessage = async () => {
    const body = message.trim();
    if (!selected || !body || sending) return;
    if (!environmentId) {
      setError("Choose a default environment before starting this bot.");
      return;
    }
    setSending(true);
    setError(undefined);
    try {
      if (selected.binding.defaultEnvironmentId !== environmentId) {
        await window.electronAPI.updateBotBinding(selected.agent.id, {
          defaultEnvironmentId: environmentId,
        });
      }
      await window.electronAPI.sendBotMessage({
        fromAgentId: "user",
        toAgentId: selected.agent.id,
        body,
        kind: "request",
        conversationId: `bot:${selected.agent.id}`,
        idempotencyKey: `ui:${selected.agent.id}:${crypto.randomUUID()}`,
      });
      composer.clearIfUnchanged(body);
      await Promise.all([loadConversation(selected.agent.id), loadBots()]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };

  const togglePin = async () => {
    if (!selected) return;
    await window.electronAPI.updateBotBinding(selected.agent.id, {
      pinned: !selected.binding.pinned,
    });
    await loadBots();
  };

  if (loading) {
    return (
      <main className="bot-workspace bot-workspace-loading">
        <div className="bot-skeleton bot-skeleton-roster" />
        <div className="bot-skeleton bot-skeleton-chat" />
        <div className="bot-skeleton bot-skeleton-inspector" />
      </main>
    );
  }

  if (showRooms) {
    return (
      <BotRoomsPanel bots={bots} onOpenBots={() => setShowRooms(false)} onExit={onExit} />
    );
  }

  return (
    <main className="bot-workspace">
      <aside className="bot-roster">
        <div className="bot-brand-row">
          <button className="bot-quiet-button" onClick={onExit} title="Back to CoWork">
            <ArrowLeft size={17} />
          </button>
          <div className="bot-brand-copy">
            <strong>CoWork Bots</strong>
            <span>Always-on agents</span>
          </div>
          <button className="bot-icon-button" onClick={onOpenAgents} title="Create a bot">
            <Plus size={17} />
          </button>
        </div>

        <div className="bot-view-tabs" role="tablist" aria-label="Bot workspace views">
          <button className="active" role="tab" aria-selected="true">
            <Bot size={14} /> Bots
          </button>
          <button role="tab" aria-selected="false" onClick={() => setShowRooms(true)}>
            <UsersRound size={14} /> Rooms
          </button>
        </div>

        <label className="bot-search">
          <Search size={14} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search bots"
            aria-label="Search bots"
          />
          {search ? (
            <button onClick={() => setSearch("")} title="Clear search" type="button">
              <X size={13} />
            </button>
          ) : null}
        </label>

        <div className="bot-roster-section-label">
          <span>Your bots</span>
          <span>{filteredBots.length}</span>
        </div>
        <div className="bot-roster-list">
          {filteredBots.map((bot, index) => (
            <button
              key={bot.agent.id}
              className={`bot-roster-item ${selectedAgentId === bot.agent.id ? "active" : ""}`}
              onClick={() => setSelectedAgentId(bot.agent.id)}
              style={{ "--bot-list-index": index } as CSSProperties}
            >
              <span className="bot-avatar" style={avatarStyle(bot.agent.name)}>
                {initials(bot.agent.name)}
              </span>
              <span className="bot-roster-copy">
                <span className="bot-roster-name">
                  {bot.agent.name}
                  {bot.binding.pinned ? <Pin size={11} fill="currentColor" /> : null}
                </span>
                <span className="bot-roster-preview">
                  {bot.canonicalSession?.latestSummary || bot.agent.description || "Ready to work"}
                </span>
              </span>
              <span className={`bot-runtime-dot ${bot.binding.runtimeKind}`} />
            </button>
          ))}
          {bots.length === 0 ? (
            <div className="bot-empty-roster">
              <Bot size={26} />
              <p>No bots yet.</p>
              <button onClick={onOpenAgents}>Create your first bot</button>
            </div>
          ) : filteredBots.length === 0 ? (
            <div className="bot-empty-roster compact">
              <Search size={20} />
              <p>No matching bots.</p>
            </div>
          ) : null}
        </div>
        <div className="bot-roster-footer">
          <button className="bot-new-button" onClick={onOpenAgents}>
            <Plus size={16} /> New bot
          </button>
          <button className="bot-manage-button" onClick={onOpenAgents}>
            Manage agents <ChevronRight size={14} />
          </button>
        </div>
      </aside>

      <section className="bot-chat">
        {selected ? (
          <>
            <header className="bot-chat-header">
              <span className="bot-avatar large" style={avatarStyle(selected.agent.name)}>
                {initials(selected.agent.name)}
              </span>
              <div className="bot-chat-identity">
                <h1>{selected.agent.name}</h1>
                <span>
                  @{selected.agent.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")} · v
                  {selected.agent.currentVersion} · Memory on
                </span>
              </div>
              <div className="bot-chat-actions">
                <button className="bot-icon-button" onClick={togglePin} title="Pin bot">
                  <Pin size={16} fill={selected.binding.pinned ? "currentColor" : "none"} />
                </button>
                <button className="bot-secondary-button bot-capabilities-button" onClick={onOpenAgents}>
                  <Settings2 size={15} /> Capabilities
                </button>
                <button
                  className={`bot-icon-button ${inspectorOpen ? "active" : ""}`}
                  onClick={() => setInspectorOpen((current) => !current)}
                  title="Bot details"
                >
                  <PanelRight size={16} />
                </button>
              </div>
            </header>

            <div className="bot-message-list">
              <div className="bot-message-list-inner" aria-live="polite">
                {conversationMessages.length === 0 ? (
                  <div className="bot-chat-empty">
                    <span className="bot-empty-mark" style={avatarStyle(selected.agent.name)}>
                      {initials(selected.agent.name)}
                    </span>
                    <h3>What should {selected.agent.name} work on?</h3>
                    <p>Send a message, hand off a task, or schedule recurring work.</p>
                    <div className="bot-prompt-chips">
                      <button onClick={() => setMessage("Give me a concise morning brief every weekday.")}>Plan a recurring brief</button>
                      <button onClick={() => setMessage("Review my latest work and tell me what needs attention.")}>Review recent work</button>
                    </div>
                  </div>
                ) : (
                  conversationMessages.map((entry) => (
                    <article key={entry.id} className={`bot-message ${entry.role}`}>
                      <div className="bot-message-bubble markdown-content">
                        <MarkdownRenderer withBreaks>{entry.text}</MarkdownRenderer>
                      </div>
                    </article>
                  ))
                )}
                {selected.runtime?.state === "running" || selected.runtime?.state === "queued" ? (
                  <div className="bot-turn-status" role="status">
                    <LoaderCircle className="spin" size={13} />
                    {selected.runtime.state === "queued" ? "Queued" : `${selected.agent.name} is working`}
                  </div>
                ) : null}
                <div ref={messageEndRef} />
              </div>
            </div>

            <footer className="bot-chat-footer">
              {error || conversationFailure ? (
                <div className="bot-error-banner">
                  <CircleAlert size={15} /> {error || conversationFailure}
                </div>
              ) : null}
              <div className="bot-composer">
                <textarea
                  key={`bot:${selected.agent.id}`}
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void sendMessage();
                    }
                  }}
                  placeholder={`Message ${selected.agent.name}`}
                  rows={1}
                />
                <button
                  aria-label={`Send message to ${selected.agent.name}`}
                  onClick={() => void sendMessage()}
                  disabled={!message.trim() || sending}
                >
                  {sending ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}
                </button>
              </div>
              <div className="bot-composer-meta">
                {!selected.binding.defaultEnvironmentId ? (
                  <select
                    value={environmentId}
                    onChange={(event) => setEnvironmentId(event.target.value)}
                    aria-label="Bot environment"
                  >
                    <option value="">Choose environment…</option>
                    {environments.map((environment) => (
                      <option key={environment.id} value={environment.id}>
                        {environment.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span>{environments.find((environment) => environment.id === environmentId)?.name || "Local environment"}</span>
                )}
                <span>Enter to send · Shift Enter for a new line</span>
              </div>
            </footer>
          </>
        ) : null}
      </section>

      {inspectorOpen ? (
        <button
          className="bot-inspector-scrim"
          onClick={() => setInspectorOpen(false)}
          aria-label="Close bot details"
        />
      ) : null}
      <aside className={`bot-inspector ${inspectorOpen ? "open" : ""}`} aria-hidden={!inspectorOpen}>
        {selected ? (
          <>
            <div className="bot-inspector-title">
              <span>Bot inspector</span>
              <div className="bot-inspector-actions">
                <button
                  className="bot-icon-button"
                  onClick={() => void Promise.all([loadBots(), loadConversation(selected.agent.id)])}
                  title="Refresh"
                >
                  <RefreshCw size={15} />
                </button>
                <button className="bot-icon-button" onClick={() => setInspectorOpen(false)} title="Close">
                  <X size={15} />
                </button>
              </div>
            </div>
            <div className="bot-inspector-profile">
              <span className="bot-avatar large" style={avatarStyle(selected.agent.name)}>
                {initials(selected.agent.name)}
              </span>
              <strong>{selected.agent.name}</strong>
              <span>{selected.agent.description || "Persistent CoWork bot"}</span>
            </div>
            <section>
              <h3>Runtime</h3>
              <dl>
                <div>
                  <dt>Location</dt>
                  <dd>{selected.binding.runtimeKind}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>
                    {(selected.runtime?.state || selected.canonicalSession?.status || "not_started").replace(
                      "_",
                      " ",
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Queued</dt>
                  <dd>{selected.queuedCount}</dd>
                </div>
              </dl>
            </section>
            <section>
              <h3>
                <CalendarClock size={14} /> Routines
              </h3>
              {routines.length ? (
                routines.slice(0, 5).map((routine) => (
                  <div className="bot-routine-row" key={routine.id}>
                    <span>{routine.name}</span>
                    <small>{routine.enabled ? "Active" : "Paused"}</small>
                  </div>
                ))
              ) : (
                <p className="bot-muted">No recurring work yet.</p>
              )}
            </section>
            <section>
              <h3>Environment</h3>
              <select
                value={environmentId}
                onChange={async (event) => {
                  const value = event.target.value;
                  setEnvironmentId(value);
                  if (value) {
                    await window.electronAPI.updateBotBinding(selected.agent.id, {
                      defaultEnvironmentId: value,
                    });
                    await loadBots();
                  }
                }}
              >
                <option value="">Not configured</option>
                {environments.map((environment) => (
                  <option key={environment.id} value={environment.id}>
                    {environment.name}
                  </option>
                ))}
              </select>
            </section>
          </>
        ) : null}
      </aside>
    </main>
  );
}
