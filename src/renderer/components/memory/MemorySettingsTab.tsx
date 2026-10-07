import { useCallback, useEffect, useState } from "react";
import type {
  AutonomyConfig,
  AwarenessConfig,
  AwarenessSource,
  MemoryFeaturesSettings,
  Workspace,
} from "../../../shared/types";
import { hasHostMethod, hasHostMethods, isBrowserHost } from "../../host/browser-capabilities";
import { AwarenessDetailsPanel } from "./AwarenessDetailsPanel";
import "../memory-hub-settings.css";
import {
  BROWSER_PENDING_FEATURES,
  compressionCostNotice,
  isMemoryInUse,
  isSessionRecoveryOn,
  memoryInUsePatch,
  parseCompressionBudget,
  parseStorageCapMb,
  RETENTION_OPTIONS,
  scopeCaption,
  sessionRecoveryPatch,
  strictPrivacyPatch,
  type MemoryClearSummary,
  type WorkspaceMemorySettings,
} from "./memory-settings-model";
import { MemoryImportSection } from "./MemoryImportSection";
import { MemoryInspectorPanel } from "./MemoryInspectorPanel";
import {
  MEMORY_REPO_METHODS,
  MemoryRepoCard,
  MemoryRepoLocation,
  useMemoryRepoController,
} from "./MemoryRepoCard";
import { SettingsGroup, SettingsRow, SettingsSection, SettingsSwitch } from "./SettingsRow";
import { SUPERMEMORY_METHODS, SupermemoryConnection } from "./SupermemoryConnection";
import {
  useWorkspaceMemorySettings,
  type WorkspaceMemoryStats,
} from "./useWorkspaceMemorySettings";
import { WakeUpLayersPreview } from "./WakeUpLayersPreview";
import { WorkspaceKitPanel } from "./WorkspaceKitPanel";

/** The app Settings tabs the Memory Settings tab links to. */
export type MemorySettingsLinkTab = "tools";

type SourcePolicy = AwarenessConfig["sources"][AwarenessSource];

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export interface WorkspaceMemorySectionProps {
  settings: WorkspaceMemorySettings | null;
  loadError: string | null;
  saving: boolean;
  clearing: boolean;
  clearSummary: MemoryClearSummary | null;
  canDelete: boolean;
  onSave: (updates: Partial<WorkspaceMemorySettings>) => void;
  onClear: () => void;
  onRetry: () => void;
}

