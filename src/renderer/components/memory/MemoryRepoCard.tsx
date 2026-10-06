import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MemoryRepoCompactResult,
  MemoryRepoDreamNowResult,
  MemoryRepoDreamsReport,
  MemoryRepoImportResult,
  MemoryRepoStatusReport,
  MemoryRepoSyncNowResult,
} from "../../../shared/memory-repo-types";
import type { MemoryFeaturesSettings, MemoryRepoTeamRepoSetting } from "../../../shared/types";
import { hasHostMethod } from "../../host/browser-capabilities";
import { formatRelative } from "./memory-knowledge-model";
import {
  dreamCostNotice,
  dreamLastLine,
  dreamNowMessage,
  dreamTokensLine,
} from "./memory-repo-dreams-model";
import {
  MemoryRepoSyncView,
  MemoryRepoTeamView,
  syncNowMessage,
  type SectionMessage,
} from "./MemoryRepoSyncTeam";

/** `memoryRepoDreamDailyTokenBudget` when unset (the settings manager's default). */
export const MEMORY_REPO_DREAM_DEFAULT_BUDGET = 50_000;

/** The preload methods the card uses (injected in tests). */
export type MemoryRepoApi = {
  getMemoryFeaturesSettings: () => Promise<MemoryFeaturesSettings>;
  saveMemoryFeaturesSettings: (settings: MemoryFeaturesSettings) => Promise<{ success: boolean }>;
  getMemoryRepoStatus: () => Promise<MemoryRepoStatusReport>;
  openMemoryRepoFolder?: () => Promise<{ success: true }>;
  compactMemoryRepoHistory: () => Promise<MemoryRepoCompactResult>;
  getMemoryRepoDreams?: () => Promise<MemoryRepoDreamsReport>;
  dreamMemoryRepoNow?: () => Promise<MemoryRepoDreamNowResult>;
  syncMemoryRepoNow?: () => Promise<MemoryRepoSyncNowResult>;
  /** Desktop only: main opens a folder picker and imports its notes into the inbox. */
  importMemoryRepoFolder?: () => Promise<MemoryRepoImportResult>;
};

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The result line of "Import notes from a folder"; null when the picker was closed. */
export function importResultMessage(
  result: MemoryRepoImportResult,
): { tone: "success" | "error"; text: string } | null {
  if (result.cancelled) return null;
  if (result.error) return { tone: "error", text: result.error };
  const from = result.folderName ? ` from "${result.folderName}"` : "";
  if (result.imported === 0) {
    const why =
      result.files === 0
        ? "no markdown notes were found"
        : result.duplicates > 0
          ? "your memory already has them"
          : "none of them could be kept";
    return { tone: "success", text: `Nothing imported${from}: ${why}.` };
  }
  const extra = [
    result.duplicates > 0 ? `${plural(result.duplicates, "duplicate", "duplicates")} left out` : "",
    result.skipped > 0 ? `${result.skipped} skipped` : "",
    result.truncated ? "a size limit was reached, so some notes were not read" : "",
  ].filter(Boolean);
  return {
    tone: "success",
    text: `Imported ${plural(result.imported, "note", "notes")}${from} into the inbox${
      extra.length ? ` (${extra.join("; ")})` : ""
    }. Keep the ones you want in What CoWork knows.`,
  };
}

export interface MemoryRepoDreamingViewProps {
  dreamingEnabled: boolean;
  dailyBudget: number;
  report: MemoryRepoDreamsReport | null;
  /** The folder is on and ready. */
  ready: boolean;
  canDreamNow: boolean;
  /** Another action of the card runs. */
  disabled: boolean;
  dreaming: boolean;
  message: { tone: "success" | "error"; text: string } | null;
  onToggle: (enabled: boolean) => void;
  onDreamNow: () => void;
}

