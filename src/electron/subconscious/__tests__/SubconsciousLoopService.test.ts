import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SUBCONSCIOUS_SETTINGS } from "../../../shared/subconscious";

type Any = any;

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      const Database = module.default;
      const probe = new Database(":memory:");
      probe.close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("SubconsciousLoopService", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let manager: import("../../database/schema").DatabaseManager;
  let db: ReturnType<import("../../database/schema").DatabaseManager["getDatabase"]>;

  const insertWorkspace = (name = "workspace") => {
    const workspaceId = randomUUID();
    const workspacePath = path.join(tmpDir, name);
    fs.mkdirSync(workspacePath, { recursive: true });
    db.prepare(
      `
        INSERT INTO workspaces (id, name, path, created_at, last_used_at, permissions)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
    ).run(
      workspaceId,
      name,
      workspacePath,
      Date.now(),
      Date.now(),
      JSON.stringify({
        read: true,
        write: true,
        delete: true,
        network: true,
        shell: true,
      }),
    );
    return { id: workspaceId, name, path: workspacePath };
  };

  const initGitRepo = (repoPath: string, originUrl?: string) => {
    execFileSync("git", ["init"], { cwd: repoPath });
    if (originUrl) {
      execFileSync("git", ["remote", "add", "origin", originUrl], { cwd: repoPath });
    }
  };

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-subconscious-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;

    const [{ DatabaseManager }, { SecureSettingsRepository }] = await Promise.all([
      import("../../database/schema"),
      import("../../database/SecureSettingsRepository"),
    ]);

    manager = new DatabaseManager();
    db = manager.getDatabase();
    new SecureSettingsRepository(db);
    const { SubconsciousSettingsManager } = await import("../SubconsciousSettingsManager");
    SubconsciousSettingsManager.clearCache();

    db.exec(`
      CREATE TABLE IF NOT EXISTS event_triggers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        source TEXT NOT NULL,
        conditions TEXT NOT NULL,
        condition_logic TEXT,
        action TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        cooldown_ms INTEGER,
        last_fired_at INTEGER,
        fire_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS briefing_config (
        workspace_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        schedule_time TEXT,
        enabled_sections TEXT,
        delivery_channel_type TEXT,
        delivery_channel_id TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
  });

  afterEach(() => {
    manager?.close();
    vi.restoreAllMocks();
    if (previousUserDataDir === undefined) {
      delete process.env.COWORK_USER_DATA_DIR;
    } else {
      process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("normalizes tasks, mailbox, heartbeat, scheduled jobs, triggers, briefing, and playbook signals into stable target refs", async () => {
    const workspace = insertWorkspace("alpha");
    initGitRepo(workspace.path, "https://github.com/CoWork-OS/CoWork-OS.git");
    const now = Date.now();

    db.prepare(
      `INSERT INTO tasks (id, title, prompt, status, workspace_id, created_at, updated_at, failure_class)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), "Fix failing test", "Investigate", "failed", workspace.id, now, now, "verification_failed");

    db.prepare(
      `INSERT INTO memory_markdown_files (workspace_id, path, content_hash, mtime, size, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(workspace.id, ".cowork/playbook.md", "hash", now, 100, now);

    db.prepare(
      `INSERT INTO mailbox_events (
        id, fingerprint, workspace_id, event_type, thread_id, provider, subject, summary_text, payload_json, created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), "mailbox-fp", workspace.id, "message_received", "thread-1", "gmail", "Launch", "Need a reply", "{}", now, now);

    db.prepare(
      `INSERT INTO agent_roles (
        id, name, display_name, capabilities, created_at, updated_at, heartbeat_enabled, last_heartbeat_at, heartbeat_status, heartbeat_last_pulse_result
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    ).run("role-1", "Researcher", "Researcher", "[]", now, now, now, "active", "Pulse landed");

    db.prepare(
      `INSERT INTO heartbeat_runs (
        id, workspace_id, agent_role_id, run_type, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("hb-1", workspace.id, "role-1", "pulse", "completed", now, now);

    db.prepare(
      `INSERT INTO event_triggers (
        id, name, enabled, source, conditions, action, workspace_id, created_at, updated_at
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    ).run("trigger-1", "Deploy trigger", "webhook", "[]", "{}", workspace.id, now, now);

    db.prepare(
      `INSERT INTO briefing_config (
        workspace_id, enabled, schedule_time, enabled_sections, updated_at
      ) VALUES (?, 1, ?, ?, ?)`,
    ).run(workspace.id, "08:00", "{}", now);

    const cronDir = path.join(tmpDir, "cron");
    fs.mkdirSync(cronDir, { recursive: true });
    fs.writeFileSync(
      path.join(cronDir, "jobs.json"),
      JSON.stringify({
        version: 1,
        jobs: [
          {
            id: "job-1",
            name: "Morning sync",
            enabled: true,
            createdAtMs: now,
            updatedAtMs: now,
            schedule: { kind: "every", everyMs: 3600000 },
            workspaceId: workspace.id,
            taskPrompt: "Summarize the state of the workspace",
            state: {},
          },
        ],
      }),
    );

    const { SubconsciousLoopService } = await import("../SubconsciousLoopService");
    const service = new SubconsciousLoopService(db, { getGlobalRoot: () => workspace.path });

    const result = await service.refreshTargets();
    const targets = service.listTargets();
    const keys = new Set(targets.map((target) => target.key));

    expect(result.targetCount).toBeGreaterThanOrEqual(8);
    expect([...keys]).toEqual(
      expect.arrayContaining([
        "global:brain",
        `workspace:${workspace.id}`,
        "code_workspace:github:CoWork-OS/CoWork-OS",
        "mailbox_thread:thread-1",
        "agent_role:role-1",
        "scheduled_task:job-1",
        "event_trigger:trigger-1",
        `briefing:${workspace.id}`,
      ]),
    );
  });

  it("deduplicates code targets by repo and prefers the canonical CoWork OS workspace root", async () => {
    const repoRootWorkspace = insertWorkspace("cowork-root");
    initGitRepo(repoRootWorkspace.path, "git@github.com:CoWork-OS/CoWork-OS.git");
    const nestedPath = path.join(repoRootWorkspace.path, "apps", "desktop");
    fs.mkdirSync(nestedPath, { recursive: true });
    const nestedWorkspaceId = randomUUID();
    db.prepare(
      `
        INSERT INTO workspaces (id, name, path, created_at, last_used_at, permissions)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
    ).run(
      nestedWorkspaceId,
      "cowork-nested",
      nestedPath,
      Date.now(),
      Date.now() + 5000,
      JSON.stringify({
        read: true,
        write: true,
        delete: true,
        network: true,
        shell: true,
      }),
    );

    const now = Date.now();
    db.prepare(
      `INSERT INTO tasks (id, title, prompt, status, workspace_id, created_at, updated_at, failure_class)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("root-task", "Fix coordinator drift", "Investigate", "failed", repoRootWorkspace.id, now, now, "verification_failed");
    db.prepare(
      `INSERT INTO tasks (id, title, prompt, status, workspace_id, created_at, updated_at, failure_class)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("nested-task", "Fix renderer drift", "Investigate", "failed", nestedWorkspaceId, now, now, "verification_failed");

    const { SubconsciousLoopService } = await import("../SubconsciousLoopService");
    const service = new SubconsciousLoopService(db, { getGlobalRoot: () => repoRootWorkspace.path });

    await service.refreshTargets();
    const codeTargets = service.listTargets().filter((target) => target.target.kind === "code_workspace");

    expect(codeTargets).toHaveLength(1);
    expect(codeTargets[0]?.key).toBe("code_workspace:github:CoWork-OS/CoWork-OS");
    expect(codeTargets[0]?.target.workspaceId).toBe(repoRootWorkspace.id);
    expect(codeTargets[0]?.target.codeWorkspacePath).toBe(repoRootWorkspace.path);

    const detail = await service.getTargetDetail("code_workspace:github:CoWork-OS/CoWork-OS");
    expect(detail?.latestEvidence).toHaveLength(2);
  });

  it("writes global brain artifacts to the user data directory when no workspace root exists", async () => {
    const { SubconsciousLoopService } = await import("../SubconsciousLoopService");
    const service = new SubconsciousLoopService(db);

    const result = await service.refreshTargets();

    expect(result.targetCount).toBeGreaterThanOrEqual(1);
    expect(
      fs.existsSync(path.join(tmpDir, ".cowork", "subconscious", "brain", "state.json")),
    ).toBe(true);
  });

  it("deduplicates repeated open backlog items during target refresh", async () => {
    const workspace = insertWorkspace("backlog-dedupe");
    const targetKey = `workspace:${workspace.id}`;
    const now = Date.now();

    for (const id of ["backlog-1", "backlog-2"]) {
      db.prepare(
        `INSERT INTO subconscious_backlog_items (
          id, target_key, title, summary, status, priority, executor_kind, source_run_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        targetKey,
        "Keep the winner durable",
        "Track the repeated lesson without creating another duplicate.",
        "open",
        90,
        "task",
        `run-${id}`,
        now,
        now,
      );
    }

    const { SubconsciousLoopService } = await import("../SubconsciousLoopService");
    const service = new SubconsciousLoopService(db, { getGlobalRoot: () => workspace.path });

    await service.refreshTargets();

    const row = db.prepare(
      "SELECT COUNT(*) AS count FROM subconscious_backlog_items WHERE target_key = ? AND status = 'open'",
    ).get(targetKey) as Any;
    expect(Number(row.count)).toBe(1);
    expect(service.listTargets().find((target) => target.key === targetKey)?.backlogCount).toBe(1);
  });

  it("does not recreate missing workspace roots when refreshing stale workspace targets", async () => {
    const workspace = insertWorkspace("stale-root");
    fs.rmSync(workspace.path, { recursive: true, force: true });

    const { SubconsciousLoopService } = await import("../SubconsciousLoopService");
    const service = new SubconsciousLoopService(db, { getGlobalRoot: () => tmpDir });

    await service.refreshTargets();

    expect(fs.existsSync(workspace.path)).toBe(false);
    expect(
      fs.existsSync(path.join(tmpDir, ".cowork", "subconscious", "brain", "state.json")),
    ).toBe(true);
  });

  it("excludes persona-template roles from agent_role targets and prunes stale twin targets", async () => {
    const workspace = insertWorkspace("twins");
    const now = Date.now();

    db.prepare(
      `INSERT INTO agent_roles (
        id, name, display_name, capabilities, created_at, updated_at,
        role_kind, is_active, heartbeat_enabled, last_heartbeat_at, heartbeat_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "operator-role",
      "operator-role",
      "Operator Role",
      "[]",
      now,
      now,
      "custom",
      1,
      1,
      now,
      "active",
    );

    db.prepare(
      `INSERT INTO agent_roles (
        id, name, display_name, capabilities, created_at, updated_at,
        role_kind, is_active, heartbeat_enabled, last_heartbeat_at, heartbeat_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "twin-role",
      "twin-qa-test-engineer",
      "Twin QA Test Engineer",
      "[]",
      now,
      now,
      "persona_template",
      1,
      1,
      now,
      "active",
    );

    db.prepare(
      `INSERT INTO subconscious_targets (
        target_key, kind, workspace_id, ref_json, health, state, persistence, missed_run_policy,
        backlog_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "agent_role:twin-role",
      "agent_role",
      workspace.id,
      JSON.stringify({
        key: "agent_role:twin-role",
        kind: "agent_role",
        agentRoleId: "twin-role",
        workspaceId: workspace.id,
        label: "twin-qa-test-engineer",
      }),
      "healthy",
      "active",
      "sessionOnly",
      "catchUp",
      0,
      now,
      now,
    );

    const { SubconsciousLoopService } = await import("../SubconsciousLoopService");
    const service = new SubconsciousLoopService(db, { getGlobalRoot: () => workspace.path });

    await service.refreshTargets();
    const targets = service.listTargets();

    expect(targets.some((target) => target.key === "agent_role:operator-role")).toBe(true);
    expect(targets.some((target) => target.key === "agent_role:twin-role")).toBe(false);
    expect(
      db.prepare("SELECT 1 FROM subconscious_targets WHERE target_key = ?").get("agent_role:twin-role"),
    ).toBeUndefined();
  });

  it("writes durable artifacts and sqlite index rows for a code workspace run", async () => {
    const workspace = insertWorkspace("beta");
    initGitRepo(workspace.path, "https://github.com/CoWork-OS/CoWork-OS.git");
    const now = Date.now();
    db.prepare(
      `INSERT INTO tasks (id, title, prompt, status, workspace_id, created_at, updated_at, failure_class)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("task-1", "Patch flaky tests", "Fix the regression", "failed", workspace.id, now, now, "verification_failed");

    const { SubconsciousLoopService } = await import("../SubconsciousLoopService");
    const createTask = vi.fn().mockResolvedValue({ id: "dispatch-task-1" });
    const getWorktreeManager = vi.fn(() => ({
      shouldUseWorktree: vi.fn().mockResolvedValue(true),
    }));
    const service = new SubconsciousLoopService(db, { getGlobalRoot: () => workspace.path });
    service.saveSettings({
      ...DEFAULT_SUBCONSCIOUS_SETTINGS,
      enabled: true,
      autoRun: false,
      trustedTargetKeys: ["code_workspace:github:CoWork-OS/CoWork-OS"],
    });
    await service.start({
      createTask,
      getWorktreeManager,
    } as unknown as import("../../agent/daemon").AgentDaemon);

    const run = await service.runNow("code_workspace:github:CoWork-OS/CoWork-OS");
    expect(run).not.toBeNull();
    expect(createTask).toHaveBeenCalledTimes(1);

    const runRoot = path.join(
      workspace.path,
      ".cowork",
      "subconscious",
      "targets",
      "code_workspace_github_CoWork-OS_CoWork-OS",
      "runs",
      run!.id,
    );

    for (const artifact of [
      "evidence.json",
      "ideas.jsonl",
      "critique.jsonl",
      "decision.json",
      "winning-recommendation.md",
      "next-backlog.md",
      "dispatch.json",
    ]) {
      expect(fs.existsSync(path.join(runRoot, artifact))).toBe(true);
    }

    const counts = {
      runs: Number((db.prepare("SELECT COUNT(*) as count FROM subconscious_runs").get() as Any).count),
      hypotheses: Number((db.prepare("SELECT COUNT(*) as count FROM subconscious_hypotheses").get() as Any).count),
      critiques: Number((db.prepare("SELECT COUNT(*) as count FROM subconscious_critiques").get() as Any).count),
      decisions: Number((db.prepare("SELECT COUNT(*) as count FROM subconscious_decisions").get() as Any).count),
      backlog: Number((db.prepare("SELECT COUNT(*) as count FROM subconscious_backlog_items").get() as Any).count),
      dispatches: Number((db.prepare("SELECT COUNT(*) as count FROM subconscious_dispatch_records").get() as Any).count),
      legacyCampaigns: Number((db.prepare("SELECT COUNT(*) as count FROM improvement_campaigns").get() as Any).count),
    };

    expect(counts.runs).toBeGreaterThan(0);
    expect(counts.hypotheses).toBeGreaterThan(0);
    expect(counts.critiques).toBeGreaterThan(0);
    expect(counts.decisions).toBeGreaterThan(0);
    expect(counts.backlog).toBeGreaterThan(0);
    expect(counts.dispatches).toBeGreaterThan(0);
    expect(counts.legacyCampaigns).toBe(0);

    await service.stop();
  });

  it("records a sleep outcome when a target has no fresh evidence worth acting on", async () => {
    const workspace = insertWorkspace("gamma");
    const { SubconsciousLoopService } = await import("../SubconsciousLoopService");
    const service = new SubconsciousLoopService(db, { getGlobalRoot: () => workspace.path });
    service.saveSettings({
      ...DEFAULT_SUBCONSCIOUS_SETTINGS,
      enabled: true,
      autoRun: false,
    });

    await service.refreshTargets();
    const run = await service.runNow(`workspace:${workspace.id}`);

    expect(run).not.toBeNull();
    expect(run?.outcome).toBe("sleep");
    const detail = await service.getTargetDetail(`workspace:${workspace.id}`);
    expect(detail?.journal.some((entry) => entry.kind === "sleep")).toBe(true);
  });

  it("advances next eligibility when an unchanged target is deduplicated", async () => {
    const workspace = insertWorkspace("dedupe-window");
    const targetKey = `workspace:${workspace.id}`;
    const now = Date.now();

    db.prepare(
      `INSERT INTO tasks (id, title, prompt, status, workspace_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("task-dedupe", "Follow up with customer", "Investigate", "completed", workspace.id, now, now);

    const { SubconsciousLoopService } = await import("../SubconsciousLoopService");
    const service = new SubconsciousLoopService(db, { getGlobalRoot: () => workspace.path });
    service.saveSettings({
      ...DEFAULT_SUBCONSCIOUS_SETTINGS,
      enabled: true,
      autoRun: false,
    });

    await service.refreshTargets();
    const firstRun = await service.runNow(targetKey);
    expect(firstRun).not.toBeNull();

    db.prepare("UPDATE subconscious_targets SET next_eligible_at = ? WHERE target_key = ?").run(now - 1000, targetKey);
    const before = Number(
      (
        db.prepare("SELECT next_eligible_at AS next_eligible_at FROM subconscious_targets WHERE target_key = ?").get(
          targetKey,
        ) as Any
      ).next_eligible_at || 0,
    );

    const secondRun = await service.runNow(targetKey);
    const after = Number(
      (
        db.prepare("SELECT next_eligible_at AS next_eligible_at FROM subconscious_targets WHERE target_key = ?").get(
          targetKey,
        ) as Any
      ).next_eligible_at || 0,
    );

    expect(secondRun?.id).toBe(firstRun?.id);
    expect(after).toBeGreaterThan(before);
    expect(after).toBeGreaterThan(Date.now());
  });

  it("does not start a duplicate catch-up run on restart without newer evidence", async () => {
    const workspace = insertWorkspace("restart-catchup");
    initGitRepo(workspace.path, "https://github.com/CoWork-OS/CoWork-OS.git");
    const now = Date.now();
    db.prepare(
      `INSERT INTO tasks (id, title, prompt, status, workspace_id, created_at, updated_at, failure_class)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("task-restart", "Fix restart noise", "Investigate", "failed", workspace.id, now, now, "verification_failed");

    const targetKey = "code_workspace:github:CoWork-OS/CoWork-OS";
    const { SubconsciousLoopService } = await import("../SubconsciousLoopService");
    const firstCreateTask = vi.fn().mockResolvedValue({ id: "dispatch-task-restart-1" });
    const getWorktreeManager = vi.fn(() => ({
      shouldUseWorktree: vi.fn().mockResolvedValue(true),
    }));
    const first = new SubconsciousLoopService(db, { getGlobalRoot: () => workspace.path });
    first.saveSettings({
      ...DEFAULT_SUBCONSCIOUS_SETTINGS,
      enabled: true,
      autoRun: false,
      catchUpOnRestart: true,
      trustedTargetKeys: [targetKey],
    });
    await first.start({
      createTask: firstCreateTask,
      getWorktreeManager,
    } as unknown as import("../../agent/daemon").AgentDaemon);

    const firstRun = await first.runNow(targetKey);
    expect(firstRun).not.toBeNull();
    expect(firstCreateTask).toHaveBeenCalledTimes(1);
    first.stop();

    db.prepare("UPDATE subconscious_targets SET next_eligible_at = ? WHERE target_key = ?").run(
      Date.now() - 1000,
      targetKey,
    );
    const runCountBeforeRestart = Number(
      (db.prepare("SELECT COUNT(*) AS count FROM subconscious_runs").get() as Any).count,
    );

    const secondCreateTask = vi.fn().mockResolvedValue({ id: "dispatch-task-restart-2" });
    const second = new SubconsciousLoopService(db, { getGlobalRoot: () => workspace.path });
    second.saveSettings({
      ...DEFAULT_SUBCONSCIOUS_SETTINGS,
      enabled: true,
      autoRun: true,
      catchUpOnRestart: true,
      trustedTargetKeys: [targetKey],
    });
    await second.start({
      createTask: secondCreateTask,
      getWorktreeManager,
    } as unknown as import("../../agent/daemon").AgentDaemon);

    const runCountAfterRestart = Number(
      (db.prepare("SELECT COUNT(*) AS count FROM subconscious_runs").get() as Any).count,
    );

    expect(secondCreateTask).not.toHaveBeenCalled();
    expect(runCountAfterRestart).toBe(runCountBeforeRestart);
    second.stop();
  });

  it("clears session-only target state on restart while preserving durable targets", async () => {
    const workspace = insertWorkspace("delta");
    const now = Date.now();
    db.prepare(
      `INSERT INTO mailbox_events (
        id, fingerprint, workspace_id, event_type, thread_id, provider, subject, summary_text, payload_json, created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), "mailbox-fp", workspace.id, "message_received", "thread-2", "gmail", "Delta", "Follow up", "{}", now, now);

    const { SubconsciousLoopService } = await import("../SubconsciousLoopService");
    const first = new SubconsciousLoopService(db, { getGlobalRoot: () => workspace.path });
    first.saveSettings({
      ...DEFAULT_SUBCONSCIOUS_SETTINGS,
      enabled: true,
      autoRun: false,
      durableTargetKinds: ["workspace"],
    });
    await first.refreshTargets();
    expect(first.listTargets().some((target) => target.key === `mailbox_thread:thread-2`)).toBe(true);
    first.stop();

    const second = new SubconsciousLoopService(db, { getGlobalRoot: () => workspace.path });
    second.saveSettings({
      ...DEFAULT_SUBCONSCIOUS_SETTINGS,
      enabled: true,
      autoRun: false,
      durableTargetKinds: ["workspace"],
    });
    await second.start({} as unknown as import("../../agent/daemon").AgentDaemon);

    const targets = second.listTargets();
    const mailbox = targets.find((target) => target.key === `mailbox_thread:thread-2`);
    const workspaceTarget = targets.find((target) => target.key === `workspace:${workspace.id}`);

    expect(mailbox?.persistence).toBe("sessionOnly");
    expect(workspaceTarget?.persistence).toBe("durable");
    second.stop();
  });

  it("prefers fresh evidence over stale backlog-only targets", async () => {
    const staleWorkspace = insertWorkspace("stale-target");
    const freshWorkspace = insertWorkspace("fresh-target");
    const staleTargetKey = `workspace:${staleWorkspace.id}`;
    const old = Date.now() - 5 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    db.prepare(
      `INSERT INTO subconscious_backlog_items (
        id, target_key, title, summary, status, priority, executor_kind, source_run_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "stale-backlog",
      staleTargetKey,
      "Keep the winner durable",
      "This backlog is old and should not outrank fresh work.",
      "open",
      90,
      "task",
      "stale-run",
      old,
      old,
    );

    db.prepare(
      `INSERT INTO subconscious_targets (
        target_key, kind, workspace_id, ref_json, health, state, persistence, missed_run_policy,
        next_eligible_at, last_observed_at, last_action_at, expires_at, jitter_ms, last_meaningful_outcome,
        last_winner, last_run_at, last_evidence_at, backlog_count, evidence_fingerprint,
        last_dispatch_kind, last_dispatch_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      staleTargetKey,
      "workspace",
      staleWorkspace.id,
      JSON.stringify({
        key: staleTargetKey,
        kind: "workspace",
        workspaceId: staleWorkspace.id,
        label: staleWorkspace.name,
      }),
      "watch",
      "idle",
      "durable",
      "catchUp",
      old,
      old,
      old,
      null,
      0,
      "defer",
      null,
      old,
      old,
      1,
      "stale-fingerprint",
      null,
      null,
      old,
      old,
    );

    db.prepare(
      `INSERT INTO tasks (id, title, prompt, status, workspace_id, created_at, updated_at, failure_class)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("fresh-task", "Investigate a new failure", "Investigate", "failed", freshWorkspace.id, now, now, "verification_failed");

    const { SubconsciousLoopService } = await import("../SubconsciousLoopService");
    const service = new SubconsciousLoopService(db, { getGlobalRoot: () => freshWorkspace.path });
    service.saveSettings({
      ...DEFAULT_SUBCONSCIOUS_SETTINGS,
      enabled: true,
      autoRun: false,
    });

    await service.refreshTargets();
    const run = await service.runNow();

    expect(run?.targetKey).toBe(`workspace:${freshWorkspace.id}`);
  });

  it("distills journal entries into dream artifacts and memory index", async () => {
    const workspace = insertWorkspace("epsilon");
    initGitRepo(workspace.path, "https://github.com/CoWork-OS/CoWork-OS.git");
    const now = Date.now();
    db.prepare(
      `INSERT INTO tasks (id, title, prompt, status, workspace_id, created_at, updated_at, failure_class)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("task-dream", "Fix reflective drift", "Investigate", "failed", workspace.id, now, now, "verification_failed");

    const { SubconsciousLoopService } = await import("../SubconsciousLoopService");
    const service = new SubconsciousLoopService(db, { getGlobalRoot: () => workspace.path });
    service.saveSettings({
      ...DEFAULT_SUBCONSCIOUS_SETTINGS,
      enabled: true,
      autoRun: false,
      dreamsEnabled: true,
      dreamCadenceHours: 1,
      trustedTargetKeys: ["code_workspace:github:CoWork-OS/CoWork-OS"],
    });
    await service.start({
      createTask: vi.fn().mockResolvedValue({ id: "dispatch-task-2" }),
      getWorktreeManager: vi.fn(() => ({
        shouldUseWorktree: vi.fn().mockResolvedValue(true),
      })),
    } as unknown as import("../../agent/daemon").AgentDaemon);

    await service.runNow("code_workspace:github:CoWork-OS/CoWork-OS");
    const detail = await service.getTargetDetail("code_workspace:github:CoWork-OS/CoWork-OS");

    expect(detail?.journal.length).toBeGreaterThan(0);
    expect(detail?.dreams.length).toBeGreaterThan(0);
    expect(detail?.memory.length).toBeGreaterThan(0);
  });
});
