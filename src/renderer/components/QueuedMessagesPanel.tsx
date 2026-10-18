import { useCallback, useEffect, useRef, useState } from "react";
import type { QueuedTaskInput } from "../../shared/queued-task-input";
import "./queued-messages.css";

/** Render with key={taskId}: a reply from another session must never replace this draft. */
export function QueuedMessagesPanel({
  taskId,
  onChanged,
}: {
  taskId: string;
  onChanged?: () => void;
}) {
  const [items, setItems] = useState<QueuedTaskInput[]>([]);
  const [edit, setEdit] = useState<{ item: QueuedTaskInput; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    try {
      const next = await window.electronAPI.getQueuedTaskInputs(taskId);
      if (mounted.current && request === generation.current) setItems(next);
    } catch (cause) {
      if (mounted.current && request === generation.current)
        setError(cause instanceof Error ? cause.message : "Unable to read queued messages.");
    }
  }, [taskId]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = window.electronAPI.onTaskEvent((event) => {
      if (event.taskId !== taskId || timer) return;
      if (
        ![
          "user_message",
          "agent_follow_up_scheduled",
          "agent_follow_up_started",
          "task_created",
          "task_completed",
          "task_cancelled",
          "task_interrupted",
        ].includes(event.legacyType || event.payload?.legacyType || event.type) &&
        !event.payload?.queuedInputUpdated
      )
        return;
      timer = setTimeout(() => {
        timer = undefined;
        void refresh();
      }, 150);
    });
    return () => {
      mounted.current = false;
      generation.current++;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [taskId, refresh]);

  const save = async () => {
    if (!edit || saving || !edit.text.trim()) return;
    const submitted = edit;
    setSaving(true);
    setError(null);
    try {
      await window.electronAPI.editQueuedTaskInput({
        taskId,
        id: submitted.item.id,
        kind: submitted.item.kind,
        expectedMessage: submitted.item.message,
        expectedRevision: submitted.item.revision,
        message: submitted.text,
      });
      if (!mounted.current) return;
      setEdit(null);
      onChanged?.();
      await refresh();
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : "Unable to save this queued message.");
    } finally {
      if (mounted.current) setSaving(false);
    }
  };
  if (!items.length && !edit && !error) return null;
  return (
    <section className="queued-messages-panel" aria-label="Queued messages">
      <strong>Queued messages</strong>
      <span className="queued-messages-hint">
        Changes reach the agent before this message starts.
      </span>
      {items.map((item) => (
        <div className="queued-messages-row" key={`${item.kind}:${item.id}`}>
          <span>{item.message}</span>
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              setEdit({ item, text: item.message });
              setError(null);
            }}
          >
            Edit
          </button>
        </div>
      ))}
      {edit && (
        <div className="queued-message-edit">
          <textarea
            aria-label="Edit queued message"
            value={edit.text}
            disabled={saving}
            onChange={(event) => setEdit({ ...edit, text: event.target.value })}
          />
          <div>
            <button
              type="button"
              disabled={saving || !edit.text.trim()}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save queued message"}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                setEdit(null);
                setError(null);
              }}
            >
              Cancel edit
            </button>
          </div>
        </div>
      )}
      {error && (
        <div role="alert">
          {error}{" "}
          {edit && "Your edit is preserved here; copy it to send as a new message if needed."}
        </div>
      )}
    </section>
  );
}
