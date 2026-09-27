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
  detectCgroupV2MemoryLimit,
  disposeProfileDir,
  isApprovalInScope,
  isApprovalInWorkspace,
  minimalDaemonEnvironment,
  parseArgs,
  signalOwnedProcessTree,
  stopOwnedChildren,
  stopOwnedDaemon,
  verifyArtifact,
  verifyToolEvidenceFromEvents,
  waitProcessTreeExit,
  waitForFollowUp,
  waitForTerminalStatus,
  withProfileCleanupError,
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

function centralDirectoryEntryOffset(buffer, name) {
  for (let offset = 0; offset + 46 <= buffer.length; offset += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameLength = buffer.readUInt16LE(offset + 28);
    const entryName = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (entryName === name) return offset;
  }
  throw new Error("ZIP entry not found: " + name);
}

function timelineToolEvent(legacyType, payload, type = "timeline_step_updated") {
  return { id: legacyType + "-event", type, payload: { ...payload, legacyType } };
}

test("authentic correct PDF, PPTX, and XLSX fixtures pass read-back graders", async (t) => {
  const directory = temporaryDirectory(t);
  const runId = "fixture-run-2026-09-27";
  const pdf = await createFixture(directory, "correct.pdf", { kind: "pdf", runId });
  const pptx = await createFixture(directory, "correct.pptx", { kind: "pptx", runId });
  const xlsx = await createFixture(directory, "correct.xlsx", { kind: "xlsx" });

  assert.equal((await verifyArtifact("pdf", pdf, runId, { mode: "fixtures" })).ok, true);
  assert.equal((await verifyArtifact("pptx", pptx, runId)).ok, true);
  assert.equal((await verifyArtifact("xlsx", xlsx, runId)).ok, true);
});

