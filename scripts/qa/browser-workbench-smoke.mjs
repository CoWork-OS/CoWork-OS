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
// BROWSER_ENGINE=native runs the same checks on the native tab views (WebContentsView).
const engine = process.env.BROWSER_ENGINE === "native" ? "native" : "webview";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-browser-qa-"));
const workspaceDir = path.join(outputDir, "workspace");
await fs.mkdir(workspaceDir, { recursive: true });

const env = {
  ...process.env,
  NODE_ENV: "production",
  COWORK_USER_DATA_DIR: path.join(outputDir, "profile"),
  // QA_OS_KEYCHAIN=1 uses the real keychain, which the saved-login fill check needs.
  COWORK_DISABLE_OS_KEYCHAIN: process.env.QA_OS_KEYCHAIN === "1" ? "0" : "1",
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
  } else if (url.pathname === "/echo") {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end(
      JSON.stringify({
        userAgent: request.headers["user-agent"] || "",
        secChUa: request.headers["sec-ch-ua"] || "",
      }),
    );
  } else if (url.pathname === "/login") {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(
      `<!doctype html><html><head><title>Sign in</title></head><body><form><input id="user" name="user" autocomplete="username"><input id="pass" type="password" name="pass" autocomplete="current-password"></form></body></html>`,
    );
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
    await windowCapture(`fail-window-${results.length}`).catch(() => undefined);
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
      // Webview tabs, and native tab views and popups (both report "window"); the app's
      // own window is the file:// renderer.
      .filter((contents) => {
        const url = contents.getURL();
        return (
          contents.getType() === "webview" ||
          (contents.getType() === "window" && /^(https?:|about:blank)/.test(url))
        );
      })
      .map((contents) => ({ id: contents.id, type: contents.getType(), url: contents.getURL() })),
  );
}

/**
 * A real capture of the app window (macOS). The test driver's screenshots show only the
 * app's own page, so native tab views (drawn by the window, not the page) need this.
 */
async function windowCapture(name) {
  if (process.platform !== "darwin") return;
  const sourceId = await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().startsWith("file:"))
      ?.getMediaSourceId(),
  );
  if (process.env.QA_DEBUG_VIEWS) {
    console.log(
      "DEBUG views",
      name,
      JSON.stringify(
        await desktop.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows().find((w) =>
            w.webContents.getURL().startsWith("file:"),
          );
          return window.contentView.children.map((view) => ({
            bounds: view.getBounds(),
            visible: view.getVisible?.(),
            url: view.webContents?.getURL?.(),
          }));
        }),
      ),
    );
  }
  const windowNumber = Number(String(sourceId || "").split(":")[1]);
  if (!windowNumber) return;
  const { execFileSync } = await import("node:child_process");
  try {
    execFileSync("screencapture", [
      "-x",
      "-o",
      `-l${windowNumber}`,
      path.join(outputDir, `${name}.png`),
    ]);
  } catch {
    // Screen recording not allowed for the terminal: skip the capture.
  }
}

async function inGuest(id, code) {
  return desktop.evaluate(
    ({ webContents }, input) => webContents.fromId(input.id)?.executeJavaScript(input.code, true),
    { id, code },
  );
}

