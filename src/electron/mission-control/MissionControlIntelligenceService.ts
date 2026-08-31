import Database from "better-sqlite3";
import type {
  HeartbeatEvent,
  HeartbeatSignal,
  MissionControlBrief,
  MissionControlCategory,
  MissionControlItem,
  MissionControlItemEvidence,
  MissionControlListRequest,
  MissionControlScopeRequest,
  MissionControlSeverity,
} from "../../shared/types";
import {
  MissionControlRepository,
  ReplaceMissionControlEvidenceInput,
  UpsertMissionControlItemInput,
} from "./MissionControlRepository";

type Any = any; // oxlint-disable-line typescript-eslint/no-explicit-any

const ALL_WORKSPACES_ID = "__all__";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeScopeId(value?: string | null): string | undefined {
  return value && value !== ALL_WORKSPACES_ID ? value : undefined;
}

function truncate(value: string | undefined | null, max = 220): string {
  const text = (value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trim()}…`;
}

function humanize(value?: string | null): string {
  return (value || "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function hasRawToolShape(activity: ActivityRow): boolean {
  const text = `${activity.title} ${activity.description || ""}`.toLowerCase();
  return (
    activity.activity_type === "tool_used" ||
    activity.activity_type === "command_executed" ||
    text.startsWith("tool used") ||
    text.includes("tool used -") ||
    text.includes("tool used –") ||
    text.includes("scratchpad_") ||
    text.includes("read_file") ||
    text.includes("write_file")
  );
}

function activityCategory(activity: ActivityRow): MissionControlCategory {
  const text = `${activity.title} ${activity.description || ""}`.toLowerCase();
  if (
    text.includes("what cowork learned") ||
    text.includes(".cowork/") ||
    text.includes("memory")
  ) {
    return "learnings";
  }
  if (text.includes("heartbeat") || text.includes("background review")) {
    return "reviews";
  }
  if (activity.activity_type === "error" || text.includes("blocked") || text.includes("failed")) {
    return "attention";
  }
  if (activity.activity_type.startsWith("task_") || activity.activity_type === "agent_assigned") {
    return "work";
  }
  if (activity.activity_type === "mention" || activity.activity_type === "comment") {
    return "attention";
  }
  return "evidence";
}

function activitySeverity(activity: ActivityRow): MissionControlSeverity {
  const text = `${activity.title} ${activity.description || ""}`.toLowerCase();
  if (activity.activity_type === "error" || text.includes("failed") || text.includes("blocked")) {
    return "failed";
  }
  if (
    text.includes("needs review") ||
    text.includes("pending") ||
    activity.activity_type === "mention"
  ) {
    return "action_needed";
  }
  if (text.includes("no follow-up") || text.includes("no action") || text.includes("monitor")) {
    return "monitor_only";
  }
  if (activity.activity_type === "task_completed" || text.includes("completed")) {
    return "successful";
  }
  return "monitor_only";
}

function signalText(signal?: HeartbeatSignal): string {
  if (!signal) return "background signal";
  return truncate(
    signal.reason || signal.signalFamily?.replace(/_/g, " ") || "background signal",
    160,
  );
}

interface ActivityRow {
  id: string;
  workspace_id: string;
  workspace_name?: string | null;
  task_id?: string | null;
  agent_role_id?: string | null;
  agent_name?: string | null;
  actor_type: string;
  activity_type: string;
  title: string;
  description?: string | null;
  metadata?: string | null;
  created_at: number;
}

interface TaskRow {
  id: string;
  workspace_id: string;
  workspace_name?: string | null;
  company_id?: string | null;
  company_name?: string | null;
  assigned_agent_role_id?: string | null;
  agent_name?: string | null;
  title: string;
  status: string;
  board_column?: string | null;
  updated_at: number;
}

interface MentionRow {
  id: string;
  workspace_id: string;
  workspace_name?: string | null;
  task_id?: string | null;
  to_agent_role_id?: string | null;
  agent_name?: string | null;
  mention_type: string;
  context?: string | null;
  status: string;
  created_at: number;
}

interface HeartbeatRunRow {
  id: string;
  workspace_id?: string | null;
  workspace_name?: string | null;
  task_id?: string | null;
  issue_id?: string | null;
  agent_role_id?: string | null;
  agent_name?: string | null;
  run_type: string;
  dispatch_kind?: string | null;
  reason?: string | null;
  status: string;
  summary?: string | null;
  error?: string | null;
  created_at: number;
  updated_at: number;
  completed_at?: number | null;
}

export class MissionControlIntelligenceService {
  private readonly repo: MissionControlRepository;

  constructor(private readonly db: Database.Database) {
    this.repo = new MissionControlRepository(db);
  }

  refresh(scope: MissionControlScopeRequest = {}): MissionControlBrief {
    this.refreshTasks(scope);
    this.refreshMentions(scope);
    this.refreshActivities(scope);
    this.refreshHeartbeatRuns(scope);
    this.refreshCoreMemory(scope);
    this.refreshSubconscious(scope);
    return this.getBrief(scope);
  }

  listItems(request: MissionControlListRequest = {}): MissionControlItem[] {
    return this.repo.listItems(request);
  }

  getEvidence(itemId: string): MissionControlItemEvidence[] {
    return this.repo.listEvidence(itemId);
  }

  getBrief(scope: MissionControlScopeRequest = {}): MissionControlBrief {
    const items = this.repo.listItems({ ...scope, limit: 120 });
    const attention = items.filter(
      (item) => item.severity === "action_needed" || item.severity === "failed",
    );
    const activeWork = items.filter((item) => item.category === "work").slice(0, 6);
    const reviewItems = items.filter((item) => item.category === "reviews");
    const learningChanges = items.filter((item) => item.category === "learnings").slice(0, 6);
    const awarenessClusters = items.filter((item) => item.category === "awareness").slice(0, 6);
    const latestDecisions = items.filter((item) => Boolean(item.decision)).slice(0, 6);
    const upcomingReviews = reviewItems.filter((item) => item.nextStep).slice(0, 6);

    return {
      generatedAt: Date.now(),
      attentionCount: attention.length,
      activeWorkCount: activeWork.length,
      reviewCount: reviewItems.length,
      learningCount: items.filter((item) => item.category === "learnings").length,
      awarenessCount: items.filter((item) => item.category === "awareness").length,
      evidenceCount: items.reduce((sum, item) => sum + item.evidenceCount, 0),
      latestDecisions,
      learningChanges,
      awarenessClusters,
      activeWork,
      upcomingReviews,
      sections: [
        { title: "Needs attention", items: attention.slice(0, 6) },
        { title: "Latest decisions", items: latestDecisions },
        { title: "Learnings", items: learningChanges },
        { title: "Awareness", items: awarenessClusters },
        { title: "Active work", items: activeWork },
      ],
    };
  }

  recordHeartbeatEvent(event: HeartbeatEvent): void {
    const base: Partial<UpsertMissionControlItemInput> = {
      agentRoleId: event.agentRoleId,
      agentName: event.agentName,
      timestamp: event.timestamp,
      runId: event.runId,
    };
    const evidence: ReplaceMissionControlEvidenceInput[] = [
      {
        sourceType:
          event.type === "signal_merged" || event.type === "signal_received"
            ? "heartbeat_signal"
            : "heartbeat_event",
        sourceId: event.runId,
        title: humanize(event.type) || "Heartbeat event",
        summary: event.signal ? signalText(event.signal) : event.result?.triggerReason,
        payload: event as unknown as Record<string, unknown>,
        timestamp: event.timestamp,
      },
    ];

    if (event.type === "signal_merged" || event.type === "signal_received") {
      const family = event.signal?.signalFamily || "awareness_signal";
      const merged =
        event.signal?.mergedCount && event.signal.mergedCount > 1
          ? `${event.signal.mergedCount} signals`
          : "1 signal";
      const source = signalText(event.signal);
      const item = this.repo.upsertItem({
        ...base,
        fingerprint: `heartbeat-signal:${event.agentRoleId}:${family}:${event.signal?.fingerprint || source}`,
        category: family === "memory_drift" ? "learnings" : "awareness",
        severity:
          event.signal?.urgency === "critical" || event.signal?.urgency === "high"
            ? "action_needed"
            : "monitor_only",
        title:
          family === "memory_drift"
            ? "Learning signal captured"
            : "Awareness noticed background activity",
        summary: `${merged}: ${source}`,
        decision: "Grouped as background context until it becomes actionable.",
        nextStep: "Keep monitoring unless a blocker, deadline, or assignment appears.",
        timestamp: event.timestamp,
      } as UpsertMissionControlItemInput);
      this.repo.replaceEvidence(item.id, evidence);
      return;
    }

    const result = event.result;
    const item = this.repo.upsertItem({
      ...base,
      fingerprint: `heartbeat-review:${event.runId || `${event.agentRoleId}:${event.type}:${event.timestamp}`}`,
      category: "reviews",
      severity:
        event.type === "error"
          ? "failed"
          : event.type === "work_found"
            ? "action_needed"
            : "monitor_only",
      title:
        event.type === "work_found"
          ? "Background review found pending work"
          : "Background review completed",
      summary: result
        ? `${result.pendingMentions || 0} mentions, ${result.assignedTasks || 0} assigned tasks detected.`
        : humanize(event.type) || "Review event captured.",
      decision: event.type === "no_work" ? "No action needed." : result?.triggerReason,
      nextStep:
        event.type === "work_found"
          ? "Review the pending work queue."
          : "Next review will run on schedule or when a signal arrives.",
      timestamp: event.timestamp,
    } as UpsertMissionControlItemInput);
    this.repo.replaceEvidence(item.id, evidence);
  }

  private refreshTasks(scope: MissionControlScopeRequest): void {
    const workspaceId = normalizeScopeId(scope.workspaceId);
    const companyId = normalizeScopeId(scope.companyId);
    const params: unknown[] = [];
    const conditions = ["t.status NOT IN ('completed', 'cancelled', 'failed')"];
    if (workspaceId) {
      conditions.push("t.workspace_id = ?");
      params.push(workspaceId);
    }
    if (companyId) {
      conditions.push("t.company_id = ?");
      params.push(companyId);
    }
    const rows = this.db
      .prepare(
        `SELECT t.id, t.workspace_id, w.name AS workspace_name, t.company_id, c.name AS company_name,
                t.assigned_agent_role_id, ar.display_name AS agent_name, t.title, t.status,
                t.board_column, t.updated_at
         FROM tasks t
         LEFT JOIN workspaces w ON w.id = t.workspace_id
         LEFT JOIN companies c ON c.id = t.company_id
         LEFT JOIN agent_roles ar ON ar.id = t.assigned_agent_role_id
         WHERE ${conditions.join(" AND ")}
         ORDER BY t.updated_at DESC
         LIMIT 80`,
      )
      .all(...params) as TaskRow[];
    const activeTaskIds = (
      this.db
        .prepare(`SELECT t.id FROM tasks t WHERE ${conditions.join(" AND ")}`)
        .all(...params) as Array<{ id: string }>
    ).map((task) => task.id);
    this.repo.deleteTaskItemsNotIn({
      taskIds: activeTaskIds,
      workspaceId,
      companyId,
    });
    for (const task of rows) {
      const blocked = task.status === "blocked" || task.board_column === "review";
      const item = this.repo.upsertItem({
        fingerprint: `task:${task.id}`,
        category: blocked ? "attention" : "work",
        severity: blocked ? "action_needed" : "monitor_only",
        title: blocked ? `Work needs attention: ${task.title}` : `Active work: ${task.title}`,
        summary: `Status: ${humanize(task.status)}${task.board_column ? ` · ${humanize(task.board_column)}` : ""}`,
        decision: blocked
          ? "This work is not moving without review or intervention."
          : "Work remains in the active queue.",
        nextStep: blocked ? "Open the task and resolve the blocker or review request." : undefined,
        agentRoleId: task.assigned_agent_role_id || undefined,
        agentName: task.agent_name || undefined,
        workspaceId: task.workspace_id,
        workspaceName: task.workspace_name || undefined,
        companyId: task.company_id || undefined,
        companyName: task.company_name || undefined,
        taskId: task.id,
        timestamp: task.updated_at,
      });
      this.repo.replaceEvidence(item.id, [
        {
          sourceType: "task",
          sourceId: task.id,
          title: task.title,
          summary: `Task ${humanize(task.status)}`,
          payload: task as unknown as Record<string, unknown>,
          timestamp: task.updated_at,
        },
      ]);
    }
  }

  private refreshMentions(scope: MissionControlScopeRequest): void {
    const workspaceId = normalizeScopeId(scope.workspaceId);
    const params: unknown[] = [];
    const conditions = ["m.status = 'pending'"];
    if (workspaceId) {
      conditions.push("m.workspace_id = ?");
      params.push(workspaceId);
    }
    const rows = this.db
      .prepare(
        `SELECT m.id, m.workspace_id, w.name AS workspace_name, m.task_id, m.to_agent_role_id,
                ar.display_name AS agent_name, m.mention_type, m.context, m.status, m.created_at
         FROM agent_mentions m
         LEFT JOIN workspaces w ON w.id = m.workspace_id
         LEFT JOIN agent_roles ar ON ar.id = m.to_agent_role_id
         WHERE ${conditions.join(" AND ")}
         ORDER BY m.created_at DESC
         LIMIT 80`,
      )
      .all(...params) as MentionRow[];
    for (const mention of rows) {
      const item = this.repo.upsertItem({
        fingerprint: `mention:${mention.id}`,
        category: "attention",
        severity: "action_needed",
        title: "Mention needs a response",
        summary: truncate(
          mention.context || `Pending ${humanize(mention.mention_type)} mention`,
          180,
        ),
        decision: "Cowork is waiting on a response or acknowledgement.",
        nextStep: "Open the related task or mention thread.",
        agentRoleId: mention.to_agent_role_id || undefined,
        agentName: mention.agent_name || undefined,
        workspaceId: mention.workspace_id,
        workspaceName: mention.workspace_name || undefined,
        taskId: mention.task_id || undefined,
        timestamp: mention.created_at,
      });
      this.repo.replaceEvidence(item.id, [
        {
          sourceType: "mention",
          sourceId: mention.id,
          title: humanize(mention.mention_type) || "Mention",
          summary: mention.context || undefined,
          payload: mention as unknown as Record<string, unknown>,
          timestamp: mention.created_at,
        },
      ]);
    }
  }

  private refreshActivities(scope: MissionControlScopeRequest): void {
    const workspaceId = normalizeScopeId(scope.workspaceId);
    const params: unknown[] = [Date.now() - 14 * DAY_MS];
    const conditions = ["a.created_at >= ?"];
    if (workspaceId) {
      conditions.push("a.workspace_id = ?");
      params.push(workspaceId);
    }
    const activities = this.db
      .prepare(
        `SELECT a.*, w.name AS workspace_name, ar.display_name AS agent_name
         FROM activity_feed a
         LEFT JOIN workspaces w ON w.id = a.workspace_id
         LEFT JOIN agent_roles ar ON ar.id = a.agent_role_id
         WHERE ${conditions.join(" AND ")}
         ORDER BY a.created_at DESC
         LIMIT 240`,
      )
      .all(...params) as ActivityRow[];

    const toolGroups = new Map<string, ActivityRow[]>();
    for (const activity of activities) {
      if (hasRawToolShape(activity)) {
        const bucket = Math.floor(activity.created_at / HOUR_MS) * HOUR_MS;
        const key = `tools:${activity.workspace_id}:${activity.agent_role_id || "system"}:${bucket}`;
        const list = toolGroups.get(key) || [];
        list.push(activity);
        toolGroups.set(key, list);
        continue;
      }

      const category = activityCategory(activity);
      const severity = activitySeverity(activity);
      const text = activity.description
        ? `${activity.title} — ${activity.description}`
        : activity.title;
      const item = this.repo.upsertItem({
        fingerprint: `activity:${activity.id}`,
        category,
        severity,
        title: category === "learnings" ? "Cowork recorded a learning" : activity.title,
        summary: truncate(text, 220),
        decision:
          category === "reviews" && severity === "monitor_only" ? "No action needed." : undefined,
        nextStep: severity === "action_needed" ? "Review this item." : undefined,
        agentRoleId: activity.agent_role_id || undefined,
        agentName: activity.agent_name || undefined,
        workspaceId: activity.workspace_id,
        workspaceName: activity.workspace_name || undefined,
        taskId: activity.task_id || undefined,
        timestamp: activity.created_at,
      });
      this.repo.replaceEvidence(item.id, [
        {
          sourceType: "activity_feed",
          sourceId: activity.id,
          title: activity.title,
          summary: activity.description || undefined,
          payload: parseJson<Record<string, unknown>>(activity.metadata, {}),
          timestamp: activity.created_at,
        },
      ]);
    }

    for (const [key, group] of toolGroups.entries()) {
      const newest = group[0];
      const toolNames = Array.from(
        new Set(
          group
            .map(
              (activity) =>
                `${activity.title} ${activity.description || ""}`.match(
                  /(?:tool used|Tool used)\s*[–-]\s*([A-Za-z0-9_:-]+)/,
                )?.[1],
            )
            .filter(Boolean),
        ),
      ) as string[];
      const item = this.repo.upsertItem({
        fingerprint: key,
        category: "evidence",
        severity: "monitor_only",
        title: "Tool activity captured",
        summary: `${group.length} low-level tool events${toolNames.length ? `: ${toolNames.slice(0, 4).join(", ")}` : ""}.`,
        decision: "Stored as evidence, not an operator action.",
        nextStep: "Expand evidence only when debugging a run.",
        agentRoleId: newest.agent_role_id || undefined,
        agentName: newest.agent_name || undefined,
        workspaceId: newest.workspace_id,
        workspaceName: newest.workspace_name || undefined,
        timestamp: newest.created_at,
      });
      this.repo.replaceEvidence(
        item.id,
        group.slice(0, 40).map((activity) => ({
          sourceType: "activity_feed",
          sourceId: activity.id,
          title: activity.title,
          summary: activity.description || undefined,
          payload: parseJson<Record<string, unknown>>(activity.metadata, {}),
          timestamp: activity.created_at,
        })),
      );
    }
  }

  private refreshHeartbeatRuns(scope: MissionControlScopeRequest): void {
    const workspaceId = normalizeScopeId(scope.workspaceId);
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (workspaceId) {
      conditions.push("r.workspace_id = ?");
      params.push(workspaceId);
    }
    const rows = this.db
      .prepare(
        `SELECT r.*, w.name AS workspace_name, ar.display_name AS agent_name
         FROM heartbeat_runs r
         LEFT JOIN workspaces w ON w.id = r.workspace_id
         LEFT JOIN agent_roles ar ON ar.id = r.agent_role_id
         ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
         ORDER BY r.updated_at DESC
         LIMIT 120`,
      )
      .all(...params) as HeartbeatRunRow[];

    const eventStmt = this.db.prepare(
      "SELECT * FROM heartbeat_run_events WHERE run_id = ? ORDER BY timestamp DESC LIMIT 40",
    );
    for (const run of rows) {
      const failed = run.status === "failed";
      const running = run.status === "running" || run.status === "queued";
      const title = failed
        ? "Background review failed"
        : running
          ? "Background review running"
          : "Background review completed";
      const summary = truncate(
        run.summary || run.reason || humanize(run.dispatch_kind || run.run_type),
        200,
      );
      const item = this.repo.upsertItem({
        fingerprint: `heartbeat-run:${run.id}`,
        category: failed ? "attention" : "reviews",
        severity: failed ? "failed" : running ? "monitor_only" : "successful",
        title,
        summary: summary || `Review ${humanize(run.status)}.`,
        decision: failed
          ? run.error || "Review did not complete."
          : running
            ? "Review is still in progress."
            : "Review completed.",
        nextStep: failed
          ? "Inspect evidence and retry if needed."
          : "Next review will run on schedule or when new signals arrive.",
        agentRoleId: run.agent_role_id || undefined,
        agentName: run.agent_name || undefined,
        workspaceId: run.workspace_id || undefined,
        workspaceName: run.workspace_name || undefined,
        taskId: run.task_id || undefined,
        issueId: run.issue_id || undefined,
        runId: run.id,
        timestamp: run.completed_at || run.updated_at || run.created_at,
      });
      const events = eventStmt.all(run.id) as Any[];
      this.repo.replaceEvidence(item.id, [
        {
          sourceType: "heartbeat_run",
          sourceId: run.id,
          title: title,
          summary: run.summary || run.error || run.reason || undefined,
          payload: run as unknown as Record<string, unknown>,
          timestamp: run.updated_at,
        },
        ...events.map((event) => ({
          sourceType: "heartbeat_event" as const,
          sourceId: event.id,
          title: humanize(event.type) || "Heartbeat event",
          summary: truncate(event.payload, 180),
          payload: parseJson<Record<string, unknown>>(event.payload, {}),
          timestamp: Number(event.timestamp),
        })),
      ]);
    }
  }

  private refreshCoreMemory(scope: MissionControlScopeRequest): void {
    const workspaceId = normalizeScopeId(scope.workspaceId);
    const workspaceCondition = workspaceId ? "WHERE workspace_id = ?" : "";
    const params = workspaceId ? [workspaceId] : [];
    const candidates = this.db
      .prepare(
        `SELECT * FROM core_memory_candidates ${workspaceCondition}
         ORDER BY created_at DESC LIMIT 80`,
      )
      .all(...params) as Any[];
    for (const candidate of candidates) {
      const accepted = candidate.status === "accepted" || candidate.status === "merged";
      const item = this.repo.upsertItem({
        fingerprint: `memory-candidate:${candidate.id}`,
        category: "learnings",
        severity: accepted ? "successful" : "monitor_only",
        title: accepted ? "Cowork saved a learning" : "Cowork proposed a learning",
        summary: truncate(candidate.summary, 220),
        decision: accepted
          ? "Learning is available for future work."
          : "Learning is waiting for review or more evidence.",
        nextStep: accepted ? undefined : "Review the learning candidate if it matters.",
        workspaceId: candidate.workspace_id || undefined,
        timestamp: Number(candidate.resolved_at || candidate.created_at),
      });
      this.repo.replaceEvidence(item.id, [
        {
          sourceType: "core_memory_candidate",
          sourceId: candidate.id,
          title: humanize(candidate.candidate_type) || "Memory candidate",
          summary: candidate.details || candidate.resolution || undefined,
          payload: candidate,
          timestamp: Number(candidate.created_at),
        },
      ]);
    }

    const distills = this.db
      .prepare(
        `SELECT * FROM core_memory_distill_runs ${workspaceCondition}
         ORDER BY started_at DESC LIMIT 40`,
      )
      .all(...params) as Any[];
    for (const run of distills) {
      const failed = run.status === "failed";
      const item = this.repo.upsertItem({
        fingerprint: `memory-distill:${run.id}`,
        category: failed ? "attention" : "learnings",
        severity: failed ? "failed" : run.status === "completed" ? "successful" : "monitor_only",
        title: failed ? "Learning distill failed" : "Cowork distilled learnings",
        summary: `${run.candidate_count || 0} candidates, ${run.accepted_count || 0} accepted, ${run.pruned_count || 0} pruned.`,
        decision: failed
          ? run.error || "Learning update did not complete."
          : "Learning state was consolidated.",
        nextStep: failed ? "Inspect the distill run evidence." : undefined,
        workspaceId: run.workspace_id || undefined,
        timestamp: Number(run.completed_at || run.started_at),
      });
      this.repo.replaceEvidence(item.id, [
        {
          sourceType: "core_memory_distill_run",
          sourceId: run.id,
          title: humanize(run.mode) || "Memory distill",
          summary: run.error || undefined,
          payload: run,
          timestamp: Number(run.started_at),
        },
      ]);
    }
  }

  private refreshSubconscious(scope: MissionControlScopeRequest): void {
    const workspaceId = normalizeScopeId(scope.workspaceId);
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (workspaceId) {
      conditions.push("r.workspace_id = ?");
      params.push(workspaceId);
    }
    const rows = this.db
      .prepare(
        `SELECT r.*, d.winner_summary, d.recommendation, d.rationale, d.outcome AS decision_outcome
         FROM subconscious_runs r
         LEFT JOIN subconscious_decisions d ON d.run_id = r.id
         ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
         ORDER BY r.created_at DESC
         LIMIT 80`,
      )
      .all(...params) as Any[];
    for (const run of rows) {
      const failed = Boolean(run.error || run.blocked_reason);
      const dispatched = Boolean(run.dispatch_kind);
      const item = this.repo.upsertItem({
        fingerprint: `subconscious-run:${run.id}`,
        category: failed ? "attention" : "awareness",
        severity: failed ? "failed" : dispatched ? "action_needed" : "monitor_only",
        title: failed ? "Awareness loop needs attention" : "Awareness reviewed background context",
        summary: truncate(run.winner_summary || run.evidence_summary || run.recommendation, 220),
        decision: truncate(run.recommendation || run.decision_outcome || run.outcome, 180),
        nextStep: failed
          ? run.blocked_reason || "Inspect the awareness evidence."
          : dispatched
            ? `Dispatch created: ${humanize(run.dispatch_kind)}`
            : "Keep monitoring until a stronger signal appears.",
        workspaceId: run.workspace_id || undefined,
        runId: run.id,
        timestamp: Number(run.completed_at || run.created_at),
      });
      this.repo.replaceEvidence(item.id, [
        {
          sourceType: "subconscious_run",
          sourceId: run.id,
          title: humanize(run.stage) || "Awareness run",
          summary: run.evidence_summary || undefined,
          payload: run,
          timestamp: Number(run.created_at),
        },
      ]);
    }
  }
}
