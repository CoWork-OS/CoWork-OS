import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Play,
  Square,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Info,
  Camera,
  Monitor,
  Smartphone,
  Globe,
  Zap,
  Eye,
  MousePointer,
  RefreshCw,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

type Any = any;

interface QAIssue {
  id: string;
  type: string;
  severity: "critical" | "major" | "minor" | "info";
  title: string;
  description: string;
  screenshotPath?: string;
  element?: string;
  url: string;
  fixed: boolean;
  fixDescription?: string;
  timestamp: number;
}

interface QACheck {
  type: string;
  label: string;
  description: string;
  passed: boolean;
  issues: QAIssue[];
  screenshotPath?: string;
  durationMs: number;
}

interface QAInteractionStep {
  action: string;
  selector?: string;
  value?: string;
  url?: string;
  description: string;
  screenshotPath?: string;
  success: boolean;
  error?: string;
  durationMs: number;
}

interface QARun {
  id: string;
  taskId: string;
  status: string;
  config: {
    targetUrl: string;
    serverCommand?: string;
    enabledChecks?: string[];
  };
  checks: QACheck[];
  interactionLog: QAInteractionStep[];
  issues: QAIssue[];
  finalScreenshotPath?: string;
  fixAttempts: number;
  durationMs: number;
  startedAt: number;
  completedAt?: number;
  summary?: string;
}

interface QAEvent {
  type: string;
  runId: string;
  taskId: string;
  data: Partial<QARun> & {
    check?: QACheck;
    issue?: QAIssue;
    step?: QAInteractionStep;
    screenshotPath?: string;
    status?: string;
  };
  timestamp: number;
}

interface PlaywrightQAPanelProps {
  taskId?: string;
  workspaceId: string;
}

const SEVERITY_CONFIG = {
  critical: { color: "#ef4444", bg: "#ef444420", icon: XCircle, label: "Critical" },
  major: { color: "#f59e0b", bg: "#f59e0b20", icon: AlertTriangle, label: "Major" },
  minor: { color: "#3b82f6", bg: "#3b82f620", icon: Info, label: "Minor" },
  info: { color: "#6b7280", bg: "#6b728020", icon: Info, label: "Info" },
} as const;

const CHECK_ICONS: Record<string, React.ReactNode> = {
  console_errors: <Monitor size={14} />,
  network_errors: <Globe size={14} />,
  visual_snapshot: <Eye size={14} />,
  interaction_test: <MousePointer size={14} />,
  responsive_check: <Smartphone size={14} />,
  accessibility_check: <Zap size={14} />,
  performance_check: <Zap size={14} />,
};

const STATUS_LABELS: Record<string, string> = {
  idle: "Idle",
  starting_server: "Starting Server...",
  launching_browser: "Launching Browser...",
  navigating: "Navigating...",
  testing: "Running Tests...",
  analyzing: "Analyzing Results...",
  fixing: "Fixing Issues...",
  retesting: "Re-testing...",
  completed: "Completed",
  failed: "Failed",
};

