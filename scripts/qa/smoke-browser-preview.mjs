#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { spawn } from "node:child_process";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const daemonPath = path.join(root, "dist/daemon/daemon/main.js");
const daemonEntry = process.env.COWORK_WEB_SMOKE_DAEMON_ENTRY
  ? path.resolve(root, process.env.COWORK_WEB_SMOKE_DAEMON_ENTRY)
  : daemonPath;
const controlCliPath = path.join(root, "bin/coworkctl.js");
const manifestPath = path.join(root, "dist/web/web-manifest.json");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function callControlPlane(url, token, method) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [controlCliPath, "--url", url, "call", method],
    {
      cwd: root,
      env: { ...process.env, COWORK_CONTROL_PLANE_TOKEN: token },
      timeout: 15_000,
      maxBuffer: 256 * 1024,
    },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true, `Control Plane ${method} failed`);
  return result.payload;
}

async function rpc(base, cookie, csrfToken, apiVersion, method, params, operationKey) {
  const response = await fetch(`${base}/api/web/v1/rpc`, {
    method: "POST",
    headers: {
      Origin: base,
      Cookie: cookie,
      "X-CoWork-CSRF": csrfToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      apiVersion,
      type: "request",
      id: randomUUID(),
      method,
      params,
      ...(operationKey ? { operationKey } : {}),
    }),
  });
  assert.equal(response.status, 200, `${method} HTTP ${response.status}`);
  const frame = await response.json();
  assert.equal(frame.error, undefined, `${method}: ${frame.error?.message ?? "RPC error"}`);
  return frame.result;
}