/** The card's "Dreaming" subsection (docs/memory-repo-phase2-design.md §6-§7). */
export function MemoryRepoDreamingView(props: MemoryRepoDreamingViewProps) {
  return (
    <div className="settings-form-group memory-hub-top-gap" data-testid="memory-repo-dreaming">
      <div className="memory-hub-toggle-row">
        <div className="memory-hub-grow">
          <div className="memory-hub-primary-label">Dreaming</div>
          <p className="settings-form-hint memory-hub-hint-tight">
            A daily pass keeps the folder accurate and small and saves what tasks taught. Safe
            changes are committed (undo them in the Review tab); the rest waits there for you.
          </p>
          <p className="settings-form-hint memory-hub-hint-tight">
            {dreamCostNotice(props.dailyBudget)}
          </p>
        </div>
        <label className="settings-toggle memory-hub-toggle">
          <input
            type="checkbox"
            aria-label="Dreaming"
            checked={props.dreamingEnabled}
            onChange={(e) => props.onToggle(e.target.checked)}
            disabled={props.disabled || props.dreaming}
          />
          <span className="toggle-slider" />
        </label>
      </div>
      {props.ready && (
        <>
          <p className="settings-form-hint" role="status">
            {dreamLastLine(props.report)}
            {props.report ? ` ${dreamTokensLine(props.report)}` : ""}
          </p>
          {props.canDreamNow && (
            <div className="memory-hub-row-wrap-center">
              <button
                type="button"
                className="settings-button"
                disabled={props.disabled || props.dreaming || !props.dreamingEnabled}
                onClick={props.onDreamNow}
              >
                {props.dreaming ? "Dreaming..." : "Dream now"}
              </button>
            </div>
          )}
        </>
      )}
      {props.message && (
        <div
          role={props.message.tone === "error" ? "alert" : "status"}
          className={`settings-feedback ${props.message.tone} memory-hub-top-gap`}
        >
          {props.message.text}
        </div>
      )}
    </div>
  );
}

export const COMPACT_HISTORY_CONFIRM =
  "Compact the memory folder's history?\n\nRemoves old versions so deleted memories are really gone. This can't be undone.";

/** The compact confirmation; with sync on the remote's history is replaced too. */
export function compactHistoryConfirm(syncConfigured: boolean): string {
  return syncConfigured
    ? `${COMPACT_HISTORY_CONFIRM} It also replaces the history of your synced repository.`
    : COMPACT_HISTORY_CONFIRM;
}

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
  /** The workspace the Memory Hub shows (team repos can be limited to it). */
  workspaceId?: string | null;
}

/**
 * "Memory folder" (docs/memory-repo-phase1-design.md §9): switch the markdown + git
 * memory folder on or off, choose where it lives, open it, and compact its history. The
 * path is only ever sent as the `memoryRepoPath` setting; main validates it on save.
 */
