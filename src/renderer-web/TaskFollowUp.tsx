import { useEffect, useRef, useState } from "react";
import type { WebSessionBootstrap } from "../shared/host-api/contracts";
import { BrowserHostTransport } from "./transport";

type PendingFollowUp = { key: string; message: string };
type FollowUpDraft = { message: string; pending: PendingFollowUp | null };
type FollowUpReceipt = {
  found: boolean;
  state: "admitted" | "pending" | "unavailable";
};

export function TaskFollowUp({
  taskId,
  workspaceId,
  session,
  transport,
  connected,
}: {
  taskId: string;
  workspaceId: string;
  session: WebSessionBootstrap;
  transport: BrowserHostTransport | null;
  connected: boolean;
}) {
  const storageKey = `cowork:web:follow-up:${session.host.installationId}:${session.host.profileId}:${workspaceId}:${taskId}`;
  const [draftScope, setDraftScope] = useState(storageKey);
  const currentScope = useRef(storageKey);
  const [draft, setDraft] = useState<FollowUpDraft>(() => readFollowUpDraft(storageKey));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  currentScope.current = storageKey;
  if (draftScope !== storageKey) {
    setDraftScope(storageKey);
    setDraft(readFollowUpDraft(storageKey));
    setBusy(false);
    setNotice("");
    setError("");
  }

  useEffect(() => {
    writeFollowUpDraft(storageKey, draft);
  }, [storageKey, draft]);

  useEffect(() => {
    if (!connected || !transport || busy || !draft.pending) return;
    let active = true;
    void transport
      .request<unknown>("task.followUp.receipt", {
        taskId,
        workspaceId,
        operationKey: draft.pending.key,
      })
      .then((result) => {
        if (!active) return;
        const receipt = parseReceipt(result);
        if (receipt.found && receipt.state !== "unavailable") {
          setDraft({ message: "", pending: null });
          setNotice("The host confirmed this follow-up.");
          setError("");
        } else if (receipt.found) {
          setDraft({ message: draft.pending!.message, pending: null });
          setError("The host could not deliver this follow-up. Review it before sending again.");
        } else {
          setNotice("The host has not confirmed this follow-up. Retry with the same key.");
        }
      })
      .catch(() => {
        if (active) setError("Follow-up status is unavailable. Keep this request for retry.");
      });
    return () => {
      active = false;
    };
  }, [connected, transport, taskId, workspaceId, draft.pending, busy]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!connected || !transport || busy) return;
    const request = draft.pending ?? {
      key: crypto.randomUUID(),
      message: draft.message.trim(),
    };
    if (!request.message) return;
    const nextDraft = { message: request.message, pending: request };
    writeFollowUpDraft(storageKey, nextDraft);
    setDraft(nextDraft);
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const result = await transport.request<unknown>(
        "task.followUp",
        { taskId, workspaceId, message: request.message },
        { operationKey: request.key, mutation: true, timeoutMs: 120_000 },
      );
      if (currentScope.current !== storageKey) return;
      acceptReceipt(result, request);
    } catch (cause) {
      if (currentScope.current !== storageKey) return;
      try {
        const result = await transport.request<unknown>("task.followUp.receipt", {
          taskId,
          workspaceId,
          operationKey: request.key,
        });
        if (currentScope.current !== storageKey) return;
        if (acceptReceipt(result, request)) return;
      } catch {
        // Keep the exact operation key and message for a deliberate retry.
      }
      setError(cause instanceof Error ? cause.message : "The follow-up outcome is unknown.");
    } finally {
      if (currentScope.current === storageKey) setBusy(false);
    }
  };

  const acceptReceipt = (value: unknown, request: PendingFollowUp): boolean => {
    const receipt = parseReceipt(value);
    if (!receipt.found) return false;
    if (receipt.state === "unavailable") {
      setDraft({ message: request.message, pending: null });
      setError("The host could not deliver this follow-up. Review it before sending again.");
      return true;
    }
    setDraft({ message: "", pending: null });
    setNotice("Follow-up accepted by your CoWork host.");
    setError("");
    return true;
  };

  return (
    <section className="web-follow-up" aria-label="Continue task">
      <h3>Continue this task</h3>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="web-follow-up-message">Message</label>
        <textarea
          id="web-follow-up-message"
          value={draft.message}
          maxLength={64_000}
          disabled={busy || Boolean(draft.pending)}
          onChange={(event) => setDraft({ message: event.target.value, pending: null })}
          required
        />
        <button type="submit" disabled={!connected || busy || !draft.message.trim()}>
          {busy ? "Sending…" : draft.pending ? "Retry same follow-up" : "Send follow-up"}
        </button>
      </form>
      {notice && (
        <p className="web-muted" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="web-inline-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function parseReceipt(value: unknown): FollowUpReceipt {
  if (
    !isRecord(value) ||
    typeof value.found !== "boolean" ||
    (value.state !== "admitted" && value.state !== "pending" && value.state !== "unavailable")
  ) {
    throw new Error("The host returned an invalid follow-up receipt.");
  }
  return { found: value.found, state: value.state };
}

function readFollowUpDraft(storageKey: string): FollowUpDraft {
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (!raw) return { message: "", pending: null };
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return { message: "", pending: null };
    const message = typeof value.message === "string" ? value.message.slice(0, 64_000) : "";
    const pending = value.pending;
    if (
      isRecord(pending) &&
      typeof pending.key === "string" &&
      /^[A-Za-z0-9._:-]{8,128}$/.test(pending.key) &&
      typeof pending.message === "string" &&
      pending.message.length <= 64_000
    ) {
      return { message: pending.message, pending: { key: pending.key, message: pending.message } };
    }
    return { message, pending: null };
  } catch {
    return { message: "", pending: null };
  }
}

function writeFollowUpDraft(storageKey: string, draft: FollowUpDraft): void {
  try {
    if (!draft.message && !draft.pending) window.sessionStorage.removeItem(storageKey);
    else window.sessionStorage.setItem(storageKey, JSON.stringify(draft));
  } catch {
    // The in-memory draft remains usable if browser storage is disabled.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
