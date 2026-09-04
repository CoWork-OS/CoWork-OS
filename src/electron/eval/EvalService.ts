import type Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import type {
  EvalBaselineMetrics,
  EvalCase,
  EvalCaseRun,
  EvalRun,
  EvalSuite,
  Task,
  TaskEvent,
  WorkSessionItem,
  WorkSessionStatus,
  WorkSessionTurnStatus,
} from "../../shared/types";
import { WorkSessionProtocolRepository } from "../database/WorkSessionProtocolRepository";
import { mapTaskEventKind } from "../sessions/WorkSessionProtocolService";
import {
  evaluateIsolatedReplay,
  type WorkSessionReplayAssertions,
} from "../sessions/WorkSessionReplayEvaluationService";

interface EvalSuiteSummary extends EvalSuite {
  caseCount: number;
  latestRun?: Pick<
    EvalRun,
    "id" | "status" | "startedAt" | "completedAt" | "passCount" | "failCount"
  >;
}

function safeJsonParse<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function sanitizeCorpusText(raw: string): string {
  if (!raw) return "";
  const patterns: Array<[RegExp, string]> = [
    [/sk-[A-Za-z0-9_-]{12,}/g, "[REDACTED_API_KEY]"],
    [/ghp_[A-Za-z0-9]{20,}/g, "[REDACTED_GITHUB_TOKEN]"],
    [/xox[baprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED_SLACK_TOKEN]"],
    [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]"],
    [/\b\d{3}[-.\s]?\d{2,3}[-.\s]?\d{4}\b/g, "[REDACTED_PHONE]"],
    [/\b(?:\d[ -]*?){13,16}\b/g, "[REDACTED_NUMBER]"],
  ];
  let output = raw;
  for (const [pattern, replacement] of patterns) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

function normalizeTerminalStatus(task: {
  status?: string;
  terminal_status?: string | null;
}): Task["terminalStatus"] {
  const terminal = (task.terminal_status || "").trim();
  if (
    terminal === "ok" ||
    terminal === "partial_success" ||
    terminal === "needs_user_action" ||
    terminal === "failed"
  ) {
    return terminal;
  }
  if (task.status === "completed") return "ok";
  return "failed";
}

function replayStatusForAssertion(status: Task["terminalStatus"]): WorkSessionStatus | undefined {
  switch (status) {
    case "ok":
      return "completed";
    case "partial_success":
      return "partial_success";
    case "needs_user_action":
    case "awaiting_approval":
    case "awaiting_verification":
      return "waiting";
    case "resume_available":
      return "partial_success";
    case "failed":
      return "failed";
    default:
      return undefined;
  }
}

function replayStatusForTask(task: {
  status?: string;
  terminal_status?: string | null;
}): WorkSessionStatus | undefined {
  if (task.status === "cancelled") return "cancelled";
  const terminal = normalizeTerminalStatus(task);
  return replayStatusForAssertion(terminal);
}

function normalizeReplayItemStatus(value: unknown): WorkSessionTurnStatus | undefined {
  if (typeof value !== "string") return undefined;
  if (
    value === "pending" ||
    value === "executing" ||
    value === "waiting" ||
    value === "completed" ||
    value === "partial_success" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }
  if (value === "ok") return "completed";
  if (value === "blocked") return "waiting";
  return undefined;
}

function isSyntheticCanonicalItem(item: WorkSessionItem): boolean {
  if (item.sourceEventId) return false;
  const payload = item.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const event = (payload as Record<string, unknown>).event;
  return event === "session.created" || (typeof event === "string" && event.startsWith("turn."));
}

function extractTool(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "unknown";
  const tool = ((payload as Any).tool || (payload as Any).name || "unknown").toString().trim();
  return tool || "unknown";
}

function extractTaskChangedPaths(events: TaskEvent[]): Set<string> {
  const changed = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    const normalized = value.trim().replace(/\\/g, "/");
    if (!normalized) return;
    changed.add(normalized);
  };

  for (const event of events) {
    if (
      event.type !== "file_created" &&
      event.type !== "file_modified" &&
      event.type !== "file_deleted" &&
      event.type !== "artifact_created"
    ) {
      continue;
    }
    add(event.payload?.path);
    add(event.payload?.from);
    add(event.payload?.to);
  }
  return changed;
}

export class EvalService {
  constructor(private db: Database.Database) {}

  private mapEvalCase(row: Any): EvalCase {
    return {
      id: row.id,
      name: row.name,
      workspaceId: row.workspace_id || undefined,
      sourceTaskId: row.source_task_id || undefined,
      prompt: row.prompt,
      sanitizedPrompt: row.sanitized_prompt,
      assertions: row.assertions
        ? safeJsonParse<EvalCase["assertions"]>(row.assertions, undefined)
        : undefined,
      metadata: row.metadata ? safeJsonParse<Record<string, unknown>>(row.metadata, {}) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapEvalSuite(row: Any): EvalSuite {
    return {
      id: row.id,
      name: row.name,
      description: row.description || undefined,
      caseIds: safeJsonParse<string[]>(row.case_ids, []),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapEvalRun(row: Any): EvalRun {
    return {
      id: row.id,
      suiteId: row.suite_id,
      status: row.status as EvalRun["status"],
      startedAt: row.started_at,
      completedAt: row.completed_at || undefined,
      passCount: Number(row.pass_count) || 0,
      failCount: Number(row.fail_count) || 0,
      skippedCount: Number(row.skipped_count) || 0,
      metadata: row.metadata ? safeJsonParse<Record<string, unknown>>(row.metadata, {}) : undefined,
    };
  }

  private mapEvalCaseRun(row: Any): EvalCaseRun {
    return {
      id: row.id,
      runId: row.run_id,
      caseId: row.case_id,
      status: row.status as EvalCaseRun["status"],
      details: row.details || undefined,
      startedAt: row.started_at,
      completedAt: row.completed_at || undefined,
      durationMs: row.duration_ms || undefined,
    };
  }

  private getOrCreateDefaultSuiteId(): string {
    const existing = this.db
      .prepare("SELECT id FROM eval_suites WHERE name = ? LIMIT 1")
      .get("reliability-regressions") as Any;
    if (existing?.id) return existing.id;

    const now = Date.now();
    const id = uuidv4();
    this.db
      .prepare(
        `
        INSERT INTO eval_suites (id, name, description, case_ids, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        id,
        "reliability-regressions",
        "Auto-generated regression corpus from failed or partial tasks",
        JSON.stringify([]),
        now,
        now,
      );
    return id;
  }

  private addCaseToSuite(suiteId: string, caseId: string): void {
    const row = this.db
      .prepare("SELECT case_ids FROM eval_suites WHERE id = ?")
      .get(suiteId) as Any;
    if (!row) return;
    const current = safeJsonParse<string[]>(row.case_ids, []);
    if (current.includes(caseId)) return;
    current.push(caseId);
    this.db
      .prepare("UPDATE eval_suites SET case_ids = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(current), Date.now(), suiteId);
  }

  listSuites(): EvalSuiteSummary[] {
    const rows = this.db
      .prepare(
        `
        SELECT id, name, description, case_ids, created_at, updated_at
        FROM eval_suites
        ORDER BY updated_at DESC
      `,
      )
      .all() as Any[];

    return rows.map((row) => {
      const suite = this.mapEvalSuite(row);
      const latestRunRow = this.db
        .prepare(
          `
          SELECT id, status, started_at, completed_at, pass_count, fail_count
          FROM eval_runs
          WHERE suite_id = ?
          ORDER BY started_at DESC
          LIMIT 1
        `,
        )
        .get(suite.id) as Any;
      return {
        ...suite,
        caseCount: suite.caseIds.length,
        latestRun: latestRunRow
          ? {
              id: latestRunRow.id,
              status: latestRunRow.status,
              startedAt: latestRunRow.started_at,
              completedAt: latestRunRow.completed_at || undefined,
              passCount: Number(latestRunRow.pass_count) || 0,
              failCount: Number(latestRunRow.fail_count) || 0,
            }
          : undefined,
      };
    });
  }

  getCase(caseId: string): EvalCase | null {
    const row = this.db.prepare("SELECT * FROM eval_cases WHERE id = ?").get(caseId) as Any;
    return row ? this.mapEvalCase(row) : null;
  }

  getRun(runId: string): (EvalRun & { caseRuns: EvalCaseRun[] }) | null {
    const runRow = this.db.prepare("SELECT * FROM eval_runs WHERE id = ?").get(runId) as Any;
    if (!runRow) return null;
    const caseRunRows = this.db
      .prepare("SELECT * FROM eval_case_runs WHERE run_id = ? ORDER BY started_at ASC")
      .all(runId) as Any[];
    return {
      ...this.mapEvalRun(runRow),
      caseRuns: caseRunRows.map((row) => this.mapEvalCaseRun(row)),
    };
  }

  createCaseFromTask(taskId: string): EvalCase {
    const taskRow = this.db
      .prepare(
        `
        SELECT id, title, prompt, raw_prompt, user_prompt, status, workspace_id, terminal_status, failure_class, error, result_summary
        FROM tasks
        WHERE id = ?
      `,
      )
      .get(taskId) as Any;

    if (!taskRow) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const promptSource = (
      taskRow.raw_prompt ||
      taskRow.user_prompt ||
      taskRow.prompt ||
      ""
    ).toString();
    const sanitizedPrompt = sanitizeCorpusText(promptSource);
    const now = Date.now();
    const id = uuidv4();
    const terminalStatus = normalizeTerminalStatus(taskRow);
    const eventRows = this.db
      .prepare(
        `
        SELECT type, payload
        FROM task_events
        WHERE task_id = ?
      `,
      )
      .all(taskId) as Array<{ type: string; payload: string }>;
    const eventText = eventRows
      .map((row) => `${row.type} ${String(row.payload || "")}`)
      .join("\n")
      .toLowerCase();
    const reliabilityTags = new Set<string>();
    const failureClass = String(taskRow.failure_class || "").toLowerCase();
    const errorText = String(taskRow.error || "").toLowerCase();
    const summaryText = String(taskRow.result_summary || "").toLowerCase();
    const combined = `${failureClass}\n${errorText}\n${summaryText}\n${eventText}`;
    if (
      /contract_unmet_write_required|artifact_write_checkpoint_failed|required artifact mutation/.test(
        combined,
      )
    ) {
      reliabilityTags.add("contract_unmet_write_required");
    }
    if (/missing_required_workspace_artifact/.test(combined)) {
      reliabilityTags.add("missing_required_workspace_artifact");
    }
    if (
      /verification failed|does \*\*not\*\* pass the completion criteria|required verification|platform minimums not met/.test(
        combined,
      )
    ) {
      reliabilityTags.add("verification_required_fail");
    }
    if (
      /dependency_unavailable|external_unknown|getaddrinfo|enotfound|err_network|opening handshake has timed out|status:\s*408/.test(
        combined,
      )
    ) {
      reliabilityTags.add("dependency_unavailable");
    }
    const reliabilityTagList = Array.from(reliabilityTags.values());

    const evalCase: EvalCase = {
      id,
      name: `${(taskRow.title || "task").toString().slice(0, 100)} [${taskRow.id.slice(0, 8)}]`,
      workspaceId: taskRow.workspace_id || undefined,
      sourceTaskId: taskRow.id,
      prompt: promptSource,
      sanitizedPrompt,
      assertions: {
        expectedTerminalStatus: "ok",
        mustContainAll: reliabilityTagList.length > 0 ? reliabilityTagList : undefined,
      },
      metadata: {
        extractedFromTaskStatus: taskRow.status,
        extractedFromTerminalStatus: terminalStatus,
        extractedFromFailureClass: taskRow.failure_class || null,
        reliabilityTags: reliabilityTagList,
        extractedAt: new Date(now).toISOString(),
      },
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `
        INSERT INTO eval_cases (
          id, name, workspace_id, source_task_id, prompt, sanitized_prompt, assertions, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        evalCase.id,
        evalCase.name,
        evalCase.workspaceId || null,
        evalCase.sourceTaskId || null,
        evalCase.prompt,
        evalCase.sanitizedPrompt,
        JSON.stringify(evalCase.assertions || {}),
        JSON.stringify(evalCase.metadata || {}),
        evalCase.createdAt,
        evalCase.updatedAt,
      );

    this.db
      .prepare("UPDATE tasks SET eval_case_id = ?, updated_at = ? WHERE id = ?")
      .run(evalCase.id, Date.now(), taskId);

    const suiteId = this.getOrCreateDefaultSuiteId();
    this.addCaseToSuite(suiteId, evalCase.id);

    return evalCase;
  }

  runSuite(suiteId: string): EvalRun {
    const suiteRow = this.db.prepare("SELECT * FROM eval_suites WHERE id = ?").get(suiteId) as Any;
    if (!suiteRow) {
      throw new Error(`Eval suite not found: ${suiteId}`);
    }
    const suite = this.mapEvalSuite(suiteRow);
    const startedAt = Date.now();
    const runId = uuidv4();

    this.db
      .prepare(
        `
        INSERT INTO eval_runs (id, suite_id, status, started_at, pass_count, fail_count, skipped_count, metadata)
        VALUES (?, ?, 'running', ?, 0, 0, 0, ?)
      `,
      )
      .run(
        runId,
        suite.id,
        startedAt,
        JSON.stringify({
          mode: "local_deterministic",
          caseCount: suite.caseIds.length,
        }),
      );

    let passCount = 0;
    let failCount = 0;
    let skippedCount = 0;
    for (const caseId of suite.caseIds) {
      const caseDef = this.getCase(caseId);
      const caseRunStartedAt = Date.now();

      if (!caseDef) {
        skippedCount += 1;
        this.db
          .prepare(
            `
            INSERT INTO eval_case_runs (
              id, run_id, case_id, status, details, started_at, completed_at, duration_ms
            ) VALUES (?, ?, ?, 'skipped', ?, ?, ?, ?)
          `,
          )
          .run(
            uuidv4(),
            runId,
            caseId,
            "Missing eval case definition",
            caseRunStartedAt,
            Date.now(),
            Date.now() - caseRunStartedAt,
          );
        continue;
      }

      const verdict = this.evaluateCaseAgainstTask(caseDef);
      if (verdict.status === "pass") passCount += 1;
      if (verdict.status === "fail") failCount += 1;
      if (verdict.status === "skipped") skippedCount += 1;

      this.db
        .prepare(
          `
          INSERT INTO eval_case_runs (
            id, run_id, case_id, status, details, started_at, completed_at, duration_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          uuidv4(),
          runId,
          caseDef.id,
          verdict.status,
          verdict.details,
          caseRunStartedAt,
          Date.now(),
          Date.now() - caseRunStartedAt,
        );
    }

    const executedCount = passCount + failCount;
    const completedAt = Date.now();
    const status: EvalRun["status"] = failCount > 0 || executedCount === 0 ? "failed" : "completed";

    this.db
      .prepare(
        `
        UPDATE eval_runs
        SET status = ?, completed_at = ?, pass_count = ?, fail_count = ?, skipped_count = ?
        WHERE id = ?
      `,
      )
      .run(status, completedAt, passCount, failCount, skippedCount, runId);

    const completedRun = this.getRun(runId);
    if (!completedRun) {
      throw new Error(`Failed to load eval run after execution: ${runId}`);
    }
    return completedRun;
  }

  private evaluateCaseAgainstTask(evalCase: EvalCase): {
    status: "pass" | "fail" | "skipped";
    details: string;
  } {
    if (!evalCase.sourceTaskId) {
      return { status: "skipped", details: "No source task linked to eval case" };
    }

    const taskRow = this.db
      .prepare(
        `
        SELECT id, status, terminal_status, result_summary, workspace_id, session_id
        FROM tasks
        WHERE id = ?
      `,
      )
      .get(evalCase.sourceTaskId) as Any;

    if (!taskRow) {
      return { status: "skipped", details: "Source task no longer exists" };
    }

    const items = this.loadReplayItems(taskRow.id, taskRow.session_id);
    const assertions = evalCase.assertions || {};
    const replayAssertions: WorkSessionReplayAssertions = {
      ...(assertions.expectedTerminalStatus
        ? { expectedTerminalStatus: replayStatusForAssertion(assertions.expectedTerminalStatus) }
        : {}),
      ...(Array.isArray(assertions.mustContainAll)
        ? { mustContainAll: assertions.mustContainAll }
        : {}),
      ...(Array.isArray(assertions.mustCreatePaths)
        ? { mustCreatePaths: assertions.mustCreatePaths }
        : {}),
    };
    const replay = evaluateIsolatedReplay(items, {
      fixtureId: `eval:${evalCase.id}`,
      assertions: replayAssertions,
    });
    const failures = [...replay.findings];
    const snapshotStatus = replayStatusForTask(taskRow);
    if (
      items.length > 0 &&
      replay.replayStatus &&
      snapshotStatus &&
      ["completed", "failed", "cancelled"].includes(String(taskRow.status)) &&
      replay.replayStatus !== snapshotStatus
    ) {
      failures.push(
        `snapshot/replay status mismatch: snapshot=${snapshotStatus}, replay=${replay.replayStatus}`,
      );
    }

    return {
      status: failures.length === 0 ? "pass" : "fail",
      details:
        `isolated replay ${replay.passed ? "passed" : "failed"} (${replay.itemCount} items; ` +
        `incremental=${replay.incrementalChecksum.slice(0, 12)}, full=${replay.fullRebuildChecksum.slice(0, 12)})` +
        (failures.length > 0 ? `; ${[...new Set(failures)].join("; ")}` : ""),
    };
  }

  /**
   * Load a replay fixture without calling ensure/backfill.  Evaluation must be
   * isolated: grading a task cannot mutate its canonical stream or silently
   * turn a snapshot read into the source of truth.
   */
  private loadReplayItems(taskId: string, taskSessionId?: string | null): WorkSessionItem[] {
    const protocol = new WorkSessionProtocolRepository(this.db);
    const boundSessionId =
      protocol.findSessionIdForTask(taskId) ||
      (typeof taskSessionId === "string" && taskSessionId.trim()
        ? taskSessionId.trim()
        : undefined) ||
      (
        this.db
          .prepare(
            "SELECT id FROM work_sessions WHERE task_id = ? ORDER BY updated_at DESC LIMIT 1",
          )
          .get(taskId) as { id?: string } | undefined
      )?.id;
    if (boundSessionId) {
      const canonical = protocol.listAllItems(boundSessionId);
      if (canonical.length > 0) {
        const replayCanonical = canonical.filter((item) => !isSyntheticCanonicalItem(item));
        // A session can be observed between creation of its synthetic root
        // item and completion of the legacy backfill.  Do not grade that
        // partial canonical stream as if it were complete: compare source
        // event ids first and fall back to the immutable legacy event rows
        // when any persisted event is still missing from vNext.
        const legacyEventIds = this.db
          .prepare(
            `SELECT id, event_id
             FROM task_events
             WHERE task_id = ? AND type <> 'llm_streaming'`,
          )
          .all(taskId) as Array<{ id?: unknown; event_id?: unknown }>;
        const canonicalEventIds = new Set<string>();
        for (const item of canonical) {
          if (item.sourceEventId) canonicalEventIds.add(String(item.sourceEventId));
          const payload = item.payload;
          if (payload && typeof payload === "object" && !Array.isArray(payload)) {
            const eventId = (payload as Record<string, unknown>).eventId;
            if (typeof eventId === "string" && eventId.trim()) {
              canonicalEventIds.add(eventId.trim());
            }
          }
        }
        const canonicalComplete = legacyEventIds.every((row) => {
          const eventId =
            typeof row.event_id === "string" && row.event_id.trim()
              ? row.event_id.trim()
              : typeof row.id === "string"
                ? row.id
                : "";
          return !eventId || canonicalEventIds.has(eventId);
        });
        // A synthetic session/turn root is bookkeeping, not replay evidence.
        // Do not let a newly-created session with no persisted task events
        // pass evaluation merely because that root item exists.
        if (canonicalComplete && replayCanonical.length > 0) return canonical;
      }
    }

    const rows = this.db
      .prepare(
        `SELECT id, task_id, timestamp, type, legacy_type, payload, schema_version,
                event_id, seq, status, actor
         FROM task_events
         WHERE task_id = ? AND type <> 'llm_streaming'
         ORDER BY COALESCE(seq, timestamp) ASC, timestamp ASC, id ASC`,
      )
      .all(taskId) as Any[];
    return rows.map((row, index) => {
      const payload = safeJsonParse<Record<string, unknown>>(row.payload, {});
      const sourceType =
        typeof row.legacy_type === "string" && row.legacy_type.trim()
          ? row.legacy_type.trim()
          : String(row.type || "legacy_event");
      const sequence =
        typeof row.seq === "number" && Number.isFinite(row.seq)
          ? Math.max(1, Math.floor(row.seq))
          : index + 1;
      return {
        id: String(row.id),
        sessionId: boundSessionId || `legacy:${taskId}`,
        turnId: `legacy-turn:${taskId}`,
        sequence,
        kind: mapTaskEventKind(sourceType),
        actor:
          typeof row.actor === "string" && row.actor.trim()
            ? row.actor.trim()
            : sourceType === "user_message"
              ? "user"
              : sourceType.startsWith("tool_")
                ? "tool"
                : "agent",
        payload: {
          eventType: sourceType,
          sourceType: row.type,
          eventId: row.event_id || row.id,
          timestamp: Number(row.timestamp || 0),
          ...(typeof row.seq === "number" ? { seq: row.seq } : {}),
          payload,
        },
        redactionClass: "standard",
        ...(normalizeReplayItemStatus(row.status)
          ? { status: normalizeReplayItemStatus(row.status) }
          : {}),
        sourceEventId:
          typeof row.event_id === "string" && row.event_id ? row.event_id : String(row.id),
        createdAt: Number(row.timestamp || 0),
      } satisfies WorkSessionItem;
    });
  }

  getBaselineMetrics(windowDays = 30): EvalBaselineMetrics {
    const clampedDays = Number.isFinite(windowDays)
      ? Math.min(Math.max(Math.round(windowDays), 1), 365)
      : 30;
    const end = Date.now();
    const start = end - clampedDays * 24 * 60 * 60 * 1000;

    const taskRows = this.db
      .prepare(
        `
        SELECT id, status, terminal_status, failure_class, current_attempt
        FROM tasks
        WHERE created_at >= ?
          AND (parent_task_id IS NULL OR parent_task_id = '')
      `,
      )
      .all(start) as Any[];

    const totalTasks = taskRows.length;
    const successfulTasks = taskRows.filter(
      (task) => task.status === "completed" && normalizeTerminalStatus(task) === "ok",
    ).length;
    const taskSuccessRate = totalTasks > 0 ? successfulTasks / totalTasks : 0;

    const totalRetryCount = taskRows.reduce((sum, task) => {
      const attempt = Number(task.current_attempt) || 1;
      return sum + Math.max(0, attempt - 1);
    }, 0);
    const retriesPerTask = totalTasks > 0 ? totalRetryCount / totalTasks : 0;

    const pendingApprovalRows = this.db
      .prepare(
        `
        SELECT DISTINCT task_id
        FROM approvals
        WHERE status = 'pending'
          AND requested_at >= ?
      `,
      )
      .all(start) as Any[];
    const approvalDeadEndRate = totalTasks > 0 ? pendingApprovalRows.length / totalTasks : 0;

    const verificationEventRows = this.db
      .prepare(
        `
        SELECT type
        FROM task_events
        WHERE timestamp >= ?
          AND type IN ('verification_passed', 'verification_failed')
      `,
      )
      .all(start) as Any[];
    const verificationPassed = verificationEventRows.filter(
      (row) => row.type === "verification_passed",
    ).length;
    const verificationFailed = verificationEventRows.filter(
      (row) => row.type === "verification_failed",
    ).length;
    const verificationDenominator = verificationPassed + verificationFailed;
    const verificationPassRate =
      verificationDenominator > 0 ? verificationPassed / verificationDenominator : 0;

    const terminalTasks = taskRows.filter(
      (task) =>
        task.status === "completed" || task.status === "failed" || task.status === "cancelled",
    );
    const terminalTotal = terminalTasks.length;
    const coreOkCount = terminalTasks.filter(
      (task) => normalizeTerminalStatus(task) === "ok",
    ).length;
    const corePartialCount = terminalTasks.filter(
      (task) =>
        normalizeTerminalStatus(task) === "partial_success" ||
        normalizeTerminalStatus(task) === "needs_user_action",
    ).length;
    const dependencyIssueCount = terminalTasks.filter((task) =>
      /dependency_unavailable|external_unknown|tool_error|provider_quota/i.test(
        String(task.failure_class || ""),
      ),
    ).length;
    const verificationBlockCount = terminalTasks.filter((task) =>
      /required_verification/i.test(String(task.failure_class || "")),
    ).length;
    const artifactContractFailureCount = terminalTasks.filter((task) =>
      /contract_unmet_write_required|required_contract|contract_error/i.test(
        String(task.failure_class || ""),
      ),
    ).length;
    const agentCoreSuccessRate =
      terminalTotal > 0 ? (coreOkCount + corePartialCount) / terminalTotal : 0;
    const dependencyAvailabilityRate =
      terminalTotal > 0 ? (terminalTotal - dependencyIssueCount) / terminalTotal : 0;
    const verificationBlockRate = terminalTotal > 0 ? verificationBlockCount / terminalTotal : 0;
    const artifactContractFailureRate =
      terminalTotal > 0 ? artifactContractFailureCount / terminalTotal : 0;

    const toolCallRows = this.db
      .prepare(
        `
        SELECT type, payload
        FROM task_events
        WHERE timestamp >= ?
          AND type IN ('tool_call', 'tool_error')
      `,
      )
      .all(start) as Any[];

    const toolCounts = new Map<string, { calls: number; failures: number }>();
    for (const row of toolCallRows) {
      const payload = safeJsonParse<Record<string, unknown>>(row.payload, {});
      const tool = extractTool(payload);
      const current = toolCounts.get(tool) || { calls: 0, failures: 0 };
      if (row.type === "tool_call") current.calls += 1;
      if (row.type === "tool_error") current.failures += 1;
      toolCounts.set(tool, current);
    }
    const toolFailureRateByTool = Array.from(toolCounts.entries())
      .map(([tool, counts]) => ({
        tool,
        calls: counts.calls,
        failures: counts.failures,
        failureRate:
          counts.calls > 0 ? counts.failures / counts.calls : counts.failures > 0 ? 1 : 0,
      }))
      .sort(
        (a, b) =>
          b.failureRate - a.failureRate || b.failures - a.failures || a.tool.localeCompare(b.tool),
      );

    return {
      generatedAt: end,
      windowDays: clampedDays,
      taskSuccessRate,
      approvalDeadEndRate,
      verificationPassRate,
      agentCoreSuccessRate,
      dependencyAvailabilityRate,
      verificationBlockRate,
      artifactContractFailureRate,
      retriesPerTask,
      toolFailureRateByTool,
    };
  }
}
