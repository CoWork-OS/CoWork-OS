import { useState } from "react";
import { Send, X } from "lucide-react";

export type ManualComposeMode = "reply" | "reply_all" | "forward";
export interface ManualComposeDraft {
  mode: ManualComposeMode;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
}

export function splitMailboxRecipients(value: string): string[] {
  return value
    .split(/[,\n;]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Keep keystrokes local to the form instead of reconciling the mailbox and reader. */
export function InboxManualCompose({
  initialDraft,
  busy,
  onModeChange,
  onClose,
  onSend,
}: {
  initialDraft: ManualComposeDraft;
  busy: boolean;
  onModeChange: (mode: ManualComposeMode) => void;
  onClose: () => void;
  onSend: (draft: ManualComposeDraft) => void;
}) {
  const [draft, setDraft] = useState(initialDraft);
  const update = (field: keyof Omit<ManualComposeDraft, "mode">, value: string) =>
    setDraft((current) => ({ ...current, [field]: value }));
  const canSend =
    !busy &&
    Boolean(draft.body.trim()) &&
    splitMailboxRecipients(draft.to).length +
      splitMailboxRecipients(draft.cc).length +
      splitMailboxRecipients(draft.bcc).length >
      0;
  return (
    <div className="ibx-compose">
      <div className="ibx-compose-head">
        <div className="ibx-segmented" role="group" aria-label="Compose mode">
          {(["reply", "reply_all", "forward"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={draft.mode === mode}
              disabled={busy}
              onClick={() => onModeChange(mode)}
            >
              {mode === "reply_all" ? "Reply all" : mode === "forward" ? "Forward" : "Reply"}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="ibx-icon-btn"
          aria-label="Close"
          title="Close"
          disabled={busy}
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </div>
      <label className="ibx-compose-field">
        <span>To</span>
        <input
          aria-label="To"
          value={draft.to}
          onChange={(event) => update("to", event.target.value)}
        />
      </label>
      <div className="ibx-compose-split">
        <label className="ibx-compose-field">
          <span>Cc</span>
          <input
            aria-label="Cc"
            value={draft.cc}
            onChange={(event) => update("cc", event.target.value)}
          />
        </label>
        <label className="ibx-compose-field">
          <span>Bcc</span>
          <input
            aria-label="Bcc"
            value={draft.bcc}
            onChange={(event) => update("bcc", event.target.value)}
          />
        </label>
      </div>
      <label className="ibx-compose-field">
        <span>Subject</span>
        <input
          aria-label="Subject"
          value={draft.subject}
          onChange={(event) => update("subject", event.target.value)}
        />
      </label>
      <textarea
        aria-label="Message"
        placeholder="Write your message…"
        className={draft.mode === "forward" ? "is-tall" : undefined}
        value={draft.body}
        onChange={(event) => update("body", event.target.value)}
      />
      <div className="ibx-compose-foot">
        <div className="ibx-compose-foot-actions">
          <button
            type="button"
            className="ibx-btn ibx-btn--ghost"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="ibx-btn ibx-btn--primary"
            disabled={!canSend}
            onClick={() => onSend(draft)}
          >
            <Send size={13} />
            {draft.mode === "forward" ? "Forward" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
