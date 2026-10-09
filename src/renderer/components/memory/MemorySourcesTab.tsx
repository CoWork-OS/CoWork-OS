import { useCallback, useEffect, useRef, useState } from "react";
import type { MemorySourcesReport } from "../../../shared/memory-health-types";
import type { MemoryHubSource } from "../../../shared/memory-hub-types";
import { hasHostMethod } from "../../host/browser-capabilities";
import "./memory-knowledge.css";
import "./memory-health.css";
import { SOURCE_FILTERS } from "./MemoryKnowledgeTab";
import { MemorySourcesLists } from "./MemorySourcesLists";
import { SOURCE_LABELS } from "./memory-knowledge-model";
import {
  MEMORY_SOURCES_METHODS,
  ORIGIN_LABELS,
  SOURCE_EXPLANATIONS,
  errorMessage,
  storeLabel,
  type MemoryHealthApi,
} from "./memory-health-model";

const FILTERABLE = new Set(SOURCE_FILTERS.map((entry) => entry.value).filter(Boolean));

function CountCells({ row }: { row: { workspace: number; global: number; contacts: number } }) {
  return (
    <>
      <td className="memory-health-num">{row.workspace.toLocaleString()}</td>
      <td className="memory-health-num">{row.global.toLocaleString()}</td>
      <td className="memory-health-num">{row.contacts.toLocaleString()}</td>
    </>
  );
}

function KeyCountList({
  rows,
  label,
  empty,
}: {
  rows: Array<{ key: string; count: number }>;
  label: (key: string) => string;
  empty: string;
}) {
  if (rows.length === 0) return <div className="settings-empty">{empty}</div>;
  return (
    <ul className="memory-health-pills">
      {rows.map((row) => (
        <li key={row.key}>
          {label(row.key)} <span className="memory-knowledge-count">{row.count}</span>
        </li>
      ))}
    </ul>
  );
}

export interface MemorySourcesViewProps {
  report: MemorySourcesReport | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  /** Open "What CoWork knows" filtered to one source; absent when the tab is unavailable. */
  onShowSource?: (source: MemoryHubSource) => void;
}

