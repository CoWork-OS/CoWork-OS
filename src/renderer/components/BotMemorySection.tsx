import { useState } from "react";
import { BookOpen, Undo2, X } from "lucide-react";
import { useBotMemory } from "../hooks/useBotMemory";
import type { MemoryRepoBotChange } from "../../shared/memory-repo-types";

const ENTRIES_SHOWN = 6;

function changeLabel(change: MemoryRepoBotChange): string {
  const added = change.added.length;
  const removed = change.removed.length;
  if (change.message.startsWith("Undo:")) {
    if (added) return `Restored: ${change.added[0]}`;
    if (removed) return `Undid: ${change.removed[0]}`;
  }
  if (added && !removed) return `Saved: ${change.added[0]}`;
  if (removed && !added) return `Removed: ${change.removed[0]}`;
  if (added && removed) return `Changed: ${change.added[0]}`;
  return change.message;
}

function shortDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * The bot's own memory in its details panel: what it saved about its job and the user's
 * wishes for it, with Forget per entry and a history of changes with Undo.
 */
export function BotMemorySection({ botId, refreshKey }: { botId: string; refreshKey?: unknown }) {
  const { report, loading, error, busy, forget, undo } = useBotMemory(botId, refreshKey);
  const [showAll, setShowAll] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  if (!report?.available && !loading) return null;
  const entries = report?.entries ?? [];
  const visible = showAll ? entries : entries.slice(0, ENTRIES_SHOWN);
  const history = report?.history ?? [];

  return (
    <section className="bot-details-section" aria-label="Bot memory">
      <h3 className="bot-details-section-heading">
        <BookOpen size={13} />
        <span>Memory</span>
      </h3>
      {entries.length === 0 ? (
        <p className="bot-details-hint">
          {loading
            ? "Loading…"
            : "Nothing saved yet. The bot saves what it learns about its job here."}
        </p>
      ) : (
        <ul className="bot-memory-list">
          {visible.map((entry) => (
            <li key={entry.ref} className="bot-memory-entry">
              <span className="bot-memory-text">
                {entry.text}
                {entry.until ? <small> · until {entry.until}</small> : null}
              </span>
              {report?.writable ? (
                <button
                  type="button"
                  className="bot-details-icon-button"
                  aria-label={`Forget: ${entry.text}`}
                  title="Forget"
                  disabled={busy}
                  onClick={() => void forget(entry.ref, entry.hash)}
                >
                  <X size={12} />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {entries.length > ENTRIES_SHOWN ? (
        <button type="button" className="bot-details-link" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Show less" : `Show all ${entries.length}`}
        </button>
      ) : null}
      {history.length > 0 ? (
        <button
          type="button"
          className="bot-details-link"
          aria-expanded={showHistory}
          onClick={() => setShowHistory((open) => !open)}
        >
          {showHistory ? "Hide changes" : "Recent changes"}
        </button>
      ) : null}
      {showHistory ? (
        <ul className="bot-memory-list bot-memory-history">
          {history.map((change) => (
            <li key={change.commit} className="bot-memory-entry">
              <span className="bot-memory-text">
                {changeLabel(change)}
                <small> · {shortDate(change.at)}</small>
              </span>
              {report?.writable ? (
                <button
                  type="button"
                  className="bot-details-icon-button"
                  aria-label={`Undo: ${changeLabel(change)}`}
                  title="Undo this change"
                  disabled={busy}
                  onClick={() => void undo(change.commit)}
                >
                  <Undo2 size={12} />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p className="bot-details-hint" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
