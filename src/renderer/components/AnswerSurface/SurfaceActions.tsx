import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  SurfaceActionOrigin,
  SurfaceActionRequest,
} from "../../../shared/answer-surfaces/actions";

/**
 * Asks the user to approve an answer surface's action. Resolves true once the approved
 * action was carried out, false when it was cancelled or another request is open.
 */
export type SurfaceActionHandler = (
  request: SurfaceActionRequest,
  origin: SurfaceActionOrigin,
) => Promise<boolean>;

const SurfaceActionContext = createContext<SurfaceActionHandler | null>(null);

/**
 * The confirm button wakes up this long after the dialog opens, so a double click or a
 * held Enter that opened it cannot also approve it.
 */
export const SURFACE_ACTION_CONFIRM_DELAY_MS = 700;

/** The handler for surfaces in this view, or null where actions are not offered. */
export function useSurfaceActions(): SurfaceActionHandler | null {
  return useContext(SurfaceActionContext);
}

type Pending = {
  request: SurfaceActionRequest;
  origin: SurfaceActionOrigin;
  resolve: (approved: boolean) => void;
};

/**
 * Offers surface actions to everything inside it. The confirmation is drawn here, by the
 * app, so neither a model-written block nor page code can fake or skip it; one request
 * is open at a time and any others are refused while it is.
 */
export function SurfaceActionProvider({
  scopeKey,
  onSendPrompt,
  onOpenLink,
  children,
}: {
  /** The conversation the actions belong to; an open request is cancelled when it changes. */
  scopeKey?: string;
  onSendPrompt: (text: string, origin: SurfaceActionOrigin) => void | Promise<void>;
  onOpenLink: (url: string) => void | Promise<void>;
  children: ReactNode;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const handlersRef = useRef({ onSendPrompt, onOpenLink });
  handlersRef.current = { onSendPrompt, onOpenLink };

  const request = useCallback<SurfaceActionHandler>(
    (next, origin) =>
      new Promise<boolean>((resolve) => {
        if (pendingRef.current) {
          resolve(false);
          return;
        }
        const entry = { request: next, origin, resolve };
        pendingRef.current = entry;
        setPending(entry);
      }),
    [],
  );

  const settle = useCallback(async (approved: boolean) => {
    const entry = pendingRef.current;
    if (!entry) return;
    pendingRef.current = null;
    setPending(null);
    if (!approved) {
      entry.resolve(false);
      return;
    }
    try {
      if (entry.request.kind === "prompt")
        await handlersRef.current.onSendPrompt(entry.request.text, entry.origin);
      else await handlersRef.current.onOpenLink(entry.request.url);
      entry.resolve(true);
    } catch {
      entry.resolve(false);
    }
  }, []);

  // A request left open when the view goes away, or moves to another conversation,
  // counts as cancelled: the message must not land somewhere the user did not see.
  useEffect(
    () => () => {
      const entry = pendingRef.current;
      pendingRef.current = null;
      setPending(null);
      entry?.resolve(false);
    },
    [scopeKey],
  );

  return (
    <SurfaceActionContext.Provider value={request}>
      {children}
      {pending && (
        <SurfaceActionConfirm
          request={pending.request}
          origin={pending.origin}
          onDecide={(approved) => void settle(approved)}
        />
      )}
    </SurfaceActionContext.Provider>
  );
}

function SurfaceActionConfirm({
  request,
  origin,
  onDecide,
}: {
  request: SurfaceActionRequest;
  origin: SurfaceActionOrigin;
  onDecide: (approved: boolean) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const decidedRef = useRef(false);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), SURFACE_ACTION_CONFIRM_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  const decide = useCallback(
    (approved: boolean) => {
      if (decidedRef.current) return;
      decidedRef.current = true;
      onDecide(approved);
    },
    [onDecide],
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  const isPrompt = request.kind === "prompt";
  const fromPage = origin === "page";
  const copy = useMemo(
    () => ({
      title: isPrompt ? "Send this message?" : "Open this link?",
      source: fromPage
        ? "An interactive page in this answer is asking. Pages can't send anything or open links without your OK."
        : "From a button in this answer.",
      note: isPrompt
        ? "It will be sent as your message, and the agent will act on it."
        : "It opens in your web browser.",
      confirm: isPrompt ? "Send message" : "Open link",
    }),
    [fromPage, isPrompt],
  );

  return (
    <dialog
      ref={dialogRef}
      className="as-action-dialog"
      aria-labelledby="as-action-title"
      onCancel={(event) => {
        event.preventDefault();
        decide(false);
      }}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog element itself.
        if (event.target === dialogRef.current) decide(false);
      }}
    >
      <div className="as-action-body">
        <h2 id="as-action-title" className="as-action-title">
          {copy.title}
        </h2>
        <p className="as-action-source">{copy.source}</p>
        {request.kind === "prompt" ? (
          <blockquote className="as-action-message">{request.text}</blockquote>
        ) : (
          <div className="as-action-link">
            <strong className="as-action-host">{request.host}</strong>
            <span className="as-action-url">{request.url}</span>
            {fromPage && request.extra > 0 && (
              <span className="as-action-warning">
                The link carries {request.extra} characters of data from the page.
              </span>
            )}
          </div>
        )}
        <p className="as-action-note">{copy.note}</p>
        <div className="as-action-buttons">
          <button
            type="button"
            className="as-action-cancel"
            // Focus starts on Cancel, so Enter never approves by accident.
            autoFocus
            onClick={() => decide(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="as-action-confirm"
            disabled={!armed}
            onClick={() => decide(true)}
          >
            {copy.confirm}
          </button>
        </div>
      </div>
    </dialog>
  );
}
