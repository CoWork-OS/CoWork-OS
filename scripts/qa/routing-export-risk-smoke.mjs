#!/usr/bin/env node
// Controlled requests in the real Electron app. No model, external send, or real profile.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { _electron } from "playwright";
import { createServer } from "vite";
import { launchCoworkDesktop } from "./electron-launch.mjs";

const root = process.cwd();
const require = createRequire(import.meta.url);
const productionRenderer = process.env.COWORK_SMOKE_PRODUCTION_RENDERER === "1";
const firstRun = productionRenderer && process.env.COWORK_SMOKE_FIRST_RUN === "1";
const output = path.resolve(
  productionRenderer
    ? firstRun
      ? "output/playwright/bundle-first-run"
      : "output/playwright/bundle-optimization"
    : "output/playwright/routing-export-risk",
);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-routing-export-risk-"));
fs.mkdirSync(output, { recursive: true });
process.env.COWORK_USER_DATA_DIR = profile;
delete process.env.COWORK_PROFILE;
delete process.env.COWORK_PROFILE_ID;
const { DatabaseManager } = require(path.join(root, "dist/electron/electron/database/schema.js"));
const { SecureSettingsRepository } = require(
  path.join(root, "dist/electron/electron/database/SecureSettingsRepository.js"),
);
const { WorkspaceStore, TaskStore, TaskEventRepository } = require(
  path.join(root, "dist/electron/electron/database/repositories.js"),
);
const seed = new DatabaseManager();
let taskId;
const diagramCases = [
  {
    title: "Bundle diagrams",
    charts: [
      "---\nconfig:\n  layout: dagre\n---\nflowchart TD\nA[Start] --> B[Finish]",
      "---\nconfig:\n  layout: elk\n---\nflowchart TD\nA[Input] --> B[Worker]\nB --> C[Output]",
      'packet-beta\n0-15: "Header"\n16-31: "Payload"',
      "architecture-beta\nservice a[Client]\nservice b[Server]\na:R -- L:b",
    ],
  },
  { title: "Invalid diagram", charts: ["flowchart TD\nA -->"] },
  { title: "Diagram recovery", charts: ["flowchart LR\nRecovered --> Safe"] },
  {
    title: "ELK interrupted",
    charts: [
      "---\nconfig:\n  layout: elk\n---\nflowchart TD\n" +
        Array.from({ length: 350 }, (_, index) => `N${index} --> N${index + 1}`).join("\n"),
    ],
  },
];
try {
  new SecureSettingsRepository(seed.getDatabase()).save("appearance", {
    themeMode: "light",
    visualTheme: "calm",
    accentColor: "cyan",
    uiDensity: "focused",
    disclaimerAccepted: true,
    onboardingCompleted: !firstRun,
  });
  const workspacePath = path.join(profile, "workspace");
  fs.mkdirSync(path.join(workspacePath, "private"), { recursive: true });
  fs.writeFileSync(
    path.join(workspacePath, "private/report.pdf"),
    "Synthetic report for approval UI verification.",
  );
  const longDirectory = path.join(workspacePath, ...Array(32).fill("synthetic-report-directory"));
  fs.mkdirSync(longDirectory, { recursive: true });
  fs.writeFileSync(path.join(longDirectory, "report.pdf"), "Synthetic long path approval fixture.");
  const workspace = new WorkspaceStore(seed.getDatabase()).create(
    "Approval verification",
    workspacePath,
    {
      read: true,
      write: true,
      delete: false,
      shell: false,
      network: false,
    },
  );
  taskId = new TaskStore(seed.getDatabase()).create({
    title: "Export risk verification",
    prompt: "Controlled approval fixture; no execution.",
    workspaceId: workspace.id,
    status: "paused",
    source: "api",
    agentConfig: { accessProfileId: "ask_for_approval" },
  }).id;
  if (productionRenderer) {
    const tasks = new TaskStore(seed.getDatabase());
    const events = new TaskEventRepository(seed.getDatabase());
    for (const item of diagramCases) {
      const task = tasks.create({
        title: item.title,
        prompt: "Synthetic diagram acceptance; no execution.",
        workspaceId: workspace.id,
        status: "completed",
        source: "api",
      });
      events.create({
        taskId: task.id,
        type: "assistant_message",
        timestamp: Date.now(),
        payload: {
          message: item.charts.map((chart) => "```mermaid\n" + chart + "\n```").join("\n\n"),
        },
      });
    }
  }
} finally {
  seed.close();
}

