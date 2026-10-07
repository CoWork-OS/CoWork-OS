/* eslint-disable no-console */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { WebSocketServer } = require("ws");

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const WORKER_PATH = path.join(__dirname, "battery_fixture_worker.cjs");

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function approvalRevisionHash(approval) {
  const serialized = JSON.stringify(
    canonicalize({
      taskId: approval.taskId,
      type: approval.type,
      description: approval.description,
      details: approval.details,
      requestedAt: approval.requestedAt,
    }),
  );
  if (typeof serialized !== "string" || serialized.length > 256000)
    throw new Error("Approval revision exceeds limit");
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

function approvalRevisionMatches(approval, expectedRevisionHash) {
  return (
    typeof expectedRevisionHash === "string" &&
    /^[0-9a-f]{64}$/.test(expectedRevisionHash) &&
    expectedRevisionHash === approval.revisionHash &&
    expectedRevisionHash === approvalRevisionHash(approval)
  );
}

function startFixtureControlPlane({
  profileDir,
  workerDelayMs = 25,
  token = crypto.randomBytes(32).toString("hex"),
}) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const workspaces = new Map();
  const tasks = new Map();
  const workers = new Map();
  const approvals = new Map();
  const approvalResponses = [];
  function addApprovalRow(input) {
    const approval = {
      ...input,
      id: input.id || crypto.randomUUID(),
      status: input.status || "pending",
      requestedAt: Number.isFinite(input.requestedAt) ? input.requestedAt : Date.now(),
    };
    approval.revisionHash = approvalRevisionHash(approval);
    approvals.set(approval.id, approval);
    return approval;
  }
  let serverReady;
  const listening = new Promise((resolve, reject) => {
    serverReady = resolve;
    wss.once("listening", resolve);
    wss.once("error", reject);
  });

  function createEvent(task, type, payload = {}) {
    const event = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      type,
      payload: { taskId: task.id, ...payload },
    };
    task.events.push(event);
    return event;
  }

  function setTerminal(task, status, error) {
    task.status = status;
    task.error = error || null;
    task.updatedAt = Date.now();
    task.completedAt = task.updatedAt;
    createEvent(
      task,
      status === "completed" ? "task_completed" : `task_${status}`,
      error ? { error } : {},
    );
  }

  function stopWorker(taskId) {
    const child = workers.get(taskId);
    if (!child || child.exitCode !== null || child.signalCode !== null)
      return Promise.resolve({ exited: true });
    child.kill("SIGTERM");
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(forceTimer);
        resolve(result);
      };
      child.once("exit", (code, signal) => finish({ exited: true, code, signal, pid: child.pid }));
      const forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        const finalTimer = setTimeout(() => finish({ exited: false, pid: child.pid }), 500);
        child.once("exit", (code, signal) => {
          clearTimeout(finalTimer);
          finish({ exited: true, code, signal, pid: child.pid, forced: true });
        });
      }, 500);
      forceTimer.unref?.();
    });
  }

  function startWorker(task, workerInput, { followUp = false } = {}) {
    task.status = "executing";
    task.updatedAt = Date.now();
    const child = spawn(
      process.execPath,
      [
        WORKER_PATH,
        JSON.stringify({
          ...workerInput,
          delayMs: workerInput.kind === "hang" ? 0 : workerDelayMs,
        }),
      ],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    workers.set(task.id, child);
    child.on("message", (message) => {
      if (!message || typeof message !== "object") return;
      if (message.type === "terminal") {
        setTerminal(task, message.status, message.error);
        if (followUp && message.status === "completed") createEvent(task, "follow_up_completed");
      }
    });
    child.once("error", (error) => setTerminal(task, "failed", String(error.message || error)));
    child.once("exit", (code, signal) => {
      if (!TERMINAL.has(task.status)) {
        setTerminal(
          task,
          code === 0 ? "completed" : "failed",
          code === 0 ? undefined : `fixture_worker_exit_${signal || code}`,
        );
      }
      task.workerExit = { code, signal, pid: child.pid };
      if (workers.get(task.id) === child) workers.delete(task.id);
    });
    return child;
  }

  function response(ws, id, ok, payload, error) {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ type: "res", id, ok, ...(ok ? { payload } : { error }) }));
  }

  function handleRequest(ws, frame, clientState) {
    if (
      !frame ||
      frame.type !== "req" ||
      typeof frame.id !== "string" ||
      typeof frame.method !== "string"
    )
      return;
    const params = frame.params && typeof frame.params === "object" ? frame.params : {};
    const { id, method } = frame;
    const fail = (message, code = "INVALID_PARAMS") =>
      response(ws, id, false, null, { code, message });

    if (method === "connect") {
      if (params.token !== token) return fail("Invalid token", "UNAUTHORIZED");
      clientState.authenticated = true;
      return response(ws, id, true, {
        clientId: crypto.randomUUID(),
        scopes: ["admin", "read", "write"],
      });
    }
    if (!clientState.authenticated) return fail("Connect first", "UNAUTHORIZED");

    try {
      if (method === "health" || method === "ping") {
        return response(ws, id, true, { status: "ok", fixture: true });
      }
      if (method === "workspace.create") {
        const name = String(params.name || "").trim();
        const workspacePath = path.resolve(String(params.path || ""));
        if (!name || !isInside(profileDir, workspacePath))
          return fail("workspace must be inside fixture profile");
        fs.mkdirSync(workspacePath, { recursive: true });
        const workspace = { id: crypto.randomUUID(), name, path: workspacePath };
        workspaces.set(workspace.id, workspace);
        return response(ws, id, true, { workspace });
      }
      if (method === "workspace.list") {
        return response(ws, id, true, { workspaces: [...workspaces.values()] });
      }
      if (method === "task.create") {
        const workspace = workspaces.get(String(params.workspaceId || ""));
        if (!workspace) return fail("workspace not found");
        const fixtureScenario = params.batteryFixture;
        if (!fixtureScenario || typeof fixtureScenario.kind !== "string")
          return fail("fixture scenario missing");
        const outputPath = path.resolve(workspace.path, String(fixtureScenario.outRel || ""));
        if (!isInside(workspace.path, outputPath)) return fail("fixture output escaped workspace");
        const now = Date.now();
        const task = {
          id: crypto.randomUUID(),
          title: String(params.title || "fixture task"),
          status: "pending",
          workspaceId: workspace.id,
          error: null,
          createdAt: now,
          updatedAt: now,
          completedAt: null,
          events: [],
          fixtureScenario,
        };
        tasks.set(task.id, task);
        if (fixtureScenario.approvalType) {
          const approval = addApprovalRow({
            taskId: task.id,
            type: fixtureScenario.approvalType,
            description: "Fixture approval boundary probe",
            details: fixtureScenario.approvalDetails || {},
            requestedAt: now,
          });
          task.status = "paused";
          task.approvalId = approval.id;
        } else {
          startWorker(task, { ...fixtureScenario, workspacePath: workspace.path });
        }
        return response(ws, id, true, { task, taskId: task.id });
      }
      if (method === "task.get") {
        const task = tasks.get(String(params.taskId || ""));
        if (!task) return fail("task not found");
        return response(ws, id, true, { task: { ...task, events: undefined } });
      }
      if (method === "task.list") {
        const workspaceId = String(params.workspaceId || "");
        const limit = Math.max(1, Math.min(500, Number(params.limit) || 100));
        const offset = Math.max(0, Number(params.offset) || 0);
        const rows = [...tasks.values()].filter(
          (task) => !workspaceId || task.workspaceId === workspaceId,
        );
        return response(ws, id, true, {
          tasks: rows.slice(offset, offset + limit).map((task) => ({ ...task, events: undefined })),
          total: rows.length,
          limit,
          offset,
        });
      }
      if (method === "task.events") {
        const task = tasks.get(String(params.taskId || ""));
        if (!task) return fail("task not found");
        const limit = Math.max(1, Math.min(2000, Number(params.limit) || 200));
        return response(ws, id, true, { events: task.events.slice(-limit) });
      }
      if (method === "approval.list") {
        const taskId = String(params.taskId || "");
        return response(ws, id, true, {
          approvals: [...approvals.values()].filter(
            (approval) => !taskId || approval.taskId === taskId,
          ),
        });
      }
      if (method === "approval.respond") {
        const approval = approvals.get(String(params.approvalId || ""));
        if (!approval) return fail("approval not found");
        if (!approvalRevisionMatches(approval, params.expectedRevisionHash))
          return response(ws, id, true, { status: "not_found" });
        approval.status = params.approved === true ? "approved" : "denied";
        approvalResponses.push({
          id: approval.id,
          taskId: approval.taskId,
          type: approval.type,
          approved: approval.status === "approved",
        });
        if (approval.status === "approved") {
          const task = tasks.get(approval.taskId);
          if (task && task.status === "paused") {
            const workspace = workspaces.get(task.workspaceId);
            startWorker(task, { ...task.fixtureScenario, workspacePath: workspace.path });
          }
        }
        return response(ws, id, true, { status: approval.status });
      }
      if (method === "task.sendMessage") {
        const task = tasks.get(String(params.taskId || ""));
        if (!task) return fail("task not found");
        const source = task.fixtureScenario;
        startWorker(
          task,
          {
            kind: "followup",
            workspacePath: workspaces.get(task.workspaceId).path,
            outRel: source.outRel,
          },
          { followUp: true },
        );
        return response(ws, id, true, { ok: true });
      }
      if (method === "task.cancel") {
        const task = tasks.get(String(params.taskId || ""));
        if (!task) return fail("task not found");
        if (!TERMINAL.has(task.status)) {
          void stopWorker(task.id).then((result) => {
            if (result.exited) setTerminal(task, "cancelled");
          });
        }
        return response(ws, id, true, { ok: true, workerPid: workers.get(task.id)?.pid || null });
      }
      return fail(`unsupported fixture method: ${method}`, "METHOD_NOT_FOUND");
    } catch (error) {
      return fail(String(error && error.message ? error.message : error), "METHOD_FAILED");
    }
  }

  wss.on("connection", (ws) => {
    const clientState = { authenticated: false };
    ws.on("message", (data) => {
      let frame;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      handleRequest(ws, frame, clientState);
    });
  });
  if (wss.address()) serverReady(wss.address());

  return {
    token,
    listening,
    get url() {
      const address = wss.address();
      if (!address || typeof address === "string") return null;
      return `ws://127.0.0.1:${address.port}`;
    },
    getOwnedProcesses() {
      return [...workers.values()]
        .filter((child) => child.exitCode === null && child.signalCode === null)
        .map((child) => child.pid);
    },
    getTask(taskId) {
      return tasks.get(taskId) || null;
    },
    getApprovalResponses() {
      return [...approvalResponses];
    },
    addApproval(input) {
      return addApprovalRow(input);
    },
    async close() {
      await Promise.all([...workers.keys()].map((taskId) => stopWorker(taskId)));
      for (const client of wss.clients) client.close();
      await new Promise((resolve) => wss.close(resolve));
    },
  };
}

module.exports = { approvalRevisionHash, approvalRevisionMatches, startFixtureControlPlane };
