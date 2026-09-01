import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  ExternalLink,
  FileOutput,
  GitBranch,
  KeyRound,
  ListChecks,
  Play,
  RefreshCw,
  RotateCw,
  Square,
  Users,
  Workflow,
} from "lucide-react";
import type {
  ProtectedCredentialRequestSummary,
  SessionShareSnapshot,
  SessionProgressState,
  Task,
  TaskEvent,
} from "../../shared/types";
import type {
  LocalPreviewCommandTemplate,
  LocalPreviewProcessInfo,
  LocalPreviewTemplateId,
} from "../../shared/local-preview";
import { buildSessionDashboardMetrics } from "../utils/session-dashboard";

interface SessionDashboardCardProps {
  task?: Task;
  events: TaskEvent[];
  refreshKey?: string | number;
  onSelectTask?: (taskId: string) => void;
  onOpenFile?: (path: string) => void;
  workspacePath?: string;
}

function Metric({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="session-dashboard-metric">
      <span className="session-dashboard-metric-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="session-dashboard-metric-copy">
        <span className="session-dashboard-metric-label">{label}</span>
        <strong>{value}</strong>
        {detail ? <small>{detail}</small> : null}
      </span>
    </div>
  );
}

export function SessionDashboardCard({
  task,
  events,
  refreshKey,
  onSelectTask,
  onOpenFile,
  workspacePath,
}: SessionDashboardCardProps) {
  const [progress, setProgress] = useState<SessionProgressState>();
  const [artifactCount, setArtifactCount] = useState(0);
  const [memberCount, setMemberCount] = useState(0);
  const [preview, setPreview] = useState<LocalPreviewProcessInfo>();
  const [previewTemplates, setPreviewTemplates] = useState<LocalPreviewCommandTemplate[]>([]);
  const [previewTemplateId, setPreviewTemplateId] = useState<LocalPreviewTemplateId>("npm-dev");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [credentialRequests, setCredentialRequests] = useState<ProtectedCredentialRequestSummary[]>(
    [],
  );
  const [credentialValues, setCredentialValues] = useState<Record<string, string>>({});
  const [credentialBusyId, setCredentialBusyId] = useState<string | null>(null);
  const [credentialError, setCredentialError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!task?.id) {
      setProgress(undefined);
      setArtifactCount(0);
      setMemberCount(0);
      return;
    }
    void Promise.all([
      window.electronAPI.getSessionProgress(task.id),
      window.electronAPI.listArtifacts(task.id).catch(() => []),
      window.electronAPI
        .getSessionMembers({ taskId: task.id })
        .catch(() => undefined as SessionShareSnapshot | undefined),
    ])
      .then(([nextProgress, artifacts, members]) => {
        if (cancelled) return;
        setProgress(nextProgress);
        setArtifactCount(Array.isArray(artifacts) ? artifacts.length : 0);
        setMemberCount(members?.members.filter((member) => member.status === "active").length || 0);
      })
      .catch(() => {
        if (!cancelled) setProgress(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [task?.id, task?.updatedAt, refreshKey]);

  useEffect(() => {
    let cancelled = false;
    if (!task?.id || !workspacePath || !window.electronAPI?.listLocalPreviews) {
      setPreview(undefined);
      setPreviewTemplates([]);
      return;
    }
    void Promise.all([
      window.electronAPI.listLocalPreviewTemplates().catch(() => []),
      window.electronAPI.listLocalPreviews(task.workspaceId).catch(() => []),
    ]).then(([templates, previews]) => {
      if (cancelled) return;
      const nextTemplates = Array.isArray(templates) ? templates : [];
      const nextPreview = Array.isArray(previews)
        ? previews.find((candidate) => candidate.taskId === task.id)
        : undefined;
      setPreviewTemplates(nextTemplates);
      setPreview(nextPreview);
      setPreviewTemplateId(nextPreview?.templateId || nextTemplates[0]?.id || "npm-dev");
      setPreviewError(null);
    });
    return () => {
      cancelled = true;
    };
  }, [task?.id, task?.workspaceId, workspacePath, refreshKey]);

  const refreshCredentialRequests = async () => {
    if (!task?.id || !window.electronAPI?.listProtectedCredentialRequests) return;
    try {
      const next = await window.electronAPI.listProtectedCredentialRequests({
        taskId: task.id,
        includeResolved: false,
      });
      setCredentialRequests(Array.isArray(next) ? next : []);
      setCredentialError(null);
    } catch (cause) {
      setCredentialError(
        cause instanceof Error ? cause.message : "Unable to load protected credential requests.",
      );
    }
  };

  useEffect(() => {
    let cancelled = false;
    if (!task?.id || !window.electronAPI?.listProtectedCredentialRequests) {
      setCredentialRequests([]);
      setCredentialError(null);
      return;
    }
    void window.electronAPI
      .listProtectedCredentialRequests({ taskId: task.id, includeResolved: false })
      .then((next) => {
        if (!cancelled) {
          setCredentialRequests(Array.isArray(next) ? next : []);
          setCredentialError(null);
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setCredentialError(
            cause instanceof Error
              ? cause.message
              : "Unable to load protected credential requests.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [task?.id, refreshKey]);

  const metrics = useMemo(
    () =>
      task && progress
        ? buildSessionDashboardMetrics(task, progress, events, { artifactCount, memberCount })
        : undefined,
    [artifactCount, events, memberCount, progress, task],
  );

  const startPreview = async () => {
    if (!task || !workspacePath || previewBusy) return;
    setPreviewBusy(true);
    setPreviewError(null);
    try {
      const next = await window.electronAPI.startLocalPreview({
        taskId: task.id,
        workspaceId: task.workspaceId,
        templateId: previewTemplateId,
        workingDirectory: workspacePath,
      });
      setPreview(next);
    } catch (cause) {
      setPreviewError(cause instanceof Error ? cause.message : "Unable to start local preview.");
    } finally {
      setPreviewBusy(false);
    }
  };

  const stopPreview = async () => {
    if (!preview || previewBusy) return;
    setPreviewBusy(true);
    setPreviewError(null);
    try {
      setPreview(await window.electronAPI.stopLocalPreview(preview.id));
    } catch (cause) {
      setPreviewError(cause instanceof Error ? cause.message : "Unable to stop local preview.");
    } finally {
      setPreviewBusy(false);
    }
  };

  const restartPreview = async () => {
    if (!preview || previewBusy) return;
    setPreviewBusy(true);
    setPreviewError(null);
    try {
      setPreview(await window.electronAPI.restartLocalPreview(preview.id));
    } catch (cause) {
      setPreviewError(cause instanceof Error ? cause.message : "Unable to restart local preview.");
    } finally {
      setPreviewBusy(false);
    }
  };

  const openPreview = async () => {
    if (!preview || preview.status === "stopped" || preview.status === "failed" || previewBusy)
      return;
    setPreviewBusy(true);
    setPreviewError(null);
    try {
      setPreview(await window.electronAPI.openLocalPreview(preview.id));
    } catch (cause) {
      setPreviewError(cause instanceof Error ? cause.message : "Unable to open local preview.");
    } finally {
      setPreviewBusy(false);
    }
  };

  const fulfillCredential = async (request: ProtectedCredentialRequestSummary) => {
    const value = credentialValues[request.id] || "";
    if (!value || credentialBusyId) return;
    setCredentialBusyId(request.id);
    setCredentialError(null);
    try {
      await window.electronAPI.fulfillProtectedCredentialRequest(request.id, value);
      setCredentialValues((current) => {
        const next = { ...current };
        delete next[request.id];
        return next;
      });
      await refreshCredentialRequests();
    } catch (cause) {
      setCredentialError(
        cause instanceof Error ? cause.message : "Unable to store the protected credential.",
      );
    } finally {
      setCredentialBusyId(null);
    }
  };

  const denyCredential = async (request: ProtectedCredentialRequestSummary) => {
    if (credentialBusyId) return;
    setCredentialBusyId(request.id);
    setCredentialError(null);
    try {
      await window.electronAPI.denyProtectedCredentialRequest(request.id);
      await refreshCredentialRequests();
    } catch (cause) {
      setCredentialError(
        cause instanceof Error ? cause.message : "Unable to deny the credential request.",
      );
    } finally {
      setCredentialBusyId(null);
    }
  };

  if (!task || !progress || !metrics) return null;
  const branchLabel = task.branchLabel || (task.branchFromTaskId ? "Branch" : undefined);

  return (
    <section className="session-dashboard-card" aria-label="Session dashboard">
      <div className="session-dashboard-header">
        <div>
          <span className="session-dashboard-eyebrow">
            <ListChecks size={13} /> Session dashboard
          </span>
          <strong>{progress.headline}</strong>
        </div>
        <span className={`session-dashboard-phase ${progress.phase}`}>{progress.phase}</span>
      </div>
      <div className="session-dashboard-grid">
        <Metric
          icon={<CheckCircle2 size={14} />}
          label="Progress"
          value={`${metrics.progressPercent}%`}
          detail={`${metrics.completedSteps}/${metrics.totalSteps || "—"} steps`}
        />
        <Metric
          icon={<FileOutput size={14} />}
          label="Artifacts"
          value={String(metrics.artifactCount)}
          detail="outputs"
        />
        <Metric
          icon={<KeyRound size={14} />}
          label="Approvals"
          value={String(metrics.approvalCount)}
          detail={metrics.approvalCount ? "needs attention" : "clear"}
        />
        <Metric
          icon={<Users size={14} />}
          label="Members"
          value={String(metrics.memberCount)}
          detail="active"
        />
        <Metric
          icon={<Workflow size={14} />}
          label="Automation"
          value={String(metrics.automationRunCount)}
          detail="runs"
        />
        <Metric
          icon={<GitBranch size={14} />}
          label="Workspace"
          value={String(metrics.workspaceChangeCount)}
          detail={branchLabel || "changes"}
        />
      </div>
      {metrics.recentChanges.length > 0 ? (
        <div className="session-dashboard-changes">
          <span className="session-dashboard-section-label">Recent workspace changes</span>
          {metrics.recentChanges.map((change, index) => {
            const file = events
              .filter((event) =>
                ["file_created", "file_modified", "file_deleted", "artifact_created"].includes(
                  String(event.legacyType || event.type),
                ),
              )
              .map((event) => event.payload?.path)
              .filter((path): path is string => typeof path === "string")
              .find((path) => change.endsWith(String(path).split(/[\\/]/).pop() || path));
            return (
              <button
                type="button"
                className="session-dashboard-change"
                key={`${change}-${index}`}
                onClick={() => file && onOpenFile?.(file)}
                disabled={!file}
              >
                {change}
              </button>
            );
          })}
        </div>
      ) : null}
      {task.branchFromTaskId && onSelectTask ? (
        <button
          type="button"
          className="session-dashboard-branch"
          onClick={() => onSelectTask(task.branchFromTaskId!)}
        >
          <GitBranch size={13} /> Open parent session
        </button>
      ) : null}
      {workspacePath && previewTemplates.length > 0 ? (
        <div className="session-dashboard-preview">
          <div className="session-dashboard-section-label">Local preview</div>
          <div className="session-dashboard-preview-controls">
            <select
              aria-label="Local preview command"
              value={previewTemplateId}
              onChange={(event) =>
                setPreviewTemplateId(event.target.value as LocalPreviewTemplateId)
              }
              disabled={
                previewBusy ||
                Boolean(preview && preview.status !== "stopped" && preview.status !== "failed")
              }
            >
              {previewTemplates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.label}
                </option>
              ))}
            </select>
            {!preview || preview.status === "stopped" || preview.status === "failed" ? (
              <button type="button" onClick={() => void startPreview()} disabled={previewBusy}>
                <Play size={12} aria-hidden="true" />
                {previewBusy ? "Starting…" : "Start"}
              </button>
            ) : null}
            {preview && preview.status !== "stopped" && preview.status !== "failed" ? (
              <>
                <button type="button" onClick={() => void openPreview()} disabled={previewBusy}>
                  <ExternalLink size={12} aria-hidden="true" />
                  Open
                </button>
                <button type="button" onClick={() => void restartPreview()} disabled={previewBusy}>
                  <RotateCw size={12} aria-hidden="true" />
                  Restart
                </button>
                <button type="button" onClick={() => void stopPreview()} disabled={previewBusy}>
                  <Square size={12} aria-hidden="true" />
                  Stop
                </button>
              </>
            ) : null}
          </div>
          {preview ? (
            <div className={`session-dashboard-preview-status ${preview.status}`}>
              <span>{preview.status}</span>
              <code>{preview.url}</code>
            </div>
          ) : (
            <small className="session-dashboard-preview-help">
              Starts the project’s named dev script on loopback only.
            </small>
          )}
          {previewError || preview?.lastError ? (
            <div className="session-dashboard-preview-error" role="alert">
              {previewError || preview?.lastError}
            </div>
          ) : null}
        </div>
      ) : null}
      {credentialRequests.length > 0 || credentialError ? (
        <div className="session-dashboard-credentials">
          <div className="session-dashboard-section-label">Protected credentials</div>
          <small className="session-dashboard-credential-help">
            Secrets stay in the local protected vault and are only released to their allowlisted
            hosts.
          </small>
          {credentialRequests.map((request) => (
            <div className="session-dashboard-credential-request" key={request.id}>
              <div className="session-dashboard-credential-copy">
                <strong>{request.name}</strong>
                <span>{request.destinationAllowlist.join(", ")}</span>
              </div>
              <input
                type="password"
                aria-label={`Credential value for ${request.name}`}
                placeholder="Enter secret"
                value={credentialValues[request.id] || ""}
                onChange={(event) =>
                  setCredentialValues((current) => ({
                    ...current,
                    [request.id]: event.target.value,
                  }))
                }
                disabled={credentialBusyId !== null}
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => void fulfillCredential(request)}
                disabled={credentialBusyId !== null || !credentialValues[request.id]}
              >
                {credentialBusyId === request.id ? "Saving…" : "Store"}
              </button>
              <button
                type="button"
                onClick={() => void denyCredential(request)}
                disabled={credentialBusyId !== null}
              >
                Deny
              </button>
            </div>
          ))}
          {credentialError ? (
            <div className="session-dashboard-preview-error" role="alert">
              {credentialError}
            </div>
          ) : null}
        </div>
      ) : null}
      {metrics.approvalCount > 0 ? (
        <span className="session-dashboard-refresh-hint">
          <RefreshCw size={11} /> Approval or input is waiting in this session
        </span>
      ) : null}
    </section>
  );
}
