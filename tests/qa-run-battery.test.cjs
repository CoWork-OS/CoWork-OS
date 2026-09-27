const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const JSZip = require("jszip");
const { WebSocketServer } = require("ws");

const { PDFDocument } = require("pdf-lib");
const {
  BoundedControlPlaneClient,
  isApprovalInScope,
  isApprovalInWorkspace,
  minimalDaemonEnvironment,
  parseArgs,
  stopOwnedDaemon,
  verifyArtifact,
  waitForTerminalStatus,
  writeFixture,
} = (() => {
  const battery = require("../scripts/qa/run_battery.cjs");
  const graders = require("../scripts/qa/battery_artifact_graders.cjs");
  const fixtureWorker = require("../scripts/qa/battery_fixture_worker.cjs");
  return { ...battery, ...graders, ...fixtureWorker };
})();

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-battery-graders-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function createFixture(directory, name, input) {
  const outRel = name;
  await writeFixture({ workspacePath: directory, outRel, ...input });
  return path.join(directory, name);
}

async function mutatePptx(sourcePath, targetPath, mutate) {
  const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
  await mutate(zip);
  fs.writeFileSync(targetPath, await zip.generateAsync({ type: "nodebuffer" }));
}

test("authentic correct PDF, PPTX, and XLSX fixtures pass read-back graders", async (t) => {
  const directory = temporaryDirectory(t);
  const runId = "fixture-run-2026-09-27";
  const pdf = await createFixture(directory, "correct.pdf", { kind: "pdf", runId });
  const pptx = await createFixture(directory, "correct.pptx", { kind: "pptx", runId });
  const xlsx = await createFixture(directory, "correct.xlsx", { kind: "xlsx" });

  assert.equal((await verifyArtifact("pdf", pdf, runId)).ok, true);
  assert.equal((await verifyArtifact("pptx", pptx, runId)).ok, true);
  assert.equal((await verifyArtifact("xlsx", xlsx, runId)).ok, true);
});

test("nonempty corrupt and valid-format wrong-content PDF files fail", async (t) => {
  const directory = temporaryDirectory(t);
  const corrupt = path.join(directory, "corrupt.pdf");
  fs.writeFileSync(corrupt, "this is nonempty but not a PDF");
  const runId = "fixture-run-pdf";
  assert.equal((await verifyArtifact("pdf", corrupt, runId)).ok, false);

  const wrong = await createFixture(directory, "wrong.pdf", {
    kind: "pdf",
    runId,
    title: "Quarterly Overview",
  });
  const result = await verifyArtifact("pdf", wrong, runId);
  assert.equal(result.ok, false);
  assert.equal(result.error, "pdf_title_missing");

  const document = await PDFDocument.create();
  document.addPage().drawText("QA Battery Report but wrong run");
  const wrongRun = path.join(directory, "wrong-run.pdf");
  fs.writeFileSync(wrongRun, await document.save());
  assert.equal((await verifyArtifact("pdf", wrongRun, runId)).error, "pdf_run_id_missing");
});

test("nonempty corrupt, malformed XML, broken slide targets, and wrong-content PPTX files fail", async (t) => {
  const directory = temporaryDirectory(t);
  const corrupt = path.join(directory, "corrupt.pptx");
  fs.writeFileSync(corrupt, "not an Office package");
  assert.equal((await verifyArtifact("pptx", corrupt, "fixture-run-pptx")).ok, false);

  const runId = "fixture-run-pptx";
  const valid = await createFixture(directory, "valid.pptx", { kind: "pptx", runId });
  const malformed = path.join(directory, "malformed.pptx");
  await mutatePptx(valid, malformed, async (zip) => {
    zip.file("ppt/slides/slide1.xml", "<p:sld><p:cSld></p:sld>");
  });
  assert.equal((await verifyArtifact("pptx", malformed, runId)).ok, false);

  const missingTarget = path.join(directory, "missing-target.pptx");
  await mutatePptx(valid, missingTarget, async (zip) => {
    const rels = await zip.file("ppt/_rels/presentation.xml.rels").async("string");
    const rewritten = rels.replace(/Target="slides\/slide1\.xml"/, 'Target="slides/MISSING.xml"');
    assert.notEqual(rewritten, rels, "fixture should contain a slide1 relationship");
    zip.file("ppt/_rels/presentation.xml.rels", rewritten);
  });
  assert.equal((await verifyArtifact("pptx", missingTarget, runId)).ok, false);

  const wrong = await createFixture(directory, "wrong-content.pptx", {
    kind: "pptx",
    runId,
    title: "Wrong Presentation",
  });
  const result = await verifyArtifact("pptx", wrong, runId);
  assert.equal(result.ok, false);
  assert.equal(result.error, "pptx_title_or_run_id_missing");
});

