import { useEffect, useMemo, useState } from "react";
import "./memory-hub-settings.css";
import type { MemoryFeaturesSettings, Workspace } from "../../shared/types";
import { MemoryKnowledgeTab } from "./memory/MemoryKnowledgeTab";
import { peekBotMemoryContext, peekMemoryHubFocusWorkspace } from "./memory/memory-hub-focus";
import { MemoryReviewTab } from "./memory/MemoryReviewTab";
import { MemorySourcesTab } from "./memory/MemorySourcesTab";
import { MemoryHealthTab } from "./memory/MemoryHealthTab";
import { MemorySettingsTab, type MemorySettingsLinkTab } from "./memory/MemorySettingsTab";
import type { MemoryHubSource } from "../../shared/memory-hub-types";
import "./memory/memory-knowledge.css";
import { hasHostMethod } from "../host/browser-capabilities";

const DEFAULT_FEATURES: MemoryFeaturesSettings = {
  contextPackInjectionEnabled: true,
  heartbeatMaintenanceEnabled: true,
  checkpointCaptureEnabled: true,
  wakeUpLayersEnabled: true,
  temporalKnowledgeEnabled: true,
  structuredObservationsEnabled: true,
  memoryInspectorEnabled: true,
  transcriptStoreEnabled: false,
  durableContextEnabled: false,
  durableContextMode: "off",
  durableContextLargePayloadThreshold: 25000,
  memoryWriteApprovalMode: "off",
};

