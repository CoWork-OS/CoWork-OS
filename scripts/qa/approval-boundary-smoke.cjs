#!/usr/bin/env node
// Run after build:electron (or build:daemon with COWORK_SMOKE_DIST=daemon).
// Uses the real SQLite repositories, daemon broker and registered tools without
// a model/provider. All state and mutations stay in an isolated temporary tree.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repo = path.resolve(__dirname, "../..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-approval-smoke-"));
process.env.COWORK_USER_DATA_DIR = path.join(root, "profile");
process.env.COWORK_ACCESS_POLICY_VERSION = "boundary";
// Queue scenarios explicitly exercise the supported compatibility surface.
process.env.COWORK_APPROVAL_PROMPTS = "on";
const dist = path.join(repo, "dist", process.env.COWORK_SMOKE_DIST || "electron");
const fromBuild = (relative) => require(path.join(dist, relative));
let daemon;
let manager;
const results = [];

async function main() {
  const { DatabaseManager } = fromBuild("electron/database/schema.js");
  const { SecureSettingsRepository } = fromBuild("electron/database/SecureSettingsRepository.js");
  const {
    WorkspaceStore: WorkspaceRepository,
    TaskStore: TaskRepository,
    ApprovalStore: ApprovalRepository,
    InputRequestStore: InputRequestRepository,
  } = fromBuild("electron/database/repositories.js");
  const { AgentDaemon } = fromBuild("electron/agent/daemon.js");
  const { ToolRegistry } = fromBuild("electron/agent/tools/registry.js");
  const { PermissionSettingsManager } = fromBuild(
    "electron/security/permission-settings-manager.js",
  );
  const { MemoryService } = fromBuild("electron/memory/MemoryService.js");
  manager = new DatabaseManager();
  const db = manager.getDatabase();
  new SecureSettingsRepository(db);
  MemoryService.initialize(manager);
  daemon = new AgentDaemon(manager, { startupRecovery: false });
  const taskRepo = new TaskRepository(db);
  const approvals = new ApprovalRepository(db);
  const session = path.join(root, "cowork-os-temp", "ui-session-smoke");
  fs.mkdirSync(session, { recursive: true });
  const workspace = new WorkspaceRepository(db).create("Approval smoke", session, {
    read: true,
    write: true,
    delete: true,
    shell: true,
    network: true,
  });
  const makeTask = (accessProfileId, extra = {}) =>
    taskRepo.create({
      title: "Approval boundary smoke",
      prompt: "Controlled local operation",
      status: "executing",
      workspaceId: workspace.id,
      agentConfig: { accessProfileId, ...extra },
    });
  let approvalCalls = 0;
  const requestApproval = daemon.requestApproval.bind(daemon);
  daemon.requestApproval = (...args) => {
    approvalCalls++;
    return requestApproval(...args);
  };

  // Durable rows precede the in-memory waiter. Respond only after both exist,
  // otherwise the broker treats the response as a persisted-task restart.
  const waitForPending = async (taskId, count = 1) => {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const pending = approvals.findPendingByTaskId(taskId);
      if (
        pending.length === count &&
        pending.every((item) => daemon.pendingApprovals.has(item.id))
      ) {
        return pending;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      `Timed out waiting for ${count} live approvals for ${taskId}: ${JSON.stringify({ pending: approvals.findPendingByTaskId(taskId), liveIds: [...daemon.pendingApprovals.keys()], events: daemon.getTaskEvents(taskId).slice(-5) })}`,
    );
  };
  const withShellConsent = async (taskId, operation) => {
    const result = operation();
    // Attach the rejection handler immediately while the broker records consent.
    const settled = result.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    const pending = await Promise.race([
      waitForPending(taskId),
      settled.then((outcome) => {
        throw (
          outcome.error ||
          new Error(`Shell completed without requesting consent: ${JSON.stringify(outcome.value)}`)
        );
      }),
    ]);
    assert.equal(pending[0].type, "run_command");
    await daemon.respondToApproval(pending[0].id, true, "allow_once");
    const outcome = await settled;
    if (outcome.error) throw outcome.error;
    return outcome.value;
  };

  for (const id of ["ask_for_approval", "approve_for_me", "full_access"]) {
    const task = makeTask(id);
    const registry = new ToolRegistry(
      daemon.getEffectiveWorkspaceForTask(task.id),
      daemon,
      task.id,
    );
    const note = path.join(session, `${id}-scribe-conversation.md`);
    const before = approvalCalls;
    for (const content of ["Initial note", "Updated note"]) {
      const result = await registry.executeTool("write_file", { path: note, content });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(fs.readFileSync(note, "utf8"), content);
    }
    const read = await registry.executeTool("read_file", { path: note });
    assert.equal(read.content, "Updated note", JSON.stringify(read));
    const edit = await registry.executeTool("edit_file", {
      file_path: note,
      old_string: "Updated note",
      new_string: "Edited note",
    });
    assert.equal(edit.success, true, JSON.stringify(edit));
    assert.equal(fs.readFileSync(note, "utf8"), "Edited note");
    const directory = await registry.executeTool("create_directory", { path: `${id}-artifacts` });
    assert.equal(directory.success, true, JSON.stringify(directory));
    assert.equal(approvalCalls, before, `${id} file operations requested approval`);
    // The real shell handler must use a functioning OS sandbox for bounded
    // profiles. This intentionally fails on hosts without a supported backend.
    if (id !== "full_access") {
      const command = await withShellConsent(task.id, () =>
        registry.executeTool("run_command", {
          command: `printf 'sandboxed command' > ${id}-command-proof.txt`,
        }),
      );
      assert.equal(command.success, true, JSON.stringify(command));
      assert.equal(
        fs.readFileSync(path.join(session, `${id}-command-proof.txt`), "utf8"),
        "sandboxed command",
      );
      const siblingProof = path.join(path.dirname(session), `${id}-sibling-proof.txt`);
      const siblingAttempt = await withShellConsent(task.id, () =>
        registry.executeTool("run_command", {
          command: `printf 'escape' > ../${id}-sibling-proof.txt`,
        }),
      );
      assert.equal(siblingAttempt.success, false, JSON.stringify(siblingAttempt));
      assert.equal(fs.existsSync(siblingProof), false);
    }
    const expectedApprovals = id === "full_access" ? 0 : 2;
    assert.equal(approvalCalls - before, expectedApprovals, `${id} shell consent count`);
    assert.equal(
      db.prepare("SELECT count(*) n FROM approvals WHERE task_id = ?").get(task.id).n,
      expectedApprovals,
    );
    assert.equal(taskRepo.findById(task.id).status, "executing");
    assert.equal(
      daemon
        .getTaskEvents(task.id)
        .filter(
          (event) =>
            (event.legacyType || event.payload?.legacyType || event.type) === "approval_requested",
        ).length,
      expectedApprovals,
    );
    results.push({
      scenario: `${id}: registered temporary-session create, update, read, edit, mkdir${id !== "full_access" ? " and sandboxed command" : ""}`,
      passed: true,
      approvalCalls: expectedApprovals,
    });
  }

  // An actual exception creates exactly one pending row, and a response unblocks it.
  const externalTask = makeTask("ask_for_approval");
  const external = {
    toolName: "write_file",
    approvalType: "external_file_access",
    details: {
      path: path.join(root, "outside.md"),
      operation: "write",
    },
  };
  const decision = daemon.authorizeToolAction(externalTask.id, external);
  const pending = await waitForPending(externalTask.id);
  assert.equal(pending.length, 1);
  await daemon.respondToApproval(pending[0].id, true, "allow_once");
  assert.equal(await decision, true);
  results.push({
    scenario: "eligible external exception requests once and resolves",
    passed: true,
  });

  const settings = PermissionSettingsManager.loadSettings();
  PermissionSettingsManager.saveSettings({
    ...settings,
    accessProfiles: [
      ...settings.accessProfiles,
      {
        id: "smoke_bounded_never",
        label: "Bounded never",
        sandbox: "workspace-write",
        approval: "never",
        reviewer: "none",
        network: "disabled",
        shellAccess: true,
      },
    ],
  });
  const neverTask = makeTask("smoke_bounded_never");
  const beforeNever = approvalCalls;
  assert.equal(await daemon.authorizeToolAction(neverTask.id, external), false);
  assert.equal(approvalCalls, beforeNever);
  assert.equal(approvals.findPendingByTaskId(neverTask.id).length, 0);
  results.push({
    scenario: "bounded never denies missing authority without a request",
    passed: true,
  });

  const narrowedTask = makeTask("ask_for_approval");
  daemon.grantExternalFileApproval(narrowedTask.id, external.details.path, "write");
  daemon.setTransientTaskAgentConfig(narrowedTask.id, { accessProfileId: "smoke_bounded_never" });
  assert.equal(
    daemon.consumeExternalFileApproval(narrowedTask.id, external.details.path, "write"),
    false,
  );
  daemon.setTransientTaskAgentConfig(narrowedTask.id, undefined);
  assert.equal(
    daemon.consumeExternalFileApproval(narrowedTask.id, external.details.path, "write"),
    false,
  );
  results.push({
    scenario: "external grant cannot survive transient authority narrowing",
    passed: true,
  });

  // Pending consent cannot survive changed task authority.
  const staleTask = makeTask("ask_for_approval");
  const staleDecision = daemon.authorizeToolAction(staleTask.id, external).then(
    (allowed) => allowed,
    () => false,
  );
  const staleApproval = (await waitForPending(staleTask.id))[0];
  assert.ok(staleApproval);
  taskRepo.update(staleTask.id, { agentConfig: { accessProfileId: "smoke_bounded_never" } });
  await daemon.respondToApproval(staleApproval.id, true, "allow_once");
  assert.equal(await staleDecision, false);
  assert.equal(approvals.findById(staleApproval.id).status, "denied");
  assert.match(taskRepo.findById(staleTask.id).error, /authority changed/);
  results.push({ scenario: "pending approval invalidated when authority narrows", passed: true });

  const endedTask = makeTask("ask_for_approval");
  const endedDecision = daemon.authorizeToolAction(endedTask.id, external).catch(() => false);
  const endedApproval = (await waitForPending(endedTask.id))[0];
  assert.ok(endedApproval);
  taskRepo.update(endedTask.id, { status: "completed" });
  await daemon.respondToApproval(endedApproval.id, true, "allow_once");
  assert.equal(await endedDecision, false);
  assert.equal(taskRepo.findById(endedTask.id).status, "completed");
  results.push({ scenario: "late approval cannot restart a completed task", passed: true });

  const concurrentTask = makeTask("ask_for_approval");
  const first = daemon.authorizeToolAction(concurrentTask.id, external);
  const second = daemon.authorizeToolAction(concurrentTask.id, {
    ...external,
    details: { ...external.details, path: path.join(root, "second-outside.md") },
  });
  const concurrent = await waitForPending(concurrentTask.id, 2);
  assert.equal(concurrent.length, 2);
  await daemon.respondToApproval(concurrent[0].id, true, "allow_once");
  assert.equal(taskRepo.findById(concurrentTask.id).status, "blocked");
  assert.equal(await daemon.respondToApproval(concurrent[0].id, true, "allow_once"), "duplicate");
  await daemon.respondToApproval(concurrent[1].id, true, "allow_once");
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(taskRepo.findById(concurrentTask.id).status, "executing");
  results.push({
    scenario: "concurrent exceptions resolve independently and duplicate responses are inert",
    passed: true,
  });

  const cancelledTask = makeTask("ask_for_approval");
  const controller = new AbortController();
  const cancelled = daemon
    .authorizeToolAction(cancelledTask.id, { ...external, signal: controller.signal })
    .then(
      () => {
        throw new Error("Cancelled request unexpectedly resolved");
      },
      (error) => error.message,
    );
  controller.abort();
  assert.match(await cancelled, /cancelled/);
  assert.equal(approvals.findPendingByTaskId(cancelledTask.id).length, 0);
  results.push({ scenario: "cancelled execution cannot retain a pending approval", passed: true });

  // The default UI routes consent through inline input rather than the queue.
  process.env.COWORK_APPROVAL_PROMPTS = "off";
  const inlineTask = makeTask("ask_for_approval");
  const inlineDecision = daemon.authorizeToolAction(inlineTask.id, external);
  const inlineSettled = inlineDecision.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  const inputs = new InputRequestRepository(db);
  let inlineInput;
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    inlineInput = inputs.findPendingByTaskId(inlineTask.id)[0];
    if (inlineInput && daemon.pendingInputRequests.has(inlineInput.id)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(
    inlineInput && daemon.pendingInputRequests.has(inlineInput.id),
    "Inline consent waiter missing",
  );
  const inlineApproval = approvals.findPendingByTaskId(inlineTask.id)[0];
  assert.ok(inlineApproval);
  await daemon.respondToInputRequest({
    requestId: inlineInput.id,
    taskId: inlineTask.id,
    status: "submitted",
    answers: { approval_decision: { optionLabel: "Allow once" } },
  });
  const inlineOutcome = await inlineSettled;
  if (inlineOutcome.error) throw inlineOutcome.error;
  assert.equal(inlineOutcome.value, true);
  assert.equal(approvals.findById(inlineApproval.id).status, "approved");
  assert.equal(daemon.pendingInputRequests.has(inlineInput.id), false);
  results.push({
    scenario: "default inline consent resolves its bound durable approval",
    passed: true,
  });

  console.log(
    JSON.stringify({ runtime: process.versions.electron ? "electron" : "node", results }, null, 2),
  );
}

const watchdog = setTimeout(() => {
  console.error("Approval boundary smoke exceeded its 60-second deadline", JSON.stringify(results));
  process.exit(1);
}, 60_000);

main()
  .then(async () => {
    await daemon?.shutdown();
    manager?.close();
    fs.rmSync(root, { recursive: true, force: true });
    clearTimeout(watchdog);
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    await daemon?.shutdown().catch(() => {});
    manager?.close();
    fs.rmSync(root, { recursive: true, force: true });
    clearTimeout(watchdog);
    process.exit(1);
  });
