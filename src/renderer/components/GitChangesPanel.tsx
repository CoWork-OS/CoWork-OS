import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Check, GitBranch, RefreshCw } from "lucide-react";
import "./GitChangesPanel.css";
import type {
  BrowserGitApi,
  BrowserGitDiffSummary,
  BrowserGitFileStatus,
  BrowserGitStatusSummary,
} from "../../shared/host-api/git";
import type { Workspace } from "../../shared/types";
import { getHostCapabilityReason, hasHostCapability } from "../host/browser-capabilities";

interface GitChangesPanelProps {
  workspace: Workspace | null;
}

type GitDiffRequest = Parameters<BrowserGitApi["diff"]>[0];
type GitDiffState = { request: GitDiffRequest } & (
  | { result: BrowserGitDiffSummary }
  | { error: string }
);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The repository request failed.";
}

function fileStatusLabel(file: BrowserGitFileStatus): string {
  if (file.conflicted) return "Conflict";
  if (file.untracked) return "Untracked";
  if (file.staged && file.unstaged) return "Staged + modified";
  if (file.staged) return "Staged";
  return "Modified";
}

export function GitChangesPanel({ workspace }: GitChangesPanelProps) {
  const api = window.coworkBrowserGit;
  if (!workspace) {
    return (
      <main className="main-content git-changes-view">
        <div className="git-changes-empty">Choose a project to view its Git changes.</div>
      </main>
    );
  }
  if (!hasHostCapability("git.read") || !api) {
    return (
      <main className="main-content git-changes-view">
        <header className="git-changes-header">
          <GitBranch size={20} aria-hidden="true" />
          <div>
            <span>Workspace</span>
            <h1>Git Changes</h1>
          </div>
        </header>
        <div className="git-changes-empty" role="status">
          {getHostCapabilityReason("git.read") ??
            "Git Changes are unavailable in this browser session."}
        </div>
      </main>
    );
  }
  return <GitWorkspaceChanges key={workspace.id} workspace={workspace} api={api} />;
}