/** "This workspace": use memory, learn from chats, strict privacy, history, clear. */
export function WorkspaceMemorySection(props: WorkspaceMemorySectionProps) {
  const { settings } = props;
  if (props.loadError) {
    return (
      <div role="alert" className="memory-settings-load-error">
        {props.loadError}{" "}
        <button type="button" className="settings-button" onClick={props.onRetry}>
          Retry
        </button>
      </div>
    );
  }
  if (!settings) return <div className="settings-empty">Loading...</div>;
  const inUse = isMemoryInUse(settings);
  const retentionKnown = RETENTION_OPTIONS.some((option) => option.days === settings.retentionDays);
  return (
    <>
      <SettingsRow label="Use memory" hint="Let CoWork remember and recall context here.">
        <SettingsSwitch
          label="Use memory"
          checked={inUse}
          onChange={(on) => props.onSave(memoryInUsePatch(on, settings.privacyMode))}
          disabled={props.saving}
        />
      </SettingsRow>
      <SettingsRow
        label="Learn from chats"
        hint="Save useful context from chats and tasks automatically."
      >
        <SettingsSwitch
          label="Learn from chats"
          checked={settings.autoCapture}
          onChange={(on) => props.onSave({ autoCapture: on })}
          disabled={props.saving || !inUse}
        />
      </SettingsRow>
      <SettingsRow
        label="Strict privacy"
        hint="Keep every new memory private. Off: sensitive data is detected automatically."
      >
        <SettingsSwitch
          label="Strict privacy"
          checked={settings.privacyMode === "strict"}
          onChange={(on) => props.onSave(strictPrivacyPatch(on))}
          disabled={props.saving || !inUse}
        />
      </SettingsRow>
      <SettingsRow
        label="Keep history for"
        htmlFor="memory-retention"
        hint="Older memories are deleted automatically."
      >
        <select
          id="memory-retention"
          className="settings-select"
          value={settings.retentionDays}
          onChange={(event) =>
            props.onSave({ retentionDays: Number.parseInt(event.target.value, 10) })
          }
          disabled={props.saving}
        >
          {!retentionKnown && (
            <option value={settings.retentionDays}>{settings.retentionDays} days</option>
          )}
          {RETENTION_OPTIONS.map((option) => (
            <option key={option.days} value={option.days}>
              {option.label}
            </option>
          ))}
        </select>
      </SettingsRow>
      <SettingsRow
        label="Clear this workspace's memory"
        hint="Deletes this workspace's memories for good. Facts about you are cleared in What CoWork knows."
        below={
          props.clearSummary && (
            <div role="status" className="memory-settings-clear-summary">
              <p className="settings-form-hint">Cleared:</p>
              <ul className="memory-clear-summary">
                {props.clearSummary.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              {props.clearSummary.errors.length > 0 && (
                <p className="settings-form-hint" role="alert">
                  Some stores could not be cleared: {props.clearSummary.errors.join("; ")}
                </p>
              )}
              {props.clearSummary.notes.map((note) => (
                <p key={note} className="settings-form-hint">
                  {note}
                </p>
              ))}
            </div>
          )
        }
      >
        <button
          type="button"
          className="settings-button settings-button-danger"
          onClick={props.onClear}
          disabled={props.saving || props.clearing || !props.canDelete}
          title={!props.canDelete ? "This workspace does not permit memory deletion." : undefined}
        >
          {props.clearing ? "Clearing..." : "Clear memory"}
        </button>
      </SettingsRow>
    </>
  );
}

/** Connections → Chronicle: configured with the other tools; this row links there. */
export function ChronicleConnectionRow({
  onOpenSettingsTab,
}: {
  onOpenSettingsTab?: (tab: MemorySettingsLinkTab) => void;
}) {
  return (
    <SettingsRow label="Chronicle" hint="Screen context · managed in Tools" testId="chronicle-link">
      {onOpenSettingsTab && (
        <button
          type="button"
          className="settings-button"
          aria-label="Open Chronicle in Tools"
          onClick={() => onOpenSettingsTab("tools")}
        >
          Open
        </button>
      )}
    </SettingsRow>
  );
}

/** Proactive: the chief of staff and awareness private mode (all workspaces). */
export function ProactiveSection(props: {
  autonomyConfig: AutonomyConfig | null;
  autonomySaving: boolean;
  onSaveAutonomy: (next: AutonomyConfig) => void;
  awarenessConfig: AwarenessConfig | null;
  awarenessSaving: boolean;
  onSaveAwareness: (next: AwarenessConfig) => void;
  loaded: boolean;
}) {
  const { autonomyConfig, awarenessConfig } = props;
  if (!autonomyConfig && !awarenessConfig) {
    return (
      <div className="settings-empty">
        {props.loaded ? "Proactive features are not available here." : "Loading..."}
      </div>
    );
  }
  return (
    <>
      {autonomyConfig && (
        <SettingsRow
          label="Chief of staff"
          hint="Plans toward your goals, suggests next steps and runs allowed local actions."
        >
          <SettingsSwitch
            label="Chief of staff"
            checked={autonomyConfig.enabled}
            onChange={(enabled) => props.onSaveAutonomy({ ...autonomyConfig, enabled })}
            disabled={props.autonomySaving}
          />
        </SettingsRow>
      )}
      {autonomyConfig?.enabled && (
        <SettingsRow
          label="Auto-evaluate"
          hint="Re-plan when ambient signals change, not only on request."
        >
          <SettingsSwitch
            label="Auto-evaluate"
            checked={autonomyConfig.autoEvaluate}
            onChange={(autoEvaluate) => props.onSaveAutonomy({ ...autonomyConfig, autoEvaluate })}
            disabled={props.autonomySaving}
          />
        </SettingsRow>
      )}
      {awarenessConfig && (
        <SettingsRow
          label="Awareness private mode"
          hint="Pause browser, clipboard and notification signals; tasks keep running."
        >
          <SettingsSwitch
            label="Awareness private mode"
            checked={awarenessConfig.privateModeEnabled}
            onChange={(privateModeEnabled) =>
              props.onSaveAwareness({ ...awarenessConfig, privateModeEnabled })
            }
            disabled={props.awarenessSaving}
          />
        </SettingsRow>
      )}
    </>
  );
}

/** A number field saved on blur or Enter (not on every keystroke). */
function CommitNumberField(props: {
  id: string;
  value: number | null;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  parse: (raw: string) => number | null;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(props.value === null ? "" : String(props.value));
  const [saved, setSaved] = useState(props.value);
  if (saved !== props.value) {
    setSaved(props.value);
    setDraft(props.value === null ? "" : String(props.value));
  }
  const commit = () => {
    const next = props.parse(draft);
    if (next === null || next === props.value) {
      setDraft(props.value === null ? "" : String(props.value));
      return;
    }
    setDraft(String(next));
    props.onCommit(next);
  };
  return (
    <input
      id={props.id}
      className="settings-input"
      type="number"
      min={props.min}
      max={props.max}
      step={props.step}
      value={draft}
      disabled={props.disabled || props.value === null}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }}
    />
  );
}

