#!/usr/bin/env node
// Owns an isolated npm run dev profile. Only loopback servers and synthetic tasks are used.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const profile = await mkdtemp(path.join(tmpdir(), "cowork-queued-input-qa-"));
// Development AppearanceManager also synchronizes a checkout-local logging sidecar.
const devLogSettingsPath = path.join(process.cwd(), ".cowork/dev-log-settings.json");
const previousDevLogSettings = await readFile(devLogSettingsPath).catch(() => null);
const restoreDevLogSettings = async () => {
  if (previousDevLogSettings) await writeFile(devLogSettingsPath, previousDevLogSettings);
  else await rm(devLogSettingsPath, { force: true });
};
const workspacePath = `${profile}/workspace`;
await mkdir(workspacePath, { recursive: true });
const requests = [];
const held = [];
let holding = true;
const respond = (res, message = "Fixture response complete.") => {
  if (res.destroyed) return;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      id: "fixture-response",
      model: "runtime-fixture",
      choices: [
        { index: 0, finish_reason: "stop", message: { role: "assistant", content: message } },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  );
};
const server = createServer(async (req, res) => {
  if (req.url?.endsWith("/models")) {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "runtime-fixture" }] }));
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || "{}");
  requests.push(body);
  if (holding) held.push(res);
  else respond(res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
console.log(`Fixture provider bound to 127.0.0.1:${port}`);
const freePort = async () => {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
};
const debugPort = await freePort();
const devPort = await freePort();
const log = openSync(`${profile}/dev.log`, "w");
const child = spawn(process.execPath, ["scripts/dev_with_logs.mjs"], {
  cwd: process.cwd(),
  detached: true,
  env: {
    ...process.env,
    COWORK_USER_DATA_DIR: profile,
    COWORK_BACKGROUND_AUTOSTART: "0",
    COWORK_DEV_BRAND_APP: "0",
    COWORK_REMOTE_DEBUGGING_PORT: String(debugPort),
    COWORK_DEV_SERVER_PORT: String(devPort),
    ELECTRON_RUN_AS_NODE: "",
  },
  stdio: ["ignore", log, log],
});
closeSync(log);
const stopTestApp = async () => {
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  await restoreDevLogSettings();
};
let browser;
for (let attempt = 0; attempt < 120; attempt++) {
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    break;
  } catch {
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
if (!browser) {
  await stopTestApp();
  server.close();
  throw new Error(`Isolated Electron did not start; inspect ${profile}/dev.log`);
}
let page;
for (let attempt = 0; attempt < 120; attempt++) {
  page = browser
    .contexts()[0]
    .pages()
    .find((p) => p.url().startsWith(`http://127.0.0.1:${devPort}`));
  if (page) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!page) {
  await browser.close();
  await stopTestApp();
  server.close();
  throw new Error(`Renderer did not load; inspect ${profile}/dev.log`);
}
const taskIds = [];
const api = (name, ...args) =>
  page.evaluate(({ name, args }) => window.electronAPI[name](...args), { name, args });
const edit = (taskId, item, message) =>
  api("editQueuedTaskInput", {
    taskId,
    id: item.id,
    kind: item.kind,
    expectedMessage: item.message,
    expectedRevision: item.revision,
    message,
  });
const until = async (check, label) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
};
try {
  await page.waitForFunction(() => !!window.electronAPI?.getQueuedTaskInputs);
  const settings = await api("getAppearanceSettings");
  await api("saveAppearanceSettings", {
    ...settings,
    onboardingCompleted: true,
    disclaimerAccepted: true,
  });
  await api("saveLLMSettings", {
    providerType: "openai-compatible",
    modelKey: "runtime-fixture",
    openaiCompatible: { baseUrl: `http://127.0.0.1:${port}/v1`, model: "runtime-fixture" },
  });
  await api("saveQueueSettings", { maxConcurrentTasks: 1 });
  const workspace = await api("createWorkspace", {
    name: "Queued input acceptance",
    path: workspacePath,
    permissions: { read: true, write: true, shell: false, network: false },
  });
  const create = async (title, prompt) => {
    const task = await api("createTask", {
      title,
      prompt,
      workspaceId: workspace.id,
      agentConfig: {
        providerType: "openai-compatible",
        modelKey: "runtime-fixture",
        modelPinned: true,
        executionMode: "chat",
        conversationMode: "chat",
        interactionMode: { mode: "chat" },
      },
    });
    taskIds.push(task.id);
    return task;
  };
  const first = await create(
    "Active turn fixture",
    "Reply briefly to this synthetic acceptance message.",
  );
  await until(() => requests.length > 0, "provider holds the active turn");
  const running = await api("getTask", first.id);
  await assert.rejects(
    api("discardInterruptedTask", first.id, running.updatedAt),
    /changed or resumed/,
  );
  assert.notEqual((await api("getTask", first.id)).status, "cancelled");
  console.log("Real IPC: stale interrupted-turn discard refused without cancelling active work.");
  const queued = await create("Queued input fixture", "ORIGINAL_INITIAL_TEXT");
  await until(
    async () => (await api("getTask", queued.id)).status === "queued",
    "second task queued",
  );
  const [initial] = await api("getQueuedTaskInputs", queued.id);
  assert.equal(initial.kind, "initial");
  await edit(queued.id, initial, "EDITED_INITIAL_TEXT");
  assert.equal((await api("getTask", queued.id)).prompt, "EDITED_INITIAL_TEXT");
  const followUp = await api("sendMessage", first.id, "ORIGINAL_FOLLOW_UP", undefined, undefined, {
    messageId: "queued-edit-followup",
    deliveryMode: "follow_up",
    returnOnAccepted: true,
  });
  assert.equal(followUp.queued, true);
  const [pending] = await api("getQueuedTaskInputs", first.id);
  assert.equal(pending.message, "ORIGINAL_FOLLOW_UP");
  await edit(first.id, pending, "EDITED_FOLLOW_UP");
  await assert.rejects(edit(first.id, pending, "STALE_WINDOW_EDIT"), /another window/);
  console.log("Real IPC: initial prompt edit, follow-up edit and stale-window refusal passed.");
  await page.reload();
  await page.waitForFunction(() => !!window.electronAPI);
  await page.getByText("Active turn fixture", { exact: true }).first().click();
  const panel = page.getByRole("region", { name: "Queued messages" });
  await panel.getByText("EDITED_FOLLOW_UP", { exact: true }).waitFor();
  await panel.getByRole("button", { name: "Edit", exact: true }).click();
  await panel.getByRole("textbox", { name: "Edit queued message" }).fill("UI_EDITED_FOLLOW_UP");
  await panel.getByRole("button", { name: "Save queued message" }).click();
  await panel.getByText("UI_EDITED_FOLLOW_UP", { exact: true }).waitFor();
  await page.locator(".user-message").getByText("UI_EDITED_FOLLOW_UP", { exact: true }).waitFor();
  await page.screenshot({ path: `${profile}/queued-message.png` });
  holding = false;
  for (const res of held.splice(0)) respond(res);
  await until(
    () => requests.some((body) => JSON.stringify(body.messages).includes("UI_EDITED_FOLLOW_UP")),
    "provider receives edited follow-up",
  );
  await until(
    () => requests.some((body) => JSON.stringify(body.messages).includes("EDITED_INITIAL_TEXT")),
    "provider receives edited initial prompt",
  );
  assert.ok(!requests.some((body) => JSON.stringify(body.messages).includes("ORIGINAL_FOLLOW_UP")));
  assert.ok(
    !requests.some((body) => JSON.stringify(body.messages).includes("ORIGINAL_INITIAL_TEXT")),
  );
  await writeFile(
    `${profile}/acceptance.json`,
    JSON.stringify(
      {
        passed: true,
        providerBind: `127.0.0.1:${port}`,
        requests: requests.length,
        taskIds,
        checks: [
          "queued initial prompt",
          "queued follow-up",
          "stale revision",
          "stale interrupted-turn discard",
          "Desktop inline edit",
          "edited provider payload",
        ],
      },
      null,
      2,
    ),
  );
  console.log("Desktop inline editing and edited provider payloads passed.");
  console.log(`Acceptance evidence: ${profile}`);
} finally {
  await writeFile(`${profile}/provider-requests.json`, JSON.stringify(requests, null, 2));
  holding = false;
  for (const res of held.splice(0)) respond(res);
  for (const id of taskIds) await api("cancelTask", id).catch(() => {});
  await browser.close();
  await stopTestApp();
  await new Promise((resolve) => server.close(resolve));
}
