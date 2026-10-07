#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const root = process.cwd();
const daemonPath = path.join(root, "dist/daemon/daemon/main.js");
const daemonEntry = process.env.COWORK_WEB_SMOKE_DAEMON_ENTRY
  ? path.resolve(root, process.env.COWORK_WEB_SMOKE_DAEMON_ENTRY)
  : daemonPath;
const electronHost =
  daemonEntry === path.join(root, "bin/coworkd.js") && process.env.ELECTRON_RUN_AS_NODE === "1";
const electronMainPath = path.join(root, "dist/electron/electron/main.js");
const controlCliPath = path.join(root, "bin/coworkctl.js");
const manifestPath = path.join(root, "dist/web/web-manifest.json");

function inspectFollowUpCopies(userMessageTexts, marker) {
  const countMarker = (text) => text.split(marker).length - 1;
  const followUpMessageCopies = userMessageTexts.reduce((count, text) => {
    const currentUserText = text.replace(
      /<cowork_memory_recall>[\s\S]*?<\/cowork_memory_recall>/gi,
      "",
    );
    return count + countMarker(currentUserText);
  }, 0);
  const recalledObservationCopies = userMessageTexts.reduce((count, text) => {
    const recallBlocks = text.match(/<cowork_memory_recall>[\s\S]*?<\/cowork_memory_recall>/gi) || [];
    return count + recallBlocks.reduce((blockCount, block) => blockCount + countMarker(block), 0);
  }, 0);
  return { followUpMessageCopies, recalledObservationCopies };
}

const followUpMarkerFixture = "Synthetic follow-up marker fixture.";
const mixedRecallTranscriptFixture = inspectFollowUpCopies(
  [
    `<cowork_memory_recall>[recent:observation] ${followUpMarkerFixture}</cowork_memory_recall>\nCurrent user message: ${followUpMarkerFixture}`,
  ],
  followUpMarkerFixture,
);
assert.deepEqual(mixedRecallTranscriptFixture, {
  followUpMessageCopies: 1,
  recalledObservationCopies: 1,
});

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

async function startSyntheticOpenAIStub() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    if (request.url === "/v1/models" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "synthetic-recovery-model", object: "model" }] }));
      return;
    }
    if (request.url !== "/v1/chat/completions" || request.method !== "POST") {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Synthetic QA stub route not found" } }));
      return;
    }
    if (request.headers.authorization !== "Bearer synthetic-browser-qa-only") {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Synthetic QA key rejected" } }));
      return;
    }
    let requestJson;
    try {
      requestJson = JSON.parse(body);
    } catch {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Malformed synthetic completion request" } }));
      return;
    }
    const userMessages = Array.isArray(requestJson.messages)
      ? requestJson.messages.filter((message) => message?.role === "user")
      : [];
    const userMessageText = userMessages.map((message) => {
      if (typeof message.content === "string") return message.content;
      if (!Array.isArray(message.content)) return "";
      return message.content
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");
    });
    const followUpMarker =
      "Synthetic recovery acceptance: preserve the uploaded CSV and report that the request was received.";
    const cancellationMarker =
      "Synthetic cancellation acceptance: keep this provider request open until the task is canceled.";
    const { followUpMessageCopies, recalledObservationCopies } = inspectFollowUpCopies(
      userMessageText,
      followUpMarker,
    );
    const record = {
      model: requestJson.model,
      messageCount: Array.isArray(requestJson.messages) ? requestJson.messages.length : 0,
      hasTools: Array.isArray(requestJson.tools) && requestJson.tools.length > 0,
      followUpMessageCopies,
      recalledObservationCopies,
      lastUserMessageHasFollowUp: userMessageText.at(-1)?.includes(followUpMarker) === true,
      heldForCancellation: userMessageText.some((text) => text.includes(cancellationMarker)),
      providerConnectionClosed: false,
      holdTimedOut: false,
    };
    requests.push(record);
    if (record.heldForCancellation) {
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          record.holdTimedOut = true;
          response.writeHead(504, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: { message: "Synthetic cancellation hold timed out" } }));
          finish();
        }, 60_000);
        response.once("close", () => {
          if (!response.writableEnded) record.providerConnectionClosed = true;
          finish();
        });
        request.once("aborted", () => {
          record.providerConnectionClosed = true;
          finish();
        });
      });
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      id: `chatcmpl-synthetic-${requests.length}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "synthetic-recovery-model",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "Synthetic recovery provider accepted this request. No external model was called.",
        },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 64, completion_tokens: 16, total_tokens: 80 },
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    async waitForRequest(predicate, timeoutMs = 15_000, timeoutMessage) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const match = requests.find(predicate);
        if (match) return match;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.fail(
        timeoutMessage?.() ?? `Synthetic provider request was not observed within ${timeoutMs}ms`,
      );
    },
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function waitForTaskTerminal({ base, cookie, csrfToken, apiVersion, taskId, timeoutMs = 45_000 }) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await rpc(base, cookie, csrfToken, apiVersion, "task.get", { taskId });
    if (["completed", "error", "failed", "cancelled"].includes(latest.task.status)) {
      assert.equal(latest.task.status, "completed", `Synthetic task ended as ${latest.task.status}: ${latest.task.error || "no error detail"}`);
      return latest.task;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.fail(`Synthetic task did not complete before the ${timeoutMs}ms acceptance timeout; last status=${latest?.task?.status || "unknown"}`);
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

async function dropHttpResponse(url, headers, body) {
  return await new Promise((resolve, reject) => {
    let settled = false;
    const request = http.request(url, { method: "POST", headers }, (response) => {
      settled = true;
      const status = response.statusCode ?? 0;
      response.on("error", () => undefined);
      response.destroy();
      resolve(status);
    });
    request.on("error", (error) => {
      if (!settled) reject(error);
    });
    request.end(body);
  });
}

async function dropRpcResponse(base, cookie, csrfToken, apiVersion, method, params, operationKey) {
  const body = JSON.stringify({
    apiVersion,
    type: "request",
    id: randomUUID(),
    method,
    params,
    ...(operationKey ? { operationKey } : {}),
  });
  return await dropHttpResponse(`${base}/api/web/v1/rpc`, {
    Origin: base,
    Cookie: cookie,
    "X-CoWork-CSRF": csrfToken,
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  }, body);
}

async function pairBrowserSession({ base, port, token, manifest }) {
  const pairing = await callControlPlane(`ws://127.0.0.1:${port}`, token, "web.pair");
  assert.equal(typeof pairing.code, "string");
  const pair = await fetch(`${base}/api/web/v1/session/pair`, {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ code: pairing.code }),
  });
  assert.equal(pair.status, 200);
  const cookie = pair.headers.get("set-cookie")?.split(";")[0];
  assert(cookie);
  const response = await fetch(`${base}/api/web/v1/session/bootstrap`, {
    headers: { Cookie: cookie, Origin: base },
  });
  assert.equal(response.status, 200);
  const session = await response.json();
  assert.equal(session.apiVersion, manifest.apiVersion);
  return { cookie, session };
}

function seedRecoveryFixtures(Database, profile, workspaceId) {
  const db = new Database(path.join(profile, "cowork-os.db"));
  const now = Date.now();
  const approvalTaskId = randomUUID();
  const inputTaskId = randomUUID();
  const branchTaskId = randomUUID();
  const approvalId = `browser-recovery-approval-${randomUUID()}`;
  const inputRequestId = randomUUID();
  const approvalRequestedAt = now + 1;
  const inputRequestedAt = now + 2;
  try {
    const insertTask = db.prepare(`INSERT INTO tasks
      (id, title, prompt, status, workspace_id, created_at, updated_at, terminal_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    insertTask.run(
      approvalTaskId,
      "Synthetic approval recovery fixture",
      "Disposable browser recovery fixture; no provider execution is scheduled.",
      "blocked",
      workspaceId,
      now,
      now,
      "awaiting_approval",
    );
    insertTask.run(
      inputTaskId,
      "Synthetic input recovery fixture",
      "Disposable browser recovery fixture; no provider execution is scheduled.",
      "paused",
      workspaceId,
      now,
      now,
      "needs_user_action",
    );
    insertTask.run(
      branchTaskId,
      "Synthetic task branching fixture",
      "Disposable branch-operation fixture; no provider execution is scheduled.",
      "executing",
      workspaceId,
      now,
      now,
      null,
    );
    db.prepare(`INSERT INTO approvals
      (id, task_id, type, description, details, status, requested_at)
      VALUES (?, ?, 'run_command', ?, ?, 'pending', ?)`)
      .run(
        approvalId,
        approvalTaskId,
        "Disposable approval fixture for browser recovery acceptance.",
        JSON.stringify({ command: "printf synthetic", apiKey: "synthetic-redaction-probe" }),
        approvalRequestedAt,
      );
    db.prepare(`INSERT INTO input_requests
      (id, task_id, questions, status, requested_at)
      VALUES (?, ?, ?, 'pending', ?)`)
      .run(
        inputRequestId,
        inputTaskId,
        JSON.stringify([
          {
            header: "Output",
            id: "output_format",
            question: "Which format should the disposable task use?",
            options: [
              { label: "CSV", description: "Comma-separated values" },
              { label: "Markdown", description: "Plain text report" },
            ],
          },
        ]),
        inputRequestedAt,
      );
  } finally {
    db.close();
  }
  return {
    approval: { taskId: approvalTaskId, id: approvalId, expectedVersion: approvalRequestedAt },
    inputRequest: { taskId: inputTaskId, id: inputRequestId, expectedVersion: inputRequestedAt },
    branchTaskId,
  };
}

function countFollowUpReceipts(Database, profile, taskId, messageId) {
  const db = new Database(path.join(profile, "cowork-os.db"));
  try {
    const rows = db.prepare(`SELECT payload FROM task_events
      WHERE task_id = ? AND COALESCE(legacy_type, type) = 'user_message'`).all(taskId);
    return rows.filter((row) => {
      try {
        return JSON.parse(row.payload)?.messageId === messageId;
      } catch {
        return false;
      }
    }).map((row) => JSON.parse(row.payload));
  } finally {
    db.close();
  }
}

async function waitForReady(child) {
  let output = "";
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `Disposable host did not start in time.${output ? `\nHost output:\n${output.replace(/Control Plane token: \S+/g, "Control Plane token: [redacted]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(-5_000)}` : " No host output was captured."}`,
          ),
        ),
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

async function readLocalControlPlaneToken(profile, port) {
  try {
    const pairing = JSON.parse(
      await fs.readFile(path.join(profile, "control-plane-local.json"), "utf8"),
    );
    if (
      pairing?.url === `ws://127.0.0.1:${port}` &&
      typeof pairing?.token === "string" &&
      /^[A-Za-z0-9_-]{32,256}$/.test(pairing.token)
    ) {
      return pairing.token;
    }
  } catch {
    // The descriptor is written after the Electron Control Plane starts.
  }
  return null;
}

async function waitForElectronReady(child, { base, port, profile, timeoutMs = 60_000 }) {
  let output = "";
  const onData = (chunk) => {
    output = (output + chunk.toString()).slice(-32_000);
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Electron daemon exited before readiness: ${output.replace(/Control Plane token: \S+/g, "Control Plane token: [redacted]").slice(-5_000)}`);
      }
      try {
        const appResponse = await fetch(`${base}/app/`, { signal: AbortSignal.timeout(1_000) });
        if (appResponse.status === 200) {
          const token = await readLocalControlPlaneToken(profile, port);
          if (!token) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            continue;
          }
          const pairing = await callControlPlane(`ws://127.0.0.1:${port}`, token, "web.pair");
          if (typeof pairing.code === "string") return token;
        }
      } catch {
        // The HTTP and Control Plane listeners may become ready in either order.
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(
      `Electron daemon did not become ready within ${timeoutMs}ms.${output ? `\nHost output:\n${output.replace(/Control Plane token: \S+/g, "Control Plane token: [redacted]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(-5_000)}` : " No host output was captured."}`,
    );
  } finally {
    child.stdout.off("data", onData);
    child.stderr.off("data", onData);
  }
}

async function stopHost(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const signalTree = async (signal) => {
    if (child.pid === undefined) return;
    if (process.platform === "win32") {
      try {
        await execFileAsync(
          "taskkill",
          ["/PID", String(child.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])],
          { timeout: 5_000, windowsHide: true },
        );
      } catch {
        child.kill(signal);
      }
      return;
    }
    try {
      // The Electron daemon wrapper starts the actual Electron process. Signal
      // the detached group so restart/cleanup cannot leave that child orphaned.
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
      child.kill(signal);
    }
  };
  await signalTree("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null && child.signalCode === null) {
    await signalTree("SIGKILL");
    await exited;
  }
}

async function seedMemoryApprovals(profile, workspaceId, prefix) {
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(path.join(profile, "cowork-os.db"));
  try {
    for (const action of ["approve", "reject"]) {
      db.prepare(`INSERT INTO pending_memory_writes
        (id, workspace_id, target, action, origin, summary, payload_json, status, created_at)
        VALUES (?, ?, 'archive', 'capture', 'system', ?, ?, 'pending', ?)`).run(
        `${prefix}-${action}`, workspaceId, `Disposable ${prefix} ${action} memory`,
        JSON.stringify({ type: "insight", content: `The disposable ${prefix} ${action} project uses orange notebooks for all planning notes.`, isPrivate: true }), Date.now(),
      );
    }
  } finally { db.close(); }
}

