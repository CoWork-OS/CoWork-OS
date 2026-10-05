import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MemoryRepoCompactResult,
  MemoryRepoStatusReport,
} from "../../../shared/memory-repo-types";
import type { MemoryFeaturesSettings } from "../../../shared/types";
import { hasHostMethod } from "../../host/browser-capabilities";
import { formatRelative } from "./memory-knowledge-model";

/** The preload methods the card uses (injected in tests). */
export type MemoryRepoApi = {
  getMemoryFeaturesSettings: () => Promise<MemoryFeaturesSettings>;
  saveMemoryFeaturesSettings: (settings: MemoryFeaturesSettings) => Promise<{ success: boolean }>;
  getMemoryRepoStatus: () => Promise<MemoryRepoStatusReport>;
  openMemoryRepoFolder?: () => Promise<{ success: true }>;
  compactMemoryRepoHistory: () => Promise<MemoryRepoCompactResult>;
};

export const COMPACT_HISTORY_CONFIRM =
  "Compact the memory folder's history?\n\nRemoves old versions so deleted memories are really gone. This can't be undone.";

/** The message of an error from main, without Electron's "Error invoking remote method" prefix. */
export function memoryRepoErrorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const cleaned = raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, "").trim();
  return cleaned || fallback;
}

/** One line describing the folder's state. */
export function memoryRepoStatusLine(status: MemoryRepoStatusReport | null): {
  tone: "success" | "warning" | "neutral";
  text: string;
} {
  if (!status) return { tone: "neutral", text: "Checking the memory folder..." };
  if (!status.enabled)
    return { tone: "neutral", text: "Off. Memory is kept in CoWork's database." };
  if (!status.ready) {
    return {
      tone: "warning",
      text: status.problem ? `Not ready: ${status.problem}.` : "Not ready yet.",
    };
  }
  const parts: string[] = ["Ready"];
  if (!status.gitAvailable) parts.push("git not found, so memory has no history");
  else if (status.lastCommitAt) parts.push(`last change ${formatRelative(status.lastCommitAt)}`);
  if (status.clean === false) parts.push("has edits not yet committed");
  if (status.lastWriteError) parts.push(`last write failed: ${status.lastWriteError}`);
  const warn = !status.gitAvailable || Boolean(status.lastWriteError);
  return { tone: warn ? "warning" : "success", text: `${parts.join("; ")}.` };
}

function defaultApi(): MemoryRepoApi {
  return window.electronAPI;
}

export interface MemoryRepoCardProps {
  features: MemoryFeaturesSettings;
  /** Called with the stored settings after a save. */
  onFeaturesSaved: (settings: MemoryFeaturesSettings) => void;
  api?: () => MemoryRepoApi;
  confirm?: (message: string) => boolean;
  /** Re-read the status this long after a save, once main has restarted the folder. */
  settleMs?: number;
}

/**
 * "Memory folder (beta)" (docs/memory-repo-phase1-design.md §9): switch the markdown + git
 * memory folder on or off, choose where it lives, open it, and compact its history. The
 * path is only ever sent as the `memoryRepoPath` setting; main validates it on save.
 */
