import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

// End-to-end check of the in-app browser workbench in the real Electron app, on a
// disposable profile against a local fixture site. No model is needed: the
// workbench is opened through the main-process service, and pages are driven
// through their guest webContents. Build Electron and React first:
//   npm run build:electron && npm run build:react && node scripts/qa/browser-workbench-smoke.mjs
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-browser-qa-"));
const workspaceDir = path.join(outputDir, "workspace");
await fs.mkdir(workspaceDir, { recursive: true });

const env = {
  ...process.env,
  NODE_ENV: "production",
  COWORK_USER_DATA_DIR: path.join(outputDir, "profile"),
  COWORK_DISABLE_OS_KEYCHAIN: "1",
  COWORK_IMPORT_ENV_SETTINGS: "0",
};
delete env.ELECTRON_RUN_AS_NODE;

/* ---------- fixture site ---------- */

const PAGE = (n) => `<!doctype html><html><head><title>Fixture ${n}</title></head>
<body style="font-family: sans-serif">
  <h1 id="heading">Fixture page ${n}</h1>
  <p>Find me: needle one, needle two, needle three.</p>
  <input id="field" placeholder="type here" />
  <p><a id="blank" href="/page?n=${n}-child" target="_blank">Open in a new tab</a></p>
  <p><button id="popup" onclick="window.open('/popup', 'auth', 'width=480,height=600')">Sign in with popup</button></p>
  <p><a id="download" href="/download">Download report</a></p>
  <div style="height: 3000px">tall</div>
  <script>
    window.__loadedAt = Date.now();
    window.addEventListener("message", (event) => { window.__popupResult = event.data; });
  </script>
</body></html>`;

const POPUP = `<!doctype html><html><head><title>Sign in</title></head><body>
  <p>Signing in…</p>
  <script>
    setTimeout(() => {
      if (window.opener) window.opener.postMessage("token-ok", "*");
      setTimeout(() => window.close(), 300);
    }, 300);
  </script>
</body></html>`;

// A form with unsaved changes: leaving asks first.
const UNSAVED = `<!doctype html><html><head><title>Unsaved form</title></head><body>
  <textarea id="draft"></textarea>
  <script>
    window.addEventListener("beforeunload", (event) => { event.preventDefault(); event.returnValue = ""; });
  </script>
</body></html>`;