let electron;
let server;
let page;
const results = {
  profile,
  output,
  renderer: productionRenderer ? "production file assets" : "Vite development server",
  checks: [],
  rendererErrors: [],
};
let mainUrl;
try {
  if (productionRenderer) {
    mainUrl = pathToFileURL(path.join(root, "dist/renderer/index.html")).href;
  } else {
    server = await createServer({
      configFile: path.join(root, "vite.config.mts"),
      clearScreen: false,
      server: { host: "127.0.0.1", port: 0, strictPort: false },
    });
    await server.listen();
    mainUrl = server.resolvedUrls.local[0];
  }
  const env = {
    ...process.env,
    NODE_ENV: productionRenderer ? "production" : "development",
    COWORK_DEV_SERVER_URL: productionRenderer ? "" : mainUrl,
    COWORK_PROFILE_QUIET: "1",
    COWORK_STARTUP_QUIET: "1",
    COWORK_BACKGROUND_AUTOSTART: "0",
    COWORK_DISABLE_UPDATE_CHECK: "1",
    COWORK_APPROVAL_PROMPTS: "on",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  electron = await launchCoworkDesktop(_electron, { root, env, timeout: 120_000 });
  electron.process().stdout?.on("data", (data) => process.stdout.write(data));
  electron.process().stderr?.on("data", (data) => process.stderr.write(data));
  // macOS briefly opens a keychain bootstrap window before the real app window.
  page =
    electron.windows().find((window) => window.url().startsWith(mainUrl)) ??
    (await electron.waitForEvent("window", {
      timeout: 120_000,
      predicate: async (window) => {
        try {
          await window.waitForFunction(
            () => typeof globalThis.window.electronAPI?.listTaskSkills === "function",
            undefined,
            { timeout: 60_000 },
          );
          return true;
        } catch {
          return false;
        }
      },
    }));
  page.on("pageerror", (error) => results.rendererErrors.push(error.message));
  await page.waitForFunction(
    () => typeof window.electronAPI?.listTaskSkills === "function",
    undefined,
    { timeout: 60_000 },
  );
  await page.evaluate(() => window.electronAPI.listTaskSkills());
  if (firstRun) {
    await page.locator(".cinematic-onboarding").waitFor({ timeout: 60_000 });
    await page.screenshot({ path: path.join(output, "production-onboarding.png") });
    await page.getByRole("button", { name: "Skip onboarding", exact: true }).click();
    results.checks.push(
      "production first-run Onboarding chunk loads and exits through its real Skip control",
    );
  }
  await page.getByRole("button", { name: "New session", exact: true }).waitFor({ timeout: 60_000 });
  await electron.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.closeDevTools();
  });

  if (productionRenderer) {
    const buildReport = JSON.parse(
      fs.readFileSync(path.join(root, "tmp/qa/bundle-build-renderer.json"), "utf8"),
    );
    const featureChunks = Object.fromEntries(
      [
        "Onboarding/Onboarding.tsx",
        "calm/LibraryPanel.tsx",
        "calm/BuildPanel.tsx",
        "BotDetailsRail.tsx",
        "MainContent/TaskConversationFlow.tsx",
      ].map((feature) => [
        feature,
        buildReport.chunks.find((chunk) =>
          chunk.modules.some((module) => module.id.endsWith(`/components/${feature}`)),
        )?.fileName,
      ]),
    );
    // Chromium's Resource Timing list is empty for file:// documents. Its actual
    // resource tree still records modules fetched by the production renderer.
    const cdp = await page.context().newCDPSession(page);
    const executedScripts = new Set();
    cdp.on("Debugger.scriptParsed", ({ url }) => {
      if (url) executedScripts.add(url);
    });
    // Enabling the debugger reports existing scripts as well as later imports.
    // Unlike the frame resource cache, this includes executed dynamic modules.
    await cdp.send("Debugger.enable");
    await cdp.send("Page.enable");
    const resources = async () => {
      const { frameTree } = await cdp.send("Page.getResourceTree");
      const entries = [];
      const visit = (frame) => {
        entries.push(...frame.resources.map((resource) => resource.url));
        for (const child of frame.childFrames ?? []) visit(child);
      };
      visit(frameTree);
      return [...new Set([...entries, ...executedScripts])];
    };
    results.initialResources = await resources();
    assert(
      results.initialResources.some((url) => /\/assets\/index-[^/]+\.js$/.test(url)),
      "Production resource inventory must include the actual entry script",
    );
    results.featureChunks = featureChunks;
    for (const feature of [
      "calm/LibraryPanel.tsx",
      "calm/BuildPanel.tsx",
      "BotDetailsRail.tsx",
      ...(!firstRun ? ["Onboarding/Onboarding.tsx"] : []),
    ]) {
      assert(featureChunks[feature], `Missing compiled feature chunk: ${feature}`);
      assert(
        !results.initialResources.some((url) => url.endsWith("/" + featureChunks[feature])),
        `Optional feature loaded before use: ${feature}`,
      );
    }
    await page.evaluate(() => {
      performance.setResourceTimingBufferSize(10000);
      const NativeWorker = window.Worker;
      window.__bundleWorkers = [];
      window.Worker = class extends NativeWorker {
        constructor(...args) {
          super(...args);
          this.trace = { url: String(args[0]), terminated: false };
          window.__bundleWorkers.push(this.trace);
        }
        terminate() {
          this.trace.terminated = true;
          super.terminate();
        }
      };
    });
    await page.getByRole("button", { name: "Bundle diagrams", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll(".mermaid-diagram svg").length === 4,
      undefined,
      { timeout: 60_000 },
    );
    results.lightDiagramFill = await page
      .locator(".mermaid-diagram svg text")
      .first()
      .evaluate((element) => getComputedStyle(element).fill);
    assert.equal(await page.locator(".mermaid-error").count(), 0);
    assert.equal(
      await page
        .locator(
          ".mermaid-diagram script, .mermaid-diagram foreignObject, .mermaid-diagram [onclick], .mermaid-diagram [href^='javascript:']",
        )
        .count(),
      0,
    );
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await composer.fill("Preserve this unsent draft across lazy task navigation.");
    await page.getByRole("button", { name: "Invalid diagram", exact: true }).click();
    await page.locator(".mermaid-error").waitFor();
    assert.equal(
      await page.locator('body > div[id^="dmermaid-"]').count(),
      0,
      "Rejected diagrams must retain their inline error without orphaned Mermaid DOM",
    );
    await page.getByRole("button", { name: "Diagram recovery", exact: true }).click();
    await page.locator(".mermaid-diagram svg").waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Bundle diagrams", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll(".mermaid-diagram svg").length === 4,
    );
    await page.waitForFunction(
      () =>
        document.querySelector('[role="textbox"][aria-label="Message"]')?.textContent ===
        "Preserve this unsent draft across lazy task navigation.",
    );
    assert.equal(
      await composer.innerText(),
      "Preserve this unsent draft across lazy task navigation.",
    );
    assert.equal(await page.locator('body > div[id^="dmermaid-"]').count(), 0);
    await composer.fill("");
    await page.screenshot({ path: path.join(output, "production-diagrams.png"), fullPage: true });
    results.diagramWorkers = await page.evaluate(() => window.__bundleWorkers);
    const elkWorkers = results.diagramWorkers.filter((worker) => worker.url.includes("elk-worker"));
    assert(elkWorkers.length >= 2, "Repeated ELK renders must execute in native workers");
    assert(
      elkWorkers.every((worker) => worker.terminated),
      "Every ELK worker must be released",
    );
    results.checks.push(
      "production chunks: Dagre/ELK/packet/architecture diagrams, parse error and recovery, strict SVG content, task-scoped unsent draft restoration, repeated worker cleanup",
    );
    await page.locator('.sidebar-rail button[aria-label="Home"]').click();
    for (const [name, selector] of [
      ["Library", ".calm-library"],
      ["Build", ".calm-build"],
    ]) {
      const button = page.locator(`.sidebar-rail button[aria-label="${name}"]`);
      if (await button.count()) await button.click();
      else {
        await page.locator('.sidebar-rail button[aria-label="More"]').click();
        await page.getByRole("menuitem", { name, exact: true }).click();
      }
      await page.locator(selector).waitFor();
      results.checks.push(`production lazy ${name} view loads through navigation`);
    }
    await page.locator('.sidebar-rail button[aria-label="Settings"]').click();
    await page.locator('.settings-nav-item[data-tab="appearance"]').click();
    await page.getByRole("button", { name: "Dark", exact: true }).click();
    await page.locator('.sidebar-rail button[aria-label="Home"]').click();
    await page.getByRole("button", { name: "Bundle diagrams", exact: true }).click();
    await page.waitForFunction(
      () =>
        !document.documentElement.classList.contains("theme-light") &&
        document.querySelectorAll(".mermaid-diagram svg").length === 4,
    );
    await page.screenshot({
      path: path.join(output, "production-diagrams-dark.png"),
      fullPage: true,
    });
    assert.equal(await page.locator(".mermaid-error").count(), 0);
    results.darkDiagramFill = await page
      .locator(".mermaid-diagram svg text")
      .first()
      .evaluate((element) => getComputedStyle(element).fill);
    assert.notEqual(
      results.darkDiagramFill,
      results.lightDiagramFill,
      "Theme change must update actual SVG text styling",
    );
    results.checks.push(
      "production lazy Settings and appearance change retain diagram rendering in dark mode",
    );
    await page.locator('.sidebar-rail button[aria-label="Home"]').click();
    await page.getByRole("button", { name: "ELK interrupted", exact: true }).click();
    await page.waitForFunction(() =>
      window.__bundleWorkers.some(
        (worker) => worker.url.includes("elk-worker") && !worker.terminated,
      ),
    );
    // Home returns to the current conversation; New session actually deselects
    // it and unmounts its history while retaining the workspace.
    await page.getByRole("button", { name: "New session", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".mermaid-diagram").length === 0);
    await page.waitForFunction(() =>
      window.__bundleWorkers
        .filter((worker) => worker.url.includes("elk-worker"))
        .every((worker) => worker.terminated),
    );
    assert.equal(
      await page.locator(".mermaid-diagram").count(),
      0,
      "An unmounted chart must not commit a late SVG",
    );
    await page.getByRole("button", { name: "Diagram recovery", exact: true }).click();
    await page.locator(".mermaid-diagram svg").waitFor();
    results.checks.push(
      "unmount during ELK work does not commit stale SVG; worker is released after settlement and a later chart renders",
    );
    results.finalResources = await resources();
    for (const feature of [
      "calm/LibraryPanel.tsx",
      "calm/BuildPanel.tsx",
      "MainContent/TaskConversationFlow.tsx",
    ]) {
      assert(
        results.finalResources.some((url) => url.endsWith("/" + featureChunks[feature])),
        `Feature chunk was not requested through its real interaction: ${feature}`,
      );
    }
    await page.locator('.sidebar-rail button[aria-label="Home"]').click();
  }

  const routing = await electron.evaluate(async (_, repo) => {
    const require = process.getBuiltinModule("module").createRequire(repo + "/package.json");
    const { getCustomSkillLoader } = require(
      repo + "/dist/electron/electron/agent/custom-skill-loader.js",
    );
    const loader = getCustomSkillLoader();
    await loader.initialize();
    return [
      { query: "Use nano-pdf to rotate the pages of this document.", expected: "nano-pdf" },
      { query: "Use Playwright QA to check the checkout page.", expected: "playwright-qa" },
      {
        query: "Do not use nano-pdf; instead use summarize-folder for a directory overview.",
        expected: "summarize-folder",
        forbidden: "nano-pdf",
      },
      { query: "Do not run Codex CLI; inspect this file yourself.", forbidden: "codex-cli" },
      { query: "Do not use Gemini. The Gemini skill requires a key.", forbidden: "gemini" },
      {
        query: "Do not use the codex-cli skill. The codex-cli skill is unavailable.",
        forbidden: "codex-cli",
      },
      {
        query: "Do not use codex-cli. The Codex CLI Agent skill requires a key.",
        forbidden: "codex-cli",
      },
      {
        query: "Use Gemini to summarize this text. Actually do not use Gemini.",
        forbidden: "gemini",
      },
      { query: "Use Gemini CLI to summarize this text.", expected: "gemini" },
      { query: "Run codex-cli --help", expected: "codex-cli" },
      {
        query:
          "Use when the user asks to run Codex CLI, OpenCode, or Pi Coding Agent via background process for programmatic control.",
        expected: "coding-agent",
        forbidden: "codex-cli",
      },
      { query: "Explain when to run Codex CLI to summarize a file.", forbidden: "codex-cli" },
      { query: "When you are ready, run Codex CLI --help.", expected: "codex-cli" },
      {
        query: "Explain when to run Gemini CLI. Then run Gemini CLI to summarize this text.",
        expected: "gemini",
      },
      { query: "Gemini: provide an actionable result.", forbidden: "gemini" },
      { query: "Use the gog skill for this request.", forbidden: "gog" },
      { query: "Use the himalaya skill for this request.", forbidden: "himalaya" },
      {
        query: "Fix this bug without refactoring unrelated modules.",
        forbidden: "karpathy-guidelines",
      },
      {
        query: "Do not use Gemini for file edits. Use Gemini to summarize this text.",
        expected: "gemini",
      },
      {
        query: "Analyze a CSV export and summarize trends.",
        expected: "analyze-csv",
        expectedRank: 3,
      },
      {
        query: "Review this Terraform module for security issues.",
        expected: "terraform-ops",
        expectedRank: 3,
      },
      {
        query: "Build and test this frontend in the browser.",
        expected: "playwright-qa",
        expectedRank: 3,
      },
    ].map((item) => ({
      ...item,
      ranked: loader
        .rankModelInvocableSkillsForQuery(item.query)
        .map((match) => ({ id: match.skill.id, score: match.score })),
    }));
  }, root);
  for (const item of routing) {
    // Named invocations must win; task descriptions use the corpus's top-three criterion.
    // The live app also has plugin skills (e.g. Terraform Plan Review), unlike the bundled corpus.
    if (item.expected)
      assert(
        item.ranked.slice(0, item.expectedRank ?? 1).some((match) => match.id === item.expected),
        JSON.stringify(item),
      );
    if (item.forbidden)
      assert(!item.ranked.some((match) => match.id === item.forbidden), JSON.stringify(item));
  }
  results.routing = routing;
  results.checks.push("production runtime routing inside the running Electron main process");

  // Exercise Chromium's real event signature and the production Canvas listener.
  // This also protects the severity mapping that the old positional API supplied.
  results.canvasConsole = await electron.evaluate(
    async (_, args) => {
      const require = process.getBuiltinModule("module").createRequire(args.root + "/package.json");
      const { CanvasManager } = require(
        args.root + "/dist/electron/electron/canvas/canvas-manager.js",
      );
      const { DatabaseManager } = require(args.root + "/dist/electron/electron/database/schema.js");
      const { TaskStore } = require(args.root + "/dist/electron/electron/database/repositories.js");
      const db = new DatabaseManager();
      const manager = CanvasManager.getInstance();
      const previousCallback = manager.eventCallback;
      let canvas;
      const events = [];
      let timeout;
      try {
        const task = new TaskStore(db.getDatabase()).findById(args.taskId);
        canvas = await manager.createSession(args.taskId, task.workspaceId, "Console event QA");
        const received = new Promise((resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Canvas console events were not forwarded")),
            5000,
          );
          manager.setEventCallback((event) => {
            previousCallback?.(event);
            if (event.sessionId === canvas.id && event.console?.message.startsWith("qa-console-")) {
              events.push(event.console);
              if (events.length === 4) resolve();
            }
          });
        });
        await manager.evalScript(
          canvas.id,
          `
        console.debug("qa-console-debug");
        console.info("qa-console-info");
        console.warn("qa-console-warning");
        console.error("qa-console-error");
        true;
      `,
        );
        await received;
        return events;
      } finally {
        clearTimeout(timeout);
        manager.eventCallback = previousCallback;
        if (canvas) await manager.closeSession(canvas.id);
        db.close();
      }
    },
    { root, taskId },
  );
  assert.deepEqual(results.canvasConsole, [
    { level: "log", message: "qa-console-debug" },
    { level: "info", message: "qa-console-info" },
    { level: "warn", message: "qa-console-warning" },
    { level: "error", message: "qa-console-error" },
  ]);
  results.checks.push("real Chromium console events retain all four Canvas severity mappings");

  // The Devices view selects remote devices. Supply only read-only device IPC
  // data in this isolated process; no gateway connection or device action runs.
  // Production preload, Team navigation, and Devices rendering remain in use.
  await electron.evaluate(({ ipcMain }, repo) => {
    const require = process.getBuiltinModule("module").createRequire(repo + "/package.json");
    const { IPC_CHANNELS } = require(repo + "/dist/electron/shared/types.js");
    const device = {
      id: "qa-remote-device",
      name: "QA remote device",
      role: "remote",
      purpose: "general",
      transport: "direct",
      status: "connected",
      platform: "darwin",
    };
    ipcMain.removeHandler(IPC_CHANNELS.DEVICE_LIST_MANAGED);
    ipcMain.handle(IPC_CHANNELS.DEVICE_LIST_MANAGED, () => ({ ok: true, devices: [device] }));
    ipcMain.removeHandler(IPC_CHANNELS.DEVICE_GET_SUMMARY);
    ipcMain.handle(IPC_CHANNELS.DEVICE_GET_SUMMARY, (_, id) => ({
      ok: id === device.id,
      summary: {
        device,
        tasks: { total: 0, active: 0, attention: 0, recent: [] },
        apps: {
          channelsTotal: 0,
          channelsEnabled: 0,
          workspacesTotal: 0,
          approvalsPending: 0,
          inputRequestsPending: 0,
          accountsTotal: 0,
          channels: [],
          accounts: [],
        },
        storage: { workspaceCount: 0, artifactCount: 0, workspaceRoots: [] },
        alerts: [],
        observer: [],
      },
    }));
  }, root);
  await page.locator('.sidebar-rail button[aria-label="Team"]').click();
  await page.locator(".team-view-device:not(.team-view-device-add)").first().click();
  const health = page.locator(".dp-support-card").filter({ hasText: "Resource Health" });
  await health.locator(".dp-support-stats strong").first().waitFor();
  const healthLabels = await health.locator(".dp-support-stats strong").allTextContents();
  assert.deepEqual(healthLabels, ["—", "—", "—"]);
  await page.screenshot({ path: path.join(output, "device-health-unavailable.png") });
  results.deviceHealth = {
    labels: healthLabels,
    journey: "Team → Devices → Resource Health",
    fixture: "controlled remote-summary IPC data; production preload and renderer",
  };
  results.checks.push("unmeasured device health is shown as unavailable in the real Devices view");
  await page.locator('.sidebar-rail button[aria-label="Home"]').click();

  async function showApproval(mode) {
    return electron.evaluate(
      ({ BrowserWindow }, args) => {
        const require = process
          .getBuiltinModule("module")
          .createRequire(args.root + "/package.json");
        const { DatabaseManager } = require(
          args.root + "/dist/electron/electron/database/schema.js",
        );
        const { ApprovalStore, TaskStore } = require(
          args.root + "/dist/electron/electron/database/repositories.js",
        );
        const { buildPermissionSecurityContext } = require(
          args.root + "/dist/electron/electron/agent/security/export-permission-context.js",
        );
        const { FileProvenanceRegistry } = require(
          args.root + "/dist/electron/electron/security/file-provenance-registry.js",
        );
        const { WorkspaceStore } = require(
          args.root + "/dist/electron/electron/database/repositories.js",
        );
        const db = new DatabaseManager();
        try {
          const task = new TaskStore(db.getDatabase()).findById(args.taskId);
          const workspace = new WorkspaceStore(db.getDatabase()).findById(task.workspaceId);
          const browserUpload = args.mode === "browser-long";
          const outgoingPath = browserUpload
            ? Array(32).fill("synthetic-report-directory").join("/") + "/report.pdf"
            : "private/report.pdf";
          const tool = browserUpload ? "browser_upload_file" : "http_request";
          const recent =
            args.mode === "untrusted"
              ? [
                  FileProvenanceRegistry.record({
                    path: workspace.path + "/incoming.txt",
                    sourceKind: "channel_attachment",
                    trustLevel: "untrusted",
                    sourceLabel: "Incoming email",
                  }),
                ]
              : [];
          const securityContext =
            args.mode === "legacy"
              ? undefined
              : buildPermissionSecurityContext({
                  workspace,
                  toolName: tool,
                  toolInput: {
                    path: outgoingPath,
                    method: browserUpload ? undefined : "POST",
                    url: "https://uploads.example.com/submit",
                  },
                  recentSensitiveSources: recent,
                });
          const store = new ApprovalStore(db.getDatabase());
          const saved = store.create({
            taskId: args.taskId,
            type: browserUpload ? "browser" : "data_export",
            description: browserUpload
              ? "Allow upload of the synthetic report?"
              : "Review sending the synthetic report to uploads.example.com",
            status: "pending",
            requestedAt: Date.now(),
            details: {
              tool,
              ...(browserUpload
                ? {
                    kind: "browser_upload",
                    filePath: outgoingPath,
                    host: "uploads.example.com",
                    browserSessionId: "export-risk-qa",
                  }
                : {}),
              permissionPrompt: {
                securityContext,
                scopePreview: "POST uploads.example.com",
                reason: { type: "mode", mode: "default", summary: "Review this external action." },
                suggestedActions: [
                  { action: "deny_once", label: "Deny once", effect: "deny" },
                  { action: "allow_once", label: "Allow once", effect: "allow" },
                ],
              },
            },
          });
          const approval = store.findById(saved.id);
          const win = BrowserWindow.getAllWindows().find(
            (window) =>
              !window.isDestroyed() && window.webContents.getURL().startsWith(args.mainUrl),
          );
          win.webContents.send("task:event", {
            id: "qa-" + saved.id,
            taskId: args.taskId,
            type: "approval_requested",
            timestamp: Date.now(),
            payload: { approval },
          });
          return approval;
        } finally {
          db.close();
        }
      },
      { root, taskId, mode, mainUrl },
    );
  }

  for (const mode of ["untrusted", "trusted", "legacy", "browser-long"]) {
    const browserUpload = mode === "browser-long";
    if (browserUpload) {
      await page.getByRole("button", { name: "Export risk verification", exact: true }).click();
      const opened = await electron.evaluate(
        async (_, args) => {
          const require = process
            .getBuiltinModule("module")
            .createRequire(args.root + "/package.json");
          const { getBrowserWorkbenchService } = require(
            args.root + "/dist/electron/electron/browser/browser-workbench-service.js",
          );
          return Boolean(
            await getBrowserWorkbenchService().requestOpen({
              taskId: args.taskId,
              sessionId: "export-risk-qa",
              url: "about:blank",
            }),
          );
        },
        { root, taskId },
      );
      assert(opened, "The real browser workbench registered its session");
      await electron.evaluate(({ BrowserWindow }, url) => {
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL().startsWith(url))
          .setSize(1080, 700);
      }, mainUrl);
    }
    const approval = await showApproval(mode);
    const dialog = browserUpload
      ? page.getByRole("alertdialog", {
          name: "Allow upload of the synthetic report?",
          exact: true,
        })
      : page
          .getByRole("dialog")
          .filter({ has: page.getByRole("heading", { name: "Data export", exact: true }) });
    await dialog.waitFor({ state: "visible", timeout: 15_000 });
    const explanation = dialog.getByRole("region", { name: "Export risk explanation" });
    if (mode !== "legacy") {
      await explanation.waitFor({ state: "visible" });
      const text = await explanation.innerText();
      assert(text.includes(browserUpload ? "synthetic-report-directory/" : "private/report.pdf"));
      assert(text.includes("uploads.example.com"));
      assert(
        text.includes(browserUpload ? "browser_upload_file export" : "http_request POST export"),
      );
      assert.equal(text.includes("Incoming email"), mode === "untrusted");
    } else {
      assert.equal(await explanation.count(), 0);
    }
    if (browserUpload) {
      const layout = await dialog.evaluate((card) => {
        const risk = card.querySelector(".export-risk-review");
        const buttons = [...card.querySelectorAll("button")].map((button) => {
          const { top, bottom, left, right } = button.getBoundingClientRect();
          return { top, bottom, left, right };
        });
        return {
          riskHeight: risk.clientHeight,
          scrollHeight: risk.scrollHeight,
          buttons,
          width: innerWidth,
          height: innerHeight,
        };
      });
      assert(
        layout.scrollHeight > layout.riskHeight,
        "Long paths remain readable in a bounded scrolling explanation",
      );
      assert(
        layout.buttons.every(
          (button) =>
            button.top >= 0 &&
            button.bottom <= layout.height &&
            button.left >= 0 &&
            button.right <= layout.width,
        ),
        JSON.stringify(layout),
      );
      results.browserLayout = layout;
    }
    await page.screenshot({ path: path.join(output, `approval-${mode}.png`) });
    if (browserUpload && Number(process.env.COWORK_QA_REVIEW_PAUSE_MS) > 0) {
      console.log("Approval ready for native visual review");
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(Number(process.env.COWORK_QA_REVIEW_PAUSE_MS), 30_000)),
      );
    }
    await dialog
      .getByRole("button", { name: browserUpload ? "Deny" : "Deny once", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden", timeout: 15_000 });
    const status = await electron.evaluate(
      (_, args) => {
        const require = process
          .getBuiltinModule("module")
          .createRequire(args.root + "/package.json");
        const { DatabaseManager } = require(
          args.root + "/dist/electron/electron/database/schema.js",
        );
        const db = new DatabaseManager();
        try {
          return db.getDatabase().prepare("SELECT status FROM approvals WHERE id = ?").get(args.id)
            .status;
        } finally {
          db.close();
        }
      },
      { root, id: approval.id },
    );
    assert.equal(status, "denied");
    results.checks.push(
      `${mode}: real approval IPC, visible presentation, deny action, persisted denial`,
    );
  }
  assert.deepEqual(results.rendererErrors, []);
  if (productionRenderer) {
    results.diagramWorkers = await page.evaluate(() => window.__bundleWorkers);
    assert(
      results.diagramWorkers
        .filter((worker) => worker.url.includes("elk-worker"))
        .every((worker) => worker.terminated),
    );
  }
  results.success = true;
} finally {
  if (!results.success && page && !page.isClosed()) {
    await page.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
    results.failureVisibleText = await page
      .locator("body")
      .innerText()
      .catch(() => "");
  }
  fs.writeFileSync(path.join(output, "evidence.json"), JSON.stringify(results, null, 2) + "\n");
  await electron?.close();
  await server?.close();
}
console.log(JSON.stringify(results, null, 2));