/** Advanced → Cost and storage. */
function CostAndStorageRows(props: {
  settings: WorkspaceMemorySettings | null;
  stats: WorkspaceMemoryStats | null;
  saving: boolean;
  features: MemoryFeaturesSettings;
  featuresSaving: boolean;
  onSaveWorkspace: (updates: Partial<WorkspaceMemorySettings>) => void;
  onSaveFeatures: (updates: Partial<MemoryFeaturesSettings>) => void;
}) {
  const budget =
    props.features.memoryCompressionDailyTokenBudget ??
    props.stats?.compressionDailyTokenBudget ??
    null;
  return (
    <>
      <SettingsRow
        label="AI memory compression (this workspace)"
        hint="Summarize long memories and group related ones with your model."
        below={
          <>
            <p className="settings-form-hint">{compressionCostNotice(budget)}</p>
            {typeof props.stats?.compressionTokensLast24h === "number" && (
              <p className="settings-form-hint">
                Used in the last 24 hours: {props.stats.compressionTokensLast24h.toLocaleString()}{" "}
                tokens.
              </p>
            )}
          </>
        }
      >
        <SettingsSwitch
          label="AI memory compression"
          checked={props.settings?.compressionEnabled === true}
          onChange={(on) => props.onSaveWorkspace({ compressionEnabled: on })}
          disabled={props.saving || !props.settings}
        />
      </SettingsRow>
      <SettingsRow
        label="Daily compression budget (all workspaces)"
        htmlFor="memory-compression-budget"
        hint="Tokens per day; saved when you leave the field."
      >
        <CommitNumberField
          id="memory-compression-budget"
          value={budget}
          min={1000}
          max={1_000_000}
          step={1000}
          disabled={props.featuresSaving || !hasHostMethod("saveMemoryFeaturesSettings")}
          parse={parseCompressionBudget}
          onCommit={(value) => props.onSaveFeatures({ memoryCompressionDailyTokenBudget: value })}
        />
      </SettingsRow>
      <SettingsRow
        label="Storage cap in MB (this workspace)"
        htmlFor="memory-storage-cap"
        hint="Text, summaries, embeddings and metadata; the oldest memories go past it."
      >
        <CommitNumberField
          id="memory-storage-cap"
          value={props.settings?.maxStorageMb ?? null}
          min={10}
          max={5000}
          step={10}
          disabled={props.saving}
          parse={parseStorageCapMb}
          onCommit={(value) => props.onSaveWorkspace({ maxStorageMb: value })}
        />
      </SettingsRow>
    </>
  );
}

export interface MemorySettingsTabProps {
  /** The workspace selected in the Memory Hub. */
  workspace: Workspace | null;
  features: MemoryFeaturesSettings;
  featuresSaving: boolean;
  /** Merge and save global memory feature settings. */
  onSaveFeatures: (updates: Partial<MemoryFeaturesSettings>) => Promise<void>;
  /** The stored feature settings after the memory folder saved them. */
  onFeaturesSaved: (settings: MemoryFeaturesSettings) => void;
  canDelete: boolean;
  onSettingsChanged?: () => void;
  onOpenSettingsTab?: (tab: MemorySettingsLinkTab) => void;
}

/**
 * The Memory Hub "Settings" tab: this workspace, the memory folder, import, connections,
 * proactive features, and everything else under a collapsed Advanced.
 */