export function MemoryRepoCard({
  features,
  onFeaturesSaved,
  api = defaultApi,
  confirm = (message: string) => window.confirm(message),
  settleMs = 1500,
}: MemoryRepoCardProps) {
  const [status, setStatus] = useState<MemoryRepoStatusReport | null>(null);
  const [pathDraft, setPathDraft] = useState(features.memoryRepoPath ?? "");
  const [busy, setBusy] = useState<"save" | "open" | "compact" | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const generation = useRef(0);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canOpen = hasHostMethod("openMemoryRepoFolder");
  const enabled = features.memoryRepoEnabled === true;
  const savedPath = features.memoryRepoPath ?? "";

  useEffect(() => setPathDraft(features.memoryRepoPath ?? ""), [features.memoryRepoPath]);

  const loadStatus = useCallback(async () => {
    const current = ++generation.current;
    try {
      const next = await api().getMemoryRepoStatus();
      if (current === generation.current) setStatus(next);
    } catch (error) {
      if (current !== generation.current) return;
      setMessage({
        tone: "error",
        text: memoryRepoErrorMessage(error, "Failed to read the memory folder status."),
      });
    }
  }, [api]);

  useEffect(() => {
    void loadStatus();
    return () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
    };
  }, [loadStatus]);

  const save = async (updates: Partial<MemoryFeaturesSettings>, done: string) => {
    setBusy("save");
    setMessage(null);
    try {
      // Merge into the stored settings, not this card's copy (other cards save the same object).
      const stored = await api()
        .getMemoryFeaturesSettings()
        .catch(() => null);
      await api().saveMemoryFeaturesSettings({ ...(stored ?? features), ...updates });
      onFeaturesSaved(await api().getMemoryFeaturesSettings());
      setMessage({ tone: "success", text: done });
      await loadStatus();
      if (settleTimer.current) clearTimeout(settleTimer.current);
      settleTimer.current = setTimeout(() => void loadStatus(), settleMs);
    } catch (error) {
      setMessage({
        tone: "error",
        text: memoryRepoErrorMessage(error, "Failed to save the memory folder settings."),
      });
    } finally {
      setBusy(null);
    }
  };

  const openFolder = async () => {
    const open = api().openMemoryRepoFolder;
    if (!open) return;
    setBusy("open");
    setMessage(null);
    try {
      await open();
    } catch (error) {
      setMessage({
        tone: "error",
        text: memoryRepoErrorMessage(error, "Failed to open the memory folder."),
      });
    } finally {
      setBusy(null);
    }
  };

  const compact = async () => {
    if (!confirm(COMPACT_HISTORY_CONFIRM)) return;
    setBusy("compact");
    setMessage(null);
    try {
      const result = await api().compactMemoryRepoHistory();
      setMessage(
        result.compacted
          ? { tone: "success", text: "History compacted. Only the current notes remain." }
          : { tone: "error", text: result.error || "Failed to compact the history." },
      );
      await loadStatus();
    } catch (error) {
      setMessage({
        tone: "error",
        text: memoryRepoErrorMessage(error, "Failed to compact the history."),
      });
    } finally {
      setBusy(null);
    }
  };

  const line = memoryRepoStatusLine(status);
  const ready = enabled && status?.enabled === true && status.ready;
  const pathChanged = pathDraft.trim() !== savedPath.trim();

  return (
    <div className="settings-card" data-testid="memory-repo-card">
      <div className="settings-form-group">
        <div className="memory-hub-toggle-row">
          <div className="memory-hub-grow">
            <div className="memory-hub-primary-label">Memory folder (beta)</div>
            <p className="settings-form-hint memory-hub-hint-tight">
              Memory is kept as plain notes in a folder you can open and edit. The agent reads it,
              and saves to it through CoWork, which keeps every change in its history.
            </p>
          </div>
          <label className="settings-toggle memory-hub-toggle">
            <input
              type="checkbox"
              aria-label="Memory folder"
              checked={enabled}
              onChange={(e) =>
                void save(
                  { memoryRepoEnabled: e.target.checked },
                  e.target.checked ? "Memory folder on." : "Memory folder off.",
                )
              }
              disabled={busy !== null}
            />
            <span className="toggle-slider" />
          </label>
        </div>
      </div>

      <div className="settings-field">
        <label htmlFor="memory-repo-path">Folder</label>
        <div className="memory-hub-stack-gap">
          <input
            id="memory-repo-path"
            className="settings-input"
            value={pathDraft}
            placeholder={status?.root || "~/CoWork Memory"}
            onChange={(e) => setPathDraft(e.target.value)}
            disabled={busy !== null}
          />
          <button
            type="button"
            className="settings-button"
            disabled={busy !== null || !pathChanged}
            onClick={() => void save({ memoryRepoPath: pathDraft.trim() }, "Folder saved.")}
          >
            {busy === "save" ? "Saving..." : "Save"}
          </button>
        </div>
        <p className="settings-hint">
          Leave empty for the default. The folder must be outside your workspaces, and either empty
          or an existing memory folder.
        </p>
      </div>

      <p className="settings-form-hint" role="status">
        <span className={`settings-badge settings-badge--${line.tone}`}>
          {!status ? "..." : !status.enabled ? "OFF" : line.tone === "warning" ? "WARN" : "READY"}
        </span>{" "}
        {line.text}
        {status?.enabled && status.ready && (status.inboxEntries ?? 0) > 0
          ? ` ${status.inboxEntries} ${status.inboxEntries === 1 ? "entry" : "entries"} in the inbox.`
          : ""}
      </p>

      <div className="memory-hub-row-wrap-center">
        {canOpen && (
          <button
            type="button"
            className="settings-button"
            disabled={busy !== null || !ready}
            onClick={() => void openFolder()}
          >
            {busy === "open" ? "Opening..." : "Open memory folder"}
          </button>
        )}
        <button
          type="button"
          className="settings-button settings-button-danger"
          disabled={busy !== null || !ready || status?.gitAvailable !== true}
          onClick={() => void compact()}
        >
          {busy === "compact" ? "Compacting..." : "Compact history"}
        </button>
      </div>

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
