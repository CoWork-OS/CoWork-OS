import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AwarenessBelief,
  AwarenessConfig,
  AwarenessSource,
  AwarenessSummary,
} from "../../../shared/types";
import { hasHostMethods, isBrowserHost } from "../../host/browser-capabilities";
import { parseAwarenessTtlMinutes } from "./memory-settings-model";
import { SettingsBadge } from "./SettingsRow";

type SourcePolicy = AwarenessConfig["sources"][AwarenessSource];

function formatConfidence(confidence?: number): string {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return "n/a";
  return `${Math.round(confidence * 100)}%`;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** A source's TTL field: edited freely, saved on blur or Enter. */
function TtlField(props: {
  source: string;
  value: number;
  disabled: boolean;
  onSave: (minutes: number) => void;
}) {
  const [draft, setDraft] = useState(String(props.value));
  const [saved, setSaved] = useState(props.value);
  if (saved !== props.value) {
    setSaved(props.value);
    setDraft(String(props.value));
  }
  const commit = () => {
    const minutes = parseAwarenessTtlMinutes(draft);
    if (minutes === null || minutes === props.value) {
      setDraft(String(props.value));
      return;
    }
    setDraft(String(minutes));
    props.onSave(minutes);
  };
  return (
    <input
      className="settings-input"
      type="number"
      aria-label={`${props.source} TTL in minutes`}
      min={5}
      max={24 * 60}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }}
      disabled={props.disabled}
    />
  );
}

const POLICY_COLUMNS: ReadonlyArray<{
  key: "enabled" | "allowPromotion" | "allowPromptInjection" | "allowHeartbeat";
  label: string;
}> = [
  { key: "enabled", label: "Enabled" },
  { key: "allowPromotion", label: "Promote to beliefs" },
  { key: "allowPromptInjection", label: "Inject into prompts" },
  { key: "allowHeartbeat", label: "Use for heartbeat" },
];

/**
 * Advanced → Awareness details: which local signals awareness may use
 * (all workspaces), this workspace's beliefs and summary.
 */
