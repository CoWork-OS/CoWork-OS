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
  const [readError, setReadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    try {
      const next = await window.electronAPI.getQueuedTaskInputs(taskId);
      if (mounted.current && request === generation.current) {
        setItems(next);
        setReadError(null);
      }
    } catch (cause) {
      if (mounted.current && request === generation.current) {
        setReadError(cause instanceof Error ? cause.message : "Unable to read queued messages.");
      }
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
          "task_queued",
          "task_dequeued",
          "task_status",
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

  const queuedVersion = edit
    ? items.find((item) => item.id === edit.item.id && item.kind === edit.item.kind)
    : undefined;
  const editConflict = edit
    ? !queuedVersion
      ? "This message is no longer queued."
      : queuedVersion.revision !== edit.item.revision || queuedVersion.message !== edit.item.message
        ? "This queued message changed while you were editing."
        : null
    : null;

  const save = async () => {
    if (!edit || saving || editConflict || !edit.text.trim()) return;
    const submitted = edit;
    setSaving(true);
    setSaveError(null);
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
      if (mounted.current) {
        setSaveError(
          cause instanceof Error ? cause.message : "Unable to save this queued message.",
        );
        await refresh();
      }
    } finally {
      if (mounted.current) setSaving(false);
    }
  };
  if (!items.length && !edit && !readError && !saveError) return null;
  return (
    <section className="queued-messages-panel" aria-label="Queued messages">
      <strong>Queued messages</strong>
      {items.length > 0 && (
        <span className="queued-messages-hint">
          Changes reach the agent before this message starts.
        </span>
      )}
      {items.map((item) => (
        <div className="queued-messages-row" key={`${item.kind}:${item.id}`}>
          <span>{item.message}</span>
          <button
            type="button"
            disabled={saving || Boolean(edit)}
            onClick={() => {
              setEdit({ item, text: item.message });
              setSaveError(null);
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
          {editConflict && !saving && (
            <div role="status">{editConflict} Copy your draft before closing this editor.</div>
          )}
          <div>
            <button
              type="button"
              disabled={saving || Boolean(editConflict) || !edit.text.trim()}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save queued message"}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                setEdit(null);
                setSaveError(null);
              }}
            >
              Cancel edit
            </button>
          </div>
        </div>
      )}
      {readError && (
        <div role="alert">
          {readError}{" "}
          <button type="button" onClick={() => void refresh()}>
            Refresh queue
          </button>
        </div>
      )}
      {saveError && (
        <div role="alert">
          {saveError} {edit && "Your draft is preserved here."}
        </div>
      )}
    </section>
  );
}
