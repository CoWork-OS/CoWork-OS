import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, ExternalLink, Loader2, Mail, Paperclip, Send, Trash2, X } from "lucide-react";
import { extractMailboxComposeDraftInputFromText } from "../../shared/mailbox";
import type {
  ChatInlineFrame,
  MailboxAccount,
  MailboxClientState,
  MailboxComposeDraft,
  MailboxComposeDraftPatch,
  MailboxComposeDraftStatus,
  MailboxIdentity,
  MailboxProvider,
  MailboxRecipientInput,
} from "../../shared/mailbox";
import "./mail-compose-frame.css";

const SAVE_DEBOUNCE_MS = 550;
const SEND_POLL_INTERVAL_MS = 2_500;

type MailComposeFrameProps = {
  frame: ChatInlineFrame;
};

type AutoMailComposeFrameProps = {
  eventId?: string;
  taskId?: string;
  assistantMessage: string;
  sourceUserMessage?: string;
  allowCreate: boolean;
};

type EditableDraftState = {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  bodyText: string;
  identityId: string;
};

function recipientToString(recipient: MailboxRecipientInput): string {
  const email = recipient.email.trim();
  const name = recipient.name?.trim();
  return name ? `${name} <${email}>` : email;
}

export function formatRecipients(recipients: readonly MailboxRecipientInput[] = []): string {
  return recipients.map(recipientToString).join(", ");
}

function parseRecipientToken(token: string): MailboxRecipientInput | null {
  const trimmed = token.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(.*?)<([^<>]+)>$/);
  if (match) {
    const name = match[1]?.trim().replace(/^"|"$/g, "");
    const email = match[2]?.trim();
    if (!email) return null;
    return { ...(name ? { name } : {}), email };
  }
  return { email: trimmed };
}

export function parseRecipients(value: string): MailboxRecipientInput[] {
  return value
    .split(/[,;\n]+/)
    .map(parseRecipientToken)
    .filter((recipient): recipient is MailboxRecipientInput => recipient !== null);
}

function editableFromDraft(draft: MailboxComposeDraft): EditableDraftState {
  return {
    to: formatRecipients(draft.to),
    cc: formatRecipients(draft.cc),
    bcc: formatRecipients(draft.bcc),
    subject: draft.subject,
    bodyText: draft.bodyText,
    identityId: draft.identityId || "",
  };
}

function buildDraftPatch(editable: EditableDraftState): MailboxComposeDraftPatch {
  return {
    to: parseRecipients(editable.to),
    cc: parseRecipients(editable.cc),
    bcc: parseRecipients(editable.bcc),
    subject: editable.subject,
    bodyText: editable.bodyText,
    bodyHtml: null,
    identityId: editable.identityId || null,
  };
}

export const extractAssistantMailDraft = extractMailboxComposeDraftInputFromText;

function draftStatusIsLocked(status: MailboxComposeDraftStatus): boolean {
  return status === "queued" || status === "scheduled" || status === "sending" || status === "sent";
}

function draftStatusIsTransient(status: MailboxComposeDraftStatus): boolean {
  return status === "queued" || status === "scheduled" || status === "sending";
}

function providerLabel(provider?: MailboxProvider): string {
  switch (provider) {
    case "gmail":
      return "Gmail";
    case "outlook_graph":
      return "Outlook";
    case "imap":
      return "Email";
    case "agentmail":
      return "AgentMail";
    default:
      return "Mailbox";
  }
}

function statusLabel(status: MailboxComposeDraftStatus): string {
  switch (status) {
    case "provider":
      return "Draft saved";
    case "queued":
      return "Queued";
    case "scheduled":
      return "Scheduled";
    case "sending":
      return "Sending";
    case "sent":
      return "Sent";
    case "failed":
      return "Failed";
    case "discarded":
      return "Discarded";
    case "local":
    default:
      return "Draft";
  }
}

function findAccount(
  frame: ChatInlineFrame,
  draft: MailboxComposeDraft | null,
  clientState: MailboxClientState | null,
): MailboxAccount | undefined {
  const accountId = draft?.accountId || frame.accountId;
  return clientState?.accounts.find((account) => account.id === accountId);
}