/** The guest showing exactly this path (and query), e.g. "/page?n=1" but not "/page?n=1-child". */
async function guestFor(pathAndQuery) {
  try {
    return await waitFor(
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
  } catch (error) {
    // Name every page there is, to tell a missing page from an unrecognised one.
    const all = await desktop.evaluate(({ webContents }) =>
      webContents
        .getAllWebContents()
        .filter((contents) => !contents.isDestroyed())
        .map((contents) => `${contents.getType()} ${contents.getURL().slice(0, 80)}`),
    );
    throw new Error(`${error.message} (pages: ${all.join(" | ")})`);
  }
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

// An organization policy for the in-app browser: developer mode locked off, camera blocked.
await fs.mkdir(env.COWORK_USER_DATA_DIR, { recursive: true });
await fs.writeFile(
  path.join(env.COWORK_USER_DATA_DIR, "policies.json"),
  JSON.stringify({ browser: { developerMode: "off", blockedSitePermissions: ["camera"] } }),
);

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
  await main.evaluate(
    (browserEngine) => window.electronAPI.saveBrowserSettings({ browserEngine }),
    engine,
  );
  console.log(`Browser engine: ${engine}`);

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
    await sleep(1500);
    await windowCapture("window-tab-page");
    assert.equal(tabs.length, 3, `browser_tabs lists ${tabs.length}`);
    return { tabs: tabs.map((tab) => tab.title) };
  });

  await step("target=_blank opens a new workbench tab", async () => {
    const first = await guestFor("/page?n=1");
    await inGuest(first.id, `document.querySelector("#blank").click(); 1`);
    await guestFor("/page?n=1-child");
    await main.getByRole("tab", { name: /Fixture 1-child/ }).waitFor({ timeout: 10000 });
    await sleep(1000);
    await windowCapture("window-new-tab-page");
  });

  await step("annotating picks the element under the pointer", async () => {
    // On the native engine the layer sits over a still image of the page.
    await main.getByRole("tab", { name: /Fixture 1-child/ }).click();
    await main.getByRole("button", { name: "Annotate page element" }).click();
    const layer = main.locator(".browser-live-annotation-layer");
    await layer.waitFor({ timeout: 5000 });
    await sleep(500);
    await layer.click({ position: { x: 80, y: 32 } });
    const meta = main.locator(".browser-live-annotation-meta");
    await meta.waitFor({ timeout: 8000 });
    assert.match(await meta.innerText(), /h1/i);
    await windowCapture("window-annotating");
    await main.getByRole("button", { name: "Annotate page element" }).click();
    await waitFor(async () => (await layer.count()) === 0, "annotation mode to end");
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
      if (await toSidebar.isVisible().catch(() => false)) {
        // Full view is the browser alone: no follow-up box or turn panel over the page.
        assert.equal(
          await main.locator(".browser-workbench .spreadsheet-viewer-composer").count(),
          0,
        );
      }
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

  await step(
    "an admin policy locks developer mode and blocks the camera without a prompt",
    async () => {
      const settings = await main.evaluate(() => window.electronAPI.getBrowserSettings());
      assert.equal(settings.policy?.developerModeLocked, true);
      assert.equal(settings.developerMode, false);
      assert.deepEqual(settings.policy?.blockedSitePermissions, ["camera"]);
      await main.getByRole("tab", { name: /Fixture 1$/ }).click();
      const first = await guestFor("/page?n=1");
      await inGuest(
        first.id,
        `navigator.mediaDevices.getUserMedia({ video: true }).then(() => { window.__camera = "ok"; }, (error) => { window.__camera = "err:" + error.name; }); 1`,
      );
      const camera = await waitFor(
        async () => inGuest(first.id, "window.__camera"),
        "the camera answer",
      );
      assert.match(camera, /^err:/);
      assert.equal(await main.locator(".browser-workbench-permission").count(), 0, "no prompt");
      return { camera };
    },
  );

  await step("notifications can be allowed for a site from the profile menu", async () => {
    const first = await guestFor("/page?n=1");
    assert.equal(await inGuest(first.id, "Notification.permission"), "denied");
    await main.getByRole("button", { name: "Browser profile" }).click();
    await main.getByLabel(/Notifications from/).selectOption("allow");
    await sleep(300);
    await inGuest(first.id, "location.reload(); 1").catch(() => undefined);
    const reloaded = await waitFor(async () => {
      const guest = (await guests()).find((candidate) => candidate.url.endsWith("/page?n=1"));
      if (!guest) return null;
      const state = await inGuest(
        guest.id,
        "document.readyState + ':' + Notification.permission",
      ).catch(() => null);
      return state === "complete:granted" ? state : null;
    }, "the site to see notifications as granted");
    assert.equal(reloaded, "complete:granted");
    await main.keyboard.press("Escape");
  });

  if (process.env.QA_GOOGLE_SIGNIN) {
    // Reaches the real Google sign-in page (nothing is typed): it must show the sign-in form
    // rather than refusing the browser. Needs network access.
    await step(
      "Google's sign-in page loads in the in-app browser and offers the form",
      async () => {
        await main.getByRole("tab", { name: /Fixture 1$/ }).click();
        await navigateActiveTab("https://accounts.google.com/signin/v2/identifier?hl=en");
        const page = await waitFor(
          async () => (await guests()).find((guest) => /accounts\.google\.com/.test(guest.url)),
          "Google's sign-in page",
          30000,
        );
        const state = await waitFor(
          async () => {
            const result = JSON.parse(
              await inGuest(
                page.id,
                `JSON.stringify({ email: !!document.querySelector('input[name="identifier"], input[type="email"], input[autocomplete="username"]'), text: document.body.innerText.slice(0, 400), webdriver: navigator.webdriver })`,
              ),
            );
            return result.email || /not secure|couldn.t sign you in|disallowed/i.test(result.text)
              ? result
              : null;
          },
          "the sign-in form",
          30000,
        );
        assert.equal(state.email, true, state.text);
        assert.doesNotMatch(state.text, /not secure|couldn.t sign you in|disallowed/i);
        await navigateActiveTab(`${site}/page?n=1`);
        await guestFor("/page?n=1");
        return { title: state.text.split("\n")[0], webdriver: state.webdriver };
      },
    );
  }

  if (process.env.QA_REAL_SCREEN_SHARE) {
    // Needs Screen Recording permission for the app (or the terminal that started it).
    await step(
      "sharing a real screen: real sources, pick one, the page gets a live video track",
      async () => {
        await main.getByRole("tab", { name: /Fixture 1$/ }).click();
        const first = await guestFor("/page?n=1");
        await inGuest(
          first.id,
          `navigator.mediaDevices.getDisplayMedia({ video: true }).then((stream) => { window.__stream = stream; const t = stream.getVideoTracks()[0]; window.__share = "ok:" + t.readyState + ":" + (t.getSettings().width || 0); }, (e) => { window.__share = "err:" + e.name; }); 1`,
        );
        const picker = main.getByRole("dialog", { name: "Choose what to share" });
        await picker.waitFor({ timeout: 10000 });
        const options = await picker.getByRole("option").count();
        assert.ok(options > 0, "the picker lists real screens or windows");
        const hasThumbnail = await picker.locator("img").count();
        await windowCapture("window-real-screen-share");
        await picker.getByRole("option").first().click();
        await picker.getByRole("button", { name: "Share" }).click();
        const answer = await waitFor(
          async () => inGuest(first.id, "window.__share"),
          "the share answer",
        );
        assert.match(answer, /^ok:live:[1-9]/, answer);
        await inGuest(first.id, "window.__stream.getTracks().forEach((t) => t.stop()); 1");
        return { options, hasThumbnail, answer };
      },
    );
  }

  await step("a page asking to share the screen shows a source picker", async () => {
    await desktop.evaluate(({ desktopCapturer }) => {
      desktopCapturer.getSources = async () => [
        { id: "screen:1:0", name: "QA Screen", thumbnail: { toDataURL: () => "" } },
        { id: "window:2:0", name: "QA Window", thumbnail: { toDataURL: () => "" } },
      ];
    });
    await main
      .locator("body")
      .click({ position: { x: 5, y: 5 } })
      .catch(() => undefined);
    await main.getByRole("tab", { name: /Fixture 1$/ }).click();
    const first = await guestFor("/page?n=1");
    await inGuest(
      first.id,
      `navigator.mediaDevices.getDisplayMedia({ video: true }).then(() => { window.__share = "ok"; }, (error) => { window.__share = "err:" + error.name; }); 1`,
    );
    const picker = main.getByRole("dialog", { name: "Choose what to share" });
    await picker.waitFor({ timeout: 8000 });
    await picker.getByText("QA Screen").waitFor();
    await main.screenshot({ path: path.join(outputDir, "screen-share.png") });
    await picker.getByRole("button", { name: "Cancel" }).click();
    const answer = await waitFor(
      async () => inGuest(first.id, "window.__share"),
      "the share answer",
    );
    // Electron rejects a cancelled pick with AbortError (Chrome uses NotAllowedError).
    assert.match(answer, /^err:(NotAllowed|Abort)Error$/);
  });

  await step("the focused address bar draws a single frame", async () => {
    const omnibox = main.getByLabel("Browser URL");
    for (const calm of [false, true]) {
      await main.evaluate(
        (on) => document.documentElement.classList.toggle("visual-calm", on),
        calm,
      );
      await omnibox.click();
      const style = await omnibox.evaluate((input) => {
        const computed = getComputedStyle(input);
        return {
          border: computed.borderTopColor,
          shadow: computed.boxShadow,
          background: computed.backgroundColor,
        };
      });
      assert.equal(style.shadow, "none", `input shadow (calm: ${calm})`);
      assert.match(style.border, /rgba\(0, 0, 0, 0\)|transparent/, `input border (calm: ${calm})`);
      assert.match(
        style.background,
        /rgba\(0, 0, 0, 0\)|transparent/,
        `input fill (calm: ${calm})`,
      );
      if (calm) await main.screenshot({ path: path.join(outputDir, "omnibox-focus-calm.png") });
      await main.keyboard.press("Escape");
    }
    await main.evaluate(() => document.documentElement.classList.remove("visual-calm"));
  });

  await step("the More menu holds page size, screenshots and developer views", async () => {
    await main.getByRole("tab", { name: /Fixture 1$/ }).click();
    await main
      .locator(".browser-workbench-toolbar-menu")
      .getByRole("button", { name: "More" })
      .click();
    // Toolbar icons must actually render (an inherited rule once collapsed them to 0px).
    const iconWidths = await main.evaluate(() =>
      Array.from(
        document.querySelectorAll(
          ".browser-workbench-nav-controls button svg, .browser-workbench-toolbar-menu > button svg",
        ),
      ).map((svg) => svg.getBoundingClientRect().width),
    );
    assert.ok(iconWidths.length >= 4 && iconWidths.every((width) => width >= 12), `${iconWidths}`);
    const menu = main.locator(".browser-workbench-toolbar-popover");
    await menu.waitFor({ timeout: 5000 });
    for (const label of ["Save screenshot", "Fit to panel", "Mobile", "Diagnostics"]) {
      await menu.getByText(label, { exact: true }).waitFor();
    }
    await main.screenshot({ path: path.join(outputDir, "toolbar-menu.png") });
    await sleep(300);
    await windowCapture("window-menu-open");
    await menu.getByText("Mobile", { exact: true }).click();
    await main.locator(".browser-workbench-size-chip").waitFor({ timeout: 5000 });
    assert.match(await main.locator(".browser-workbench-size-chip").innerText(), /390.844/);
    await main.locator(".browser-workbench-size-chip").click();
    assert.equal(await main.locator(".browser-workbench-size-chip").count(), 0);
  });

  await step("the new tab page offers an ask box, ideas and recent sites", async () => {
    await main.getByRole("button", { name: "New tab", exact: true }).click();
    await main.getByLabel("Ask CoWork").waitFor({ timeout: 5000 });
    await main.locator(".browser-newtab-idea").first().waitFor();
    await main.locator(".browser-newtab-site").first().waitFor();
    await main.screenshot({ path: path.join(outputDir, "new-tab.png") });
    await main
      .locator(".browser-workbench-tab-shell.is-active")
      .getByRole("button", { name: "Close tab" })
      .click();
    // The close is asynchronous (the page's unload check runs first).
    await waitFor(
      async () => (await main.getByRole("tab", { name: /New tab/ }).count()) === 0,
      "the new tab to close",
    );
  });

  await step(
    "the browser identifies as Chrome, with no Electron or app name anywhere",
    async () => {
      await main.getByRole("tab", { name: /Fixture 1$/ }).click();
      await guestFor("/page?n=1");
      await navigateActiveTab(`${site}/echo`);
      const echo = await guestFor("/echo");
      const seen = JSON.parse(await inGuest(echo.id, "document.body.innerText"));
      const client = JSON.parse(
        await inGuest(
          echo.id,
          `JSON.stringify({ ua: navigator.userAgent, brands: (navigator.userAgentData?.brands || []).map((b) => b.brand), vendor: navigator.vendor })`,
        ),
      );
      assert.match(seen.userAgent, /Chrome\/\d+/);
      const everything = [seen.userAgent, seen.secChUa, client.ua, ...client.brands].join(" | ");
      assert.doesNotMatch(everything, /Electron|CoWork/i, everything);
      assert.equal(client.vendor, "Google Inc.");
      await navigateActiveTab(`${site}/page?n=1`);
      await guestFor("/page?n=1");
      return { userAgent: seen.userAgent, secChUa: seen.secChUa };
    },
  );

  await step(
    "a click on the page while CoWork drives asks to take over; Take over pauses, Resume continues",
    async () => {
      const service = (fn, input) =>
        desktop.evaluate(
          (_, args) => {
            const svc = process.mainModule.require(args.module).getBrowserWorkbenchService();
            return new Function("svc", "input", `return (${args.fn})(svc, input)`)(svc, args.input);
          },
          { module: workbenchModule, fn: fn.toString(), input },
        );
      await service((svc, i) => svc.beginDriving(i.taskId, "default", "browser_click"), {
        taskId: task.id,
      });
      await main.getByText(/CoWork is using this tab/).waitFor({ timeout: 5000 });
      if (engine === "native") {
        // A click on the page from the user: main stops it and the take-over bar asks.
        await desktop.evaluate(({ webContents }) => {
          const view = webContents
            .getAllWebContents()
            .find((c) => c.getType() === "window" && /\/page\?n=1$/.test(c.getURL()));
          view.sendInputEvent({ type: "mouseDown", x: 60, y: 60, button: "left", clickCount: 1 });
          view.sendInputEvent({ type: "mouseUp", x: 60, y: 60, button: "left", clickCount: 1 });
        });
        await main.locator(".browser-workbench-driving-ask").waitFor({ timeout: 5000 });
        await windowCapture("window-takeover");
        await main
          .locator(".browser-workbench-driving-ask")
          .getByRole("button", { name: "Take over" })
          .click();
      } else {
        await main
          .locator(".browser-workbench-driving-shield")
          .click({ position: { x: 60, y: 60 } });
        await main.getByText("CoWork is controlling this tab.").waitFor({ timeout: 5000 });
        await main
          .locator(".browser-workbench-driving-takeover")
          .getByRole("button", { name: "Take over" })
          .click();
      }
      await waitFor(
        async () =>
          service((svc, i) => svc.isPausedByUser(i.taskId, "default"), { taskId: task.id }),
        "CoWork to be paused",
      );
      await main.getByText(/You have control/).waitFor({ timeout: 5000 });
      await main.getByRole("button", { name: "Resume CoWork" }).click();
      await waitFor(
        async () =>
          !(await service((svc, i) => svc.isPausedByUser(i.taskId, "default"), {
            taskId: task.id,
          })),
        "CoWork to resume",
      );
      await service((svc, i) => svc.endDriving(i.taskId, "default"), { taskId: task.id });
      await waitFor(
        async () => (await main.getByText(/CoWork is using this tab/).count()) === 0,
        "the banner to clear",
      );
    },
  );

  await step(
    "a sign-in page CoWork lands on shows the hand-back banner; Done dismisses it",
    async () => {
      await desktop.evaluate(
        (_, input) =>
          process.mainModule
            .require(input.module)
            .getBrowserWorkbenchService()
            .navigate({ taskId: input.taskId, sessionId: "default", url: input.url }),
        { module: workbenchModule, taskId: task.id, url: `${site}/login` },
      );
      await guestFor("/login");
      const banner = main.locator(".browser-workbench-driving.is-sign-in");
      await banner.waitFor({ timeout: 8000 });
      await windowCapture("window-signin");
      await banner.getByRole("button", { name: "Done" }).click();
      await waitFor(async () => (await banner.count()) === 0, "the sign-in banner to clear");
      await navigateActiveTab(`${site}/page?n=1`);
      await guestFor("/page?n=1");
    },
  );

  await step(
    "a password CSV imports and fills only on its own site, and the password never reaches the window",
    async () => {
      const csvPath = path.join(outputDir, "logins.csv");
      await fs.writeFile(
        csvPath,
        `name,url,username,password\nlocal,${site}/login,qa-user,qa-secret-9f3\n`,
      );
      // Native pickers and Touch ID are answered here; the handlers still run for real.
      await desktop.evaluate(({ dialog, systemPreferences }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
        dialog.showMessageBox = async () => ({ response: 0 });
        systemPreferences.promptTouchID = async () => undefined;
      }, csvPath);
      const detected = await main.evaluate(() => window.electronAPI.browserImportDetect());
      assert.equal(detected.success, true);
      const keychain = process.env.QA_OS_KEYCHAIN === "1";
      assert.equal(detected.canStorePasswords, keychain, "saving needs OS encryption");
      const prepared = await main.evaluate(
        (id) => window.electronAPI.browserImportPrepare({ workspaceId: id, kind: "csv" }),
        workspace.id,
      );
      assert.equal(prepared.success, true, JSON.stringify(prepared));
      assert.equal(prepared.logins, 1);
      assert.ok(!JSON.stringify(prepared).includes("qa-secret-9f3"), "no secret in the preview");
      const committed = await main.evaluate(
        (input) => window.electronAPI.browserImportCommit(input),
        { workspaceId: workspace.id, token: prepared.token },
      );
      if (!keychain) {
        // Without OS encryption nothing is saved rather than saved weakly.
        assert.equal(committed.success, false);
        assert.equal(committed.code, "encryption_unavailable");
        const none = await main.evaluate(
          (id) => window.electronAPI.listBrowserLogins({ workspaceId: id }),
          workspace.id,
        );
        assert.equal(none.logins.length, 0);
        return;
      }
      assert.equal(committed.success, true, JSON.stringify(committed));
      assert.equal(committed.logins, 1);
      const listed = await main.evaluate(
        (id) => window.electronAPI.listBrowserLogins({ workspaceId: id }),
        workspace.id,
      );
      assert.equal(listed.logins.length, 1);
      assert.ok(!JSON.stringify(listed).includes("qa-secret-9f3"), "no secret in the list");
      const saved = listed.logins[0];

      // A look-alike address must refuse: same page, other origin.
      await navigateActiveTab(`${site.replace("127.0.0.1", "localhost")}/login`);
      const lookalike = await guestFor("/login");
      const refused = await main.evaluate(
        (input) => window.electronAPI.fillBrowserLogin(input),
        { workspaceId: workspace.id, taskId: task.id, id: saved.id },
      );
      assert.equal(refused.success, false);
      assert.equal(refused.code, "origin_mismatch");
      assert.equal(await inGuest(lookalike.id, "document.getElementById('pass').value"), "");

      await navigateActiveTab(`${site}/login`);
      const login = await waitFor(async () => {
        const found = (await guests()).find((guest) => guest.url === `${site}/login`);
        return found;
      }, "the exact-origin login page");
      const hint = await main.evaluate(
        (input) => window.electronAPI.listBrowserLoginsForPage(input),
        { workspaceId: workspace.id, url: `${site}/login` },
      );
      assert.equal(hint.logins.length, 1);
      // A refused fill starts a short cool-down.
      await sleep(2300);
      const filled = await main.evaluate(
        (input) => window.electronAPI.fillBrowserLogin(input),
        { workspaceId: workspace.id, taskId: task.id, id: saved.id },
      );
      assert.equal(filled.success, true, JSON.stringify(filled));
      assert.equal(await inGuest(login.id, "document.getElementById('user').value"), "qa-user");
      assert.equal(await inGuest(login.id, "document.getElementById('pass').value"), "qa-secret-9f3");
      assert.ok(!JSON.stringify(filled).includes("qa-secret-9f3"), "fill result has no secret");

      // Nothing the app stored on disk holds the password in plain text.
      const scan = async (dir) => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!/Cache|node_modules/.test(entry.name)) await scan(full);
          } else if (/\.(db|json|sqlite|log)(-wal)?$/.test(entry.name)) {
            const data = await fs.readFile(full).catch(() => Buffer.alloc(0));
            assert.ok(!data.includes("qa-secret-9f3"), `plaintext password in ${full}`);
          }
        }
      };
      await scan(env.COWORK_USER_DATA_DIR);
      await navigateActiveTab(`${site}/page?n=1`);
      await guestFor("/page?n=1");
    },
  );

  await step(
    "Adjust edits the page live, the image under it follows, and closing reverts it",
    async () => {
      await main.getByRole("tab", { name: /Fixture 1-child/ }).click();
      const child = await guestFor("/page?n=1-child");
      const sizeOf = () =>
        inGuest(child.id, `getComputedStyle(document.querySelector("#heading")).fontSize`);
      const before = await sizeOf();
      await main.getByRole("button", { name: "Annotate page element" }).click();
      const layer = main.locator(".browser-live-annotation-layer");
      await layer.waitFor({ timeout: 5000 });
      await sleep(600);
      await layer.click({ position: { x: 80, y: 32 } });
      await main.locator(".browser-live-annotation-meta").waitFor({ timeout: 8000 });
      await main.locator(".browser-annotation-adjust-toggle").click();
      const frozen = main.locator(".browser-workbench-tab-freeze");
      const imageBefore = engine === "native" ? await frozen.getAttribute("src") : null;
      await main
        .locator(".browser-annotation-adjust")
        .getByLabel("Size", { exact: true })
        .fill("52px");
      await waitFor(async () => (await sizeOf()) === "52px", "the heading to grow on the page");
      if (engine === "native") {
        await waitFor(
          async () => (await frozen.getAttribute("src").catch(() => null)) !== imageBefore,
          "the still image to follow the edit",
        );
      }
      await windowCapture("window-adjust");
      await main.locator(".browser-annotation-adjust-toggle").click();
      await waitFor(async () => (await sizeOf()) === before, "the edit to be reverted");
      await main.getByRole("button", { name: "Cancel" }).first().click();
      await main.getByRole("button", { name: "Annotate page element" }).click();
      await waitFor(async () => (await layer.count()) === 0, "annotation mode to end");
      await main.getByRole("tab", { name: /Fixture 1$/ }).click();
    },
  );

  if (engine === "native") {
    await step("CoWork's cursor is drawn inside a native page", async () => {
      await main.getByRole("tab", { name: /Fixture 1$/ }).click();
      const first = await guestFor("/page?n=1");
      await desktop.evaluate(
        (_, input) => {
          const service = process.mainModule.require(input.module).getBrowserWorkbenchService();
          service.emitCursor(service.getSession(input.taskId, "default"), {
            x: 220,
            y: 160,
            kind: "click",
            label: "Click",
            pulse: true,
          });
        },
        { module: workbenchModule, taskId: task.id },
      );
      await waitFor(
        async () => inGuest(first.id, `!!document.getElementById("__cowork_agent_cursor")`),
        "the cursor marker",
      );
      // The page's own scripts see no scripts, listeners or events from it.
      assert.equal(
        await inGuest(first.id, `document.getElementById("__cowork_agent_cursor").shadowRoot`),
        null,
        "closed shadow root",
      );
      await sleep(500);
      await windowCapture("window-agent-cursor");
    });

    await step(
      "mouse and swipe back/forward act on the native page under the pointer",
      async () => {
        await navigateActiveTab(`${site}/page?n=9`);
        await guestFor("/page?n=9");
        await navigateActiveTab(`${site}/page?n=10`);
        await guestFor("/page?n=10");
        // Put the pointer over the page (the real pointer is not moved by the test).
        const point = await desktop.evaluate(({ BrowserWindow, screen }) => {
          const window = BrowserWindow.getAllWindows().find((w) =>
            w.webContents.getURL().startsWith("file:"),
          );
          const view = window.contentView.children.find(
            (child) => child.getVisible?.() && /n=10/.test(child.webContents?.getURL?.() || ""),
          );
          const bounds = view.getBounds();
          const content = window.getContentBounds();
          const target = { x: content.x + bounds.x + 40, y: content.y + bounds.y + 40 };
          screen.getCursorScreenPoint = () => target;
          return target;
        });
        assert.ok(point.x > 0);
        await desktop.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows().find((w) =>
            w.webContents.getURL().startsWith("file:"),
          );
          window.emit("app-command", {}, "browser-backward");
        });
        await guestFor("/page?n=9");
        await desktop.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows().find((w) =>
            w.webContents.getURL().startsWith("file:"),
          );
          window.emit("swipe", {}, "right");
        });
        await guestFor("/page?n=10");
        // Leave the tab as later steps expect it.
        await navigateActiveTab(`${site}/page?n=1`);
        await guestFor("/page?n=1");
      },
    );
  }

  await step("closing and reopening the workbench restores its tabs", async () => {
    const before = await guestFor("/page?n=1");
    const loadedAt = await inGuest(before.id, "window.__loadedAt");
    await main.getByRole("button", { name: "Close browser workbench" }).click();
    if (engine === "native") {
      // Native tab views stay alive (hidden) while the browser is closed.
      await sleep(500);
      assert.ok(
        (await guests()).some((guest) => guest.id === before.id),
        "page kept alive",
      );
    } else {
      await waitFor(async () => (await guests()).length === 0, "the webviews to close");
    }
    await openWorkbench("Browser QA");
    const after = await guestFor("/page?n=1");
    await guestFor("/page?n=3");
    if (engine === "native") {
      await sleep(1500);
      await windowCapture("window-reopened");
      assert.equal(after.id, before.id, "same page view reattached");
      assert.equal(await inGuest(after.id, "window.__loadedAt"), loadedAt, "page not reloaded");
    }
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

  await step("Cmd+Shift+B opens the browser from the task view", async () => {
    await main.getByRole("button", { name: "Close browser workbench" }).click();
    await waitFor(
      async () => (await main.getByLabel("Browser URL").count()) === 0,
      "the browser to close",
    );
    await main.locator(".main-header-title").first().click();
    await main.keyboard.press("Meta+Shift+B");
    await main.getByLabel("Browser URL").waitFor({ timeout: 10000 });
  });

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
