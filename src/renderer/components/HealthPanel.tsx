import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Brain,
  CalendarHeart,
  CheckCircle2,
  CircleAlert,
  Plus,
  RefreshCw,
  Sparkles,
  Upload,
  X,
  HeartPulse,
} from "lucide-react";
import {
  HEALTH_SOURCE_TEMPLATES,
  type HealthDashboard,
  type HealthSource,
  type HealthSourceInput,
  type HealthWritebackItem,
  type HealthWritebackPreview,
  type HealthWorkflow,
  type HealthWorkflowType,
} from "../../shared/health";
import type { ReactNode } from "react";

interface HealthPanelProps {
  compact?: boolean;
  onOpenSettings?: () => void;
  onCreateTask?: (title: string, prompt: string) => void;
}

type SourceFormState = {
  provider: HealthSourceInput["provider"];
  kind: HealthSourceInput["kind"];
  name: string;
  description: string;
  accountLabel: string;
  notes: string;
};

const WORKFLOW_ACTIONS: Array<{
  workflowType: HealthWorkflowType;
  title: string;
  description: string;
  icon: ReactNode;
}> = [
  {
    workflowType: "marathon-training",
    title: "Marathon training",
    description: "Adaptive plan from recovery, steps, and training load.",
    icon: <ArrowRight size={14} />,
  },
  {
    workflowType: "visit-prep",
    title: "Visit prep",
    description: "Clinician-ready summary of the important signals.",
    icon: <CalendarHeart size={14} />,
  },
  {
    workflowType: "nutrition-plan",
    title: "Nutrition plan",
    description: "Food guidance that reflects your activity and labs.",
    icon: <Sparkles size={14} />,
  },
  {
    workflowType: "trend-analysis",
    title: "What changed",
    description: "A compact view of the biggest shifts in the data.",
    icon: <Brain size={14} />,
  },
];