/** The Sources tab's markup, without data loading (rendered directly in tests). */
export function MemorySourcesView(props: MemorySourcesViewProps) {
  const { report } = props;
  return (
    <div className="memory-knowledge memory-health">
      <p className="settings-form-hint">
        Where CoWork's memory of this workspace comes from. Facts are what CoWork knows about you
        and the workspace; the archive keeps task history, notes, imports and screen context. Counts
        only.
      </p>
      <div className="memory-health-toolbar">
        <button
          type="button"
          className="settings-button"
          disabled={props.loading}
          onClick={props.onRefresh}
        >
          {props.loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>
      {props.error && (
        <div role="alert" className="memory-knowledge-error">
          {props.error}
        </div>
      )}
      {props.loading && !report ? <div className="settings-loading">Loading sources...</div> : null}
      {report && (
        <>
          <section className="memory-knowledge-group" data-group="facts-by-source">
            <h4>
              Facts by source <span className="memory-knowledge-count">{report.facts.total}</span>
            </h4>
            {report.facts.bySource.length === 0 ? (
              <div className="settings-empty">No facts yet.</div>
            ) : (
              <table className="memory-health-table">
                <thead>
                  <tr>
                    <th>Source</th>
                    <th className="memory-health-num">This workspace</th>
                    <th className="memory-health-num">Global</th>
                    <th className="memory-health-num">Contacts</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {report.facts.bySource.map((row) => (
                    <tr key={row.key} data-source={row.key}>
                      <td>
                        <div className="memory-health-name">
                          {SOURCE_LABELS[row.key] ?? row.key}
                        </div>
                        <div className="memory-health-explain">
                          {SOURCE_EXPLANATIONS[row.key] ?? ""}
                        </div>
                      </td>
                      <CountCells row={row} />
                      <td>
                        {props.onShowSource && FILTERABLE.has(row.key) && (
                          <button
                            type="button"
                            className="memory-inline-btn"
                            onClick={() => props.onShowSource?.(row.key)}
                          >
                            Show
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="memory-knowledge-group" data-group="facts-by-store">
            <h4>Facts by producer</h4>
            {report.facts.byStore.length === 0 ? (
              <div className="settings-empty">No facts yet.</div>
            ) : (
              <table className="memory-health-table">
                <thead>
                  <tr>
                    <th>Written by</th>
                    <th className="memory-health-num">This workspace</th>
                    <th className="memory-health-num">Global</th>
                    <th className="memory-health-num">Contacts</th>
                  </tr>
                </thead>
                <tbody>
                  {report.facts.byStore.map((row) => {
                    const store = storeLabel(row.key);
                    return (
                      <tr key={row.key} data-store={row.key}>
                        <td>
                          <div className="memory-health-name">{store.label}</div>
                          {store.explanation && (
                            <div className="memory-health-explain">{store.explanation}</div>
                          )}
                        </td>
                        <CountCells row={row} />
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>

          <section className="memory-knowledge-group" data-group="archive">
            <h4>
              Archive <span className="memory-knowledge-count">{report.archive.total}</span>
            </h4>
            <p className="settings-form-hint">
              Task history of this workspace ({report.archive.private} private). By capture origin:
            </p>
            <KeyCountList
              rows={report.archive.byOrigin}
              label={(key) => ORIGIN_LABELS[key] ?? key}
              empty="The archive is empty."
            />
            <p className="settings-form-hint">By type:</p>
            <KeyCountList
              rows={report.archive.byType}
              label={(key) => key.replace(/_/g, " ")}
              empty="The archive is empty."
            />
          </section>

          <section className="memory-knowledge-group" data-group="connected">
            <h4>Imports and connected sources</h4>
            <dl className="memory-health-facts">
              <dt>Imports (ChatGPT, pasted text)</dt>
              <dd>
                {report.imports.archiveRows} archive entries, {report.imports.facts} facts
              </dd>
              <dt>Chronicle (screen context)</dt>
              <dd>
                {report.chronicle.enabled ? "On" : "Off"}, {report.chronicle.archiveRows} private
                archive entries
              </dd>
              <dt>Knowledge graph</dt>
              <dd>
                {report.knowledgeGraph.entities} entities, {report.knowledgeGraph.edges}{" "}
                relationships, {report.knowledgeGraph.observations} observations
              </dd>
            </dl>
            {report.knowledgeGraph.byType.length > 0 && (
              <KeyCountList rows={report.knowledgeGraph.byType} label={(key) => key} empty="" />
            )}
          </section>
        </>
      )}
    </div>
  );
}

function healthApi(): MemoryHealthApi {
  return window.electronAPI;
}

export function MemorySourcesTab({
  workspaceId,
  api = healthApi,
  onShowSource,
  canDelete = true,
}: {
  workspaceId: string;
  api?: () => MemoryHealthApi;
  onShowSource?: (source: MemoryHubSource) => void;
  /** The workspace permits deleting memory (imported memories). */
  canDelete?: boolean;
}) {
  const [report, setReport] = useState<MemorySourcesReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const available = MEMORY_SOURCES_METHODS.every((method) => hasHostMethod(method));

  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const next = await api().getMemorySources({ workspaceId });
      if (current !== generation.current) return;
      setReport(next);
      setError(null);
    } catch (loadError) {
      if (current !== generation.current) return;
      setError(errorMessage(loadError, "Failed to load memory sources."));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [api, workspaceId]);

  useEffect(() => {
    if (!available) return;
    void load();
  }, [load, available]);

  return (
    <>
      {available ? (
        <MemorySourcesView
          report={report}
          loading={loading}
          error={error}
          onRefresh={() => void load()}
          onShowSource={onShowSource}
        />
      ) : (
        <p className="settings-form-hint">
          Memory sources are not connected to this browser host yet.
        </p>
      )}
      <MemorySourcesLists workspaceId={workspaceId} canDelete={canDelete} />
    </>
  );
}
