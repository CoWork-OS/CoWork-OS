import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  CalendarClock,
  CircleAlert,
  LoaderCircle,
  MessageSquareText,
  Pin,
  Plus,
  RefreshCw,
  Send,
  Settings2,
  UsersRound,
} from "lucide-react";

import type {
  BotSummary,
  ManagedAgentRoutineRecord,
  ManagedEnvironment,
  ManagedSessionEvent,
} from "../../../shared/types";
import "./bots.css";
import { BotRoomsPanel } from "./BotRoomsPanel";

interface BotWorkspaceProps {
  onOpenAgents: () => void;
}

function eventText(event: ManagedSessionEvent): string {
  const payload = event.payload as Record<string, unknown>;
  const content = Array.isArray(payload.content) ? payload.content : [];
  const contentText = content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const record = item as Record<string, unknown>;
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
  if (contentText) return contentText;
  for (const key of ["message", "text", "summary", "result", "error"]) {
    if (typeof payload[key] === "string" && payload[key]) return String(payload[key]);
  }
  const nested = payload.payload;
  if (nested && typeof nested === "object") {
    const record = nested as Record<string, unknown>;
    for (const key of ["message", "text", "summary", "result", "error"]) {
      if (typeof record[key] === "string" && record[key]) return String(record[key]);
    }
  }
  return "";
}

function eventRole(event: ManagedSessionEvent): "user" | "assistant" | "system" {
  if (event.type === "user.message" || event.type === "input.received") return "user";
  if (event.type === "assistant.message") return "assistant";
  return "system";
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

export function BotWorkspace({ onOpenAgents }: BotWorkspaceProps) {
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>();
  const [environments, setEnvironments] = useState<ManagedEnvironment[]>([]);
  const [environmentId, setEnvironmentId] = useState("");
  const [events, setEvents] = useState<ManagedSessionEvent[]>([]);
  const [routines, setRoutines] = useState<ManagedAgentRoutineRecord[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [showRooms, setShowRooms] = useState(false);
  const conversationRequestRef = useRef(0);

  const selected = useMemo(
    () => bots.find((bot) => bot.agent.id === selectedAgentId),
    [bots, selectedAgentId],
  );

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
      setMessage("");
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
    return <BotRoomsPanel bots={bots} onOpenBots={() => setShowRooms(false)} />;
  }

  return (
    <main className="bot-workspace">
      <aside className="bot-roster">
        <div className="bot-roster-header">
          <div>
            <span className="bot-eyebrow">Persistent agents</span>
            <h2>Bots</h2>
          </div>
          <button className="bot-icon-button" onClick={onOpenAgents} title="Create a bot">
            <Plus size={17} />
          </button>
        </div>
        <div className="bot-roster-list">
          {bots.map((bot) => (
            <button
              key={bot.agent.id}
              className={`bot-roster-item ${selectedAgentId === bot.agent.id ? "active" : ""}`}
              onClick={() => setSelectedAgentId(bot.agent.id)}
            >
              <span className="bot-avatar">{initials(bot.agent.name)}</span>
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
          ) : null}
        </div>
        <button className="bot-secondary-button bot-view-switch" onClick={() => setShowRooms(true)}>
          <UsersRound size={15} /> Bot rooms
        </button>
        <button className="bot-new-button" onClick={onOpenAgents}>
          <Plus size={16} /> New bot
        </button>
      </aside>

      <section className="bot-chat">
        {selected ? (
          <>
            <header className="bot-chat-header">
              <span className="bot-avatar large">{initials(selected.agent.name)}</span>
              <div>
                <h1>{selected.agent.name}</h1>
                <span>
                  @{selected.agent.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")} · v
                  {selected.agent.currentVersion}
                </span>
              </div>
              <div className="bot-chat-actions">
                <button className="bot-icon-button" onClick={togglePin} title="Pin bot">
                  <Pin size={16} fill={selected.binding.pinned ? "currentColor" : "none"} />
                </button>
                <button className="bot-secondary-button" onClick={onOpenAgents}>
                  <Settings2 size={15} /> Capabilities
                </button>
              </div>
            </header>

            <div className="bot-version-banner">
              This chat is pinned to its starting agent version. Capability changes apply to new
              sessions.
            </div>

            <div className="bot-message-list">
              {events.length === 0 ? (
                <div className="bot-chat-empty">
                  <MessageSquareText size={34} />
                  <h3>Start working with {selected.agent.name}</h3>
                  <p>The conversation stays attached to this bot across sessions and restarts.</p>
                </div>
              ) : (
                events.map((event) => {
                  const text = eventText(event);
                  if (!text) return null;
                  const role = eventRole(event);
                  return (
                    <article key={event.id} className={`bot-message ${role}`}>
                      <span className="bot-message-role">
                        {role === "user"
                          ? "You"
                          : role === "assistant"
                            ? selected.agent.name
                            : "Activity"}
                      </span>
                      <p>{text}</p>
                    </article>
                  );
                })
              )}
            </div>

            {error ? (
              <div className="bot-error-banner">
                <CircleAlert size={15} /> {error}
              </div>
            ) : null}
            <div className="bot-composer">
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
              ) : null}
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void sendMessage();
                  }
                }}
                placeholder={`Message ${selected.agent.name}`}
                rows={2}
              />
              <button onClick={() => void sendMessage()} disabled={!message.trim() || sending}>
                {sending ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}
              </button>
            </div>
          </>
        ) : null}
      </section>

      <aside className="bot-inspector">
        {selected ? (
          <>
            <div className="bot-inspector-title">
              <span>Bot inspector</span>
              <button
                className="bot-icon-button"
                onClick={() => void Promise.all([loadBots(), loadConversation(selected.agent.id)])}
                title="Refresh"
              >
                <RefreshCw size={15} />
              </button>
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
                  <dd>{selected.canonicalSession?.status || "not started"}</dd>
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
