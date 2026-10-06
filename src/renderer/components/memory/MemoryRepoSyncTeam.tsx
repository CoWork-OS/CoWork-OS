import { useState } from "react";
import {
  MEMORY_REPO_TEAM_REPOS_MAX,
  type MemoryRepoSyncNowResult,
  type MemoryRepoSyncStatus,
  type TeamMemoryRepoStatus,
} from "../../../shared/memory-repo-types";
import type { MemoryRepoTeamRepoSetting } from "../../../shared/types";
import { formatRelative } from "./memory-knowledge-model";

/**
 * The memory folder card's "Sync" and "Team memory" sections
 * (docs/memory-repo-phase4-design.md §1-§3). Settings are only ever sent as
 * `memoryRepoRemoteUrl`, `memoryRepoRemoteConfirmedPrivate` and `memoryRepoTeamRepos`;
 * main validates them on save.
 */

export type SectionMessage = { tone: "success" | "error"; text: string } | null;

/** One line describing sync with the private remote. */
export function memoryRepoSyncLine(input: {
  remoteUrl: string;
  confirmed: boolean;
  folderReady: boolean;
  sync: MemoryRepoSyncStatus | null | undefined;
}): { tone: "success" | "warning" | "neutral"; text: string } {
  if (!input.remoteUrl.trim()) {
    return { tone: "neutral", text: "Off. Add the URL of a private repository you own." };
  }
  if (!input.confirmed) {
    return {
      tone: "neutral",
      text: "Off until you confirm the repository is private and yours.",
    };
  }
  const sync = input.sync;
  if (!input.folderReady || !sync) {
    return { tone: "neutral", text: "Sync starts when the memory folder is on and ready." };
  }
  if (sync.conflict) {
    return {
      tone: "warning",
      text: `Paused: ${sync.conflict}. Open the folder and resolve it, then press Sync now.`,
    };
  }
  const parts = [
    `With ${sync.remoteUrl ?? "your repository"}`,
    `last pull ${formatRelative(sync.lastPullAt)}`,
    `last push ${formatRelative(sync.lastPushAt)}`,
  ];
  if (sync.ahead > 0) parts.push(`${sync.ahead} to push`);
  if (sync.behind > 0) parts.push(`${sync.behind} to pull`);
  if (sync.lastError) parts.push(`last error: ${sync.lastError}`);
  return { tone: sync.lastError ? "warning" : "success", text: `${parts.join("; ")}.` };
}

/** The feedback after "Sync now". */
export function syncNowMessage(result: MemoryRepoSyncNowResult): NonNullable<SectionMessage> {
  if ("error" in result) return { tone: "error", text: result.error };
  if (result.conflict) return { tone: "error", text: `Sync paused: ${result.conflict}.` };
  if (result.lastError) return { tone: "error", text: `Sync failed: ${result.lastError}` };
  return { tone: "success", text: "Synced." };
}

function Feedback({ message }: { message: SectionMessage }) {
  if (!message) return null;
  return (
    <div
      role={message.tone === "error" ? "alert" : "status"}
      className={`settings-feedback ${message.tone} memory-hub-top-gap`}
    >
      {message.text}
    </div>
  );
}

function Badge({ tone, label }: { tone: "success" | "warning" | "neutral"; label: string }) {
  return <span className={`settings-badge settings-badge--${tone}`}>{label}</span>;
}

export interface MemoryRepoSyncViewProps {
  savedRemoteUrl: string;
  confirmed: boolean;
  /** The memory folder is on and ready. */
  folderReady: boolean;
  sync: MemoryRepoSyncStatus | null | undefined;
  canSyncNow: boolean;
  disabled: boolean;
  syncing: boolean;
  message: SectionMessage;
  onSaveRemoteUrl: (url: string) => void;
  onConfirmChange: (confirmed: boolean) => void;
  onSyncNow: () => void;
}