export function PlaywrightQAPanel({ taskId, workspaceId }: PlaywrightQAPanelProps) {
  const [runs, setRuns] = useState<QARun[]>([]);
  const [selectedRun, setSelectedRun] = useState<QARun | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [expandedChecks, setExpandedChecks] = useState<Set<string>>(new Set());
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(["checks", "issues"]),
  );
  const [targetUrl, setTargetUrl] = useState("http://localhost:3000");
  const [serverCommand, setServerCommand] = useState("");
  const eventCleanupRef = useRef<(() => void) | null>(null);

  // Load runs on mount
  useEffect(() => {
    loadRuns();
  }, []);

  // Subscribe to QA events
  useEffect(() => {
    const api = (window as Any).electronAPI;
    if (!api?.onQAEvent) return;

    const cleanup = api.onQAEvent((event: QAEvent) => {
      if (taskId && event.taskId !== taskId) return;

      if (event.type === "qa:status" && event.data.status) {
        setSelectedRun((prev) =>
          prev && prev.id === event.runId ? { ...prev, status: event.data.status! } : prev,
        );
      }

      if (event.type === "qa:check" && event.data.check) {
        setSelectedRun((prev) => {
          if (!prev || prev.id !== event.runId) return prev;
          return {
            ...prev,
            checks: [...prev.checks, event.data.check!],
          };
        });
      }

      if (event.type === "qa:issue" && event.data.issue) {
        setSelectedRun((prev) => {
          if (!prev || prev.id !== event.runId) return prev;
          return {
            ...prev,
            issues: [...prev.issues, event.data.issue!],
          };
        });
      }

      if (event.type === "qa:step" && event.data.step) {
        setSelectedRun((prev) => {
          if (!prev || prev.id !== event.runId) return prev;
          return {
            ...prev,
            interactionLog: [...prev.interactionLog, event.data.step!],
          };
        });
      }

      if (event.type === "qa:complete") {
        setIsRunning(false);
        loadRuns();
      }
    });

    eventCleanupRef.current = cleanup;
    return () => {
      cleanup();
      eventCleanupRef.current = null;
    };
  }, [taskId]);

  const loadRuns = useCallback(async () => {
    const api = (window as Any).electronAPI;
    if (!api?.qaGetRuns) return;
    try {
      const result = await api.qaGetRuns();
      setRuns(result || []);
      if (result?.length > 0 && !selectedRun) {
        setSelectedRun(result[0]);
      }
    } catch {
      // best effort
    }
  }, [selectedRun]);

  const startRun = useCallback(async () => {
    const api = (window as Any).electronAPI;
    if (!api?.qaStartRun || !taskId) return;

    setIsRunning(true);
    try {
      const run = await api.qaStartRun({
        taskId,
        workspaceId,
        config: {
          targetUrl,
          serverCommand: serverCommand || undefined,
        },
      });
      setSelectedRun(run);
      loadRuns();
    } catch (error) {
      console.error("[QA] Failed to start run:", error);
    } finally {
      setIsRunning(false);
    }
  }, [taskId, workspaceId, targetUrl, serverCommand, loadRuns]);

  const stopRun = useCallback(async () => {
    const api = (window as Any).electronAPI;
    if (!api?.qaStopRun || !taskId) return;

    try {
      await api.qaStopRun(taskId);
      setIsRunning(false);
    } catch {
      // best effort
    }
  }, [taskId]);

  const toggleCheck = (checkType: string) => {
    setExpandedChecks((prev) => {
      const next = new Set(prev);
      if (next.has(checkType)) next.delete(checkType);
      else next.add(checkType);
      return next;
    });
  };

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  };

  const containerStyle: React.CSSProperties = {
    padding: "16px",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    fontSize: "13px",
    color: "var(--text-primary, #e4e4e7)",
  };

  const cardStyle: React.CSSProperties = {
    background: "var(--surface-secondary, #1e1e2e)",
    borderRadius: "8px",
    border: "1px solid var(--border-primary, #2e2e3e)",
    padding: "12px",
    marginBottom: "12px",
  };

  const buttonStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    padding: "6px 12px",
    borderRadius: "6px",
    border: "none",
    cursor: "pointer",
    fontSize: "12px",
    fontWeight: 500,
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "6px 10px",
    borderRadius: "6px",
    border: "1px solid var(--border-primary, #2e2e3e)",
    background: "var(--surface-primary, #121218)",
    color: "var(--text-primary, #e4e4e7)",
    fontSize: "12px",
    outline: "none",
  };

  return (
    <div style={containerStyle}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "16px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <Camera size={18} style={{ color: "var(--accent-primary, #8b5cf6)" }} />
          <span style={{ fontSize: "15px", fontWeight: 600 }}>Visual QA</span>
          {selectedRun && (
            <span
              style={{
                fontSize: "11px",
                padding: "2px 8px",
                borderRadius: "10px",
                background:
                  selectedRun.status === "completed"
                    ? "#22c55e20"
                    : selectedRun.status === "failed"
                      ? "#ef444420"
                      : "#3b82f620",
                color:
                  selectedRun.status === "completed"
                    ? "#22c55e"
                    : selectedRun.status === "failed"
                      ? "#ef4444"
                      : "#3b82f6",
              }}
            >
              {STATUS_LABELS[selectedRun.status] || selectedRun.status}
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <button
            onClick={loadRuns}
            style={{
              ...buttonStyle,
              background: "transparent",
              color: "var(--text-secondary, #a1a1aa)",
            }}
            title="Refresh"
          >
            <RefreshCw size={14} />
          </button>
          {isRunning ? (
            <button
              onClick={stopRun}
              style={{
                ...buttonStyle,
                background: "#ef4444",
                color: "#fff",
              }}
            >
              <Square size={14} />
              Stop
            </button>
          ) : (
            <button
              onClick={startRun}
              disabled={!taskId}
              style={{
                ...buttonStyle,
                background: "var(--accent-primary, #8b5cf6)",
                color: "#fff",
                opacity: taskId ? 1 : 0.5,
              }}
            >
              <Play size={14} />
              Run QA
            </button>
          )}
        </div>
      </div>

      {/* Config */}
      <div style={cardStyle}>
        <div style={{ marginBottom: "8px" }}>
          <label
            style={{
              fontSize: "11px",
              color: "var(--text-secondary, #a1a1aa)",
              marginBottom: "4px",
              display: "block",
            }}
          >
            Target URL
          </label>
          <input
            style={inputStyle}
            value={targetUrl}
            onChange={(e) => setTargetUrl(e.target.value)}
            placeholder="http://localhost:3000"
          />
        </div>
        <div>
          <label
            style={{
              fontSize: "11px",
              color: "var(--text-secondary, #a1a1aa)",
              marginBottom: "4px",
              display: "block",
            }}
          >
            Server Command (optional)
          </label>
          <input
            style={inputStyle}
            value={serverCommand}
            onChange={(e) => setServerCommand(e.target.value)}
            placeholder="npm run dev"
          />
        </div>
      </div>

      {/* Run Summary */}
      {selectedRun && (
        <>
          {/* Summary bar */}
          {selectedRun.summary && (
            <div
              style={{
                ...cardStyle,
                display: "flex",
                alignItems: "center",
                gap: "8px",
                borderLeft: `3px solid ${
                  selectedRun.issues.length === 0
                    ? "#22c55e"
                    : selectedRun.issues.some((i) => i.severity === "critical")
                      ? "#ef4444"
                      : "#f59e0b"
                }`,
              }}
            >
              {selectedRun.issues.length === 0 ? (
                <CheckCircle size={16} style={{ color: "#22c55e" }} />
              ) : (
                <AlertTriangle size={16} style={{ color: "#f59e0b" }} />
              )}
              <span style={{ fontSize: "12px" }}>{selectedRun.summary}</span>
            </div>
          )}

          {/* Checks */}
          <SectionHeader
            title="Checks"
            count={selectedRun.checks.length}
            expanded={expandedSections.has("checks")}
            onToggle={() => toggleSection("checks")}
          />
          {expandedSections.has("checks") && (
            <div style={{ marginBottom: "12px" }}>
              {selectedRun.checks.map((check) => (
                <div key={check.type} style={{ ...cardStyle, padding: "8px 12px" }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      cursor: "pointer",
                    }}
                    onClick={() => toggleCheck(check.type)}
                  >
                    {check.passed ? (
                      <CheckCircle size={14} style={{ color: "#22c55e" }} />
                    ) : (
                      <XCircle size={14} style={{ color: "#ef4444" }} />
                    )}
                    {CHECK_ICONS[check.type] || <Info size={14} />}
                    <span style={{ flex: 1, fontWeight: 500 }}>{check.label}</span>
                    <span
                      style={{
                        fontSize: "11px",
                        color: "var(--text-secondary, #a1a1aa)",
                      }}
                    >
                      {check.issues.length} issue{check.issues.length !== 1 ? "s" : ""}
                      {" | "}
                      {Math.round(check.durationMs / 1000)}s
                    </span>
                    {expandedChecks.has(check.type) ? (
                      <ChevronDown size={14} />
                    ) : (
                      <ChevronRight size={14} />
                    )}
                  </div>
                  {expandedChecks.has(check.type) && check.issues.length > 0 && (
                    <div style={{ marginTop: "8px", paddingLeft: "22px" }}>
                      {check.issues.map((issue) => (
                        <IssueRow key={issue.id} issue={issue} />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Issues */}
          {selectedRun.issues.length > 0 && (
            <>
              <SectionHeader
                title="All Issues"
                count={selectedRun.issues.length}
                expanded={expandedSections.has("issues")}
                onToggle={() => toggleSection("issues")}
              />
              {expandedSections.has("issues") && (
                <div style={{ marginBottom: "12px" }}>
                  {selectedRun.issues.map((issue) => (
                    <IssueRow key={issue.id} issue={issue} />
                  ))}
                </div>
              )}
            </>
          )}

          {/* Interaction Log */}
          {selectedRun.interactionLog.length > 0 && (
            <>
              <SectionHeader
                title="Interaction Log"
                count={selectedRun.interactionLog.length}
                expanded={expandedSections.has("interactions")}
                onToggle={() => toggleSection("interactions")}
              />
              {expandedSections.has("interactions") && (
                <div style={{ marginBottom: "12px" }}>
                  {selectedRun.interactionLog.map((step, i) => (
                    <div
                      key={i}
                      style={{
                        ...cardStyle,
                        padding: "6px 12px",
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                      }}
                    >
                      {step.success ? (
                        <CheckCircle size={12} style={{ color: "#22c55e" }} />
                      ) : (
                        <XCircle size={12} style={{ color: "#ef4444" }} />
                      )}
                      <span style={{ flex: 1, fontSize: "12px" }}>{step.description}</span>
                      {step.error && (
                        <span
                          style={{
                            fontSize: "11px",
                            color: "#ef4444",
                            maxWidth: "200px",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {step.error}
                        </span>
                      )}
                      <span
                        style={{
                          fontSize: "11px",
                          color: "var(--text-secondary, #a1a1aa)",
                        }}
                      >
                        {step.durationMs}ms
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* Run History */}
          {runs.length > 1 && (
            <>
              <SectionHeader
                title="History"
                count={runs.length}
                expanded={expandedSections.has("history")}
                onToggle={() => toggleSection("history")}
              />
              {expandedSections.has("history") && (
                <div style={{ marginBottom: "12px" }}>
                  {runs.map((run) => (
                    <div
                      key={run.id}
                      onClick={() => setSelectedRun(run)}
                      style={{
                        ...cardStyle,
                        padding: "6px 12px",
                        cursor: "pointer",
                        borderLeft:
                          selectedRun?.id === run.id
                            ? "3px solid var(--accent-primary, #8b5cf6)"
                            : "3px solid transparent",
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                      }}
                    >
                      {run.status === "completed" && run.issues.length === 0 ? (
                        <CheckCircle size={14} style={{ color: "#22c55e" }} />
                      ) : run.status === "failed" ? (
                        <XCircle size={14} style={{ color: "#ef4444" }} />
                      ) : (
                        <AlertTriangle size={14} style={{ color: "#f59e0b" }} />
                      )}
                      <span style={{ flex: 1, fontSize: "12px" }}>
                        {new Date(run.startedAt).toLocaleTimeString()}
                      </span>
                      <span
                        style={{
                          fontSize: "11px",
                          color: "var(--text-secondary, #a1a1aa)",
                        }}
                      >
                        {run.issues.length} issue{run.issues.length !== 1 ? "s" : ""}
                        {" | "}
                        {Math.round(run.durationMs / 1000)}s
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* Empty state */}
      {!selectedRun && !isRunning && (
        <div
          style={{
            textAlign: "center",
            padding: "32px 16px",
            color: "var(--text-secondary, #a1a1aa)",
          }}
        >
          <Camera
            size={32}
            style={{
              marginBottom: "8px",
              opacity: 0.5,
              color: "var(--accent-primary, #8b5cf6)",
            }}
          />
          <div style={{ fontSize: "13px", marginBottom: "4px" }}>No QA runs yet</div>
          <div style={{ fontSize: "11px" }}>
            Run automated Playwright tests to catch visual and functional bugs.
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Sub-components ----

function SectionHeader({
  title,
  count,
  expanded,
  onToggle,
}: {
  title: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      onClick={onToggle}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "6px",
        padding: "6px 0",
        cursor: "pointer",
        fontSize: "12px",
        fontWeight: 600,
        color: "var(--text-secondary, #a1a1aa)",
        textTransform: "uppercase",
        letterSpacing: "0.5px",
      }}
    >
      {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      {title}
      <span
        style={{
          fontSize: "10px",
          background: "var(--surface-secondary, #1e1e2e)",
          padding: "1px 6px",
          borderRadius: "8px",
        }}
      >
        {count}
      </span>
    </div>
  );
}

function IssueRow({ issue }: { issue: QAIssue }) {
  const config = SEVERITY_CONFIG[issue.severity] || SEVERITY_CONFIG.info;
  const Icon = config.icon;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: "8px",
        padding: "6px 8px",
        marginBottom: "4px",
        borderRadius: "6px",
        background: config.bg,
      }}
    >
      <Icon size={14} style={{ color: config.color, marginTop: "1px", flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: "12px",
            fontWeight: 500,
            color: "var(--text-primary, #e4e4e7)",
          }}
        >
          {issue.title}
        </div>
        {issue.description !== issue.title && (
          <div
            style={{
              fontSize: "11px",
              color: "var(--text-secondary, #a1a1aa)",
              marginTop: "2px",
              wordBreak: "break-word",
            }}
          >
            {issue.description}
          </div>
        )}
        {issue.fixed && (
          <div
            style={{
              fontSize: "11px",
              color: "#22c55e",
              marginTop: "2px",
              display: "flex",
              alignItems: "center",
              gap: "4px",
            }}
          >
            <CheckCircle size={10} />
            Fixed{issue.fixDescription ? `: ${issue.fixDescription}` : ""}
          </div>
        )}
      </div>
      <span
        style={{
          fontSize: "10px",
          color: config.color,
          fontWeight: 600,
          textTransform: "uppercase",
          flexShrink: 0,
        }}
      >
        {config.label}
      </span>
    </div>
  );
}

export default PlaywrightQAPanel;
