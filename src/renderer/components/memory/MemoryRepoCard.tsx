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
  dreamLastLine,
  dreamNowMessage,
  dreamScheduleHint,
  dreamUpkeepHint,
} from "./memory-repo-dreams-model";
import {
  MemoryRepoSyncView,
  MemoryRepoTeamView,
  memoryRepoSyncLine,
  syncNowMessage,
  teamRepoStatusFor,
  teamRepoStatusLine,
  type SectionMessage,
} from "./MemoryRepoSyncTeam";
import {
  DisclosureButton,
  SettingsBadge,
  SettingsFeedback,
  SettingsRow,
  SettingsSwitch,
} from "./SettingsRow";

/** `memoryRepoDreamDailyTokenBudget` when unset (the settings manager's default). */
export const MEMORY_REPO_DREAM_DEFAULT_BUDGET = 50_000;

/** The preload methods the memory folder settings use (injected in tests). */
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

/** The host methods without which the memory folder settings are not shown. */
export const MEMORY_REPO_METHODS = ["getMemoryRepoStatus", "compactMemoryRepoHistory"] as const;

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The result line of "Folder of notes"; null when the picker was closed. */
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

/** The badge next to "Memory folder". */
export function memoryRepoBadge(status: MemoryRepoStatusReport | null): {
  tone: "success" | "warning" | "neutral";
  label: string;
} {
  if (!status) return { tone: "neutral", label: "..." };
  if (!status.enabled) return { tone: "neutral", label: "Off" };
  const line = memoryRepoStatusLine(status);
  return line.tone === "warning"
    ? { tone: "warning", label: "Check" }
    : { tone: "success", label: "Ready" };
}

/** The Team memory row's summary: none, or how many repos and their names. */
export function teamMemorySummary(repos: readonly MemoryRepoTeamRepoSetting[]): string {
  if (repos.length === 0) return "None. Read-only memory a team shares, read next to yours.";
  return `${plural(repos.length, "team repo", "team repos")}: ${repos.map((repo) => repo.name).join(", ")}.`;
}

function defaultApi(): MemoryRepoApi {
  return window.electronAPI;
}

type Feedback = { tone: "success" | "error"; text: string } | null;

export interface MemoryRepoControllerOptions {
  features: MemoryFeaturesSettings;
  /** Called with the stored settings after a save. */
  onFeaturesSaved: (settings: MemoryFeaturesSettings) => void;
  api?: () => MemoryRepoApi;
  confirm?: (message: string) => boolean;
  /** Re-read the status this long after a save, once main has restarted the folder. */
  settleMs?: number;
  /** False where the host has no memory folder: nothing is loaded. */
  available?: boolean;
}

/** The state and actions of the memory folder, shared by its row, Import and Advanced. */
export interface MemoryRepoController {
  features: MemoryFeaturesSettings;
  status: MemoryRepoStatusReport | null;
  enabled: boolean;
  /** The folder is on and ready. */
  ready: boolean;
  busy: "save" | "open" | "compact" | "import" | null;
  /** Results of the folder switch, Open and Dreaming switch. */
  message: Feedback;
  /** Results of the folder location and Compact history (Advanced). */
  locationMessage: Feedback;
  /** Result of "Folder of notes" (Import). */
  importMessage: Feedback;
  syncMessage: SectionMessage;
  teamMessage: SectionMessage;
  dreamMessage: Feedback;
  dreams: MemoryRepoDreamsReport | null;
  syncing: boolean;
  dreaming: boolean;
  canOpen: boolean;
  canImport: boolean;
  canSyncNow: boolean;
  canListDreams: boolean;
  canDreamNow: boolean;
  pathDraft: string;
  setPathDraft: (path: string) => void;
  setEnabled: (on: boolean) => void;
  setDreamingEnabled: (on: boolean) => void;
  savePath: () => void;
  saveRemoteUrl: (url: string) => void;
  setConfirmedPrivate: (confirmed: boolean) => void;
  saveTeamRepos: (repos: MemoryRepoTeamRepoSetting[], done: string) => Promise<boolean>;
  syncNow: () => void;
  openFolder: () => void;
  importFolder: () => void;
  compact: () => void;
  dreamNow: () => void;
}

/**
 * The memory folder (docs/memory-repo-phase1-design.md §9): switch the markdown + git
 * memory folder on or off, choose where it lives, open it, import notes, compact its
 * history, dream, sync and read team memory. The path is only ever sent as the
 * `memoryRepoPath` setting; main validates it on save.
 */
