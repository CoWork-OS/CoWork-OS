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

function formatOutcome(value?: string): string {
  return value ? value.replace(/_/g, " ") : "none";
}

function isUsefulOutcome(value?: string): boolean {
  return value === "dispatch" || value === "notify" || value === "suggest";
}

function formatPercent(value?: number): string {
  if (typeof value !== "number") return "n/a";
  return `${Math.round(value * 100)}%`;
}

function runImpactLabel(run?: SubconsciousRun): string {
  if (!run) return "No runs yet";
  if (run.dispatchStatus === "dispatched") return "Created follow-up work";
  if (run.dispatchStatus === "completed") return "Delivered a visible outcome";
  if (run.permissionDecision === "escalated") return "Waiting for your input";
  if (run.outcome === "sleep") return "Correctly stayed quiet";
  if (run.outcome === "failed") return "Needs attention";
  if (isUsefulOutcome(run.outcome)) return "Produced a recommendation";
  return "Recorded context only";
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
  const valueLedger = useMemo(() => {
    const recentCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentTargets = targets.filter((target) => (target.lastRunAt || target.lastActionAt || 0) >= recentCutoff);
    const dispatched = recentTargets.filter((target) => target.lastDispatchStatus === "dispatched").length;
    const suggested = recentTargets.filter((target) => target.lastMeaningfulOutcome === "suggest").length;
    const quiet = recentTargets.filter((target) => target.lastMeaningfulOutcome === "sleep").length;
    const attention = targets.filter((target) => target.health === "blocked" || target.lastMeaningfulOutcome === "defer").length;
    return {
      dispatched,
      suggested,
      quiet,
      attention,
      useful: dispatched + suggested,
    };
  }, [targets]);
  const selectedValue = useMemo(() => {
    const latestRun = detail?.recentRuns[0];
    const dispatch = detail?.dispatchHistory[0];
    const topEvidence = detail?.latestEvidence.slice(0, 3).map((item) => item.summary) || [];
    return {
      latestRun,
      dispatch,
      topEvidence,
      impact: runImpactLabel(latestRun),
      confidence: formatPercent(latestRun?.confidence),
      evidenceFreshness: formatPercent(latestRun?.evidenceFreshness),
    };
  }, [detail]);

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
      setMessage("Workflow Intelligence settings saved.");
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
      "Delete workflow intelligence history, hypotheses, critiques, decisions, backlog, and dispatch records?",
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
      setMessage(`Reset workflow intelligence history. Removed ${total} record(s).`);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <div className="sc-loading">Loading workflow intelligence settings...</div>;
  }

  return (
    <div className="sc-panel">
      {/* Header */}
      <div>
        <div className="sc-header">
          <h2 className="sc-title">Workflow Intelligence</h2>
        </div>
        <p className="sc-subtitle">
          Memory, heartbeat, and reflection working together to surface useful next actions across workflows.
        </p>
      </div>

      {message ? <div className="sc-message">{message}</div> : null}

      {/* Status cards */}
      <div className="sc-status-row">
        <div className="sc-status-card">
          <div className="sc-status-label">Workflow Intelligence</div>
          <div className="sc-status-value">{brain?.status || "idle"}</div>
          <div className="sc-status-meta">
            Triggered by heartbeat | {settings.autonomyMode.replace(/_/g, " ")}
          </div>
        </div>
        <div className="sc-status-card">
          <div className="sc-status-label">Targets</div>
          <div className="sc-status-value">{brain?.targetCount || targets.length}</div>
          <div className="sc-status-meta">Active runs: {brain?.activeRunCount || 0}</div>
        </div>
        <div className="sc-status-card">
          <div className="sc-status-label">Latest Run / Reflection</div>
          <div className="sc-status-value" style={{ fontSize: 16 }}>{formatTimestamp(brain?.lastRunAt)}</div>
          <div className="sc-status-meta">Reflection: {formatTimestamp(brain?.lastDreamAt)}</div>
        </div>
      </div>

      <div>
        <div className="sc-card-title">What Changed This Week</div>
        <div className="sc-status-row">
          <div className="sc-status-card">
            <div className="sc-status-label">Useful Outputs</div>
            <div className="sc-status-value">{valueLedger.useful}</div>
            <div className="sc-status-meta">
              {valueLedger.dispatched} task(s), {valueLedger.suggested} suggestion(s)
            </div>
          </div>
          <div className="sc-status-card">
            <div className="sc-status-label">Noise Avoided</div>
            <div className="sc-status-value">{valueLedger.quiet}</div>
            <div className="sc-status-meta">targets intentionally slept</div>
          </div>
          <div className="sc-status-card">
            <div className="sc-status-label">Needs Attention</div>
            <div className="sc-status-value">{valueLedger.attention}</div>
            <div className="sc-status-meta">blocked or waiting targets</div>
          </div>
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
            <span>Enable Workflow Intelligence</span>
          </label>
          <label className="sc-checkbox">
            <input
              type="checkbox"
              checked={settings.autoRun}
              disabled={busy}
              onChange={(event) => void saveSettings({ autoRun: event.target.checked })}
            />
            <span>Heartbeat-triggered reflection</span>
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
            <span>Auto-create after trusted patterns</span>
          </label>
          <label className="sc-checkbox">
            <input
              type="checkbox"
              checked={settings.journalingEnabled}
              disabled={busy}
              onChange={(event) => void saveSettings({ journalingEnabled: event.target.checked })}
            />
            <span>Daily journaling</span>
          </label>
          <label className="sc-checkbox">
            <input
              type="checkbox"
              checked={settings.dreamsEnabled}
              disabled={busy}
              onChange={(event) => void saveSettings({ dreamsEnabled: event.target.checked })}
            />
            <span>Reflection distillation</span>
          </label>
          <label className="sc-checkbox">
            <input
              type="checkbox"
              checked={settings.catchUpOnRestart}
              disabled={busy}
              onChange={(event) => void saveSettings({ catchUpOnRestart: event.target.checked })}
            />
            <span>Catch up on restart through heartbeat</span>
          </label>
          <label className="sc-input-group">
            <span className="sc-input-label">Heartbeat review window (minutes)</span>
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
            <span className="sc-input-label">Synthesis cadence (hours)</span>
            <input
              type="number"
              min={1}
              value={settings.dreamCadenceHours}
              disabled={busy}
              onChange={(event) =>
                setSettings((current) => ({ ...current, dreamCadenceHours: Number(event.target.value || 24) }))
              }
              onBlur={() => void saveSettings({ dreamCadenceHours: settings.dreamCadenceHours })}
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
          <label className="sc-input-group">
            <span className="sc-input-label">Autonomy mode</span>
            <select
              value={settings.autonomyMode}
              disabled={busy}
              onChange={(event) => void saveSettings({ autonomyMode: event.target.value as SubconsciousSettings["autonomyMode"] })}
            >
              <option value="recommendation_first">recommendation first</option>
              <option value="balanced_autopilot">balanced autopilot</option>
              <option value="strong_autonomy">strong autonomy</option>
            </select>
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
        <div className="sc-target-kinds">
          <div className="sc-target-kinds-label">Durable target kinds</div>
          <div className="sc-target-kinds-row">
            {SUBCONSCIOUS_TARGET_KINDS.map((kind) => {
              const isActive = settings.durableTargetKinds.includes(kind);
              return (
                <label key={`durable-${kind}`} className={`sc-kind-chip${isActive ? " active" : ""}`}>
                  <input
                    type="checkbox"
                    checked={isActive}
                    disabled={busy}
                    onChange={(event) => {
                      const nextKinds = event.target.checked
                        ? [...new Set([...settings.durableTargetKinds, kind])]
                        : settings.durableTargetKinds.filter((entry) => entry !== kind);
                      void saveSettings({ durableTargetKinds: nextKinds });
                    }}
                  />
                  <span>{kind}</span>
                </label>
              );
            })}
          </div>
        </div>
        <div className="sc-target-kinds">
          <div className="sc-target-kinds-label">Notification intents</div>
          <div className="sc-target-kinds-row">
            {[
              ["inputNeeded", "input needed"],
              ["importantActionTaken", "important action"],
              ["completedWhileAway", "completed while away"],
            ].map(([key, label]) => (
              <label key={key} className="sc-kind-chip active">
                <input
                  type="checkbox"
                  checked={settings.notificationPolicy[key as keyof SubconsciousSettings["notificationPolicy"]] as boolean}
                  disabled={busy}
                  onChange={(event) =>
                    void saveSettings({
                      notificationPolicy: {
                        ...settings.notificationPolicy,
                        [key]: event.target.checked,
                      },
                    })
                  }
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Action buttons */}
      <div className="sc-actions">
        <button className="sc-btn primary" disabled={busy} onClick={() => void refresh()}>
          Refresh Evidence
        </button>
        <button className="sc-btn primary" disabled={busy} onClick={() => void runNow()}>
          Run Global Reflection
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
                  {target.target.kind} | {target.persistence} | backlog {target.backlogCount} | outcome {formatOutcome(target.lastMeaningfulOutcome)}
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
                    {detail.target.target.kind} | {detail.target.persistence} | health {detail.target.health} | last run {formatTimestamp(detail.target.lastRunAt)} | outcome {formatOutcome(detail.target.lastMeaningfulOutcome)}
                  </div>
                </div>
                <label className="sc-checkbox">
                  <input
                    type="checkbox"
                    checked={settings.trustedTargetKeys.includes(detail.target.key)}
                    disabled={busy}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...new Set([...settings.trustedTargetKeys, detail.target.key])]
                        : settings.trustedTargetKeys.filter((key) => key !== detail.target.key);
                      void saveSettings({ trustedTargetKeys: next });
                    }}
                  />
                  <span>Trusted for auto-create</span>
                </label>
                <div>
                  <div className="sc-detail-section-title">Benefit summary</div>
                  <div className="sc-detail-winner">
                    <div className="sc-detail-winner-text">
                      <Md text={`**${selectedValue.impact}**`} />
                    </div>
                    <div className="sc-detail-winner-rec">
                      Confidence {selectedValue.confidence} | Freshness {selectedValue.evidenceFreshness} | Dispatch{" "}
                      {selectedValue.dispatch?.status || "none"}
                    </div>
                    {selectedValue.topEvidence.length ? (
                      <ul className="sc-detail-list">
                        {selectedValue.topEvidence.map((item, index) => (
                          <li key={`${index}-${item}`}>
                            <Md text={item} />
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="sc-detail-empty">No actionable evidence currently selected.</div>
                    )}
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
                <div>
                  <div className="sc-detail-section-title">Operator Timeline</div>
                  {detail.journal.length ? (
                    <ul className="sc-detail-list">
                      {detail.journal.slice(0, 8).map((entry) => (
                        <li key={entry.id}>
                          <Md
                            text={`**${entry.kind}** · ${formatTimestamp(entry.createdAt)} · ${entry.summary}${entry.details ? ` — ${entry.details}` : ""}`}
                          />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="sc-detail-empty">No journal entries yet.</div>
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
              <div className="sc-card-title">Learning Candidates</div>
              {detail?.memory.length ? (
                <ul className="sc-detail-list">
                  {detail.memory.slice(0, 8).map((item) => (
                    <li key={item.id}>
                      <Md text={`**${item.bucket}**: ${item.summary}${item.stale ? " _(stale)_" : ""}`} />
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="sc-detail-empty">No learning candidates yet.</div>
              )}
            </div>
          </div>

          <div className="sc-bottom-grid">
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

            <div className="sc-card">
              <div className="sc-card-title">Reflections</div>
              {detail?.dreams.length ? (
                <ul className="sc-detail-list">
                  {detail.dreams.slice(0, 5).map((dream) => (
                    <li key={dream.id}>
                      <Md text={`**${formatTimestamp(dream.createdAt)}**: ${dream.digest.join(" | ")}`} />
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="sc-detail-empty">No reflection distillations yet.</div>
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