test("valid XLSX with wrong cached formula result fails", async (t) => {
  const directory = temporaryDirectory(t);
  const correct = await createFixture(directory, "correct.xlsx", { kind: "xlsx" });
  assert.equal((await verifyArtifact("xlsx", correct)).ok, true);
  const wrong = await createFixture(directory, "wrong-result.xlsx", { kind: "xlsx", result: 999 });
  const result = await verifyArtifact("xlsx", wrong);
  assert.equal(result.ok, false);
  assert.equal(result.error, "spreadsheet_cached_result_mismatch");
});

test("allow-list needs exact task and an in-workspace resource path", (t) => {
  const directory = temporaryDirectory(t);
  const base = {
    id: "approval-1",
    taskId: "task-1",
    type: "file_write",
    details: { path: "reports/result.xlsx", operation: "write" },
  };
  const options = { taskId: "task-1", workspacePath: directory, approvalScope: "workspace" };
  assert.equal(isApprovalInWorkspace(base, options), true);
  assert.equal(isApprovalInWorkspace({ ...base, taskId: "different-task" }, options), false);
  assert.equal(
    isApprovalInWorkspace({ ...base, details: { path: "../grader-secret.json" } }, options),
    false,
  );
  assert.equal(
    isApprovalInWorkspace({ ...base, details: { command: "cat grader-secret.json" } }, options),
    false,
  );
  assert.equal(
    isApprovalInScope(
      {
        ...base,
        type: "browser_use_domain_access",
        details: {
          kind: "browser_use_domain_access",
          domain: "example.com",
          origin: "https://example.com",
          url: "https://example.com/path",
        },
      },
      { ...options, approvalScopes: new Set(["domain:example.com"]) },
    ),
    true,
  );
  assert.equal(
    isApprovalInScope(
      {
        ...base,
        type: "browser_use_domain_access",
        details: {
          kind: "browser_use_domain_access",
          domain: "sub.example.com",
          origin: "https://sub.example.com",
          url: "https://sub.example.com/path",
        },
      },
      { ...options, approvalScopes: new Set(["domain:example.com"]) },
    ),
    false,
  );
  assert.throws(
    () => parseArgs(["--approval-mode", "allow-list", "--approve-type", "file_write"]),
    /explicit --approval-scope/,
  );
  assert.doesNotThrow(() =>
    parseArgs([
      "--approval-mode",
      "allow-list",
      "--approve-type",
      "browser_use_domain_access",
      "--approval-scope",
      "domain:example.com",
    ]),
  );
});

test("Control Plane approvals for another task are never auto-approved", async (t) => {
  const directory = temporaryDirectory(t);
  const calls = [];
  const client = {
    async request(method) {
      calls.push(method);
      if (method === "task.get") return { task: { id: "task-1", status: "paused" } };
      if (method === "approval.list") {
        return {
          approvals: [
            {
              id: "approval-foreign",
              taskId: "task-2",
              type: "file_write",
              status: "pending",
              details: { path: "inside.txt", operation: "write" },
            },
          ],
        };
      }
      throw new Error("unexpected request " + method);
    },
  };
  const result = await waitForTerminalStatus(client, "task-1", {
    deadlineAt: Date.now() + 1000,
    pollMs: 5,
    approvalMode: "allow-list",
    approveTypes: new Set(["file_write"]),
    approvalScopes: new Set(["workspace"]),
    workspacePath: directory,
  });
  assert.equal(result.reason, "pending_approval");
  assert.deepEqual(calls, ["task.get", "approval.list"]);
});

test("live daemon environment drops legacy database and hook variables", () => {
  const previousDb = process.env.COWORK_DB_PATH;
  const previousHooks = process.env.COWORK_HOOKS_URL;
  process.env.COWORK_DB_PATH = "/production/cowork.db";
  process.env.COWORK_HOOKS_URL = "http://production.invalid";
  try {
    const childEnv = minimalDaemonEnvironment(
      {},
      path.join(os.tmpdir(), "qa-owned-profile"),
      43210,
    );
    assert.equal(childEnv.COWORK_USER_DATA_DIR, path.join(os.tmpdir(), "qa-owned-profile"));
    assert.equal(childEnv.COWORK_CONTROL_PLANE_PORT, "43210");
    assert.equal(Object.hasOwn(childEnv, "COWORK_DB_PATH"), false);
    assert.equal(
      Object.keys(childEnv).some((key) => key.startsWith("COWORK_HOOKS_")),
      false,
    );
  } finally {
    if (previousDb === undefined) delete process.env.COWORK_DB_PATH;
    else process.env.COWORK_DB_PATH = previousDb;
    if (previousHooks === undefined) delete process.env.COWORK_HOOKS_URL;
    else process.env.COWORK_HOOKS_URL = previousHooks;
  }
});

