import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Workspace, WorkspaceKitStatus } from "../../../shared/types";
import { isBrowserHost } from "../../host/browser-capabilities";
import { FileViewer } from "../FileViewer";
import { SettingsBadge, SettingsRow } from "./SettingsRow";

function formatTimestamp(timestamp?: number): string | null {
  if (!timestamp) return null;
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return null;
  }
}

function formatBytes(bytes?: number): string | null {
  if (!bytes || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

const KIT_FILES = [".cowork/USER.md", ".cowork/MEMORY.md", ".cowork/DESIGN.md"] as const;

/**
 * Advanced → Workspace kit: the recommended `.cowork/` files of the workspace (preset,
 * status, initialize, projects) and opening its USER.md, MEMORY.md and DESIGN.md.
 */
export function WorkspaceKitPanel({
  workspace,
  onError,
}: {
  workspace: Workspace;
  onError: (message: string) => void;
}) {
  const workspaceId = workspace.id;
  const [status, setStatus] = useState<WorkspaceKitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preset, setPreset] = useState<"default" | "venture_operator">("default");
  const [newProjectId, setNewProjectId] = useState("");
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const alive = useRef(true);
  const report = useRef(onError);
  report.current = onError;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const health = useMemo(() => {
    const files = status?.files || [];
    return {
      staleCount: files.filter((file) => file.stale).length,
      warningCount: status?.lintWarningCount || 0,
      errorCount: status?.lintErrorCount || 0,
    };
  }, [status]);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      const next = await window.electronAPI.getWorkspaceKitStatus(workspaceId);
      if (alive.current) setStatus(next);
    } catch (error) {
      if (alive.current) report.current(errorText(error, "Failed to load workspace kit status."));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const initialize = async () => {
    try {
      setBusy(true);
      const next = await window.electronAPI.initWorkspaceKit({
        workspaceId,
        mode: "missing",
        templatePreset: preset,
      });
      if (alive.current) setStatus(next);
    } catch (error) {
      if (alive.current) report.current(errorText(error, "Failed to initialize workspace kit."));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const createProject = async () => {
    const projectId = newProjectId.trim();
    if (!projectId) return;
    try {
      setBusy(true);
      await window.electronAPI.createWorkspaceKitProject({ workspaceId, projectId });
      if (alive.current) setNewProjectId("");
      await refresh();
    } catch (error) {
      if (alive.current) report.current(errorText(error, "Failed to create project folder."));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const openFile = async (relPath: string) => {
    if (isBrowserHost()) {
      setPreviewPath(relPath);
      return;
    }
    try {
      if (!(await window.electronAPI.openWorkspaceKitFile({ workspaceId, relPath })))
        throw new Error("Workspace kit file could not be opened.");
    } catch (error) {
      if (alive.current)
        report.current(errorText(error, "Workspace kit file could not be opened."));
    }
  };

  const onboarding = status?.onboarding;

  return (
    <div className="workspace-kit-panel">
      {previewPath && (
        <FileViewer
          filePath={previewPath}
          workspacePath={workspace.path}
          onClose={() => setPreviewPath(null)}
        />
      )}
      <SettingsRow
        label="Kit preset"
        htmlFor="memory-kit-preset"
        hint="Venture operator also seeds company, KPI and operating-loop files."
      >
        <select
          id="memory-kit-preset"
          className="settings-select"
          value={preset}
          onChange={(event) =>
            setPreset(event.target.value === "venture_operator" ? "venture_operator" : "default")
          }
        >
          <option value="default">Default workspace kit</option>
          <option value="venture_operator">Venture operator kit</option>
        </select>
      </SettingsRow>

      <SettingsRow
        label="Workspace kit"
        hint={
          <>
            Creates the recommended <code>.cowork/</code> files for shared, durable context.
          </>
        }
        below={
          status && (
            <div className="workspace-kit-status">
              <div className="memory-hub-stack-wrap">
                <SettingsBadge tone={status.hasKitDir ? "success" : "warning"}>
                  {status.hasKitDir ? ".cowork ready" : ".cowork missing"}
                </SettingsBadge>
                <SettingsBadge tone={status.missingCount > 0 ? "error" : "success"}>
                  {status.missingCount} missing
                </SettingsBadge>
                <SettingsBadge tone={health.errorCount > 0 ? "error" : "neutral"}>
                  {health.errorCount} lint error{health.errorCount === 1 ? "" : "s"}
                </SettingsBadge>
                <SettingsBadge tone={health.warningCount > 0 ? "warning" : "neutral"}>
                  {health.warningCount} warning{health.warningCount === 1 ? "" : "s"}
                </SettingsBadge>
                <SettingsBadge tone={health.staleCount > 0 ? "warning" : "neutral"}>
                  {health.staleCount} stale
                </SettingsBadge>
                {onboarding && (
                  <SettingsBadge
                    tone={
                      onboarding.onboardingCompletedAt
                        ? "success"
                        : onboarding.bootstrapPresent
                          ? "warning"
                          : "neutral"
                    }
                  >
                    {onboarding.onboardingCompletedAt
                      ? "Onboarding completed"
                      : onboarding.bootstrapPresent
                        ? "Bootstrap active"
                        : "Bootstrap missing"}
                  </SettingsBadge>
                )}
              </div>
              <p className="settings-form-hint">
                {status.workspacePath ? `${status.workspacePath} · ` : ""}
                {onboarding?.bootstrapSeededAt
                  ? `Bootstrap seeded ${formatTimestamp(onboarding.bootstrapSeededAt)}`
                  : "Bootstrap not yet seeded"}
              </p>
              {status.files.length > 0 && (
                <details className="memory-settings-details">
                  <summary>Show kit files</summary>
                  <ul className="memory-sources-list">
                    {status.files.map((file) => {
                      const warningCount =
                        file.issues?.filter((issue) => issue.level === "warning").length || 0;
                      const errorCount =
                        file.issues?.filter((issue) => issue.level === "error").length || 0;
                      const modifiedAt = formatTimestamp(file.modifiedAt);
                      const sizeLabel = formatBytes(file.sizeBytes);
                      const metadata = [
                        file.title,
                        modifiedAt ? `updated ${modifiedAt}` : null,
                        sizeLabel,
                        typeof file.revisionCount === "number"
                          ? `${file.revisionCount} revision${file.revisionCount === 1 ? "" : "s"}`
                          : null,
                      ].filter(Boolean);
                      return (
                        <li key={file.relPath} className="memory-sources-item">
                          <div className="memory-sources-item-text">
                            <div className="memory-sources-item-title">
                              <code>{file.relPath}</code>{" "}
                              {file.specialHandling === "heartbeat" && (
                                <SettingsBadge tone="warning">heartbeat</SettingsBadge>
                              )}
                              {file.specialHandling === "bootstrap" && (
                                <SettingsBadge tone="neutral">bootstrap</SettingsBadge>
                              )}
                              {file.specialHandling === "design-system" && (
                                <SettingsBadge tone="neutral">design</SettingsBadge>
                              )}
                            </div>
                            {metadata.length > 0 && (
                              <div className="memory-sources-item-meta">{metadata.join(" · ")}</div>
                            )}
                            {file.issues && file.issues.length > 0 && (
                              <ul className="workspace-kit-issues">
                                {file.issues.map((issue) => (
                                  <li key={`${file.relPath}:${issue.code}:${issue.message}`}>
                                    <strong
                                      className={
                                        issue.level === "error"
                                          ? "workspace-kit-issue-error"
                                          : "workspace-kit-issue-warning"
                                      }
                                    >
                                      {issue.code}
                                    </strong>{" "}
                                    {issue.message}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                          <div className="memory-sources-item-actions">
                            <SettingsBadge tone={file.exists ? "success" : "error"}>
                              {file.exists ? "OK" : "Missing"}
                            </SettingsBadge>
                            {file.stale && <SettingsBadge tone="warning">stale</SettingsBadge>}
                            {errorCount > 0 && (
                              <SettingsBadge tone="error">
                                {errorCount} error{errorCount === 1 ? "" : "s"}
                              </SettingsBadge>
                            )}
                            {warningCount > 0 && (
                              <SettingsBadge tone="warning">
                                {warningCount} warning{warningCount === 1 ? "" : "s"}
                              </SettingsBadge>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </details>
              )}
            </div>
          )
        }
      >
        <button
          type="button"
          className="settings-button"
          onClick={() => void refresh()}
          disabled={loading || busy}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
        <button
          type="button"
          className="settings-button"
          onClick={() => void initialize()}
          disabled={busy}
        >
          {busy ? "Working…" : "Initialize"}
        </button>
      </SettingsRow>

      <SettingsRow
        label="Projects"
        htmlFor="memory-kit-project"
        hint="Adds a project folder with its own context files under .cowork/projects."
        below={
          <div className="memory-settings-inline-field">
            <input
              id="memory-kit-project"
              className="settings-input"
              value={newProjectId}
              onChange={(event) => setNewProjectId(event.target.value)}
              placeholder="New project id (e.g. website-redesign)"
            />
            <button
              type="button"
              className="settings-button"
              onClick={() => void createProject()}
              disabled={busy || !newProjectId.trim()}
            >
              Create project
            </button>
          </div>
        }
      />

      <SettingsRow label="Kit files" hint="Open the workspace's profile, memory and design notes.">
        {KIT_FILES.map((relPath) => (
          <button
            key={relPath}
            type="button"
            className="settings-button"
            onClick={() => void openFile(relPath)}
            disabled={busy}
          >
            Open {relPath.replace(".cowork/", "")}
          </button>
        ))}
      </SettingsRow>
    </div>
  );
}
