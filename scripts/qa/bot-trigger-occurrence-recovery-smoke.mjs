#!/usr/bin/env node
/**
 * Compiled Node occurrence-recovery acceptance using a disposable profile and the actual
 * services-domain SQLite worker. Effects are local fixture callbacks only; this script
 * never starts a provider, channel gateway, model, or Control Plane listener.
 *
 * Run after the daemon build:
 *   node scripts/qa/bot-trigger-occurrence-recovery-smoke.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), "../..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadDaemon(relativePath) {
  return require(path.join(root, "dist/daemon", relativePath));
}

function cleanEnvironment(profile) {
  const result = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "SystemRoot", "LANG", "LC_ALL"]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
  Object.assign(result, {
    COWORK_USER_DATA_DIR: profile,
    COWORK_PROFILE: "default",
    COWORK_HEADLESS: "1",
    COWORK_IMPORT_ENV_SETTINGS: "0",
    COWORK_DISABLE_OS_KEYCHAIN: "1",
    COWORK_LOG_LEVEL: "error",
    COWORK_DB_WORKER: "1",
    COWORK_DB_WORKER_SERVICES: "1",
    COWORK_DB_WORKER_TIMELINE: "0",
    COWORK_DB_WORKER_REPORTS: "0",
    COWORK_DB_WORKER_SETTINGS: "0",
    COWORK_DB_WORKER_STORAGE: "0",
    COWORK_DB_WORKER_MEMORY: "0",
    COWORK_DB_WORKER_MAILBOX: "0",
    COWORK_DB_WORKER_CONTROL_PLANE: "0",
  });
  return result;
}

function readLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeLine(filePath, value) {
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function selectOccurrence(db, triggerId) {
  return db
    .prepare(
      `SELECT id,status,receipt_json,error,attempt_count,trigger_snapshot_json,
              responsibility_snapshot_json
       FROM event_trigger_occurrences WHERE trigger_id=? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(triggerId);
}

function eventFor(source, eventId, text) {
  return {
    source,
    eventId,
    timestamp: 1_791_287_400_000,
    fields: { text, senderName: "synthetic fixture" },
  };
}

function waitForLine(host, marker, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (host.stdout.includes(marker)) return resolve();
      if (host.exit) return reject(new Error(`Child exited before ${marker}: ${host.stderr}`));
      if (Date.now() >= deadline)
        return reject(new Error(`Timed out waiting for ${marker}: ${host.stderr}`));
      setTimeout(poll, 25);
    };
    poll();
  });
}

function spawnFixtureChild(mode, directory, fixture) {
  const profile = path.join(directory, "profile");
  const child = spawn(
    process.execPath,
    [scriptPath, "--child", mode, directory, JSON.stringify(fixture)],
    { cwd: root, env: cleanEnvironment(profile), stdio: ["ignore", "pipe", "pipe"] },
  );
  const host = { child, stdout: "", stderr: "", exit: null, exitPromise: null };
  child.stdout.on("data", (chunk) => {
    host.stdout = (host.stdout + String(chunk)).slice(-128_000);
  });
  child.stderr.on("data", (chunk) => {
    host.stderr = (host.stderr + String(chunk)).slice(-128_000);
  });
  host.exitPromise = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      host.exit = { code, signal };
      resolve(host.exit);
    });
  });
  return host;
}

async function finishChild(host) {
  const exit = await host.exitPromise;
  assert.deepEqual(exit, { code: 0, signal: null }, `Child failed: ${host.stderr}`);
  const resultLine = host.stdout.split("\n").find((line) => line.startsWith("FIXTURE_RESULT="));
  assert(resultLine, `Child omitted its result: ${host.stdout}\n${host.stderr}`);
  return JSON.parse(resultLine.slice("FIXTURE_RESULT=".length));
}

async function stopWithSignal(host) {
  assert.equal(host.exit, null, "Crash fixture child already exited");
  host.child.kill("SIGKILL");
  const exit = await host.exitPromise;
  assert.equal(exit.signal, "SIGKILL");
}

async function seedFixture(directory) {
  const { DatabaseManager } = loadDaemon("electron/database/schema.js");
  const { WorkspaceStore } = loadDaemon("electron/database/repositories.js");
  const { AgentRoleStore } = loadDaemon("electron/agents/AgentRoleRepository.js");
  const { EventTriggerService } = loadDaemon("electron/triggers/EventTriggerService.js");
  const { RoutineService } = loadDaemon("electron/routines/service.js");
  const { BotResponsibilityService } = loadDaemon(
    "electron/automation/BotResponsibilityService.js",
  );
  const { SchedulerLeaseStore } = loadDaemon("electron/automation/scheduler-lease-store.js");
  const profile = path.join(directory, "profile");
  const workspacePath = path.join(directory, "workspace");
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  fs.mkdirSync(workspacePath, { recursive: true, mode: 0o700 });

  const manager = new DatabaseManager({ dbPath: path.join(profile, "cowork-os.db") });
  let triggers;
  let routines;
  try {
    const db = manager.getDatabase();
    const workspace = new WorkspaceStore(db).create("Synthetic trigger acceptance", workspacePath, {
      read: true,
      write: false,
      delete: false,
      shell: false,
      network: false,
    });
    const fixtureDeps = {
      createTask: async () => {
        throw new Error("Seeding must not dispatch a trigger task");
      },
      getDefaultWorkspaceId: () => workspace.id,
    };
    triggers = new EventTriggerService(fixtureDeps, db);
    await triggers.start();
    const add = (name, source, action, cooldownMs = 0) =>
      triggers.addTrigger({
        name,
        enabled: true,
        source,
        conditions: [],
        action,
        workspaceId: workspace.id,
        cooldownMs,
      });
    const race = await add("fixture race", "webhook", {
      type: "create_task",
      config: { prompt: "fixture/race" },
    });
    const preIntent = await add("fixture pre-intent", "github_event", {
      type: "create_task",
      config: { prompt: "fixture/pre-intent" },
    });
    const completedDelivery = await add("fixture completed delivery", "connector_event", {
      type: "send_message",
      config: {
        channelType: "slack",
        channelId: "fixture-destination",
        message: "fixture/completed",
      },
    });
    const uncertainDelivery = await add("fixture uncertain delivery", "file_change", {
      type: "send_message",
      config: {
        channelType: "slack",
        channelId: "fixture-destination",
        message: "fixture/uncertain",
      },
    });
    const legacy = await add(
      "fixture legacy processing",
      "cron_event",
      { type: "create_task", config: { prompt: "fixture/legacy-must-not-run" } },
      60_000,
    );
    const definitionDrift = await add("fixture definition drift", "email", {
      type: "create_task",
      config: { prompt: "fixture/original-definition" },
    });

    const bot = new AgentRoleStore(db).create({
      name: "stage74-synthetic-role",
      displayName: "Synthetic",
      description: "Disposable acceptance fixture",
      systemPrompt: "Synthetic fixture only",
      capabilities: [],
    });
    db.prepare(
      `INSERT INTO channels(id,type,name,enabled,config,security_config,created_at,updated_at)
       VALUES('fixture-history','slack','Synthetic history',1,'{}','{}',0,0)`,
    ).run();
    db.prepare(
      `INSERT INTO channel_messages(id,channel_id,channel_message_id,chat_id,direction,content,timestamp)
       VALUES('fixture-history-message','fixture-history','fixture-message','selected-chat','incoming','A',1)`,
    ).run();

    const emptyHooks = {
      enabled: false,
      token: "fixture-only",
      path: "/hooks",
      maxBodyBytes: 1024,
      presets: [],
      mappings: [],
    };
    const neverCreate = async () => {
      throw new Error("Seeding must not run workflow tasks");
    };
    routines = new RoutineService({
      db,
      getCronService: () => null,
      getEventTriggerService: () => triggers,
      loadHooksSettings: () => emptyHooks,
      saveHooksSettings: () => {},
      createTask: neverCreate,
    });
    const lease = new SchedulerLeaseStore(db);
    const fence = lease.acquire({ owner: "stage74-fixture", now: Date.now(), leaseMs: 60_000 });
    assert(fence, "Could not acquire fixture scheduler lease");
    const responsibilities = new BotResponsibilityService(db, {
      runtime: () => "node",
      getRoutineService: () => routines,
      assertOwnership: async () => {},
      getSchedulerFence: () => fence,
    });
    const routine = await routines.create({
      name: "Synthetic selected-chat responsibility",
      enabled: false,
      workspaceId: workspace.id,
      prompt: "Inspect selected synthetic source",
      connectors: [],
      triggers: [
        {
          id: "fixture-channel-trigger",
          type: "channel_event",
          enabled: true,
          channelType: "slack",
          chatId: "selected-chat",
          cooldownMs: 0,
        },
      ],
    });
    const saved = await responsibilities.create({
      scope: { workspaceId: workspace.id, agentRoleId: bot.id },
      definition: {
        objective: "Inspect selected synthetic chat",
        engine: { kind: "routine", id: routine.id },
        mode: "observe",
        sources: [
          { connectorId: "gateway:slack", method: "channel_history", resourceId: "selected-chat" },
        ],
        permittedActions: [],
        expectedOutput: "Internal synthetic report",
        reviewBoundary: "all_effects",
        destination: { channel: "internal", id: "fixture-results" },
        backend: "node",
        budget: { maxTokens: 1000, maxCost: 0 },
      },
    });
    const scope = { workspaceId: workspace.id, agentRoleId: bot.id };
    const preview = await responsibilities.preview({ scope, definition: saved.definition });
    assert.equal(preview.activationAvailable, true, preview.activationIssues.join(" "));
    const active = await responsibilities.activate({
      scope,
      id: saved.id,
      expectedRevision: saved.revision,
      expectedControlVersion: saved.controlVersion,
    });
    const revisionTrigger = triggers
      .listTriggers()
      .find((item) => item.source === "channel_message" && item.workspaceId === workspace.id);
    assert(revisionTrigger, "Routine did not create the expected event trigger");

    const now = Date.now();
    db.prepare("UPDATE event_triggers SET last_fired_at=? WHERE id=?").run(now, legacy.id);
    const legacyEvent = eventFor("cron_event", "legacy-processing-id", "legacy pending effect");
    db.prepare(
      `INSERT INTO event_trigger_queue
       (id,dedupe_key,event_json,status,attempt_count,available_at,created_at,updated_at)
       VALUES('fixture-legacy-processing','fixture-legacy-dedupe',?,'processing',1,?,?,?)`,
    ).run(JSON.stringify(legacyEvent), now, now, now);

    await routines.stopWorkflowRuntime();
    await triggers.stop();
    return {
      profile,
      workspacePath,
      workspaceId: workspace.id,
      botId: bot.id,
      responsibilityId: active.id,
      responsibilityRevision: active.revision,
      triggers: {
        race: race.id,
        preIntent: preIntent.id,
        completedDelivery: completedDelivery.id,
        uncertainDelivery: uncertainDelivery.id,
        legacy: legacy.id,
        definitionDrift: definitionDrift.id,
        responsibilityDrift: revisionTrigger.id,
      },
    };
  } finally {
    await routines?.stopWorkflowRuntime();
    await triggers?.stop();
    manager.close();
  }
}

async function runChild(mode, directory, fixture) {
  const { DatabaseManager } = loadDaemon("electron/database/schema.js");
  const { EventTriggerService } = loadDaemon("electron/triggers/EventTriggerService.js");
  const { startDatabaseWorker, stopDatabaseWorker } = loadDaemon(
    "electron/database/async/runtime.js",
  );
  const profile = path.join(directory, "profile");
  const dbPath = path.join(profile, "cowork-os.db");
  const effects = {
    tasks: path.join(directory, "fake-task-effects.jsonl"),
    deliveries: path.join(directory, "fake-channel-acceptances.jsonl"),
  };
  const manager = new DatabaseManager({ dbPath });
  const db = manager.getDatabase();
  let activeTaskCount = 0;
  let triggers;
  let workerStarted = false;
  const createTask = async (input) => {
    const task = { prompt: input.prompt, workspaceId: input.workspaceId, acceptedAt: Date.now() };
    writeLine(effects.tasks, task);
    return { id: `fixture-task-${readLines(effects.tasks).length}` };
  };
  const deliverToChannel = async (input) => {
    const accepted = {
      channelType: input.channelType,
      channelId: input.channelId,
      idempotencyKey: input.idempotencyKey,
      text: input.text,
      acceptedAt: Date.now(),
      messageId: `fixture-message-${readLines(effects.deliveries).length + 1}`,
    };
    writeLine(effects.deliveries, accepted);
    return { messageId: accepted.messageId };
  };

  try {
    triggers = new EventTriggerService(
      {
        createTask,
        deliverToChannel,
        getDefaultWorkspaceId: () => fixture.workspaceId,
        getActiveTaskCount: () => activeTaskCount,
      },
      db,
    );
    const worker = await startDatabaseWorker({ dbPath, runtime: "daemon" });
    assert(worker, "Services-domain SQLite worker did not start");
    workerStarted = true;
    await triggers.start();
    assert.equal(
      triggers.sql.usesWorker(),
      true,
      "Event trigger services units bypassed the worker",
    );

    const triggerId = fixture.triggers;
    const event = {
      race: eventFor("webhook", "stable-race-occurrence", "fixture race"),
      preIntent: eventFor("github_event", "before-intent-occurrence", "fixture before intent"),
      completedDelivery: eventFor(
        "connector_event",
        "completed-delivery-occurrence",
        "fixture completed",
      ),
      uncertainDelivery: eventFor(
        "file_change",
        "uncertain-delivery-occurrence",
        "fixture uncertain",
      ),
      definitionDrift: eventFor("email", "definition-drift-occurrence", "fixture definition drift"),
      responsibilityDrift: eventFor(
        "channel_message",
        "responsibility-revision-occurrence",
        "fixture responsibility revision drift",
      ),
    };
    event.responsibilityDrift.fields = {
      ...event.responsibilityDrift.fields,
      channelType: "slack",
      channelInstanceId: "fixture-history",
      chatId: "selected-chat",
    };
    const rows = (trigger) => selectOccurrence(db, trigger);

    if (mode === "race") {
      activeTaskCount = 4;
      await Promise.all([triggers.evaluateEvent(event.race), triggers.evaluateEvent(event.race)]);
      activeTaskCount = 0;
      await triggers.drainPendingEvents();
      assert.equal(
        readLines(effects.tasks).filter((item) => item.prompt === "fixture/race").length,
        1,
      );
      assert.equal(rows(triggerId.race)?.status, "completed");
      assert.equal(triggers.sql.usesWorker(), true);
    } else if (mode === "replay-race") {
      await triggers.evaluateEvent(event.race);
      assert.equal(
        readLines(effects.tasks).filter((item) => item.prompt === "fixture/race").length,
        1,
      );
      assert.equal(rows(triggerId.race)?.status, "completed");
    } else if (mode === "interrupt-before-intent") {
      activeTaskCount = 4;
      await triggers.evaluateEvent(event.preIntent);
      activeTaskCount = 0;
      const port = triggers.sql;
      const originalUnit = port.unit.bind(port);
      port.unit = async (name, args) => {
        if (name === "eventTrigger_markOccurrenceIntent") {
          process.stdout.write("FIXTURE_CHECKPOINT:BEFORE_ACTION_INTENT\n");
          await new Promise(() => {});
        }
        return originalUnit(name, args);
      };
      await triggers.drainPendingEvents();
    } else if (mode === "recover-before-intent") {
      await triggers.drainPendingEvents();
      assert.equal(rows(triggerId.preIntent)?.status, "completed");
      assert.equal(
        readLines(effects.tasks).filter((item) => item.prompt === "fixture/pre-intent").length,
        1,
      );
    } else if (mode === "complete-delivery") {
      await triggers.evaluateEvent(event.completedDelivery);
      const row = rows(triggerId.completedDelivery);
      assert.equal(row?.status, "completed");
      const receipt = JSON.parse(row.receipt_json);
      assert.equal(receipt.kind, "channel_message");
      assert.equal(typeof receipt.messageId, "string");
      const accepted = readLines(effects.deliveries).filter(
        (item) => item.text === "fixture/completed",
      );
      assert.equal(accepted.length, 1);
      assert.equal(typeof accepted[0].idempotencyKey, "string");
    } else if (mode === "replay-completed-delivery") {
      await triggers.evaluateEvent(event.completedDelivery);
      assert.equal(
        readLines(effects.deliveries).filter((item) => item.text === "fixture/completed").length,
        1,
      );
      assert.equal(rows(triggerId.completedDelivery)?.status, "completed");
    } else if (mode === "interrupt-after-delivery") {
      const port = triggers.sql;
      const originalUnit = port.unit.bind(port);
      port.unit = async (name, args) => {
        if (name === "eventTrigger_completeOccurrence" && args[1] === "completed") {
          process.stdout.write("FIXTURE_CHECKPOINT:AFTER_FAKE_DELIVERY_BEFORE_RECEIPT\n");
          await new Promise(() => {});
        }
        return originalUnit(name, args);
      };
      await triggers.evaluateEvent(event.uncertainDelivery);
    } else if (mode === "recover-after-delivery") {
      await triggers.drainPendingEvents();
      await triggers.evaluateEvent(event.uncertainDelivery);
      assert.equal(rows(triggerId.uncertainDelivery)?.status, "outcome_unknown");
      assert.equal(
        readLines(effects.deliveries).filter((item) => item.text === "fixture/uncertain").length,
        1,
      );
    } else if (mode === "recover-legacy-processing") {
      await triggers.drainPendingEvents();
      const legacy = db
        .prepare(
          "SELECT status,error FROM event_trigger_queue WHERE id='fixture-legacy-processing'",
        )
        .get();
      assert.equal(legacy?.status, "outcome_unknown");
      assert.match(legacy.error, /without an action receipt/);
      assert.equal(
        readLines(effects.tasks).filter((item) => item.prompt === "fixture/legacy-must-not-run")
          .length,
        0,
      );
      assert.equal(rows(triggerId.legacy), undefined);
    } else if (mode === "admit-definition-drift") {
      activeTaskCount = 4;
      await triggers.evaluateEvent(event.definitionDrift);
      assert.equal(rows(triggerId.definitionDrift)?.status, "pending");
    } else if (mode === "drain-definition-drift") {
      await triggers.drainPendingEvents();
      assert.equal(rows(triggerId.definitionDrift)?.status, "failed");
      assert.equal(
        readLines(effects.tasks).filter((item) => item.prompt.includes("definition")).length,
        0,
      );
    } else if (mode === "admit-responsibility-drift") {
      activeTaskCount = 4;
      await triggers.evaluateEvent(event.responsibilityDrift);
      const occurrence = rows(triggerId.responsibilityDrift);
      assert.equal(occurrence?.status, "pending");
      assert.equal(
        JSON.parse(occurrence.responsibility_snapshot_json)?.revision,
        fixture.responsibilityRevision,
      );
    } else if (mode === "drain-responsibility-drift") {
      await triggers.drainPendingEvents();
      const occurrence = rows(triggerId.responsibilityDrift);
      assert.equal(occurrence?.status, "failed");
      assert.match(occurrence.error, /responsibility binding changed/i);
      assert.equal(
        readLines(effects.tasks).filter((item) => item.prompt.includes("responsibility")).length,
        0,
      );
    } else {
      throw new Error(`Unknown child mode: ${mode}`);
    }

    console.log(
      `FIXTURE_RESULT=${JSON.stringify({
        mode,
        servicesDomainWorker: triggers.sql.usesWorker(),
        modelExecution: false,
        providerCalls: false,
        realChannelSend: false,
      })}`,
    );
  } finally {
    await triggers?.stop();
    if (workerStarted) {
      const stopped = await stopDatabaseWorker(10_000);
      assert.equal(stopped.drained, true, "Services-domain worker did not drain cleanly");
    }
    manager.close();
  }
}

function openFixtureDatabase(directory) {
  const Database = require("better-sqlite3");
  const db = new Database(path.join(directory, "profile", "cowork-os.db"));
  db.pragma("busy_timeout = 5000");
  return db;
}

async function runParent() {
  const originalEnvironment = { ...process.env };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-trigger-occurrence-recovery-"));
  const isolatedEnvironment = cleanEnvironment(path.join(directory, "profile"));
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, isolatedEnvironment);
  let fixture;
  const hostChildren = new Set();
  try {
    fixture = await seedFixture(directory);
    const run = async (mode) => {
      const host = spawnFixtureChild(mode, directory, fixture);
      hostChildren.add(host);
      const result = await finishChild(host);
      hostChildren.delete(host);
      return result;
    };

    await run("race");
    await run("replay-race");

    const beforeIntent = spawnFixtureChild("interrupt-before-intent", directory, fixture);
    hostChildren.add(beforeIntent);
    await waitForLine(beforeIntent, "FIXTURE_CHECKPOINT:BEFORE_ACTION_INTENT");
    await stopWithSignal(beforeIntent);
    hostChildren.delete(beforeIntent);
    {
      const db = openFixtureDatabase(directory);
      try {
        assert.equal(selectOccurrence(db, fixture.triggers.preIntent)?.status, "processing");
      } finally {
        db.close();
      }
    }
    await run("recover-before-intent");

    await run("complete-delivery");
    await run("replay-completed-delivery");

    const afterDelivery = spawnFixtureChild("interrupt-after-delivery", directory, fixture);
    hostChildren.add(afterDelivery);
    await waitForLine(afterDelivery, "FIXTURE_CHECKPOINT:AFTER_FAKE_DELIVERY_BEFORE_RECEIPT");
    assert.equal(
      readLines(path.join(directory, "fake-channel-acceptances.jsonl")).filter(
        (item) => item.text === "fixture/uncertain",
      ).length,
      1,
    );
    await stopWithSignal(afterDelivery);
    hostChildren.delete(afterDelivery);
    {
      const db = openFixtureDatabase(directory);
      try {
        assert.equal(selectOccurrence(db, fixture.triggers.uncertainDelivery)?.status, "intent");
      } finally {
        db.close();
      }
    }
    await run("recover-after-delivery");

    await run("recover-legacy-processing");

    await run("admit-definition-drift");
    {
      const db = openFixtureDatabase(directory);
      try {
        db.prepare("UPDATE event_triggers SET action=? WHERE id=?").run(
          JSON.stringify({
            type: "create_task",
            config: { prompt: "fixture/redirected-definition" },
          }),
          fixture.triggers.definitionDrift,
        );
      } finally {
        db.close();
      }
    }
    await run("drain-definition-drift");

    await run("admit-responsibility-drift");
    {
      const db = openFixtureDatabase(directory);
      try {
        const row = db
          .prepare(
            "SELECT definition_json FROM bot_responsibility_revisions WHERE responsibility_id=? AND revision=?",
          )
          .get(fixture.responsibilityId, fixture.responsibilityRevision);
        assert(row, "Accepted responsibility revision disappeared");
        const next = JSON.parse(row.definition_json);
        next.objective = "Changed after the occurrence was accepted";
        db.transaction(() => {
          db.prepare(
            `INSERT INTO bot_responsibility_revisions(responsibility_id,revision,definition_json,created_at)
             VALUES(?,?,?,?)`,
          ).run(
            fixture.responsibilityId,
            fixture.responsibilityRevision + 1,
            JSON.stringify(next),
            Date.now(),
          );
          db.prepare("UPDATE bot_responsibilities SET revision=? WHERE id=? AND revision=?").run(
            fixture.responsibilityRevision + 1,
            fixture.responsibilityId,
            fixture.responsibilityRevision,
          );
          db.prepare(
            "UPDATE bot_responsibility_controls SET control_version=control_version+1 WHERE responsibility_id=?",
          ).run(fixture.responsibilityId);
        })();
      } finally {
        db.close();
      }
    }
    await run("drain-responsibility-drift");

    const db = openFixtureDatabase(directory);
    try {
      const legacy = db
        .prepare(
          `SELECT q.status,t.last_fired_at FROM event_trigger_queue q
           JOIN event_triggers t ON t.id=? WHERE q.id='fixture-legacy-processing'`,
        )
        .get(fixture.triggers.legacy);
      assert.equal(legacy?.status, "outcome_unknown");
      assert.equal(typeof legacy?.last_fired_at, "number");
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM event_trigger_occurrences").get().count,
        6,
      );
    } finally {
      db.close();
    }

    const summary = {
      fixture: "compiled local Node process + services-domain SQLite worker",
      isolatedProfile: true,
      concurrentStableOccurrenceDeduped: true,
      completedReceiptSurvivesRestartWithoutReplay: true,
      crashBeforeIntentRecoversAndRunsOnce: true,
      fakeDeliveryAcceptedBeforeCrashThenUnknownWithoutRedelivery: true,
      legacyProcessingWithLastFiredAtQuarantined: true,
      queuedTriggerDefinitionDriftFailsClosed: true,
      queuedResponsibilityRevisionDriftFailsClosed: true,
      modelExecution: false,
      configuredProviders: false,
      realChannelSends: false,
      controlPlaneOrBrowserEvidence: false,
    };
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    try {
      for (const host of hostChildren) {
        if (host.exit === null) {
          host.child.kill("SIGKILL");
          await host.exitPromise;
        }
      }
    } finally {
      try {
        fs.rmSync(directory, { recursive: true, force: true });
      } finally {
        for (const key of Object.keys(process.env)) delete process.env[key];
        Object.assign(process.env, originalEnvironment);
      }
    }
  }
}

async function main() {
  if (process.argv[2] === "--child") {
    const [, , , mode, directory, encodedFixture] = process.argv;
    await runChild(mode, directory, JSON.parse(encodedFixture));
  } else {
    await runParent();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
