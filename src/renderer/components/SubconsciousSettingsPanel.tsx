import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import type {
  SubconsciousBrainSummary,
  SubconsciousRun,
  SubconsciousSettings,
  SubconsciousTargetDetail,
  SubconsciousTargetSummary,
} from "../../shared/subconscious";
import { DEFAULT_SUBCONSCIOUS_SETTINGS, SUBCONSCIOUS_TARGET_KINDS } from "../../shared/subconscious";

function formatTimestamp(value?: number): string {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

function renderList(items: string[]): string {
  return items.length ? items.join(", ") : "None";
}

const mdPlugins = [remarkGfm, remarkBreaks];

function Md({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={mdPlugins} components={{ p: ({ children }) => <span>{children}</span> }}>
      {text}
    </ReactMarkdown>
  );
}

export function SubconsciousSettingsPanel(props?: {
  initialWorkspaceId?: string;
  onOpenTask?: (taskId: string) => void;
}) {
  const [settings, setSettings] = useState<SubconsciousSettings>(DEFAULT_SUBCONSCIOUS_SETTINGS);
  const [brain, setBrain] = useState<SubconsciousBrainSummary | null>(null);
  const [targets, setTargets] = useState<SubconsciousTargetSummary[]>([]);
  const [selectedTargetKey, setSelectedTargetKey] = useState("");
  const [detail, setDetail] = useState<SubconsciousTargetDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  const activeRuns = useMemo(
    () =>
      detail?.recentRuns.filter((run) =>
        [
          "collecting_evidence",
          "ideating",
          "critiquing",
          "synthesizing",
          "dispatching",
        ].includes(run.stage),
      ) || [],
    [detail],
  );

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!selectedTargetKey) return;
    void loadTargetDetail(selectedTargetKey);
  }, [selectedTargetKey]);

  const load = async () => {
    try {
      setLoading(true);
      const [nextSettings, nextBrain, nextTargets] = await Promise.all([
        window.electronAPI.getSubconsciousSettings().catch(() => DEFAULT_SUBCONSCIOUS_SETTINGS),
        window.electronAPI.getSubconsciousBrain().catch(() => null),
        window.electronAPI
          .listSubconsciousTargets(props?.initialWorkspaceId)
          .catch(() => [] as SubconsciousTargetSummary[]),
      ]);
      setSettings(nextSettings);
      setBrain(nextBrain);
      setTargets(nextTargets);
      const preferred = nextTargets.find((target) => target.key === selectedTargetKey)?.key || nextTargets[0]?.key || "";
      setSelectedTargetKey(preferred);
      if (preferred) {
        await loadTargetDetail(preferred);
      } else {
        setDetail(null);
      }
    } finally {
      setLoading(false);
    }
  };

  const loadTargetDetail = async (targetKey: string) => {
    const next = await window.electronAPI.getSubconsciousTargetDetail(targetKey);
    setDetail(next);
  };

  const saveSettings = async (updates: Partial<SubconsciousSettings>) => {
    const next: SubconsciousSettings = {
      ...settings,
      ...updates,
      dispatchDefaults: {
        ...settings.dispatchDefaults,
        ...(updates.dispatchDefaults || {}),
        defaultKinds: {
          ...settings.dispatchDefaults.defaultKinds,
          ...(updates.dispatchDefaults?.defaultKinds || {}),
        },
      },
      perExecutorPolicy: {
        ...settings.perExecutorPolicy,
        ...(updates.perExecutorPolicy || {}),
        codeChangeTask: {
          ...settings.perExecutorPolicy.codeChangeTask,
          ...(updates.perExecutorPolicy?.codeChangeTask || {}),
        },
      },
    };
    try {
      setBusy(true);
      const saved = await window.electronAPI.saveSubconsciousSettings(next);
      setSettings(saved);
      setMessage("Subconscious settings saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const runNow = async (targetKey?: string) => {
    try {
      setBusy(true);
      const run = await window.electronAPI.runSubconsciousNow(targetKey);
      setMessage(run ? `Run ${run.id} completed at stage ${run.stage}.` : "No eligible target was selected.");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    try {
      setBusy(true);
      const result = await window.electronAPI.refreshSubconsciousTargets();
      setMessage(`Refreshed ${result.targetCount} targets from ${result.evidenceCount} evidence signal(s).`);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const dismissTarget = async () => {
    if (!selectedTargetKey) return;
    try {
      setBusy(true);
      await window.electronAPI.dismissSubconsciousTarget(selectedTargetKey);
      setMessage("Target dismissed from the active queue.");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const resetHistory = async () => {
    const confirmed = window.confirm(
      "Delete subconscious target history, hypotheses, critiques, decisions, backlog, and dispatch records?",
    );
    if (!confirmed) return;
    try {
      setBusy(true);
      const result = await window.electronAPI.resetSubconsciousHistory();
      const total =
        result.deleted.targets +
        result.deleted.runs +
        result.deleted.hypotheses +
        result.deleted.critiques +
        result.deleted.decisions +
        result.deleted.backlogItems +
        result.deleted.dispatchRecords;
      setMessage(`Reset subconscious history. Removed ${total} record(s).`);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <div className="sc-loading">Loading subconscious settings...</div>;
  }

  return (
    <div className="sc-panel">
      {/* Header */}
      <div>
        <div className="sc-header">
          <h2 className="sc-title">Subconscious</h2>
        </div>
        <p className="sc-subtitle">
          Reflective automation for evidence, hypotheses, critique, winners, backlog, and dispatch across every workflow.
        </p>
      </div>

      {message ? <div className="sc-message">{message}</div> : null}

      {/* Status cards */}
      <div className="sc-status-row">
        <div className="sc-status-card">
          <div className="sc-status-label">Global Brain</div>
          <div className="sc-status-value">{brain?.status || "idle"}</div>
          <div className="sc-status-meta">Cadence: every {settings.cadenceMinutes} minute(s)</div>
        </div>
        <div className="sc-status-card">
          <div className="sc-status-label">Targets</div>
          <div className="sc-status-value">{brain?.targetCount || targets.length}</div>
          <div className="sc-status-meta">Active runs: {brain?.activeRunCount || 0}</div>
        </div>
        <div className="sc-status-card">
          <div className="sc-status-label">Latest Run</div>
          <div className="sc-status-value" style={{ fontSize: 16 }}>{formatTimestamp(brain?.lastRunAt)}</div>
          <div className="sc-status-meta">Target kinds: {renderList(settings.enabledTargetKinds)}</div>
        </div>
      </div>

      {/* Policy controls */}
      <div className="sc-card">
        <div className="sc-card-title">Policy Controls</div>
        <div className="sc-controls-grid">
          <label className="sc-checkbox">
            <input
              type="checkbox"
              checked={settings.enabled}
              disabled={busy}
              onChange={(event) => void saveSettings({ enabled: event.target.checked })}
            />
            <span>Enable Subconscious</span>
          </label>
          <label className="sc-checkbox">
            <input
              type="checkbox"
              checked={settings.autoRun}
              disabled={busy}
              onChange={(event) => void saveSettings({ autoRun: event.target.checked })}
            />
            <span>Auto-run on cadence</span>
          </label>
          <label className="sc-checkbox">
            <input
              type="checkbox"
              checked={settings.dispatchDefaults.autoDispatch}
              disabled={busy}
              onChange={(event) =>
                void saveSettings({
                  dispatchDefaults: {
                    ...settings.dispatchDefaults,
                    autoDispatch: event.target.checked,
                  },
                })
              }
            />
            <span>Auto-dispatch winners</span>
          </label>
          <label className="sc-input-group">
            <span className="sc-input-label">Cadence (minutes)</span>
            <input
              type="number"
              min={15}
              value={settings.cadenceMinutes}
              disabled={busy}
              onChange={(event) =>
                setSettings((current) => ({ ...current, cadenceMinutes: Number(event.target.value || 15) }))
              }
              onBlur={() => void saveSettings({ cadenceMinutes: settings.cadenceMinutes })}
            />
          </label>
          <label className="sc-input-group">
            <span className="sc-input-label">Hypotheses per run</span>
            <input
              type="number"
              min={3}
              max={5}
              value={settings.maxHypothesesPerRun}
              disabled={busy}
              onChange={(event) =>
                setSettings((current) => ({ ...current, maxHypothesesPerRun: Number(event.target.value || 3) }))
              }
              onBlur={() => void saveSettings({ maxHypothesesPerRun: settings.maxHypothesesPerRun })}
            />
          </label>
          <label className="sc-input-group">
            <span className="sc-input-label">Artifact retention (days)</span>
            <input
              type="number"
              min={1}
              value={settings.artifactRetentionDays}
              disabled={busy}
              onChange={(event) =>
                setSettings((current) => ({ ...current, artifactRetentionDays: Number(event.target.value || 1) }))
              }
              onBlur={() => void saveSettings({ artifactRetentionDays: settings.artifactRetentionDays })}
            />
          </label>
        </div>
        <div className="sc-target-kinds">
          <div className="sc-target-kinds-label">Enabled target kinds</div>
          <div className="sc-target-kinds-row">
            {SUBCONSCIOUS_TARGET_KINDS.map((kind) => {
              const isActive = settings.enabledTargetKinds.includes(kind);
              return (
                <label key={kind} className={`sc-kind-chip${isActive ? " active" : ""}`}>
                  <input
                    type="checkbox"
                    checked={isActive}
                    disabled={busy}
                    onChange={(event) => {
                      const nextKinds = event.target.checked
                        ? [...settings.enabledTargetKinds, kind]
                        : settings.enabledTargetKinds.filter((entry) => entry !== kind);
                      void saveSettings({
                        enabledTargetKinds: nextKinds.length ? nextKinds : [kind],
                      });
                    }}
                  />
                  <span>{kind}</span>
                </label>
              );
            })}
          </div>
        </div>
      </div>

      {/* Action buttons */}
      <div className="sc-actions">
        <button className="sc-btn primary" disabled={busy} onClick={() => void refresh()}>
          Refresh Evidence
        </button>
        <button className="sc-btn primary" disabled={busy} onClick={() => void runNow()}>
          Run Global Brain
        </button>
        <button
          className="sc-btn"
          disabled={busy || !selectedTargetKey}
          onClick={() => void runNow(selectedTargetKey)}
        >
          Run Selected Target
        </button>
        <button
          className="sc-btn"
          disabled={busy || !selectedTargetKey}
          onClick={() => void dismissTarget()}
        >
          Dismiss Target
        </button>
        <button className="sc-btn danger" disabled={busy} onClick={() => void resetHistory()}>
          Reset History
        </button>
      </div>

      {/* Targets + detail */}
      <div className="sc-body">
        {/* Left: target list */}
        <div className="sc-card">
          <div className="sc-card-title">Targets</div>
          <div className="sc-targets-list">
            {targets.map((target) => (
              <button
                key={target.key}
                type="button"
                onClick={() => setSelectedTargetKey(target.key)}
                className={`sc-target-btn${selectedTargetKey === target.key ? " selected" : ""}`}
              >
                <div className="sc-target-top">
                  <span className="sc-target-name">{target.target.label}</span>
                  <span className={`sc-target-health ${target.health}`}>
                    <span className="sc-health-dot" />
                    {target.health}
                  </span>
                </div>
                <div className="sc-target-meta">
                  {target.target.kind} | backlog {target.backlogCount} | winner {target.lastWinner || "none"}
                </div>
              </button>
            ))}
            {targets.length === 0 ? (
              <div className="sc-target-empty">No targets discovered yet.</div>
            ) : null}
          </div>
        </div>

        {/* Right: detail pane */}
        <div className="sc-detail-stack">
          <div className="sc-card">
            <div className="sc-card-title">Selected Target</div>
            {detail ? (
              <div className="sc-detail-stack">
                <div className="sc-detail-header">
                  <div className="sc-detail-name">{detail.target.target.label}</div>
                  <div className="sc-detail-meta">
                    {detail.target.target.kind} | health {detail.target.health} | last run {formatTimestamp(detail.target.lastRunAt)}
                  </div>
                </div>
                <div>
                  <div className="sc-detail-section-title">Latest evidence</div>
                  <ul className="sc-detail-list">
                    {detail.latestEvidence.slice(0, 5).map((item) => (
                      <li key={item.id}>
                        <Md text={item.summary + (item.details ? ` — ${item.details}` : "")} />
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <div className="sc-detail-section-title">Hypotheses</div>
                  <ul className="sc-detail-list">
                    {detail.latestHypotheses.map((item) => (
                      <li key={item.id}>
                        <Md text={`**${item.title}:** ${item.summary}`} />
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <div className="sc-detail-section-title">Critique</div>
                  <ul className="sc-detail-list">
                    {detail.latestCritiques.map((item) => (
                      <li key={item.id}>
                        <Md text={`**${item.verdict}:** ${item.objection}`} />
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <div className="sc-detail-section-title">Winner</div>
                  {detail.latestDecision ? (
                    <div className="sc-detail-winner">
                      <div className="sc-detail-winner-text"><Md text={detail.latestDecision.winnerSummary} /></div>
                      {detail.latestDecision.recommendation ? (
                        <div className="sc-detail-winner-rec"><Md text={detail.latestDecision.recommendation} /></div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="sc-detail-empty">No winner yet.</div>
                  )}
                </div>
              </div>
            ) : (
              <div className="sc-detail-empty">Select a target to inspect its reflective history.</div>
            )}
          </div>

          <div className="sc-bottom-grid">
            <div className="sc-card">
              <div className="sc-card-title">Namespaced Backlog</div>
              {detail?.backlog.length ? (
                <ul className="sc-detail-list">
                  {detail.backlog.slice(0, 8).map((item) => (
                    <li key={item.id}>
                      <Md text={`**${item.title}**: ${item.summary}`} />
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="sc-detail-empty">No backlog items.</div>
              )}
            </div>

            <div className="sc-card">
              <div className="sc-card-title">Dispatch History</div>
              {detail?.dispatchHistory.length ? (
                <ul className="sc-detail-list">
                  {detail.dispatchHistory.slice(0, 8).map((item) => (
                    <li key={item.id}>
                      <Md text={`**${item.kind}**: ${item.summary}`} />
                      {item.taskId && props?.onOpenTask ? (
                        <>
                          {" "}
                          <button
                            type="button"
                            onClick={() => props.onOpenTask?.(item.taskId!)}
                            className="sc-link-btn"
                          >
                            Open task
                          </button>
                        </>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="sc-detail-empty">No dispatches yet.</div>
              )}
            </div>
          </div>

          <div className="sc-card">
            <div className="sc-card-title">Active Runs</div>
            {activeRuns.length ? (
              <ul className="sc-detail-list">
                {activeRuns.map((run: SubconsciousRun) => (
                  <li key={run.id}>
                    {run.id} — {run.stage}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="sc-detail-empty">No active runs for this target.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