function GitWorkspaceChanges({ workspace, api }: { workspace: Workspace; api: BrowserGitApi }) {
  const workspaceId = workspace.id;
  const [status, setStatus] = useState<BrowserGitStatusSummary | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [showStagedDiff, setShowStagedDiff] = useState(false);
  const [diff, setDiff] = useState<GitDiffState | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const statusRequestId = useRef(0);
  const active = useRef(false);

  const writeAvailable = hasHostCapability("git.write") && workspace.permissions.write === true;
  const writeReason =
    workspace.permissions.write === true
      ? getHostCapabilityReason("git.write")
      : "This workspace is read-only.";

  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      statusRequestId.current++;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!active.current) return;
    const requestId = ++statusRequestId.current;
    setLoading(true);
    setError(null);
    try {
      const next = await api.status(workspaceId);
      if (next.workspaceId !== workspaceId) throw new Error("The host returned another workspace.");
      if (requestId !== statusRequestId.current) return;
      setStatus(next);
      setSelectedPath((current) =>
        next.files.some((file) => file.path === current) ? current : (next.files[0]?.path ?? null),
      );
    } catch (refreshError) {
      if (requestId === statusRequestId.current) setError(errorMessage(refreshError));
    } finally {
      if (requestId === statusRequestId.current) setLoading(false);
    }
  }, [api, workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectedFile = useMemo(
    () => status?.files.find((file) => file.path === selectedPath) ?? null,
    [selectedPath, status?.files],
  );
  const diffRequest = useMemo(
    () =>
      selectedFile && (!selectedFile.untracked || showStagedDiff)
        ? { workspaceId, relativePath: selectedFile.path, staged: showStagedDiff }
        : null,
    [selectedFile, showStagedDiff, workspaceId],
  );
  const selectedDiff = diff?.request === diffRequest ? diff : null;

  useEffect(() => {
    if (!diffRequest) return;
    let current = true;
    void api
      .diff(diffRequest)
      .then((result) => {
        if (current) setDiff({ request: diffRequest, result });
      })
      .catch((diffError: unknown) => {
        if (current) setDiff({ request: diffRequest, error: errorMessage(diffError) });
      });
    return () => {
      current = false;
    };
  }, [api, diffRequest]);

  const mutateFile = async (action: "stage" | "unstage", file: BrowserGitFileStatus) => {
    if (!status?.revision || !writeAvailable || busyPath !== null || committing) return;
    setBusyPath(file.path);
    setError(null);
    setNotice(null);
    try {
      await api[action]({
        workspaceId,
        expectedRevision: status.revision,
        relativePaths: [file.path],
      });
      if (!active.current) return;
      setNotice(`${file.path} ${action === "stage" ? "staged" : "unstaged"}.`);
      await refresh();
    } catch (mutationError) {
      if (!active.current) return;
      setError(errorMessage(mutationError));
      if (/repository changed|refresh git changes/i.test(errorMessage(mutationError))) {
        await refresh();
      }
    } finally {
      if (active.current) setBusyPath(null);
    }
  };

  const commit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!status?.revision || !writeAvailable || committing || busyPath !== null) return;
    setCommitting(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.commit({
        workspaceId,
        expectedRevision: status.revision,
        message: commitMessage.trim(),
      });
      if (!active.current) return;
      setCommitMessage("");
      setNotice(
        result.commitSha ? `Created commit ${result.commitSha.slice(0, 8)}.` : "Commit completed.",
      );
      await refresh();
    } catch (commitError) {
      if (!active.current) return;
      setError(errorMessage(commitError));
      if (/repository changed|refresh git changes/i.test(errorMessage(commitError))) {
        await refresh();
      }
    } finally {
      if (active.current) setCommitting(false);
    }
  };

  const stagedFiles = status?.files.filter((file) => file.staged) ?? [];
  const commitDisabled =
    !writeAvailable ||
    committing ||
    busyPath !== null ||
    !commitMessage.trim() ||
    !status?.stagedChanges ||
    Boolean(status.filesTruncated) ||
    Boolean(status.conflictedFiles);

  return (
    <main className="main-content git-changes-view">
      <header className="git-changes-header">
        <GitBranch size={20} aria-hidden="true" />
        <div>
          <span>{workspace.name}</span>
          <h1>Git Changes</h1>
        </div>
        {status?.branch && <code className="git-changes-branch">{status.branch}</code>}
        <button
          type="button"
          className="git-refresh-button"
          onClick={() => void refresh()}
          disabled={loading}
        >
          <RefreshCw size={15} className={loading ? "spinning" : ""} aria-hidden="true" />
          Refresh
        </button>
      </header>

      {error && (
        <div className="git-changes-message error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="git-changes-message success" role="status">
          {notice}
        </div>
      )}
      {writeReason && (
        <div className="git-changes-message muted" role="status">
          {writeReason}
        </div>
      )}
      {status?.filesTruncated && (
        <div className="git-changes-message muted" role="status">
          Showing the first {status.files.length} changed files. Refresh after reducing the change
          set to commit safely.
        </div>
      )}

      {status && !status.isRepository ? (
        <section className="git-changes-empty" role="status">
          <GitBranch size={22} aria-hidden="true" />
          <strong>This project is not a Git repository.</strong>
          <span>Open a Git-backed project to review and commit changes here.</span>
        </section>
      ) : (
        <div className="git-changes-layout">
          <section className="git-changes-files" aria-label="Changed files">
            <div className="git-changes-section-title">
              <h2>Changes</h2>
              <span>{status?.changedFiles ?? 0}</span>
            </div>
            {loading && !status ? (
              <div className="git-changes-empty">Loading repository…</div>
            ) : !status ? (
              <div className="git-changes-empty">
                {error ? "Git status could not be loaded." : "Loading repository…"}
              </div>
            ) : status.files.length ? (
              <ul>
                {status.files.map((file) => (
                  <li key={`${file.path}:${file.status}`}>
                    <button
                      type="button"
                      className={`git-changes-file${selectedPath === file.path ? " selected" : ""}`}
                      onClick={() => setSelectedPath(file.path)}
                      aria-pressed={selectedPath === file.path}
                      title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                    >
                      <span className="git-changes-file-state" aria-hidden="true">
                        {file.status.trim() || "?"}
                      </span>
                      <span className="git-changes-file-name">{file.path}</span>
                      <span className="git-changes-file-label">{fileStatusLabel(file)}</span>
                    </button>
                    {file.conflicted ? (
                      <span
                        className="git-changes-action-reason"
                        title="Resolve conflicts in the desktop app first"
                      >
                        Resolve in desktop
                      </span>
                    ) : file.staged ? (
                      <button
                        type="button"
                        className="git-changes-inline-action"
                        onClick={() => void mutateFile("unstage", file)}
                        disabled={!writeAvailable || committing || busyPath !== null}
                        title={writeReason ?? "Unstage this file"}
                      >
                        {busyPath === file.path ? "Working…" : "Unstage"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="git-changes-inline-action"
                        onClick={() => void mutateFile("stage", file)}
                        disabled={!writeAvailable || committing || busyPath !== null}
                        title={writeReason ?? "Stage this file"}
                      >
                        {busyPath === file.path ? "Working…" : "Stage"}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="git-changes-empty">Working tree clean.</div>
            )}
          </section>

          <section className="git-changes-detail" aria-label="Selected change">
            {selectedFile ? (
              <>
                <div className="git-changes-detail-header">
                  <div>
                    <span>{fileStatusLabel(selectedFile)}</span>
                    <h2>{selectedFile.path}</h2>
                  </div>
                  <div className="git-changes-diff-tabs" role="tablist" aria-label="Diff version">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={!showStagedDiff}
                      onClick={() => setShowStagedDiff(false)}
                    >
                      Working tree
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={showStagedDiff}
                      onClick={() => setShowStagedDiff(true)}
                    >
                      Staged
                    </button>
                  </div>
                </div>
                {selectedFile.untracked && !showStagedDiff ? (
                  <pre className="git-changes-diff-empty">
                    Stage this new file to review its diff.
                  </pre>
                ) : selectedDiff && "error" in selectedDiff ? (
                  <div className="git-changes-message error" role="alert">
                    {selectedDiff.error}
                  </div>
                ) : selectedDiff ? (
                  <pre className="git-changes-diff">
                    {selectedDiff.result.diff || "No changes in this diff."}
                  </pre>
                ) : (
                  <pre className="git-changes-diff-empty">Loading diff…</pre>
                )}
              </>
            ) : (
              <div className="git-changes-empty">
                <Check size={20} aria-hidden="true" />
                Select a file to inspect its diff.
              </div>
            )}
          </section>

          <form className="git-changes-commit" onSubmit={(event) => void commit(event)}>
            <div className="git-changes-section-title">
              <h2>Commit staged changes</h2>
              <span>{status?.stagedChanges ?? 0} files</span>
            </div>
            <label htmlFor="git-commit-message">Commit message</label>
            <textarea
              id="git-commit-message"
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              maxLength={4000}
              placeholder="Describe this change"
              disabled={!writeAvailable || committing}
            />
            <button type="submit" disabled={commitDisabled} title={writeReason}>
              {committing ? "Committing…" : "Commit staged changes"}
            </button>
            {stagedFiles.length > 0 && <small>Only staged files will be included.</small>}
            {status?.conflictedFiles ? (
              <small>Resolve merge conflicts before committing.</small>
            ) : null}
          </form>
        </div>
      )}
    </main>
  );
}