/** "Sync": the memory folder on several machines through a private remote the user owns. */
export function MemoryRepoSyncView(props: MemoryRepoSyncViewProps) {
  const [draft, setDraft] = useState(props.savedRemoteUrl);
  const [lastSaved, setLastSaved] = useState(props.savedRemoteUrl);
  if (lastSaved !== props.savedRemoteUrl) {
    // The stored setting changed (saved here or elsewhere): show it.
    setLastSaved(props.savedRemoteUrl);
    setDraft(props.savedRemoteUrl);
  }
  const line = memoryRepoSyncLine({
    remoteUrl: props.savedRemoteUrl,
    confirmed: props.confirmed,
    folderReady: props.folderReady,
    sync: props.sync,
  });
  const active = props.folderReady && Boolean(props.sync);
  return (
    <div className="settings-form-group memory-hub-top-gap" data-testid="memory-repo-sync">
      <div className="memory-hub-primary-label">Sync</div>
      <p className="settings-form-hint memory-hub-hint-tight">
        Syncs the memory folder with a private git repository you own, so the same memory is on each
        of your machines. CoWork uses your own git credentials (credential helper or SSH agent) and
        stores none. Dream review branches are never pushed.
      </p>
      <div className="settings-field">
        <label htmlFor="memory-repo-remote-url">Repository URL</label>
        <div className="memory-hub-stack-gap">
          <input
            id="memory-repo-remote-url"
            className="settings-input"
            value={draft}
            placeholder="git@github.com:you/memory.git"
            onChange={(e) => setDraft(e.target.value)}
            disabled={props.disabled}
          />
          <button
            type="button"
            className="settings-button"
            disabled={props.disabled || draft.trim() === props.savedRemoteUrl.trim()}
            onClick={() => props.onSaveRemoteUrl(draft.trim())}
          >
            Save
          </button>
        </div>
        <p className="settings-hint">
          An https, ssh or user@host:path URL without a password or token in it. Leave empty to turn
          sync off.
        </p>
      </div>
      <label className="memory-knowledge-checkbox">
        <input
          type="checkbox"
          checked={props.confirmed}
          onChange={(e) => props.onConfirmChange(e.target.checked)}
          disabled={props.disabled}
        />
        This repository is private and mine
      </label>
      {!props.confirmed && <p className="settings-hint">Sync stays off until this is checked.</p>}
      <p className="settings-form-hint" role="status">
        <Badge
          tone={line.tone}
          label={active ? (line.tone === "warning" ? "WARN" : "ON") : "OFF"}
        />{" "}
        {line.text}
      </p>
      {props.canSyncNow && (
        <div className="memory-hub-row-wrap-center">
          <button
            type="button"
            className="settings-button"
            disabled={props.disabled || props.syncing || !active}
            onClick={props.onSyncNow}
          >
            {props.syncing ? "Syncing..." : "Sync now"}
          </button>
        </div>
      )}
      <Feedback message={props.message} />
    </div>
  );
}

/** "All" or the number of workspaces a team repo applies to. */
export function teamRepoWorkspacesLabel(workspaceIds: readonly string[] | undefined): string {
  const count = workspaceIds?.length ?? 0;
  if (count === 0) return "All workspaces";
  return count === 1 ? "1 workspace" : `${count} workspaces`;
}

/** The status of one configured team repo, by its setting. */
export function teamRepoStatusLine(status: TeamMemoryRepoStatus | undefined): {
  tone: "success" | "warning" | "neutral";
  text: string;
} {
  if (!status) return { tone: "neutral", text: "Not loaded yet." };
  if (!status.ready) {
    return { tone: "warning", text: `Not read: ${status.problem ?? "not a memory repo"}.` };
  }
  if (status.lastPullError) {
    return { tone: "warning", text: `Ready; last update failed: ${status.lastPullError}` };
  }
  return {
    tone: "success",
    text: status.lastPullAt ? `Ready; updated ${formatRelative(status.lastPullAt)}.` : "Ready.",
  };
}

const TEAM_REPO_NAME = /^[\p{L}\p{N} ._-]+$/u;

/** Why a new team repo cannot be added (checked again in main), or null. */
export function teamRepoDraftProblem(
  draft: { name: string; path: string },
  existing: readonly MemoryRepoTeamRepoSetting[],
): string | null {
  const name = draft.name.trim();
  if (existing.length >= MEMORY_REPO_TEAM_REPOS_MAX) {
    return `At most ${MEMORY_REPO_TEAM_REPOS_MAX} team repos.`;
  }
  if (!name) return "Give the team repo a name.";
  if (name.length > 60) return "The name is too long (60 characters at most).";
  if (!TEAM_REPO_NAME.test(name)) {
    return "Use letters, digits, spaces, dots, dashes and underscores in the name.";
  }
  if (existing.some((repo) => repo.name.toLowerCase() === name.toLowerCase())) {
    return "Another team repo has this name.";
  }
  if (!draft.path.trim()) return "Enter the folder of the team repo.";
  return null;
}

/** The status reported for a configured team repo (matched by name). */
export function teamRepoStatusFor(
  repo: MemoryRepoTeamRepoSetting,
  statuses: readonly TeamMemoryRepoStatus[] | undefined,
): TeamMemoryRepoStatus | undefined {
  return statuses?.find((status) => status.name.toLowerCase() === repo.name.toLowerCase());
}