export function useMemoryRepoController({
  features,
  onFeaturesSaved,
  api = defaultApi,
  confirm = (message: string) => window.confirm(message),
  settleMs = 1500,
  available = true,
}: MemoryRepoControllerOptions): MemoryRepoController {
  const [status, setStatus] = useState<MemoryRepoStatusReport | null>(null);
  const [pathDraft, setPathDraft] = useState(features.memoryRepoPath ?? "");
  const [busy, setBusy] = useState<MemoryRepoController["busy"]>(null);
  const [message, setMessage] = useState<Feedback>(null);
  const [locationMessage, setLocationMessage] = useState<Feedback>(null);
  const [importMessage, setImportMessage] = useState<Feedback>(null);
  const [syncMessage, setSyncMessage] = useState<SectionMessage>(null);
  const [teamMessage, setTeamMessage] = useState<SectionMessage>(null);
  const [syncing, setSyncing] = useState(false);
  const [dreams, setDreams] = useState<MemoryRepoDreamsReport | null>(null);
  const [dreaming, setDreaming] = useState(false);
  const [dreamMessage, setDreamMessage] = useState<Feedback>(null);
  const generation = useRef(0);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canOpen = hasHostMethod("openMemoryRepoFolder");
  // Desktop only: the browser host has no native folder picker (and no such method).
  const canImport = hasHostMethod("importMemoryRepoFolder");
  const canSyncNow = hasHostMethod("syncMemoryRepoNow");
  const canListDreams = hasHostMethod("getMemoryRepoDreams");
  const canDreamNow = hasHostMethod("dreamMemoryRepoNow");
  const enabled = features.memoryRepoEnabled === true;

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
    if (!available) return;
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
  }, [api, available, loadDreams]);

  useEffect(() => {
    void loadStatus();
    return () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
    };
  }, [loadStatus]);

  const save = async (
    updates: Partial<MemoryFeaturesSettings>,
    done: string,
    section: "folder" | "location" | "sync" | "team" = "folder",
  ): Promise<boolean> => {
    // Each part shows its own result (main's validation error next to the field saved).
    const setFeedback =
      section === "sync"
        ? setSyncMessage
        : section === "team"
          ? setTeamMessage
          : section === "location"
            ? setLocationMessage
            : setMessage;
    setBusy("save");
    setMessage(null);
    setLocationMessage(null);
    setSyncMessage(null);
    setTeamMessage(null);
    try {
      // Merge into the stored settings, not this copy (other settings save the same object).
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
      setSyncMessage(syncNowMessage(await run()));
    } catch (error) {
      setSyncMessage({ tone: "error", text: memoryRepoErrorMessage(error, "Sync failed.") });
    } finally {
      setSyncing(false);
      await loadStatus();
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

  const importFolder = async () => {
    const run = api().importMemoryRepoFolder;
    if (!run) return;
    setBusy("import");
    setImportMessage(null);
    try {
      setImportMessage(importResultMessage(await run()));
      await loadStatus();
    } catch (error) {
      setImportMessage({
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
    setLocationMessage(null);
    try {
      const result = await api().compactMemoryRepoHistory();
      setLocationMessage(
        result.compacted
          ? { tone: "success", text: "History compacted. Only the current notes remain." }
          : { tone: "error", text: result.error || "Failed to compact the history." },
      );
      await loadStatus();
    } catch (error) {
      setLocationMessage({
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

  return {
    features,
    status,
    enabled,
    ready: enabled && status?.enabled === true && status.ready,
    busy,
    message,
    locationMessage,
    importMessage,
    syncMessage,
    teamMessage,
    dreamMessage,
    dreams,
    syncing,
    dreaming,
    canOpen,
    canImport,
    canSyncNow,
    canListDreams,
    canDreamNow,
    pathDraft,
    setPathDraft,
    setEnabled: (on) =>
      void save({ memoryRepoEnabled: on }, on ? "Memory folder on." : "Memory folder off."),
    setDreamingEnabled: (on) =>
      void save({ memoryRepoDreamingEnabled: on }, on ? "Dreaming on." : "Dreaming off."),
    savePath: () => void save({ memoryRepoPath: pathDraft.trim() }, "Folder saved.", "location"),
    saveRemoteUrl: (url) =>
      void save({ memoryRepoRemoteUrl: url }, url ? "Repository saved." : "Sync off.", "sync"),
    setConfirmedPrivate: (confirmed) =>
      void save(
        { memoryRepoRemoteConfirmedPrivate: confirmed },
        confirmed ? "Confirmed." : "Sync off.",
        "sync",
      ),
    saveTeamRepos: (repos, done) => save({ memoryRepoTeamRepos: repos }, done, "team"),
    syncNow: () => void syncNow(),
    openFolder: () => void openFolder(),
    importFolder: () => void importFolder(),
    compact: () => void compact(),
    dreamNow: () => void dreamNow(),
  };
}

export interface MemoryRepoDreamingViewProps {
  dreamingEnabled: boolean;
  dailyBudget: number;
  report: MemoryRepoDreamsReport | null;
  /** The folder is on and ready. */
  ready: boolean;
  canDreamNow: boolean;
  /** Background upkeep (heartbeat maintenance) runs the scheduled dreams. */
  backgroundUpkeepOn: boolean;
  /** Another action of the folder runs. */
  disabled: boolean;
  dreaming: boolean;
  message: Feedback;
  onToggle: (enabled: boolean) => void;
  onDreamNow: () => void;
}

/** The "Dreaming" row (docs/memory-repo-phase2-design.md §6-§7). */
export function MemoryRepoDreamingView(props: MemoryRepoDreamingViewProps) {
  return (
    <SettingsRow
      testId="memory-repo-dreaming"
      label={
        <>
          Dreaming{" "}
          {!props.backgroundUpkeepOn && props.dreamingEnabled && (
            <SettingsBadge tone="warning">Paused</SettingsBadge>
          )}
        </>
      }
      hint={
        <>
          {dreamScheduleHint(props.dailyBudget, props.report)}{" "}
          {dreamUpkeepHint(props.backgroundUpkeepOn)}
        </>
      }
      below={
        <>
          {props.ready && props.report && props.report.dreams.length > 0 && (
            <p className="settings-form-hint" role="status">
              {dreamLastLine(props.report)} Review it in the Review tab.
            </p>
          )}
          <SettingsFeedback message={props.message} />
        </>
      }
    >
      {props.ready && props.canDreamNow && (
        <button
          type="button"
          className="settings-button"
          disabled={props.disabled || props.dreaming || !props.dreamingEnabled}
          onClick={props.onDreamNow}
        >
          {props.dreaming ? "Dreaming..." : "Dream now"}
        </button>
      )}
      <SettingsSwitch
        label="Dreaming"
        checked={props.dreamingEnabled}
        onChange={props.onToggle}
        disabled={props.disabled || props.dreaming}
      />
    </SettingsRow>
  );
}

/**
 * The "Memory folder" section: the folder (path, state, Open, switch), Dreaming, Sync and
 * Team memory, each one row; Sync and Team memory open their settings under the row.
 */
export function MemoryRepoCard({
  repo,
  backgroundUpkeepOn,
  workspaceId = null,
}: {
  repo: MemoryRepoController;
  backgroundUpkeepOn: boolean;
  /** The workspace the Memory Hub shows (team repos can be limited to it). */
  workspaceId?: string | null;
}) {
  const [syncOpen, setSyncOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const { features, status } = repo;
  const disabled = repo.busy !== null;
  const badge = memoryRepoBadge(status);
  const line = memoryRepoStatusLine(status);
  const folder = status?.root || features.memoryRepoPath || "~/CoWork Memory";
  const inbox = repo.ready ? (status?.inboxEntries ?? 0) : 0;
  const remoteUrl = features.memoryRepoRemoteUrl ?? "";
  const confirmed = features.memoryRepoRemoteConfirmedPrivate === true;
  const syncLine = memoryRepoSyncLine({
    remoteUrl,
    confirmed,
    folderReady: repo.ready,
    sync: status?.sync,
  });
  const syncActive = repo.ready && Boolean(status?.sync);
  const teamRepos = features.memoryRepoTeamRepos ?? [];
  const teamWarning = teamRepos.some(
    (teamRepo) =>
      teamRepoStatusLine(teamRepoStatusFor(teamRepo, status?.team)).tone === "warning" &&
      Boolean(status?.team),
  );

  return (
    <div data-testid="memory-repo-card">
      <SettingsRow
        testId="memory-repo-folder"
        label={
          <>
            Memory folder <SettingsBadge tone={badge.tone}>{badge.label}</SettingsBadge>
          </>
        }
        hint={
          <>
            <code>{folder}</code> · plain notes you can open and edit, with every change in its
            history.
          </>
        }
        below={
          <>
            {(line.tone === "warning" || inbox > 0) && (
              <p className="settings-form-hint" role="status">
                {line.tone === "warning" ? `${line.text} ` : ""}
                {inbox > 0
                  ? `${plural(inbox, "entry", "entries")} in the inbox; keep them in What CoWork knows.`
                  : ""}
              </p>
            )}
            <SettingsFeedback message={repo.message} />
          </>
        }
      >
        {repo.canOpen && (
          <button
            type="button"
            className="settings-button"
            disabled={disabled || !repo.ready}
            onClick={repo.openFolder}
          >
            {repo.busy === "open" ? "Opening..." : "Open"}
          </button>
        )}
        <SettingsSwitch
          label="Memory folder"
          checked={repo.enabled}
          onChange={repo.setEnabled}
          disabled={disabled}
        />
      </SettingsRow>

      {repo.enabled && repo.canListDreams && (
        <MemoryRepoDreamingView
          dreamingEnabled={features.memoryRepoDreamingEnabled !== false}
          dailyBudget={features.memoryRepoDreamDailyTokenBudget ?? MEMORY_REPO_DREAM_DEFAULT_BUDGET}
          report={repo.dreams}
          ready={repo.ready && status?.gitAvailable === true}
          canDreamNow={repo.canDreamNow}
          backgroundUpkeepOn={backgroundUpkeepOn}
          disabled={disabled}
          dreaming={repo.dreaming}
          message={repo.dreamMessage}
          onToggle={repo.setDreamingEnabled}
          onDreamNow={repo.dreamNow}
        />
      )}

      {repo.enabled && (
        <SettingsRow
          testId="memory-repo-sync"
          label={
            <>
              Sync{" "}
              <SettingsBadge tone={syncLine.tone}>
                {syncActive ? (syncLine.tone === "warning" ? "Check" : "On") : "Off"}
              </SettingsBadge>
            </>
          }
          hint={syncLine.text}
          below={
            syncOpen ? (
              <div id="memory-repo-sync-panel" className="memory-settings-panel">
                <MemoryRepoSyncView
                  savedRemoteUrl={remoteUrl}
                  confirmed={confirmed}
                  folderReady={repo.ready}
                  sync={status?.sync}
                  canSyncNow={repo.canSyncNow}
                  disabled={disabled}
                  syncing={repo.syncing}
                  message={repo.syncMessage}
                  onSaveRemoteUrl={repo.saveRemoteUrl}
                  onConfirmChange={repo.setConfirmedPrivate}
                  onSyncNow={repo.syncNow}
                />
              </div>
            ) : (
              <SettingsFeedback message={repo.syncMessage} />
            )
          }
        >
          <DisclosureButton
            expanded={syncOpen}
            onToggle={() => setSyncOpen((open) => !open)}
            label={remoteUrl ? "Manage" : "Set up"}
            controls="memory-repo-sync-panel"
          />
        </SettingsRow>
      )}

      <SettingsRow
        testId="memory-repo-team"
        label={
          <>Team memory {teamWarning && <SettingsBadge tone="warning">Check</SettingsBadge>}</>
        }
        hint={teamMemorySummary(teamRepos)}
        below={
          teamOpen ? (
            <div id="memory-repo-team-panel" className="memory-settings-panel">
              <MemoryRepoTeamView
                repos={teamRepos}
                statuses={status?.team}
                workspaceId={workspaceId}
                disabled={disabled}
                message={repo.teamMessage}
                onSave={repo.saveTeamRepos}
              />
            </div>
          ) : (
            <SettingsFeedback message={repo.teamMessage} />
          )
        }
      >
        <DisclosureButton
          expanded={teamOpen}
          onToggle={() => setTeamOpen((open) => !open)}
          label={teamRepos.length === 0 ? "Add" : "Manage"}
          controls="memory-repo-team-panel"
        />
      </SettingsRow>
    </div>
  );
}

/** Advanced → Memory folder: where the folder lives, and compacting its history. */
export function MemoryRepoLocation({ repo }: { repo: MemoryRepoController }) {
  const disabled = repo.busy !== null;
  const savedPath = repo.features.memoryRepoPath ?? "";
  const pathChanged = repo.pathDraft.trim() !== savedPath.trim();
  return (
    <div data-testid="memory-repo-location">
      <SettingsRow
        label="Folder location"
        htmlFor="memory-repo-path"
        hint="Leave empty for the default. It must be outside your workspaces, and empty or an existing memory folder."
        below={
          <div className="memory-settings-inline-field">
            <input
              id="memory-repo-path"
              className="settings-input"
              value={repo.pathDraft}
              placeholder={repo.status?.root || "~/CoWork Memory"}
              onChange={(event) => repo.setPathDraft(event.target.value)}
              disabled={disabled}
            />
            <button
              type="button"
              className="settings-button"
              disabled={disabled || !pathChanged}
              onClick={repo.savePath}
            >
              {repo.busy === "save" ? "Saving..." : "Save"}
            </button>
          </div>
        }
      />
      <SettingsRow
        label="Compact history"
        hint="Removes old versions so deleted memories are really gone. This can't be undone."
        below={<SettingsFeedback message={repo.locationMessage} />}
      >
        <button
          type="button"
          className="settings-button settings-button-danger"
          disabled={disabled || !repo.ready || repo.status?.gitAvailable !== true}
          onClick={repo.compact}
        >
          {repo.busy === "compact" ? "Compacting..." : "Compact history"}
        </button>
      </SettingsRow>
    </div>
  );
}