export function MemoryHubSettings(props?: {
  initialWorkspaceId?: string;
  onSettingsChanged?: () => void;
  /** Open a task (the source task of a memory folder entry). */
  onOpenTask?: (taskId: string) => void;
  /** Bumped to show the Review tab (a dream review notification was clicked). */
  openReviewRequest?: number;
  /** Switch the app Settings to another tab (Chronicle lives in Tools). */
  onOpenSettingsTab?: (tab: MemorySettingsLinkTab) => void;
}) {
  const [botOrigin] = useState(() => peekBotMemoryContext());
  const [features, setFeatures] = useState<MemoryFeaturesSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hubNotice, setHubNotice] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");
  // "What CoWork knows" is the primary view; everything else is under Settings.
  const [hubTab, setHubTab] = useState<"knowledge" | "review" | "sources" | "health" | "settings">(
    "knowledge",
  );
  const openReviewRequest = props?.openReviewRequest ?? 0;
  useEffect(() => {
    if (openReviewRequest > 0) setHubTab("review");
  }, [openReviewRequest]);
  // "Show" in the Sources tab opens "What CoWork knows" filtered to that source.
  const [knowledgeSourceFilter, setKnowledgeSourceFilter] = useState<MemoryHubSource | "">("");
  // Memory folder dreams waiting for review (profile-wide; the Review tab badge).
  const [dreamReviewCount, setDreamReviewCount] = useState(0);
  const memoryRepoOn = features?.memoryRepoEnabled === true;
  useEffect(() => {
    setDreamReviewCount(0);
    if (!memoryRepoOn || !hasHostMethod("getMemoryRepoDreams")) return;
    let cancelled = false;
    window.electronAPI
      .getMemoryRepoDreams()
      .then((report) => {
        if (!cancelled) setDreamReviewCount(report.pendingReviews);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [memoryRepoOn]);
  const reviewBadgeCount = dreamReviewCount;

  const selectedWorkspace = useMemo(() => {
    return workspaces.find((w) => w.id === selectedWorkspaceId) || null;
  }, [workspaces, selectedWorkspaceId]);

  useEffect(() => {
    void loadAll();
  }, []);

  const loadAll = async () => {
    try {
      setLoading(true);
      setLoadError(null);

      const [loadedFeatures, loadedWorkspaces, tempWorkspace] = await Promise.all([
        window.electronAPI.getMemoryFeaturesSettings(),
        window.electronAPI.listWorkspaces(),
        hasHostMethod("getTempWorkspace") ? window.electronAPI.getTempWorkspace() : null,
      ]);

      const combined: Workspace[] = [
        ...(tempWorkspace ? [tempWorkspace] : []),
        ...loadedWorkspaces.filter((w) => w.id !== tempWorkspace?.id),
      ];

      setFeatures(loadedFeatures);
      setWorkspaces(combined);
      if (botOrigin && !combined.some((w) => w.id === botOrigin.workspaceId))
        setHubNotice(
          "The workspace opened from this bot is no longer available. Select a workspace to continue.",
        );
      // "Open in Memory Hub" from a task reply shows the task's workspace.
      const focusWorkspaceId = peekMemoryHubFocusWorkspace();
      if (focusWorkspaceId && combined.some((w) => w.id === focusWorkspaceId)) {
        setHubTab("knowledge");
      }
      setSelectedWorkspaceId((prev) => {
        if (botOrigin && !combined.some((w) => w.id === botOrigin.workspaceId)) return "";
        if (focusWorkspaceId && combined.some((w) => w.id === focusWorkspaceId)) {
          return focusWorkspaceId;
        }
        const preferred = (props?.initialWorkspaceId || "").trim();
        if (preferred && combined.some((w) => w.id === preferred)) return preferred;
        if (prev && combined.some((w) => w.id === prev)) return prev;
        return combined[0]?.id || "";
      });
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Failed to load memory settings.");
    } finally {
      setLoading(false);
    }
  };

  // Throws on failure; the Settings tab shows the error.
  const saveFeatures = async (updates: Partial<MemoryFeaturesSettings>) => {
    try {
      setSaving(true);
      // Merge into the stored settings, not this tab's copy: other parts of the tab (the
      // memory folder, the compression budget) save other fields of the same object, which
      // a stale copy would overwrite.
      const stored = await window.electronAPI.getMemoryFeaturesSettings().catch(() => null);
      const next: MemoryFeaturesSettings = {
        ...DEFAULT_FEATURES,
        ...(stored || features),
        ...updates,
      };
      await window.electronAPI.saveMemoryFeaturesSettings(next);
      setFeatures(await window.electronAPI.getMemoryFeaturesSettings());
    } finally {
      setSaving(false);
    }
  };

  if (loadError) {
    return (
      <div className="settings-section">
        <p role="alert">{loadError}</p>
        <button className="settings-button" onClick={() => void loadAll()}>
          Retry
        </button>
      </div>
    );
  }
  if (loading || !features) {
    return (
      <div className="settings-section">
        <div className="settings-loading">Loading memory settings...</div>
      </div>
    );
  }

  const canWriteWorkspace =
    window.coworkBrowserHost !== true || selectedWorkspace?.permissions.write === true;
  const canDeleteWorkspace =
    window.coworkBrowserHost !== true || selectedWorkspace?.permissions.delete === true;

  // Workspace picker first (it scopes every view below), then the view tabs.
  const hubHeader = (
    <>
      <h2 className="settings-section-title">Memory</h2>
      {workspaces.length === 0 ? (
        <p className="settings-form-hint">No workspaces found.</p>
      ) : (
        <div className="memory-hub-workspace-bar">
          <label className="settings-label" htmlFor="memory-workspace">
            Workspace
          </label>
          <select
            id="memory-workspace"
            value={selectedWorkspaceId}
            onChange={(e) => setSelectedWorkspaceId(e.target.value)}
            className="settings-select"
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          {selectedWorkspace?.path && (
            <p className="settings-form-hint">
              <code>{selectedWorkspace.path}</code>
            </p>
          )}
        </div>
      )}
      <div className="settings-tabs" role="tablist" aria-label="Memory views">
        <button
          type="button"
          role="tab"
          aria-selected={hubTab === "knowledge"}
          className={`settings-tab ${hubTab === "knowledge" ? "active" : ""}`}
          onClick={() => {
            setKnowledgeSourceFilter("");
            setHubTab("knowledge");
          }}
        >
          What CoWork knows
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={hubTab === "review"}
          className={`settings-tab ${hubTab === "review" ? "active" : ""}`}
          onClick={() => setHubTab("review")}
        >
          Review
          {reviewBadgeCount > 0 && (
            <span className="memory-review-badge" aria-label={`${reviewBadgeCount} pending`}>
              {reviewBadgeCount}
            </span>
          )}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={hubTab === "sources"}
          className={`settings-tab ${hubTab === "sources" ? "active" : ""}`}
          onClick={() => setHubTab("sources")}
        >
          Sources
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={hubTab === "health"}
          className={`settings-tab ${hubTab === "health" ? "active" : ""}`}
          onClick={() => setHubTab("health")}
        >
          Health
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={hubTab === "settings"}
          className={`settings-tab ${hubTab === "settings" ? "active" : ""}`}
          onClick={() => setHubTab("settings")}
        >
          Settings
        </button>
      </div>
      {hubNotice && (
        <div role="alert" className="memory-hub-notice">
          {hubNotice}
          <button className="settings-button small" onClick={() => setHubNotice(null)}>
            Dismiss
          </button>
        </div>
      )}
    </>
  );

  if (hubTab === "review") {
    return (
      <div className="settings-section">
        {hubHeader}
        {selectedWorkspaceId ? (
          <MemoryReviewTab
            key={selectedWorkspaceId}
            workspaceId={selectedWorkspaceId}
            canWrite={canWriteWorkspace}
            onDreamCountChange={setDreamReviewCount}
          />
        ) : null}
      </div>
    );
  }

  if (hubTab === "sources") {
    return (
      <div className="settings-section">
        {hubHeader}
        {selectedWorkspaceId ? (
          <MemorySourcesTab
            key={selectedWorkspaceId}
            workspaceId={selectedWorkspaceId}
            canDelete={canDeleteWorkspace}
            onShowSource={(source) => {
              setKnowledgeSourceFilter(source);
              setHubTab("knowledge");
            }}
          />
        ) : null}
      </div>
    );
  }

  if (hubTab === "health") {
    return (
      <div className="settings-section">
        {hubHeader}
        {selectedWorkspaceId ? (
          <MemoryHealthTab key={selectedWorkspaceId} workspaceId={selectedWorkspaceId} />
        ) : null}
      </div>
    );
  }

  if (hubTab === "knowledge") {
    return (
      <div className="settings-section">
        {hubHeader}
        {botOrigin?.workspaceId === selectedWorkspaceId && (
          <p className="settings-form-hint">
            Workspace context opened from {botOrigin.botName}. This Hub also includes private
            context visible to you. Workspace records without a recorded bot source are shared
            workspace context.
          </p>
        )}
        {selectedWorkspaceId ? (
          <MemoryKnowledgeTab
            key={`${selectedWorkspaceId}:${knowledgeSourceFilter}`}
            workspaceId={selectedWorkspaceId}
            canWrite={canWriteWorkspace}
            canDelete={canDeleteWorkspace}
            initialSourceFilter={knowledgeSourceFilter}
            onOpenTask={props?.onOpenTask}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="settings-section">
      {hubHeader}
      <MemorySettingsTab
        workspace={selectedWorkspace}
        features={features}
        featuresSaving={saving}
        onSaveFeatures={saveFeatures}
        onFeaturesSaved={setFeatures}
        canDelete={canDeleteWorkspace}
        onSettingsChanged={props?.onSettingsChanged}
        onOpenSettingsTab={props?.onOpenSettingsTab}
      />
    </div>
  );
}