export interface MemoryRepoTeamViewProps {
  repos: readonly MemoryRepoTeamRepoSetting[];
  statuses: readonly TeamMemoryRepoStatus[] | undefined;
  /** The workspace the Memory Hub shows, for "only for this workspace". */
  workspaceId?: string | null;
  disabled: boolean;
  message: SectionMessage;
  onSave: (repos: MemoryRepoTeamRepoSetting[], done: string) => Promise<boolean>;
}

/** "Team memory": read-only memory repos shared by a team, read next to the personal folder. */
export function MemoryRepoTeamView(props: MemoryRepoTeamViewProps) {
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [onlyHere, setOnlyHere] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const full = props.repos.length >= MEMORY_REPO_TEAM_REPOS_MAX;

  const add = async () => {
    const draftProblem = teamRepoDraftProblem({ name, path: folder }, props.repos);
    setProblem(draftProblem);
    if (draftProblem) return;
    const repo: MemoryRepoTeamRepoSetting = {
      name: name.trim(),
      path: folder.trim(),
      ...(onlyHere && props.workspaceId ? { workspaceIds: [props.workspaceId] } : {}),
    };
    const saved = await props.onSave([...props.repos, repo], `Team repo "${repo.name}" added.`);
    if (saved) {
      setName("");
      setFolder("");
      setOnlyHere(false);
    }
  };

  return (
    <div className="settings-form-group memory-hub-top-gap" data-testid="memory-repo-team">
      <div className="memory-hub-primary-label">Team memory</div>
      <p className="settings-form-hint memory-hub-hint-tight">
        Read-only memory shared by a team: a memory folder you cloned from your team. CoWork reads
        it next to your own memory and never writes it. A team folder with a remote is updated every
        10 minutes when it has no local edits.
      </p>
      {props.repos.length === 0 ? (
        <p className="settings-hint">No team memory yet.</p>
      ) : (
        <div className="memory-hub-column">
          {props.repos.map((repo) => {
            const status = teamRepoStatusLine(teamRepoStatusFor(repo, props.statuses));
            return (
              <div key={repo.name} className="memory-hub-row-center memory-hub-top-gap-sm">
                <div className="memory-hub-grow">
                  <div className="memory-hub-text-primary">{repo.name}</div>
                  <div className="memory-hub-text-secondary">
                    {repo.path} · {teamRepoWorkspacesLabel(repo.workspaceIds)}
                  </div>
                  <div className="settings-form-hint memory-hub-hint-tight" role="status">
                    <Badge
                      tone={status.tone}
                      label={
                        status.tone === "success"
                          ? "READY"
                          : status.tone === "warning"
                            ? "WARN"
                            : "..."
                      }
                    />{" "}
                    {status.text}
                  </div>
                </div>
                <button
                  type="button"
                  className="settings-button"
                  aria-label={`Remove team repo ${repo.name}`}
                  disabled={props.disabled}
                  onClick={() =>
                    void props.onSave(
                      props.repos.filter((other) => other.name !== repo.name),
                      `Team repo "${repo.name}" removed.`,
                    )
                  }
                >
                  Remove
                </button>
              </div>
            );
          })}
        </div>
      )}
      {full ? (
        <p className="settings-hint">
          At most {MEMORY_REPO_TEAM_REPOS_MAX} team repos; remove one to add another.
        </p>
      ) : (
        <div className="settings-field memory-hub-top-gap">
          <label htmlFor="memory-repo-team-name">Add a team repo</label>
          <div className="memory-hub-stack-gap">
            <input
              id="memory-repo-team-name"
              className="settings-input"
              value={name}
              placeholder="Name, e.g. Platform team"
              aria-label="Team repo name"
              onChange={(e) => setName(e.target.value)}
              disabled={props.disabled}
            />
            <input
              className="settings-input"
              value={folder}
              placeholder="/Users/you/Team Memory"
              aria-label="Team repo folder"
              onChange={(e) => setFolder(e.target.value)}
              disabled={props.disabled}
            />
            <button
              type="button"
              className="settings-button"
              disabled={props.disabled || !name.trim() || !folder.trim()}
              onClick={() => void add()}
            >
              Add
            </button>
          </div>
          {props.workspaceId && (
            <label className="memory-knowledge-checkbox">
              <input
                type="checkbox"
                checked={onlyHere}
                onChange={(e) => setOnlyHere(e.target.checked)}
                disabled={props.disabled}
              />
              Only for this workspace
            </label>
          )}
          <p className="settings-hint">
            The folder must be a memory folder (a git repository with a MEMORY.md), outside your
            workspaces and apart from your own memory folder.
          </p>
          {problem && (
            <div role="alert" className="settings-feedback error memory-hub-top-gap">
              {problem}
            </div>
          )}
        </div>
      )}
      <Feedback message={props.message} />
    </div>
  );
}
