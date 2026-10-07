import { useState } from "react";
import type {
  SupermemoryConfigStatus,
  SupermemoryDisconnectPurgeResult,
} from "../../../shared/types";

export interface SupermemoryDisconnectPurgeProps {
  status: SupermemoryConfigStatus | null;
  /** Called after a purge so the card reloads the status (enabled flag, copy count). */
  onDone?: (result: SupermemoryDisconnectPurgeResult) => void;
  /** Injected in tests; defaults to the preload API. */
  purge?: () => Promise<SupermemoryDisconnectPurgeResult>;
  confirm?: (message: string) => boolean;
}

function copies(count: number): string {
  return `${count} ${count === 1 ? "copy" : "copies"}`;
}

/** The confirmation text, naming how many recorded copies will be deleted. */
export function purgeConfirmMessage(recorded: number | null): string {
  const scope =
    recorded === null
      ? "every memory copy CoWork recorded"
      : recorded === 0
        ? "no recorded copies (nothing to delete)"
        : `${copies(recorded)} CoWork recorded`;
  return (
    `Disconnect Supermemory and delete ${scope} from it?\n\n` +
    "Copies sent before CoWork kept remote ids, and memories added to Supermemory outside CoWork, are not affected. This cannot be undone."
  );
}

export interface PurgeOutcome {
  tone: "success" | "error";
  text: string;
  result: SupermemoryDisconnectPurgeResult | null;
}

/** Confirm, run the purge and describe the outcome; null when the user cancels. */
export async function runSupermemoryPurge(deps: {
  recorded: number | null;
  confirm: (message: string) => boolean;
  purge: () => Promise<SupermemoryDisconnectPurgeResult>;
}): Promise<PurgeOutcome | null> {
  if (!deps.confirm(purgeConfirmMessage(deps.recorded))) return null;
  try {
    const result = await deps.purge();
    return result.success
      ? {
          tone: "success",
          text: `Supermemory disconnected. Deleted ${copies(result.forgotten)}.`,
          result,
        }
      : { tone: "error", text: result.error || "Disconnect and purge failed.", result };
  } catch (error) {
    return {
      tone: "error",
      text: error instanceof Error ? error.message : "Disconnect and purge failed.",
      result: null,
    };
  }
}

/**
 * "Disconnect & purge" for the Supermemory card (audit SEC-17): deletes the remote copies
 * CoWork recorded, then disables the integration. Shown while Supermemory is enabled.
 */
export function SupermemoryDisconnectPurge({
  status,
  onDone,
  purge,
  confirm,
}: SupermemoryDisconnectPurgeProps) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  if (!status?.enabled) return null;

  const recorded = typeof status.mirroredCopies === "number" ? status.mirroredCopies : null;

  const run = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const outcome = await runSupermemoryPurge({
        recorded,
        confirm: confirm ?? ((text: string) => window.confirm(text)),
        purge: purge ?? (() => window.electronAPI.disconnectAndPurgeSupermemory()),
      });
      if (!outcome) return;
      setMessage({ tone: outcome.tone, text: outcome.text });
      if (outcome.result) onDone?.(outcome.result);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="memory-hub-top-gap">
      <button
        type="button"
        className="settings-button settings-button-danger"
        onClick={() => void run()}
        disabled={busy}
      >
        {busy ? "Purging..." : "Disconnect & purge"}
      </button>
      {recorded !== null && (
        <span className="settings-form-hint supermemory-purge-hint">
          {recorded === 0
            ? "No remote copies on record."
            : `${copies(recorded)} on record in Supermemory.`}
        </span>
      )}
      {message && (
        <div
          role={message.tone === "error" ? "alert" : "status"}
          className={`settings-feedback ${message.tone} memory-hub-top-gap`}
        >
          {message.text}
        </div>
      )}
    </div>
  );
}
