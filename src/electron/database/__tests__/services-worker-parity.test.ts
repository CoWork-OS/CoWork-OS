import { buildSync } from "esbuild";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DatabaseClient } from "../async/DatabaseClient";
import { DATABASE_COMMANDS, requiredTablesFor } from "../async/commands";
import { TaskStore, WorkspaceStore } from "../repositories";
import { AgentRoleStore } from "../../agents/AgentRoleRepository";
import { AutomationProfileStore } from "../../agents/AutomationProfileRepository";
import {
  AgentRoleRepository,
  AgentTeamMemberRepository,
  AgentTeamRepository,
  AutomationProfileRepository,
  MentionRepository,
  TaskSubscriptionRepository,
} from "../../agents/agent-repository-facades";
import {
  RoutineRepository,
  RoutineWorkflowRepository,
} from "../../routines/routine-repository-facades";
import { RoutineService } from "../../routines/service";
import { ManagedSessionService } from "../../managed/ManagedSessionService";
import { ManagedRepository } from "../../managed/managed-repository-facades";
import { ContactIdentityService } from "../../identity/identity-repository-facades";
import { EvalService } from "../../eval/eval-repository-facades";
import { ActivityRepository } from "../../activity/activity-repository-facades";
import { MissionControlIntelligenceService } from "../../mission-control/mission-control-repository-facades";
import { registerPendingTimelineWrites } from "../timeline-write-registry";
import { EverydayAgentService } from "../../everyday-agent/everyday-agent-repository-facades";
import { WorkSessionProtocolService } from "../../sessions/WorkSessionProtocolService";
import {
  SessionMembershipService,
  WorkContextService,
} from "../../workspaces/workspaces-repository-facades";
import { SecureSettingsRepository } from "../SecureSettingsRepository";
import { SubconsciousLoopService } from "../../subconscious/SubconsciousLoopService";
import { SubconsciousSettingsManager } from "../../subconscious/SubconsciousSettingsManager";
import {
  CoreFailureClusterRepository,
  CoreFailureRecordRepository,
  CoreLearningsRepository,
  CoreMemoryScopeStateRepository,
  CoreTraceRepository,
} from "../../core/core-repository-facades";
import { DatabaseManager } from "../schema";
import { setStatementClient } from "../statements/statement-route";

// The services domain's agent repositories on both backends (async SQLite migration
// plan, DB6): the same calls through the facades return the same results on the host and
// in the database worker.

const BUILD_DIR = path.resolve("node_modules/.cache/cowork-db-worker-test");
let workerPath: string;

beforeAll(() => {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  workerPath = path.join(BUILD_DIR, `database-worker-services-${process.pid}.js`);
  buildSync({
    entryPoints: [path.resolve("src/electron/database/async/database-worker.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: workerPath,
    external: ["better-sqlite3", "electron"],
    logLevel: "silent",
  });
});

afterAll(() => {
  fs.rmSync(workerPath, { force: true });
});

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function stable(value: unknown, start: number): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, entry) => {
      if (typeof entry === "string")
        return entry.replace(UUID, "<uuid>").replace(/\/[^"]*cowork-services-[^"/]*/g, "<dir>");
      if (typeof entry === "number" && entry >= start - 60_000 && entry < start + 3_600_000) {
        return "<now>";
      }
      return entry;
    }),
  );
}