async function runBrowserUiSmoke({ base, port, token, profile, awarenessWorkspaceId, awarenessBeliefId }) {
  const { chromium } = require("playwright");
  const pairing = await callControlPlane(`ws://127.0.0.1:${port}`, token, "web.pair");
  assert.equal(typeof pairing.code, "string");
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.COWORK_WEB_UI_BROWSER_EXECUTABLE
      ? { executablePath: process.env.COWORK_WEB_UI_BROWSER_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage();
  try {
    const controlAudit = [];
    const captureControls = async (route) => {
      const snapshot = await page.evaluate(() => {
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && !element.closest("[hidden]");
        };
        return {
          routeMessage: document.querySelector(".settings-content")?.innerText?.slice(0, 1500) ?? "",
          controls: Array.from(document.querySelectorAll('button, input:not([type="hidden"]), select, textarea, [role="button"], [role="menuitem"], [role="tab"]')).filter(visible).map((element) => ({
            tag: element.tagName.toLowerCase(),
            role: element.getAttribute("role"),
            type: element.getAttribute("type"),
            name: element.getAttribute("aria-label") || element.labels?.[0]?.innerText?.trim() || element.innerText?.trim() || element.getAttribute("placeholder") || element.getAttribute("title") || "",
            disabled: element.disabled === true || element.getAttribute("aria-disabled") === "true",
            reason: element.getAttribute("title") || "",
            settingsTab: element.getAttribute("data-tab"),
            state: element.getAttribute("aria-expanded") || element.getAttribute("aria-pressed"),
          })),
        };
      });
      controlAudit.push({ route, ...snapshot });
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      const output = path.resolve(process.env.COWORK_WEB_CONTROL_AUDIT_PATH || path.join(os.tmpdir(), "cowork-web-control-audit.json"));
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.writeFile(output, JSON.stringify({ generatedAt: new Date().toISOString(), host: "disposable Node QA host", buildId: manifest.buildId, apiVersion: manifest.apiVersion, scope: "Rendered control inventory; presence/enabled state does not prove action behavior. Nested dialogs, populated-data states and native host parity need further audit.", routes: controlAudit }, null, 2) + "\n");
    };
    const failures = [];
    let manifestMismatches = 1;
    await page.addInitScript(() => {
      window.__coworkBrowserUnsupportedActions = [];
      window.addEventListener("cowork-browser-unsupported-action", (event) => {
        const method = event?.detail?.method;
        if (typeof method === "string") window.__coworkBrowserUnsupportedActions.push(method);
      });
    });
    page.on("pageerror", (error) => failures.push(`${error.name}: ${error.message}`));
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        /UnsupportedBrowserHostMethodError|UNSUPPORTED_CAPABILITY/.test(message.text())
      ) {
        failures.push(message.text().slice(0, 500));
      }
    });
    await page.route("**/app/web-manifest.json", async (route) => {
      const response = await route.fetch();
      if (manifestMismatches > 0) {
        manifestMismatches -= 1;
        const manifest = await response.json();
        await route.fulfill({
          response,
          body: JSON.stringify({ ...manifest, buildId: `${manifest.buildId}-newer` }),
        });
      } else {
        await route.fulfill({ response });
      }
    });

    await page.goto(`${base}/app/`);
    page.setDefaultTimeout(10_000);
    await page.getByLabel("Pairing code").fill(pairing.code);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.getByRole("button", { name: "Skip onboarding" }).click();
    const understand = page.getByText("Yes, I understand", { exact: true });
    await understand.waitFor({ state: "visible" });
    await understand.click();
    const continueButton = page.getByRole("button", { name: "Continue", exact: true });
    await continueButton.waitFor({ state: "visible" });
    await continueButton.click();

    // Rail items carry their destination; aria-labels can include an unread count.
    const railButton = (destination) =>
      page.locator(`.sidebar-rail [data-destination="${destination}"]`);
    const openMoreItem = async (name) => {
      await page.locator('.sidebar-rail button[aria-label="More"]').click();
      await page.getByRole("menuitem", { name, exact: true }).click();
    };
    const inboxButton = railButton("inbox");
    try {
      await inboxButton.waitFor({ state: "visible", timeout: 7_000 });
    } catch {
      const state = await page
        .locator("body")
        .innerText()
        .catch(() => "<unavailable>");
      throw new Error(`The shared app did not open after pairing. UI: ${state.slice(0, 1_000)}`);
    }
    await captureControls("shared-app/initial");
    const renderedText = await page.locator("body").innerText();
    assert.doesNotMatch(
      renderedText,
      /Run on your host|Recent activity|Workspace files/,
      "The browser should render the shared desktop interface, not the reduced legacy dashboard.",
    );
    await page.locator(".browser-host-update-banner").waitFor({ state: "visible" });
    await page
      .locator(".browser-host-update-banner")
      .getByRole("button", { name: "Reload" })
      .click();
    await inboxButton.waitFor({ state: "visible" });
    await page.locator(".browser-host-update-banner").waitFor({ state: "detached" });
    await page.evaluate(() => {
      const probe = document.createElement("button");
      probe.type = "button";
      probe.dataset.browserUnsupportedSmoke = "true";
      probe.textContent = "Unavailable action smoke";
      probe.addEventListener("click", () => {
        void window.electronAPI.agentSecurityScan().catch(() => undefined);
      });
      document.body.append(probe);
    });
    await page.locator('[data-browser-unsupported-smoke="true"]').click();
    await page
      .getByText(
        "This action is not connected to the browser session. Use CoWork OS on the host to complete it.",
        { exact: true },
      )
      .waitFor({ state: "visible" });
    await page.evaluate(() => {
      window.__coworkBrowserUnsupportedActions.length = 0;
    });
    await page
      .locator('[data-browser-unsupported-smoke="true"]')
      .evaluate((element) => element.remove());
    await page.getByText("No model provider is configured on this host.", { exact: true }).waitFor({
      state: "visible",
    });
    await page.getByRole("button", { name: "Open AI & Models", exact: true }).click();
    await page.getByRole("heading", { name: "AI & Models", exact: true }).waitFor({
      state: "visible",
    });
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await inboxButton.click();
    await page.getByText("Inbox Agent", { exact: true }).waitFor({ state: "visible" });

    await railButton("automations").click();
    await page.locator('section[aria-label="Automation Studio"]').waitFor({ state: "visible" });
    await page.getByRole("heading", { name: "Build work that runs itself", exact: true }).waitFor({
      state: "visible",
    });
    await openMoreItem("Devices");
    await page.getByRole("heading", { name: "Devices", exact: true }).waitFor({ state: "visible" });
    await openMoreItem("Everyday");
    await page
      .getByRole("heading", { name: "Everyday Agent", exact: true })
      .waitFor({ state: "visible" });
    await openMoreItem("Mission Control");
    await page.locator(".mc-v2-topbar h1").waitFor({ state: "visible" });
    await inboxButton.click();
    await page.getByText("Inbox Agent", { exact: true }).waitFor({ state: "visible" });

    await page.evaluate(async () => {
      const project = (await window.electronAPI.listWorkspaces()).find(
        (candidate) => candidate.name === "Browser Git UI smoke workspace",
      );
      if (!project) throw new Error("The Git UI smoke workspace is unavailable.");
      const selected = await window.electronAPI.selectWorkspace(project.id);
      window.dispatchEvent(
        new CustomEvent("cowork-browser-workspace-selected", { detail: selected }),
      );
    });
    await railButton("gitChanges").click();
    await page
      .getByRole("heading", { name: "Git Changes", exact: true })
      .waitFor({ state: "visible" });
    try {
      await page.getByText("ui-git-change.txt", { exact: true }).waitFor({ state: "visible" });
    } catch (error) {
      const details = await page.evaluate(async () => {
        const workspaces = await window.electronAPI.listWorkspaces();
        const results = await Promise.all(
          workspaces.map(async (candidate) => ({
            name: candidate.name,
            workspaceId: candidate.id,
            status: await window.coworkBrowserGit?.status(candidate.id).catch((statusError) => ({
              error: statusError instanceof Error ? statusError.message : String(statusError),
            })),
          })),
        );
        return {
          activeWorkspaceId: window.coworkBrowserHostInfo?.activeWorkspaceId,
          text: document.body.innerText.slice(0, 2_000),
          workspaces: results,
        };
      });
      throw new Error(`Git Changes UI omitted the changed file: ${JSON.stringify(details)}`, {
        cause: error,
      });
    }
    await page
      .locator(".git-changes-files li")
      .filter({ hasText: "ui-git-change.txt" })
      .getByRole("button", { name: "Stage", exact: true })
      .click();
    await page.getByText("Staged", { exact: true }).waitFor({ state: "visible" });
    await page.getByLabel("Commit message").fill("Browser UI smoke change");
    await page.getByRole("button", { name: "Commit staged changes", exact: true }).click();
    await page.getByText(/Created commit [a-f0-9]{8}/i).waitFor({ state: "visible" });
    const gitFilesAfterCommit = await page.evaluate(async () =>
      (
        await window.coworkBrowserGit?.status(window.coworkBrowserHostInfo?.activeWorkspaceId ?? "")
      )?.files.map((file) => file.path),
    );
    assert(gitFilesAfterCommit?.includes("browser-artifact.txt"));
    assert(!gitFilesAfterCommit?.includes("ui-git-change.txt"));

    await page.getByRole("button", { name: "New session", exact: true }).click();
    await page
      .getByRole("heading", { name: /Tell me what you want to make/ })
      .waitFor({ state: "visible" });

    await page.getByRole("button", { name: "Organize projects" }).click();
    await page.getByRole("menuitem", { name: "New project", exact: true }).click();
    const projectDialog = page.getByRole("dialog", { name: "Create project" });
    await projectDialog.getByLabel("Project name").fill("UI smoke project");
    await projectDialog.getByRole("button", { name: "Create project" }).click();
    await page.getByText("UI smoke project", { exact: true }).first().waitFor({ state: "visible" });

    await railButton("agents").click();
    // The Bots page keeps workspace (managed) agents in a collapsible section below the bots.
    const workspaceAgentsToggle = page.locator("button.agents-workspace-toggle");
    await workspaceAgentsToggle.waitFor({ state: "visible" });
    if ((await workspaceAgentsToggle.getAttribute("aria-expanded")) !== "true") {
      await workspaceAgentsToggle.click();
    }
    await page.getByRole("button", { name: "Create agent", exact: true }).first().click();
    await page.getByRole("button", { name: "Start blank", exact: true }).click();
    const saveAgent = page.getByRole("button", { name: "Save Agent", exact: true });
    await saveAgent.waitFor({ state: "visible" });
    assert.equal(
      await saveAgent.isDisabled(),
      false,
      "Save Agent should be an active browser action",
    );
    await saveAgent.click();
    await page.getByText("New Agent", { exact: true }).waitFor({ state: "visible" });

    const notification = await page.evaluate(() =>
      window.electronAPI.addNotification({
        type: "info",
        title: "UI smoke notification",
        message: "Notification actions are connected.",
      }),
    );
    assert(notification?.id, "The host should persist a test notification");
    // The bell reads "Notifications, N unread" while anything is unread.
    await page.getByRole("button", { name: /^Notifications(, \d+ unread)?$/ }).click();
    await page.getByText("UI smoke notification", { exact: true }).waitFor({
      state: "visible",
      timeout: 8_000,
    });
    await page.getByRole("button", { name: /Mark all read/ }).click();
    await page.getByRole("button", { name: /Clear all/ }).click();
    await page.getByText("You're all caught up", { exact: true }).waitFor({ state: "visible" });
    // Close the notifications popover before interacting with the sidebar; its
    // backdrop intentionally consumes the first click outside the panel.
    // The bell reads "Notifications, N unread" while anything is unread.
    await page.getByRole("button", { name: /^Notifications(, \d+ unread)?$/ }).click();

    await openMoreItem("Mission Control");
    for (const name of ["Teams", "Reviews", "Check-in"]) {
      const button = page.getByRole("button", { name, exact: true });
      assert.equal(
        await button.isDisabled(),
        true,
        `${name} should be disabled when host support is absent`,
      );
      assert(
        (await button.getAttribute("title"))?.trim(),
        `${name} should explain its unavailable state`,
      );
    }

    const syntheticTask = await page.evaluate(async () => {
      const bootstrapUrl = new URL("../api/web/v1/session/bootstrap", document.baseURI);
      const rpcUrl = new URL("../api/web/v1/rpc", document.baseURI);
      const session = await fetch(bootstrapUrl, { credentials: "same-origin" }).then((response) =>
        response.json(),
      );
      const operationKey = `ui-smoke-${crypto.randomUUID()}`;
      const send = async (method, params) => {
        const response = await fetch(rpcUrl, {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "X-CoWork-CSRF": session.csrfToken,
          },
          body: JSON.stringify({
            apiVersion: session.apiVersion,
            type: "request",
            id: crypto.randomUUID(),
            method,
            params,
            ...(method === "task.create" ? { operationKey } : {}),
          }),
        });
        return response.json();
      };
      const workspaces = await window.electronAPI.listWorkspaces();
      const workspace = workspaces.find((candidate) => candidate.permissions?.write === true);
      if (!workspace) throw new Error("The UI smoke host has no writable workspace.");
      let result = await send("task.create", {
        title: "Browser action smoke task",
        prompt: "Disposable UI action coverage; do not perform external work.",
        workspaceId: workspace.id,
      });
      if (result.error?.code === "OUTCOME_UNKNOWN") {
        result = await send("task.admission.get", { operationKey });
      }
      if (result.error)
        throw new Error(result.error.message || "Could not create the UI smoke task.");
      const taskId = result.result?.taskId;
      if (typeof taskId !== "string") throw new Error("The host returned no UI smoke task id.");
      return { taskId, title: "Browser action smoke task" };
    });
    await page.reload();
    await railButton("inbox").waitFor({ state: "visible" });
    try {
      await page.locator(`[data-task-id="${syntheticTask.taskId}"]`).waitFor({ state: "visible" });
    } catch (error) {
      const state = await page
        .evaluate(async () => ({
          text: document.body.innerText.slice(0, 2_000),
          tasks: await window.electronAPI.listSidebarTasks({ limit: 50 }),
        }))
        .catch(() => ({ text: "<unavailable>", tasks: [] }));
      throw new Error(
        `The UI smoke task did not appear after reload. Tasks: ${JSON.stringify(state.tasks)}. UI: ${state.text}`,
        { cause: error },
      );
    }
    const taskRow = page.locator(`[data-task-id="${syntheticTask.taskId}"]`);
    const taskMenu = taskRow.locator("button.task-item-more");

    await taskMenu.click();
    const pinAction = page.getByRole("menuitem", { name: "Pin", exact: true });
    assert.equal(await pinAction.isDisabled(), false, "Pin should be an active browser action");
    await pinAction.click();
    // Pinned rows move to the Pinned section without a marker; the menu says Unpin.
    await taskMenu.click();
    await page.getByRole("menuitem", { name: "Unpin", exact: true }).waitFor({ state: "visible" });
    await taskMenu.click();

    await taskMenu.click();
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
    const renamedTask = `${syntheticTask.title} renamed`;
    const renameInput = taskRow.locator("input.task-item-rename-input");
    await renameInput.fill(renamedTask);
    await renameInput.press("Enter");
    await page.waitForFunction(
      ({ taskId, title }) =>
        document
          .querySelector(`[data-task-id="${taskId}"] .cli-task-title`)
          ?.getAttribute("title") === title,
      { taskId: syntheticTask.taskId, title: renamedTask },
    );

    // A selected task remounts its background panels when returning from Settings.
    // Unsupported optional reads/subscriptions must not masquerade as user actions.
    await taskRow.locator(".cli-task-title").click();
    await page.locator('.sidebar-rail button[aria-label^="Settings"]').click();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('textarea[aria-label="Message"]') || document.querySelector(".main-content"));
    assert.deepEqual(await page.evaluate(() => window.__coworkBrowserUnsupportedActions), [], "Returning to a selected task must not invoke absent background methods");
    await taskMenu.click();
    await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
    await taskRow.waitFor({ state: "detached" });

    await page.locator('.sidebar-rail button[aria-label^="Settings"]').click();
    await page.getByRole("button", { name: "Integrations", exact: true }).click();
    await page
      .getByRole("heading", {
        name: "This setting is unavailable on this browser host",
      })
      .waitFor({ state: "visible" });

    const settingsTabs = [
      "appearance",
      "personality",
      "system",
      "voice",
      "everydayAgent",
      "aimodels",
      "jev",
      "whatsapp",
      "telegram",
      "slack",
      "morechannels",
      "memory",
      "automations",
      "integrations",
      "customize",
      "skills",
      "mcp",
      "tools",
      "briefing",
      "access",
      "extensions",
      "insights",
      "pulse",
      "suggestions",
      "traces",
      "updates",
    ];
    for (const tab of settingsTabs) {
      const settingsTab = page.locator(`.settings-sidebar [data-tab="${tab}"]`);
      await settingsTab.click();
      assert.match(
        (await settingsTab.getAttribute("class")) ?? "",
        /\bactive\b/,
        `Settings tab ${tab} should become active when clicked`,
      );
      await page.waitForFunction(() => !document.querySelector(".settings-loading"), null, {
        timeout: 5_000,
      });
      const content = (await page.locator(".settings-content").innerText()).trim();
      assert(
        content.length > 0,
        `Settings tab ${tab} should show content or an availability reason`,
      );
      if (tab === "insights") {
        await page.getByRole("heading", { name: "Usage Insights", exact: true }).waitFor({
          state: "visible",
        });
      }
      const unsupportedInRoute = await page.evaluate(
        () => window.__coworkBrowserUnsupportedActions,
      );
      assert.deepEqual(
        unsupportedInRoute,
        [],
        `Settings tab ${tab} invoked unsupported host actions: ${unsupportedInRoute.join(", ")}`,
      );
      await captureControls(`settings/${tab}`);
      await page.waitForTimeout(100);
    }

    for (const tab of ["aimodels", "automations", "skills", "access"]) {
      await page.locator(`.settings-sidebar [data-tab="${tab}"]`).click();
      const subtabs = page.locator(".settings-content .more-channels-tabs .more-channels-tab");
      const subtabCount = await subtabs.count();
      if (subtabCount === 0) {
        await page
          .getByRole("heading", { name: "This setting is unavailable on this browser host" })
          .waitFor({ state: "visible" });
        continue;
      }
      for (let index = 0; index < subtabCount; index += 1) {
        const subtab = subtabs.nth(index);
        const label = (await subtab.innerText()).trim();
        if (await subtab.isDisabled()) {
          assert(
            (await subtab.getAttribute("title"))?.trim(),
            `Unavailable ${tab} subtab ${label} should explain why it is disabled`,
          );
          continue;
        }
        await subtab.click();
        await page.waitForFunction(
          (label) =>
            Array.from(
              document.querySelectorAll(".settings-content .more-channels-tabs .more-channels-tab"),
            ).some(
              (element) =>
                element.textContent?.trim() === label && element.classList.contains("active"),
            ),
          label,
        );
        assert.match(
          (await subtab.getAttribute("class")) ?? "",
          /\bactive\b/,
          `Settings subtab ${tab}/${label} should become active when clicked`,
        );
        await captureControls(`settings/${tab}/${label}`);
        const unsupportedInSubtab = await page.evaluate(
          () => window.__coworkBrowserUnsupportedActions,
        );
        assert.deepEqual(
          unsupportedInSubtab,
          [],
          `Settings subtab ${tab}/${label} invoked unsupported host actions: ${unsupportedInSubtab.join(", ")}`,
        );
        if (tab === "automations" && label === "Scheduled Tasks") {
          await page.getByRole("button", { name: "New Scheduled Task", exact: true }).click();
          await page.getByPlaceholder("e.g., Daily AI News Report").waitFor({ state: "visible" });
          const scheduledName = `Browser UI smoke ${Date.now()}`;
          const updatedScheduledName = `${scheduledName} updated`;
          await page.getByPlaceholder("e.g., Daily AI News Report").fill(scheduledName);
          await page
            .getByPlaceholder("What should the agent do? Be specific about the task...")
            .fill("Disposable disabled job for browser UI interaction QA.");
          await page.getByRole("checkbox", { name: "Enable immediately after saving" }).uncheck();
          await page.getByRole("button", { name: "Create Task", exact: true }).click();
          try {
            await page.getByText(scheduledName, { exact: true }).waitFor({ state: "visible" });
          } catch (error) {
            const diagnostics = await page.evaluate(() => ({
              text: document.body.innerText.slice(-2_000),
              unsupported: window.__coworkBrowserUnsupportedActions,
            }));
            throw new Error(
              `Scheduled task was not visible after Save. UI: ${diagnostics.text}. Unsupported methods: ${diagnostics.unsupported.join(", ")}`,
              { cause: error },
            );
          }

          await page.getByText(scheduledName, { exact: true }).locator("..").locator("..").locator("..").locator('button[title="Edit"]').click();
          await page.getByPlaceholder("e.g., Daily AI News Report").fill(updatedScheduledName);
          await page.getByRole("button", { name: "Save Changes", exact: true }).click();
          await page.getByText(updatedScheduledName, { exact: true }).waitFor({ state: "visible" });

          const liveScheduledName = `${updatedScheduledName} live`;
          await page.evaluate(
            async ({ scheduledName, updatedName }) => {
              const jobs = await window.electronAPI.listCronJobs({ includeDisabled: true });
              const job = jobs.find((candidate) => candidate.name === scheduledName);
              if (!job) throw new Error("The host did not persist the edited scheduled task.");
              const result = await window.electronAPI.updateCronJob(job.id, { name: updatedName });
              if (!result?.ok)
                throw new Error(result?.error || "Could not update the live-refresh smoke job.");
            },
            { scheduledName: updatedScheduledName, updatedName: liveScheduledName },
          );
          await page.getByText(liveScheduledName, { exact: true }).waitFor({ state: "visible" });

          page.once("dialog", async (dialog) => await dialog.accept());
          await page.getByText(liveScheduledName, { exact: true }).locator("..").locator("..").locator("..").locator('button[title="Delete"]').click();
          await page.getByText(liveScheduledName, { exact: true }).waitFor({ state: "detached" });
          const unsupportedInScheduledTask = await page.evaluate(
            () => window.__coworkBrowserUnsupportedActions,
          );
          assert.deepEqual(
            unsupportedInScheduledTask,
            [],
            `Scheduled Task UI invoked unsupported host actions: ${unsupportedInScheduledTask.join(", ")}`,
          );
        }
      }
    }

    await page.locator('.settings-sidebar [data-tab="automations"]').click();
    await page.getByRole("button", { name: "Task Queue", exact: true }).click();
    await page
      .getByText("Maximum concurrent tasks:", { exact: true })
      .waitFor({ state: "visible" });
    const concurrencySlider = page.locator(".settings-slider").first();
    const originalConcurrency = Number(await concurrencySlider.inputValue());
    assert(
      Number.isInteger(originalConcurrency),
      "Queue settings should show its saved concurrency",
    );
    const changedDirection = originalConcurrency < 20 ? "ArrowRight" : "ArrowLeft";
    const restoreDirection = originalConcurrency < 20 ? "ArrowLeft" : "ArrowRight";
    await concurrencySlider.press(changedDirection);
    assert.notEqual(
      Number(await concurrencySlider.inputValue()),
      originalConcurrency,
      "The queue concurrency control should respond to user input",
    );
    await page.getByRole("button", { name: "Save Settings", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Queue settings saved." }).waitFor();
    await concurrencySlider.press(restoreDirection);
    assert.equal(
      Number(await concurrencySlider.inputValue()),
      originalConcurrency,
      "The smoke should restore the disposable queue setting after testing its control",
    );
    await page.getByRole("button", { name: "Save Settings", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Queue settings saved." }).waitFor();

    await page.locator('.settings-sidebar [data-tab="aimodels"]').click();
    await page.getByRole("button", { name: "AI Model", exact: true }).click();
    await page.getByRole("button", { name: "OpenAI Account or API", exact: true }).click();
    await page.getByRole("button", { name: "Sign in with ChatGPT (unofficial)", exact: true }).click();
    const accountSignIn = page.getByRole("button", { name: "Sign in with ChatGPT", exact: true });
    await accountSignIn.click();
    const accountLink = page.getByRole("link", { name: "Continue ChatGPT sign-in", exact: true });
    await accountLink.waitFor();
    assert.equal(new URL(await accountLink.getAttribute("href")).origin, "https://auth.openai.com");
    const signInStorage = await page.evaluate(() => sessionStorage.getItem("cowork-openai-sign-in"));
    assert.match(signInStorage, /^[a-f0-9-]{36}$/);
    await captureControls("settings/aimodels/chatgpt-sign-in");
    await page.getByRole("button", { name: "Cancel sign-in", exact: true }).click();
    await accountLink.waitFor({ state: "detached" });
    assert.equal(await accountSignIn.isDisabled(), false);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("cowork-openai-sign-in")), null);

    await page.locator('.settings-sidebar [data-tab="memory"]').click();
    await page.locator("#memory-workspace").selectOption(awarenessWorkspaceId);
    await page.getByRole("tab", { name: "What CoWork knows", exact: true }).click();
    const qaFact = "Disposable browser UI memory prefers blue notebooks";
    const correctedFact = "Disposable browser UI memory prefers green notebooks";
    const factInput = page.getByLabel("New memory", { exact: true });
    await factInput.fill(qaFact);
    await page.getByLabel("Where it applies", { exact: true }).selectOption("workspace");
    await page.locator(".memory-knowledge-add").getByRole("button", { name: "Add", exact: true }).click();
    const factRow = page.locator(".memory-knowledge-item").filter({ hasText: qaFact });
    await factRow.waitFor();
    const memoryWorkspace = await page.locator("#memory-workspace").inputValue();
    if (await factRow.getAttribute("data-entry-ref")) {
      // Memory folder on (the default): the fact is a line in the folder. Pin moves it to
      // MEMORY.md (its own section, no Pin toggle); edits and deletes act on that line.
      const folderTexts = async () =>
        page.evaluate(async (workspaceId) => {
          const report = await window.electronAPI.getMemoryRepoEntries({ workspaceId });
          return report.files.flatMap((file) => file.entries.map((entry) => `${file.path}: ${entry.text}`));
        }, memoryWorkspace);
      await factRow.getByRole("button", { name: "Pin", exact: true }).click();
      const pinnedRow = page.locator('[data-file="MEMORY.md"] .memory-knowledge-item').filter({ hasText: qaFact });
      await pinnedRow.waitFor();
      await pinnedRow.getByRole("button", { name: "Edit", exact: true }).click();
      await page.getByLabel("Edit memory", { exact: true }).fill(correctedFact);
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.getByLabel("Edit memory", { exact: true }).waitFor({ state: "detached" });
      const correctedRow = page.locator('[data-file="MEMORY.md"] .memory-knowledge-item').filter({ hasText: correctedFact });
      await correctedRow.waitFor();
      assert.equal(await factRow.count(), 0, "Correction must replace the old folder line");
      assert((await folderTexts()).includes(`MEMORY.md: ${correctedFact}`), "The corrected fact must be pinned in MEMORY.md");
      page.once("dialog", (dialog) => dialog.accept());
      await correctedRow.getByRole("button", { name: "Delete", exact: true }).click();
      await correctedRow.waitFor({ state: "detached" });
      assert(!(await folderTexts()).some((text) => text.includes(correctedFact)), "Delete must remove the folder line");
    } else {
      await factRow.getByRole("button", { name: "Pin", exact: true }).click();
      await factRow.getByRole("button", { name: "Pinned", exact: true }).waitFor();
      await factRow.getByRole("button", { name: "Edit", exact: true }).click();
      await page.getByLabel("Edit memory", { exact: true }).fill(correctedFact);
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.getByLabel("Edit memory", { exact: true }).waitFor({ state: "detached" });
      const correctedRow = page.locator(".memory-knowledge-item").filter({ hasText: correctedFact });
      await correctedRow.waitFor();
      assert.equal(await factRow.count(), 0, "Correction must replace the old active Memory Hub fact");
      const correctedId = await correctedRow.getAttribute("data-item-id");
      assert(correctedId);
      assert.equal((await page.evaluate(async ({workspaceId, id}) => window.electronAPI.getMemoryItem({workspaceId, id}), {workspaceId: memoryWorkspace, id: correctedId})).item.content, correctedFact);
      page.once("dialog", (dialog) => dialog.accept());
      await correctedRow.getByRole("button", { name: "Delete", exact: true }).click();
      await correctedRow.waitFor({ state: "detached" });
      assert(!(await page.evaluate(async (workspaceId) => window.electronAPI.listMemoryItems({workspaceId, statuses: ["active"], limit: 200}), memoryWorkspace)).items.some((item) => item.id === correctedId));
    }
    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    // The workspace kit, inspector and awareness details live under the collapsed Advanced.
    await page.locator("details.memory-settings-advanced > summary").click();
    await page.getByRole("button", { name: "Initialize", exact: true }).click();
    await page.waitForFunction(async (workspaceId) => (await window.electronAPI.getWorkspaceKitStatus(workspaceId)).hasKitDir, memoryWorkspace);
    await page.getByPlaceholder("New project id (e.g. website-redesign)").fill("disposable-kit-project");
    await page.getByRole("button", { name: "Create project", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('input[placeholder="New project id (e.g. website-redesign)"]')?.value === "");
    await page.getByRole("button", { name: "Open USER.md", exact: true }).click();
    await page.locator(".file-viewer-markdown").waitFor();
    await page.locator(".file-viewer-close-btn").click();
    await page.locator(".file-viewer-overlay").waitFor({ state: "detached" });
    const kitDb = new (await import("better-sqlite3")).default(path.join(profile, "cowork-os.db"));
    try {
      const kitWorkspacePath = kitDb.prepare("SELECT path FROM workspaces WHERE id = ?").get(memoryWorkspace).path;
      assert((await fs.readFile(path.join(kitWorkspacePath, ".cowork", "projects", "disposable-kit-project", "CONTEXT.md"), "utf8")).includes("## Goals"));
    } finally { kitDb.close(); }
    const retention = page.locator("#memory-retention");
    const originalRetention = await retention.inputValue();
    const changedRetention = originalRetention === "30" ? "90" : "30";
    await retention.selectOption(changedRetention);
    await page.waitForFunction(async ({ workspaceId, desired }) => (await window.electronAPI.getMemorySettings(workspaceId)).retentionDays === Number(desired), { workspaceId: memoryWorkspace, desired: changedRetention });
    await retention.selectOption(originalRetention);
    await page.waitForFunction(async ({ workspaceId, desired }) => (await window.electronAPI.getMemorySettings(workspaceId)).retentionDays === Number(desired), { workspaceId: memoryWorkspace, desired: originalRetention });
    // Delay a genuine workspace read, then navigate away before its reply arrives.
    const otherMemoryWorkspace = await page.locator("#memory-workspace option").evaluateAll((options, current) => options.map((option) => option.value).find((value) => value !== current), memoryWorkspace);
    assert(otherMemoryWorkspace, "Memory stale-reply acceptance requires two disposable workspaces");
    await page.evaluate((delayedWorkspace) => {
      const original = window.electronAPI.getMemorySettings;
      window.__memoryOriginalRead = original;
      window.electronAPI.getMemorySettings = async (workspaceId) => {
        const result = await original(workspaceId);
        if (workspaceId !== delayedWorkspace || window.__memoryDelayedRead) return result;
        return new Promise((resolve) => {
          window.__memoryDelayedRead = () => resolve({ ...result, retentionDays: 365 });
        });
      };
    }, otherMemoryWorkspace);
    try {
      await page.locator("#memory-workspace").selectOption(otherMemoryWorkspace);
      await page.waitForFunction(() => Boolean(window.__memoryDelayedRead));
      await page.locator("#memory-workspace").selectOption(memoryWorkspace);
      await retention.waitFor();
      assert.equal(await retention.inputValue(), originalRetention);
      await page.evaluate(() => window.__memoryDelayedRead());
      // Flush promise continuations and a rendered frame before checking the old reply.
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await retention.inputValue(), originalRetention, "A late reply from another workspace must not replace the current settings");
    } finally {
      await page.evaluate(() => {
        window.electronAPI.getMemorySettings = window.__memoryOriginalRead;
        window.__memoryDelayedRead?.();
        delete window.__memoryOriginalRead;
        delete window.__memoryDelayedRead;
      });
    }
    await page.getByRole("button", { name: "From another assistant", exact: true }).click();
    // Two-step copy/paste import dialog (categorized import, 0.5.60).
    const importDialog = page.getByRole("dialog", { name: "Import memory to CoWork" });
    await importDialog.getByLabel("Paste results below to add to CoWork's memory", { exact: true }).fill("- The disposable browser UI memory project uses green notebooks.");
    await importDialog.getByRole("button", { name: "Add to memory", exact: true }).click();
    await importDialog.getByRole("heading", { name: "Added to memory", exact: true }).waitFor();
    await page.getByRole("button", { name: "Close import popup", exact: true }).click();
    const persistedImport = await page.evaluate(async (workspaceId) => (await window.electronAPI.findImportedMemories({ workspaceId, limit: 50 })).find((memory) => memory.content.includes("green notebooks")), memoryWorkspace);
    assert(persistedImport, "The browser text import should persist in the selected workspace");
    await page.getByRole("button", { name: "Rebuild metadata (all workspaces)", exact: true }).click();
    await page.waitForFunction(async () => !(await window.electronAPI.getMemoryObservationBackfillStatus()).running);
    const importedDetail = await page.evaluate(async ({ workspaceId, memoryId }) => (await window.electronAPI.getMemoryObservationDetails({ workspaceId, ids: [memoryId] }))[0], { workspaceId: memoryWorkspace, memoryId: persistedImport.id });
    assert(importedDetail, "Imported memory metadata should be available for promotion");
    const searchInput = page.locator(".memory-inspector-search input");
    await searchInput.fill("green notebooks");
    await page.locator(".memory-inspector-search").getByRole("button", { name: "Search", exact: true }).click();
    await page.locator(".memory-inspector-results button").filter({ hasText: "green notebooks" }).first().click();
    await page.locator(".memory-observation-detail").getByRole("button", { name: "Promote", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Memory promoted to workspace knowledge." }).waitFor();
    await page.locator(".memory-layer-grid").waitFor({ state: "attached" });
    // With the memory folder on, a promotion is the user's line in the workspace's folder
    // file; with it off, a curated entry in the workspace's .cowork/MEMORY.md.
    const promotedFolder = await page.evaluate(async (workspaceId) => window.electronAPI.getMemoryRepoEntries({ workspaceId }), memoryWorkspace);
    if (promotedFolder.available) {
      assert(
        promotedFolder.files.some((file) => file.role === "workspace" && file.entries.some((entry) => entry.by === "user" && entry.text.includes(importedDetail.title))),
        "Browser promotion must persist in the workspace's memory folder file",
      );
    } else {
      const memoryFilesDb = new (await import("better-sqlite3")).default(path.join(profile, "cowork-os.db"));
      try {
        const workspacePath = memoryFilesDb.prepare("SELECT path FROM workspaces WHERE id = ?").get(memoryWorkspace).path;
        const knowledge = await fs.readFile(path.join(workspacePath, ".cowork", "MEMORY.md"), "utf8");
        assert(knowledge.includes(importedDetail.title), "Browser promotion must persist in the workspace memory file");
      } finally { memoryFilesDb.close(); }
    }


    await page.locator("#memory-workspace").selectOption(awarenessWorkspaceId);
    const privateMode = page.getByRole("switch", { name: "Awareness private mode", exact: true });
    const originalPrivateMode = await privateMode.isChecked();
    await privateMode.locator("..").click();
    await page.waitForFunction(async (desired) => (await window.electronAPI.getAwarenessConfig()).privateModeEnabled === desired, !originalPrivateMode);
    await privateMode.locator("..").click();
    await page.waitForFunction(async (desired) => (await window.electronAPI.getAwarenessConfig()).privateModeEnabled === desired, originalPrivateMode);
    const beliefRow = page.locator(".memory-settings-item").filter({ has: page.getByText("I prefer disposable awareness QA orange notebooks", { exact: true }) }).last();
    await beliefRow.getByRole("button", { name: "Confirm", exact: true }).click();
    await page.waitForFunction(async ({ workspaceId, beliefId }) => (await window.electronAPI.listAwarenessBeliefs(workspaceId)).find((belief) => belief.id === beliefId)?.promotionStatus === "confirmed", { workspaceId: awarenessWorkspaceId, beliefId: awarenessBeliefId });
    const awarenessDb = new (await import("better-sqlite3")).default(path.join(profile, "cowork-os.db"));
    const oldAwarenessPermissions = awarenessDb.prepare("SELECT permissions FROM workspaces WHERE id = ?").get(awarenessWorkspaceId).permissions;
    try {
      awarenessDb.prepare("UPDATE workspaces SET permissions = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse(oldAwarenessPermissions), delete: true }), awarenessWorkspaceId);
      await beliefRow.getByRole("button", { name: "Forget", exact: true }).click();
      await beliefRow.waitFor({ state: "detached" });
      assert(!(await page.evaluate(async (workspaceId) => window.electronAPI.listAwarenessBeliefs(workspaceId), awarenessWorkspaceId)).some((belief) => belief.id === awarenessBeliefId));
    } finally {
      awarenessDb.prepare("UPDATE workspaces SET permissions = ? WHERE id = ?").run(oldAwarenessPermissions, awarenessWorkspaceId);
      awarenessDb.close();
    }

    await captureControls("settings/memory/awareness-accepted");
    const unsupportedActions = await page.evaluate(() => window.__coworkBrowserUnsupportedActions);
    assert.deepEqual(
      unsupportedActions,
      [],
      `Browser UI invoked unsupported host subscriptions/actions: ${unsupportedActions.join(", ")}`,
    );
    assert.deepEqual(
      failures,
      [],
      `Browser UI emitted unsupported-action errors: ${failures.join("; ")}`,
    );
  } catch (error) {
    const diagnosticBase = path.resolve(process.env.COWORK_WEB_UI_DIAGNOSTIC_PATH || path.join(os.tmpdir(), "cowork-browser-ui-smoke-failure"));
    await fs.mkdir(path.dirname(diagnosticBase), { recursive: true });
    await page.screenshot({ path: `${diagnosticBase}.png`, fullPage: true }).catch(() => undefined);
    await fs.writeFile(`${diagnosticBase}.txt`, await page.locator("body").innerText().catch(() => "UI unavailable")).catch(() => undefined);
    throw error;
  } finally {
    await browser.close();
  }
}

async function main() {
  await fs.access(electronHost ? electronMainPath : daemonPath);
  await fs.access(daemonEntry);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert(Number.isSafeInteger(manifest.apiVersion));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-web-smoke-"));
  const profile = path.join(temp, "profile");
  const workspace = path.join(temp, "workspace");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "input.csv"), "name,value\nAda,7\n");
  await execFileAsync("git", ["init", "-q"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.name", "Browser Smoke"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.email", "smoke@example.invalid"], { cwd: workspace });
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
  const syntheticProvider = await startSyntheticOpenAIStub();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const hostEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/^COWORK_LLM_/i.test(name) &&
        !/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(name),
    ),
  );
  let child = spawn(
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
      detached: process.platform !== "win32",
    },
  );

  try {
    let token = electronHost
      ? await waitForElectronReady(child, { base, port, profile })
      : await waitForReady(child);
    // The installed Node launcher may rebuild the native SQLite binding before
    // it starts the host. Load it only after the launcher reports readiness.
    const Database = (await import("better-sqlite3")).default;
    const app = await fetch(`${base}/app/`);
    assert.equal(app.status, 200);
    let { cookie, session } = await pairBrowserSession({ base, port, token, manifest });
    assert.equal(session.apiVersion, manifest.apiVersion);
    assert.equal(session.capabilities["files.read"]?.available, true);
    assert.equal(session.capabilities["files.upload"]?.available, true);
    assert.equal(session.capabilities["tasks.followUp"]?.available, true);
    assert.equal(session.capabilities["tasks.cancel"]?.available, true);
    assert.equal(session.capabilities["terminal.attach"]?.available, true);
    assert.equal(session.capabilities["notifications.read"]?.available, true);
    assert.equal(session.capabilities["notifications.manage"]?.available, true);
    assert.equal(session.capabilities["git.read"]?.available, true);
    assert.equal(session.capabilities["git.write"]?.available, true);
    assert.equal(session.desktopMethods?.forkTaskSession?.mutation, true);
    let secondaryBrowserSession = await pairBrowserSession({ base, port, token, manifest });

    // Shared desktop controls must reach real services, including omitted positional arguments.
    const desktop = (name, args = [], operationKey, omittedArgs) =>
      rpc(
        base,
        cookie,
        session.csrfToken,
        manifest.apiVersion,
        `desktop.${name}`,
        { args, ...(omittedArgs ? { omittedArgs } : {}) },
        operationKey,
      );
    for (const name of [
      "getLLMSettings",
      "getGoogleWorkspaceSettings",
      "getMailboxSyncStatus",
      "listMailboxThreads",
      "previewMailboxMissionControlHandoff",
      "listMailboxMissionControlHandoffs",
      "createMailboxMissionControlHandoff",
      "updateMailboxCommitmentDetails",
      "updateMailboxCommitmentState",
      "generateMailboxDraft",
      "reclassifyMailboxAccount",
      "retryMailboxAction",
      "extractMailboxAttachmentText",
      "replyViaChannel",
      "createMailboxRule",
      "deleteMailboxRule",
      "createMailboxSchedule",
      "deleteMailboxSchedule",
      "createMailboxForward",
      "deleteMailboxForward",
      "runMailboxForward",
      "previewMailboxSavedViewSimilar",
      "createMailboxSavedView",
      "getPersonalityConfigV2",
      "getRelationshipStats",
      "listManagedAgents",
      "listRoutines",
      "listProfiles",
      "createWorkspace",
      "listPluginPacks",
      "togglePluginPack",
      "togglePluginPackSkill",
      "getQueueSettings",
      "saveQueueSettings",
      "updateTaskWorkspace",
      "resumeTask",
      "sendStepFeedback",
      "submitMessageFeedback",
      "findTeamRunByRootTask",
      "wrapUpTask",
      "wrapUpTeamRun",
      "respondToRoutineWorkflowApproval",
      "listRoutineWorkflowRunSteps",
      "listIntegrationMentionOptions",
      "listNotifications",
      "getUnreadNotificationCount",
      "markNotificationRead",
      "markAllNotificationsRead",
      "deleteNotification",
      "deleteAllNotifications",
      "addNotification",
    ]) {
      assert(session.desktopMethods?.[name], `${name} is missing from the browser method manifest`);
    }
    const settingsSnapshot = await desktop("getLLMSettings");
    assert.equal(typeof settingsSnapshot.revision, "string");
    const settings = settingsSnapshot.settings;
    assert.equal(typeof settings.providerType, "string");
    const syntheticProviderConfig = await desktop(
      "saveLLMSettings",
      [
        {
          set: [
            { path: ["providerType"], value: "openai-compatible" },
            { path: ["modelKey"], value: "synthetic-recovery-model" },
            { path: ["openaiCompatible", "baseUrl"], value: syntheticProvider.baseUrl },
            { path: ["openaiCompatible", "model"], value: "synthetic-recovery-model" },
          ],
          remove: [],
          replaceSecrets: [
            {
              path: ["openaiCompatible", "apiKey"],
              value: "synthetic-browser-qa-only",
            },
          ],
        },
        settingsSnapshot.revision,
      ],
      "synthetic-provider-config",
    );
    assert.equal(syntheticProviderConfig.success, true);
    const memoryWorkspaceId = session.activeWorkspaceId;
    assert.equal(typeof memoryWorkspaceId, "string");
    await seedMemoryApprovals(profile, memoryWorkspaceId, "browser-host-approval");
    assert.equal((await desktop("getMemoryWriteApprovalCount", [memoryWorkspaceId])).pending, 2);
    assert.equal((await desktop("listMemoryWriteApprovals", [{ workspaceId: memoryWorkspaceId, limit: 50 }])).length, 2);
    assert.equal((await desktop("approveMemoryWriteApproval", [{ workspaceId: memoryWorkspaceId, id: "browser-host-approval-approve" }], "approve-memory-01")).status, "applied");
    assert.equal((await desktop("approveMemoryWriteApproval", [{ workspaceId: memoryWorkspaceId, id: "browser-host-approval-approve" }], "approve-memory-01")).status, "applied");
    assert.equal((await desktop("rejectMemoryWriteApproval", [{ workspaceId: memoryWorkspaceId, id: "browser-host-approval-reject", reason: "Disposable host rejection" }], "reject-memory-01")).status, "rejected");
    assert.equal((await desktop("getMemoryWriteApprovalCount", [memoryWorkspaceId])).pending, 0);
    assert.equal((await desktop("getMemoryWriteApproval", ["browser-host-approval-approve"])).status, "applied");
    const kitHostWorkspace = await desktop("createWorkspace", [{ name: "Disposable kit host project", path: "" }], "kit-host-workspace-01");
    const initializedKit = await desktop("initWorkspaceKit", [{ workspaceId: kitHostWorkspace.id, mode: "missing" }], "kit-init-01");
    assert.equal(initializedKit.hasKitDir, true);
    assert.equal((await desktop("getWorkspaceKitStatus", [kitHostWorkspace.id])).hasKitDir, true);
    await desktop("initWorkspaceKit", [{ workspaceId: kitHostWorkspace.id, mode: "missing" }], "kit-init-02");
    const kitJobs = (await desktop("listCronJobs", [{ includeDisabled: true }])).filter((job) => job.workspaceId === kitHostWorkspace.id && job.name.startsWith("Kit:"));
    if (!kitHostWorkspace.id.startsWith("__temp_workspace__")) assert.equal(kitJobs.length, 3, "Repeated kit initialization must not duplicate scheduled jobs");
    assert.equal((await desktop("createWorkspaceKitProject", [{ workspaceId: kitHostWorkspace.id, projectId: "host-kit-project" }], "kit-project-01")).success, true);
    const memorySettings = await desktop("getMemorySettings", [memoryWorkspaceId]);
    const testRetention = memorySettings.retentionDays === 30 ? 90 : 30;
    await desktop("saveMemorySettings", [{ workspaceId: memoryWorkspaceId, settings: { retentionDays: testRetention } }], "memory-settings-save-01");
    assert.equal((await desktop("getMemorySettings", [memoryWorkspaceId])).retentionDays, testRetention);
    await desktop("saveMemorySettings", [{ workspaceId: memoryWorkspaceId, settings: { retentionDays: memorySettings.retentionDays } }], "memory-settings-restore-01");
    const memoryImport = await desktop("importMemoryFromText", [{ workspaceId: memoryWorkspaceId, provider: "Disposable QA", pastedText: "- The disposable browser memory QA project uses blue notebooks.", forcePrivate: true }], "memory-import-01");
    assert.equal(memoryImport.success, true);
    assert.equal(memoryImport.memoriesCreated, 1);
    const importedMemories = await desktop("findImportedMemories", [{ workspaceId: memoryWorkspaceId, limit: 20, offset: 0 }]);
    const importedMemory = importedMemories.find((memory) => memory.content.includes("blue notebooks"));
    assert(importedMemory);
    assert.equal((await desktop("getMemoryDetails", [[importedMemory.id]]))[0].workspaceId, memoryWorkspaceId);
    await desktop("rebuildMemoryObservationMetadata", [{ force: true }], "memory-backfill-01");
    const observation = (await desktop("getMemoryObservationDetails", [{ workspaceId: memoryWorkspaceId, ids: [importedMemory.id] }]))[0];
    assert(observation);
    await desktop("updateMemoryObservation", [{ workspaceId: memoryWorkspaceId, memoryId: importedMemory.id, patch: { title: "Disposable browser QA memory" } }], "memory-observation-update-01");
    assert.equal((await desktop("getMemoryObservationDetails", [{ workspaceId: memoryWorkspaceId, ids: [importedMemory.id] }]))[0].title, "Disposable browser QA memory");
    const promotedObservation = await desktop("promoteMemoryObservation", [{ workspaceId: memoryWorkspaceId, memoryId: importedMemory.id }], "memory-promote-01");
    assert.equal(promotedObservation.success, true);
    // With the memory folder on, the promotion is a line in a folder file (`ref`, `file`);
    // with it off, a curated entry.
    if (promotedObservation.entry) assert.equal(promotedObservation.entry.content, "Disposable browser QA memory");
    else assert.equal(typeof promotedObservation.ref, "string", "A folder promotion returns its line reference");
    const layerPreview = await desktop("getMemoryLayerPreview", [memoryWorkspaceId]);
    assert.equal(layerPreview.workspaceId, memoryWorkspaceId);
    assert(layerPreview.layers.length > 0, "Layer preview must contain authoritative host layers");
    const ignoredMemory = await desktop("setImportedMemoryPromptRecallIgnored", [{ workspaceId: memoryWorkspaceId, memoryId: importedMemory.id, ignored: true }], "memory-ignore-01");
    assert.equal(ignoredMemory.success, true);
    assert.match(ignoredMemory.memory.content, /prompt_recall=ignore/);
    const memoryPolicyDb = new Database(path.join(profile, "cowork-os.db"));
    const originalMemoryPermissions = memoryPolicyDb.prepare("SELECT permissions FROM workspaces WHERE id = ?").get(memoryWorkspaceId).permissions;
    try {
      const deniedMemoryPermissions = { ...JSON.parse(originalMemoryPermissions), delete: false };
      memoryPolicyDb.prepare("UPDATE workspaces SET permissions = ? WHERE id = ?").run(JSON.stringify(deniedMemoryPermissions), memoryWorkspaceId);
      assert.deepEqual(
        JSON.parse(memoryPolicyDb.prepare("SELECT permissions FROM workspaces WHERE id = ?").get(memoryWorkspaceId).permissions),
        deniedMemoryPermissions,
        "The denial check must read back the restricted workspace permission snapshot",
      );
      await assert.rejects(desktop("deleteImportedMemoryEntry", [{ workspaceId: memoryWorkspaceId, memoryId: importedMemory.id }], "memory-delete-denied-01"), /Workspace memory access is unavailable/);
      assert(
        (await desktop("findImportedMemories", [{ workspaceId: memoryWorkspaceId, limit: 20, offset: 0 }])).some((memory) => memory.id === importedMemory.id),
        "A refused deletion must preserve the imported memory",
      );
      const allowedMemoryPermissions = { ...JSON.parse(originalMemoryPermissions), delete: true };
      memoryPolicyDb.prepare("UPDATE workspaces SET permissions = ? WHERE id = ?").run(JSON.stringify(allowedMemoryPermissions), memoryWorkspaceId);
      assert.deepEqual(
        JSON.parse(memoryPolicyDb.prepare("SELECT permissions FROM workspaces WHERE id = ?").get(memoryWorkspaceId).permissions),
        allowedMemoryPermissions,
        "The allowed deletion check must read back delete authority",
      );
      assert.equal((await desktop("deleteImportedMemoryEntry", [{ workspaceId: memoryWorkspaceId, memoryId: importedMemory.id }], "memory-delete-01")).success, true);
      assert(
        !(await desktop("findImportedMemories", [{ workspaceId: memoryWorkspaceId, limit: 20, offset: 0 }])).some((memory) => memory.id === importedMemory.id),
        "An authorized deletion must remove the imported memory",
      );
    } finally {
      memoryPolicyDb.prepare("UPDATE workspaces SET permissions = ? WHERE id = ?").run(originalMemoryPermissions, memoryWorkspaceId);
      memoryPolicyDb.close();
    }
    // Global legacy profile mutations remain unavailable on the browser surface.
    // Exercise the current, workspace-authorized Memory Hub contract instead.
    await assert.rejects(desktop("addUserFact", [{ category: "preference", value: "Disposable browser QA prefers blue notebooks", source: "manual" }], "memory-legacy-fact-denied-01"), /unsupported|unknown|unavailable/i);
    const factResult = await desktop("addMemoryItem", [{ workspaceId: memoryWorkspaceId, kind: "preference", content: "Disposable browser QA prefers blue notebooks", scope: "workspace" }], "memory-fact-add-01");
    assert.equal(factResult.success, true);
    const factPolicyDb = new Database(path.join(profile, "cowork-os.db"));
    const originalFactPermissions = factPolicyDb.prepare("SELECT permissions FROM workspaces WHERE id = ?").get(memoryWorkspaceId).permissions;
    const setFactDeletePermission = (allowed) =>
      factPolicyDb.prepare("UPDATE workspaces SET permissions = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse(originalFactPermissions), delete: allowed }), memoryWorkspaceId);
    try {
      if (factResult.item) {
        // Memory folder off: the fact is a `memory_items` row.
        const fact = factResult.item;
        assert(fact.id);
        assert.equal(fact.workspaceId, memoryWorkspaceId);
        assert.equal(fact.source, "user_stated");
        assert((await desktop("listMemoryItems", [{ workspaceId: memoryWorkspaceId }])).items.some((entry) => entry.id === fact.id));
        assert.equal((await desktop("setMemoryItemPinned", [{ workspaceId: memoryWorkspaceId, id: fact.id, pinned: true }], "memory-fact-pin-01")).success, true);
        assert.equal((await desktop("getMemoryItem", [{ workspaceId: memoryWorkspaceId, id: fact.id }])).item.pinned, true);
        const updatedFact = await desktop("updateMemoryItem", [{ workspaceId: memoryWorkspaceId, id: fact.id, content: "Disposable browser QA prefers green notebooks" }], "memory-fact-update-01");
        assert.equal(updatedFact.success, true);
        assert.equal(updatedFact.item.content, "Disposable browser QA prefers green notebooks");
        setFactDeletePermission(false);
        await assert.rejects(desktop("deleteMemoryItem", [{ workspaceId: memoryWorkspaceId, id: updatedFact.item.id }], "memory-fact-delete-denied-01"), /Workspace memory access is unavailable/);
        assert.equal((await desktop("getMemoryItem", [{ workspaceId: memoryWorkspaceId, id: updatedFact.item.id }])).item.status, "active");
        setFactDeletePermission(true);
        assert.equal((await desktop("deleteMemoryItem", [{ workspaceId: memoryWorkspaceId, id: updatedFact.item.id }], "memory-fact-delete-01")).success, true);
        assert(!(await desktop("listMemoryItems", [{ workspaceId: memoryWorkspaceId, statuses: ["active"] }])).items.some((entry) => entry.id === updatedFact.item.id));
      } else {
        // Memory folder on (the default): the fact is a user line in the folder, returned as
        // `ref` with no item. Verify it through the folder APIs the Memory Hub uses.
        assert.match(factResult.ref ?? "", /^repo:.+#L\d+$/, "A folder write returns its line reference");
        const folderEntry = async (ref) => {
          const report = await desktop("getMemoryRepoEntries", [{ workspaceId: memoryWorkspaceId }]);
          assert.equal(report.available, true);
          return report.files.flatMap((file) => file.entries.map((entry) => ({ ...entry, role: file.role }))).find((entry) => entry.ref === ref);
        };
        const added = await folderEntry(factResult.ref);
        assert(added, "The added fact must be listed in the memory folder");
        assert.match(added.text, /blue notebooks/);
        assert.equal(added.by, "user");
        assert.equal(added.role, "workspace", "A workspace fact goes to the workspace's file");
        const pinned = await desktop("pinMemoryRepoEntry", [{ workspaceId: memoryWorkspaceId, ref: added.ref, hash: added.hash }], "memory-fact-pin-01");
        assert.equal(pinned.ok, true, pinned.error);
        const pinnedEntry = await folderEntry(pinned.ref);
        assert.equal(pinnedEntry?.role, "entry", "Pinning moves the fact to MEMORY.md");
        const updated = await desktop("updateMemoryRepoEntry", [{ workspaceId: memoryWorkspaceId, ref: pinnedEntry.ref, hash: pinnedEntry.hash, text: "Disposable browser QA prefers green notebooks" }], "memory-fact-update-01");
        assert.equal(updated.ok, true, updated.error);
        const updatedEntry = await folderEntry(updated.ref);
        assert.match(updatedEntry?.text ?? "", /green notebooks/);
        setFactDeletePermission(false);
        await assert.rejects(desktop("removeMemoryRepoEntry", [{ workspaceId: memoryWorkspaceId, ref: updatedEntry.ref, hash: updatedEntry.hash }], "memory-fact-delete-denied-01"), /Workspace memory access is unavailable/);
        assert.equal((await folderEntry(updatedEntry.ref))?.hash, updatedEntry.hash, "A refused deletion must keep the folder line");
        setFactDeletePermission(true);
        const removed = await desktop("removeMemoryRepoEntry", [{ workspaceId: memoryWorkspaceId, ref: updatedEntry.ref, hash: updatedEntry.hash }], "memory-fact-delete-01");
        assert.equal(removed.ok, true, removed.error);
        const remaining = await desktop("getMemoryRepoEntries", [{ workspaceId: memoryWorkspaceId }]);
        assert(!remaining.files.some((file) => file.entries.some((entry) => /green notebooks/.test(entry.text))), "An authorized deletion must remove the folder line");
      }
    } finally {
      factPolicyDb.prepare("UPDATE workspaces SET permissions = ? WHERE id = ?").run(originalFactPermissions, memoryWorkspaceId);
      factPolicyDb.close();
    }
    const googleWorkspaceSettings = await desktop("getGoogleWorkspaceSettings");
    assert.equal(typeof googleWorkspaceSettings.enabled, "boolean");
    assert.equal(typeof googleWorkspaceSettings.credentialsConfigured, "boolean");
    assert(
      !JSON.stringify(googleWorkspaceSettings).match(/accessToken|refreshToken|clientSecret/i),
    );
    const mailboxStatus = await desktop("getMailboxSyncStatus");
    assert.equal(typeof mailboxStatus.connected, "boolean");
    assert(Array.isArray(await desktop("listMailboxThreads", [{}])));
    assert.equal(await desktop("previewMailboxMissionControlHandoff", ["missing-thread"]), null);
    assert.deepEqual(await desktop("listMailboxMissionControlHandoffs", ["missing-thread"]), []);
    assert.equal((await desktop("getPersonalityConfigV2")).version, 2);
    assert.equal(typeof (await desktop("getRelationshipStats")).tasksCompleted, "number");
    assert(Array.isArray(await desktop("listManagedAgents")));
    assert(Array.isArray(await desktop("listRoutines")));
    assert(Array.isArray(await desktop("listIntegrationMentionOptions")));
    assert(Array.isArray(await desktop("listRoutineWorkflowRuns", [null, 60], undefined, [0])));
    const profiles = await desktop("listProfiles");
    assert.equal(profiles.filter((profile) => profile.isActive).length, 1);
    const originalQueueSettings = await desktop("getQueueSettings");
    const desiredQueueSettings = {
      ...originalQueueSettings,
      maxConcurrentTasks:
        originalQueueSettings.maxConcurrentTasks > 1
          ? originalQueueSettings.maxConcurrentTasks - 1
          : 2,
    };
    assert.deepEqual(
      await desktop("saveQueueSettings", [desiredQueueSettings], "browser-queue-save-01"),
      { success: true },
    );
    assert.deepEqual(await desktop("getQueueSettings"), desiredQueueSettings);
    assert.deepEqual(
      await desktop("saveQueueSettings", [desiredQueueSettings], "browser-queue-save-01"),
      { success: true },
    );
    await desktop("saveQueueSettings", [originalQueueSettings], "browser-queue-restore-01");
    assert.deepEqual(await desktop("getQueueSettings"), originalQueueSettings);
    const packs = await desktop("listPluginPacks");
    const testPack = packs.find(
      (pack) =>
        !pack.policyBlocked &&
        !pack.policyRequired &&
        pack.securityReport?.verdict !== "quarantined" &&
        pack.skills?.length > 0,
    );
    assert(testPack, "No installed pack is eligible for the disposable toggle test");
    const originalPackEnabled = testPack.enabled;
    const packToggleArgs = [testPack.name, !originalPackEnabled];
    const toggledPack = await desktop("togglePluginPack", packToggleArgs, "browser-pack-toggle-01");
    assert.equal(toggledPack.enabled, !originalPackEnabled);
    assert.equal(
      (await desktop("listPluginPacks")).find((pack) => pack.name === testPack.name)?.enabled,
      !originalPackEnabled,
    );
    assert.deepEqual(
      await desktop("togglePluginPack", packToggleArgs, "browser-pack-toggle-01"),
      toggledPack,
      "A same-key replay must not reverse the desired pack state",
    );
    await desktop(
      "togglePluginPack",
      [testPack.name, originalPackEnabled],
      "browser-pack-restore-01",
    );
    const testSkill = testPack.skills[0];
    const originalSkillEnabled = testSkill.enabled !== false;
    await desktop(
      "togglePluginPackSkill",
      [testPack.name, testSkill.id, !originalSkillEnabled],
      "browser-pack-skill-toggle-01",
    );
    assert.equal(
      (await desktop("listPluginPacks"))
        .find((pack) => pack.name === testPack.name)
        ?.skills.find((skill) => skill.id === testSkill.id)?.enabled,
      !originalSkillEnabled,
    );
    await desktop(
      "togglePluginPackSkill",
      [testPack.name, testSkill.id, originalSkillEnabled],
      "browser-pack-skill-restore-01",
    );
    const restoredPack = (await desktop("listPluginPacks")).find(
      (pack) => pack.name === testPack.name,
    );
    assert.equal(restoredPack?.enabled, originalPackEnabled);
    assert.equal(
      restoredPack?.skills.find((skill) => skill.id === testSkill.id)?.enabled,
      originalSkillEnabled,
    );
    const createArgs = [
      {
        name: "Browser controls project",
        path: "",
        permissions: { read: true, write: true, delete: true, network: true, shell: false },
      },
    ];
    const createdProject = await desktop(
      "createWorkspace",
      createArgs,
      "browser-control-project-01",
    );
    assert.equal(createdProject.name, "Browser controls project");
    assert.equal(createdProject.path, "");
    const projectDb = new Database(path.join(profile, "cowork-os.db"));
    try {
      const row = projectDb
        .prepare("SELECT permissions FROM workspaces WHERE id = ?")
        .get(createdProject.id);
      assert.equal(
        JSON.parse(row.permissions).shell,
        false,
        "Browser project creation must not grant shell access",
      );
    } finally {
      projectDb.close();
    }
    const replayedProject = await desktop(
      "createWorkspace",
      createArgs,
      "browser-control-project-01",
    );
    assert.equal(replayedProject.id, createdProject.id);

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
    const firstNotification = await desktop(
      "addNotification",
      [
        {
          type: "info",
          title: "Browser notification one",
          message: "A scoped host notification.",
          workspaceId: selected.id,
        },
      ],
      randomUUID(),
    );
    const secondNotification = await desktop(
      "addNotification",
      [{ type: "warning", title: "Browser notification two", message: "A profile notice." }],
      randomUUID(),
    );
    assert.equal(await desktop("getUnreadNotificationCount"), 2);
    assert(
      (await desktop("listNotifications")).some(
        (notification) => notification.id === firstNotification.id,
      ),
    );
    await desktop("markNotificationRead", [firstNotification.id], randomUUID());
    assert.equal(await desktop("getUnreadNotificationCount"), 1);
    await desktop("markAllNotificationsRead", [], randomUUID());
    assert.equal(await desktop("getUnreadNotificationCount"), 0);
    assert.equal(await desktop("deleteNotification", [firstNotification.id], randomUUID()), true);
    await desktop("deleteAllNotifications", [], randomUUID());
    assert.deepEqual(await desktop("listNotifications"), []);
    assert.equal(typeof secondNotification.id, "string");
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
    const gitStageKey = randomUUID();
    const stagedGitChange = await rpc(
      base,
      cookie,
      session.csrfToken,
      manifest.apiVersion,
      "git.stage",
      {
        workspaceId: selected.id,
        expectedRevision: gitStatus.revision,
        relativePaths: ["input.csv"],
      },
      gitStageKey,
    );
    assert.equal(stagedGitChange.outcome, "applied");
    const stagedGitStatus = await rpc(
      base,
      cookie,
      session.csrfToken,
      manifest.apiVersion,
      "git.status",
      { workspaceId: selected.id },
    );
    const commitRequest = {
      workspaceId: selected.id,
      expectedRevision: stagedGitStatus.revision,
      message: "Browser host smoke change",
    };
    const gitCommitKey = randomUUID();
    const gitCommit = await rpc(
      base,
      cookie,
      session.csrfToken,
      manifest.apiVersion,
      "git.commit",
      commitRequest,
      gitCommitKey,
    );
    assert.equal(gitCommit.outcome, "applied");
    assert.equal(typeof gitCommit.commitSha, "string");
    const gitCommitReplay = await rpc(
      base,
      cookie,
      session.csrfToken,
      manifest.apiVersion,
      "git.commit",
      commitRequest,
      gitCommitKey,
    );
    assert.equal(gitCommitReplay.outcome, "reconciled");
    assert.equal(gitCommitReplay.commitSha, gitCommit.commitSha);
    assert.equal(
      (
        await execFileAsync("git", ["rev-list", "--count", "HEAD"], { cwd: workspace })
      ).stdout.trim(),
      "2",
    );
    const postCommitGitStatus = await rpc(base, cookie, session.csrfToken, manifest.apiVersion, "git.status", { workspaceId: selected.id });
    assert.equal(postCommitGitStatus.stagedChanges, 0);
    assert(!postCommitGitStatus.files.some((file) => file.path === "input.csv"), "Committed CSV must no longer be dirty");
    const isGeneratedMemoryFile = (file) =>
      [".cowork/MEMORY.md", ".cowork/USER.md"].includes(file.path) ||
      /^\.cowork\/subconscious\/targets\/[A-Za-z0-9_-]+\/(?:backlog\.md|memory\.jsonl|state\.json)$/.test(file.path);
    assert(
      postCommitGitStatus.files.every((file) => isGeneratedMemoryFile(file) && file.untracked),
      `Only unrelated generated workspace memory files may remain untracked: ${JSON.stringify(postCommitGitStatus.files)}`,
    );

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
    const uploadedText = "uploaded from browser smoke\n";
    assert.equal(
      await dropHttpResponse(
        `${base}/api/web/v1/workspace-files/upload`,
        uploadHeaders,
        uploadedText,
      ),
      201,
      "The upload fixture must be committed before the client drops its response socket",
    );
    assert.equal(
      await fs.readFile(path.join(workspace, "browser-note.txt"), "utf8"),
      uploadedText,
    );
    const duplicateUpload = await fetch(`${base}/api/web/v1/workspace-files/upload`, {
      method: "POST",
      headers: uploadHeaders,
      body: "different content\n",
    });
    assert.equal(duplicateUpload.status, 409);

    // A real uploaded raster exercises the shared composer's scoped media wire
    // contract. This host has no model credential; acceptance is not inference.
    const visualBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6m0AAAAASUVORK5CYII=",
      "base64",
    );
    const visualUpload = await fetch(`${base}/api/web/v1/workspace-files/upload`, {
      method: "POST",
      headers: { ...uploadHeaders, "X-CoWork-Relative-Path": "browser-image.png" },
      body: visualBytes,
    });
    assert.equal(visualUpload.status, 201);

    const taskKey = randomUUID();
    const taskCreateParams = {
      title: "Browser artifact smoke task",
      prompt: "Inspect the disposable input.csv file.",
      workspaceId: selected.id,
      images: [
        {
          relativePath: "browser-image.png",
          mimeType: "image/png",
          filename: "browser-image.png",
          sizeBytes: visualBytes.length,
        },
      ],
    };
    assert.equal(
      await dropRpcResponse(
        base,
        cookie,
        session.csrfToken,
        manifest.apiVersion,
        "task.create",
        taskCreateParams,
        taskKey,
      ),
      200,
      "Task creation must cross admission before the synthetic client drops its response",
    );
    const admission = await rpc(
      base,
      cookie,
      session.csrfToken,
      manifest.apiVersion,
      "task.admission.get",
      { operationKey: taskKey },
    );
    assert.equal(admission.found, true, "Disposable task admission receipt was not recoverable");
    const taskId = admission.taskId;
    const taskCreateReplay = await rpc(
      base,
      cookie,
      session.csrfToken,
      manifest.apiVersion,
      "task.create",
      taskCreateParams,
      taskKey,
    );
    assert.equal(taskCreateReplay.taskId, taskId);
    assert.equal(taskCreateReplay.replayed, true, "Same-key retry must reuse the admitted task");
    const recoveryFixtures = seedRecoveryFixtures(Database, profile, selected.id);
    const followUpKey = randomUUID();
    const followUpParams = {
      taskId,
      workspaceId: selected.id,
      message: "Synthetic recovery acceptance: preserve the uploaded CSV and report that the request was received.",
      images: [
        {
          relativePath: "browser-image.png",
          mimeType: "image/png",
          filename: "browser-image.png",
          sizeBytes: visualBytes.length,
        },
      ],
    };
    assert.equal(
      await dropRpcResponse(
        base,
        cookie,
        session.csrfToken,
        manifest.apiVersion,
        "task.followUp",
        followUpParams,
        followUpKey,
      ),
      200,
      "The follow-up must have a durable admission receipt before the client disconnects",
    );
    const followUpReceipt = await rpc(
      base,
      cookie,
      session.csrfToken,
      manifest.apiVersion,
      "task.followUp.receipt",
      { taskId, workspaceId: selected.id, operationKey: followUpKey },
    );
    const followUpReplay = await rpc(
      base,
      cookie,
      session.csrfToken,
      manifest.apiVersion,
      "task.followUp",
      followUpParams,
      followUpKey,
    );
    assert.equal(followUpReceipt.found, true, `Follow-up receipt was unavailable: ${JSON.stringify(followUpReceipt)}`);
    assert.notEqual(followUpReceipt.state, "unavailable");
    assert.equal(followUpReplay.messageId, followUpReceipt.messageId);
    const receiptSeenInSecondTab = await rpc(
      base,
      secondaryBrowserSession.cookie,
      secondaryBrowserSession.session.csrfToken,
      manifest.apiVersion,
      "task.followUp.receipt",
      { taskId, workspaceId: selected.id, operationKey: followUpKey },
    );
    assert.equal(receiptSeenInSecondTab.messageId, followUpReceipt.messageId);
    const followUpRowsAcrossTabs = countFollowUpReceipts(
      Database,
      profile,
      taskId,
      followUpReceipt.messageId,
    );
    assert(followUpRowsAcrossTabs.length >= 1, "The follow-up receipt was not durably journaled");
    const syntheticTaskTerminal = () =>
      waitForTaskTerminal({
        base,
        cookie,
        csrfToken: session.csrfToken,
        apiVersion: manifest.apiVersion,
        taskId,
      });
    await syntheticTaskTerminal();
    // A follow-up admitted while the first turn runs is queued and drained after
    // that turn ends, so the first turn's completed status can be read before
    // the follow-up reaches the provider. Wait for the follow-up request itself,
    // then for the end of the turn that carried it.
    await syntheticProvider.waitForRequest(
      (request) => request.followUpMessageCopies > 0,
      30_000,
      () =>
        `No synthetic provider request contained the admitted follow-up outside recalled context: ${JSON.stringify(syntheticProvider.requests)}`,
    );
    await syntheticTaskTerminal();
    assert(
      syntheticProvider.requests.length >= 2,
      `Both the initial task and its follow-up must reach the local synthetic provider; calls=${syntheticProvider.requests.length}`,
    );
    const followUpProviderRequests = syntheticProvider.requests.filter(
      (request) => request.followUpMessageCopies > 0,
    );
    assert(
      followUpProviderRequests.every((request) => request.followUpMessageCopies === 1),
      `The synthetic provider transcript contains a duplicated follow-up input: ${JSON.stringify(followUpProviderRequests)}`,
    );
    const syntheticCompletionEvents = await rpc(
      base,
      cookie,
      session.csrfToken,
      manifest.apiVersion,
      "task.events.snapshot",
      { taskId, workspaceId: selected.id, limit: 100 },
    );
    assert(
      JSON.stringify(syntheticCompletionEvents.events).includes(
        "Synthetic recovery provider accepted this request",
      ),
      "The follow-up must finish through the local synthetic provider before host restart",
    );
    const followUpTimelineMessages = syntheticCompletionEvents.events.filter(
      (event) =>
        (event.type === "user_message" || event.legacyType === "user_message") &&
        event.payload?.messageId === followUpReceipt.messageId,
    );
    assert(
      followUpTimelineMessages.length >= 1,
      `The task timeline should project the admitted follow-up: ${JSON.stringify(followUpTimelineMessages)}`,
    );
    const followUpLifecycleStatuses = followUpTimelineMessages
      .map((event) => event.payload?.deliveryStatus || event.payload?.status)
      .filter((status) => typeof status === "string");
    assert(
      followUpLifecycleStatuses.length > 0 &&
        new Set(followUpLifecycleStatuses).size === followUpLifecycleStatuses.length,
      `Follow-up lifecycle projection should keep one row per distinct delivery status: ${JSON.stringify(followUpTimelineMessages)}`,
    );
    assert(
      followUpLifecycleStatuses.includes("accepted"),
      `The follow-up timeline should retain its accepted state: ${JSON.stringify(followUpTimelineMessages)}`,
    );
    const liveCancellationPrompt =
      "Synthetic cancellation acceptance: keep this provider request open until the task is canceled.";
    const liveCancellationCreateParams = {
      title: "Synthetic in-flight cancellation acceptance",
      prompt: liveCancellationPrompt,
      workspaceId: selected.id,
    };
    const liveCancellationAdmissionKey = randomUUID();
    assert.equal(
      await dropRpcResponse(
        base,
        cookie,
        session.csrfToken,
        manifest.apiVersion,
        "task.create",
        liveCancellationCreateParams,
        liveCancellationAdmissionKey,
      ),
      200,
      "The cancellation task must be admitted before the synthetic client drops its response",
    );
    const liveCancellationAdmission = await rpc(
      base,
      cookie,
      session.csrfToken,
      manifest.apiVersion,
      "task.admission.get",
      { operationKey: liveCancellationAdmissionKey },
    );
    assert.equal(liveCancellationAdmission.found, true);
    const liveCancellationTaskId = liveCancellationAdmission.taskId;
    const heldProviderRequest = await syntheticProvider.waitForRequest(
      (request) => request.heldForCancellation,
    );
    assert.equal(heldProviderRequest.holdTimedOut, false);
    const liveCancellationTask = await rpc(
      base,
      cookie,
      session.csrfToken,
      manifest.apiVersion,
      "task.get",
      { taskId: liveCancellationTaskId },
    );
    assert(
      ["planning", "executing"].includes(liveCancellationTask.task.status),
      `The task must remain active while the synthetic provider request is held: ${liveCancellationTask.task.status}`,
    );
    const liveCancellationParams = {
      taskId: liveCancellationTaskId,
      workspaceId: selected.id,
      expectedStatus: liveCancellationTask.task.status,
      expectedUpdatedAt: liveCancellationTask.task.updatedAt,
    };
    const liveCancellationKey = randomUUID();
    assert.equal(
      await dropRpcResponse(
        base,
        cookie,
        session.csrfToken,
        manifest.apiVersion,
        "task.cancel",
        liveCancellationParams,
        liveCancellationKey,
      ),
      200,
      "The active task must be canceled before the synthetic client drops its response",
    );
    const liveCancelledInSecondTab = await rpc(
      base,
      secondaryBrowserSession.cookie,
      secondaryBrowserSession.session.csrfToken,
      manifest.apiVersion,
      "task.get",
      { taskId: liveCancellationTaskId },
    );
    assert.equal(liveCancelledInSecondTab.task.status, "cancelled");
    const providerDisconnectDeadline = Date.now() + 5_000;
    while (!heldProviderRequest.providerConnectionClosed && Date.now() < providerDisconnectDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(
      heldProviderRequest.providerConnectionClosed,
      true,
      "Canceling the in-flight task must abort its blocked provider request",
    );
    const syntheticProviderRevision = (await desktop("getLLMSettings")).revision;
    await desktop(
      "resetLLMProviderCredentials",
      ["openai-compatible", syntheticProviderRevision],
      "synthetic-provider-reset",
    );
    const settingsAfterReset = await desktop("getLLMSettings");
    await desktop(
      "saveLLMSettings",
      [
        {
          set: [{ path: ["providerType"], value: settings.providerType }],
          remove:
            typeof settings.modelKey === "string"
              ? []
              : [["modelKey"]],
          replaceSecrets: [],
        },
        settingsAfterReset.revision,
      ],
      "synthetic-provider-restore-selection",
    );
    assert.equal(typeof taskId, "string");
    await desktop(
      "submitMessageFeedback",
      [
        {
          taskId,
          messageId: "browser-smoke-feedback",
          decision: "accepted",
          note: "I prefer disposable awareness QA orange notebooks",
        },
      ],
      "browser-message-feedback-01",
    );
    const feedbackEvents = await rpc(
      base,
      cookie,
      session.csrfToken,
      manifest.apiVersion,
      "task.events.snapshot",
      { taskId, workspaceId: selected.id, limit: 100 },
    );
    assert(
      feedbackEvents.events.some(
        (event) =>
          (event.type === "user_feedback" || event.legacyType === "user_feedback") &&
          event.payload?.messageId === "browser-smoke-feedback" &&
          event.payload?.reason === "I prefer disposable awareness QA orange notebooks",
      ),
      "Browser message feedback was not persisted to the task timeline",
    );
    const originalAwareness = await desktop("getAwarenessConfig");
    const changedTtl = originalAwareness.defaultTtlMinutes === 60 ? 90 : 60;
    await desktop("saveAwarenessConfig", [{ defaultTtlMinutes: changedTtl }], "awareness-config-change");
    assert.equal((await desktop("getAwarenessConfig")).defaultTtlMinutes, changedTtl);
    await desktop("saveAwarenessConfig", [{ defaultTtlMinutes: originalAwareness.defaultTtlMinutes }], "awareness-config-restore");
    let awarenessBelief;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      awarenessBelief = (await desktop("listAwarenessBeliefs", [selected.id])).find((belief) => belief.value.includes("orange notebooks"));
      if (awarenessBelief) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(awarenessBelief, "Task feedback must promote a real host awareness belief");
    await desktop("updateAwarenessBelief", [awarenessBelief.id, { confidence: 0.8 }], "awareness-belief-edit");
    assert.equal((await desktop("listAwarenessBeliefs", [selected.id])).find((belief) => belief.id === awarenessBelief.id).confidence, 0.8);
    const awarenessEvents = await desktop("listAwarenessEvents", [{ workspaceId: selected.id, limit: 20 }]);
    assert(awarenessEvents.some((event) => event.source === "feedback"));
    assert(awarenessEvents.every((event) => !("payload" in event)));
    assert((await desktop("getAwarenessSnapshot", [selected.id])).beliefs.some((belief) => belief.id === awarenessBelief.id));
    const awarenessPolicyDb = new Database(path.join(profile, "cowork-os.db"));
    const originalAwarenessPermissions = awarenessPolicyDb.prepare("SELECT permissions FROM workspaces WHERE id = ?").get(selected.id).permissions;
    try {
      const deniedAwarenessPermissions = { ...JSON.parse(originalAwarenessPermissions), delete: false };
      awarenessPolicyDb.prepare("UPDATE workspaces SET permissions = ? WHERE id = ?").run(JSON.stringify(deniedAwarenessPermissions), selected.id);
      assert.deepEqual(
        JSON.parse(awarenessPolicyDb.prepare("SELECT permissions FROM workspaces WHERE id = ?").get(selected.id).permissions),
        deniedAwarenessPermissions,
        "The awareness denial check must read back the restricted workspace permission snapshot",
      );
      await assert.rejects(desktop("deleteAwarenessBelief", [awarenessBelief.id], "awareness-delete-denied"), /FORBIDDEN|unavailable/);
      assert(
        (await desktop("listAwarenessBeliefs", [selected.id])).some((belief) => belief.id === awarenessBelief.id),
        "A refused awareness deletion must preserve the belief",
      );
    } finally {
      awarenessPolicyDb.prepare("UPDATE workspaces SET permissions = ? WHERE id = ?").run(originalAwarenessPermissions, selected.id);
      awarenessPolicyDb.close();
    }
    const terminalDb = new Database(path.join(profile, "cowork-os.db"));
    try {
      const mediaEvents = terminalDb
        .prepare(
          "SELECT payload FROM task_events WHERE task_id = ? AND COALESCE(legacy_type, type) = 'task_created'",
        )
        .all(taskId);
      assert.equal(mediaEvents.length, 1, "Media admission wrote duplicate task-created events");
      const mediaPayload = JSON.parse(mediaEvents[0].payload);
      assert.equal(mediaPayload.browserInitialAttachmentMessageId, "__task_initial_media__");
      assert.equal(mediaPayload.queuedAttachmentRefs.length, 1);
      const mediaRef = mediaPayload.queuedAttachmentRefs[0];
      assert.equal(mediaRef.mimeType, "image/png");
      const mediaRoot = path.join(profile, "runtime", "queued-attachments");
      const mediaManifest = JSON.parse(
        await fs.readFile(path.join(mediaRoot, `${mediaRef.key}.json`), "utf8"),
      );
      assert.equal(mediaManifest.taskId, taskId);
      assert.equal(mediaManifest.messageId, "__task_initial_media__");
      assert.equal(mediaManifest.sha256, createHash("sha256").update(visualBytes).digest("hex"));
      assert.deepEqual(await fs.readFile(path.join(mediaRoot, `${mediaRef.key}.png`)), visualBytes);
      const followUpEvents = countFollowUpReceipts(
        Database,
        profile,
        taskId,
        followUpReceipt.messageId,
      );
      assert(followUpEvents.length >= 1);
      assert(followUpEvents.every((event) => event.deliveryMode === "follow_up"));
      const followUpRefs = new Map(
        followUpEvents.flatMap((event) =>
          (Array.isArray(event.queuedAttachmentRefs) ? event.queuedAttachmentRefs : []).map(
            (ref) => [ref.key, ref],
          ),
        ),
      );
      assert.equal(followUpRefs.size, 1, "One logical follow-up should persist one deduplicated media snapshot");
      const followUpRef = [...followUpRefs.values()][0];
      const followUpManifest = JSON.parse(
        await fs.readFile(path.join(mediaRoot, `${followUpRef.key}.json`), "utf8"),
      );
      assert.equal(followUpManifest.taskId, taskId);
      assert.equal(followUpManifest.messageId, followUpReceipt.messageId);
      assert.equal(followUpManifest.sha256, createHash("sha256").update(visualBytes).digest("hex"));
      assert.deepEqual(await fs.readFile(path.join(mediaRoot, `${followUpRef.key}.png`)), visualBytes);
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
    const stoppedTerminal = await rpc(
      base,
      cookie,
      session.csrfToken,
      manifest.apiVersion,
      "terminal.stop",
      { ...terminalScope, attachmentId: reattachedTerminal.attachmentId },
      randomUUID(),
    );
    assert.equal(stoppedTerminal.status, "inactive");

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

    const branchTaskId = recoveryFixtures.branchTaskId;
    const forkArgs = [{ taskId: branchTaskId, branchLabel: "browser-smoke" }];
    const forkKey = randomUUID();
    const forkedTask = await rpc(
      base,
      cookie,
      session.csrfToken,
      manifest.apiVersion,
      "desktop.forkTaskSession",
      { args: forkArgs },
      forkKey,
    );
    assert.equal(typeof forkedTask.id, "string");
    assert.equal(forkedTask.prompt, "");
    assert.equal(JSON.stringify(forkedTask).includes("No provider execution"), false);
    const forkReplay = await rpc(
      base,
      cookie,
      session.csrfToken,
      manifest.apiVersion,
      "desktop.forkTaskSession",
      { args: forkArgs },
      forkKey,
    );
    assert.equal(forkReplay.id, forkedTask.id, "Fork operation replay created another task");

    const sideChatArgs = [{ taskId: branchTaskId, branchLabel: "side-chat", sideChat: true }];
    const sideChatKey = randomUUID();
    const sideChat = await rpc(
      base,
      cookie,
      session.csrfToken,
      manifest.apiVersion,
      "desktop.forkTaskSession",
      { args: sideChatArgs },
      sideChatKey,
    );
    assert.equal(sideChat.source, "side_chat");
    assert.equal(sideChat.prompt, "");
    const sideChatReplay = await rpc(
      base,
      cookie,
      session.csrfToken,
      manifest.apiVersion,
      "desktop.forkTaskSession",
      { args: sideChatArgs },
      sideChatKey,
    );
    assert.equal(sideChatReplay.id, sideChat.id, "Side-chat replay created another task");

    // A page refresh preserves the in-memory paired session. A process restart
    // deliberately invalidates those cookies, so recovery continues after re-pairing.
    const refreshedSession = await fetch(`${base}/api/web/v1/session/bootstrap`, {
      headers: { Cookie: cookie, Origin: base },
    });
    assert.equal(refreshedSession.status, 200);
    assert.equal((await refreshedSession.json()).csrfToken, session.csrfToken);

    await stopHost(child);
    child = spawn(
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
          COWORK_APPROVAL_PROMPTS: "on",
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    );
    token = electronHost
      ? await waitForElectronReady(child, { base, port, profile })
      : await waitForReady(child);
    const stalePrimarySession = await fetch(`${base}/api/web/v1/session/bootstrap`, {
      headers: { Cookie: cookie, Origin: base },
    });
    assert.equal(stalePrimarySession.status, 401, "Host restart should require a fresh browser pairing");
    ({ cookie, session } = await pairBrowserSession({ base, port, token, manifest }));
    secondaryBrowserSession = await pairBrowserSession({ base, port, token, manifest });

    const recoveredAdmission = await rpc(
      base,
      cookie,
      session.csrfToken,
      manifest.apiVersion,
      "task.admission.get",
      { operationKey: taskKey },
    );
    assert.equal(recoveredAdmission.found, true);
    assert.equal(recoveredAdmission.taskId, taskId);

    const recoveredFollowUp = await rpc(
      base,
      cookie,
      session.csrfToken,
      manifest.apiVersion,
      "task.followUp.receipt",
      { taskId, workspaceId: selected.id, operationKey: followUpKey },
    );
    assert.equal(recoveredFollowUp.found, true);
    assert.equal(recoveredFollowUp.messageId, followUpReceipt.messageId);
    const providerRequestsAtRestartRecovery = syntheticProvider.requests.length;
    const recoveredFollowUpReplay = await rpc(
      base,
      cookie,
      session.csrfToken,
      manifest.apiVersion,
      "task.followUp",
      followUpParams,
      followUpKey,
    );
    assert.equal(recoveredFollowUpReplay.messageId, followUpReceipt.messageId);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal(
      syntheticProvider.requests.length,
      providerRequestsAtRestartRecovery,
      "Same-key follow-up reconciliation after host restart must not dispatch another provider turn",
    );
    const followUpRowsAfterRestart = countFollowUpReceipts(
      Database,
      profile,
      taskId,
      followUpReceipt.messageId,
    );
    const recoveredCancel = await rpc(
      base,
      secondaryBrowserSession.cookie,
      secondaryBrowserSession.session.csrfToken,
      manifest.apiVersion,
      "task.cancel",
      liveCancellationParams,
      liveCancellationKey,
    );
    assert.equal(recoveredCancel.status, "cancelled");
    assert.equal(recoveredCancel.outcome, "observed_terminal");

    const approvalsAfterRestart = await rpc(
      base,
      cookie,
      session.csrfToken,
      manifest.apiVersion,
      "approval.list",
      { workspaceId: selected.id, limit: 50 },
    );
    const presentedApproval = approvalsAfterRestart.approvals.find(
      (row) => row.id === recoveryFixtures.approval.id,
    );
    assert(presentedApproval, "The recovery approval must be present in the post-restart list");
    assert.match(
      presentedApproval.revisionHash,
      /^[0-9a-f]{64}$/,
      "The listed approval must carry the revision shown to the reviewer",
    );
    const inputRequestsAfterRestart = await rpc(
      base,
      secondaryBrowserSession.cookie,
      secondaryBrowserSession.session.csrfToken,
      manifest.apiVersion,
      "input_request.list",
      { workspaceId: selected.id, limit: 50 },
    );
    assert(
      inputRequestsAfterRestart.inputRequests.some((row) => row.id === recoveryFixtures.inputRequest.id),
    );

    const approvalResponseParams = {
      approvalId: recoveryFixtures.approval.id,
      workspaceId: selected.id,
      taskId: recoveryFixtures.approval.taskId,
      expectedVersion: recoveryFixtures.approval.expectedVersion,
      expectedRevisionHash: presentedApproval.revisionHash,
      approved: false,
    };
    const approvalResponseKey = randomUUID();
    assert.equal(
      await dropRpcResponse(
        base,
        cookie,
        session.csrfToken,
        manifest.apiVersion,
        "approval.respond",
        approvalResponseParams,
        approvalResponseKey,
      ),
      200,
      "The approval decision must persist before the synthetic client drops its response",
    );
    const observedApproval = await rpc(
      base,
      secondaryBrowserSession.cookie,
      secondaryBrowserSession.session.csrfToken,
      manifest.apiVersion,
      "approval.get",
      {
        approvalId: recoveryFixtures.approval.id,
        workspaceId: selected.id,
        taskId: recoveryFixtures.approval.taskId,
        expectedVersion: recoveryFixtures.approval.expectedVersion,
        expectedRevisionHash: presentedApproval.revisionHash,
      },
    );
    assert.equal(observedApproval.approval.status, "denied");

    const inputResponseParams = {
      requestId: recoveryFixtures.inputRequest.id,
      workspaceId: selected.id,
      taskId: recoveryFixtures.inputRequest.taskId,
      expectedVersion: recoveryFixtures.inputRequest.expectedVersion,
      status: "submitted",
      answers: { output_format: { optionLabel: "Markdown" } },
    };
    const inputResponseKey = randomUUID();
    assert.equal(
      await dropRpcResponse(
        base,
        secondaryBrowserSession.cookie,
        secondaryBrowserSession.session.csrfToken,
        manifest.apiVersion,
        "input_request.respond",
        inputResponseParams,
        inputResponseKey,
      ),
      200,
      "The structured input answer must persist before the synthetic client drops its response",
    );
    const observedInput = await rpc(
      base,
      cookie,
      session.csrfToken,
      manifest.apiVersion,
      "input_request.get",
      {
        requestId: recoveryFixtures.inputRequest.id,
        workspaceId: selected.id,
        taskId: recoveryFixtures.inputRequest.taskId,
        expectedVersion: recoveryFixtures.inputRequest.expectedVersion,
      },
    );
    assert.equal(observedInput.inputRequest.status, "submitted");

    if (process.env.COWORK_WEB_UI_SMOKE === "1") {
      // Task execution can add private-path restrictions to its workspace. Give the
      // independent Git UI acceptance its own disposable repository and permissions.
      const gitUiWorkspace = path.join(temp, "git-ui-workspace");
      await fs.mkdir(gitUiWorkspace);
      await execFileAsync("git", ["init", "-q"], { cwd: gitUiWorkspace });
      await execFileAsync("git", ["config", "user.name", "Browser Smoke"], { cwd: gitUiWorkspace });
      await execFileAsync("git", ["config", "user.email", "smoke@example.invalid"], { cwd: gitUiWorkspace });
      await fs.writeFile(path.join(gitUiWorkspace, "ui-git-change.txt"), "A browser UI commit test.\n");
      await fs.writeFile(path.join(gitUiWorkspace, "browser-artifact.txt"), "An unrelated unstaged UI fixture.\n");
      const gitUiDb = new Database(path.join(profile, "cowork-os.db"));
      try {
        const { WorkspaceStore } = require("../../dist/daemon/electron/database/repositories.js");
        new WorkspaceStore(gitUiDb).create("Browser Git UI smoke workspace", gitUiWorkspace, {
          read: true, write: true, delete: false, shell: false, network: false,
        });
      } finally { gitUiDb.close(); }
      await runBrowserUiSmoke({ base, port, token, profile, awarenessWorkspaceId: selected.id, awarenessBeliefId: awarenessBelief.id });
      const committedByUi = await execFileAsync(
        "git",
        ["show", "--format=", "--name-only", "HEAD"],
        { cwd: gitUiWorkspace },
      );
      assert.equal(committedByUi.stdout.trim(), "ui-git-change.txt");
    }

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
      `Synthetic browser preview ${process.env.COWORK_WEB_UI_SMOKE === "1" ? "UI and host" : "host"} smoke passed on the ${electronHost ? "Electron" : "Node"} daemon: shared desktop service reads, workspace memory settings/import/observation/recall/deletion permissions, workspace Memory Hub fact edits and legacy global mutation denial, memory approval/rejection and replay, observation promotion and layer preview, kit initialization/project files/default-job deduplication, Inbox actions, host-backed notifications, queue settings save/replay/readback, installed pack/skill toggles and replay, project creation/replay, message feedback persistence, task wrap-up and side-chat methods, routine workflow methods, pairing, scoped files, verified image admission/persistence, Git status/diff/stage/commit replay, terminal detach/replay, upload/no-overwrite with dropped reply, task admission replay with dropped reply, follow-up attachment receipt replay across two sessions and a same-profile host restart using a local deterministic synthetic OpenAI-compatible stub (${syntheticProvider.requests.length} completion requests), approval/input decisions observed across sessions after restart, in-flight synthetic cancellation with provider abort, cancellation receipt replay after restart, artifact download/one-use handle, traversal denial, ${process.env.COWORK_WEB_UI_SMOKE === "1" ? "UI navigation and all Settings routes/subtabs, memory facts/retention/text-import/approval/rejection/promotion persistence, kit initialization/project/file viewing, and stale workspace replies, scheduled-task create/live-update/delete, queue-setting interaction/save/restore, project/agent/task/notification/Git actions, unavailable-action explanations, " : ""}logout. Synthetic acceptance does not establish real-model execution or installed-artifact parity.\n`,
    );
  } finally {
    try {
      await stopHost(child);
    } catch (error) {
      process.stderr.write(`Disposable host cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
    try {
      await syntheticProvider.close();
    } catch (error) {
      process.stderr.write(`Synthetic provider cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
    try {
      await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      process.stderr.write(`Disposable profile cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
