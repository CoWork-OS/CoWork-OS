import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      const probe = new module.default(":memory:");
      probe.close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

const DAY = 24 * 60 * 60 * 1000;

describeWithSqlite("MemoryRetentionService (LIFE-3)", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let manager: import("../../database/schema").DatabaseManager;
  let db: ReturnType<import("../../database/schema").DatabaseManager["getDatabase"]>;
  const now = Date.UTC(2026, 9, 3, 12, 0, 0);

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-memory-retention-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = path.join(tmpDir, "user-data");
    fs.mkdirSync(process.env.COWORK_USER_DATA_DIR, { recursive: true });
    const { DatabaseManager } = await import("../../database/schema");
    manager = new DatabaseManager();
    db = manager.getDatabase();
  });

  afterEach(() => {
    manager?.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const count = (sql: string, ...params: unknown[]) =>
    (db.prepare(sql).get(...params) as { n: number }).n;

  const addWorkspace = (name: string, permissions: Record<string, boolean>) => {
    const id = randomUUID();
    const workspacePath = path.join(tmpDir, name);
    fs.mkdirSync(path.join(workspacePath, ".cowork"), { recursive: true });
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, permissions) VALUES (?, ?, ?, ?, ?)",
    ).run(id, name, workspacePath, now, JSON.stringify(permissions));
    return { id, path: workspacePath };
  };

  const writeFile = (filePath: string, content: string, ageMs: number) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    const time = new Date(now - ageMs);
    fs.utimesSync(filePath, time, time);
  };

  const makeService = async (overrides: Record<string, unknown> = {}) => {
    const { MemoryRetentionService } = await import("../MemoryRetentionService");
    return new MemoryRetentionService({
      database: () => db,
      now: () => now,
      artifactRetentionDays: () => 30,
      pause: async () => undefined,
      ...overrides,
    });
  };

  it("prunes old core, dreaming and subconscious rows while keeping pending work", async () => {
    const workspace = addWorkspace("rows", { read: true, write: true, delete: true });
    db.pragma("foreign_keys = OFF");
    const trace = (id: string, ageDays: number, status = "completed") =>
      db
        .prepare(
          `INSERT INTO core_traces (id, profile_id, source_surface, trace_kind, status,
             started_at, created_at) VALUES (?, 'profile', 'heartbeat', 'pulse', ?, ?, ?)`,
        )
        .run(id, status, now - ageDays * DAY, now - ageDays * DAY);
    trace("old-trace", 40);
    trace("old-running", 40, "running");
    trace("old-with-proposal", 40);
    trace("recent-trace", 5);
    db.prepare(
      `INSERT INTO core_trace_events (id, trace_id, phase, event_type, summary, created_at)
       VALUES ('event-old', 'old-trace', 'start', 'x', 's', ?)`,
    ).run(now - 40 * DAY);
    db.prepare(
      `INSERT INTO core_memory_candidates (id, trace_id, profile_id, scope_kind, scope_ref,
         candidate_type, summary, confidence, novelty_score, stability_score, status, created_at)
       VALUES ('candidate', 'old-with-proposal', 'profile', 'global', 'global', 'preference',
         's', 1, 1, 1, 'proposed', ?)`,
    ).run(now - 40 * DAY);

    const dreamingRun = (id: string, ageDays: number) =>
      db
        .prepare(
          `INSERT INTO dreaming_runs (id, workspace_id, scope_kind, scope_ref, status,
             trigger_source, started_at, created_at)
           VALUES (?, ?, 'workspace', ?, 'completed', 'manual', ?, ?)`,
        )
        .run(id, workspace.id, workspace.id, now - ageDays * DAY, now - ageDays * DAY);
    dreamingRun("dream-old", 100);
    dreamingRun("dream-old-pending", 100);
    const dreamingCandidate = (id: string, runId: string, status: string) =>
      db
        .prepare(
          `INSERT INTO dreaming_candidates (id, run_id, workspace_id, action, target,
             proposed_value, rationale, confidence, status, created_at)
           VALUES (?, ?, ?, 'add', 'memory', 'v', 'r', 1, ?, ?)`,
        )
        .run(id, runId, workspace.id, status, now - 100 * DAY);
    dreamingCandidate("dc-rejected", "dream-old", "rejected");
    dreamingCandidate("dc-proposed", "dream-old-pending", "proposed");

    db.prepare(
      `INSERT INTO subconscious_targets (target_key, kind, ref_json, health, state, created_at,
         updated_at) VALUES ('target', 'workspace', '{}', 'healthy', 'active', ?, ?)`,
    ).run(now, now);
    const subRun = (id: string, ageDays: number, stage: string) =>
      db
        .prepare(
          `INSERT INTO subconscious_runs (id, target_key, stage, evidence_fingerprint,
             evidence_summary, artifact_root, rejected_hypothesis_ids_json, started_at, created_at)
           VALUES (?, 'target', ?, 'f', 's', ?, '[]', ?, ?)`,
        )
        .run(
          id,
          stage,
          path.join(workspace.path, ".cowork", "subconscious", "targets", "target", "runs", id),
          now - ageDays * DAY,
          now - ageDays * DAY,
        );
    subRun("sub-old", 100, "completed");
    subRun("sub-old-active", 100, "ideating");
    subRun("sub-recent", 10, "completed");
    db.prepare(
      `INSERT INTO subconscious_hypotheses (id, run_id, target_key, title, summary, rationale,
         evidence_refs_json, status, created_at)
       VALUES ('hyp', 'sub-old', 'target', 't', 's', 'r', '[]', 'proposed', ?)`,
    ).run(now - 100 * DAY);
    db.pragma("foreign_keys = ON");

    const service = await makeService();
    const result = await service.runOnce();

    expect(result.errors).toEqual({});
    const ids = (table: string) =>
      (db.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as Array<{ id: string }>).map(
        (row) => row.id,
      );
    expect(ids("core_traces")).toEqual(["old-running", "old-with-proposal", "recent-trace"]);
    expect(count("SELECT COUNT(*) AS n FROM core_trace_events")).toBe(0);
    expect(ids("dreaming_runs")).toEqual(["dream-old-pending"]);
    expect(ids("dreaming_candidates")).toEqual(["dc-proposed"]);
    expect(ids("subconscious_runs")).toEqual(["sub-old-active", "sub-recent"]);
    expect(count("SELECT COUNT(*) AS n FROM subconscious_hypotheses")).toBe(0);
  });

  it("prunes WI artifacts, kit snapshots and feedback files inside allowed workspaces", async () => {
    const allowed = addWorkspace("allowed", { read: true, write: true, delete: true });
    const denied = addWorkspace("denied", { read: true, write: true, delete: false });
    for (const workspace of [allowed, denied]) {
      const runs = path.join(workspace.path, ".cowork", "subconscious", "targets", "t1", "runs");
      writeFile(path.join(runs, "old-run", "ideas.jsonl"), "{}", 40 * DAY);
      fs.utimesSync(path.join(runs, "old-run"), new Date(now - 40 * DAY), new Date(now - 40 * DAY));
      writeFile(path.join(runs, "new-run", "ideas.jsonl"), "{}", DAY);
      writeFile(
        path.join(workspace.path, ".cowork", "subconscious", "journal", "2026-08-01.jsonl"),
        "{}",
        60 * DAY,
      );
      writeFile(
        path.join(workspace.path, ".cowork", "feedback", "feedback-2026-W10.json"),
        "{}",
        200 * DAY,
      );
      writeFile(
        path.join(workspace.path, ".cowork", "feedback", "feedback-2026-W40.json"),
        "{}",
        DAY,
      );
      const history = path.join(workspace.path, ".cowork", ".history", "USER.md");
      const lines: string[] = [];
      for (let index = 0; index < 25; index += 1) {
        const stamp = new Date(now - (25 - index) * DAY).toISOString().replace(/[:.]/g, "-");
        writeFile(path.join(history, `${stamp}.md`), `v${index}`, (25 - index) * DAY);
        lines.push(JSON.stringify({ file: "USER.md", createdAt: stamp }));
      }
      writeFile(path.join(history, "revisions.jsonl"), `${lines.join("\n")}\n`, 0);
    }
    // A planted symlink in runs/ pointing outside the workspace is never followed.
    const outside = path.join(tmpDir, "outside");
    writeFile(path.join(outside, "keep.txt"), "keep", 0);
    const allowedRuns = path.join(allowed.path, ".cowork", "subconscious", "targets", "t1", "runs");
    fs.symlinkSync(outside, path.join(allowedRuns, "linked-run"));

    const service = await makeService();
    const result = await service.runOnce();

    expect(result.errors).toEqual({});
    const exists = (base: string, relative: string) => fs.existsSync(path.join(base, relative));
    const runsRel = ".cowork/subconscious/targets/t1/runs";
    expect(exists(allowed.path, `${runsRel}/old-run`)).toBe(false);
    expect(exists(allowed.path, `${runsRel}/new-run`)).toBe(true);
    expect(exists(allowed.path, ".cowork/subconscious/journal/2026-08-01.jsonl")).toBe(false);
    expect(exists(allowed.path, ".cowork/feedback/feedback-2026-W10.json")).toBe(false);
    expect(exists(allowed.path, ".cowork/feedback/feedback-2026-W40.json")).toBe(true);
    expect(fs.existsSync(path.join(outside, "keep.txt"))).toBe(true);
    const allowedHistory = path.join(allowed.path, ".cowork", ".history", "USER.md");
    const snapshots = fs.readdirSync(allowedHistory).filter((name) => name.endsWith(".md"));
    expect(snapshots).toHaveLength(20);
    const revisionLines = fs
      .readFileSync(path.join(allowedHistory, "revisions.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean);
    expect(revisionLines).toHaveLength(20);

    // The workspace whose access profile forbids deletes is left untouched.
    expect(exists(denied.path, `${runsRel}/old-run`)).toBe(true);
    expect(exists(denied.path, ".cowork/feedback/feedback-2026-W10.json")).toBe(true);
    expect(fs.readdirSync(path.join(denied.path, ".cowork", ".history", "USER.md")).length).toBe(
      26,
    );
  });

  it("prunes old suggestions, suggestion feedback and Playbook entries", async () => {
    const workspace = addWorkspace("payloads", { read: true, write: true, delete: true });
    const suggestion = (id: string, status: string, expiresAt: number, updatedAt: number) =>
      db
        .prepare(
          `INSERT INTO suggestions (id, workspace_id, title, payload, status, created_at, expires_at, updated_at)
           VALUES (?, ?, ?, '{}', ?, ?, ?, ?)`,
        )
        .run(id, workspace.id, id, status, updatedAt, expiresAt, updatedAt);
    suggestion("expired-long-ago", "active", now - 40 * DAY, now - 47 * DAY);
    suggestion("open", "active", now + DAY, now - DAY);
    suggestion("dismissed-long-ago", "dismissed", now + DAY, now - 40 * DAY);
    suggestion("dismissed-recently", "dismissed", now + DAY, now - DAY);
    const feedback = db.prepare(
      `INSERT INTO suggestion_feedback (id, workspace_id, action, created_at) VALUES (?, ?, 'dismissed', ?)`,
    );
    feedback.run("fb-old", workspace.id, now - 100 * DAY);
    feedback.run("fb-new", workspace.id, now - DAY);

    const entry = db.prepare(
      `INSERT INTO playbook_entries (id, workspace_id, task_id, kind, content, content_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'h', ?, ?)`,
    );
    entry.run("old-failure", workspace.id, "t1", "failure", "f", now - 200 * DAY, now - 200 * DAY);
    entry.run("new-failure", workspace.id, "t2", "failure", "f", now - DAY, now - DAY);
    entry.run(
      "old-backed-success",
      workspace.id,
      "t3",
      "success",
      "s",
      now - 200 * DAY,
      now - 200 * DAY,
    );
    entry.run(
      "old-unbacked-success",
      workspace.id,
      "t4",
      "success",
      "s",
      now - 200 * DAY,
      now - 200 * DAY,
    );
    db.prepare(
      `INSERT INTO playbook_success_evidence (id, workspace_id, task_id, source_memory_id, source_content_hash, created_at, invalidated_at)
       VALUES ('e-active', ?, 't3', 'old-backed-success', 'h', ?, NULL),
              ('e-invalid', ?, 't4', 'old-unbacked-success', 'h', ?, ?)`,
    ).run(workspace.id, now - 200 * DAY, workspace.id, now - 200 * DAY, now - 150 * DAY);

    const result = await (await makeService()).runOnce();

    expect(result.counts.suggestions).toBe(3);
    expect(
      (db.prepare("SELECT id FROM suggestions ORDER BY id").all() as Array<{ id: string }>).map(
        (row) => row.id,
      ),
    ).toEqual(["dismissed-recently", "open"]);
    expect(count("SELECT COUNT(*) AS n FROM suggestion_feedback WHERE id = 'fb-new'")).toBe(1);
    expect(result.counts.playbookEntries).toBe(2);
    expect(
      (
        db.prepare("SELECT id FROM playbook_entries ORDER BY id").all() as Array<{ id: string }>
      ).map((row) => row.id),
    ).toEqual(["new-failure", "old-backed-success"]);
  });

  it("keeps only the newest 50 non-current working states per agent and workspace", async () => {
    const workspace = addWorkspace("working-state", { read: true, write: true, delete: true });
    db.pragma("foreign_keys = OFF");
    const insert = db.prepare(
      `INSERT INTO agent_working_state (id, agent_role_id, workspace_id, state_type, content, is_current, created_at, updated_at)
       VALUES (?, 'agent-1', ?, 'context', 'c', ?, ?, ?)`,
    );
    for (let i = 0; i < 53; i += 1) insert.run(`old-${i}`, workspace.id, 0, now - i, now - i);
    insert.run("current", workspace.id, 1, now - 1000, now - 1000);

    const result = await (await makeService()).runOnce();

    expect(result.counts.workingStates).toBe(3);
    expect(count("SELECT COUNT(*) AS n FROM agent_working_state WHERE is_current = 0")).toBe(50);
    expect(count("SELECT COUNT(*) AS n FROM agent_working_state WHERE id = 'current'")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM agent_working_state WHERE id = 'old-52'")).toBe(0);
  });

  it("isolates step failures so later steps still run", async () => {
    const workspace = addWorkspace("isolated", { read: true, write: true, delete: true });
    writeFile(
      path.join(workspace.path, ".cowork", "feedback", "feedback-2026-W10.json"),
      "{}",
      200 * DAY,
    );
    const service = await makeService({
      artifactRetentionDays: () => {
        throw new Error("settings unavailable");
      },
    });

    const result = await service.runOnce();

    expect(result.errors.subconsciousArtifacts).toBe("settings unavailable");
    expect(result.counts.feedbackFiles).toBe(1);
    expect(result.counts.kitSnapshots).toBe(0);
  });

  it("does nothing after stop and never schedules twice", async () => {
    const service = await makeService();
    service.start({ initialDelayMs: 60_000 });
    service.start({ initialDelayMs: 60_000 });
    service.stop();
    const result = await service.runOnce();
    expect(result.counts).toEqual({});
  });
});