test("nonempty corrupt and valid-format wrong-content PDF files fail", async (t) => {
  const directory = temporaryDirectory(t);
  const corrupt = path.join(directory, "corrupt.pdf");
  fs.writeFileSync(corrupt, "this is nonempty but not a PDF");
  const runId = "fixture-run-pdf";
  assert.equal((await verifyArtifact("pdf", corrupt, runId, { mode: "fixtures" })).ok, false);

  const wrong = await createFixture(directory, "wrong.pdf", {
    kind: "pdf",
    runId,
    title: "Quarterly Overview",
  });
  const result = await verifyArtifact("pdf", wrong, runId, { mode: "fixtures" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "pdf_title_missing");

  const document = await PDFDocument.create();
  document.addPage().drawText("QA Battery Report but wrong run");
  const wrongRun = path.join(directory, "wrong-run.pdf");
  fs.writeFileSync(wrongRun, await document.save());
  assert.equal(
    (await verifyArtifact("pdf", wrongRun, runId, { mode: "fixtures" })).error,
    "pdf_run_id_missing",
  );
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

test("live tool evidence accepts canonical timeline transport only with paired successful results", () => {
  const browserRequirement = {
    tool: "browser_navigate",
    targetUrl: "https://example.com/",
  };
  const browserCall = timelineToolEvent("tool_call", {
    tool: "browser_navigate",
    input: { url: "https://example.com/" },
    toolUseId: "browser-use-1",
  });
  const browserResult = timelineToolEvent("tool_result", {
    tool: "browser_navigate",
    result: { success: true, url: "https://example.com/", title: "Example Domain" },
    envelope: { status: "success", toolUseId: "separate-envelope-id" },
    toolUseId: "browser-use-1",
  });
  assert.equal(
    verifyToolEvidenceFromEvents([browserCall, browserResult], browserRequirement).ok,
    true,
  );
  assert.equal(
    verifyToolEvidenceFromEvents(
      [
        browserCall,
        {
          ...browserResult,
          payload: {
            ...browserResult.payload,
            result: { ...browserResult.payload.result, success: false },
          },
        },
      ],
      browserRequirement,
    ).ok,
    false,
    "an explicit failed result cannot be overridden by a success envelope",
  );
  assert.equal(
    verifyToolEvidenceFromEvents(
      [
        browserCall,
        { ...browserResult, payload: { ...browserResult.payload, envelope: { status: "error" } } },
      ],
      browserRequirement,
    ).ok,
    false,
    "an explicit error envelope cannot be overridden by result.success",
  );
  assert.equal(
    verifyToolEvidenceFromEvents(
      [
        browserCall,
        { ...browserResult, payload: { ...browserResult.payload, toolUseId: "other" } },
      ],
      browserRequirement,
    ).ok,
    false,
    "the top-level result toolUseId must pair with the call",
  );
  assert.equal(
    verifyToolEvidenceFromEvents(
      [
        browserCall,
        browserResult,
        timelineToolEvent("tool_error", { toolUseId: "browser-use-1" }, "timeline_error"),
      ],
      browserRequirement,
    ).ok,
    false,
    "a matching tool_error invalidates an otherwise successful result",
  );
  assert.equal(
    verifyToolEvidenceFromEvents(
      [
        {
          ...browserCall,
          payload: { ...browserCall.payload, input: { url: "https://wrong.example/" } },
        },
        browserResult,
      ],
      browserRequirement,
    ).ok,
    false,
  );
  assert.equal(
    verifyToolEvidenceFromEvents(
      [{ ...browserCall, type: "unrelated_event" }, browserResult],
      browserRequirement,
    ).ok,
    false,
    "legacyType is recognized only on canonical timeline events",
  );

  const searchRequirement = { tool: "web_search", query: "TypeScript 5.7 new features" };
  const searchCall = timelineToolEvent("tool_call", {
    tool: "web_search",
    input: { query: "TypeScript 5.7 new features" },
    toolUseId: "search-use-1",
  });
  const searchResult = timelineToolEvent("tool_result", {
    tool: "web_search",
    result: {
      success: true,
      query: "TypeScript 5.7 new features",
      results: [
        {
          title: "TypeScript 5.7",
          url: "https://www.typescriptlang.org/docs/",
          snippet: "Feature overview",
        },
      ],
    },
    toolUseId: "search-use-1",
    envelope: { status: "success" },
  });
  assert.equal(
    verifyToolEvidenceFromEvents([searchCall, searchResult], searchRequirement).ok,
    true,
  );
  assert.equal(
    verifyToolEvidenceFromEvents(
      [
        searchCall,
        {
          ...searchResult,
          payload: {
            ...searchResult.payload,
            result: { success: true, query: searchRequirement.query, results: [{}] },
          },
        },
      ],
      searchRequirement,
    ).ok,
    false,
    "empty search placeholders are not successful route evidence",
  );
  const truncated = "[... truncated ...]";
  const withSearchResult = (result) => ({
    ...searchResult,
    payload: { ...searchResult.payload, result },
  });
  assert.equal(
    verifyToolEvidenceFromEvents(
      [
        searchCall,
        withSearchResult({
          success: true,
          query: searchRequirement.query,
          // Shape produced by task.events sanitizeForBroadcast (depth-4 fields truncated).
          results: [{ title: truncated, url: truncated, snippet: truncated }],
        }),
      ],
      searchRequirement,
    ).ok,
    true,
    "broadcast-truncated hit fields are accepted as live search evidence",
  );
  assert.equal(
    verifyToolEvidenceFromEvents(
      [searchCall, withSearchResult({ success: true, query: searchRequirement.query, results: [] })],
      searchRequirement,
    ).ok,
    false,
    "an empty results array is not search evidence",
  );
  assert.equal(
    verifyToolEvidenceFromEvents(
      [
        searchCall,
        withSearchResult({
          success: true,
          query: searchRequirement.query,
          results: [{ title: "T", url: "not a url", snippet: "S" }],
        }),
      ],
      searchRequirement,
    ).ok,
    false,
    "a hit whose url is neither http(s) nor the truncation marker is rejected",
  );
  assert.equal(
    verifyToolEvidenceFromEvents(
      [
        searchCall,
        withSearchResult({
          success: false,
          query: searchRequirement.query,
          results: [{ title: truncated, url: truncated, snippet: truncated }],
        }),
      ],
      searchRequirement,
    ).ok,
    false,
    "an error search result is rejected even with truncated hits",
  );

  const commandRequirement = { tool: "run_command", command: "node -v" };
  const commandCall = {
    type: "tool_call",
    payload: { tool: "run_command", input: { command: "node -v" }, toolUseId: "shell-use-1" },
  };
  const commandResult = {
    type: "tool_result",
    payload: {
      tool: "run_command",
      result: { success: true, exitCode: 0, terminationReason: "normal", stdout: process.version },
      toolUseId: "shell-use-1",
    },
  };
  assert.equal(
    verifyToolEvidenceFromEvents([commandCall, commandResult], commandRequirement).ok,
    true,
  );
  assert.equal(
    verifyToolEvidenceFromEvents(
      [
        commandCall,
        {
          ...commandResult,
          payload: {
            ...commandResult.payload,
            result: { ...commandResult.payload.result, exitCode: 1 },
          },
        },
      ],
      commandRequirement,
    ).ok,
    false,
  );
  assert.equal(
    verifyToolEvidenceFromEvents(
      [
        { ...commandCall, payload: { ...commandCall.payload, input: { command: "npm -v" } } },
        commandResult,
      ],
      commandRequirement,
    ).ok,
    false,
  );
});

test("follow-up wait accepts timeline-v2 rows carrying legacyType follow_up_completed", async () => {
  const deadlineAt = Date.now() + 5000;
  const clientFor = (events) => ({
    request: async (method) =>
      method === "task.events" ? { events } : { task: { status: "executing" } },
  });
  const v2Row = {
    id: "fu-1",
    type: "timeline_step_updated",
    payload: { legacyType: "follow_up_completed" },
  };
  const found = await waitForFollowUp(clientFor([v2Row]), "task-1", new Set(), deadlineAt, 1);
  assert.equal(found.ok, true);
  assert.equal(found.event.id, "fu-1");

  const legacy = await waitForFollowUp(
    clientFor([{ id: "fu-2", type: "follow_up_completed", payload: {} }]),
    "task-1",
    new Set(),
    deadlineAt,
    1,
  );
  assert.equal(legacy.ok, true);

  const prior = await waitForFollowUp(
    clientFor([v2Row, { id: "x", type: "unrelated", payload: { legacyType: "follow_up_completed" } }]),
    "task-1",
    new Set(["fu-1"]),
    Date.now() + 50,
    5,
  );
  assert.equal(prior.ok, false, "prior events and non-timeline legacyType are ignored");
  assert.equal(prior.reason, "timeout");
});

test("cgroup v2 PDF prerequisite finds the minimum finite inherited ancestor limit", () => {
  const files = new Map([
    ["/proc/self/cgroup", "0::/qa/jobs/run-1\n"],
    ["/proc/self/mountinfo", "31 22 0:29 / /sys/fs/cgroup rw,nosuid,nodev - cgroup2 cgroup rw\n"],
    ["/sys/fs/cgroup/qa/jobs/run-1/memory.max", "max\n"],
    ["/sys/fs/cgroup/qa/jobs/memory.max", "536870912\n"],
    ["/sys/fs/cgroup/qa/memory.max", "1073741824\n"],
    // The kernel root cgroup (the cgroup2 mount root here) has no memory.max file.
  ]);
  const enoent = (file) =>
    Object.assign(new Error("ENOENT: no such file or directory, open '" + file + "'"), {
      code: "ENOENT",
    });
  const detected = detectCgroupV2MemoryLimit({
    platform: "linux",
    readFileSync: (file) => {
      if (!files.has(file)) throw enoent(file);
      return files.get(file);
    },
  });
  assert.equal(detected.available, true);
  assert.equal(detected.memoryLimitBytes, 536870912);
  assert.equal(detectCgroupV2MemoryLimit({ platform: "darwin" }).available, false);
  assert.equal(
    detectCgroupV2MemoryLimit({
      platform: "linux",
      readFileSync: (file) => {
        if (file === "/proc/self/cgroup") return "0::/\n";
        if (file === "/proc/self/mountinfo")
          return "31 22 0:29 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n";
        throw enoent(file);
      },
    }).available,
    false,
    "unlimited cgroups fail closed",
  );
  assert.equal(
    detectCgroupV2MemoryLimit({
      platform: "linux",
      readFileSync: (file) => {
        if (file === "/sys/fs/cgroup/qa/memory.max") {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        }
        if (!files.has(file)) throw enoent(file);
        return files.get(file);
      },
    }).available,
    false,
    "an unreadable non-root ancestor still fails closed",
  );
  assert.equal(
    detectCgroupV2MemoryLimit({
      platform: "linux",
      readFileSync: (file) => {
        if (file === "/sys/fs/cgroup/qa/memory.max") throw enoent(file);
        if (!files.has(file)) throw enoent(file);
        return files.get(file);
      },
    }).available,
    false,
    "a missing memory.max below the mount root still fails closed",
  );
});

test("profile cleanup is attempted before disposition and EACCES retains the path", () => {
  const profilePath = path.join(os.tmpdir(), "qa-profile-pre-spawn");
  let removed = false;
  const cleanError = withProfileCleanupError(new Error("pre-spawn startup error"), profilePath, {
    cleanupAllowed: true,
    remove(target) {
      assert.equal(target, profilePath);
      removed = true;
    },
    exists: () => false,
  });
  assert.equal(removed, true, "a failed startup before process ownership should clean the profile");
  assert.equal(cleanError.profileCleanup.attempted, true);
  assert.equal(cleanError.profileCleanup.failed, false);
  assert.equal(cleanError.profileCleanup.path, null);
  assert.equal(cleanError.profileCleanup.disposition, "cleaned after run");

  const retained = withProfileCleanupError(new Error("cleanup EACCES"), profilePath, {
    cleanupAllowed: true,
    remove() {
      const error = new Error("EACCES: permission denied");
      error.code = "EACCES";
      throw error;
    },
    exists: () => true,
  });
  assert.equal(retained.profileCleanup.attempted, true);
  assert.equal(retained.profileCleanup.failed, true);
  assert.equal(retained.profileCleanup.path, profilePath);
  assert.equal(retained.profileCleanup.disposition, "retained because profile cleanup failed");
  assert.match(retained.profileCleanup.error, /EACCES/);

  let shouldNotRemove = false;
  const unresolved = disposeProfileDir(profilePath, {
    cleanupAllowed: false,
    remove: () => {
      shouldNotRemove = true;
    },
  });
  assert.equal(shouldNotRemove, false);
  assert.equal(unresolved.path, profilePath);
  assert.match(unresolved.disposition, /owned work remains unresolved/);
});

test("Windows cleanup needs taskkill tree acknowledgement and daemon leader exit", async () => {
  const child = { pid: 98765, exitCode: 0, signalCode: null };
  const calls = [];
  const successful = await stopOwnedDaemon(child, 1, "C:/tmp/qa-profile", {
    platform: "win32",
    spawnSyncImpl: (...args) => {
      calls.push(args);
      return { status: 0, stdout: "SUCCESS", stderr: "" };
    },
  });
  assert.equal(successful.stopped, true);
  assert.equal(successful.signal, "taskkill /T /F");
  assert.equal(successful.termination, "forced");
  assert.deepEqual(calls[0].slice(0, 2), ["taskkill.exe", ["/PID", "98765", "/T", "/F"]]);

  for (const spawnSyncImpl of [
    () => ({ status: 1, stdout: "", stderr: "not found" }),
    () => ({ status: null, error: new Error("taskkill missing") }),
    () => {
      throw new Error("spawn failed");
    },
  ]) {
    const failed = await stopOwnedDaemon(child, 1, "C:/tmp/qa-profile", {
      platform: "win32",
      spawnSyncImpl,
    });
    assert.equal(failed.stopped, false);
    assert.equal(failed.termination, "forced");
    assert.equal(failed.unresolvedOwnedProcess.pid, child.pid);
    assert.equal(failed.unresolvedOwnedProcess.profileDir, "C:/tmp/qa-profile");
  }

  assert.equal(
    await waitProcessTreeExit(child, 0, { platform: "win32" }),
    false,
    "leader exit alone is insufficient for an unknown daemon tree",
  );
  assert.equal(
    signalOwnedProcessTree(child, "SIGKILL", {
      platform: "win32",
      spawnSyncImpl: () => ({ status: 1, stderr: "failed" }),
    }),
    false,
  );
  const ownedLeaf = { pid: 98766, exitCode: 0, signalCode: null, qaKnownLeafProcess: true };
  assert.equal(
    await stopOwnedChildren([ownedLeaf], 1, {
      platform: "win32",
      spawnSyncImpl: () => ({ status: 0 }),
    }).then((result) => result.stopped),
    true,
  );
});

test("live PDF grading fails closed without a qualifying cgroup cap", async (t) => {
  const directory = temporaryDirectory(t);
  const runId = "live-pdf-prerequisite";
  const pdf = await createFixture(directory, "live.pdf", { kind: "pdf", runId });
  const noBound = await verifyArtifact("pdf", pdf, runId, { mode: "live" });
  assert.equal(noBound.ok, false);
  assert.equal(noBound.error, "pdf_memory_bound_unavailable");
  const tooLarge = await verifyArtifact("pdf", pdf, runId, {
    mode: "live",
    pdfMemoryLimitBytes: 512 * 1024 * 1024 + 1,
  });
  assert.equal(tooLarge.error, "pdf_memory_bound_unavailable");
  assert.equal(
    (await verifyArtifact("pdf", pdf, runId, { mode: "fixtures" })).ok,
    true,
    "trusted fixture parsing remains available without pretending it is live isolation",
  );
});

test("XLSX is rejected before ExcelJS when an entry CRC or declared expansion bound is false", async (t) => {
  const directory = temporaryDirectory(t);
  const valid = await createFixture(directory, "valid.xlsx", { kind: "xlsx" });

  const crcBuffer = fs.readFileSync(valid);
  const crcOffset = centralDirectoryEntryOffset(crcBuffer, "xl/workbook.xml");
  crcBuffer.writeUInt32LE((crcBuffer.readUInt32LE(crcOffset + 16) ^ 1) >>> 0, crcOffset + 16);
  const badCrc = path.join(directory, "bad-crc.xlsx");
  fs.writeFileSync(badCrc, crcBuffer);
  const crcResult = await verifyArtifact("xlsx", badCrc);
  assert.equal(crcResult.ok, false);
  assert.equal(crcResult.error, "spreadsheet_zip_preflight_failed");
  assert.match(crcResult.detail, /CRC mismatch/);

  const zip = await JSZip.loadAsync(fs.readFileSync(valid));
  zip.file("qa-bomb.bin", Buffer.alloc(256 * 1024), { compression: "DEFLATE" });
  const bombBuffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const bombOffset = centralDirectoryEntryOffset(bombBuffer, "qa-bomb.bin");
  const declaredLength = bombBuffer.readUInt32LE(bombOffset + 20);
  assert.ok(declaredLength > 0);
  bombBuffer.writeUInt32LE(1024, bombOffset + 24);
  const bomb = path.join(directory, "declared-small-bomb.xlsx");
  fs.writeFileSync(bomb, bombBuffer);
  const bombResult = await verifyArtifact("xlsx", bomb);
  assert.equal(bombResult.ok, false);
  assert.equal(bombResult.error, "spreadsheet_zip_preflight_failed");
  assert.match(bombResult.detail, /maxOutputLength|larger than|buffer/i);
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

test("full live mode without a qualifying cgroup cap fails before creating its profile", (t) => {
  const currentBound = detectCgroupV2MemoryLimit();
  if (currentBound.available && currentBound.memoryLimitBytes <= 512 * 1024 * 1024) {
    return t.skip("host already has the required inherited cgroup memory cap");
  }
  const script = path.resolve(__dirname, "../scripts/qa/run_battery.cjs");
  const profilePath = path.join(os.tmpdir(), "cowork-live-pdf-bound-not-created-" + process.pid);
  const env = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG"]
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]]),
  );
  Object.assign(env, {
    COWORK_QA_LLM_PROVIDER: "ollama",
    COWORK_QA_OLLAMA_BASE_URL: "http://127.0.0.1:11434",
  });
  try {
    const result = spawnSync(
      process.execPath,
      [
        script,
        "--live",
        "--allow-provider-calls",
        "--allow-network",
        "--profile-dir",
        profilePath,
        "--json",
      ],
      {
        cwd: path.resolve(__dirname, ".."),
        env,
        encoding: "utf8",
        timeout: 5000,
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Full live mode is unavailable:.*cgroup v2/);
    assert.equal(fs.existsSync(profilePath), false);
  } finally {
    fs.rmSync(profilePath, { recursive: true, force: true });
  }
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