test("live mode fails closed before profile creation without explicit QA provider config", () => {
  const script = path.resolve(__dirname, "../scripts/qa/run_battery.cjs");
  const env = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG"]
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]]),
  );
  const result = spawnSync(
    process.execPath,
    [script, "--live", "--allow-provider-calls", "--allow-network", "--json"],
    {
      cwd: path.resolve(__dirname, ".."),
      env,
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Live mode requires COWORK_QA_LLM_PROVIDER/);
  assert.doesNotMatch(result.stdout, /"profile"/);
});

test("explicit live mode cannot silently become fixture mode", () => {
  for (const modes of [
    ["--live", "--fixtures-only"],
    ["--fixtures-only", "--live"],
  ]) {
    assert.throws(() => parseArgs(modes), /cannot be combined/);
  }
});

test("a malformed Control Plane frame rejects pending work as uncertain without crashing", async (t) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  server.on("connection", (socket) => {
    socket.on("error", () => {});
    socket.on("message", (bytes) => {
      const request = JSON.parse(String(bytes));
      if (request.method === "connect") {
        socket.send(JSON.stringify({ type: "res", id: request.id, ok: true, payload: {} }));
      } else {
        // An invalid reserved opcode exercises the real client's post-connect error event.
        socket._socket.write(Buffer.from([0x83, 0x00]));
      }
    });
  });
  const client = new BoundedControlPlaneClient({
    url: `ws://127.0.0.1:${server.address().port}`,
    token: "disposable-test-token",
  });
  t.after(() => client.close());
  await client.connect(Date.now() + 1000);
  await assert.rejects(client.request("task.create", {}, Date.now() + 1000), (error) => {
    assert.equal(error.uncertainDispatch, true);
    assert.match(error.message, /Invalid WebSocket frame/);
    return true;
  });
  assert.equal(client.pending.size, 0);
});

test("Control Plane request deadlines bound a stalled HTTP-over-WebSocket response", async (t) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  server.on("connection", (socket) => {
    socket.on("message", (bytes) => {
      const request = JSON.parse(String(bytes));
      if (request.method === "connect") {
        socket.send(
          JSON.stringify({
            type: "res",
            id: request.id,
            ok: true,
            payload: { clientId: "test", scopes: ["admin"] },
          }),
        );
      }
    });
  });
  const address = server.address();
  const client = new BoundedControlPlaneClient({
    url: `ws://127.0.0.1:${address.port}`,
    token: "local-fixture-token",
  });
  t.after(() => client.close());
  await client.connect(Date.now() + 1000);
  const startedAt = Date.now();
  await assert.rejects(
    client.request("stalled.response", {}, Date.now() + 120),
    /deadline exceeded/,
  );
  assert.ok(Date.now() - startedAt < 1000);
});

test("owned daemon cleanup kills a child that survives the parent SIGTERM", async (t) => {
  if (process.platform === "win32")
    return t.skip("POSIX process-group behavior is tested on Unix hosts");
  const childSource = [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "console.log(child.pid);",
    "setInterval(() => {}, 1000);",
  ].join(" ");
  const parent = spawn(process.execPath, ["-e", childSource], {
    stdio: ["ignore", "pipe", "ignore"],
    detached: true,
  });
  t.after(() => {
    if (parent.pid) {
      try {
        process.kill(-parent.pid, "SIGKILL");
      } catch {}
    }
  });
  const childPid = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("owned child pid was not reported")), 3000);
    let stdout = "";
    parent.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const match = stdout.match(/(?:^|\n)(\d+)(?:\n|$)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    });
    parent.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  const cleanup = await stopOwnedDaemon(parent, 250, os.tmpdir());
  assert.equal(cleanup.stopped, true);
  assert.ok(childPid > 0);
  assert.throws(() => process.kill(-parent.pid, 0), { code: "ESRCH" });
});