export function MemoryRepoCard({
  features,
  onFeaturesSaved,
  api = defaultApi,
  confirm = (message: string) => window.confirm(message),
  settleMs = 1500,
  workspaceId = null,
}: MemoryRepoCardProps) {
  const [status, setStatus] = useState<MemoryRepoStatusReport | null>(null);
  const [pathDraft, setPathDraft] = useState(features.memoryRepoPath ?? "");
  const [busy, setBusy] = useState<"save" | "open" | "compact" | "import" | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [syncMessage, setSyncMessage] = useState<SectionMessage>(null);
  const [teamMessage, setTeamMessage] = useState<SectionMessage>(null);
  const [syncing, setSyncing] = useState(false);
  const canSyncNow = hasHostMethod("syncMemoryRepoNow");
  const generation = useRef(0);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canOpen = hasHostMethod("openMemoryRepoFolder");
  // Desktop only: the browser host has no native folder picker (and no such method).
  const canImport = hasHostMethod("importMemoryRepoFolder");
  const enabled = features.memoryRepoEnabled === true;
  const savedPath = features.memoryRepoPath ?? "";
  const canListDreams = hasHostMethod("getMemoryRepoDreams");
  const canDreamNow = hasHostMethod("dreamMemoryRepoNow");
  const [dreams, setDreams] = useState<MemoryRepoDreamsReport | null>(null);
  const [dreaming, setDreaming] = useState(false);
  const [dreamMessage, setDreamMessage] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);

  useEffect(() => setPathDraft(features.memoryRepoPath ?? ""), [features.memoryRepoPath]);

  const loadDreams = useCallback(async () => {
    const list = api().getMemoryRepoDreams;
    if (!canListDreams || !list) return;
    try {
      setDreams(await list());
    } catch {
      // The dream line stays as it was; the status line reports folder problems.
    }
  }, [api, canListDreams]);

  const loadStatus = useCallback(async () => {
    const current = ++generation.current;
    try {
      const next = await api().getMemoryRepoStatus();
      if (current === generation.current) setStatus(next);
      if (current === generation.current && next.enabled && next.ready) void loadDreams();
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

  const save = async (
    updates: Partial<MemoryFeaturesSettings>,
    done: string,
    section: "folder" | "sync" | "team" = "folder",
  ): Promise<boolean> => {
    // Each section shows its own result (main's validation error next to the field saved).
    const setFeedback =
      section === "sync" ? setSyncMessage : section === "team" ? setTeamMessage : setMessage;
    setBusy("save");
    setMessage(null);
    setSyncMessage(null);
    setTeamMessage(null);
    try {
      // Merge into the stored settings, not this card's copy (other cards save the same object).
      const stored = await api()
        .getMemoryFeaturesSettings()
        .catch(() => null);
      await api().saveMemoryFeaturesSettings({ ...(stored ?? features), ...updates });
      onFeaturesSaved(await api().getMemoryFeaturesSettings());
      setFeedback({ tone: "success", text: done });
      await loadStatus();
      if (settleTimer.current) clearTimeout(settleTimer.current);
      settleTimer.current = setTimeout(() => void loadStatus(), settleMs);
      return true;
    } catch (error) {
      setFeedback({
        tone: "error",
        text: memoryRepoErrorMessage(error, "Failed to save the memory folder settings."),
      });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const syncNow = async () => {
    const run = api().syncMemoryRepoNow;
    if (!run) return;
    setSyncing(true);
    setSyncMessage(null);
    try {
      const result = await run();
      setSyncMessage(syncNowMessage(result));
    } catch (error) {
      setSyncMessage({ tone: "error", text: memoryRepoErrorMessage(error, "Sync failed.") });
    } finally {
      setSyncing(false);
      await loadStatus();
    }
  };

  const saveTeamRepos = (repos: MemoryRepoTeamRepoSetting[], done: string) =>
    save({ memoryRepoTeamRepos: repos }, done, "team");

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

  const importFolder = async () => {
    const run = api().importMemoryRepoFolder;
    if (!run) return;
    setBusy("import");
    setMessage(null);
    try {
      setMessage(importResultMessage(await run()));
      await loadStatus();
    } catch (error) {
      setMessage({
        tone: "error",
        text: memoryRepoErrorMessage(error, "Failed to import the notes."),
      });
    } finally {
      setBusy(null);
    }
  };

  const compact = async () => {
    if (!confirm(compactHistoryConfirm(Boolean(status?.sync)))) return;
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

  const dreamNow = async () => {
    const run = api().dreamMemoryRepoNow;
    if (!run) return;
    setDreaming(true);
    setDreamMessage(null);
    try {
      setDreamMessage(dreamNowMessage(await run()));
    } catch (error) {
      setDreamMessage({ tone: "error", text: memoryRepoErrorMessage(error, "The dream failed.") });
    } finally {
      setDreaming(false);
      await loadDreams();
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
            <div className="memory-hub-primary-label">Memory folder</div>
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
        {canImport && (
          <button
            type="button"
            className="settings-button"
            disabled={busy !== null || !ready || status?.writable === false}
            onClick={() => void importFolder()}
            title="Bring notes from another agent's memory folder or any folder of markdown notes into the inbox"
          >
            {busy === "import" ? "Importing..." : "Import notes from a folder…"}
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

      {enabled && canListDreams && (
        <MemoryRepoDreamingView
          dreamingEnabled={features.memoryRepoDreamingEnabled !== false}
          dailyBudget={features.memoryRepoDreamDailyTokenBudget ?? MEMORY_REPO_DREAM_DEFAULT_BUDGET}
          report={dreams}
          ready={Boolean(ready) && status?.gitAvailable === true}
          canDreamNow={canDreamNow}
          disabled={busy !== null}
          dreaming={dreaming}
          message={dreamMessage}
          onToggle={(on) =>
            void save({ memoryRepoDreamingEnabled: on }, on ? "Dreaming on." : "Dreaming off.")
          }
          onDreamNow={() => void dreamNow()}
        />
      )}

      {enabled && (
        <MemoryRepoSyncView
          savedRemoteUrl={features.memoryRepoRemoteUrl ?? ""}
          confirmed={features.memoryRepoRemoteConfirmedPrivate === true}
          folderReady={Boolean(ready)}
          sync={status?.sync}
          canSyncNow={canSyncNow}
          disabled={busy !== null}
          syncing={syncing}
          message={syncMessage}
          onSaveRemoteUrl={(url) =>
            void save(
              { memoryRepoRemoteUrl: url },
              url ? "Repository saved." : "Sync off.",
              "sync",
            )
          }
          onConfirmChange={(confirmed) =>
            void save(
              { memoryRepoRemoteConfirmedPrivate: confirmed },
              confirmed ? "Confirmed." : "Sync off.",
              "sync",
            )
          }
          onSyncNow={() => void syncNow()}
        />
      )}

      <MemoryRepoTeamView
        repos={features.memoryRepoTeamRepos ?? []}
        statuses={status?.team}
        workspaceId={workspaceId}
        disabled={busy !== null}
        message={teamMessage}
        onSave={saveTeamRepos}
      />
    </div>
  );
}
