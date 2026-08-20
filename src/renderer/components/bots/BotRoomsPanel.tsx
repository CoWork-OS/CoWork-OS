import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, LoaderCircle, MessageSquareText, Plus, Send, UsersRound } from "lucide-react";

import type {
  BotRoom,
  BotRoomExecutionMode,
  BotRoomMember,
  BotRoomMessage,
  BotSummary,
} from "../../../shared/types";

interface BotRoomsPanelProps {
  bots: BotSummary[];
  onOpenBots: () => void;
}

export function BotRoomsPanel({ bots, onOpenBots }: BotRoomsPanelProps) {
  const [rooms, setRooms] = useState<BotRoom[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState<string>();
  const [members, setMembers] = useState<BotRoomMember[]>([]);
  const [messages, setMessages] = useState<BotRoomMessage[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [executionMode, setExecutionMode] = useState<BotRoomExecutionMode>("sequential");
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const selected = useMemo(
    () => rooms.find((room) => room.id === selectedRoomId),
    [rooms, selectedRoomId],
  );
  const botNames = useMemo(
    () => new Map(bots.map((bot) => [bot.agent.id, bot.agent.name])),
    [bots],
  );

  const loadRooms = useCallback(async () => {
    const next = await window.electronAPI.listBotRooms();
    setRooms(next);
    if (next.length === 0) setShowCreate(true);
    setSelectedRoomId((current) =>
      current && next.some((room) => room.id === current) ? current : next[0]?.id,
    );
  }, []);

  const loadSelected = useCallback(async (roomId: string) => {
    const [details, nextMessages] = await Promise.all([
      window.electronAPI.getBotRoom(roomId),
      window.electronAPI.listBotRoomMessages(roomId),
    ]);
    setMembers(details.members);
    setMessages(nextMessages.slice(-1_000));
  }, []);

  useEffect(() => {
    void loadRooms()
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoading(false));
  }, [loadRooms]);

  useEffect(() => {
    if (!selectedRoomId) {
      setMembers([]);
      setMessages([]);
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        await Promise.all([loadSelected(selectedRoomId), loadRooms()]);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) timer = window.setTimeout(poll, 2000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [loadRooms, loadSelected, selectedRoomId]);

  const createRoom = async () => {
    if (!name.trim() || memberIds.length < 2) return;
    setError(undefined);
    try {
      const room = await window.electronAPI.createBotRoom({
        name: name.trim(),
        memberAgentIds: memberIds,
        ownerAgentId: executionMode === "leader" ? memberIds[0] : undefined,
        executionMode,
        maxRounds: 3,
        maxMessages: Math.min(100, Math.max(10, memberIds.length * 3)),
      });
      setName("");
      setMemberIds([]);
      setShowCreate(false);
      await loadRooms();
      setSelectedRoomId(room.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const sendMessage = async () => {
    const body = message.trim();
    if (!selected || !body || sending) return;
    setSending(true);
    setError(undefined);
    try {
      await window.electronAPI.appendBotRoomUserMessage(selected.id, body);
      setMessage("");
      await loadSelected(selected.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
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

  return (
    <main className="bot-workspace">
      <aside className="bot-roster">
        <div className="bot-roster-header">
          <div>
            <span className="bot-eyebrow">Multi-bot collaboration</span>
            <h2>Rooms</h2>
          </div>
          <button className="bot-icon-button" onClick={() => setShowCreate(true)} title="New room">
            <Plus size={17} />
          </button>
        </div>
        <button className="bot-secondary-button bot-view-switch" onClick={onOpenBots}>
          <Bot size={15} /> Individual bots
        </button>
        <div className="bot-roster-list">
          {rooms.map((room) => (
            <button
              key={room.id}
              className={`bot-roster-item ${selectedRoomId === room.id ? "active" : ""}`}
              onClick={() => {
                setShowCreate(false);
                setSelectedRoomId(room.id);
              }}
            >
              <span className="bot-avatar"><UsersRound size={17} /></span>
              <span className="bot-roster-copy">
                <span className="bot-roster-name">{room.name}</span>
                <span className="bot-roster-preview">
                  {room.activeRunId ? `Working · round ${room.currentRound}` : room.executionMode}
                </span>
              </span>
            </button>
          ))}
        </div>
        <button className="bot-new-button" onClick={() => setShowCreate(true)}>
          <Plus size={16} /> New room
        </button>
      </aside>

      <section className="bot-chat">
        {showCreate ? (
          <div className="bot-room-create">
            <UsersRound size={32} />
            <h1>Create a bot room</h1>
            <label className="bot-form-field">
              <span>Room name</span>
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Release review" />
            </label>
            <label className="bot-form-field">
              <span>Working style</span>
              <select value={executionMode} onChange={(event) => setExecutionMode(event.target.value as BotRoomExecutionMode)}>
                <option value="sequential">Sequential</option>
                <option value="parallel">Parallel</option>
                <option value="leader">Leader synthesis</option>
              </select>
              <small>Leader synthesis uses the first selected bot as the final reviewer.</small>
            </label>
            <span className="bot-form-label">Members · select at least two</span>
            <div className="bot-room-member-picker">
              {bots.map((bot) => (
                <label key={bot.agent.id}>
                  <input
                    type="checkbox"
                    checked={memberIds.includes(bot.agent.id)}
                    onChange={(event) =>
                      setMemberIds((current) =>
                        event.target.checked
                          ? [...current, bot.agent.id]
                          : current.filter((id) => id !== bot.agent.id),
                      )
                    }
                  />
                  {bot.agent.name}
                </label>
              ))}
            </div>
            <button onClick={() => void createRoom()} disabled={!name.trim() || memberIds.length < 2}>
              Create room
            </button>
            {error ? <div className="bot-error-banner">{error}</div> : null}
          </div>
        ) : selected ? (
          <>
            <header className="bot-chat-header">
              <span className="bot-avatar large"><UsersRound size={20} /></span>
              <div>
                <h1>{selected.name}</h1>
                <span>{members.length} bots · {selected.executionMode}</span>
              </div>
            </header>
            <div className="bot-message-list">
              {messages.length ? messages.map((entry) => (
                <article key={entry.id} className={`bot-message ${entry.fromAgentId ? "assistant" : "user"}`}>
                  <span className="bot-message-role">
                    {entry.fromAgentId ? botNames.get(entry.fromAgentId) || entry.fromAgentId : "You"}
                    {entry.status === "late" ? " · late result" : entry.status === "failed" ? " · failed" : ""}
                  </span>
                  <p>{entry.body}</p>
                </article>
              )) : (
                <div className="bot-chat-empty">
                  <MessageSquareText size={34} />
                  <h3>Start the room</h3>
                  <p>Each bot contributes within the configured round and message limits.</p>
                </div>
              )}
            </div>
            {error ? <div className="bot-error-banner">{error}</div> : null}
            <div className="bot-composer">
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void sendMessage();
                  }
                }}
                placeholder={`Message ${selected.name}`}
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
        <div className="bot-inspector-title">Room members</div>
        {members.map((member) => (
          <div className="bot-routine-row" key={member.agentId}>
            <span>{botNames.get(member.agentId) || member.agentId}</span>
            <small>{member.status}</small>
          </div>
        ))}
      </aside>
    </main>
  );
}