export function AwarenessDetailsPanel({
  workspaceId,
  awarenessConfig,
  awarenessSaving,
  onUpdateAwarenessSource,
  onError,
}: {
  workspaceId: string;
  awarenessConfig: AwarenessConfig | null;
  awarenessSaving: boolean;
  onUpdateAwarenessSource: (source: AwarenessSource, updates: Partial<SourcePolicy>) => void;
  onError: (message: string) => void;
}) {
  const [beliefs, setBeliefs] = useState<AwarenessBelief[]>([]);
  const [summary, setSummary] = useState<AwarenessSummary | null>(null);
  const alive = useRef(true);
  const report = useRef(onError);
  report.current = onError;
  const canReadAwareness = hasHostMethods("listAwarenessBeliefs", "getAwarenessSummary");

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refreshAwareness = useCallback(async () => {
    if (!canReadAwareness) return;
    try {
      const [nextBeliefs, nextSummary] = await Promise.all([
        window.electronAPI.listAwarenessBeliefs(workspaceId),
        window.electronAPI.getAwarenessSummary(workspaceId),
      ]);
      if (!alive.current) return;
      setBeliefs(nextBeliefs);
      setSummary(nextSummary);
    } catch (error) {
      if (alive.current) report.current(errorText(error, "Failed to load awareness state."));
    }
  }, [workspaceId, canReadAwareness]);

  const hasAwareness = awarenessConfig !== null;
  useEffect(() => {
    if (hasAwareness) void refreshAwareness();
  }, [hasAwareness, refreshAwareness]);

  const updateBelief = async (belief: AwarenessBelief, patch: Record<string, unknown>) => {
    try {
      await window.electronAPI.updateAwarenessBelief(belief.id, patch);
      await refreshAwareness();
    } catch (error) {
      if (alive.current) report.current(errorText(error, "Failed to update awareness belief."));
    }
  };

  const deleteBelief = async (beliefId: string) => {
    try {
      await window.electronAPI.deleteAwarenessBelief(beliefId);
      await refreshAwareness();
    } catch (error) {
      if (alive.current) report.current(errorText(error, "Failed to delete awareness belief."));
    }
  };

  return (
    <div className="awareness-details-panel">
      {awarenessConfig && (
        <>
          <p className="settings-form-hint">
            Which local signals CoWork may observe, promote into beliefs, add to prompts and use for
            heartbeats (all workspaces).
            {isBrowserHost()
              ? " These apply to your host; device signals are collected only while its collectors run."
              : ""}
          </p>
          <div className="awareness-grid">
            <div className="awareness-grid-header">
              <div>Source</div>
              <div>Enabled</div>
              <div>Promote</div>
              <div>Inject</div>
              <div>Heartbeat</div>
              <div>TTL (min)</div>
            </div>
            {(
              Object.entries(awarenessConfig.sources) as Array<[AwarenessSource, SourcePolicy]>
            ).map(([source, policy]) => (
              <div key={source} className="awareness-grid-row">
                <div className="memory-hub-section-title">{source}</div>
                {POLICY_COLUMNS.map((column) => (
                  <label key={column.key} className="settings-toggle" title={column.label}>
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label={`${source}: ${column.label}`}
                      checked={policy[column.key]}
                      onChange={(event) =>
                        onUpdateAwarenessSource(source, { [column.key]: event.target.checked })
                      }
                      disabled={awarenessSaving}
                    />
                    <span className="toggle-slider" />
                  </label>
                ))}
                <TtlField
                  source={source}
                  value={policy.ttlMinutes}
                  disabled={awarenessSaving}
                  onSave={(ttlMinutes) => onUpdateAwarenessSource(source, { ttlMinutes })}
                />
              </div>
            ))}
          </div>

          <div className="memory-settings-card-grid">
            <div className="memory-settings-card">
              <div className="memory-hub-section-title">What CoWork believes</div>
              <p className="settings-form-hint">
                Beliefs formed from conversations and local context in this workspace.
              </p>
              {beliefs.length === 0 ? (
                <div className="settings-empty">No beliefs yet for this workspace.</div>
              ) : (
                <div className="memory-hub-column">
                  {beliefs.slice(0, 12).map((belief) => (
                    <div key={belief.id} className="memory-settings-item">
                      <div className="memory-hub-row-center">
                        <div className="memory-hub-primary-label">{belief.subject}</div>
                        <SettingsBadge
                          tone={belief.promotionStatus === "confirmed" ? "success" : "neutral"}
                        >
                          {belief.promotionStatus}
                        </SettingsBadge>
                      </div>
                      <div className="memory-hub-text-block-primary">{belief.value}</div>
                      <div className="memory-hub-caption">
                        {belief.beliefType} · confidence {formatConfidence(belief.confidence)} ·
                        source {belief.source}
                      </div>
                      <div className="memory-hub-chip-row">
                        <button
                          type="button"
                          className="settings-button small"
                          onClick={() =>
                            void updateBelief(belief, {
                              promotionStatus: "confirmed",
                              confidence: 1,
                            })
                          }
                        >
                          Confirm
                        </button>
                        <button
                          type="button"
                          className="settings-button small"
                          onClick={() =>
                            void updateBelief(belief, {
                              confidence: Math.max(0.1, belief.confidence - 0.15),
                            })
                          }
                        >
                          Lower confidence
                        </button>
                        <button
                          type="button"
                          className="settings-button small"
                          onClick={() => void deleteBelief(belief.id)}
                        >
                          Forget
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="memory-settings-card">
              <div className="memory-hub-section-title">Current awareness</div>
              <p className="settings-form-hint">
                Focus, high-signal changes and due-soon items right now.
              </p>
              <div className="memory-hub-inline-primary">
                <strong>Current focus:</strong> {summary?.currentFocus || "Unknown"}
              </div>
              <div className="memory-hub-top-gap">
                <div className="memory-hub-primary-label">What matters now</div>
                {(summary?.whatMattersNow || []).slice(0, 5).map((item) => (
                  <div key={item.id} className="memory-hub-text-block">
                    <div className="memory-hub-text-primary">{item.title}</div>
                    {item.detail && (
                      <div className="memory-hub-inline-secondary-top">{item.detail}</div>
                    )}
                  </div>
                ))}
                {(summary?.whatMattersNow || []).length === 0 && (
                  <p className="settings-form-hint">No current high-signal awareness items.</p>
                )}
              </div>
              <div className="memory-hub-top-gap-md">
                <div className="memory-hub-primary-label">Due soon</div>
                {(summary?.dueSoon || []).slice(0, 5).map((item) => (
                  <div key={item.id} className="memory-hub-text-block">
                    <div className="memory-hub-text-primary">{item.title}</div>
                    {item.detail && (
                      <div className="memory-hub-inline-secondary-top">{item.detail}</div>
                    )}
                  </div>
                ))}
                {(summary?.dueSoon || []).length === 0 && (
                  <p className="settings-form-hint">No due-soon signals right now.</p>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
