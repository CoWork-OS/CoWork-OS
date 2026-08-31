import React, { useState, useEffect, useCallback } from "react";
import {
  Sun,
  CheckCircle,
  Clock,
  Brain,
  Lightbulb,
  AlertTriangle,
  Calendar,
  RefreshCw,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import type { Workspace } from "../../shared/types";

interface BriefingSection {
  type: string;
  title: string;
  items: BriefingItem[];
  enabled: boolean;
}

interface BriefingItem {
  label: string;
  detail?: string;
  status?: "success" | "warning" | "error" | "info" | "pending";
  meta?: Record<string, unknown>;
}

interface Briefing {
  id: string;
  workspaceId: string;
  generatedAt: number;
  sections: BriefingSection[];
}

const ALL_WORKSPACES_ID = "__all__";

const SECTION_ICONS: Record<string, React.ReactNode> = {
  task_summary: <CheckCircle size={14} />,
  memory_highlights: <Brain size={14} />,
  active_suggestions: <Lightbulb size={14} />,
  priority_review: <AlertTriangle size={14} />,
  upcoming_jobs: <Calendar size={14} />,
  open_loops: <Clock size={14} />,
  awareness_digest: <Sun size={14} />,
};

const STATUS_COLORS: Record<string, string> = {
  success: "#22c55e",
  warning: "#f59e0b",
  error: "#ef4444",
  info: "#3b82f6",
  pending: "#6b7280",
};

function StatusDot({ status }: { status?: string }) {
  const color = STATUS_COLORS[status || "info"] || STATUS_COLORS.info;
  return (
    <span
      style={{
        display: "inline-block",
        width: 6,
        height: 6,
        borderRadius: "50%",
        background: color,
        marginRight: 6,
        flexShrink: 0,
      }}
    />
  );
}

export const BriefingPanel: React.FC<{ workspaceId?: string }> = ({ workspaceId }) => {
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>(ALL_WORKSPACES_ID);
  const [workspacesLoading, setWorkspacesLoading] = useState(true);

  const loadWorkspaces = useCallback(async () => {
    try {
      setWorkspacesLoading(true);
      const loaded = await (window as Any).electronAPI.listWorkspaces();
      const nonTemp: Workspace[] = (loaded || []).filter(
        (workspace: Workspace) => !workspace.id.startsWith("__temp_workspace__"),
      );
      setWorkspaces(nonTemp);
      setSelectedWorkspaceId((prev) => {
        if (prev === ALL_WORKSPACES_ID) return ALL_WORKSPACES_ID;
        if (prev && nonTemp.some((workspace) => workspace.id === prev)) return prev;
        if (workspaceId && nonTemp.some((workspace) => workspace.id === workspaceId)) {
          return workspaceId;
        }
        return ALL_WORKSPACES_ID;
      });
    } catch {
      setWorkspaces([]);
    } finally {
      setWorkspacesLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  const effectiveWorkspaceId = selectedWorkspaceId;

  const loadBriefing = useCallback(async () => {
    if (!effectiveWorkspaceId) return;
    try {
      const latest = await (window as Any).electronAPI.getLatestBriefing(effectiveWorkspaceId);
      if (latest) {
        setBriefing(latest);
        // Auto-expand all sections
        setExpandedSections(new Set(latest.sections.map((s: BriefingSection) => s.type)));
      }
    } catch {
      // Not available yet
    }
  }, [effectiveWorkspaceId]);

  useEffect(() => {
    loadBriefing();
  }, [loadBriefing]);

  const generateBriefing = async () => {
    if (!effectiveWorkspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await (window as Any).electronAPI.generateDailyBriefing?.(
        effectiveWorkspaceId,
      );
      if (result) {
        setBriefing(result);
        setExpandedSections(new Set(result.sections.map((s: BriefingSection) => s.type)));
      }
    } catch (e: Any) {
      setError(e?.message || "Failed to generate briefing");
    } finally {
      setLoading(false);
    }
  };

  const toggleSection = (type: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header */}
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--color-border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Sun size={16} style={{ color: "var(--color-accent)" }} />
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--color-text)" }}>
            Daily Briefing
          </span>
        </div>
        <button
          onClick={generateBriefing}
          disabled={loading || !effectiveWorkspaceId}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "4px 10px",
            borderRadius: 4,
            border: "1px solid var(--color-border)",
            background: "var(--color-accent)",
            color: "hsl(0 0% 10%)",
            cursor: loading || !effectiveWorkspaceId ? "not-allowed" : "pointer",
            fontSize: 12,
            opacity: loading || !effectiveWorkspaceId ? 0.65 : 1,
          }}
        >
          <RefreshCw size={12} className={loading ? "spinning" : ""} />
          {loading ? "Generating..." : "Generate Now"}
        </button>
      </div>

      <div style={{ padding: "10px 16px 0", maxWidth: 320 }}>
        <label
          style={{
            display: "block",
            marginBottom: 4,
            fontSize: 11,
            color: "var(--color-text-secondary)",
          }}
        >
          Workspace
        </label>
        {workspacesLoading ? (
          <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
            Loading workspaces...
          </div>
        ) : workspaces.length > 0 ? (
          <select
            value={effectiveWorkspaceId}
            onChange={(event) => setSelectedWorkspaceId(event.target.value)}
            className="briefing-workspace-select"
            style={{
              width: "100%",
              padding: "6px 8px",
              borderRadius: 6,
              fontSize: 12,
            }}
          >
            <option value={ALL_WORKSPACES_ID}>All Workspaces</option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        ) : (
          <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
            No workspace found. Create or select a workspace first.
          </div>
        )}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
        {error && (
          <div
            style={{
              margin: "8px 16px",
              padding: "8px 12px",
              borderRadius: 6,
              background: "rgba(239, 68, 68, 0.1)",
              color: "#ef4444",
              fontSize: 12,
            }}
          >
            {error}
          </div>
        )}

        {!briefing && !loading && (
          <div
            style={{
              textAlign: "center",
              padding: 32,
              color: "var(--color-text-secondary)",
              fontSize: 13,
            }}
          >
            <Sun
              size={32}
              style={{ opacity: 0.4, marginBottom: 12, color: "var(--color-text-muted)" }}
            />
            <div style={{ color: "var(--color-text)" }}>No briefing yet</div>
            <div style={{ fontSize: 11, marginTop: 4, color: "var(--color-text-muted)" }}>
              {effectiveWorkspaceId
                ? 'Click "Generate Now" to create your daily briefing'
                : "Select a workspace to create a daily briefing"}
            </div>
          </div>
        )}

        {briefing && (
          <>
            <div
              style={{
                padding: "4px 16px 8px",
                fontSize: 11,
                color: "var(--color-text-muted)",
              }}
            >
              Generated {new Date(briefing.generatedAt).toLocaleString()}
            </div>

            {briefing.sections
              .filter((s) => s.enabled !== false)
              .map((section) => (
                <div key={section.type} style={{ marginBottom: 2 }}>
                  {/* Section header */}
                  <button
                    onClick={() => toggleSection(section.type)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      width: "100%",
                      padding: "6px 16px",
                      border: "none",
                      background: "none",
                      color: "var(--color-text)",
                      cursor: "pointer",
                      fontSize: 13,
                      fontWeight: 500,
                      textAlign: "left",
                    }}
                  >
                    {expandedSections.has(section.type) ? (
                      <ChevronDown size={12} />
                    ) : (
                      <ChevronRight size={12} />
                    )}
                    {SECTION_ICONS[section.type] || <Sun size={14} />}
                    {section.title}
                    <span
                      style={{
                        marginLeft: "auto",
                        fontSize: 11,
                        color: "var(--color-text-muted)",
                      }}
                    >
                      {section.items.length}
                    </span>
                  </button>

                  {/* Section items */}
                  {expandedSections.has(section.type) && (
                    <div style={{ padding: "0 16px 8px 36px" }}>
                      {section.items.length === 0 ? (
                        <div
                          style={{
                            fontSize: 12,
                            color: "var(--color-text-muted)",
                            fontStyle: "italic",
                          }}
                        >
                          Nothing to report
                        </div>
                      ) : (
                        section.items.map((item, idx) => (
                          <div
                            key={idx}
                            style={{
                              display: "flex",
                              alignItems: "flex-start",
                              gap: 4,
                              padding: "3px 0",
                              fontSize: 12,
                              color: "var(--color-text-secondary)",
                            }}
                          >
                            <StatusDot status={item.status} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ color: "var(--color-text)" }}>{item.label}</div>
                              {item.detail && (
                                <div
                                  style={{
                                    fontSize: 11,
                                    color: "var(--color-text-muted)",
                                    marginTop: 1,
                                  }}
                                >
                                  {item.detail}
                                </div>
                              )}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              ))}
          </>
        )}
      </div>
    </div>
  );
};