const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/page") {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(PAGE(url.searchParams.get("n") || "1"));
  } else if (url.pathname === "/unsaved") {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(UNSAVED);
  } else if (url.pathname === "/popup") {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(POPUP);
  } else if (url.pathname === "/download") {
    response.writeHead(200, {
      "Content-Type": "text/plain",
      "Content-Disposition": 'attachment; filename="report.txt"',
    });
    response.end("TEST DATA report\n");
  } else {
    response.writeHead(404);
    response.end("not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const site = `http://127.0.0.1:${server.address().port}`;

/* ---------- app helpers ---------- */

const results = [];
let desktop;
let main;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function step(name, run) {
  const started = Date.now();
  try {
    const detail = await run();
    results.push({ name, ok: true, ms: Date.now() - started, ...(detail ? { detail } : {}) });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({
      name,
      ok: false,
      ms: Date.now() - started,
      error: String(error?.message || error),
    });
    console.log(`FAIL ${name}: ${error?.message || error}`);
    await main
      ?.screenshot({ path: path.join(outputDir, `fail-${results.length}.png`) })
      .catch(() => undefined);
  }
}

async function waitFor(check, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** Guest webContents of workbench tabs and popups. */
async function guests() {
  return desktop.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((contents) => !contents.isDestroyed())
      .filter(
        (contents) => contents.getType() === "webview" || contents.getURL().includes("/popup"),
      )
      .map((contents) => ({ id: contents.id, type: contents.getType(), url: contents.getURL() })),
  );
}

async function inGuest(id, code) {
  return desktop.evaluate(
    ({ webContents }, input) => webContents.fromId(input.id)?.executeJavaScript(input.code, true),
    { id, code },
  );
}

/** The guest showing exactly this path (and query), e.g. "/page?n=1" but not "/page?n=1-child". */
async function guestFor(pathAndQuery) {
  return waitFor(
    async () =>
      (await guests()).find((guest) => {
        try {
          const url = new URL(guest.url);
          return `${url.pathname}${url.search}` === pathAndQuery;
        } catch {
          return false;
        }
      }),
    `a page at ${pathAndQuery}`,
  );
}

async function navigateActiveTab(url) {
  const omnibox = main.getByLabel("Browser URL");
  await omnibox.click();
  await omnibox.fill(url);
  await omnibox.press("Enter");
}

const workbenchModule = `${root}/dist/electron/electron/browser/browser-workbench-service.js`;
const sessionManagerModule = `${root}/dist/electron/electron/browser/browser-session-manager.js`;

/** Select the task in the sidebar and open its browser from the title bar, as a user does. */
async function openWorkbench(taskTitle) {
  // Tasks created over IPC appear in the sidebar after a reload.
  if ((await main.getByText(taskTitle, { exact: true }).count()) === 0) {
    await main.reload();
    await main.waitForFunction(() => !!document.querySelector(".sidebar, .sidebar-rail"));
  }
  await main.getByText(taskTitle, { exact: true }).first().click();
  await main.getByRole("button", { name: "Open browser", exact: true }).click();
  await main.getByLabel("Browser URL").waitFor({ timeout: 20000 });
}

try {
  desktop = await electron.launch({ args: [root], cwd: root, env, timeout: 60000 });
  desktop
    .process()
    .stdout?.on("data", (data) => fs.appendFile(path.join(outputDir, "runtime.log"), data));
  desktop
    .process()
    .stderr?.on("data", (data) => fs.appendFile(path.join(outputDir, "runtime.log"), data));
  for (let attempt = 0; attempt < 240 && !main; attempt++) {
    main = desktop.windows().find((page) => page.url().includes("/renderer/index.html"));
    if (!main) await sleep(250);
  }
  if (!main) throw new Error("Main renderer did not load");
  await main.waitForFunction(() => typeof window.electronAPI?.createWorkspace === "function");
  await main.evaluate(() =>
    window.electronAPI.saveAppearanceSettings({
      onboardingCompleted: true,
      disclaimerAccepted: true,
    }),
  );
  // Downloads in this run go to the disposable workspace, never the user's Downloads folder.
  await main.evaluate(() =>
    window.electronAPI.saveBrowserSettings({ downloadLocation: "workspace" }),
  );
  await desktop.evaluate(({ shell }) => {
    shell.openExternal = async () => undefined;
  });
  await main.reload();
  await main.waitForFunction(() => !!document.querySelector(".sidebar, .sidebar-rail"));

  const permissions = { read: true, write: true, delete: false, network: true, shell: false };
  const workspace = await main.evaluate((input) => window.electronAPI.createWorkspace(input), {
    name: "Browser QA",
    path: workspaceDir,
    permissions,
  });
  const task = await main.evaluate((input) => window.electronAPI.createTask(input), {
    title: "Browser QA",
    prompt: "TEST DATA: browser workbench smoke test",
    workspaceId: workspace.id,
  });
  assert.ok(task?.id, "task created");

  await step("opens the workbench for a task and registers its first tab", async () => {
    await openWorkbench("Browser QA");
    await main.getByLabel("Browser URL").waitFor({ timeout: 20000 });
  });

  await step("typing a local dev server address loads it (user loopback allowance)", async () => {
    await navigateActiveTab(`${site}/page?n=1`);
    await guestFor("/page?n=1");
  });

  await step("three tabs keep their page state when switching", async () => {
    const first = await guestFor("/page?n=1");
    await inGuest(
      first.id,
      `document.querySelector("#field").value = "typed text"; window.scrollTo(0, 900); 1`,
    );
    const loadedAt = await inGuest(first.id, "window.__loadedAt");
    for (const n of [2, 3]) {
      await main.getByRole("button", { name: "New tab", exact: true }).click();
      await navigateActiveTab(`${site}/page?n=${n}`);
      await guestFor(`/page?n=${n}`);
    }
    await main.getByRole("tab", { name: /Fixture 1/ }).click();
    await sleep(400);
    const state = await inGuest(
      first.id,
      `({ value: document.querySelector("#field").value, scrollY: window.scrollY, loadedAt: window.__loadedAt })`,
    );
    assert.equal(state.value, "typed text");
    assert.ok(state.scrollY >= 800, `scroll kept (${state.scrollY})`);
    assert.equal(state.loadedAt, loadedAt, "page was not reloaded");
    const tabs = await desktop.evaluate(
      (_, input) => {
        const { getBrowserWorkbenchService } = process.mainModule.require(input.module);
        return getBrowserWorkbenchService().getTabs(input.taskId, "default");
      },
      { module: workbenchModule, taskId: task.id },
    );
    assert.equal(tabs.length, 3, `browser_tabs lists ${tabs.length}`);
    return { tabs: tabs.map((tab) => tab.title) };
  });

  await step("target=_blank opens a new workbench tab", async () => {
    const first = await guestFor("/page?n=1");
    await inGuest(first.id, `document.querySelector("#blank").click(); 1`);
    await guestFor("/page?n=1-child");
    await main.getByRole("tab", { name: /Fixture 1-child/ }).waitFor({ timeout: 10000 });
  });

  await step("a window.open sign-in popup reaches its opener and closes", async () => {
    await main.getByRole("tab", { name: /Fixture 1$/ }).click();
    const first = await guestFor("/page?n=1");
    await inGuest(first.id, `document.querySelector("#popup").click(); 1`);
    await waitFor(async () => inGuest(first.id, "window.__popupResult"), "the popup message");
    await waitFor(
      async () => !(await guests()).some((guest) => guest.url.endsWith("/popup")),
      "the popup to close",
    );
  });

  await step("sidebar and full view toggles keep the page loaded", async () => {
    const first = await guestFor("/page?n=1");
    await inGuest(first.id, "window.__marker = 42; 1");
    for (let index = 0; index < 5; index++) {
      const toFull = main.getByRole("button", { name: "Open browser workbench in full screen" });
      const toSidebar = main.getByRole("button", { name: "Exit full screen" });
      if (await toFull.isVisible().catch(() => false)) await toFull.click();
      else await toSidebar.click();
      await sleep(400);
    }
    const marker = await inGuest(first.id, "window.__marker");
    assert.equal(marker, 42, "page state survived mode changes");
  });

  await step("Cmd+F finds matches in the page", async () => {
    await main.getByLabel("Browser URL").click();
    await main.keyboard.press("Meta+f");
    const find = main.getByLabel("Find in page");
    await find.waitFor({ timeout: 5000 });
    await find.click();
    await find.fill("needle");
    const count = await waitFor(async () => {
      const text = await main.locator(".browser-workbench-findbar-count").textContent();
      return /of 3$/.test(text || "") ? text : null;
    }, "3 matches");
    await find.press("Escape");
    await main.keyboard.press("Escape");
    return { count };
  });

  await step("Cmd+= zooms the page and shows the zoom badge", async () => {
    await main.getByLabel("Browser URL").click();
    await main.keyboard.press("Meta+Equal");
    await main.locator(".browser-workbench-zoom-badge").waitFor({ timeout: 5000 });
    await main.locator(".browser-workbench-zoom-badge").click();
  });

  await step("a geolocation request prompts in the tab and Never allow is remembered", async () => {
    const first = await guestFor("/page?n=1");
    await inGuest(
      first.id,
      `navigator.geolocation.getCurrentPosition(() => { window.__geo = "ok"; }, (error) => { window.__geo = "denied:" + error.code; }); 1`,
    );
    const prompt = main.locator(".browser-workbench-permission");
    await prompt.waitFor({ timeout: 8000 });
    await prompt.getByRole("button", { name: "Never allow" }).click();
    await waitFor(async () => inGuest(first.id, "window.__geo"), "the denial");
    await inGuest(
      first.id,
      `window.__geo = null; navigator.geolocation.getCurrentPosition(() => { window.__geo = "ok"; }, () => { window.__geo = "denied-again"; }); 1`,
    );
    const again = await waitFor(async () => inGuest(first.id, "window.__geo"), "the second answer");
    assert.equal(again, "denied-again");
    assert.equal(await prompt.count(), 0, "no second prompt");
  });

  await step("a download is saved to the workspace and shown on the shelf", async () => {
    const first = await guestFor("/page?n=1");
    await inGuest(first.id, `document.querySelector("#download").click(); 1`);
    await main.locator(".browser-workbench-download.is-completed").waitFor({ timeout: 10000 });
    const saved = await fs.readFile(path.join(workspaceDir, "downloads", "report.txt"), "utf8");
    assert.match(saved, /TEST DATA report/);
  });

  await step("closing a tab with unsaved changes asks Leave site? first", async () => {
    await main.getByRole("button", { name: "New tab", exact: true }).click();
    await navigateActiveTab(`${site}/unsaved`);
    const page = await guestFor("/unsaved");
    // Once CoWork has used a tab its debugger owns the page's dialogs, so this
    // checks that path: attach it (as diagnostics do), and keep the test
    // driver's own dialog handling out of the way.
    const driverPage = await waitFor(
      async () =>
        desktop
          .context()
          .pages()
          .find((candidate) => candidate.url().endsWith("/unsaved")),
      "the page in the test driver",
    );
    driverPage.on("dialog", () => undefined);
    await desktop.evaluate(
      (_, input) =>
        process.mainModule
          .require(input.module)
          .getBrowserSessionManager()
          .getTabDiagnostics({ taskId: input.taskId, sessionId: "default", kind: "console" })
          .then(() => true),
      { module: sessionManagerModule, taskId: task.id },
    );
    // Chromium only honours beforeunload after the user interacted with the page.
    const interact = () =>
      desktop.evaluate(({ webContents }, id) => {
        const guest = webContents.fromId(id);
        guest.focus();
        for (const type of ["mouseDown", "mouseUp"]) {
          guest.sendInputEvent({ type, x: 20, y: 20, button: "left", clickCount: 1 });
        }
      }, page.id);
    // The native dialog can't be clicked from here: answer it in the main process.
    const answerWith = (choice) =>
      desktop.evaluate(({ dialog }, answer) => {
        globalThis.__leaveSiteAsked = [];
        dialog.showMessageBoxSync = (...args) => {
          globalThis.__leaveSiteAsked.push(args[args.length - 1]?.message);
          return answer;
        };
      }, choice);
    const closeActiveTab = () =>
      main
        .locator(".browser-workbench-tab-shell.is-active")
        .getByRole("button", { name: "Close tab" })
        .click();

    await interact();
    await sleep(300);
    await answerWith(1);
    await closeActiveTab();
    await sleep(1200);
    const asked = await desktop.evaluate(() => globalThis.__leaveSiteAsked);
    assert.deepEqual(asked, ["Leave site?"], "asked once");
    assert.ok(
      (await guests()).some((guest) => guest.url.endsWith("/unsaved")),
      "Stay keeps the tab and its page",
    );

    await interact();
    await sleep(300);
    await answerWith(0);
    await closeActiveTab();
    await waitFor(
      async () => !(await guests()).some((guest) => guest.id === page.id),
      "the tab to close after Leave",
    );
  });

  await step(
    "alert and confirm are shown in the tab once CoWork's debugger is attached",
    async () => {
      await main.getByRole("tab", { name: /Fixture 1$/ }).click();
      const first = await guestFor("/page?n=1");
      // Keep the test driver's own dialog handling out of the way, then attach
      // CoWork's debugger (as diagnostics and agent actions do).
      const driverPage = await waitFor(
        async () =>
          desktop
            .context()
            .pages()
            .find((candidate) => candidate.url().endsWith("/page?n=1")),
        "the page in the test driver",
      );
      driverPage.on("dialog", () => undefined);
      await desktop.evaluate(
        (_, input) =>
          process.mainModule
            .require(input.module)
            .getBrowserSessionManager()
            .getTabDiagnostics({ taskId: input.taskId, sessionId: "default", kind: "console" })
            .then(() => true),
        { module: sessionManagerModule, taskId: task.id },
      );
      const dialog = main.locator(".browser-workbench-page-dialog");

      await inGuest(
        first.id,
        `setTimeout(() => { window.__confirmed = confirm("Delete this draft?"); }, 0); 1`,
      );
      await dialog.waitFor({ timeout: 8000 });
      await dialog.getByText("Delete this draft?").waitFor();
      await main.screenshot({ path: path.join(outputDir, "page-dialog.png") });
      await dialog.getByRole("button", { name: "OK" }).click();
      assert.equal(
        await waitFor(async () => inGuest(first.id, "window.__confirmed"), "the confirm answer"),
        true,
      );

      await inGuest(
        first.id,
        `setTimeout(() => { window.__cancelled = confirm("Discard?"); }, 0); 1`,
      );
      await dialog.waitFor({ timeout: 8000 });
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await waitFor(
        async () => (await inGuest(first.id, "typeof window.__cancelled")) === "boolean",
        "the second confirm answer",
      );
      assert.equal(await inGuest(first.id, "window.__cancelled"), false);

      await inGuest(
        first.id,
        `setTimeout(() => { alert("Saved"); window.__alerted = true; }, 0); 1`,
      );
      await dialog.waitFor({ timeout: 8000 });
      await main.keyboard.press("Enter");
      await waitFor(
        async () => inGuest(first.id, "window.__alerted === true"),
        "the alert to close",
      );
      assert.equal(await dialog.count(), 0, "no dialog left");
    },
  );

  await step("a CoWork approval is answered over the tab instead of a dialog", async () => {
    await main.getByRole("tab", { name: /Fixture 1$/ }).click();
    const approval = {
      id: "qa-approval-1",
      taskId: task.id,
      type: "network_access",
      description: "Allow CoWork to use 127.0.0.1?",
      details: { kind: "browser_use_domain_access", origin: site, browserSessionId: "default" },
      status: "pending",
      requestedAt: Date.now(),
    };
    await desktop.evaluate(
      ({ BrowserWindow }, input) => {
        const now = Date.now();
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send("task:event", {
            id: "qa-approval-event",
            eventId: "qa-approval-event",
            taskId: input.taskId,
            type: "approval_requested",
            payload: { approval: input.approval },
            timestamp: now,
            ts: now,
            schemaVersion: 2,
          });
        }
      },
      { taskId: task.id, approval },
    );
    const card = main.locator(".browser-workbench-approval");
    await card.waitFor({ timeout: 8000 });
    assert.equal(await main.locator(".browser-use-approval-overlay").count(), 0, "no dialog too");
    await main.screenshot({ path: path.join(outputDir, "approval.png") });
    await card.getByRole("button", { name: "Deny", exact: true }).click();
    // The daemon never created this approval, so it can't resolve it: end it the
    // way the daemon does, and the card must go away.
    await sleep(800);
    const cardAfterDeny = await card.count();
    await desktop.evaluate(
      ({ BrowserWindow }, input) => {
        const now = Date.now();
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send("task:event", {
            id: "qa-approval-denied",
            eventId: "qa-approval-denied",
            taskId: input.taskId,
            type: "approval_denied",
            payload: { approvalId: "qa-approval-1", action: "deny_once" },
            timestamp: now,
            ts: now,
            schemaVersion: 2,
          });
        }
      },
      { taskId: task.id },
    );
    await waitFor(async () => (await card.count()) === 0, "the card to clear");
    return { cardAfterDeny };
  });

  await step("closing and reopening the workbench restores its tabs", async () => {
    await main.getByRole("button", { name: "Close browser workbench" }).click();
    await waitFor(async () => (await guests()).length === 0, "the webviews to close");
    await openWorkbench("Browser QA");
    await guestFor("/page?n=1");
    await guestFor("/page?n=3");
  });

  await step(
    "a link to a local server the user has not opened shows a blocked notice",
    async () => {
      // Loopback allowances are per origin: another port on 127.0.0.1 stays closed
      // until the user opens it, so the page's link is refused with a reason.
      await main.getByRole("tab", { name: /Fixture 1$/ }).click();
      const first = await guestFor("/page?n=1");
      await inGuest(first.id, `location.href = "http://127.0.0.1:9/other"; 1`);
      await main.getByText("Local page not opened").waitFor({ timeout: 10000 });
      await main.screenshot({ path: path.join(outputDir, "blocked.png") });
      await main
        .getByRole("button", { name: "Go back" })
        .click()
        .catch(() => undefined);
    },
  );

  await main.screenshot({ path: path.join(outputDir, "final.png") });
} finally {
  await fs.writeFile(path.join(outputDir, "results.json"), JSON.stringify(results, null, 2));
  await desktop?.close().catch(() => undefined);
  server.close();
  const failed = results.filter((result) => !result.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed. Output: ${outputDir}`,
  );
  if (failed.length > 0) process.exitCode = 1;
}
