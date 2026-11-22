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
          if (req.url === "/ui-audit-find-target.html") {
            res.setHeader("Content-Type", "text/html");
            res.end("<title>Find fixture</title><p>Needle one</p><p>Needle two</p>");
            return;
          }
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

  const compose = page.locator(".ibx-compose");
  const composeBody = compose.getByRole("textbox", { name: "Message", exact: true });
  await compose.getByRole("button", { name: "Reply", exact: true }).click();
  const sameModePreservesDraft =
    (await composeBody.inputValue()) === "Please send the updated document.";
  if (!sameModePreservesDraft) await composeBody.fill("Please send the updated document.");

  await fs.mkdir(path.join(root, "logs"), { recursive: true });
  await page.screenshot({ path: path.join(root, "logs/renderer-ui-audit-inbox.png") });
  // The form sends its current local fields, then resets correctly for forwarding.
  await page
    .getByRole("textbox", { name: "Cc", exact: true })
    .fill("copy@example.com; second@example.com");
  await page.getByRole("textbox", { name: "Bcc", exact: true }).fill("private@example.com");
  await page.locator(".ibx-compose").getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForFunction(() => typeof window.qa.resolveManualSend === "function");
  assert.deepEqual(
    {
      sameModePreservesDraft,
      fieldsReadOnlyDuringSend: await compose
        .getByRole("textbox")
        .evaluateAll((fields) => fields.every((field) => field.readOnly)),
    },
    { sameModePreservesDraft: true, fieldsReadOnlyDuringSend: true },
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
  await page.evaluate(() => window.qa.resolveManualSend());
  await compose.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Forward", exact: true }).first().click();
  assert.equal(await page.getByRole("textbox", { name: "To", exact: true }).inputValue(), "");
  assert.match(
    await page.getByRole("textbox", { name: "Message", exact: true }).inputValue(),
    /Forwarded message/,
  );
  results.push(
    "Manual compose: repeating the active mode keeps the draft, sending locks edits, and forwarding preserves quoted content",
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
  const importExplainsRemoteModels = (await page.getByText(/text leaves your device/).count()) > 0;
  await page.getByRole("button", { name: "I have my export ready" }).click();
  await page.evaluate(() => {
    window.qa.useFixtureImportFile = true;
  });
  await page.locator(".chatgpt-import-dropzone").focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.qa.calls.some((c) => c.method === "selectFiles"));
  results.push("Import file selector activates through Enter");
  await page.getByRole("button", { name: "Start Import", exact: true }).click();
  await page.waitForFunction(() => window.qa.finishFixtureImport);
  const cancelImport = page.getByRole("button", { name: "Cancel Import", exact: true });
  await cancelImport.click();
  await page.waitForFunction(() => window.qa.importCancelAttempts === 1);
  assert.equal(importExplainsRemoteModels, true);
  await page.getByRole("alert").filter({ hasText: "Cancellation did not start" }).waitFor();
  await cancelImport.click();
  await page.waitForFunction(() => window.qa.importCancelAttempts === 2);
  await page.evaluate(() => {
    window.qa.finishFixtureImport();
    window.qa.useFixtureImportFile = false;
  });
  await page.getByRole("heading", { name: "Import cancelled", exact: true }).waitFor();
  await page.getByText("2 memories were created before cancellation.", { exact: true }).waitFor();
  results.push(
    "ChatGPT import: remote model processing is disclosed and cancellation can be retried",
  );
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
  const registrySearch = page.getByPlaceholder("Search servers...");
  await registrySearch.fill("older");
  await page.waitForFunction(() => window.qa.pendingRegistrySearches.has("older"));
  await registrySearch.fill("newer");
  await page.waitForFunction(() => window.qa.pendingRegistrySearches.has("newer"));
  await page.evaluate(() => window.qa.pendingRegistrySearches.get("newer")());
  await page.getByText("newer result", { exact: true }).waitFor();
  await page.evaluate(() => window.qa.pendingRegistrySearches.get("older")());
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.equal(await page.getByText("older result", { exact: true }).count(), 0);
  assert.equal(await page.getByText("newer result", { exact: true }).count(), 1);
  await registrySearch.fill("unavailable");
  await page.getByRole("alert").filter({ hasText: "Could not search the MCP registry." }).waitFor();
  await registrySearch.clear();
  await page.getByRole("button", { name: "Clear tag filter for documents" }).click();
  await page.getByText("Docs", { exact: true }).waitFor();
  results.push(
    "Registry: only the current search renders, failures are visible, and tag filters can be cleared",
  );

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
  await page.getByTitle("Edit", { exact: true }).click();
  const scheduledEditor = page.getByRole("dialog", { name: "Edit Scheduled Task" });
  const scheduleDraftName = scheduledEditor.getByPlaceholder("e.g., Daily AI News Report");
  await scheduleDraftName.fill("Keep my schedule draft");
  await page.evaluate(() => {
    window.qa.holdCronRefresh = true;
    window.qa.cronEvents.forEach((listener) => listener({ type: "updated", jobId: "job-1" }));
  });
  await page.waitForFunction(() => window.qa.resolveCronRefresh);
  assert.equal(await scheduleDraftName.inputValue(), "Keep my schedule draft");
  await page.evaluate(() => window.qa.resolveCronRefresh());
  await scheduledEditor.getByRole("button", { name: "Save Changes", exact: true }).click();
  await scheduledEditor.waitFor({ state: "detached" });
  const scheduledUpdate = await page.evaluate(() =>
    window.qa.calls.find((call) => call.method === "updateCronJob"),
  );
  assert.equal(scheduledUpdate.changes.name, "Keep my schedule draft");
  assert.equal("schedule" in scheduledUpdate.changes, false);
  results.push(
    "Scheduled jobs: refresh preserves the open draft and a rename keeps the current schedule",
  );

  await page.getByRole("button", { name: "Show queued", exact: true }).click();
  const queue = page.getByRole("region", { name: "Queued messages" });
  const queueEditButtons = queue.getByRole("button", { name: "Edit", exact: true });
  await queueEditButtons.first().click();
  const queuedDraft = queue.getByRole("textbox", { name: "Edit queued message" });
  const queuedSave = queue.getByRole("button", { name: "Save queued message" });
  await queuedDraft.fill("Keep this queued draft");
  const draftProtected = await queueEditButtons.last().isDisabled();
  const refreshQueue = (type, remove) =>
    page.evaluate(
      ([eventType, removeFirst]) => {
        const [first, second] = window.qa.queuedInputs;
        window.qa.queuedInputs = removeFirst
          ? [second]
          : [{ ...first, message: "Changed in another window", revision: 2 }, second];
        for (const listener of window.qa.queuedInputEvents) {
          listener({
            taskId: "queue-fixture",
            type: eventType,
            payload: { queuedInputUpdated: true },
          });
        }
      },
      [type, remove],
    );
  await refreshQueue("user_message", false);
  await queue.getByText("Changed in another window", { exact: true }).waitFor();
  assert.deepEqual(
    { draftProtected, changedMessageCanSave: await queuedSave.isEnabled() },
    { draftProtected: true, changedMessageCanSave: false },
  );
  await queue.getByRole("status").filter({ hasText: "changed while you were editing" }).waitFor();
  assert.equal(await queuedDraft.inputValue(), "Keep this queued draft");
  await queue.getByRole("button", { name: "Cancel edit" }).click();
  await queueEditButtons.first().click();
  await queuedDraft.fill("Keep this started draft");
  await refreshQueue("task_dequeued", true);
  await queue.getByRole("status").filter({ hasText: "no longer queued" }).waitFor();
  assert.equal(await queuedSave.isDisabled(), true);
  assert.equal(await queuedDraft.inputValue(), "Keep this started draft");
  await queue.getByRole("button", { name: "Cancel edit" }).click();
  await queueEditButtons.first().click();
  await queuedDraft.fill("Updated second message");
  await queuedSave.click();
  await queue.getByText("Updated second message", { exact: true }).waitFor();
  assert.deepEqual(
    await page.evaluate(
      () => window.qa.calls.find((call) => call.method === "editQueuedTaskInput").input,
    ),
    {
      taskId: "queue-fixture",
      id: "second",
      kind: "follow_up",
      expectedMessage: "Second queued follow-up",
      expectedRevision: 1,
      message: "Updated second message",
    },
  );
  results.push(
    "Queued messages: an open draft survives another edit or the message leaving the queue",
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
  const overviewPreview = page.getByRole("dialog", { name: "overview.md" });
  await overviewPreview.getByTitle("Open in external app").click();
  await overviewPreview.getByRole("alert").filter({ hasText: "File not found" }).waitFor();
  await page.keyboard.press("Escape");
  await overviewPreview.waitFor({ state: "detached" });
  results.push(
    "Markdown preview: links focus the requested headings in the same file or another file without navigating the app",
  );
  await page.getByRole("button", { name: "Recent", exact: true }).click();
  await page.waitForFunction(() => window.qa.resolveHubRecent);
  await page.evaluate(() => window.qa.resolveHubRecent());
  await page.getByRole("button", { name: "Open file previous.txt" }).waitFor();
  assert.deepEqual(
    await page
      .getByRole("button", { name: /^Open file / })
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label"))),
    ["Open file overview.md", "Open file previous.txt"],
  );
  results.push(
    "Desktop Library: late Recent data preserves the just-opened file and viewer actions report failure",
  );
  await page.getByRole("button", { name: "Local", exact: true }).click();
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
  await page.getByRole("button", { name: "Show work-archive", exact: true }).click();
  const keepSession = page.getByRole("complementary", { name: "Selected work" });
  await keepSession.getByRole("button", { name: "Archive 1 other session", exact: true }).click();
  await keepSession.getByRole("button", { name: "Archive", exact: true }).click();
  await page.waitForFunction(() => window.qa.calls.some((call) => call.method === "archiveTask"));
  assert.deepEqual(
    await page.evaluate(() =>
      window.qa.calls.filter((call) => call.method === "archiveTask").map((call) => call.id),
    ),
    ["other-session"],
  );
  results.push("Work: archive keeps every run in the displayed session lineage");

  await page.getByRole("button", { name: "Show usage", exact: true }).click();
  const usageWorkspace = page.getByRole("combobox", { name: "Workspace", exact: true });
  const usageCount = page.locator(".insights-hero-value").getByText("101", { exact: true });
  await usageCount.waitFor();
  await usageWorkspace.selectOption("usage-beta");
  await page.waitForFunction(() => window.qa.rejectUsageReport);
  assert.equal(await usageCount.count(), 0);
  await page.getByRole("status").filter({ hasText: "Loading usage report" }).waitFor();
  await page.evaluate(() => window.qa.rejectUsageReport());
  await page.getByRole("alert").filter({ hasText: "Fixture report failed" }).waitFor();
  await usageWorkspace.selectOption("__all__");
  await usageCount.waitFor();
  results.push(
    "Usage Insights: a new workspace hides stale totals and filters stay available after failure",
  );
  await page.getByRole("button", { name: "Show memory", exact: true }).click();
  const cedarMemory = page.getByText("Cedar fixture memory", { exact: true });
  const quartzMemory = page.getByText("Quartz fixture memory", { exact: true });
  await cedarMemory.waitFor();
  await page.getByRole("button", { name: "Pin", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search memories" }).fill("quartz");
  await cedarMemory.waitFor({ state: "detached" });
  assert.equal(await page.getByRole("button", { name: "Delete", exact: true }).count(), 0);
  await page.waitForFunction(() => window.qa.resolveMemorySearch);
  await page.evaluate(() => window.qa.resolveMemorySearch());
  await quartzMemory.waitFor();
  await page.evaluate(() => window.qa.resolveMemoryPin());
  await page.getByText("Memory pinned.", { exact: true }).waitFor();
  await quartzMemory.waitFor();
  assert.equal(await cedarMemory.count(), 0);
  results.push(
    "Memory Knowledge: delayed pin cannot restore actions or results from a previous search",
  );

  await page.getByRole("button", { name: "Show spreadsheet", exact: true }).click();
  const workbookFormula = page.locator(".spreadsheet-viewer-formula-input");
  const saveWorkbook = page.getByRole("button", { name: "Save", exact: true });
  const firstCell = page.locator(".spreadsheet-viewer-grid-wrap td").first();
  await firstCell.getByText("Initial", { exact: true }).waitFor();
  await workbookFormula.fill("First edit");
  await saveWorkbook.click();
  await page.waitForFunction(() => window.qa.resolveWorkbookSave);
  assert.equal(await workbookFormula.isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "+ Row", exact: true }).isDisabled(), true);
  await firstCell.dblclick();
  assert.equal(await page.locator(".spreadsheet-viewer-cell-input").count(), 0);
  await page.evaluate(() => window.qa.resolveWorkbookSave());
  await firstCell.getByText("First edit", { exact: true }).waitFor();
  await firstCell.dblclick();
  await page.locator(".spreadsheet-viewer-cell-input").fill("Draft saved on click");
  await saveWorkbook.click();
  await page.waitForFunction(() => window.qa.resolveWorkbookSave);
  assert.equal(await page.evaluate(() => window.qa.workbookValue), "Draft saved on click");
  await page.evaluate(() => window.qa.resolveWorkbookSave());
  await firstCell.getByText("Draft saved on click", { exact: true }).waitFor();
  await page.getByRole("button", { name: "+ Row", exact: true }).click();
  await saveWorkbook.click();
  await page.waitForFunction(() => window.qa.resolveWorkbookSave);
  const patchCount = () =>
    page.evaluate(
      () => window.qa.calls.filter((call) => call.method === "applySpreadsheetPatches").length,
    );
  const applied = await patchCount();
  await page.evaluate(() => window.qa.resolveWorkbookSave(false));
  await page.getByText("Fixture workbook save failed", { exact: true }).waitFor();
  await saveWorkbook.click();
  await page.waitForFunction(() => window.qa.resolveWorkbookSave);
  assert.equal(await patchCount(), applied);
  await page.evaluate(() => window.qa.resolveWorkbookSave());
  results.push(
    "Spreadsheet: Save includes the open cell draft, locks edits, and retries without replaying applied patches",
  );

  await page.getByRole("button", { name: "Show document", exact: true }).click();
  const documentEditor = page.locator(".document-editor-page");
  const saveDocument = page.getByTitle("Save document", { exact: true });
  await page.waitForFunction(
    () => document.querySelector(".document-editor-page")?.textContent === "Initial draft",
  );
  await documentEditor.focus();
  await page.getByRole("button", { name: "Show document", exact: true }).focus();
  const cleanAfterBlur = await saveDocument.isDisabled();
  const appendToDocument = async (text) => {
    await documentEditor.evaluate((editor) => {
      editor.focus();
      const selection = window.getSelection();
      selection.selectAllChildren(editor.querySelector("p"));
      selection.collapseToEnd();
    });
    await page.keyboard.insertText(text);
  };
  await appendToDocument(" saved");
  await saveDocument.click();
  await page.waitForFunction(() => window.qa.finishDocumentSave);
  await appendToDocument(" and still editing");
  await page.evaluate(() => window.qa.finishDocumentSave());
  await page.waitForFunction(
    () => document.querySelector(".document-viewer-save-btn")?.textContent === "Save",
  );
  assert.deepEqual(
    {
      cleanAfterBlur,
      draft: await documentEditor.textContent(),
      canSave: await saveDocument.isEnabled(),
    },
    { cleanAfterBlur: true, draft: "Initial draft saved and still editing", canSave: true },
  );
  await page.getByRole("status").filter({ hasText: "You have unsaved changes." }).waitFor();
  await saveDocument.click();
  await page.waitForFunction(() => window.qa.finishDocumentSave);
  await page.evaluate(() => window.qa.finishDocumentSave(false));
  await page.getByText("Fixture document save failed", { exact: true }).waitFor();
  await saveDocument.click();
  await page.waitForFunction(() => window.qa.finishDocumentSave);
  await page.evaluate(() => window.qa.finishDocumentSave());
  await page.getByText("Saved", { exact: true }).waitFor();
  assert.equal(await saveDocument.isDisabled(), true);
  assert.deepEqual(
    await page.evaluate(() =>
      window.qa.calls
        .filter((call) => call.method === "updateDocumentFile")
        .map((call) => call.text),
    ),
    [
      "Initial draft saved",
      "Initial draft saved and still editing",
      "Initial draft saved and still editing",
    ],
  );
  results.push(
    "Document editor: content loads, a save preserves newer edits, and a failed save can be retried",
  );

  await page.getByRole("button", { name: "Show document-followup", exact: true }).click();
  const artifactDraft = page.getByPlaceholder("Ask for follow-up changes");
  const sendArtifactDraft = page.getByTitle("Send message", { exact: true });
  await artifactDraft.fill("Keep this follow-up");
  await sendArtifactDraft.click();
  await page.waitForFunction(() => window.qa.finishArtifactFollowup);
  const pendingDraft = await artifactDraft.inputValue();
  await page.evaluate(() => window.qa.finishArtifactFollowup(false));
  await page.waitForFunction(() => !window.qa.finishArtifactFollowup);
  assert.equal(pendingDraft, "Keep this follow-up");
  await page.getByText("Failed to send message. Please try again.", { exact: true }).waitFor();
  assert.equal(await artifactDraft.inputValue(), "Keep this follow-up");
  await sendArtifactDraft.click();
  await page.waitForFunction(() => window.qa.finishArtifactFollowup);
  await page.evaluate(() => window.qa.finishArtifactFollowup(true));
  await page.waitForFunction(
    () => document.querySelector('textarea[placeholder="Ask for follow-up changes"]')?.value === "",
  );
  assert.deepEqual(
    await page.evaluate(() =>
      window.qa.calls
        .filter((call) => call.method === "sendArtifactFollowup")
        .map((call) => call.message),
    ),
    ["Keep this follow-up", "Keep this follow-up"],
  );
  results.push("Artifact follow-up: rejected submissions keep the draft for a successful retry");

  await page.getByRole("button", { name: "Show skills", exact: true }).click();
  await page.getByRole("button", { name: "CoWork Registry", exact: true }).click();
  const skillSearch = page.getByRole("textbox", { name: "Search CoWork registry" });
  await skillSearch.fill("old");
  await skillSearch.press("Enter");
  await skillSearch.press("Enter");
  await page.waitForFunction(() => window.qa.pendingSkillSearches.has("old"));
  await skillSearch.fill("new");
  assert.equal(await page.getByText(/No results were returned/).count(), 0);
  await skillSearch.press("Enter");
  await page.waitForFunction(() => window.qa.pendingSkillSearches.has("new"));
  const resolveSkillSearch = (query, name) =>
    page.evaluate(
      ([keyword, resultName]) => {
        window.qa.pendingSkillSearches.get(keyword)({
          results: [{ id: keyword, name: resultName, description: "A fixture", version: "1.0.0" }],
        });
      },
      [query, name],
    );
  await resolveSkillSearch("new", "New fixture skill");
  await page.getByRole("heading", { name: "New fixture skill" }).waitFor();
  await resolveSkillSearch("old", "Old fixture skill");
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await page.getByRole("heading", { name: "New fixture skill" }).count(), 1);
  assert.equal(await page.getByRole("heading", { name: "Old fixture skill" }).count(), 0);
  assert.deepEqual(
    await page.evaluate(() =>
      window.qa.calls
        .filter((call) => call.method === "searchSkillRegistry")
        .map((call) => call.query),
    ),
    ["old", "new"],
  );
  await skillSearch.fill("draft");
  assert.equal(await page.getByRole("heading", { name: "New fixture skill" }).count(), 0);
  results.push(
    "Skill Store: duplicate submission is ignored and old results cannot replace a new query",
  );

  await page.getByRole("button", { name: "Show add-tools", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search tools" }).fill("workspace-retention");
  await page.getByRole("button", { name: /^Ops Audit/ }).click();
  assert.equal(
    await page.evaluate(
      () => window.qa.calls.find((call) => call.method === "navigateAddTools").selection.targetId,
    ),
    "ops-audit",
  );
  results.push("Add Tools: catalog matches by a hidden category keep their navigation target");

  await page.getByRole("button", { name: "Show mcp-tools", exact: true }).click();
  const alphaTools = page
    .locator('[data-mcp-server-id="alpha"]')
    .getByRole("button", { name: "View Tools", exact: true });
  await alphaTools.click();
  await page.waitForFunction(() => window.qa.pendingMcpTools.has("alpha"));
  const toolsDialog = page.getByRole("dialog", { name: "Tools from Alpha" });
  const showsLoading = await toolsDialog.getByRole("status").count();
  await page.evaluate(() => {
    window.qa.pendingMcpTools.get("alpha").reject(new Error("Fixture tool listing failed"));
    window.qa.pendingMcpTools.delete("alpha");
  });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(showsLoading, 1, "View Tools opens the dialog while loading");
  await toolsDialog.getByRole("alert").filter({ hasText: "Fixture tool listing failed" }).waitFor();
  await toolsDialog.getByRole("button", { name: "Try again" }).click();
  await page.waitForFunction(() => window.qa.pendingMcpTools.has("alpha"));
  await page.keyboard.press("Escape");
  assert.equal(await alphaTools.evaluate((button) => button.matches(":focus")), true);
  const betaTools = page
    .locator('[data-mcp-server-id="beta"]')
    .getByRole("button", { name: "View Tools", exact: true });
  await betaTools.click();
  await page.waitForFunction(() => window.qa.pendingMcpTools.has("beta"));
  await page.evaluate(() => {
    window.qa.pendingMcpTools
      .get("beta")
      .resolve([{ name: "beta_lookup", inputSchema: { type: "object" } }]);
    window.qa.pendingMcpTools
      .get("alpha")
      .resolve([{ name: "alpha_stale", inputSchema: { type: "object" } }]);
  });
  const betaDialog = page.getByRole("dialog", { name: "Tools from Beta" });
  await betaDialog.getByText("beta_lookup", { exact: true }).waitFor();
  assert.equal(await page.getByText("alpha_stale", { exact: true }).count(), 0);
  await page.keyboard.press("Escape");
  results.push(
    "MCP tools: listing failures are retryable and closed requests cannot overwrite another server",
  );

  await page.getByRole("button", { name: "Show build-changes", exact: true }).click();
  const openBuildChanges = page.getByRole("button", { name: "Review build changes", exact: true });
  await openBuildChanges.click();
  const buildChanges = page.getByRole("dialog", { name: "Build changes", exact: true });
  assert.equal(
    await buildChanges
      .getByRole("button", { name: "Close changes" })
      .evaluate((button) => button.matches(":focus")),
    true,
  );
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await buildChanges
      .getByRole("button", { name: "Open file" })
      .evaluate((button) => button.matches(":focus")),
    true,
  );
  await buildChanges.getByRole("button", { name: /removed\.md/ }).click();
  assert.equal(await buildChanges.getByRole("button", { name: "Open file" }).count(), 0);
  await page.keyboard.press("Escape");
  await buildChanges.waitFor({ state: "detached" });
  assert.equal(await openBuildChanges.evaluate((button) => button.matches(":focus")), true);
  results.push("Build Changes: traps and restores focus and omits Open file for deleted entries");

  await page.getByRole("button", { name: "Show model-picker", exact: true }).click();
  const modelTrigger = page.getByRole("button", { name: /^Change model source/ });
  const customModel = page.getByRole("button", { name: "Open custom model picker" });
  const advancedPicker = page.getByRole("dialog", { name: "Choose a model", exact: true });
  const modelSelections = () =>
    page.evaluate(() => window.qa.calls.filter((call) => call.method === "modelChange"));
  await modelTrigger.press("Enter");
  const quickFocusedCustom = await customModel.evaluate((button) => button.matches(":focus"));
  await page.keyboard.press("Enter");
  const quickSelections = (await modelSelections()).length;
  if (!(await advancedPicker.count())) {
    if (!(await customModel.count())) await modelTrigger.press("Enter");
    await customModel.click();
  }
  const modelSearch = advancedPicker.getByRole("textbox", { name: "Search Fixture source models" });
  await modelSearch.press("Enter");
  assert.deepEqual(
    { quickFocusedCustom, quickSelections, totalSelections: (await modelSelections()).length },
    { quickFocusedCustom: true, quickSelections: 0, totalSelections: 0 },
  );
  await modelSearch.fill("Selected fixture");
  await modelSearch.press("Enter");
  await advancedPicker.waitFor({ state: "detached" });
  assert.equal((await modelSelections())[0].selection.modelKey, "selected-model");
  assert.equal(await modelTrigger.evaluate((button) => button.matches(":focus")), true);
  await modelTrigger.press("ArrowDown");
  await customModel.press("Enter");
  await advancedPicker.getByRole("tab", { name: "Retry source", exact: true }).click();
  await page.waitForFunction(() => window.qa.modelCatalogAttempts === 1);
  await advancedPicker.getByRole("alert").filter({ hasText: "Could not load models." }).waitFor();
  await advancedPicker.getByRole("button", { name: "Retry", exact: true }).click();
  await advancedPicker.getByRole("option", { name: "Recovered fixture model" }).waitFor();
  await advancedPicker.getByRole("tab", { name: /Fixture source/ }).click();
  await modelSearch.press("Escape");
  await advancedPicker.waitFor({ state: "detached" });
  assert.equal(await modelTrigger.evaluate((button) => button.matches(":focus")), true);
  results.push("Model picker: keyboard opens Custom and an empty search cannot change the model");
  results.push("Model picker: a failed provider request is retryable without closing the picker");

  await page.getByRole("button", { name: "Show bot-history", exact: true }).click();
  const history = page.getByRole("region", { name: "Fixture Bot conversation history" });
  const earlier = history.getByRole("button", { name: /^Earlier fixture conversation/ });
  await earlier.press("Enter");
  assert.equal(await earlier.getAttribute("aria-current"), "true");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByText("Recovered fixture reply", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.qa.botHistoryAttempts), 2);
  results.push("Bots: conversation rows are keyboard buttons and Retry reloads earlier messages");

  await page.getByRole("button", { name: "Show mission-issue", exact: true }).click();
  await page.getByRole("button", { name: "Open Issue A", exact: true }).click();
  const firstComment = page.getByText("Comment for a", { exact: true });
  await firstComment.waitFor();
  await page.evaluate(() => {
    window.qa.holdMissionIssue = true;
  });
  await page.getByRole("button", { name: "Open Issue B", exact: true }).click();
  await firstComment.waitFor({ state: "detached" });
  await page.getByRole("status").filter({ hasText: "Loading issue details" }).waitFor();
  await page.waitForFunction(() => window.qa.resolveMissionIssue);
  await page.evaluate(() => window.qa.resolveMissionIssue());
  await page.getByText("Comment for b", { exact: true }).waitFor();
  results.push("Mission Control: selecting another issue hides the old context while details load");

  await page.getByRole("button", { name: "Show workspace", exact: true }).click();
  const alpha = page.getByRole("switch", { name: "Alpha in this conversation" });
  const beta = page.getByRole("switch", { name: "Beta in this conversation" });
  const workspaceHeader = page.locator(".workspace-scope-section .cli-section-header");
  if ((await workspaceHeader.getAttribute("aria-expanded")) === "false")
    await workspaceHeader.click();
  await alpha.click();
  assert.equal(await alpha.getAttribute("aria-checked"), "false");
  await beta.evaluate((button) => button.click());
  assert.equal(await page.evaluate(() => window.qa.connectorChanges.length), 1);
  assert.ok(await beta.isDisabled());
  await page.evaluate(() => window.qa.connectorChanges[0].reject(new Error("Fixture save failed")));
  await page.getByText("Could not save the connector change.", { exact: true }).waitFor();
  assert.equal(await alpha.getAttribute("aria-checked"), "true");
  await beta.click();
  await page.evaluate(() =>
    window.qa.connectorChanges[1].resolve({
      id: "scope-fixture",
      agentConfig: { connectorsOff: ["beta"] },
    }),
  );
  await page.getByText("Saving connector change…", { exact: true }).waitFor({ state: "detached" });
  assert.equal(await alpha.getAttribute("aria-checked"), "true");
  assert.equal(await beta.getAttribute("aria-checked"), "false");
  results.push("Workspace connectors: save one toggle at a time and report failed saves");

  await page.getByRole("button", { name: "Show search", exact: true }).click();
  const googlePrimary = page.getByRole("radio", { name: /Google Custom Search/ });
  const duckPrimary = page.getByRole("radio", { name: /DuckDuckGo/ });
  assert.ok(await googlePrimary.isChecked());
  await duckPrimary.check();
  await page.getByRole("button", { name: "Save Settings", exact: true }).click();
  await page.waitForFunction(() => window.qa.searchPrimary === "duckduckgo");
  assert.ok(await duckPrimary.isChecked());
  const searchSave = await page.evaluate(
    () => window.qa.calls.find((call) => call.method === "saveSearchSettings").options,
  );
  assert.equal(searchSave.fallbackProvider, null);
  results.push("Web Search: a Google-only setup can switch to DuckDuckGo as primary");

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

  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByRole("button", { name: /^Review approval/ }).click();
  const approval = page.getByRole("button", { name: "Approve once", exact: true });
  await approval.waitFor();
  await page.getByRole("button", { name: /^Completed workflow/ }).click();
  await page.waitForFunction(() => window.qa.resolveCompletedRunSteps);
  assert.equal(await approval.count(), 0);
  await page.getByText("Loading run steps…", { exact: true }).waitFor();
  await page.evaluate(() => window.qa.resolveCompletedRunSteps());
  const completedAction = page.getByText("Completed action", { exact: true });
  await completedAction.waitFor();
  const needsAttention = page.getByRole("checkbox", { name: "Needs attention" });
  await needsAttention.check();
  await completedAction.waitFor({ state: "detached" });
  await needsAttention.uncheck();
  await page.getByRole("button", { name: /^Review approval/ }).click();
  await approval.waitFor();
  await page.getByRole("button", { name: "Cancel run", exact: true }).click();
  await approval.waitFor({ state: "detached" });
  await page.locator(".studio-step-timeline").getByText("cancelled", { exact: true }).waitFor();
  results.push(
    "Automation Studio: approval controls belong to the visible run, and filtering and cancellation remove stale controls",
  );

  await page.getByRole("button", { name: "Show menus", exact: true }).click();
  const bell = page.getByRole("button", { name: /^Notifications\b/ });
  const notifications = page.getByRole("dialog", { name: "Notifications", exact: true });
  const reviewNotice = notifications.getByRole("button", { name: /^Review saved memories/ });
  await bell.focus();
  await page.keyboard.press("Enter");
  await notifications.waitFor();
  const focusedDialog = await notifications.evaluate((element) => element.matches(":focus"));
  await page.keyboard.press("Tab");
  const tabEntersDialog = await notifications.evaluate((element) =>
    element.contains(document.activeElement),
  );
  const hasReviewIndicator = (await reviewNotice.locator(".notif-row-open").count()) === 1;
  const fixtureWindow = await app.browserWindow(page);
  const initialSize = await fixtureWindow.evaluate((win) => win.getSize());
  await fixtureWindow.evaluate((win) => win.setSize(360, 520));
  await page.waitForFunction(() => innerWidth <= 360);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const fitsWindow = await notifications.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.left >= 0 && rect.right <= innerWidth;
  });
  await fixtureWindow.evaluate((win, size) => win.setSize(...size), initialSize);
  await notifications.getByRole("button", { name: "Dismiss", exact: true }).focus();
  await page.keyboard.press("Enter");
  const actions = await page.evaluate(() =>
    window.qa.calls.filter((call) => call.id === "memory-review").map((call) => call.method),
  );
  assert.deepEqual(
    { focusedDialog, tabEntersDialog, hasReviewIndicator, fitsWindow, actions },
    {
      focusedDialog: true,
      tabEntersDialog: true,
      hasReviewIndicator: true,
      fitsWindow: true,
      actions: ["deleteNotification"],
    },
  );
  await notifications.getByText("You're all caught up").waitFor();
  assert.equal(await notifications.evaluate((element) => element.matches(":focus")), true);
  await page.keyboard.press("Escape");
  await notifications.waitFor({ state: "hidden" });
  assert.equal(await bell.evaluate((element) => element.matches(":focus")), true);
  results.push("Notifications: keyboard entry, dismissal and Escape, review link, narrow viewport");

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
  await page.getByRole("button", { name: "Show folder-picker", exact: true }).click();
  const folderPicker = page.getByRole("button", { name: "Choose folder", exact: true });
  await folderPicker.focus();
  await page.keyboard.press("Enter");
  const currentFolder = page.getByRole("button", { name: /^Alpha folder/ });
  const removeFolder = page.getByRole("button", { name: "Remove Beta folder from CoWork" });
  await currentFolder.waitFor();
  const menuFocused = await currentFolder.evaluate((button) => button.matches(":focus"));
  await removeFolder.focus();
  await page.keyboard.press("Enter");
  const cancelRemoval = page.getByRole("button", { name: "Cancel", exact: true });
  await cancelRemoval.waitFor();
  const cancelFocused = await cancelRemoval.evaluate((button) => button.matches(":focus"));
  await page.keyboard.press("Escape");
  await removeFolder.waitFor();
  const removeFocused = await removeFolder.evaluate((button) => button.matches(":focus"));
  await page.keyboard.press("Escape");
  await currentFolder.waitFor({ state: "hidden" });
  assert.deepEqual(
    {
      menuFocused,
      cancelFocused,
      removeFocused,
      triggerFocused: await folderPicker.evaluate((button) => button.matches(":focus")),
      removed: await page.evaluate(() =>
        window.qa.calls.some((call) => call.method === "removeFolder"),
      ),
    },
    {
      menuFocused: true,
      cancelFocused: true,
      removeFocused: true,
      triggerFocused: true,
      removed: false,
    },
  );
  results.push(
    "Folder picker: keyboard focus enters the list, cancels removal, and returns to the trigger",
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
    const composerFolder = actualPage.locator(".welcome-view .calm-folder-button");
    await composerFolder.press("Enter");
    const composerFolderPicker = actualPage.getByRole("dialog", {
      name: "Choose a folder",
      exact: true,
    });
    await composerFolderPicker.waitFor();
    assert.equal(
      await composerFolderPicker.evaluate((element) => element.contains(document.activeElement)),
      true,
    );
    await actualPage.keyboard.press("Escape");
    await composerFolderPicker.waitFor({ state: "detached" });
    assert.equal(await composerFolder.evaluate((button) => button.matches(":focus")), true);
    results.push(
      "Actual app: the home composer folder picker accepts keyboard input and restores trigger focus",
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

    await actualWindow.evaluate((w) => w.setSize(1280, 800));
    const findUrl = `http://127.0.0.1:${port}/ui-audit-find-target.html`;
    const address = actualPage.getByRole("textbox", { name: "Browser URL", exact: true });
    await address.fill(findUrl);
    await address.press("Enter");
    await actualPage
      .getByRole("tab", { name: "Find fixture", exact: true })
      .waitFor({ state: "attached" });
    const findReadyDeadline = Date.now() + 5000;
    let findViewReady = false;
    while (!findViewReady && Date.now() < findReadyDeadline) {
      findViewReady = await actualWindow.evaluate(
        (win, url) =>
          win.contentView.children.some((view) => {
            if (view.webContents?.getURL() !== url || !view.getVisible()) return false;
            const bounds = view.getBounds();
            return bounds.width > 0 && bounds.height > 0;
          }),
        findUrl,
      );
      if (!findViewReady) await actualPage.waitForTimeout(50);
    }
    assert.ok(findViewReady, "Find fixture native view did not become visible");
    // Chromium's find highlights are outside the DOM. Count native clearSelection calls
    // on the disposable guest while still running the real Electron method.
    await app.evaluate(async ({ webContents }, url) => {
      const guest = webContents.getAllWebContents().find((contents) => contents.getURL() === url);
      if (!guest) throw new Error("Find fixture guest did not load");
      if (guest.isLoadingMainFrame()) {
        await new Promise((resolve) => guest.once("did-finish-load", resolve));
      }
      const paragraphs = await guest.executeJavaScript("document.querySelectorAll('p').length");
      if (paragraphs !== 2) throw new Error("Find fixture did not render both paragraphs");
      const find = guest.findInPage;
      const stop = guest.stopFindInPage;
      globalThis.uiAuditFind = { requests: 0, clears: 0, lastResult: null };
      guest.findInPage = function (text, options) {
        globalThis.uiAuditFind.requests++;
        return find.call(this, text, options);
      };
      guest.on("found-in-page", (_event, result) => {
        globalThis.uiAuditFind.lastResult = result;
      });
      guest.stopFindInPage = function (action) {
        if (action === "clearSelection") globalThis.uiAuditFind.clears++;
        return stop.call(this, action);
      };
    }, findUrl);
    const waitForFindClears = async (count) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if ((await app.evaluate(() => globalThis.uiAuditFind.clears)) >= count) return;
        await actualPage.waitForTimeout(50);
      }
      assert.fail(`Expected ${count} native find highlight clears`);
    };
    await address.press("ControlOrMeta+f");
    const findInput = actualPage.getByRole("textbox", { name: "Find in page", exact: true });
    const matchCount = actualPage.locator(".browser-workbench-findbar-count");
    // Drive the renderer control directly. The native guest can take focus
    // between Playwright focusing the input and sending text.
    const setFindQuery = (query) =>
      findInput.evaluate((input, value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, query);
    const waitForFindMatches = async () => {
      try {
        await matchCount.filter({ hasText: /of 2$/ }).waitFor();
      } catch (error) {
        const observed = await app.evaluate(() => globalThis.uiAuditFind);
        throw new Error(
          `Browser Find did not show both fixture matches: ${JSON.stringify(observed)}`,
          {
            cause: error,
          },
        );
      }
    };
    await setFindQuery("needle");
    await waitForFindMatches();
    await setFindQuery("");
    await waitForFindClears(1);
    assert.equal(await findInput.isVisible(), true);
    assert.equal(await matchCount.textContent(), "");
    await setFindQuery("needle");
    await waitForFindMatches();
    await actualPage.getByRole("button", { name: "New tab", exact: true }).click();
    await findInput.waitFor({ state: "detached" });
    await waitForFindClears(2);
    results.push("Actual app: Browser Find clears native highlights on erase and tab switch");
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
