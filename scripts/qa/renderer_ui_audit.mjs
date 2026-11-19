#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { appendFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "vite";
import { _electron } from "playwright";

const root = process.cwd();
const results = [];
const server = await createServer({
  configFile: path.join(root, "vite.config.mts"),
  cacheDir: path.join(root, "node_modules", ".vite-renderer-ui-audit"),
  server: {
    host: "127.0.0.1",
    port: 0,
    strictPort: false,
    fs: { allow: [root, realpathSync(path.join(root, "node_modules"))] },
  },
  plugins: [
    {
      name: "renderer-ui-audit",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== "/ui-audit.html") return next();
          const html =
            '<html class="visual-calm theme-light"><head></head><body><div id="root"></div><script type="module" src="/@fs/' +
            root +
            '/scripts/qa/fixtures/renderer-ui-audit.tsx"></script></body></html>';
          res.setHeader("Content-Type", "text/html");
          res.end(await server.transformIndexHtml(req.url, html));
        });
      },
    },
  ],
});
await server.listen();
const port = server.httpServer.address().port;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-ui-audit-"));
const env = { ...process.env, COWORK_UI_AUDIT_URL: `http://127.0.0.1:${port}/ui-audit.html` };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await _electron.launch({
    args: [
      path.join(root, "scripts/qa/fixtures/electron-renderer-ui.cjs"),
      `--user-data-dir=${profile}`,
    ],
    env,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.error("Renderer error:", e.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") console.error(message.text());
  });
  await page.getByRole("button", { name: "Open parent", exact: true }).waitFor();
  await page.getByRole("button", { name: "Open parent", exact: true }).click();
  assert.equal(await page.evaluate(() => document.activeElement.id), "child-opener");
  await page.getByRole("button", { name: "Close parent", exact: true }).focus();
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.id), "child-opener");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await page.evaluate(() => document.activeElement.textContent), "Close parent");
  await page.getByRole("button", { name: "Open child", exact: true }).click();
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog", { name: "Child dialog", exact: true }).count(), 0);
  assert.equal(await page.getByRole("dialog", { name: "Parent dialog", exact: true }).count(), 1);
  assert.equal(await page.evaluate(() => document.activeElement.id), "child-opener");
  await page.getByRole("button", { name: "Open access warning", exact: true }).click();
  await page.getByRole("alertdialog", { name: "Turn on Full access?" }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), "Cancel");
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog", { name: "Parent dialog", exact: true }).count(), 1);
  assert.equal(await page.evaluate(() => document.activeElement.id), "warning-opener");
  await page.getByRole("button", { name: "Open image", exact: true }).click();
  await page.getByRole("dialog", { name: "Preview image", exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() =>
      Boolean(document.elementFromPoint(20, 20)?.closest(".image-lightbox")),
    ),
    true,
  );
  await page.keyboard.press("+");
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog", { name: "Parent dialog", exact: true }).count(), 1);
  assert.equal(await page.evaluate(() => document.activeElement.id), "image-opener");
  await page.getByRole("button", { name: "Access: Parent safe access", exact: true }).click();
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog", { name: "Parent dialog", exact: true }).count(), 1);
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => document.activeElement.id), "parent-opener");
  console.log("Check passed:", results.length + 1);
  results.push(
    "Nested dialogs, access warning, lightbox and menu: focus containment, topmost Escape, opener restoration",
  );

  await page.getByRole("button", { name: "Review launch" }).click();
  await page.getByRole("dialog", { name: "Review MCP server installation" }).waitFor();
  await page.keyboard.press("Escape");
  console.log("Check passed:", results.length + 1);
  results.push("MCP launch review: accessible name and keyboard dismissal");

  await page.getByRole("button", { name: "Show inbox", exact: true }).click();
  await page.locator(".ibx-row-subject").filter({ hasText: "Subject B" }).waitFor();
  await page.locator(".ibx-row-subject").filter({ hasText: "Subject B" }).click();
  await page.locator(".ibx-reader").getByText("Subject B", { exact: true }).waitFor();
  await page.evaluate(() => {
    window.qa.holdThreads.add("A");
    window.qa.holdThreads.add("B");
  });
  await page.locator(".ibx-row-subject").filter({ hasText: "Subject A" }).click();
  await page.locator(".ibx-row-subject").filter({ hasText: "Subject B" }).click();
  await page.waitForFunction(() => window.qa.pending.has("A") && window.qa.pending.has("B"));
  await page.evaluate(() => window.qa.resolveThread("B"));
  await page.locator(".ibx-reader").getByText("Subject B", { exact: true }).waitFor();
  await page.evaluate(() => window.qa.resolveThread("A"));
  await page.waitForFunction(() => !window.qa.pending.size);
  assert.equal(
    await page.locator(".ibx-reader").getByText("Subject A", { exact: true }).count(),
    0,
  );
  console.log("Check passed:", results.length + 1);
  results.push("Inbox: older A detail cannot replace the selected B thread");

  // Record how many whole-Inbox commits typing into manual compose causes.
  await page.getByRole("button", { name: "Reply", exact: true }).first().click();
  await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
  await page.evaluate(() => {
    window.qa.commits = [];
  });
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .pressSequentially("Please send the updated document.");
  const typing = await page.evaluate(() => ({
    commits: window.qa.commits.length,
    totalMs: window.qa.commits.reduce((sum, c) => sum + c.duration, 0),
  }));
  console.log("Check passed:", results.length + 1);
  results.push({ manualComposeTyping: typing });
  console.log(JSON.stringify({ manualComposeTyping: typing }));

  await fs.mkdir(path.join(root, "logs"), { recursive: true });
  await page.screenshot({ path: path.join(root, "logs/renderer-ui-audit-inbox.png") });
  // The form sends its current local fields, then resets correctly for forwarding.
  await page
    .getByRole("textbox", { name: "Cc", exact: true })
    .fill("copy@example.com; second@example.com");
  await page.getByRole("textbox", { name: "Bcc", exact: true }).fill("private@example.com");
  await page.locator(".ibx-compose").getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForFunction(() =>
    window.qa.calls.some(
      (c) => c.method === "applyMailboxAction" && c.options.type === "send_message",
    ),
  );
  const sent = await page.evaluate(
    () =>
      window.qa.calls.find(
        (c) => c.method === "applyMailboxAction" && c.options.type === "send_message",
      ).options,
  );
  assert.equal(sent.messageBody, "Please send the updated document.");
  assert.deepEqual(sent.messageCc, ["copy@example.com", "second@example.com"]);
  assert.deepEqual(sent.messageBcc, ["private@example.com"]);
  await page.getByRole("button", { name: "Forward", exact: true }).first().click();
  assert.equal(await page.getByRole("textbox", { name: "To", exact: true }).inputValue(), "");
  assert.match(
    await page.getByRole("textbox", { name: "Message", exact: true }).inputValue(),
    /Forwarded message/,
  );
  results.push(
    "Manual compose: current local fields reach the send action; forwarding resets recipients and keeps quoted content",
  );

  await page.evaluate(() => {
    window.qa.holdList = true;
  });
  await page.getByRole("button", { name: "Display options", exact: true }).click();
  await page
    .getByRole("group", { name: "Sort threads" })
    .getByRole("button", { name: "Priority", exact: true })
    .click();
  await page
    .getByRole("group", { name: "Sort threads" })
    .getByRole("button", { name: "Recent", exact: true })
    .click();
  await page.waitForFunction(() => window.qa.pendingLists.length === 2);
  await page.evaluate(() => window.qa.resolveList(1, ["B"]));
  await page.waitForFunction(() => document.querySelectorAll(".ibx-row-subject").length === 1);
  await page.evaluate(() => window.qa.resolveList(0, ["A"]));
  await page.waitForTimeout(100);
  assert.deepEqual(await page.locator(".ibx-row-subject").allTextContents(), ["Subject B"]);
  await page.evaluate(() => {
    window.qa.holdList = false;
  });
  results.push("Inbox: older filter response cannot replace the newest list");

  await page.getByRole("button", { name: "Show dialogs", exact: true }).click();
  await page.evaluate(() => {
    window.qa.holdGoogle = true;
    window.qa.calls = [];
  });
  await page.getByRole("button", { name: "Show inbox", exact: true }).click();
  await page.waitForFunction(() => Boolean(window.qa.resolveGoogle));
  await page.getByRole("button", { name: "Show dialogs", exact: true }).click();
  await page.evaluate(() => window.qa.resolveGoogle({ enabled: false }));
  await page.waitForTimeout(100);
  assert.equal(
    await page.evaluate(
      () =>
        window.qa.calls.filter(
          (c) => c.method === "listMailboxThreads" || c.method === "syncMailbox",
        ).length,
    ),
    0,
  );
  await page.evaluate(() => {
    window.qa.holdGoogle = false;
  });
  results.push("Inbox: unmount during initialization stops subsequent reads and automatic sync");

  await page.getByRole("button", { name: "Show import", exact: true }).click();
  await page.getByRole("button", { name: "I have my export ready" }).click();
  await page.locator(".chatgpt-import-dropzone").focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.qa.calls.some((c) => c.method === "selectFiles"));
  results.push("Import file selector activates through Enter");
  await page.getByRole("button", { name: "Show registry", exact: true }).click();
  await page.locator("button.registry-tag").first().focus();
  await page.keyboard.press("Space");
  await page.waitForFunction(() =>
    window.qa.calls.some(
      (call) => call.method === "searchMCPRegistry" && call.tags?.includes("documents"),
    ),
  );
  await page.getByRole("button", { name: "Details", exact: true }).first().click();
  await page.getByRole("dialog", { name: "MCP server details" }).waitFor();
  await page.keyboard.press("Escape");
  results.push("Registry: tag uses native keyboard activation; details dialog closes with Escape");
  await page.getByRole("button", { name: "Show scheduled", exact: true }).click();
  const expand = page.getByRole("button", { name: "Expand Daily document review" });
  await expand.focus();
  await page.keyboard.press("Enter");
  assert.equal(
    await page
      .getByRole("button", { name: "Collapse Daily document review" })
      .getAttribute("aria-expanded"),
    "true",
  );
  await page.keyboard.press("Space");
  assert.equal(
    await page
      .getByRole("button", { name: "Expand Daily document review" })
      .getAttribute("aria-expanded"),
    "false",
  );
  results.push(
    "Scheduled jobs: Enter/Space expand and collapse without invoking neighboring actions",
  );

  await page.getByRole("button", { name: "Show files", exact: true }).click();
  const fileSearch = page.getByRole("searchbox", { name: "Search files across all sources" });
  await page.getByRole("button", { name: "Open file local-notes.txt" }).waitFor();
  await page.getByRole("button", { name: "Open file overview.md" }).click();
  const previewUrl = page.url();
  await page.getByRole("link", { name: "Jump within" }).click();
  assert.equal(
    await page
      .getByRole("heading", { name: "Local section" })
      .evaluate((element) => element.matches(":focus")),
    true,
  );
  assert.equal(page.url(), previewUrl);
  await page.getByRole("link", { name: "Open target" }).click();
  await page.waitForFunction(() => document.activeElement?.textContent === "Deep section");
  assert.ok(
    await page.locator(".file-viewer-content").evaluate((element) => element.scrollTop > 0),
  );
  await page.getByRole("button", { name: "Back to previous file" }).click();
  await page.getByRole("dialog", { name: "overview.md" }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "overview.md" }).waitFor({ state: "detached" });
  results.push(
    "Markdown preview: links focus the requested headings in the same file or another file without navigating the app",
  );
  await fileSearch.fill("old-search-hit");
  await page.waitForFunction(() => window.qa.resolveHubSearch);
  await page.getByText("Loading files…", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Open file local-notes.txt" }).count(), 0);
  await page.getByRole("button", { name: "Artifacts", exact: true }).click();
  await page.getByRole("button", { name: "Open file report.txt" }).waitFor();
  assert.equal(await fileSearch.inputValue(), "");
  await page.evaluate(() => window.qa.resolveHubSearch());
  assert.equal(await page.getByRole("button", { name: "Open file old-search-hit.txt" }).count(), 0);
  await page.evaluate(() => {
    window.qa.failHubListing = true;
  });
  await page.getByRole("button", { name: "Local", exact: true }).click();
  await page.getByText("Files could not be loaded.", { exact: true }).waitFor();
  results.push(
    "Desktop Library: source switch exits search, ignores stale results, and reports a failed listing",
  );

  await page.getByRole("button", { name: "Show archive", exact: true }).click();
  await page.getByText("No matching archived sessions", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Load older archived sessions" }).click();
  await page.getByRole("button", { name: "Unarchive Older archive fixture" }).waitFor();
  results.push("Archived sessions: an older search match is reachable beyond the first 200 rows");

  await page.getByRole("button", { name: "Show work", exact: true }).click();
  const workSearch = page.getByRole("searchbox", { name: "Search work" });
  const workDetail = page.getByRole("complementary", { name: "Selected work" });
  const olderWork = page.getByRole("button", { name: /Done Work session 10\b/ });
  await workSearch.fill("Work session 10");
  await olderWork.click();
  await workSearch.clear();
  await olderWork.waitFor({ state: "detached" });
  await workDetail.getByRole("heading", { name: "Work session 1", exact: true }).waitFor();
  const showAllWork = page.getByRole("button", { name: "Show all 10 sessions in No project" });
  await showAllWork.click();
  const showFewerWork = page.getByRole("button", { name: "Show fewer sessions in No project" });
  assert.equal(await showFewerWork.getAttribute("aria-expanded"), "true");
  await olderWork.click();
  await workDetail.getByRole("heading", { name: "Work session 10", exact: true }).waitFor();
  await showFewerWork.click();
  await olderWork.waitFor({ state: "detached" });
  await workDetail.getByRole("heading", { name: "Work session 1", exact: true }).waitFor();
  assert.equal(await showAllWork.getAttribute("aria-expanded"), "false");
  assert.equal(await showAllWork.evaluate((button) => button.matches(":focus")), true);
  results.push(
    "Work: expanded groups collapse and details follow a visible session after filtering or collapsing",
  );

  await page.getByRole("button", { name: "Show automation", exact: true }).click();
  await page.getByRole("button", { name: /^Daily document review/ }).click();
  const runAutomation = page.getByRole("button", { name: "Run now", exact: true });
  await runAutomation.waitFor();
  const automationSearch = page.getByRole("searchbox", { name: "Find an automation" });
  await automationSearch.fill("no matching automation");
  await page.getByText("No automations match this search.", { exact: true }).waitFor();
  await runAutomation.waitFor({ state: "detached" });
  await automationSearch.clear();
  await runAutomation.waitFor();
  results.push(
    "Automation Studio: filtering hides the selected item's controls until it is back in the results",
  );
  const routineAlert = page.getByRole("button", { name: "Open routine alert" });
  const routineHeading = page.getByRole("heading", { name: "Review approval", exact: true });
  await routineAlert.click();
  await routineHeading.waitFor();
  await automationSearch.fill("no matching automation");
  await routineHeading.waitFor({ state: "detached" });
  await routineAlert.click();
  await routineHeading.waitFor();
  assert.equal(await automationSearch.inputValue(), "");
  results.push("Automation Studio: reopening the same routine alert clears the active filter");

  await page.getByRole("button", { name: "Show menus", exact: true }).click();
  await page.getByRole("button", { name: "Access: Retired profile", exact: true }).click();
  assert.equal(
    await page.evaluate(() => document.activeElement.getAttribute("aria-disabled")),
    "true",
  );
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), "Safe access");
  await page.keyboard.press("Escape");
  assert.equal(
    await page.evaluate(() => document.activeElement.getAttribute("aria-label")),
    "Access: Retired profile",
  );
  console.log("Check passed:", results.length + 1);
  results.push(
    "Access menu: unavailable choice is navigable; arrows and Escape restore the trigger",
  );
  const more = page.getByRole("button", { name: "More", exact: true });
  const destinations = page.getByRole("menu", { name: "More destinations" });
  await more.click();
  assert.equal(
    await destinations
      .getByRole("menuitem")
      .first()
      .evaluate((item) => item.matches(":focus")),
    true,
  );
  await page.keyboard.press("ArrowDown");
  const pin = destinations.getByRole("menuitemcheckbox").first();
  assert.equal(await pin.evaluate((item) => item.matches(":focus")), true);
  await page.keyboard.press("Space");
  assert.equal(await pin.getAttribute("aria-checked"), "true");
  await page.keyboard.press("Escape");
  await destinations.waitFor({ state: "detached" });
  assert.equal(await more.evaluate((button) => button.matches(":focus")), true);
  await more.click();
  await page.keyboard.press("Shift+Tab");
  await destinations.waitFor({ state: "detached" });
  assert.equal(await more.evaluate((button) => button.matches(":focus")), true);
  await more.click();
  await page.keyboard.press("Tab");
  await destinations.waitFor({ state: "detached" });
  assert.equal(await more.evaluate((button) => button.matches(":focus")), false);
  results.push(
    "Sidebar More: opening focuses a destination, arrows reach pin controls, and Escape and Tab dismiss it",
  );
  for (const kind of ["document", "spreadsheet", "presentation", "web"]) {
    await page.locator(`.${kind}-artifact-menu-btn`).click();
    const menu = page.locator(`.${kind}-artifact-menu`);
    await menu.waitFor();
    await page.waitForFunction((cls) => {
      const el = document.querySelector(cls);
      const r = el?.getBoundingClientRect();
      return r && r.top >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
    }, `.${kind}-artifact-menu`);
    await page.keyboard.press("Escape");
  }
  await page.evaluate(() => {
    for (const kind of ["spreadsheet", "presentation", "web"])
      document
        .querySelector(`.${kind}-artifact-menu-btn`)
        .closest(`.${kind}-artifact-card`).style.display = "none";
  });
  await app.browserWindow(page).then((window) => window.evaluate((w) => w.setSize(640, 400)));
  await page.locator(".document-artifact-menu-btn").click();
  await page.waitForFunction(() => {
    const r = document.querySelector(".document-artifact-menu")?.getBoundingClientRect();
    return r && r.top >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
  });
  const countAnchorMeasurements = async () =>
    page.evaluate(async () => {
      const anchor = document.querySelector(".document-artifact-actions");
      const original = HTMLElement.prototype.getBoundingClientRect;
      let reads = 0;
      HTMLElement.prototype.getBoundingClientRect = function () {
        if (this === anchor) reads++;
        return original.call(this);
      };
      try {
        for (let i = 0; i < 40; i++) window.dispatchEvent(new Event("resize"));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return reads;
      } finally {
        HTMLElement.prototype.getBoundingClientRect = original;
      }
    });
  const measurements = await countAnchorMeasurements();
  assert.ok(measurements <= 2, `Resize burst caused ${measurements} anchor measurements`);
  results.push({ resizeEvents: 40, anchorMeasurements: measurements });
  await page.screenshot({ path: path.join(root, "logs/renderer-ui-audit-narrow-menu.png") });
  await page.keyboard.press("Escape");
  assert.equal(await countAnchorMeasurements(), 0);
  console.log("Check passed:", results.length + 1);
  results.push(
    "All four artifact menus: viewport containment near bottom/right edges, including 640x400",
  );
  await fs.mkdir(path.join(root, "logs"), { recursive: true });
  await page.screenshot({ path: path.join(root, "logs/renderer-ui-audit-menus.png") });
  if (process.argv.includes("--app-smoke")) {
    // Seed only first-run appearance in this disposable profile, then run the actual app.
    await app.evaluate((_, { root, profile }) => globalThis.seedUiAuditProfile(root, profile), {
      root,
      profile,
    });
    await app.close();
    app = await _electron.launch({
      cwd: root,
      args: [path.join(root, "dist/electron/electron/main.js"), `--user-data-dir=${profile}`],
      env: {
        ...env,
        NODE_ENV: "development",
        COWORK_USER_DATA_DIR: profile,
        COWORK_DEV_SERVER_URL: `http://127.0.0.1:${port}`,
        COWORK_PROFILE_RUN: "1",
        COWORK_PROFILE_QUIET: "1",
        COWORK_DEV_BRAND_APP: "0",
      },
    });
    const appLog = path.join(root, "logs/renderer-ui-audit-app.log");
    await fs.writeFile(appLog, "");
    for (const stream of [app.process().stdout, app.process().stderr])
      stream?.on("data", (chunk) => appendFileSync(appLog, chunk));
    // macOS safeStorage briefly creates a bootstrap window before the real app window.
    let actualPage;
    const deadline = Date.now() + 30000;
    while (!actualPage && Date.now() < deadline) {
      actualPage = app
        .windows()
        .find(
          (candidate) =>
            !candidate.isClosed() &&
            candidate.url().startsWith(`http://127.0.0.1:${port}/`) &&
            !candidate.url().includes("ui-audit.html"),
        );
      if (!actualPage) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(
      actualPage,
      "Actual app window did not finish startup; inspect logs/renderer-ui-audit-app.log",
    );
    actualPage.setDefaultTimeout(10000);
    actualPage.on("pageerror", (e) => {
      errors.push(e.message);
      console.error("App renderer error:", e.message);
    });
    await actualPage.locator(".welcome-view").waitFor({ timeout: 30000 });
    await actualPage.screenshot({ path: path.join(root, "logs/renderer-ui-audit-app-home.png") });
    const actualWindow = await app.browserWindow(actualPage);
    await actualWindow.evaluate((w) => w.webContents.closeDevTools());
    await actualWindow.evaluate((w) => {
      w.setMinimumSize(600, 400);
      w.setSize(860, 520);
    });
    await actualPage.waitForTimeout(200);
    const home = await actualPage.locator(".welcome-view").boundingBox();
    const dimensions = await actualPage.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }));
    await actualPage.screenshot({
      path: path.join(root, "logs/renderer-ui-audit-app-home-narrow.png"),
    });
    console.log(JSON.stringify({ narrowHome: home, dimensions }));
    assert.ok(home && home.x >= 0 && home.x + home.width <= dimensions.width + 1);
    results.push(
      "Actual app: Calm homepage loads with desktop preload in a disposable profile; narrow-window content stays within viewport",
    );
    await actualPage.getByRole("button", { name: "Settings", exact: true }).click();
    const settingsSearch = actualPage.getByRole("textbox", {
      name: "Search settings",
      exact: true,
    });
    await settingsSearch.fill("composer");
    await actualPage.getByRole("button", { name: "Clear search" }).click();
    assert.equal(await settingsSearch.inputValue(), "");
    assert.equal(await settingsSearch.evaluate((input) => input.matches(":focus")), true);
    results.push("Actual app: clearing Settings search restores focus to the labeled search field");
    const openFixtureBrowser = async () => {
      await actualPage.getByRole("button", { name: "Browser reload fixture", exact: true }).click();
      await actualPage.getByRole("button", { name: "Task actions", exact: true }).click();
      await actualPage.getByRole("menuitem", { name: "Open browser", exact: true }).click();
      await actualPage.getByRole("tablist", { name: "Browser tabs" }).waitFor();
    };
    const nativeTabIds = () =>
      actualWindow.evaluate((w) =>
        w.contentView.children
          .map((view) => view.webContents?.id)
          .filter((id) => id && id !== w.webContents.id),
      );
    const waitForNativeTabs = async () => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const ids = await nativeTabIds();
        if (ids.length) return ids;
        await actualPage.waitForTimeout(50);
      }
      assert.fail("No native browser tab was attached");
    };
    await actualPage.getByRole("button", { name: "Home", exact: true }).click();
    const sessionSearch = actualPage.getByRole("searchbox", { name: "Search sessions" });
    await sessionSearch.fill("no session like this");
    await actualPage.getByRole("button", { name: "Clear session search" }).click();
    assert.equal(await sessionSearch.inputValue(), "");
    assert.equal(await sessionSearch.evaluate((input) => input.matches(":focus")), true);
    const sessionActions = actualPage.getByRole("button", {
      name: "Session actions for Browser reload fixture",
    });
    await actualPage.getByRole("button", { name: "Browser reload fixture", exact: true }).hover();
    await sessionActions.click();
    const rename = actualPage.getByRole("menuitem", { name: "Rename", exact: true });
    assert.equal(await rename.evaluate((item) => item.matches(":focus")), true);
    await actualPage.keyboard.press("ArrowDown");
    assert.equal(
      await actualPage
        .getByRole("menuitem", { name: "Pin", exact: true })
        .evaluate((item) => item.matches(":focus")),
      true,
    );
    await actualPage.keyboard.press("Escape");
    await rename.waitFor({ state: "detached" });
    assert.equal(await sessionActions.evaluate((button) => button.matches(":focus")), true);
    await sessionActions.click();
    await rename.click();
    await actualPage.locator(".cli-rename-input").waitFor();
    await actualPage.keyboard.press("Escape");
    results.push(
      "Actual app: clearing session search restores focus and session actions support pointer and keyboard activation",
    );
    await openFixtureBrowser();
    const nativeTabs = await waitForNativeTabs();
    const closeBrowser = actualPage.getByRole("button", { name: "Close browser workbench" });
    await closeBrowser.click();
    await closeBrowser.waitFor({ state: "detached" });
    for (const method of ["reload", "reloadIgnoringCache"]) {
      await Promise.all([
        actualPage.waitForEvent("domcontentloaded"),
        actualWindow.evaluate((w, reload) => w.webContents[reload](), method),
      ]);
      await actualPage.locator(".welcome-view").waitFor();
      assert.deepEqual(await nativeTabIds(), []);
      await openFixtureBrowser();
      assert.deepEqual(await waitForNativeTabs(), nativeTabs);
    }
    results.push(
      "Actual app: Reload and Force Reload each restore Home, detach native browser surfaces, and allow reopening the same live tab",
    );
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(root, "logs/renderer-ui-audit.json"),
    JSON.stringify({ results, errors }, null, 2),
  );
  console.log(JSON.stringify({ results, errors }, null, 2));
} finally {
  await app?.close();
  await server.close();
  await fs.rm(profile, { recursive: true, force: true });
}
