import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const runnerScript = path.join(repoRoot, "scripts/qa/run_eval_suite.cjs");
const tempDirs: string[] = [];

type RunnerResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
};

type EvalCaseSeed = {
  id: string;
  name?: string;
  sourceTaskId?: string | null;
  prompt?: string;
};

type HookServer = {
  origin: string;
  server: http.Server;
  triggerHits: number;
  approvalHits: number;
};

function createTempDb(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-qa-eval-runner-"));
  tempDirs.push(tempDir);
  return path.join(tempDir, "eval.db");
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function runSql(dbPath: string, sql: string): void {
  execFileSync("sqlite3", ["-batch", dbPath, sql], { stdio: "pipe" });
}

function querySql(dbPath: string, sql: string): string {
  return execFileSync("sqlite3", ["-batch", dbPath, sql], {
    encoding: "utf8",
  }).trim();
}

function seedEvalDb(
  dbPath: string,
  options: { suiteName?: string; suiteId?: string; caseIds: string[]; cases?: EvalCaseSeed[] },
): void {
  const suiteName = options.suiteName || "test-suite";
  const suiteId = options.suiteId || "suite-1";
  const now = Date.now();
  const statements = [
    `CREATE TABLE eval_suites (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      case_ids TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE eval_cases (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      workspace_id TEXT,
      source_task_id TEXT,
      prompt TEXT NOT NULL,
      sanitized_prompt TEXT NOT NULL,
      assertions TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `INSERT INTO eval_suites
      (id, name, description, case_ids, created_at, updated_at)
      VALUES (${sqlLiteral(suiteId)}, ${sqlLiteral(suiteName)}, 'test',
        ${sqlLiteral(JSON.stringify(options.caseIds))}, ${now}, ${now})`,
  ];

  for (const evalCase of options.cases || []) {
    const name = evalCase.name || evalCase.id;
    const prompt = evalCase.prompt || "replay this evaluation case";
    const sourceTask = evalCase.sourceTaskId == null ? "NULL" : sqlLiteral(evalCase.sourceTaskId);
    statements.push(
      `INSERT INTO eval_cases
        (id, name, workspace_id, source_task_id, prompt, sanitized_prompt, assertions, metadata, created_at, updated_at)
        VALUES (${sqlLiteral(evalCase.id)}, ${sqlLiteral(name)}, NULL, ${sourceTask},
          ${sqlLiteral(prompt)}, ${sqlLiteral(prompt)}, '{}', '{}', ${now}, ${now})`,
    );
  }

  runSql(dbPath, `${statements.join(";\n")};`);
}

function runRunner(args: string[], env: Record<string, string> = {}): Promise<RunnerResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [runnerScript, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({
        code,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

async function startHookServer(
  dbPath: string,
  options: { hangTrigger?: boolean; resolveApproval?: boolean } = {},
): Promise<HookServer> {
  let triggerHits = 0;
  let approvalHits = 0;
  const server = http.createServer((request, response) => {
    if (request.method !== "POST") {
      response.statusCode = 404;
      response.end();
      return;
    }

    request.resume();
    request.once("end", () => {
      if (request.url === "/hooks/agent") {
        triggerHits += 1;
        if (options.hangTrigger) return;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ taskId: "hook-task-1" }));
        return;
      }

      if (request.url === "/hooks/approval/respond") {
        approvalHits += 1;
        if (options.resolveApproval) {
          runSql(
            dbPath,
            "UPDATE approvals SET status='resolved' WHERE id='approval-1'; " +
              "UPDATE tasks SET status='completed', terminal_status='completed' WHERE id='hook-task-1';",
          );
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }

      response.statusCode = 404;
      response.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("hook server did not bind");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    server,
    get triggerHits() {
      return triggerHits;
    },
    get approvalHits() {
      return approvalHits;
    },
  };
}

async function stopHookServer(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("evaluation runner evidence boundaries", () => {
  it("runs fixtures-only without opening or creating the application database", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-qa-eval-fixtures-"));
    tempDirs.push(tempDir);
    const invalidDbPath = path.join(tempDir, "missing", "app.db");

    const result = await runRunner(["--fixtures-only"], { COWORK_DB_PATH: invalidDbPath });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("scope: fixtures-only");
    expect(result.stdout).toContain("fixture pass: 6");
    expect(result.stdout).toContain("selected coverage: 0/0 (fixtures-only)");
    expect(fs.existsSync(invalidDbPath)).toBe(false);
  });

  it("rejects invalid options and contradictory fixture selectors", async () => {
    const invalidMode = await runRunner(["--mode", "livemode"], {
      COWORK_DB_PATH: "/tmp/cowork-qa-invalid-mode.db",
    });
    expect(invalidMode.code).toBe(1);
    expect(invalidMode.stderr).toContain("unsupported mode: livemode");

    const contradictoryMode = await runRunner(["--fixtures-only", "--mode", "hooks"]);
    expect(contradictoryMode.code).toBe(1);
    expect(contradictoryMode.stderr).toContain("--fixtures-only cannot be combined");

    const unknownOption = await runRunner(["--fixtures-only", "--fixture-only"]);
    expect(unknownOption.code).toBe(1);
    expect(unknownOption.stderr).toContain("unknown option: --fixture-only");
  });

  it("fails a missing suite without creating a placeholder suite", async () => {
    const dbPath = createTempDb();

    const result = await runRunner(["--suite", "does-not-exist"], { COWORK_DB_PATH: dbPath });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("suite not found: does-not-exist");
    expect(querySql(dbPath, "SELECT COUNT(*) FROM eval_suites;")).toBe("0");
  });

  it("fails suites with dangling case IDs instead of silently shrinking selection", async () => {
    const dbPath = createTempDb();
    seedEvalDb(dbPath, { caseIds: ["case-missing"] });

    const result = await runRunner(["--suite", "test-suite"], { COWORK_DB_PATH: dbPath });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("references missing eval case(s): case-missing");
    expect(querySql(dbPath, "SELECT COUNT(*) FROM eval_runs;")).toBe("0");
  });

  it("reports skipped selected cases as zero coverage and only allows that with an explicit flag", async () => {
    const dbPath = createTempDb();
    seedEvalDb(dbPath, {
      caseIds: ["case-skipped"],
      cases: [{ id: "case-skipped", sourceTaskId: "task-not-found" }],
    });
    runSql(
      dbPath,
      `CREATE TABLE tasks (
         id TEXT PRIMARY KEY,
         status TEXT,
         terminal_status TEXT,
         result_summary TEXT,
         workspace_id TEXT
       );`,
    );

    const failed = await runRunner(["--suite", "test-suite"], { COWORK_DB_PATH: dbPath });
    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain("selected cases: 1");
    expect(failed.stdout).toContain("selected skipped: 1");
    expect(failed.stdout).toContain("selected executed: 0");
    expect(failed.stdout).toContain("selected coverage: 0/1");
    expect(failed.stdout).toContain("status: failed");
    expect(
      querySql(
        dbPath,
        "SELECT status || ',' || pass_count || ',' || fail_count || ',' || skipped_count FROM eval_runs ORDER BY started_at DESC LIMIT 1;",
      ),
    ).toBe("failed,0,0,1");

    const allowed = await runRunner(["--suite", "test-suite", "--allow-empty"], {
      COWORK_DB_PATH: dbPath,
    });
    expect(allowed.code).toBe(0);
    expect(allowed.stdout).toContain("status: skipped");
    expect(allowed.stdout).toContain("explicitly allowed; no evaluated coverage");
  });

  it("bounds a hook trigger that never sends an HTTP response", async () => {
    const dbPath = createTempDb();
    seedEvalDb(dbPath, {
      caseIds: ["case-hung-hook"],
      cases: [{ id: "case-hung-hook" }],
    });
    const hookServer = await startHookServer(dbPath, { hangTrigger: true });

    let result: RunnerResult;
    try {
      result = await runRunner(["--suite", "test-suite", "--mode", "hooks"], {
        COWORK_DB_PATH: dbPath,
        COWORK_HOOKS_ORIGIN: hookServer.origin,
        COWORK_EVAL_HTTP_TIMEOUT_MS: "100",
      });
    } finally {
      await stopHookServer(hookServer.server);
    }

    expect(result.code).toBe(1);
    expect(result.durationMs).toBeLessThan(2500);
    expect(result.stdout).toContain("trigger_failed status=408");
    expect(hookServer.triggerHits).toBe(1);
  });

  it("fails closed on pending approvals and requires explicit auto-approve for approval posts", async () => {
    const dbPath = createTempDb();
    seedEvalDb(dbPath, {
      caseIds: ["case-approval"],
      cases: [{ id: "case-approval" }],
    });
    runSql(
      dbPath,
      `CREATE TABLE tasks (
         id TEXT PRIMARY KEY,
         status TEXT,
         terminal_status TEXT,
         result_summary TEXT,
         workspace_id TEXT,
         eval_run_id TEXT,
         updated_at INTEGER
       );
       CREATE TABLE approvals (id TEXT PRIMARY KEY, task_id TEXT, status TEXT, requested_at INTEGER);
       INSERT INTO tasks VALUES ('hook-task-1', 'executing', NULL, NULL, NULL, NULL, ${Date.now()});
       INSERT INTO approvals VALUES ('approval-1', 'hook-task-1', 'pending', ${Date.now()});`,
    );
    const hookServer = await startHookServer(dbPath);

    let result: RunnerResult;
    try {
      result = await runRunner(["--suite", "test-suite", "--mode", "hooks"], {
        COWORK_DB_PATH: dbPath,
        COWORK_HOOKS_ORIGIN: hookServer.origin,
      });
    } finally {
      await stopHookServer(hookServer.server);
    }

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("auto-approve: disabled");
    expect(result.stdout).toContain("reason=pending_approval");
    expect(hookServer.triggerHits).toBe(1);
    expect(hookServer.approvalHits).toBe(0);
  });

  it("posts approvals only in explicit auto-approve mode and still grades replay evidence", async () => {
    const dbPath = createTempDb();
    seedEvalDb(dbPath, {
      caseIds: ["case-auto-approval"],
      cases: [{ id: "case-auto-approval" }],
    });
    runSql(
      dbPath,
      `CREATE TABLE tasks (
         id TEXT PRIMARY KEY,
         status TEXT,
         terminal_status TEXT,
         result_summary TEXT,
         workspace_id TEXT,
         eval_run_id TEXT,
         updated_at INTEGER
       );
       CREATE TABLE approvals (id TEXT PRIMARY KEY, task_id TEXT, status TEXT, requested_at INTEGER);
       CREATE TABLE task_events (
         id TEXT,
         task_id TEXT,
         timestamp INTEGER,
         type TEXT,
         legacy_type TEXT,
         event_id TEXT,
         seq INTEGER,
         actor TEXT,
         payload TEXT
       );
       INSERT INTO tasks VALUES ('hook-task-1', 'executing', NULL, NULL, NULL, NULL, ${Date.now()});
       INSERT INTO approvals VALUES ('approval-1', 'hook-task-1', 'pending', ${Date.now()});`,
    );
    const hookServer = await startHookServer(dbPath, { resolveApproval: true });

    let result: RunnerResult;
    try {
      result = await runRunner(["--suite", "test-suite", "--mode", "hooks", "--auto-approve"], {
        COWORK_DB_PATH: dbPath,
        COWORK_HOOKS_ORIGIN: hookServer.origin,
      });
    } finally {
      await stopHookServer(hookServer.server);
    }

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("auto-approve: enabled");
    expect(result.stdout).toContain("missing_replay_items");
    expect(hookServer.triggerHits).toBe(1);
    expect(hookServer.approvalHits).toBe(1);
  });
});