async function waitForReady(child) {
  let output = "";
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Disposable host did not start in time.")),
      60_000,
    );
    const onData = (chunk) => {
      output = (output + chunk.toString()).slice(-128_000);
      const token = output.match(/\[Daemon\] Control Plane token: ([A-Za-z0-9_-]+)/)?.[1];
      if (token && output.includes("[Daemon] Browser app enabled.")) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.stderr.off("data", onData);
        resolve(token);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Disposable host exited with ${code}: ${output.replace(/Control Plane token: \S+/, "Control Plane token: [redacted]").slice(-3_000)}`,
        ),
      );
    });
  });
}

async function stopHost(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

async function main() {
  await fs.access(daemonPath);
  await fs.access(daemonEntry);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert(Number.isSafeInteger(manifest.apiVersion));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-web-smoke-"));
  const profile = path.join(temp, "profile");
  const workspace = path.join(temp, "workspace");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "input.csv"), "name,value\nAda,7\n");
  await execFileAsync("git", ["init", "-q"], { cwd: workspace });
  await execFileAsync("git", ["add", "--", "input.csv"], { cwd: workspace });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Browser Smoke",
      "-c",
      "user.email=smoke@example.invalid",
      "commit",
      "-qm",
      "Initial fixture",
    ],
    { cwd: workspace },
  );
  await fs.appendFile(path.join(workspace, "input.csv"), "Grace,8\n");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const hostEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/^COWORK_LLM_/i.test(name) &&
        !/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(name),
    ),
  );
  const child = spawn(
    process.execPath,
    [
      daemonEntry,
      "--headless",
      "--enable-control-plane",
      "--print-control-plane-token",
      ...(process.env.COWORK_WEB_SMOKE_DAEMON_ENTRY ? ["--no-import-env-settings"] : []),
      "--user-data-dir",
      profile,
    ],
    {
      cwd: root,
      env: {
        ...hostEnv,
        COWORK_USER_DATA_DIR: profile,
        COWORK_PROFILE: "default",
        COWORK_WEB_ENABLED: "1",
        COWORK_WEB_PUBLIC_ORIGIN: "",
        COWORK_WEB_TRUSTED_PROXY_ADDRESSES: "",
        COWORK_CONTROL_PLANE_HOST: "127.0.0.1",
        COWORK_CONTROL_PLANE_PORT: String(port),
        COWORK_CONTROL_PLANE_TOKEN: "",
        COWORK_BOOTSTRAP_WORKSPACE_PATH: workspace,
        COWORK_BOOTSTRAP_WORKSPACE_NAME: "Browser smoke workspace",
        COWORK_IMPORT_ENV_SETTINGS: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  try {
    const token = await waitForReady(child);
    // The installed Node launcher may rebuild the native SQLite binding before
    // it starts the host. Load it only after the launcher reports readiness.
    const Database = (await import("better-sqlite3")).default;
    const { code } = await callControlPlane(`ws://127.0.0.1:${port}`, token, "web.pair");
    assert.equal(typeof code, "string");
    const app = await fetch(`${base}/app/`);
    assert.equal(app.status, 200);
    const pair = await fetch(`${base}/api/web/v1/session/pair`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    assert.equal(pair.status, 200);
    const cookie = pair.headers.get("set-cookie")?.split(";")[0];
    assert(cookie);
    const sessionResponse = await fetch(`${base}/api/web/v1/session/bootstrap`, {
      headers: { Cookie: cookie, Origin: base },
    });
    assert.equal(sessionResponse.status, 200);
    const session = await sessionResponse.json();
    assert.equal(session.apiVersion, manifest.apiVersion);
    assert.equal(session.capabilities["files.read"]?.available, true);
    assert.equal(session.capabilities["files.upload"]?.available, true);
    assert.equal(session.capabilities["tasks.followUp"]?.available, true);
    assert.equal(session.capabilities["tasks.cancel"]?.available, true);
    assert.equal(session.capabilities["terminal.attach"]?.available, true);

    const workspaces = await rpc(
      base,
      cookie,
      session.csrfToken,
      manifest.apiVersion,
      "workspace.list",
      {},
    );
    const selected = workspaces.workspaces.find((item) => item.name === "Browser smoke workspace");
    assert(selected?.id, "Disposable workspace was not visible in browser RPC");
    const listing = await rpc(
      base,
      cookie,
      session.csrfToken,
      manifest.apiVersion,
      "workspace.files.list",
      {
        workspaceId: selected.id,
        relativePath: "",
      },
    );
    assert(listing.entries.some((entry) => entry.name === "input.csv"));

    const gitStatus = await rpc(
      base,
      cookie,
      session.csrfToken,
      manifest.apiVersion,
      "git.status",
      { workspaceId: selected.id },
    );
    assert.equal(gitStatus.isRepository, true);
    assert(gitStatus.changedFiles >= 1);
    const gitDiff = await rpc(base, cookie, session.csrfToken, manifest.apiVersion, "git.diff", {
      workspaceId: selected.id,
      relativePath: "input.csv",
    });
    assert.equal(gitDiff.truncated, false);
    assert(gitDiff.diff.includes("Grace,8"));

    const download = await fetch(`${base}/api/web/v1/workspace-files/download`, {
      method: "POST",
      headers: {
        Origin: base,
        Cookie: cookie,
        "X-CoWork-CSRF": session.csrfToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ workspaceId: selected.id, relativePath: "input.csv" }),
    });
    assert.equal(download.status, 200);
    assert.equal(await download.text(), "name,value\nAda,7\nGrace,8\n");

    const denied = await fetch(`${base}/api/web/v1/workspace-files/download`, {
      method: "POST",
      headers: {
        Origin: base,
        Cookie: cookie,
        "X-CoWork-CSRF": session.csrfToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ workspaceId: selected.id, relativePath: "../outside.txt" }),
    });
    assert.equal(denied.status, 400);

    const uploadHeaders = {
      Origin: base,
      Cookie: cookie,
      "X-CoWork-CSRF": session.csrfToken,
      "X-CoWork-Workspace-Id": selected.id,
      "X-CoWork-Relative-Path": encodeURIComponent("browser-note.txt"),
      "If-None-Match": "*",
      "Content-Type": "application/octet-stream",
    };
    const upload = await fetch(`${base}/api/web/v1/workspace-files/upload`, {
      method: "POST",
      headers: uploadHeaders,
      body: "uploaded from browser smoke\n",
    });
    assert.equal(upload.status, 201);
    assert.equal(
      await fs.readFile(path.join(workspace, "browser-note.txt"), "utf8"),
      "uploaded from browser smoke\n",
    );
    const duplicateUpload = await fetch(`${base}/api/web/v1/workspace-files/upload`, {
      method: "POST",
      headers: uploadHeaders,
      body: "different content\n",
    });
    assert.equal(duplicateUpload.status, 409);

    const taskKey = randomUUID();
    let taskId;
    try {
      const created = await rpc(
        base,
        cookie,
        session.csrfToken,
        manifest.apiVersion,
        "task.create",
        {
          title: "Browser artifact smoke task",
          prompt: "Inspect the disposable input.csv file.",
          workspaceId: selected.id,
        },
        taskKey,
      );
      taskId = created.taskId;
    } catch {
      const admission = await rpc(
        base,
        cookie,
        session.csrfToken,
        manifest.apiVersion,
        "task.admission.get",
        { operationKey: taskKey },
      );
      assert.equal(admission.found, true, "Disposable task was not admitted");
      taskId = admission.taskId;
    }
    assert.equal(typeof taskId, "string");
    const terminalDb = new Database(path.join(profile, "cowork-os.db"));
    try {
      const row = terminalDb
        .prepare("SELECT permissions FROM workspaces WHERE id = ?")
        .get(selected.id);
      assert(row?.permissions);
      const permissions = JSON.parse(row.permissions);
      terminalDb
        .prepare("UPDATE workspaces SET permissions = ? WHERE id = ?")
        .run(JSON.stringify({ ...permissions, shell: true }), selected.id);
    } finally {
      terminalDb.close();
    }
    const terminalScope = { taskId, workspaceId: selected.id };
    const openedTerminal = await rpc(
      base,
      cookie,
      session.csrfToken,
      manifest.apiVersion,
      "terminal.open",
      terminalScope,
      randomUUID(),
    );
    assert.equal(openedTerminal.writer, true);
    const marker = `browser_terminal_ready_${randomUUID().replaceAll("-", "")}`;
    await rpc(
      base,
      cookie,
      session.csrfToken,
      manifest.apiVersion,
      "terminal.input",
      {
        ...terminalScope,
        attachmentId: openedTerminal.attachmentId,
        input: `printf '%s\\n' '${marker}'\n`,
      },
      randomUUID(),
    );
    await rpc(
      base,
      cookie,
      session.csrfToken,
      manifest.apiVersion,
      "terminal.detach",
      { ...terminalScope, attachmentId: openedTerminal.attachmentId },
      randomUUID(),
    );
    const reattachedTerminal = await rpc(
      base,
      cookie,
      session.csrfToken,
      manifest.apiVersion,
      "terminal.attach",
      { ...terminalScope, tabId: openedTerminal.tab.id },
      randomUUID(),
    );
    let terminalOutput = "";
    let terminalOffset = 0;
    for (let attempt = 0; attempt < 30 && !terminalOutput.includes(marker); attempt += 1) {
      const replay = await rpc(
        base,
        cookie,
        session.csrfToken,
        manifest.apiVersion,
        "terminal.replay",
        {
          ...terminalScope,
          attachmentId: reattachedTerminal.attachmentId,
          afterOffset: terminalOffset,
        },
      );
      terminalOutput += replay.chunks.map((chunk) => chunk.text).join("");
      terminalOffset = replay.nextOffset;
      if (!terminalOutput.includes(marker))
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(terminalOutput.includes(marker), "Detached terminal output did not replay");
    await rpc(
      base,
      cookie,
      session.csrfToken,
      manifest.apiVersion,
      "terminal.close",
      { ...terminalScope, attachmentId: reattachedTerminal.attachmentId },
      randomUUID(),
    );
    const artifactPath = path.join(workspace, "browser-artifact.txt");
    const artifactBytes = "disposable browser artifact\n";
    await fs.writeFile(artifactPath, artifactBytes);
    const artifactId = randomUUID();
    const artifactDb = new Database(path.join(profile, "cowork-os.db"));
    try {
      artifactDb
        .prepare(
          "INSERT INTO artifacts (id, task_id, path, mime_type, sha256, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          artifactId,
          taskId,
          artifactPath,
          "text/plain",
          createHash("sha256").update(artifactBytes).digest("hex"),
          Buffer.byteLength(artifactBytes),
          Date.now(),
        );
    } finally {
      artifactDb.close();
    }
    const artifactPage = await rpc(
      base,
      cookie,
      session.csrfToken,
      manifest.apiVersion,
      "task.artifacts.list",
      { taskId, workspaceId: selected.id },
    );
    assert(artifactPage.artifacts.some((item) => item.artifactId === artifactId));
    const handle = await rpc(
      base,
      cookie,
      session.csrfToken,
      manifest.apiVersion,
      "artifact.download.create",
      { artifactId },
      randomUUID(),
    );
    assert.equal(handle.artifactId, artifactId);
    const artifactDownloadHeaders = {
      Origin: base,
      Cookie: cookie,
      "X-CoWork-CSRF": session.csrfToken,
      "Content-Type": "application/json",
    };
    const artifactDownload = await fetch(`${base}/api/web/v1/artifacts/download`, {
      method: "POST",
      headers: artifactDownloadHeaders,
      body: JSON.stringify({ handle: handle.handle }),
    });
    assert.equal(artifactDownload.status, 200);
    assert.equal(await artifactDownload.text(), artifactBytes);
    const replayedArtifactDownload = await fetch(`${base}/api/web/v1/artifacts/download`, {
      method: "POST",
      headers: artifactDownloadHeaders,
      body: JSON.stringify({ handle: handle.handle }),
    });
    assert.equal(replayedArtifactDownload.status, 404);

    const cancellationTaskId = randomUUID();
    const cancellationDb = new Database(path.join(profile, "cowork-os.db"));
    try {
      cancellationDb
        .prepare(
          "INSERT INTO tasks (id, title, prompt, status, workspace_id, created_at, updated_at) VALUES (?, ?, ?, 'executing', ?, ?, ?)",
        )
        .run(
          cancellationTaskId,
          "Disposable cancellation fixture",
          "No provider execution is scheduled for this fixture.",
          selected.id,
          Date.now(),
          Date.now(),
        );
    } finally {
      cancellationDb.close();
    }
    const taskBeforeCancel = await rpc(
      base,
      cookie,
      session.csrfToken,
      manifest.apiVersion,
      "task.get",
      { taskId: cancellationTaskId },
    );
    assert.equal(taskBeforeCancel.task.status, "executing");
    const cancellationKey = randomUUID();
    const cancelParams = {
      taskId: cancellationTaskId,
      workspaceId: selected.id,
      expectedStatus: taskBeforeCancel.task.status,
      expectedUpdatedAt: taskBeforeCancel.task.updatedAt,
    };
    const cancelled = await rpc(
      base,
      cookie,
      session.csrfToken,
      manifest.apiVersion,
      "task.cancel",
      cancelParams,
      cancellationKey,
    );
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.outcome, "observed_terminal");
    const cancelledReplay = await rpc(
      base,
      cookie,
      session.csrfToken,
      manifest.apiVersion,
      "task.cancel",
      cancelParams,
      cancellationKey,
    );
    assert.equal(cancelledReplay.status, "cancelled");

    const logout = await fetch(`${base}/api/web/v1/session/logout`, {
      method: "POST",
      headers: { Origin: base, Cookie: cookie, "X-CoWork-CSRF": session.csrfToken },
    });
    assert.equal(logout.status, 200);
    const afterLogout = await fetch(`${base}/api/web/v1/session/bootstrap`, {
      headers: { Cookie: cookie, Origin: base },
    });
    assert.equal(afterLogout.status, 401);
    process.stdout.write(
      "Browser preview smoke passed: pairing, scoped files, read-only Git, terminal detach/replay, upload/no-overwrite, artifact download/one-use handle, task cancellation/reconciliation, traversal denial, logout.\n",
    );
  } finally {
    await stopHost(child);
    await fs.rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
