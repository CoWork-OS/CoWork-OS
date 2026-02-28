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
} from "../../shared/types";

interface EvalSuiteSummary extends EvalSuite {
  caseCount: number;
  latestRun?: Pick<EvalRun, "id" | "status" | "startedAt" | "completedAt" | "passCount" | "failCount">;
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

function normalizeTerminalStatus(task: { status?: string; terminal_status?: string | null }): Task["terminalStatus"] {
  const terminal = (task.terminal_status || "").trim();
  if (terminal === "ok" || terminal === "partial_success" || terminal === "failed") {
    return terminal;
  }
  if (task.status === "completed") return "ok";
  return "failed";
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
    const row = this.db.prepare("SELECT case_ids FROM eval_suites WHERE id = ?").get(suiteId) as Any;
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
        SELECT id, title, prompt, raw_prompt, user_prompt, status, workspace_id, terminal_status, result_summary
        FROM tasks
        WHERE id = ?
      `,
      )
      .get(taskId) as Any;

    if (!taskRow) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const promptSource = (taskRow.raw_prompt || taskRow.user_prompt || taskRow.prompt || "").toString();
    const sanitizedPrompt = sanitizeCorpusText(promptSource);
    const now = Date.now();
    const id = uuidv4();
    const terminalStatus = normalizeTerminalStatus(taskRow);

    const evalCase: EvalCase = {
      id,
      name: `${(taskRow.title || "task").toString().slice(0, 100)} [${taskRow.id.slice(0, 8)}]`,
      workspaceId: taskRow.workspace_id || undefined,
      sourceTaskId: taskRow.id,
      prompt: promptSource,
      sanitizedPrompt,
      assertions: {
        expectedTerminalStatus: "ok",
      },
      metadata: {
        extractedFromTaskStatus: taskRow.status,
        extractedFromTerminalStatus: terminalStatus,
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
    const status: EvalRun["status"] =
      failCount > 0 || executedCount === 0 ? "failed" : "completed";

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
        SELECT id, status, terminal_status, result_summary, workspace_id
        FROM tasks
        WHERE id = ?
      `,
      )
      .get(evalCase.sourceTaskId) as Any;

    if (!taskRow) {
      return { status: "skipped", details: "Source task no longer exists" };
    }

    const assertions = evalCase.assertions || {};
    const failures: string[] = [];

    if (assertions.expectedTerminalStatus) {
      const actual = normalizeTerminalStatus(taskRow);
      if (actual !== assertions.expectedTerminalStatus) {
        failures.push(
          `expected terminal_status=${assertions.expectedTerminalStatus}, actual=${actual}`,
        );
      }
    }

    const summary = (taskRow.result_summary || "").toString();
    const mustContainAll = Array.isArray(assertions.mustContainAll) ? assertions.mustContainAll : [];
    for (const needle of mustContainAll) {
      if (!needle) continue;
      if (!summary.toLowerCase().includes(needle.toLowerCase())) {
        failures.push(`missing required summary text: "${needle}"`);
      }
    }

    const mustCreatePaths = Array.isArray(assertions.mustCreatePaths) ? assertions.mustCreatePaths : [];
    if (mustCreatePaths.length > 0) {
      const eventRows = this.db
        .prepare(
          `
          SELECT id, task_id, timestamp, type, payload
          FROM task_events
          WHERE task_id = ?
          ORDER BY timestamp ASC
        `,
        )
        .all(taskRow.id) as Any[];

      const events: TaskEvent[] = eventRows.map((row) => ({
        id: row.id,
        taskId: row.task_id,
        timestamp: row.timestamp,
        type: row.type,
        payload: safeJsonParse(row.payload, {}),
      }));
      const changed = extractTaskChangedPaths(events);

      for (const mustCreatePath of mustCreatePaths) {
        if (!mustCreatePath) continue;
        const normalized = mustCreatePath.replace(/\\/g, "/");
        const found = Array.from(changed).some((candidate) => candidate.endsWith(normalized));
        if (!found) {
          failures.push(`missing required changed path: "${mustCreatePath}"`);
        }
      }
    }

    if (failures.length > 0) {
      return {
        status: "fail",
        details: failures.join("; "),
      };
    }
    return {
      status: "pass",
      details: "All deterministic assertions satisfied",
    };
  }

  getBaselineMetrics(windowDays = 30): EvalBaselineMetrics {
    const clampedDays = Number.isFinite(windowDays) ? Math.min(Math.max(Math.round(windowDays), 1), 365) : 30;
    const end = Date.now();
    const start = end - clampedDays * 24 * 60 * 60 * 1000;

    const taskRows = this.db
      .prepare(
        `
        SELECT id, status, terminal_status, current_attempt
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
    const verificationPassed = verificationEventRows.filter((row) => row.type === "verification_passed").length;
    const verificationFailed = verificationEventRows.filter((row) => row.type === "verification_failed").length;
    const verificationDenominator = verificationPassed + verificationFailed;
    const verificationPassRate =
      verificationDenominator > 0 ? verificationPassed / verificationDenominator : 0;

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
        failureRate: counts.calls > 0 ? counts.failures / counts.calls : counts.failures > 0 ? 1 : 0,
      }))
      .sort((a, b) => b.failureRate - a.failureRate || b.failures - a.failures || a.tool.localeCompare(b.tool));

    return {
      generatedAt: end,
      windowDays: clampedDays,
      taskSuccessRate,
      approvalDeadEndRate,
      verificationPassRate,
      retriesPerTask,
      toolFailureRateByTool,
    };
  }
}