describe("agent repositories on the host and in the database worker", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  const previousUserDataDir = process.env.COWORK_USER_DATA_DIR;

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    setStatementClient(null, null, null);
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    vi.restoreAllMocks();
  });

  async function runWorkload(backend: "host" | "worker") {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), `cowork-services-${backend}-`)),
    );
    process.env.COWORK_USER_DATA_DIR = dir;
    const manager = new DatabaseManager();
    const db = manager.getDatabase();
    let calls = 0;
    let client: DatabaseClient | null = null;
    if (backend === "worker") {
      client = await DatabaseClient.start({
        dbPath: manager.getDatabasePath(),
        requiredTables: requiredTablesFor(DATABASE_COMMANDS),
        workerPath,
      });
      const execute = client.execute.bind(client);
      vi.spyOn(client, "execute").mockImplementation(((name: string, args: unknown) => {
        if (name.startsWith("statements.")) calls += 1;
        return execute(name as Parameters<typeof execute>[0], args as never);
      }) as typeof client.execute);
      setStatementClient("services", manager.getDatabasePath(), client);
    }
    cleanups.push(async () => {
      await client?.close(2_000);
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const start = Date.now();
    const workspaceDir = path.join(dir, "ws");
    fs.mkdirSync(workspaceDir);
    const workspace = new WorkspaceStore(db).create("Services", workspaceDir, {
      read: true,
      write: true,
      delete: false,
      network: false,
      shell: false,
    });
    const task = new TaskStore(db).create({
      title: "Services parity",
      prompt: "services",
      status: "executing",
      workspaceId: workspace.id,
    });

    const roles = new AgentRoleRepository(db);
    const lead = await roles.create({
      name: "parity-lead",
      displayName: "Parity Lead",
      capabilities: ["code"],
    } as never);
    const helper = await roles.create({
      name: "parity-helper",
      displayName: "Parity Helper",
      capabilities: ["review"],
    } as never);
    await roles.update({ id: helper.id, description: "Helps with parity" } as never);
    await roles.updateHeartbeatConfig(lead.id, {
      heartbeatEnabled: true,
      heartbeatIntervalMinutes: 60,
    } as never);

    const teams = new AgentTeamRepository(db);
    const team = await teams.create({
      workspaceId: workspace.id,
      name: "Parity team",
      leadAgentRoleId: lead.id,
    });
    const members = new AgentTeamMemberRepository(db);
    await members.add({ teamId: team.id, agentRoleId: helper.id } as never);

    const mentions = new MentionRepository(db);
    const mention = await mentions.create({
      workspaceId: workspace.id,
      taskId: task.id,
      fromAgentRoleId: lead.id,
      toAgentRoleId: helper.id,
      mentionType: "request",
      context: "Please check",
    } as never);
    await mentions.acknowledge(mention.id);

    const subscriptions = new TaskSubscriptionRepository(db);
    await subscriptions.subscribe(task.id, helper.id, "mentioned" as never);

    const result = stable(
      {
        helper: await roles.findById(helper.id),
        leadByName: (await roles.findByName("parity-lead"))?.id === lead.id,
        heartbeatEnabled: (await roles.findHeartbeatEnabled()).map((role) => role.id === lead.id),
        profile: await new AutomationProfileRepository(db).findByAgentRoleId(lead.id),
        team: await teams.findById(team.id),
        members: await members.listByTeam(team.id),
        pending: await mentions.getPendingCount(helper.id, workspace.id),
        mention: await mentions.findById(mention.id),
        subscribed: await subscriptions.isSubscribed(task.id, helper.id),
        subscribers: await subscriptions.getSubscriberIds(task.id),
      },
      start,
    );
    return { calls, result };
  }

  async function runRoutineWorkload(backend: "host" | "worker") {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), `cowork-services-routines-${backend}-`)),
    );
    process.env.COWORK_USER_DATA_DIR = dir;
    const manager = new DatabaseManager();
    const db = manager.getDatabase();
    let calls = 0;
    let client: DatabaseClient | null = null;
    if (backend === "worker") {
      client = await DatabaseClient.start({
        dbPath: manager.getDatabasePath(),
        requiredTables: requiredTablesFor(DATABASE_COMMANDS),
        workerPath,
      });
      const execute = client.execute.bind(client);
      vi.spyOn(client, "execute").mockImplementation(((name: string, args: unknown) => {
        if (name.startsWith("statements.")) calls += 1;
        return execute(name as Parameters<typeof execute>[0], args as never);
      }) as typeof client.execute);
      setStatementClient("services", manager.getDatabasePath(), client);
    }
    cleanups.push(async () => {
      await client?.close(2_000);
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    // The service creates the routine tables on the host connection.
    new RoutineService({
      db,
      getCronService: () => null,
      getEventTriggerService: () => null,
      loadHooksSettings: () => ({ enabled: false, mappings: [], presets: [] }) as never,
      saveHooksSettings: () => undefined,
    } as never);
    let clock = 1_779_000_000_000;
    const now = () => (clock += 1_000);
    const rows = new RoutineRepository(db);
    const workflow = new RoutineWorkflowRepository(db, now);

    await rows.persistRoutine({
      id: "routine-1",
      name: "Parity routine",
      description: null,
      enabled: 1,
      workspaceId: "ws-1",
      prompt: "Summarize",
      connectorsJson: "[]",
      triggersJson: "[]",
      definitionJson: "{}",
      createdAt: 1,
      updatedAt: 2,
    });
    const runInput = {
      routineId: "routine-1",
      triggerId: "trigger-1",
      triggerType: "schedule",
      status: "running",
      startedAt: 10,
      outputStatus: "none",
      dedupeKey: "key:routine-1:run-1",
      runKey: "run-1",
    };
    // Two upserts of the same run resolve to one row.
    const first = await rows.upsertRunRow({ ...runInput, newId: "run-a", now: 100 });
    const second = await rows.upsertRunRow({
      ...runInput,
      newId: "run-b",
      now: 200,
      status: "completed",
    });

    const definition = {
      version: 1,
      starterNodeId: "starter",
      nodes: [
        { id: "starter", kind: "starter", operation: "starter.manual", name: "Manual", config: {} },
      ],
      edges: [],
    } as never;
    const version = await workflow.createVersion("routine-1", definition);
    await workflow.activateVersion(version.id);
    const run = await workflow.createRun({
      routineId: "routine-1",
      workflowVersionId: version.id,
      triggerNodeId: "starter",
      context: { input: "x" },
    });
    await workflow.updateRun(run.id, { status: "completed", finishedAt: 5 });
    await workflow.enqueueEvent({
      routineId: "routine-1",
      triggerNodeId: "starter",
      source: "manual",
      idempotencyKey: "event-1",
      payload: { hello: "world" },
    });
    const claimed = await workflow.claimNextEvent();
    const pruned = await workflow.pruneExpiredData();

    const result = {
      routines: await rows.listRoutineRows(),
      runIds: [first.id, second.id],
      runs: await rows.listRunRows("routine-1", 10),
      version: await workflow.getActiveVersion("routine-1"),
      run: await workflow.getRun(run.id),
      claimed,
      events: await workflow.listEvents("routine-1", 10),
      pruned,
    };
    await rows.deleteRoutine("routine-1");
    return {
      calls,
      result: {
        ...(stable(result, 0) as object),
        afterDelete: {
          routines: (await rows.listRoutineRows()).length,
          runs: (await rows.listRunRows("routine-1", 10)).length,
          versions: (await workflow.listVersions("routine-1")).length,
        },
      },
    };
  }

  async function runCoreWorkload(backend: "host" | "worker") {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), `cowork-services-core-${backend}-`)),
    );
    process.env.COWORK_USER_DATA_DIR = dir;
    const manager = new DatabaseManager();
    const db = manager.getDatabase();
    let calls = 0;
    let client: DatabaseClient | null = null;
    if (backend === "worker") {
      client = await DatabaseClient.start({
        dbPath: manager.getDatabasePath(),
        requiredTables: requiredTablesFor(DATABASE_COMMANDS),
        workerPath,
      });
      const execute = client.execute.bind(client);
      vi.spyOn(client, "execute").mockImplementation(((name: string, args: unknown) => {
        if (name.startsWith("statements.")) calls += 1;
        return execute(name as Parameters<typeof execute>[0], args as never);
      }) as typeof client.execute);
      setStatementClient("services", manager.getDatabasePath(), client);
    }
    cleanups.push(async () => {
      await client?.close(2_000);
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    // Traces belong to an automation profile, which belongs to an agent role.
    const role = new AgentRoleStore(db).create({
      name: "core-parity",
      displayName: "Core Parity",
      capabilities: ["code"],
    } as never);
    const profile = new AutomationProfileStore(db).createOrReplace({
      agentRoleId: role.id,
      enabled: true,
      cadenceMinutes: 60,
    } as never);
    const traces = new CoreTraceRepository(db);
    const trace = await traces.create({
      id: "trace-1",
      profileId: profile.id,
      sourceSurface: "heartbeat",
      traceKind: "heartbeat",
      status: "running",
      startedAt: 10,
      createdAt: 10,
    } as never);
    await traces.appendEvent({
      id: "event-1",
      traceId: trace.id,
      phase: "dispatch",
      eventType: "dispatch_started",
      summary: "Started",
      createdAt: 11,
    } as never);
    await traces.update(trace.id, { status: "completed", completedAt: 12 } as never);

    const clusters = new CoreFailureClusterRepository(db);
    const cluster = await clusters.create({
      id: "cluster-1",
      profileId: profile.id,
      category: "tool_failure",
      fingerprint: "fp-1",
      rootCauseSummary: "Tool timed out",
      status: "open",
      recurrenceCount: 1,
      firstSeenAt: 10,
      lastSeenAt: 10,
      createdAt: 10,
      updatedAt: 10,
    } as never);
    await new CoreFailureRecordRepository(db).create({
      id: "failure-1",
      traceId: trace.id,
      profileId: profile.id,
      category: "tool_failure",
      severity: "medium",
      fingerprint: "fp-1",
      summary: "Tool timed out",
      status: "open",
      sourceSurface: "heartbeat",
      createdAt: 12,
    } as never);
    await clusters.addMember(cluster.id, "failure-1", 16);

    const learnings = new CoreLearningsRepository(db);
    await learnings.append({
      id: "learning-1",
      profileId: profile.id,
      kind: "failure_cluster",
      summary: "Timeouts recur",
      relatedClusterId: cluster.id,
      createdAt: 13,
    });
    const scope = new CoreMemoryScopeStateRepository(db);
    await scope.touchTrace("profile" as never, "profile-1", 14);
    await scope.touchDistill("profile" as never, "profile-1", 15);

    return {
      calls,
      result: stable(
        {
          trace: await traces.findById(trace.id),
          events: await traces.listEvents(trace.id),
          cluster: await clusters.findByFingerprint(profile.id, undefined, "fp-1"),
          members: await clusters.listMemberIds(cluster.id),
          learnings: await learnings.list({ profileId: profile.id } as never),
          scope: await scope.get("profile" as never, "profile-1"),
        },
        0,
      ),
    };
  }

  async function runSubconsciousWorkload(backend: "host" | "worker") {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), `cowork-services-subconscious-${backend}-`)),
    );
    process.env.COWORK_USER_DATA_DIR = dir;
    const manager = new DatabaseManager();
    const db = manager.getDatabase();
    new SecureSettingsRepository(db);
    SubconsciousSettingsManager.clearCache();
    let calls = 0;
    let client: DatabaseClient | null = null;
    if (backend === "worker") {
      client = await DatabaseClient.start({
        dbPath: manager.getDatabasePath(),
        requiredTables: requiredTablesFor(DATABASE_COMMANDS),
        workerPath,
      });
      const execute = client.execute.bind(client);
      vi.spyOn(client, "execute").mockImplementation(((name: string, args: unknown) => {
        if (name.startsWith("statements.")) calls += 1;
        return execute(name as Parameters<typeof execute>[0], args as never);
      }) as typeof client.execute);
      setStatementClient("services", manager.getDatabasePath(), client);
    }
    cleanups.push(async () => {
      await client?.close(2_000);
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const workspaceDir = path.join(dir, "ws");
    fs.mkdirSync(workspaceDir);
    const workspace = new WorkspaceStore(db).create("Subconscious", workspaceDir, {
      read: true,
      write: true,
      delete: false,
      network: false,
      shell: false,
    });
    new TaskStore(db).create({
      title: "Evidence task",
      prompt: "evidence",
      status: "failed",
      workspaceId: workspace.id,
    });

    // The refresh reads every evidence source in one reporting unit, upserts the targets
    // and clears stale ones; a second refresh after removing the task keeps it stable.
    const service = new SubconsciousLoopService(db, { getGlobalRoot: () => workspaceDir });
    const first = await service.refreshTargets();
    const second = await service.refreshTargets();
    const targets = (await service.listTargets()).map((target) => ({
      key: target.key.replace(workspace.id, "<workspace>"),
      kind: target.target.kind,
      evidenceCount: target.evidenceCount,
    }));
    return {
      calls,
      // Target keys, kinds and counts carry no timestamps or generated ids.
      result: {
        firstCount: first.targetCount,
        secondCount: second.targetCount,
        targets: targets.sort((a, b) => a.key.localeCompare(b.key)),
      },
    };
  }

  async function runManagedWorkload(backend: "host" | "worker") {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), `cowork-services-managed-${backend}-`)),
    );
    process.env.COWORK_USER_DATA_DIR = dir;
    const manager = new DatabaseManager();
    const db = manager.getDatabase();
    let calls = 0;
    let client: DatabaseClient | null = null;
    if (backend === "worker") {
      client = await DatabaseClient.start({
        dbPath: manager.getDatabasePath(),
        requiredTables: requiredTablesFor(DATABASE_COMMANDS),
        workerPath,
      });
      const execute = client.execute.bind(client);
      vi.spyOn(client, "execute").mockImplementation(((name: string, args: unknown) => {
        if (name.startsWith("statements.")) calls += 1;
        return execute(name as Parameters<typeof execute>[0], args as never);
      }) as typeof client.execute);
      setStatementClient("services", manager.getDatabasePath(), client);
    }
    cleanups.push(async () => {
      await client?.close(2_000);
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    // The service creates its governance tables on the host connection.
    new ManagedSessionService(db, {} as never);
    const rows = new ManagedRepository(db);
    // The first role read seeds the workspace's admin; a second seed is a no-op.
    const ownerRole = await rows.workspaceRole("ws-1", "owner", "owner", 10, "membership-a");
    await rows.seedMembership("ws-1", "someone-else", 11, "membership-b");
    const outsiderRole = await rows.workspaceRole("ws-1", "outsider", "owner", 12, "membership-c");
    const firstId = await rows.upsertMembership({
      workspaceId: "ws-1",
      principalId: "reviewer",
      role: "viewer",
      now: 20,
      newId: "membership-d",
    });
    // Changing the role keeps the membership's id.
    const secondId = await rows.upsertMembership({
      workspaceId: "ws-1",
      principalId: "reviewer",
      role: "operator",
      now: 30,
      newId: "membership-e",
    });
    await rows.insertAudit({
      id: "audit-1",
      agentId: "agent-1",
      workspaceId: "ws-1",
      actorId: "owner",
      action: "membership_updated",
      summary: "Updated reviewer",
      metadataJson: null,
      createdAt: 40,
    });
    const result = {
      ownerRole,
      outsiderRole: outsiderRole ?? null,
      membershipIds: [firstId, secondId],
      memberships: await rows.listMembershipRows("ws-1"),
      audit: await rows.listAuditRows("agent-1", 10),
      routines: await rows.listRoutineRows(),
    };
    // Read after the result's own reads have run.
    return { calls, result };
  }

  async function runIdentityWorkload(backend: "host" | "worker") {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), `cowork-services-identity-${backend}-`)),
    );
    process.env.COWORK_USER_DATA_DIR = dir;
    const manager = new DatabaseManager();
    const db = manager.getDatabase();
    let calls = 0;
    let client: DatabaseClient | null = null;
    if (backend === "worker") {
      client = await DatabaseClient.start({
        dbPath: manager.getDatabasePath(),
        requiredTables: requiredTablesFor(DATABASE_COMMANDS),
        workerPath,
      });
      const execute = client.execute.bind(client);
      vi.spyOn(client, "execute").mockImplementation(((name: string, args: unknown) => {
        if (name.startsWith("statements.")) calls += 1;
        return execute(name as Parameters<typeof execute>[0], args as never);
      }) as typeof client.execute);
      setStatementClient("services", manager.getDatabasePath(), client);
    }
    cleanups.push(async () => {
      await client?.close(2_000);
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const identities = new ContactIdentityService(db);
    // The whole resolution (identity, handles, candidates) is one unit; resolving the same
    // contact again reuses the identity.
    const first = await identities.resolveMailboxContact({
      workspaceId: "ws-1",
      email: "Ada@Example.com",
      displayName: "Ada Lovelace",
      companyHint: "Analytical Engines",
      crmHints: ["crm-42"],
    });
    const second = await identities.resolveMailboxContact({
      workspaceId: "ws-1",
      email: "ada@example.com",
      displayName: "Ada L.",
    });
    const identityId = first.identity!.id;
    await identities.linkManualHandle({
      workspaceId: "ws-1",
      contactIdentityId: identityId,
      handleType: "phone",
      normalizedValue: "+15550100",
      displayValue: "+1 555 0100",
    } as never);
    const identity = await identities.getIdentity(identityId);
    const result = stable(
      {
        sameIdentity: second.identity?.id === identityId,
        reasonCodes: first.reasonCodes,
        handles: (identity?.handles || [])
          .map((handle) => `${handle.handleType}:${handle.normalizedValue}`)
          .sort(),
        identities: (await identities.listIdentities("ws-1")).length,
        coverage: await identities.getCoverageStats("ws-1"),
      },
      0,
    );
    // Read after the result's own reads have run.
    return { calls, result };
  }

  async function runActivityWorkload(backend: "host" | "worker") {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), `cowork-services-activity-${backend}-`)),
    );
    process.env.COWORK_USER_DATA_DIR = dir;
    const manager = new DatabaseManager();
    const db = manager.getDatabase();
    const start = Date.now();
    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at, permissions)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("ws-1", "Workspace", path.join(dir, "workspace"), 1, "{}");
    let calls = 0;
    let client: DatabaseClient | null = null;
    if (backend === "worker") {
      client = await DatabaseClient.start({
        dbPath: manager.getDatabasePath(),
        requiredTables: requiredTablesFor(DATABASE_COMMANDS),
        workerPath,
      });
      const execute = client.execute.bind(client);
      vi.spyOn(client, "execute").mockImplementation(((name: string, args: unknown) => {
        if (name.startsWith("statements.")) calls += 1;
        return execute(name as Parameters<typeof execute>[0], args as never);
      }) as typeof client.execute);
      setStatementClient("services", manager.getDatabasePath(), client);
    }
    // An activity the timeline writer accepted but has not committed. Writes must commit
    // it rather than miss it, and must not ask the writer to commit it on the host.
    const pending = ActivityRepository.prepareForInsert({
      workspaceId: "ws-1",
      actorType: "agent",
      activityType: "info",
      title: "Pending activity",
    } as never);
    const unregister = registerPendingTimelineWrites(db, {
      pendingActivities: () => [pending],
      flushTask: () => undefined,
      flushEvent: () => undefined,
      flushActivities: () => {
        throw new Error("activity writes must not commit pending rows on the host");
      },
      flushAll: () => undefined,
    });
    cleanups.push(async () => {
      unregister();
      await client?.close(2_000);
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const activities = new ActivityRepository(db);
    const created = await activities.create({
      workspaceId: "ws-1",
      actorType: "system",
      activityType: "info",
      title: "Committed activity",
    } as never);
    const listedBefore = await activities.list({ workspaceId: "ws-1" } as never);
    const unreadBefore = await activities.getUnreadCount("ws-1");
    const markedPending = await activities.markRead(pending.id);
    const unreadAfter = await activities.getUnreadCount("ws-1");
    const unreadListed = await activities.list({ workspaceId: "ws-1", isRead: false } as never);
    const pinned = await activities.togglePin(created.id);

    const missionControl = new MissionControlIntelligenceService(db);
    const brief = await missionControl.refresh({ workspaceId: "ws-1" });
    const items = await missionControl.listItems({ workspaceId: "ws-1" });
    const result = stable(
      {
        listedBefore: listedBefore.map((activity) => activity.title),
        unreadBefore,
        markedPending,
        unreadAfter,
        unreadListed: unreadListed.map((activity) => activity.title),
        pinned: pinned?.isPinned,
        pendingCommitted: Boolean(
          db.prepare("SELECT 1 FROM activity_feed WHERE id = ? AND is_read = 1").get(pending.id),
        ),
        brief: { attention: brief.attentionCount, activeWork: brief.activeWorkCount },
        items: items.map((item) => `${item.category}:${item.title}`).sort(),
      },
      start,
    );
    return { calls, result };
  }

  it("keeps the activity feed and Mission Control the same on either backend", async () => {
    const host = await runActivityWorkload("host");
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    setStatementClient(null, null, null);
    vi.restoreAllMocks();
    const worker = await runActivityWorkload("worker");

    expect(host.calls).toBe(0);
    expect(worker.calls).toBe(9);
    expect(worker.result).toEqual(host.result);
    const result = host.result as Record<string, Any>;
    expect(result.listedBefore).toEqual(["Committed activity", "Pending activity"]);
    expect(result.unreadBefore).toBe(2);
    expect(result.markedPending).toBe(true);
    expect(result.unreadAfter).toBe(1);
    expect(result.unreadListed).toEqual(["Committed activity"]);
    expect(result.pendingCommitted).toBe(true);
  });

  async function runEverydayAgentWorkload(backend: "host" | "worker") {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), `cowork-services-everyday-${backend}-`)),
    );
    process.env.COWORK_USER_DATA_DIR = dir;
    const manager = new DatabaseManager();
    const db = manager.getDatabase();
    const start = Date.now();
    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at, permissions)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("ws-1", "Workspace", path.join(dir, "workspace"), 1, "{}");
    let calls = 0;
    let client: DatabaseClient | null = null;
    if (backend === "worker") {
      client = await DatabaseClient.start({
        dbPath: manager.getDatabasePath(),
        requiredTables: requiredTablesFor(DATABASE_COMMANDS),
        workerPath,
      });
      const execute = client.execute.bind(client);
      vi.spyOn(client, "execute").mockImplementation(((name: string, args: unknown) => {
        if (name.startsWith("statements.")) calls += 1;
        return execute(name as Parameters<typeof execute>[0], args as never);
      }) as typeof client.execute);
      setStatementClient("services", manager.getDatabasePath(), client);
    }
    cleanups.push(async () => {
      await client?.close(2_000);
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    // Admin policies are read on the host (defaults: no policy file) and passed to each unit.
    const everyday = new EverydayAgentService(db);
    const consent = await everyday.acceptConsent({ enabled: true, workspaceId: "ws-1" });
    const draft = { title: "Stage reply", action: "Draft email reply", capability: "inbox" };
    const approved = await everyday.approveAction({
      previewId: (await everyday.previewAction({ ...draft, workspaceId: "ws-1" } as never)).id,
    });
    const stale = await everyday.previewAction({
      ...draft,
      title: "Stage another reply",
      workspaceId: "ws-1",
    } as never);
    // Expire the preview on disk; the refusal's "expired" mark must survive the refusal.
    const row = db
      .prepare("SELECT preview_json FROM everyday_agent_action_previews WHERE id = ?")
      .get(stale.id) as { preview_json: string };
    db.prepare("UPDATE everyday_agent_action_previews SET preview_json = ? WHERE id = ?").run(
      JSON.stringify({ ...JSON.parse(row.preview_json), expiresAt: start - 1 }),
      stale.id,
    );
    const refusal = await everyday.approveAction({ previewId: stale.id }).then(
      () => "approved",
      (error: Error) => error.message,
    );
    const staleStatus = (
      db
        .prepare("SELECT status FROM everyday_agent_action_previews WHERE id = ?")
        .get(stale.id) as {
        status: string;
      }
    ).status;
    const receipts = await everyday.listReceipts({ workspaceId: "ws-1" });
    const cleared = await everyday.clearData({ previews: true });
    const result = stable(
      {
        enabled: consent.profile.enabled,
        managedAgentId: consent.profile.managedAgentId,
        managedEnvironmentId: consent.profile.managedEnvironmentId,
        allowed: consent.compiledPolicy.allowedCapabilities,
        approved: { status: approved.status, capability: approved.capability },
        refusal,
        staleStatus,
        receipts: receipts.map((receipt) => `${receipt.status}:${receipt.title}`).sort(),
        previewsLeft: (
          db.prepare("SELECT COUNT(*) AS count FROM everyday_agent_action_previews").get() as {
            count: number;
          }
        ).count,
        clearedEnabled: cleared.profile.enabled,
      },
      start,
    );
    return { calls, result };
  }

  it("runs Everyday Agent consent, approvals and clearing the same on either backend", async () => {
    const host = await runEverydayAgentWorkload("host");
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    setStatementClient(null, null, null);
    vi.restoreAllMocks();
    const worker = await runEverydayAgentWorkload("worker");

    expect(host.calls).toBe(0);
    expect(worker.calls).toBe(13);
    expect(worker.result).toEqual(host.result);
    const result = host.result as Record<string, Any>;
    expect(result.enabled).toBe(true);
    expect(result.approved.status).toBe("approved");
    expect(result.refusal).toMatch(/preview expired/i);
    expect(result.staleStatus).toBe("expired");
    expect(result.previewsLeft).toBe(0);
  });

  async function runEvalWorkload(backend: "host" | "worker") {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), `cowork-services-eval-${backend}-`)),
    );
    process.env.COWORK_USER_DATA_DIR = dir;
    const manager = new DatabaseManager();
    const db = manager.getDatabase();
    const start = Date.now();
    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at, permissions)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("workspace-1", "Workspace", path.join(dir, "workspace"), 1, "{}");
    const tasks = new TaskStore(db);
    const task = tasks.create({
      title: "Replay case",
      prompt: "Produce the replay output",
      status: "executing",
      workspaceId: "workspace-1",
      source: "test",
    } as never);
    const protocol = new WorkSessionProtocolService(db);
    for (const [id, type, payload] of [
      ["replay-assistant", "assistant_message", { message: "replay says 42" }],
      ["replay-complete", "task_completed", { resultSummary: "replay says 42" }],
    ] as const) {
      protocol.recordTaskEvent(task.id, {
        id,
        eventId: id,
        taskId: task.id,
        timestamp: start,
        type,
        schemaVersion: 2,
        payload,
      } as never);
    }
    tasks.update(task.id, { status: "completed", terminalStatus: "ok" } as never);
    let calls = 0;
    let client: DatabaseClient | null = null;
    if (backend === "worker") {
      client = await DatabaseClient.start({
        dbPath: manager.getDatabasePath(),
        requiredTables: requiredTablesFor(DATABASE_COMMANDS),
        workerPath,
      });
      const execute = client.execute.bind(client);
      vi.spyOn(client, "execute").mockImplementation(((name: string, args: unknown) => {
        if (name.startsWith("statements.")) calls += 1;
        return execute(name as Parameters<typeof execute>[0], args as never);
      }) as typeof client.execute);
      setStatementClient("services", manager.getDatabasePath(), client);
    }
    cleanups.push(async () => {
      await client?.close(2_000);
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const evals = new EvalService(db);
    // Creating a case links it on the task and adds it to the default suite in one unit;
    // a suite run grades every case and records the results in one unit.
    const evalCase = await evals.createCaseFromTask(task.id);
    const suites = await evals.listSuites();
    const run = await evals.runSuite(suites[0]!.id);
    const reloaded = await evals.getRun(run.id);
    const linked = db.prepare("SELECT eval_case_id FROM tasks WHERE id = ?").get(task.id) as {
      eval_case_id?: string;
    };
    const result = stable(
      {
        linkedOnTask: linked.eval_case_id === evalCase.id,
        caseName: evalCase.name.replace(task.id.slice(0, 8), "<id>"),
        assertions: evalCase.assertions,
        suites: suites.map((suite) => ({ name: suite.name, caseCount: suite.caseCount })),
        run: {
          status: run.status,
          passCount: run.passCount,
          failCount: run.failCount,
          caseRuns: reloaded?.caseRuns.map((caseRun) => caseRun.status),
        },
        metrics: await evals.getBaselineMetrics(30),
      },
      start,
    );
    return { calls, result };
  }

  it("creates and runs eval cases the same on either backend", async () => {
    const host = await runEvalWorkload("host");
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    setStatementClient(null, null, null);
    vi.restoreAllMocks();
    const worker = await runEvalWorkload("worker");

    expect(host.calls).toBe(0);
    expect(worker.calls).toBe(5);
    expect(worker.result).toEqual(host.result);
    const result = host.result as Record<string, Any>;
    expect(result.linkedOnTask).toBe(true);
    expect(result.run).toMatchObject({ status: "completed", passCount: 1, caseRuns: ["pass"] });
  });

  async function runWorkspaceWorkload(backend: "host" | "worker") {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), `cowork-services-workspaces-${backend}-`)),
    );
    process.env.COWORK_USER_DATA_DIR = dir;
    const manager = new DatabaseManager();
    const db = manager.getDatabase();
    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at, permissions)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("workspace-1", "Workspace", path.join(dir, "workspace"), 1, "{}");
    let calls = 0;
    let client: DatabaseClient | null = null;
    if (backend === "worker") {
      client = await DatabaseClient.start({
        dbPath: manager.getDatabasePath(),
        requiredTables: requiredTablesFor(DATABASE_COMMANDS),
        workerPath,
      });
      const execute = client.execute.bind(client);
      vi.spyOn(client, "execute").mockImplementation(((name: string, args: unknown) => {
        if (name.startsWith("statements.")) calls += 1;
        return execute(name as Parameters<typeof execute>[0], args as never);
      }) as typeof client.execute);
      setStatementClient("services", manager.getDatabasePath(), client);
    }
    cleanups.push(async () => {
      await client?.close(2_000);
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const contexts = new WorkContextService(db);
    const memberships = new SessionMembershipService(db);
    const rejection = (promise: Promise<unknown>) =>
      promise.then(
        () => "resolved",
        (error: Error) => error.message,
      );
    // The local principal is read once on the host; every other operation is one unit,
    // and each authorization check shares its unit with the write it guards.
    const owner = memberships.getLocalPrincipal();
    const context = await contexts.create({ workspaceId: "workspace-1", name: "Shared work" });
    await memberships.ensureOwner(context.id);
    const invite = await memberships.createInvite({ contextId: context.id, role: "reviewer" });
    const accepted = await memberships.acceptInvite({
      token: invite.token,
      displayName: "Review partner",
      principalId: "partner-1",
    });
    const secondAccept = await rejection(
      memberships.acceptInvite({
        token: invite.token,
        displayName: "Second partner",
        principalId: "partner-2",
      }),
    );
    const reviewerManage = await rejection(
      memberships.updateMember(
        { contextId: context.id, memberId: accepted.member.id, revoke: true },
        accepted.principal.principalId,
      ),
    );
    const outsiderSnapshot = await rejection(memberships.getSnapshot(context.id, "outsider"));
    const snapshot = await memberships.getSnapshot(context.id);
    const result = stable(
      {
        secondAccept,
        reviewerManage,
        outsiderSnapshot,
        actorIsOwner: snapshot.actor.principalId === owner.principalId,
        members: snapshot.members.map((member) => `${member.role}:${member.status}`).sort(),
        partnerContexts: (
          await memberships.listAccessibleContexts({ workspaceId: "workspace-1" }, "partner-1")
        ).length,
        audit: (await memberships.listAudit(context.id)).map((entry) => entry.action).sort(),
      },
      0,
    );
    return { calls, result };
  }

  it("runs work context membership and authorization the same on either backend", async () => {
    const host = await runWorkspaceWorkload("host");
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    setStatementClient(null, null, null);
    vi.restoreAllMocks();
    const worker = await runWorkspaceWorkload("worker");

    expect(host.calls).toBe(0);
    expect(worker.calls).toBe(10);
    expect(worker.result).toEqual(host.result);
    const result = host.result as Record<string, Any>;
    expect(result.secondAccept).toContain("already been used");
    expect(result.reviewerManage).toContain("cannot manage");
    expect(result.outsiderSnapshot).toContain("Principal is not a member");
    expect(result.actorIsOwner).toBe(true);
    expect(result.members).toEqual(["owner:active", "reviewer:active"]);
  });

  it("resolves contact identities the same on either backend", async () => {
    const host = await runIdentityWorkload("host");
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    setStatementClient(null, null, null);
    vi.restoreAllMocks();
    const worker = await runIdentityWorkload("worker");

    expect(host.calls).toBe(0);
    expect(worker.calls).toBe(6);
    expect(worker.result).toEqual(host.result);
    const result = host.result as Record<string, Any>;
    expect(result.sameIdentity).toBe(true);
    expect(result.handles).toEqual(
      expect.arrayContaining(["email:ada@example.com", "phone:+15550100"]),
    );
  });

  it("runs managed-agent governance units the same on either backend", async () => {
    const host = await runManagedWorkload("host");
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    setStatementClient(null, null, null);
    vi.restoreAllMocks();
    const worker = await runManagedWorkload("worker");

    expect(host.calls).toBe(0);
    expect(worker.calls).toBe(9);
    expect(worker.result).toEqual(host.result);
    const result = host.result as Record<string, Any>;
    expect(result.ownerRole).toBe("admin");
    expect(result.outsiderRole).toBeNull();
    expect(result.membershipIds).toEqual(["membership-d", "membership-d"]);
    expect(result.memberships).toHaveLength(2);
    expect(result.audit).toHaveLength(1);
  });

  it("refreshes subconscious targets the same on either backend", async () => {
    const host = await runSubconsciousWorkload("host");
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    setStatementClient(null, null, null);
    vi.restoreAllMocks();
    const worker = await runSubconsciousWorkload("worker");

    expect(host.calls).toBe(0);
    expect(worker.calls).toBeGreaterThan(3);
    expect(worker.result).toEqual(host.result);
    const result = host.result as Record<string, Any>;
    expect(result.firstCount).toBeGreaterThanOrEqual(2);
    expect(result.targets.map((target: Any) => target.key)).toContain("global:brain");
  });

  it("runs core learning units the same on either backend", async () => {
    const host = await runCoreWorkload("host");
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    setStatementClient(null, null, null);
    vi.restoreAllMocks();
    const worker = await runCoreWorkload("worker");

    expect(host.calls).toBe(0);
    expect(worker.calls).toBeGreaterThan(8);
    expect(worker.result).toEqual(host.result);
    const result = host.result as Record<string, Any>;
    expect(result.trace.status).toBe("completed");
    expect(result.events).toHaveLength(1);
    expect(result.members).toEqual(["failure-1"]);
    expect(result.learnings).toHaveLength(1);
    expect(result.scope.lastDistillAt).toBeDefined();
  });

  it("runs routine rows and workflow units the same on either backend", async () => {
    const host = await runRoutineWorkload("host");
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    setStatementClient(null, null, null);
    vi.restoreAllMocks();
    const worker = await runRoutineWorkload("worker");

    expect(host.calls).toBe(0);
    expect(worker.calls).toBeGreaterThan(12);
    expect(worker.result).toEqual(host.result);
    const result = host.result as Record<string, Any>;
    expect(result.runIds).toEqual(["run-a", "run-a"]);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].status).toBe("completed");
    expect(result.claimed.status).toBe("processing");
    expect(result.afterDelete).toEqual({ routines: 0, runs: 0, versions: 0 });
  });

  it("returns the same results on either backend", async () => {
    const host = await runWorkload("host");
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    setStatementClient(null, null, null);
    vi.restoreAllMocks();
    const worker = await runWorkload("worker");

    expect(host.calls).toBe(0);
    expect(worker.calls).toBeGreaterThan(15);
    expect(worker.result).toEqual(host.result);
    const result = host.result as Record<string, Any>;
    expect(result.helper.description).toBe("Helps with parity");
    expect(result.leadByName).toBe(true);
    expect(result.heartbeatEnabled).toContain(true);
    expect(result.profile.enabled).toBe(true);
    expect(result.members).toHaveLength(1);
    expect(result.mention.status).toBe("acknowledged");
    expect(result.subscribed).toBe(true);
  });
});
