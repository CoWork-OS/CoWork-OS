import { createContext, useContext, useEffect, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";
import "./next-action.css";

/**
 * The suggested next steps under an answer (a ```cowork-next block): up to three buttons,
 * each labelled with the whole message it sends; the most likely one leads. It shows only under the newest reply of a conversation
 * that is waiting for the user, so an old suggestion never fires into a later context.
 */
export type NextActionScope = {
  /** The message (event id) whose next step is live, or null when none is. */
  activeMessageKey: string | null;
  /** Sends the text as the user's message; rejects when it was not sent. */
  send: (text: string) => Promise<void>;
};

export const NextActionContext = createContext<NextActionScope | null>(null);

/**
 * Clicks this soon after the button appears are ignored: it shows the moment a run ends,
 * and a click meant for something that was there a moment ago must not send a message.
 */
export const NEXT_ACTION_ARM_DELAY_MS = 700;

export function NextActions({ steps, messageKey }: { steps: string[]; messageKey?: string }) {
  const scope = useContext(NextActionContext);
  const active = Boolean(scope && messageKey && scope.activeMessageKey === messageKey);
  const shownAtRef = useRef(0);
  const [sendingText, setSendingText] = useState<string | null>(null);

  useEffect(() => {
    if (active) shownAtRef.current = Date.now();
  }, [active]);

  if (!scope || !active || steps.length === 0) return null;

  const handleClick = async (text: string) => {
    if (sendingText !== null || Date.now() - shownAtRef.current < NEXT_ACTION_ARM_DELAY_MS) return;
    setSendingText(text);
    try {
      await scope.send(text);
    } catch {
      // Not sent (no conversation, or the send was refused): offer them again.
      setSendingText(null);
    }
  };

  return (
    <div className="next-action" role="group" aria-label="Suggested next steps">
      {steps.map((text, index) => (
        <button
          key={text}
          type="button"
          className={`next-action-button${index === 0 ? " is-primary" : ""}`}
          disabled={sendingText !== null}
          aria-busy={sendingText === text || undefined}
          title="Sends this as your message"
          onClick={() => void handleClick(text)}
        >
          {index === 0 && <ArrowUp className="next-action-icon" aria-hidden="true" />}
          <span className="next-action-text">{text}</span>
        </button>
      ))}
    </div>
  );
}
