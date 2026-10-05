import { useCallback, useEffect, useRef, useState } from "react";
import type { MemoryHealthReport } from "../../../shared/memory-health-types";
import { hasHostMethod } from "../../host/browser-capabilities";
import "./memory-knowledge.css";
import "./memory-health.css";
import { formatRelative } from "./memory-knowledge-model";
import {
  HEALTH_STATUS_LABELS,
  MEMORY_HEALTH_METHODS,
  errorMessage,
  formatHealthThreshold,
  formatHealthValue,
  healthStatusTone,
  type MemoryHealthApi,
} from "./memory-health-model";

export interface MemoryHealthViewProps {
  report: MemoryHealthReport | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

/** The Health tab's markup, without data loading (rendered directly in tests). */
export function MemoryHealthView(props: MemoryHealthViewProps) {
  const { report } = props;
  const warnings = report?.checks.filter((check) => check.status === "warn").length ?? 0;
  return (
    <div className="memory-knowledge memory-health">
      <p className="settings-form-hint">
        The same checks as <code>npm run qa:memory-health</code>, over this profile's whole memory
        database (every workspace). Counts only; no memory content is read out.
      </p>
      <div className="memory-health-toolbar">
        <button
          type="button"
          className="settings-button"
          disabled={props.loading}
          onClick={props.onRefresh}
        >
          {props.loading ? "Checking..." : "Refresh"}
        </button>
        {report && (
          <span className="memory-knowledge-count" role="status">
            {warnings === 0
              ? "All checks pass."
              : `${warnings} ${warnings === 1 ? "check needs" : "checks need"} attention.`}{" "}
            Checked {formatRelative(report.generatedAt)}.
          </span>
        )}
      </div>
      {props.error && (
        <div role="alert" className="memory-knowledge-error">
          {props.error}
        </div>
      )}
      {props.loading && !report ? <div className="settings-loading">Running checks...</div> : null}
      {report && (
        <table className="memory-health-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Check</th>
              <th className="memory-health-num">Value</th>
              <th>Threshold</th>
            </tr>
          </thead>
          <tbody>
            {report.checks.map((check) => (
              <tr key={check.id} data-check={check.id} data-status={check.status}>
                <td>
                  <span
                    className={`settings-badge settings-badge--${healthStatusTone(check.status)}`}
                  >
                    {HEALTH_STATUS_LABELS[check.status]}
                  </span>
                </td>
                <td>
                  <div className="memory-health-name">{check.label}</div>
                  {check.detail && <div className="memory-health-explain">{check.detail}</div>}
                </td>
                <td className="memory-health-num">{formatHealthValue(check)}</td>
                <td className="memory-health-threshold">{formatHealthThreshold(check)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function healthApi(): MemoryHealthApi {
  return window.electronAPI;
}

export function MemoryHealthTab({
  workspaceId,
  api = healthApi,
}: {
  workspaceId: string;
  api?: () => MemoryHealthApi;
}) {
  const [report, setReport] = useState<MemoryHealthReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const available = MEMORY_HEALTH_METHODS.every((method) => hasHostMethod(method));

  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const next = await api().getMemoryHealth({ workspaceId });
      if (current !== generation.current) return;
      setReport(next);
      setError(null);
    } catch (loadError) {
      if (current !== generation.current) return;
      setError(errorMessage(loadError, "Failed to run the memory health checks."));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [api, workspaceId]);

  useEffect(() => {
    if (!available) return;
    void load();
  }, [load, available]);

  if (!available) {
    return (
      <p className="settings-form-hint">Memory health is not connected to this browser host yet.</p>
    );
  }
  return (
    <MemoryHealthView
      report={report}
      loading={loading}
      error={error}
      onRefresh={() => void load()}
    />
  );
}