function formatTime(timestamp?: number): string {
  if (!timestamp) return "Just now";
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function workflowPrompt(workflow: HealthWorkflow): string {
  const sections = workflow.sections
    .map((section) => `## ${section.title}\n${section.items.map((item) => `- ${item}`).join("\n")}`)
    .join("\n\n");
  return [`${workflow.title}`, workflow.summary, sections, workflow.disclaimer]
    .filter(Boolean)
    .join("\n\n");
}

function buildDefaultForm(): SourceFormState {
  const first = HEALTH_SOURCE_TEMPLATES[0];
  return {
    provider: first.provider,
    kind: first.kind,
    name: first.name,
    description: first.description,
    accountLabel: "",
    notes: "",
  };
}

export function HealthPanel({ compact = false, onOpenSettings, onCreateTask }: HealthPanelProps) {
  const [dashboard, setDashboard] = useState<HealthDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sourceForm, setSourceForm] = useState<SourceFormState>(buildDefaultForm);
  const [showSourceForm, setShowSourceForm] = useState(false);
  const [workflowBusy, setWorkflowBusy] = useState<HealthWorkflowType | null>(null);
  const [workingSourceId, setWorkingSourceId] = useState<string | null>(null);
  const [selectedWorkflow, setSelectedWorkflow] = useState<HealthWorkflow | null>(null);
  const [writebackPreview, setWritebackPreview] = useState<HealthWritebackPreview | null>(null);
  const [writebackItems, setWritebackItems] = useState<HealthWritebackItem[]>([]);
  const [writebackSource, setWritebackSource] = useState<HealthSource | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadDashboard = async () => {
    try {
      setError(null);
      const next = await window.electronAPI.getHealthDashboard();
      setDashboard(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void loadDashboard();
  }, []);

  const templateMap = useMemo(
    () => new Map(HEALTH_SOURCE_TEMPLATES.map((template) => [template.provider, template])),
    [],
  );

  const topMetrics = useMemo(() => {
    if (!dashboard) return [];
    const seen = new Set<string>();
    const result: HealthDashboard["metrics"] = [];
    for (const metric of dashboard.metrics) {
      if (seen.has(metric.key)) continue;
      seen.add(metric.key);
      result.push(metric);
      if (result.length >= 5) break;
    }
    return result;
  }, [dashboard]);

  const handleTemplateSelect = (provider: HealthSourceInput["provider"]) => {
    const template = templateMap.get(provider);
    if (!template) return;
    setSourceForm((current) => ({
      ...current,
      provider,
      kind: template.kind,
      name: template.name,
      description: template.description,
    }));
  };

  const handleCreateSource = async () => {
    try {
      setWorkingSourceId("new");
      const source = await window.electronAPI.upsertHealthSource({
        provider: sourceForm.provider,
        kind: sourceForm.kind,
        name: sourceForm.name,
        description: sourceForm.description,
        accountLabel: sourceForm.accountLabel,
        notes: sourceForm.notes,
      });
      if (source.provider === "apple-health") {
        const result = await window.electronAPI.connectAppleHealth({ sourceId: source.id });
        if (!result.success) {
          throw new Error(result.error || "Unable to connect Apple Health.");
        }
      } else {
        await window.electronAPI.syncHealthSource(source.id);
      }
      setShowSourceForm(false);
      setSourceForm(buildDefaultForm());
      await loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorkingSourceId(null);
    }
  };

  const handleSyncSource = async (sourceId: string) => {
    try {
      setWorkingSourceId(sourceId);
      await window.electronAPI.syncHealthSource(sourceId);
      await loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorkingSourceId(null);
    }
  };

  const handleConnectAppleHealth = async (source: HealthSource) => {
    try {
      setWorkingSourceId(source.id);
      const result = await window.electronAPI.connectAppleHealth({
        sourceId: source.id,
        connectionMode: source.connectionMode || "native",
      });
      if (!result.success) {
        throw new Error(result.error || "Unable to connect Apple Health.");
      }
      await loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorkingSourceId(null);
    }
  };

  const handleDisableSource = async (source: HealthSource) => {
    try {
      setWorkingSourceId(source.id);
      if (source.provider === "apple-health") {
        await window.electronAPI.resetAppleHealth(source.id);
      } else {
        await window.electronAPI.removeHealthSource(source.id);
      }
      await loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorkingSourceId(null);
    }
  };

  const handleImportFiles = async (sourceId: string) => {
    try {
      setWorkingSourceId(sourceId);
      const files = await window.electronAPI.selectFiles();
      if (!files?.length) return;
      await window.electronAPI.importHealthFiles(
        sourceId,
        files.map((file) => file.path),
      );
      await loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorkingSourceId(null);
    }
  };

  const handleGenerateWorkflow = async (workflowType: HealthWorkflowType) => {
    try {
      setWorkflowBusy(workflowType);
      const result = await window.electronAPI.generateHealthWorkflow({ workflowType });
      if (result.workflow) {
        setSelectedWorkflow(result.workflow);
        if (onCreateTask) {
          onCreateTask(result.workflow.title, workflowPrompt(result.workflow));
        }
      }
      await loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorkflowBusy(null);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadDashboard();
  };

  const buildAppleHealthWritebackItems = (source: HealthSource): HealthWritebackItem[] => {
    if (!dashboard) return [];
    const sourceMetrics = dashboard.metrics.filter((metric) => metric.sourceId === source.id);
    return sourceMetrics.slice(0, 4).map((metric, index) => ({
      id: `${source.id}-writeback-${index}`,
      type:
        metric.key === "steps"
          ? "steps"
          : metric.key === "sleep_minutes"
            ? "sleep"
            : metric.key === "resting_hr"
              ? "heart_rate"
              : metric.key === "hrv"
                ? "hrv"
                : metric.key === "weight"
                  ? "weight"
                  : metric.key === "glucose"
                    ? "glucose"
                    : "custom",
      label: metric.label,
      value: metric.value.toFixed(metric.value % 1 === 0 ? 0 : 1),
      unit: metric.unit || undefined,
      sourceId: source.id,
    }));
  };

  const handlePreviewWriteback = async (source: HealthSource) => {
    try {
      setWorkingSourceId(source.id);
      const items = buildAppleHealthWritebackItems(source);
      setWritebackItems(items);
      const result = await window.electronAPI.previewAppleHealthWriteback({
        sourceId: source.id,
        items,
      });
      if (!result.success || !result.preview) {
        throw new Error(result.error || "Unable to preview Apple Health writeback.");
      }
      setWritebackSource(source);
      setWritebackPreview(result.preview);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorkingSourceId(null);
    }
  };

  const handleApplyWriteback = async () => {
    if (!writebackSource) return;
    try {
      setWorkingSourceId(writebackSource.id);
      const result = await window.electronAPI.applyAppleHealthWriteback({
        sourceId: writebackSource.id,
        items: writebackItems,
      });
      if (!result.success) {
        throw new Error(result.error || "Unable to apply Apple Health writeback.");
      }
      setWritebackPreview(null);
      setWritebackSource(null);
      setWritebackItems([]);
      await loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorkingSourceId(null);
    }
  };

  const sourceCount = dashboard?.stats.sourceCount || 0;
  const connectedCount = dashboard?.stats.connectedCount || 0;
  const recordCount = dashboard?.stats.recordsCount || 0;
  const insightCount = dashboard?.stats.insightsCount || 0;

  if (loading) {
    return (
      <div className="health-panel">
        <div className="devices-loading">Loading health dashboard…</div>
      </div>
    );
  }

  return (
    <div className={`health-panel ${compact ? "compact" : ""}`}>
      <div className="dp-header">
        <h1 className="dp-title">Health</h1>
      </div>

      <div className="dp-input-box health-hero-box">
        <div className="health-hero-grid">
          <div className="health-hero-copy">
            <h2 className="health-hero-title">Personal health data, organized for action</h2>
            <p className="health-hero-desc">
              Connect wearables, lab results, and medical records. Track what changed, review the
              important signals, and turn the data into grounded workflows.
            </p>
            <div className="health-hero-actions">
              <button className="dp-primary-btn" onClick={() => setShowSourceForm(true)}>
                <Plus size={14} />
                Add source
              </button>
              <button className="dp-secondary-btn" onClick={handleRefresh} disabled={refreshing}>
                <RefreshCw size={14} className={refreshing ? "dp-spin" : ""} />
                Refresh
              </button>
              {onOpenSettings && (
                <button className="dp-secondary-btn" onClick={onOpenSettings}>
                  Open settings
                </button>
              )}
            </div>
          </div>
          <div className="health-summary-grid">
            <div className="health-stat-cell">
              <span className="health-stat-label">Sources</span>
              <strong>{sourceCount}</strong>
            </div>
            <div className="health-stat-cell">
              <span className="health-stat-label">Connected</span>
              <strong>{connectedCount}</strong>
            </div>
            <div className="health-stat-cell">
              <span className="health-stat-label">Records</span>
              <strong>{recordCount}</strong>
            </div>
            <div className="health-stat-cell">
              <span className="health-stat-label">Insights</span>
              <strong>{insightCount}</strong>
            </div>
            <p className="health-summary-note">
              {dashboard?.isDemo
                ? "Demo data is shown until you connect your own sources."
                : "All source data is stored locally and encrypted in the app database."}
            </p>
          </div>
        </div>
      </div>

      {error && (
        <div className="health-banner health-banner-error">
          <CircleAlert size={14} />
          <span>{error}</span>
        </div>
      )}

      {dashboard?.isDemo && (
        <div className="health-banner health-banner-info">
          <Sparkles size={14} />
          <span>
            This view is seeded with demo data so the dashboard is useful on first launch.
          </span>
        </div>
      )}

      <div className="dp-section">
        <div className="dp-section-header">
          <span className="dp-section-label">Current signals</span>
          <span className="health-section-desc">Latest metrics from your connected sources</span>
        </div>
        <div className="health-metric-grid">
          {topMetrics.map((metric) => (
            <article
              key={`${metric.sourceId}:${metric.key}`}
              className="dp-task-card health-metric-card"
            >
              <span className="health-metric-label">{metric.label}</span>
              <strong>
                {Number.isFinite(metric.value)
                  ? metric.value.toFixed(metric.value % 1 === 0 ? 0 : 1)
                  : "—"}{" "}
                <span>{metric.unit}</span>
              </strong>
              <span className={`health-trend ${metric.trend || "stable"}`}>
                {metric.trend === "up" ? "Up" : metric.trend === "down" ? "Down" : "Stable"}
              </span>
              <small>{metric.sourceLabel}</small>
            </article>
          ))}
          {topMetrics.length === 0 && (
            <div className="dp-placeholder health-empty-wide">
              <CircleAlert size={20} />
              <span>No health metrics yet. Add a source or import a file to begin.</span>
            </div>
          )}
        </div>
      </div>

      <div className="dp-section">
        <div className="dp-section-header">
          <span className="dp-section-label">Sources</span>
          <span className="health-section-desc">Wearables, labs, and records</span>
        </div>
        <div className="health-source-grid">
          {(dashboard?.sources || []).map((source) => (
            <article key={source.id} className={`dp-task-card health-source-card ${source.status}`}>
              <div className="health-source-top">
                <div>
                  <h3>{source.name}</h3>
                  <p>{source.description}</p>
                </div>
                <div className="health-source-badges">
                  <div className="health-source-status">
                    <span
                      className={`dp-status-dot ${
                        source.status === "connected"
                          ? "online"
                          : source.status === "syncing"
                            ? "syncing"
                            : "off"
                      }`}
                    />
                    <span
                      className={`health-source-status-label ${
                        source.status === "connected"
                          ? "online"
                          : source.status === "syncing"
                            ? "syncing"
                            : "off"
                      }`}
                    >
                      {source.status === "connected"
                        ? "Connected"
                        : source.status === "syncing"
                          ? "Syncing"
                          : source.status.replace("-", " ")}
                    </span>
                  </div>
                  {source.provider === "apple-health" && (
                    <span className="health-pill accent">
                      {source.connectionMode === "native" ? "HealthKit" : "Import only"}
                    </span>
                  )}
                </div>
              </div>
              <div className="health-source-meta">
                <span>{source.accountLabel || source.provider}</span>
                <span>{formatTime(source.lastSyncedAt || source.updatedAt)}</span>
              </div>
              {source.provider === "apple-health" && (
                <div className="health-source-details">
                  <span>{source.permissionState || "not-determined"}</span>
                  <span>{source.readableTypes?.length || 0} read types</span>
                  <span>{source.writableTypes?.length || 0} write types</span>
                </div>
              )}
              {source.syncHistory?.[0] && (
                <p className="health-source-history">
                  Latest {source.syncHistory[0].action} · {source.syncHistory[0].status}
                </p>
              )}
              <div className="health-source-actions">
                {source.provider === "apple-health" && source.connectionMode === "native" ? (
                  <>
                    {source.permissionState !== "authorized" &&
                    source.permissionState !== "import-only" ? (
                      <button
                        className="dp-secondary-btn"
                        onClick={() => handleConnectAppleHealth(source)}
                        disabled={workingSourceId === source.id}
                      >
                        {workingSourceId === source.id ? "Working..." : "Connect"}
                      </button>
                    ) : null}
                    <button
                      className="dp-secondary-btn"
                      onClick={() => handlePreviewWriteback(source)}
                      disabled={
                        workingSourceId === source.id || source.permissionState !== "authorized"
                      }
                    >
                      <HeartPulse size={14} />
                      Writeback
                    </button>
                    <button
                      className="dp-secondary-btn"
                      onClick={() => handleSyncSource(source.id)}
                      disabled={
                        workingSourceId === source.id || source.permissionState !== "authorized"
                      }
                    >
                      {workingSourceId === source.id ? "Working..." : "Sync"}
                    </button>
                  </>
                ) : (
                  <button
                    className="dp-secondary-btn"
                    onClick={() => handleImportFiles(source.id)}
                    disabled={workingSourceId === source.id}
                  >
                    <Upload size={14} />
                    Import
                  </button>
                )}
                <button
                  className="dp-ghost-btn"
                  onClick={() => handleDisableSource(source)}
                  disabled={workingSourceId === source.id}
                >
                  {source.provider === "apple-health" ? "Remove" : "Disable"}
                </button>
              </div>
              {source.provider === "apple-health" && source.connectionMode !== "native" && (
                <p className="health-source-note">
                  Native Apple Health requires macOS. On this device, use export import instead.
                </p>
              )}
            </article>
          ))}
          {(dashboard?.sources || []).length === 0 && (
            <div className="dp-placeholder health-empty-wide">
              <CheckCircle2 size={20} />
              <span>No sources yet. Add a wearable, lab feed, or medical record source.</span>
            </div>
          )}
        </div>
      </div>

      <div className="dp-section">
        <div className="dp-section-header">
          <span className="dp-section-label">Workflow studio</span>
          <span className="health-section-desc">
            Generate an actionable summary from the current health state
          </span>
        </div>
        <div className="health-workflow-grid">
          {WORKFLOW_ACTIONS.map((action) => (
            <button
              key={action.workflowType}
              type="button"
              className="dp-task-card health-workflow-card"
              onClick={() => handleGenerateWorkflow(action.workflowType)}
              disabled={workflowBusy !== null}
            >
              <div className="health-workflow-icon">{action.icon}</div>
              <div className="health-workflow-copy">
                <strong>{action.title}</strong>
                <span>{action.description}</span>
              </div>
              <span className="health-workflow-go">
                {workflowBusy === action.workflowType ? "Working..." : "Generate"}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="health-columns">
        <div className="dp-section">
          <div className="dp-section-header">
            <span className="dp-section-label">Insights</span>
            <span className="health-section-desc">What the data suggests right now</span>
          </div>
          <div className="health-list">
            {(dashboard?.insights || []).slice(0, 5).map((insight) => (
              <div key={insight.id} className={`dp-task-card health-list-item ${insight.severity}`}>
                <div>
                  <strong>{insight.title}</strong>
                  <p>{insight.summary}</p>
                </div>
                <small>{formatTime(insight.createdAt)}</small>
              </div>
            ))}
            {(dashboard?.insights || []).length === 0 && (
              <div className="dp-placeholder">No derived insights yet.</div>
            )}
          </div>
        </div>

        <div className="dp-section">
          <div className="dp-section-header">
            <span className="dp-section-label">Recent records</span>
            <span className="health-section-desc">Imported notes, labs, and summaries</span>
          </div>
          <div className="health-list">
            {(dashboard?.records || []).slice(0, 5).map((record) => (
              <div key={record.id} className="dp-task-card health-list-item record">
                <div>
                  <strong>{record.title}</strong>
                  <p>{record.summary}</p>
                </div>
                <small>{formatTime(record.recordedAt)}</small>
              </div>
            ))}
            {(dashboard?.records || []).length === 0 && (
              <div className="dp-placeholder">No records imported yet.</div>
            )}
          </div>
        </div>
      </div>

      <div className="dp-section">
        <div className="dp-section-header">
          <span className="dp-section-label">Latest workflow</span>
          <span className="health-section-desc">Last generated health plan</span>
        </div>
        {selectedWorkflow || dashboard?.workflows?.[0] ? (
          <WorkflowCard
            workflow={selectedWorkflow || dashboard!.workflows[0]}
            onCreateTask={onCreateTask}
          />
        ) : (
          <div className="dp-placeholder health-empty-wide">
            <Sparkles size={20} />
            <span>Generate a workflow to see a personalized training or visit-prep plan here.</span>
          </div>
        )}
      </div>

      <div className="dp-section health-footer-note">
        <p>
          Health guidance is informational only. It should not be used as a diagnosis or a
          replacement for professional care.
        </p>
      </div>

      {showSourceForm && (
        <div className="health-modal-backdrop" onClick={() => setShowSourceForm(false)}>
          <div className="dp-input-box health-modal" onClick={(event) => event.stopPropagation()}>
            <div className="health-modal-head">
              <div>
                <h3 className="dp-section-label">Add source</h3>
                <p className="health-modal-desc">Connect a wearable, lab feed, or record source.</p>
              </div>
              <button
                type="button"
                className="dp-ghost-btn health-icon-btn"
                onClick={() => setShowSourceForm(false)}
                aria-label="Close"
              >
                <X size={14} />
              </button>
            </div>

            <div className="health-form-grid">
              <label>
                Source
                <select
                  value={sourceForm.provider}
                  onChange={(event) =>
                    handleTemplateSelect(event.target.value as HealthSourceInput["provider"])
                  }
                >
                  {HEALTH_SOURCE_TEMPLATES.map((template) => (
                    <option key={template.provider} value={template.provider}>
                      {template.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Type
                <select
                  value={sourceForm.kind}
                  onChange={(event) =>
                    setSourceForm((current) => ({
                      ...current,
                      kind: event.target.value as HealthSourceInput["kind"],
                    }))
                  }
                >
                  <option value="wearable">Wearable</option>
                  <option value="lab">Lab</option>
                  <option value="record">Medical record</option>
                  <option value="manual">Manual</option>
                </select>
              </label>
              <label className="span-2">
                Display name
                <input
                  value={sourceForm.name}
                  onChange={(event) =>
                    setSourceForm((current) => ({ ...current, name: event.target.value }))
                  }
                  placeholder="My Apple Health"
                />
              </label>
              <label className="span-2">
                Account label
                <input
                  value={sourceForm.accountLabel}
                  onChange={(event) =>
                    setSourceForm((current) => ({
                      ...current,
                      accountLabel: event.target.value,
                    }))
                  }
                  placeholder="Optional label"
                />
              </label>
              <label className="span-2">
                Description
                <textarea
                  value={sourceForm.description}
                  onChange={(event) =>
                    setSourceForm((current) => ({
                      ...current,
                      description: event.target.value,
                    }))
                  }
                  rows={3}
                />
              </label>
              <label className="span-2">
                Notes
                <textarea
                  value={sourceForm.notes}
                  onChange={(event) =>
                    setSourceForm((current) => ({ ...current, notes: event.target.value }))
                  }
                  rows={3}
                  placeholder="Optional context, such as a clinician or device note."
                />
              </label>
            </div>

            <div className="health-modal-actions">
              <button className="dp-secondary-btn" onClick={() => setShowSourceForm(false)}>
                Cancel
              </button>
              <button className="dp-primary-btn" onClick={handleCreateSource}>
                Add source
              </button>
            </div>
          </div>
        </div>
      )}

      {writebackPreview && writebackSource && (
        <div className="health-modal-backdrop" onClick={() => setWritebackPreview(null)}>
          <div className="dp-input-box health-modal" onClick={(event) => event.stopPropagation()}>
            <div className="health-modal-head">
              <div>
                <h3 className="dp-section-label">Review Apple Health writeback</h3>
                <p className="health-modal-desc">
                  Confirm the items that will be written to {writebackPreview.sourceLabel}.
                </p>
              </div>
              <button
                type="button"
                className="dp-ghost-btn health-icon-btn"
                onClick={() => setWritebackPreview(null)}
                aria-label="Close"
              >
                <X size={14} />
              </button>
            </div>

            <div className="health-writeback-preview">
              <div className="health-writeback-summary">
                <span className={`health-pill ${writebackPreview.connectionMode}`}>
                  {writebackPreview.connectionMode === "native"
                    ? "HealthKit writeback"
                    : "Import only"}
                </span>
                <p>{writebackPreview.items.length} item(s) prepared for Apple Health.</p>
              </div>
              {writebackPreview.warnings.length > 0 && (
                <div className="health-writeback-warnings">
                  {writebackPreview.warnings.map((warning) => (
                    <div key={warning} className="health-banner health-banner-info">
                      <CircleAlert size={14} />
                      <span>{warning}</span>
                    </div>
                  ))}
                </div>
              )}
              <ul className="health-writeback-items">
                {writebackPreview.items.map((item) => (
                  <li key={item.id}>
                    <strong>{item.label}</strong>
                    <span>
                      {item.value}
                      {item.unit ? ` ${item.unit}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="health-modal-actions">
              <button className="dp-secondary-btn" onClick={() => setWritebackPreview(null)}>
                Cancel
              </button>
              <button className="dp-primary-btn" onClick={handleApplyWriteback}>
                Apply writeback
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function WorkflowCard({
  workflow,
  onCreateTask,
}: {
  workflow: HealthWorkflow;
  onCreateTask?: (title: string, prompt: string) => void;
}) {
  return (
    <article className="dp-task-card health-workflow-preview">
      <div className="health-workflow-preview-head">
        <div>
          <span className="health-pill accent">{workflow.workflowType.replace("-", " ")}</span>
          <h3>{workflow.title}</h3>
          <p>{workflow.summary}</p>
        </div>
        <span className="health-workflow-time">{formatTime(workflow.createdAt)}</span>
      </div>
      <div className="health-workflow-sections">
        {workflow.sections.map((section) => (
          <section key={section.title} className="health-workflow-section">
            <h4>{section.title}</h4>
            <ul>
              {section.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <div className="health-workflow-footer">
        <span>{workflow.disclaimer}</span>
        {onCreateTask && (
          <button
            className="dp-secondary-btn"
            onClick={() => onCreateTask(workflow.title, workflowPrompt(workflow))}
          >
            Create task
          </button>
        )}
      </div>
    </article>
  );
}