function identitiesForAccount(
  account: MailboxAccount | undefined,
  clientState: MailboxClientState | null,
): MailboxIdentity[] {
  if (!account) return [];
  return (clientState?.identities || []).filter((identity) => identity.accountId === account.id);
}

export const MailComposeFrame = memo(function MailComposeFrame({ frame }: MailComposeFrameProps) {
  const [draft, setDraft] = useState<MailboxComposeDraft | null>(null);
  const [clientState, setClientState] = useState<MailboxClientState | null>(null);
  const [editable, setEditable] = useState<EditableDraftState | null>(null);
  const [expandedCcBcc, setExpandedCcBcc] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const lastSavedSignatureRef = useRef("");
  const dirtyRef = useRef(false);

  const loadDraft = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [nextDraft, nextClientState] = await Promise.all([
        window.electronAPI.getMailboxDraft(frame.draftId),
        window.electronAPI.getMailboxClientState().catch(() => null),
      ]);
      setDraft(nextDraft);
      setClientState(nextClientState);
      if (nextDraft) {
        const nextEditable = editableFromDraft(nextDraft);
        const signature = JSON.stringify(nextEditable);
        lastSavedSignatureRef.current = signature;
        dirtyRef.current = false;
        setEditable(nextEditable);
        setExpandedCcBcc(nextDraft.cc.length > 0 || nextDraft.bcc.length > 0);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the draft.");
    } finally {
      setIsLoading(false);
    }
  }, [frame.draftId]);

  useEffect(() => {
    void loadDraft();
  }, [loadDraft]);

  useEffect(() => {
    if (!draft || !draftStatusIsTransient(draft.status)) return undefined;
    const interval = window.setInterval(() => {
      void loadDraft();
    }, SEND_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [draft?.status, loadDraft]);

  const account = useMemo(
    () => findAccount(frame, draft, clientState),
    [clientState, draft, frame],
  );
  const identities = useMemo(
    () => identitiesForAccount(account, clientState),
    [account, clientState],
  );
  const effectiveProvider = account?.provider || frame.provider;
  const locked = draft ? draftStatusIsLocked(draft.status) : true;
  const sendCapabilityAvailable = account?.capabilities.includes("send") ?? true;
  const hasRecipients = editable
    ? parseRecipients(editable.to).length +
        parseRecipients(editable.cc).length +
        parseRecipients(editable.bcc).length >
      0
    : false;
  const sendDisabled =
    locked ||
    isLoading ||
    isSaving ||
    isSending ||
    !editable ||
    !hasRecipients ||
    !sendCapabilityAvailable;
  const fromLabel =
    identities.find((identity) => identity.id === editable?.identityId)?.email ||
    account?.address ||
    providerLabel(effectiveProvider);

  const persistEditable = useCallback(
    async (nextEditable: EditableDraftState | null) => {
      if (!nextEditable || !draft || locked) return draft;
      const signature = JSON.stringify(nextEditable);
      if (signature === lastSavedSignatureRef.current) return draft;
      setIsSaving(true);
      setError(null);
      try {
        const nextDraft = await window.electronAPI.updateMailboxDraft(
          draft.id,
          buildDraftPatch(nextEditable),
        );
        lastSavedSignatureRef.current = signature;
        dirtyRef.current = false;
        setDraft(nextDraft);
        return nextDraft;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not save draft changes.");
        throw err;
      } finally {
        setIsSaving(false);
      }
    },
    [draft, locked],
  );

  useEffect(() => {
    if (!editable || !draft || locked) return undefined;
    const signature = JSON.stringify(editable);
    if (signature === lastSavedSignatureRef.current) return undefined;
    dirtyRef.current = true;
    const timeout = window.setTimeout(() => {
      void persistEditable(editable);
    }, SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [draft, editable, locked, persistEditable]);

  const updateField = useCallback((field: keyof EditableDraftState, value: string) => {
    setEditable((current) => (current ? { ...current, [field]: value } : current));
  }, []);

  const handleCopyBody = useCallback(async () => {
    if (!editable) return;
    try {
      await navigator.clipboard.writeText(editable.bodyText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not copy the draft body.");
    }
  }, [editable]);

  const handleSend = useCallback(async () => {
    if (!editable || !draft || sendDisabled) return;
    setIsSending(true);
    setError(null);
    try {
      const savedDraft = dirtyRef.current ? await persistEditable(editable) : draft;
      if (!savedDraft) throw new Error("Draft is not available.");
      await window.electronAPI.sendMailboxDraft(savedDraft.id);
      await loadDraft();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send this draft.");
    } finally {
      setIsSending(false);
    }
  }, [draft, editable, loadDraft, persistEditable, sendDisabled]);

  const handleDiscard = useCallback(async () => {
    if (!draft) return;
    setError(null);
    try {
      await window.electronAPI.discardMailboxDraft(draft.id);
      await loadDraft();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not discard this draft.");
    }
  }, [draft, loadDraft]);

  if (isLoading) {
    return (
      <div className="mail-compose-frame loading">
        <Loader2 size={16} className="mail-compose-spin" aria-hidden="true" />
        <span>Loading compose draft...</span>
      </div>
    );
  }

  if (!draft || !editable) {
    return (
      <div className="mail-compose-frame unavailable">
        <Mail size={16} aria-hidden="true" />
        <span>This compose draft is no longer available.</span>
      </div>
    );
  }

  const primaryStatus = statusLabel(draft.status);
  const sendLabel =
    draft.status === "queued" || draft.status === "scheduled"
      ? "Queued"
      : draft.status === "sent"
        ? "Sent"
        : `Send as ${providerLabel(effectiveProvider)}`;

  return (
    <section
      className={`mail-compose-frame status-${draft.status}`}
      aria-label="Email compose draft"
    >
      <div className="mail-compose-toolbar">
        <div className="mail-compose-title">
          <Mail size={15} aria-hidden="true" />
          <span>{primaryStatus}</span>
          <span className="mail-compose-provider">from {fromLabel}</span>
        </div>
        <div className="mail-compose-actions">
          <button
            type="button"
            className="mail-compose-icon-btn"
            onClick={handleCopyBody}
            title="Copy body"
          >
            {copied ? (
              <Check size={15} aria-hidden="true" />
            ) : (
              <Copy size={15} aria-hidden="true" />
            )}
          </button>
          <button type="button" className="mail-compose-icon-btn" title="Open in mailbox" disabled>
            <ExternalLink size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="mail-compose-send-btn"
            onClick={handleSend}
            disabled={sendDisabled}
            title={
              !sendCapabilityAvailable ? "This mailbox account cannot send email yet." : undefined
            }
          >
            {isSending ? (
              <Loader2 size={15} className="mail-compose-spin" aria-hidden="true" />
            ) : draft.status === "sent" ? (
              <Check size={15} aria-hidden="true" />
            ) : (
              <Send size={15} aria-hidden="true" />
            )}
            <span>{sendLabel}</span>
          </button>
        </div>
      </div>

      <div className="mail-compose-fields">
        {identities.length > 1 && (
          <label className="mail-compose-field">
            <span>From</span>
            <select
              value={editable.identityId}
              disabled={locked}
              onChange={(event) => updateField("identityId", event.target.value)}
            >
              <option value="">{account?.address || "Default identity"}</option>
              {identities.map((identity) => (
                <option key={identity.id} value={identity.id}>
                  {identity.displayName
                    ? `${identity.displayName} <${identity.email}>`
                    : identity.email}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="mail-compose-field recipients">
          <span>To</span>
          <input
            value={editable.to}
            disabled={locked}
            onChange={(event) => updateField("to", event.target.value)}
            placeholder="recipient@example.com"
          />
          {!expandedCcBcc && (
            <button
              type="button"
              className="mail-compose-cc-toggle"
              onClick={() => setExpandedCcBcc(true)}
              disabled={locked}
            >
              Cc/Bcc
            </button>
          )}
        </label>

        {expandedCcBcc && (
          <>
            <label className="mail-compose-field">
              <span>Cc</span>
              <input
                value={editable.cc}
                disabled={locked}
                onChange={(event) => updateField("cc", event.target.value)}
              />
            </label>
            <label className="mail-compose-field">
              <span>Bcc</span>
              <input
                value={editable.bcc}
                disabled={locked}
                onChange={(event) => updateField("bcc", event.target.value)}
              />
              {!editable.cc && !editable.bcc && !locked && (
                <button
                  type="button"
                  className="mail-compose-cc-toggle close"
                  onClick={() => setExpandedCcBcc(false)}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              )}
            </label>
          </>
        )}

        <label className="mail-compose-field subject">
          <span>Subject</span>
          <input
            value={editable.subject}
            disabled={locked}
            onChange={(event) => updateField("subject", event.target.value)}
          />
        </label>

        <label className="mail-compose-body">
          <span className="sr-only">Body</span>
          <textarea
            value={editable.bodyText}
            disabled={locked}
            onChange={(event) => updateField("bodyText", event.target.value)}
            rows={8}
            placeholder="Write your email..."
          />
        </label>
      </div>

      {draft.attachments.length > 0 && (
        <div className="mail-compose-attachments">
          {draft.attachments.map((attachment) => (
            <span className="mail-compose-attachment" key={attachment.id}>
              <Paperclip size={13} aria-hidden="true" />
              {attachment.filename}
            </span>
          ))}
        </div>
      )}

      <div className="mail-compose-footer">
        <div className="mail-compose-save-state">
          {error ? (
            <span className="mail-compose-error">{error}</span>
          ) : isSaving ? (
            <span>Saving...</span>
          ) : !hasRecipients ? (
            <span>Add at least one recipient before sending.</span>
          ) : !sendCapabilityAvailable ? (
            <span>Connect a send-capable mailbox account to send this draft.</span>
          ) : draft.latestError ? (
            <span className="mail-compose-error">{draft.latestError}</span>
          ) : (
            <span>{locked ? primaryStatus : "Saved locally"}</span>
          )}
        </div>
        <button
          type="button"
          className="mail-compose-discard-btn"
          onClick={handleDiscard}
          disabled={draft.status === "sent" || draft.status === "discarded"}
        >
          <Trash2 size={14} aria-hidden="true" />
          <span>
            {draft.status === "queued" || draft.status === "scheduled" ? "Undo send" : "Discard"}
          </span>
        </button>
      </div>
    </section>
  );
});

export const AutoMailComposeFrame = memo(function AutoMailComposeFrame({
  eventId,
  taskId,
  assistantMessage,
  sourceUserMessage,
  allowCreate,
}: AutoMailComposeFrameProps) {
  const [frame, setFrame] = useState<ChatInlineFrame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const storageKey = eventId && taskId ? `cowork:mail-compose-frame:${taskId}:${eventId}` : null;
  const draftInput = useMemo(
    () => extractAssistantMailDraft(assistantMessage, sourceUserMessage),
    [assistantMessage, sourceUserMessage],
  );

  useEffect(() => {
    if (!draftInput || !storageKey) return;
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored) {
        const parsed = JSON.parse(stored) as ChatInlineFrame;
        if (parsed?.kind === "mail_compose" && parsed.draftId) {
          setFrame(parsed);
        }
      }
    } catch {
      // Ignore corrupt local materialization state and allow a fresh draft if permitted.
    }
  }, [draftInput, storageKey]);

  useEffect(() => {
    if (!draftInput || !storageKey || frame || !allowCreate) return;
    let cancelled = false;
    (async () => {
      try {
        setError(null);
        const draft = await window.electronAPI.createMailboxDraft(draftInput);
        const state = await window.electronAPI.getMailboxClientState().catch(() => null);
        const account = state?.accounts.find((item) => item.id === draft.accountId);
        const nextFrame: ChatInlineFrame = {
          kind: "mail_compose",
          draftId: draft.id,
          accountId: draft.accountId,
          provider: account?.provider || "gmail",
          mode: draft.mode,
          origin: "assistant_generated",
          status: draft.status,
        };
        if (cancelled) return;
        window.localStorage.setItem(storageKey, JSON.stringify(nextFrame));
        setFrame(nextFrame);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Could not create a sendable mailbox draft.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [allowCreate, draftInput, frame, storageKey]);

  if (frame) return <MailComposeFrame frame={frame} />;
  if (!draftInput || !error) return null;
  return (
    <div className="mail-compose-frame unavailable">
      <Mail size={16} aria-hidden="true" />
      <span>{error}</span>
    </div>
  );
});