export function MemorySettingsTab(props: MemorySettingsTabProps) {
  const { workspace, features } = props;
  const workspaceId = workspace?.id ?? "";
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [layerRefresh, setLayerRefresh] = useState(0);
  const [configsLoaded, setConfigsLoaded] = useState(false);
  const [awarenessConfig, setAwarenessConfig] = useState<AwarenessConfig | null>(null);
  const [awarenessSaving, setAwarenessSaving] = useState(false);
  const [autonomyConfig, setAutonomyConfig] = useState<AutonomyConfig | null>(null);
  const [autonomySaving, setAutonomySaving] = useState(false);

  const showError = useCallback((message: string) => {
    setActionNotice(null);
    setActionError(message);
  }, []);
  const showNotice = useCallback((message: string) => {
    setActionError(null);
    setActionNotice(message);
  }, []);

  useEffect(() => {
    setActionError(null);
    setActionNotice(null);
  }, [workspaceId]);

  const memory = useWorkspaceMemorySettings(workspaceId, {
    onError: showError,
    onSettingsChanged: props.onSettingsChanged,
  });
  const repoAvailable = hasHostMethods(...MEMORY_REPO_METHODS);
  const repo = useMemoryRepoController({
    features,
    onFeaturesSaved: props.onFeaturesSaved,
    available: repoAvailable,
  });
  const awarenessAvailable = hasHostMethod("getAwarenessConfig");
  const autonomyAvailable = hasHostMethod("getAutonomyConfig");

  useEffect(() => {
    let cancelled = false;
    const load = async <T,>(available: boolean, read: () => Promise<T>, what: string) => {
      if (!available) return null;
      try {
        return await read();
      } catch (error) {
        if (!cancelled) showError(errorText(error, `Failed to load ${what}.`));
        return null;
      }
    };
    void Promise.all([
      load(awarenessAvailable, () => window.electronAPI.getAwarenessConfig(), "awareness settings"),
      load(
        autonomyAvailable,
        () => window.electronAPI.getAutonomyConfig(),
        "chief of staff settings",
      ),
    ]).then(([awareness, autonomy]) => {
      if (cancelled) return;
      setAwarenessConfig(awareness);
      setAutonomyConfig(autonomy);
      setConfigsLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [awarenessAvailable, autonomyAvailable, showError]);

  const saveAwareness = async (next: AwarenessConfig) => {
    try {
      setAwarenessSaving(true);
      let request: Omit<Partial<AwarenessConfig>, "sources"> & {
        sources?: Partial<Record<AwarenessSource, Partial<SourcePolicy>>>;
      } = next;
      // The browser host takes only the fields that changed.
      if (isBrowserHost() && awarenessConfig) {
        request = {};
        if (next.privateModeEnabled !== awarenessConfig.privateModeEnabled)
          request.privateModeEnabled = next.privateModeEnabled;
        if (next.defaultTtlMinutes !== awarenessConfig.defaultTtlMinutes)
          request.defaultTtlMinutes = next.defaultTtlMinutes;
        const sourceChanges: Partial<Record<AwarenessSource, Partial<SourcePolicy>>> = {};
        for (const source of Object.keys(next.sources) as AwarenessSource[]) {
          const changed = Object.fromEntries(
            Object.entries(next.sources[source]).filter(
              ([key, value]) =>
                value !== awarenessConfig.sources[source][key as keyof SourcePolicy],
            ),
          ) as Partial<SourcePolicy>;
          if (Object.keys(changed).length) sourceChanges[source] = changed;
        }
        if (Object.keys(sourceChanges).length) request.sources = sourceChanges;
      }
      setAwarenessConfig(await window.electronAPI.saveAwarenessConfig(request));
    } catch (error) {
      showError(errorText(error, "Failed to save awareness config."));
    } finally {
      setAwarenessSaving(false);
    }
  };

  const updateAwarenessSource = (source: AwarenessSource, updates: Partial<SourcePolicy>) => {
    if (!awarenessConfig) return;
    void saveAwareness({
      ...awarenessConfig,
      sources: {
        ...awarenessConfig.sources,
        [source]: { ...awarenessConfig.sources[source], ...updates },
      },
    });
  };

  const saveAutonomy = async (next: AutonomyConfig) => {
    const previous = autonomyConfig;
    setAutonomyConfig(next);
    try {
      setAutonomySaving(true);
      setAutonomyConfig(await window.electronAPI.saveAutonomyConfig(next));
    } catch (error) {
      setAutonomyConfig(previous);
      showError(errorText(error, "Failed to save chief of staff settings."));
    } finally {
      setAutonomySaving(false);
    }
  };

  const saveFeatures = (updates: Partial<MemoryFeaturesSettings>) =>
    void props
      .onSaveFeatures(updates)
      .catch((error: unknown) =>
        showError(errorText(error, "Failed to save memory feature settings.")),
      );

  const workspaceScope = scopeCaption(
    workspace ? { kind: "workspace", name: workspace.name } : { kind: "all" },
  );
  const allScope = scopeCaption({ kind: "all" });
  const memoryInUse = memory.settings ? isMemoryInUse(memory.settings) : false;
  const sessionOn = isSessionRecoveryOn(features);
  const pendingBrowserFeatures = BROWSER_PENDING_FEATURES.filter(
    ([method]) => !hasHostMethod(method),
  ).map(([, label]) => label);

  const featureSwitch = (
    key:
      | "heartbeatMaintenanceEnabled"
      | "contextPackInjectionEnabled"
      | "wakeUpLayersEnabled"
      | "temporalKnowledgeEnabled"
      | "structuredObservationsEnabled",
    label: string,
  ) => (
    <SettingsSwitch
      label={label}
      checked={
        key === "heartbeatMaintenanceEnabled" || key === "contextPackInjectionEnabled"
          ? features[key] === true
          : features[key] !== false
      }
      onChange={(on) => saveFeatures({ [key]: on })}
      disabled={props.featuresSaving}
    />
  );

  return (
    <div className="memory-settings">
      {isBrowserHost() && (
        <p className="settings-form-hint">
          Workspace memory, text imports, profile facts and the observation inspector are connected
          to the host.
          {pendingBrowserFeatures.length > 0
            ? ` Still in progress for browser access: ${pendingBrowserFeatures.join(", ")}.`
            : ""}
        </p>
      )}
      {actionNotice && (
        <div role="status" className="settings-feedback success">
          {actionNotice}
        </div>
      )}
      {actionError && (
        <div role="alert" className="settings-feedback error memory-settings-error">
          <span>{actionError}</span>
          <button
            type="button"
            className="settings-button small"
            onClick={() => setActionError(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      <SettingsSection id="workspace" title="This workspace" scope={workspaceScope}>
        {workspace ? (
          <WorkspaceMemorySection
            settings={memory.settings}
            loadError={memory.loadError}
            saving={memory.saving}
            clearing={memory.clearing}
            clearSummary={memory.clearSummary}
            canDelete={props.canDelete}
            onSave={(updates) => void memory.save(updates)}
            onClear={() => void memory.clear()}
            onRetry={memory.reload}
          />
        ) : (
          <div className="settings-empty">Select a workspace above.</div>
        )}
      </SettingsSection>

      {repoAvailable && (
        <SettingsSection id="memory-folder" title="Memory folder" scope={allScope}>
          <MemoryRepoCard
            repo={repo}
            backgroundUpkeepOn={features.heartbeatMaintenanceEnabled !== false}
            workspaceId={workspaceId || null}
          />
        </SettingsSection>
      )}

      {workspace && (
        <SettingsSection id="import" title="Import" scope={workspaceScope}>
          <MemoryImportSection
            key={workspace.id}
            workspaceId={workspace.id}
            memoryInUse={memoryInUse}
            repo={repoAvailable ? repo : null}
          />
        </SettingsSection>
      )}

      <SettingsSection id="connections" title="Connections" scope={allScope}>
        {hasHostMethods(...SUPERMEMORY_METHODS) && <SupermemoryConnection onError={showError} />}
        <ChronicleConnectionRow onOpenSettingsTab={props.onOpenSettingsTab} />
      </SettingsSection>

      {(awarenessAvailable || autonomyAvailable) && (
        <SettingsSection id="proactive" title="Proactive" scope={allScope}>
          <ProactiveSection
            autonomyConfig={autonomyConfig}
            autonomySaving={autonomySaving}
            onSaveAutonomy={(next) => void saveAutonomy(next)}
            awarenessConfig={awarenessConfig}
            awarenessSaving={awarenessSaving}
            onSaveAwareness={(next) => void saveAwareness(next)}
            loaded={configsLoaded}
          />
        </SettingsSection>
      )}

      <details
        className="memory-settings-advanced"
        open={advancedOpen}
        onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
      >
        <summary>
          Advanced <span className="memory-settings-scope">scope shown per group</span>
        </summary>
        {advancedOpen && (
          <div className="memory-settings-advanced-body">
            <SettingsGroup id="background-upkeep" title="Background upkeep" scope={allScope}>
              <SettingsRow
                label="Background upkeep"
                hint="Run dreaming on schedule and close finished commitments."
              >
                {featureSwitch("heartbeatMaintenanceEnabled", "Background upkeep")}
              </SettingsRow>
            </SettingsGroup>

            <SettingsGroup id="prompt" title="Prompt" scope={allScope}>
              <SettingsRow
                label="Workspace context pack"
                hint={
                  <>
                    Add redacted notes from <code>.cowork/</code> to agent context.
                  </>
                }
              >
                {featureSwitch("contextPackInjectionEnabled", "Workspace context pack")}
              </SettingsRow>
              <SettingsRow
                label="Wake-up layers"
                hint="Add the pinned profile (L0) and memory context (L1) to prompts; deep recall (L3) stays on demand."
                below={
                  features.wakeUpLayersEnabled !== false &&
                  workspace &&
                  hasHostMethod("getMemoryLayerPreview") ? (
                    <details className="memory-settings-details">
                      <summary>Preview for this workspace</summary>
                      <WakeUpLayersPreview
                        key={workspace.id}
                        workspaceId={workspace.id}
                        refreshKey={`${features.contextPackInjectionEnabled}:${layerRefresh}`}
                        onError={showError}
                      />
                    </details>
                  ) : null
                }
              >
                {featureSwitch("wakeUpLayersEnabled", "Wake-up layers")}
              </SettingsRow>
              <SettingsRow
                label="Temporal knowledge"
                hint="Track when facts were true, so stale ones leave current context."
              >
                {featureSwitch("temporalKnowledgeEnabled", "Temporal knowledge")}
              </SettingsRow>
              <SettingsRow
                label="Structured observations"
                hint="Keep inspectable metadata next to each memory."
              >
                {featureSwitch("structuredObservationsEnabled", "Structured observations")}
              </SettingsRow>
            </SettingsGroup>

            <SettingsGroup id="session-recovery" title="Session recovery" scope={allScope}>
              <SettingsRow
                label="Session recovery"
                hint="Keep compacted task context with source links that context_recall can expand."
              >
                <SettingsSwitch
                  label="Session recovery"
                  checked={sessionOn}
                  onChange={(on) => saveFeatures(sessionRecoveryPatch(on))}
                  disabled={props.featuresSaving}
                />
              </SettingsRow>
              <SettingsRow
                label="Checkpoint capture"
                hint="Save summaries and evidence at snapshots and task ends. Stays on while session recovery is on."
              >
                <SettingsSwitch
                  label="Checkpoint capture"
                  checked={sessionOn || features.checkpointCaptureEnabled !== false}
                  onChange={(on) => saveFeatures({ checkpointCaptureEnabled: on })}
                  disabled={props.featuresSaving || sessionOn}
                  title={sessionOn ? "Stays on while session recovery is on." : undefined}
                />
              </SettingsRow>
            </SettingsGroup>

            <SettingsGroup id="cost-and-storage" title="Cost and storage">
              <CostAndStorageRows
                settings={memory.settings}
                stats={memory.stats}
                saving={memory.saving}
                features={features}
                featuresSaving={props.featuresSaving}
                onSaveWorkspace={(updates) => void memory.save(updates)}
                onSaveFeatures={saveFeatures}
              />
            </SettingsGroup>

            {repoAvailable && (
              <SettingsGroup id="memory-folder" title="Memory folder" scope={allScope}>
                <MemoryRepoLocation repo={repo} />
              </SettingsGroup>
            )}

            {workspace && (
              <SettingsGroup id="inspector" title="Inspector" scope={workspaceScope}>
                <MemoryInspectorPanel
                  key={workspace.id}
                  workspaceId={workspace.id}
                  canDelete={props.canDelete}
                  onError={showError}
                  onNotice={showNotice}
                  onPromoted={() => setLayerRefresh((value) => value + 1)}
                />
              </SettingsGroup>
            )}

            {workspace && (awarenessConfig || autonomyConfig) && (
              <SettingsGroup
                id="awareness"
                title="Awareness and chief of staff details"
                scope={workspaceScope}
              >
                <AwarenessDetailsPanel
                  key={workspace.id}
                  workspaceId={workspace.id}
                  awarenessConfig={awarenessConfig}
                  awarenessSaving={awarenessSaving}
                  onUpdateAwarenessSource={updateAwarenessSource}
                  autonomyConfig={autonomyConfig}
                  autonomySaving={autonomySaving}
                  onSaveAutonomy={(next) => void saveAutonomy(next)}
                  onError={showError}
                />
              </SettingsGroup>
            )}

            {workspace && hasHostMethod("getWorkspaceKitStatus") && (
              <SettingsGroup id="workspace-kit" title="Workspace kit" scope={workspaceScope}>
                <WorkspaceKitPanel key={workspace.id} workspace={workspace} onError={showError} />
              </SettingsGroup>
            )}
          </div>
        )}
      </details>
    </div>
  );
}
