import { useEffect, useState } from "react";
import { BrowserHostTransport } from "./transport";

type GitStatus = {
  workspaceId: string;
  isRepository: boolean;
  branch: string | null;
  clean: boolean;
  changedFiles: number;
  stagedChanges: number;
  unstagedChanges: number;
  untrackedFiles: number;
  conflictedFiles: number;
};

type GitDiff = {
  workspaceId: string;
  isRepository: boolean;
  staged: boolean;
  relativePath: string | null;
  diff: string;
  truncated: boolean;
};

export function WorkspaceGit({
  workspaceId,
  transport,
  connected,
}: {
  workspaceId: string;
  transport: BrowserHostTransport | null;
  connected: boolean;
}) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [relativePath, setRelativePath] = useState("");
  const [staged, setStaged] = useState(false);
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  useEffect(() => {
    if (!transport || !connected) return;
    let active = true;
    setLoading(true);
    setError("");
    setStatus(null);
    setDiff(null);
    void transport
      .request<unknown>("git.status", { workspaceId })
      .then((value) => {
        if (active) setStatus(parseGitStatus(value, workspaceId));
      })
      .catch((cause) => {
        if (active) setError(messageOf(cause, "Could not read repository status."));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [workspaceId, transport, connected]);

  const showDiff = async () => {
    if (!transport || !connected || diffLoading) return;
    setDiffLoading(true);
    setError("");
    setDiff(null);
    try {
      const value = await transport.request<unknown>("git.diff", {
        workspaceId,
        staged,
        relativePath: relativePath.trim() || null,
      });
      setDiff(parseGitDiff(value, workspaceId));
    } catch (cause) {
      setError(messageOf(cause, "Could not read repository diff."));
    } finally {
      setDiffLoading(false);
    }
  };

  return (
    <section className="web-panel web-git-panel" aria-label="Workspace Git">
      <div className="web-panel-heading">
        <div>
          <p className="web-eyebrow">Repository</p>
          <h2>Git status</h2>
        </div>
      </div>
      {loading && <p className="web-muted">Reading repository status…</p>}
      {error && (
        <p className="web-inline-error" role="alert">
          {error}
        </p>
      )}
      {status && !status.isRepository && (
        <p className="web-muted">This workspace is not a Git repository.</p>
      )}
      {status?.isRepository && (
        <>
          <p className="web-git-summary">
            <strong>{status.branch || "Detached HEAD"}</strong>
            <span>{status.clean ? "Clean" : `${status.changedFiles} changed`}</span>
            <span>{status.stagedChanges} staged</span>
            <span>{status.unstagedChanges} unstaged</span>
            <span>{status.untrackedFiles} untracked</span>
            {status.conflictedFiles > 0 && <span>{status.conflictedFiles} conflicted</span>}
          </p>
          <div className="web-git-controls">
            <label htmlFor="web-git-path">File path (optional)</label>
            <input
              id="web-git-path"
              value={relativePath}
              maxLength={4096}
              placeholder="src/example.ts"
              onChange={(event) => setRelativePath(event.target.value)}
            />
            <label className="web-git-staged">
              <input
                type="checkbox"
                checked={staged}
                onChange={(event) => setStaged(event.target.checked)}
              />
              Staged changes
            </label>
            <button
              type="button"
              disabled={!connected || diffLoading}
              onClick={() => void showDiff()}
            >
              {diffLoading ? "Reading diff…" : "Show diff"}
            </button>
          </div>
          {diff && (
            <>
              {diff.truncated && <p className="web-muted">Diff truncated at 64 KiB.</p>}
              <pre className="web-git-diff">{diff.diff || "No changes in this view."}</pre>
            </>
          )}
        </>
      )}
    </section>
  );
}

function parseGitStatus(value: unknown, workspaceId: string): GitStatus {
  if (
    !isRecord(value) ||
    value.workspaceId !== workspaceId ||
    typeof value.isRepository !== "boolean" ||
    (value.branch !== null && typeof value.branch !== "string") ||
    typeof value.clean !== "boolean" ||
    !isCount(value.changedFiles) ||
    !isCount(value.stagedChanges) ||
    !isCount(value.unstagedChanges) ||
    !isCount(value.untrackedFiles) ||
    !isCount(value.conflictedFiles)
  ) {
    throw new Error("The host returned invalid Git status.");
  }
  return value as GitStatus;
}

function parseGitDiff(value: unknown, workspaceId: string): GitDiff {
  if (
    !isRecord(value) ||
    value.workspaceId !== workspaceId ||
    typeof value.isRepository !== "boolean" ||
    typeof value.staged !== "boolean" ||
    (value.relativePath !== null && typeof value.relativePath !== "string") ||
    typeof value.diff !== "string" ||
    typeof value.truncated !== "boolean"
  ) {
    throw new Error("The host returned an invalid Git diff.");
  }
  return value as GitDiff;
}

function isCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}
