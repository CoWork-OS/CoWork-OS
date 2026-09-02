import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  CirclePause,
  FileText,
  Loader2,
} from "lucide-react";

import type {
  ActivityGroupViewModel,
  TaskImpactMetric,
  TaskStatusStripViewModel,
} from "../../shared/types";
import { formatTaskImpactMetric } from "../utils/task-impact-metrics";
import { incrementRendererPerfCounter } from "../utils/renderer-perf";

interface TaskStatusStripProps {
  model: TaskStatusStripViewModel;
  activityGroups: ActivityGroupViewModel[];
  outcomeMetrics: TaskImpactMetric[];
  replay?: boolean;
  telemetryEnabled?: boolean;
  onOpenOutput?: (path?: string) => void;
}

function StatusIcon({ model }: { model: TaskStatusStripViewModel }) {
  if (model.state === "working") {
    return <Loader2 className="task-status-strip-icon spinning" aria-hidden="true" />;
  }
  if (model.state === "completed") {
    return <CheckCircle2 className="task-status-strip-icon" aria-hidden="true" />;
  }
  if (model.state === "paused") {
    return <CirclePause className="task-status-strip-icon" aria-hidden="true" />;
  }
  return <AlertCircle className="task-status-strip-icon" aria-hidden="true" />;
}

function shouldAnnounce(model: TaskStatusStripViewModel): boolean {
  return (
    model.state === "waiting_for_approval" ||
    model.state === "waiting_for_input" ||
    model.state === "failed" ||
    model.state === "completed" ||
    model.activeStepOrdinal !== undefined
  );
}

export function TaskStatusStrip({
  model,
  activityGroups,
  outcomeMetrics,
  replay = false,
  telemetryEnabled = false,
  onOpenOutput,
}: TaskStatusStripProps) {
  const [open, setOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const stripRef = useRef<HTMLButtonElement>(null);
  const announcementTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const announcementSignature = `${model.state}:${model.activeStepId ?? "none"}:${model.primaryLabel}`;
  // Phase labels can change on every tool event. Keep the live region scoped to
  // step/state transitions and actionable blocking details.
  const announcementDetail = model.blockingLabel || "";
  const announceable = shouldAnnounce(model);

  useEffect(() => {
    if (replay || !announceable) return;
    if (announcementTimerRef.current) clearTimeout(announcementTimerRef.current);
    announcementTimerRef.current = setTimeout(() => {
      setAnnouncement([model.primaryLabel, announcementDetail].filter(Boolean).join(", "));
    }, 900);
    return () => {
      if (announcementTimerRef.current) clearTimeout(announcementTimerRef.current);
    };
  }, [announceable, announcementDetail, announcementSignature, replay]);

  useEffect(() => {
    if (!model.visible) setOpen(false);
  }, [model.visible]);

  const groupsByPlanStep = useMemo(() => {
    const groups = new Map<string, ActivityGroupViewModel>();
    for (const group of activityGroups) {
      if (group.planStepId) groups.set(group.planStepId, group);
    }
    return groups;
  }, [activityGroups]);

  const scrollToGroup = (groupId: string | undefined) => {
    if (!groupId) return;
    const element = document.getElementById(`activity-group-${groupId}`);
    element?.scrollIntoView({ block: "center", behavior: replay ? "auto" : "smooth" });
    incrementRendererPerfCounter("task-status-strip.drawer_closed", telemetryEnabled);
    setOpen(false);
  };

  const handleDrawerKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    incrementRendererPerfCounter("task-status-strip.drawer_closed", telemetryEnabled);
    setOpen(false);
    stripRef.current?.focus();
  };

  if (!model.visible) return null;
  return (
    <div className={`task-status-strip-shell tone-${model.tone}`} onKeyDown={handleDrawerKeyDown}>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
      {open && (
        <div id="task-status-drawer" className="task-status-drawer">
          <div className="task-status-drawer-header">
            <div>
              <strong>{model.primaryLabel}</strong>
              {model.phaseLabel && <span>{model.phaseLabel}</span>}
            </div>
            {model.verificationLabel && (
              <span className="task-status-verification">{model.verificationLabel}</span>
            )}
          </div>

          {model.blockingLabel && (
            <div className="task-status-blocking" role="status">
              <AlertCircle size={15} aria-hidden="true" />
              <span>{model.blockingLabel}</span>
            </div>
          )}

          {model.planSteps.length > 0 && (
            <section className="task-status-drawer-section" aria-labelledby="task-status-plan">
              <h3 id="task-status-plan">Plan</h3>
              <ol className="task-status-plan-list">
                {model.planSteps.map((step, index) => {
                  const group = groupsByPlanStep.get(step.id);
                  return (
                    <li key={step.id} className={`status-${step.status}`}>
                      <button
                        type="button"
                        onClick={() => scrollToGroup(group?.id)}
                        disabled={!group}
                        aria-current={step.id === model.activeStepId ? "step" : undefined}
                      >
                        <span className="task-status-step-index">{index + 1}</span>
                        <span>{step.description}</span>
                        <span className="task-status-step-state">
                          {step.status.replace("_", " ")}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </section>
          )}

          {activityGroups.length > 0 && (
            <section className="task-status-drawer-section" aria-labelledby="task-status-activity">
              <h3 id="task-status-activity">Latest activity</h3>
              <button
                type="button"
                className="task-status-latest-activity"
                onClick={() => scrollToGroup(activityGroups.at(-1)?.id)}
              >
                <span>{activityGroups.at(-1)?.latestActivityLabel}</span>
                <span>{activityGroups.at(-1)?.status}</span>
              </button>
            </section>
          )}

          {outcomeMetrics.length > 0 && (
            <section className="task-status-drawer-section" aria-labelledby="task-status-impact">
              <h3 id="task-status-impact">Impact</h3>
              <div className="task-status-impact-grid">
                {outcomeMetrics.map((metric) => (
                  <span key={metric.id}>{formatTaskImpactMetric(metric)}</span>
                ))}
              </div>
            </section>
          )}

          {model.outputs && model.outputs.outputCount > 0 && (
            <section className="task-status-drawer-section" aria-labelledby="task-status-outputs">
              <h3 id="task-status-outputs">Outputs</h3>
              <div className="task-status-output-list">
                {(model.outputs.created.length > 0
                  ? model.outputs.created
                  : model.outputs.modifiedFallback || []
                ).map((path) => (
                  <button type="button" key={path} onClick={() => onOpenOutput?.(path)}>
                    <FileText size={14} aria-hidden="true" />
                    <span>{path.split(/[\\/]/).pop() || path}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      <button
        ref={stripRef}
        type="button"
        className="task-status-strip"
        aria-expanded={open}
        aria-controls="task-status-drawer"
        onClick={() =>
          setOpen((value) => {
            const next = !value;
            incrementRendererPerfCounter(
              `task-status-strip.drawer_${next ? "opened" : "closed"}`,
              telemetryEnabled,
            );
            return next;
          })
        }
      >
        <StatusIcon model={model} />
        <strong className="task-status-strip-primary">{model.primaryLabel}</strong>
        {model.compactMetricSlots.map((slot, index) => (
          <span key={slot.id} className={`task-status-strip-metric metric-${index + 1}`}>
            {slot.label}
          </span>
        ))}
        {model.compactMetricSlots.length < 2 && model.phaseLabel && (
          <span className={`task-status-strip-phase phase-${model.compactMetricSlots.length + 1}`}>
            {model.phaseLabel}
          </span>
        )}
        <ChevronDown className="task-status-strip-chevron" aria-hidden="true" />
      </button>
    </div>
  );
}
