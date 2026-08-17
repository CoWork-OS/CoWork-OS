#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";

const repoRoot = process.cwd();
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const DEFAULT_CDP_PORT = 9333;
const DEFAULT_DEV_SERVER_PORT = 5173;
const DEFAULT_SWITCHES = 8;
const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
const DEFAULT_SWITCH_TIMEOUT_MS = 5_000;
const DEFAULT_SETTLE_MS = 150;
const DEFAULT_FIXTURE_TASKS = 12;
const DEFAULT_FIXTURE_EVENTS = 8;
const METRIC_NAMES = [
  "mark.task_switch_start_at_ms",
  "mark.task_header_ready_at_ms",
  "mark.timeline_data_received_at_ms",
  "mark.timeline_first_rows_ready_at_ms",
  "renderer.frame_gap_ms",
  "renderer.long_task_ms",
  "task-switch.header_ready_ms",
  "task-switch.timeline_data_received_ms",
];
const BACKGROUND_BEFORE_SIDEBAR_PATTERN =
  /\b(mcp-auto-connect|connectEnabledChannels|MailboxService|mailbox.*sync|auto.?sync|HeartbeatService|SubconsciousLoopService|subconscious|ChannelGateway|WhatsApp|Discord|AppUpdater|update check|AutonomyEngine|AwarenessService)\b/i;

const BUDGET_PROFILES = {
  prod: {
    taskHeaderReadyP95Ms: 75,
    timelineDataReceivedP95Ms: 75,
    timelineFirstRowsReadyP95Ms: 125,
    longTaskMaxMs: 80,
    frameGapMaxMs: 120,
    appShellReadyMs: 2_000,
    sidebarReadyMs: 4_000,
    timelinePageSerializedP95Bytes: 768 * 1024,
    timelinePageSerializedMaxBytes: 1024 * 1024,
    rendererHeapGrowthMaxBytes: 128 * 1024 * 1024,
    virtualFeedDomNodesMax: 24,
    backgroundBeforeSidebarMax: 0,
  },
  "dev-fast": {
    taskHeaderReadyP95Ms: 100,
    timelineDataReceivedP95Ms: 100,
    timelineFirstRowsReadyP95Ms: 150,
    longTaskMaxMs: 80,
    frameGapMaxMs: 120,
    appShellReadyMs: 2_500,
    sidebarReadyMs: 4_000,
    timelinePageSerializedP95Bytes: 768 * 1024,
    timelinePageSerializedMaxBytes: 1024 * 1024,
    rendererHeapGrowthMaxBytes: 128 * 1024 * 1024,
    virtualFeedDomNodesMax: 24,
    backgroundBeforeSidebarMax: 0,
  },
  dev: {
    taskHeaderReadyP95Ms: 300,
    timelineDataReceivedP95Ms: 600,
    timelineFirstRowsReadyP95Ms: 900,
    longTaskMaxMs: 250,
    frameGapMaxMs: 300,
    appShellReadyMs: 4_000,
    sidebarReadyMs: 8_000,
    timelinePageSerializedP95Bytes: 768 * 1024,
    timelinePageSerializedMaxBytes: 1024 * 1024,
    rendererHeapGrowthMaxBytes: 192 * 1024 * 1024,
    virtualFeedDomNodesMax: 24,
    backgroundBeforeSidebarMax: 0,
  },
};

function usage() {
  return `Usage: node scripts/qa/profile_electron_task_switch.mjs [options]

Profiles real CoWork OS Electron task switching over Chrome DevTools Protocol.

Options:
  --mode=prod|dev|attach        Launch production app, launch dev app, or attach to an existing CDP port. Default: prod
  --cdp-port=<port>             Remote debugging port. Default: first free port from ${DEFAULT_CDP_PORT}
  --dev-server-port=<port>      Dev Vite port for --mode=dev. Default: first free port from ${DEFAULT_DEV_SERVER_PORT}
  --switches=<count>            Number of sidebar task switches to run. Default: ${DEFAULT_SWITCHES}
  --start-index=<index>         First visible sidebar task index to click. Default: 0
  --min-task-rows=<count>       Minimum visible task rows before profiling. Default: 2
  --startup-timeout-ms=<ms>     Time to wait for Electron/sidebar readiness. Default: ${DEFAULT_STARTUP_TIMEOUT_MS}
  --switch-timeout-ms=<ms>      Time to wait for each task switch mark. Default: ${DEFAULT_SWITCH_TIMEOUT_MS}
  --settle-ms=<ms>              Extra wait after each switch before sampling. Default: ${DEFAULT_SETTLE_MS}
  --output=<path>               JSON report path. Default: logs/perf-electron-task-switch-<timestamp>.json
  --profile-mode=fixture|real   Use isolated seeded fixture profile or current real profile. Default: fixture
  --real-profile                Alias for --profile-mode=real.
  --fixture-user-data-dir=<path>
                                Use a specific fixture userData directory instead of a temp directory.
  --fixture-task-count=<count>  Number of fixture sidebar sessions to seed. Default: ${DEFAULT_FIXTURE_TASKS}
  --fixture-turn-count=<count>  Minimum user/assistant turns in the large fixture task.
  --fixture-event-count=<count> Total events in the large fixture task. Default: ${DEFAULT_FIXTURE_EVENTS}
  --fixture-total-payload-mb=<count>
                                Approximate total payload size for the large fixture task.
  --fixture-heavy-event-every=<count>
                                Add a larger payload at this event interval.
  --fixture-heavy-event-kb=<count>
                                Size of each larger event payload. Default: 256 KB.
  --keep-profile                Keep generated fixture profile after the run.
  --log=<path>                  Read existing dev log evidence, especially useful with --mode=attach.
  --no-build                    Skip build:react/build:electron before launch.
  --no-quiet                    Do not set startup quiet/background-disable env for launched apps.
  --require-desktop             Fail early when a desktop session is not available.
  --keep-open                   Leave launched Electron/Vite processes running after profiling.
  --budget-profile=prod|dev-fast|dev|none
                                Budget profile. Default: prod for prod/attach, dev for dev.
  --no-budget                   Alias for --budget-profile=none.
  --help                        Show this help.

Budget overrides:
  COWORK_PROFILE_TASK_HEADER_P95_MS
  COWORK_PROFILE_TIMELINE_DATA_P95_MS
  COWORK_PROFILE_TIMELINE_ROWS_P95_MS
  COWORK_PROFILE_LONG_TASK_MAX_MS
  COWORK_PROFILE_FRAME_GAP_MAX_MS
  COWORK_PROFILE_APP_SHELL_READY_MS
  COWORK_PROFILE_SIDEBAR_READY_MS
  COWORK_PROFILE_TIMELINE_SERIALIZED_P95_BYTES
  COWORK_PROFILE_TIMELINE_SERIALIZED_MAX_BYTES
  COWORK_PROFILE_RENDERER_HEAP_GROWTH_MAX_BYTES
  COWORK_PROFILE_VIRTUAL_FEED_DOM_NODES_MAX
  COWORK_PROFILE_BACKGROUND_BEFORE_SIDEBAR_MAX
`;
}

function parsePositiveInt(value, name) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function parseNonNegativeInt(value, name) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

function getArgValue(arg, name) {
  const prefix = `${name}=`;
  return arg.startsWith(prefix) ? arg.slice(prefix.length) : null;
}

export function parseCliArgs(argv, env = process.env) {
  const options = {
    mode: "prod",
    cdpPort: env.COWORK_PROFILE_CDP_PORT
      ? parsePositiveInt(env.COWORK_PROFILE_CDP_PORT, "COWORK_PROFILE_CDP_PORT")
      : null,
    devServerPort: env.COWORK_PROFILE_DEV_SERVER_PORT
      ? parsePositiveInt(env.COWORK_PROFILE_DEV_SERVER_PORT, "COWORK_PROFILE_DEV_SERVER_PORT")
      : null,
    switches: env.COWORK_PROFILE_SWITCHES
      ? parsePositiveInt(env.COWORK_PROFILE_SWITCHES, "COWORK_PROFILE_SWITCHES")
      : DEFAULT_SWITCHES,
    startIndex: 0,
    minTaskRows: 2,
    startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
    switchTimeoutMs: DEFAULT_SWITCH_TIMEOUT_MS,
    settleMs: DEFAULT_SETTLE_MS,
    output: null,
    profileMode: "fixture",
    fixtureUserDataDir: null,
    fixtureTaskCount: DEFAULT_FIXTURE_TASKS,
    fixtureTurnCount: 0,
    fixtureEventCount: DEFAULT_FIXTURE_EVENTS,
    fixtureTotalPayloadMb: 0,
    fixtureHeavyEventEvery: 0,
    fixtureHeavyEventKb: 256,
    keepProfile: false,
    logPath: null,
    quiet: true,
    requireDesktop: false,
    noBuild: false,
    keepOpen: false,
    budgetProfile: null,
    help: false,
  };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--no-build") {
      options.noBuild = true;
      continue;
    }
    if (arg === "--real-profile") {
      options.profileMode = "real";
      continue;
    }
    if (arg === "--keep-profile") {
      options.keepProfile = true;
      continue;
    }
    if (arg === "--no-quiet") {
      options.quiet = false;
      continue;
    }
    if (arg === "--require-desktop") {
      options.requireDesktop = true;
      continue;
    }
    if (arg === "--keep-open") {
      options.keepOpen = true;
      continue;
    }
    if (arg === "--no-budget") {
      options.budgetProfile = "none";
      continue;
    }

    const mode = getArgValue(arg, "--mode");
    if (mode != null) {
      if (!["prod", "dev", "attach"].includes(mode)) {
        throw new Error(`Unsupported --mode=${mode}. Use prod, dev, or attach.`);
      }
      options.mode = mode;
      continue;
    }

    const cdpPort = getArgValue(arg, "--cdp-port");
    if (cdpPort != null) {
      options.cdpPort = parsePositiveInt(cdpPort, "--cdp-port");
      continue;
    }

    const devServerPort = getArgValue(arg, "--dev-server-port");
    if (devServerPort != null) {
      options.devServerPort = parsePositiveInt(devServerPort, "--dev-server-port");
      continue;
    }

    const switches = getArgValue(arg, "--switches");
    if (switches != null) {
      options.switches = parsePositiveInt(switches, "--switches");
      continue;
    }

    const startIndex = getArgValue(arg, "--start-index");
    if (startIndex != null) {
      options.startIndex = parseNonNegativeInt(startIndex, "--start-index");
      continue;
    }

    const minTaskRows = getArgValue(arg, "--min-task-rows");
    if (minTaskRows != null) {
      options.minTaskRows = parsePositiveInt(minTaskRows, "--min-task-rows");
      continue;
    }

    const startupTimeoutMs = getArgValue(arg, "--startup-timeout-ms");
    if (startupTimeoutMs != null) {
      options.startupTimeoutMs = parsePositiveInt(startupTimeoutMs, "--startup-timeout-ms");
      continue;
    }

    const switchTimeoutMs = getArgValue(arg, "--switch-timeout-ms");
    if (switchTimeoutMs != null) {
      options.switchTimeoutMs = parsePositiveInt(switchTimeoutMs, "--switch-timeout-ms");
      continue;
    }

    const settleMs = getArgValue(arg, "--settle-ms");
    if (settleMs != null) {
      options.settleMs = parseNonNegativeInt(settleMs, "--settle-ms");
      continue;
    }

    const output = getArgValue(arg, "--output") ?? getArgValue(arg, "--json");
    if (output != null) {
      options.output = output;
      continue;
    }

    const profileMode = getArgValue(arg, "--profile-mode");
    if (profileMode != null) {
      if (!["fixture", "real"].includes(profileMode)) {
        throw new Error(`Unsupported --profile-mode=${profileMode}. Use fixture or real.`);
      }
      options.profileMode = profileMode;
      continue;
    }

    const fixtureUserDataDir = getArgValue(arg, "--fixture-user-data-dir");
    if (fixtureUserDataDir != null) {
      options.fixtureUserDataDir = fixtureUserDataDir;
      options.profileMode = "fixture";
      continue;
    }

    const fixtureTaskCount = getArgValue(arg, "--fixture-task-count");
    if (fixtureTaskCount != null) {
      options.fixtureTaskCount = parsePositiveInt(fixtureTaskCount, "--fixture-task-count");
      continue;
    }

    const fixtureTurnCount = getArgValue(arg, "--fixture-turn-count");
    if (fixtureTurnCount != null) {
      options.fixtureTurnCount = parsePositiveInt(fixtureTurnCount, "--fixture-turn-count");
      continue;
    }

    const fixtureEventCount = getArgValue(arg, "--fixture-event-count");
    if (fixtureEventCount != null) {
      options.fixtureEventCount = parsePositiveInt(fixtureEventCount, "--fixture-event-count");
      continue;
    }

    const fixtureTotalPayloadMb = getArgValue(arg, "--fixture-total-payload-mb");
    if (fixtureTotalPayloadMb != null) {
      options.fixtureTotalPayloadMb = parsePositiveInt(
        fixtureTotalPayloadMb,
        "--fixture-total-payload-mb",
      );
      continue;
    }

    const fixtureHeavyEventEvery = getArgValue(arg, "--fixture-heavy-event-every");
    if (fixtureHeavyEventEvery != null) {
      options.fixtureHeavyEventEvery = parsePositiveInt(
        fixtureHeavyEventEvery,
        "--fixture-heavy-event-every",
      );
      continue;
    }

    const fixtureHeavyEventKb = getArgValue(arg, "--fixture-heavy-event-kb");
    if (fixtureHeavyEventKb != null) {
      options.fixtureHeavyEventKb = parsePositiveInt(
        fixtureHeavyEventKb,
        "--fixture-heavy-event-kb",
      );
      continue;
    }

    const logPath = getArgValue(arg, "--log");
    if (logPath != null) {
      options.logPath = logPath;
      continue;
    }

    const budgetProfile = getArgValue(arg, "--budget-profile");
    if (budgetProfile != null) {
      if (![...Object.keys(BUDGET_PROFILES), "none"].includes(budgetProfile)) {
        throw new Error(`Unsupported --budget-profile=${budgetProfile}.`);
      }
      options.budgetProfile = budgetProfile;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  if (!options.budgetProfile) {
    options.budgetProfile = options.mode === "dev" ? "dev" : "prod";
  }
  return options;
}

function readBudgetOverride(env, name, fallback) {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getBudget(profile, env = process.env) {
  if (profile === "none") return null;
  const base = BUDGET_PROFILES[profile];
  if (!base) throw new Error(`Unsupported budget profile: ${profile}`);
  return {
    profile,
    taskHeaderReadyP95Ms: readBudgetOverride(
      env,
      "COWORK_PROFILE_TASK_HEADER_P95_MS",
      base.taskHeaderReadyP95Ms,
    ),
    timelineDataReceivedP95Ms: readBudgetOverride(
      env,
      "COWORK_PROFILE_TIMELINE_DATA_P95_MS",
      base.timelineDataReceivedP95Ms,
    ),
    timelineFirstRowsReadyP95Ms: readBudgetOverride(
      env,
      "COWORK_PROFILE_TIMELINE_ROWS_P95_MS",
      base.timelineFirstRowsReadyP95Ms,
    ),
    longTaskMaxMs: readBudgetOverride(
      env,
      "COWORK_PROFILE_LONG_TASK_MAX_MS",
      base.longTaskMaxMs,
    ),
    frameGapMaxMs: readBudgetOverride(
      env,
      "COWORK_PROFILE_FRAME_GAP_MAX_MS",
      base.frameGapMaxMs,
    ),
    appShellReadyMs: readBudgetOverride(
      env,
      "COWORK_PROFILE_APP_SHELL_READY_MS",
      base.appShellReadyMs,
    ),
    sidebarReadyMs: readBudgetOverride(
      env,
      "COWORK_PROFILE_SIDEBAR_READY_MS",
      base.sidebarReadyMs,
    ),
    timelinePageSerializedP95Bytes: readBudgetOverride(
      env,
      "COWORK_PROFILE_TIMELINE_SERIALIZED_P95_BYTES",
      base.timelinePageSerializedP95Bytes,
    ),
    timelinePageSerializedMaxBytes: readBudgetOverride(
      env,
      "COWORK_PROFILE_TIMELINE_SERIALIZED_MAX_BYTES",
      base.timelinePageSerializedMaxBytes,
    ),
    rendererHeapGrowthMaxBytes: readBudgetOverride(
      env,
      "COWORK_PROFILE_RENDERER_HEAP_GROWTH_MAX_BYTES",
      base.rendererHeapGrowthMaxBytes,
    ),
    virtualFeedDomNodesMax: readBudgetOverride(
      env,
      "COWORK_PROFILE_VIRTUAL_FEED_DOM_NODES_MAX",
      base.virtualFeedDomNodesMax,
    ),
    backgroundBeforeSidebarMax: readBudgetOverride(
      env,
      "COWORK_PROFILE_BACKGROUND_BEFORE_SIDEBAR_MAX",
      base.backgroundBeforeSidebarMax,
    ),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findAvailablePort(startPort, maxAttempts = 50) {
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const port = startPort + offset;
    // eslint-disable-next-line no-await-in-loop
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`Unable to find an available port starting at ${startPort}.`);
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        if ((response.statusCode ?? 500) >= 400) {
          reject(new Error(`HTTP ${response.statusCode} from ${url}: ${body.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once("error", reject);
    request.setTimeout(2_000, () => {
      request.destroy(new Error(`Timed out requesting ${url}`));
    });
  });
}

async function waitForPort(port, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const open = await new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      const finish = (value) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(value);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
    });
    if (open) return;
    // eslint-disable-next-line no-await-in-loop
    await sleep(250);
  }
  throw new Error(`Timed out waiting for port ${port}.`);
}

function runCommand(label, command, args, env) {
  console.log(`[profile] ${label}: ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? 1}.`);
  }
}

function createLineCapture(child, source, logs) {
  const attach = (stream, output) => {
    let buffer = "";
    stream?.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        logs.push({ source, line, receivedAt: new Date().toISOString() });
        output.write(`[${source}] ${line}\n`);
      }
    });
    stream?.on("end", () => {
      if (!buffer) return;
      logs.push({ source, line: buffer, receivedAt: new Date().toISOString() });
      output.write(`[${source}] ${buffer}\n`);
      buffer = "";
    });
  };
  attach(child.stdout, process.stdout);
  attach(child.stderr, process.stderr);
}

function readExternalLogLines(logPath) {
  if (!logPath) return [];
  const resolved = path.resolve(logPath);
  const raw = fs.readFileSync(resolved, "utf8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      if (resolved.endsWith(".jsonl")) {
        try {
          const row = JSON.parse(line);
          return {
            source: "log",
            receivedAt: String(row.timestamp || ""),
            line: String(row.message ?? row.rawLine ?? line),
          };
        } catch {
          return { source: "log", receivedAt: "", line };
        }
      }
      return { source: "log", receivedAt: "", line };
    });
}

function getElectronBinary() {
  const cwdRequire = createRequire(path.join(repoRoot, "package.json"));
  const electronBinary = cwdRequire("electron");
  if (typeof electronBinary !== "string" || electronBinary.length === 0) {
    throw new Error("Unable to resolve Electron binary.");
  }
  return electronBinary;
}

function hasDesktopSession() {
  if (process.platform === "darwin" || process.platform === "win32") return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

function createFixtureUserDataDir(options) {
  if (options.fixtureUserDataDir) {
    const resolved = path.resolve(options.fixtureUserDataDir);
    fs.mkdirSync(resolved, { recursive: true });
    return { userDataDir: resolved, temporary: false };
  }
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-perf-profile-"));
  return { userDataDir, temporary: true };
}

function seedFixtureProfile(userDataDir, options, env) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const workspacePath = path.join(userDataDir, "fixture-workspace");
  fs.mkdirSync(workspacePath, { recursive: true });
  const seedScript = path.join(
    os.tmpdir(),
    `cowork-perf-seed-${process.pid}-${Date.now()}.cjs`,
  );
  const script = `
process.env.COWORK_USER_DATA_DIR = ${JSON.stringify(userDataDir)};
delete process.env.COWORK_PROFILE;
delete process.env.COWORK_PROFILE_ID;
const { DatabaseManager } = require(${JSON.stringify(path.join(repoRoot, "dist/electron/electron/database/schema.js"))});
const { SecureSettingsRepository } = require(${JSON.stringify(path.join(repoRoot, "dist/electron/electron/database/SecureSettingsRepository.js"))});
const { WorkspaceRepository, TaskRepository, TaskEventRepository } = require(${JSON.stringify(path.join(repoRoot, "dist/electron/electron/database/repositories.js"))});
const dbManager = new DatabaseManager();
try {
  const db = dbManager.getDatabase();
  const secureSettings = new SecureSettingsRepository(db);
  secureSettings.save("appearance", {
    themeMode: "system",
    visualTheme: "warm",
    accentColor: "cyan",
    transparencyEffectsEnabled: true,
    uiDensity: "focused",
    timelineVerbosity: "summary",
    devRunLoggingEnabled: true,
    homeResearchVaultEnabled: false,
    homeNextActionsEnabled: false,
    disclaimerAccepted: true,
    onboardingCompleted: true,
    onboardingCompletedAt: new Date().toISOString()
  });
  const workspaceRepo = new WorkspaceRepository(db);
  const taskRepo = new TaskRepository(db);
  const eventRepo = new TaskEventRepository(db);
  const workspacePath = ${JSON.stringify(workspacePath)};
  let workspace = db.prepare("SELECT * FROM workspaces WHERE path = ?").get(workspacePath);
  if (!workspace) {
    workspace = workspaceRepo.create("Perf fixture workspace", workspacePath, {
      read: true,
      write: true,
      delete: true,
      network: false,
      shell: false
    });
  }
  const existing = db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE title LIKE 'Perf fixture task %'").get();
  const existingCount = Number(existing?.count || 0);
  const now = Date.now();
  const configuredEventCount = Math.max(
    ${DEFAULT_FIXTURE_EVENTS},
    ${options.fixtureEventCount},
    (${options.fixtureTurnCount} || 0) * 2
  );
  const targetPayloadBytes = Math.max(0, ${options.fixtureTotalPayloadMb}) * 1024 * 1024;
  const basePayloadChars = targetPayloadBytes > 0
    ? Math.max(32, Math.floor(targetPayloadBytes / configuredEventCount))
    : 0;
  const eventTypes = [
    "user_message",
    "assistant_message",
    "tool_call",
    "tool_result",
    "command_output",
    "progress_update",
    "file_modified",
    "log"
  ];
  for (let index = existingCount; index < ${options.fixtureTaskCount}; index += 1) {
    const taskNumber = String(index + 1).padStart(2, "0");
    const task = taskRepo.create({
      title: "Perf fixture task " + taskNumber,
      prompt: "Fixture task " + taskNumber + " for Electron task switching performance.",
      status: "completed",
      workspaceId: workspace.id,
      source: "api",
      agentConfig: {
        executionMode: "chat",
        executionModeSource: "user",
        allowUserInput: true
      },
      resultSummary: "Fixture task ready for profile switching."
    });
    const eventCount = index === 0 ? configuredEventCount : ${DEFAULT_FIXTURE_EVENTS};
    for (let eventIndex = 0; eventIndex < eventCount; eventIndex += 1) {
      const isHeavy = index === 0 && ${options.fixtureHeavyEventEvery} > 0 &&
        eventIndex > 0 && eventIndex % ${options.fixtureHeavyEventEvery} === 0;
      const payloadChars = isHeavy
        ? Math.max(basePayloadChars, ${options.fixtureHeavyEventKb} * 1024)
        : basePayloadChars;
      const eventType = eventIndex === 0
        ? "task_created"
        : eventTypes[eventIndex % eventTypes.length];
      eventRepo.create({
        taskId: task.id,
        timestamp: now - (index * 1000) + eventIndex,
        type: eventType,
        payload: {
          message: "Fixture timeline row " + (eventIndex + 1) + " for task " + taskNumber,
          content: payloadChars > 0 ? "x".repeat(payloadChars) : undefined,
          tool: eventType === "tool_call" || eventType === "tool_result" ? "fixture_tool" : undefined,
          result: eventType === "tool_result" && payloadChars > 0 ? "x".repeat(payloadChars) : undefined,
          fixture: true
        }
      });
    }
  }
  const fixtureTaskCount = Number(
    db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE title LIKE 'Perf fixture task %'").get()?.count || 0
  );
  if (fixtureTaskCount < ${options.fixtureTaskCount}) {
    throw new Error(
      "Fixture verification failed: expected at least ${options.fixtureTaskCount} tasks, found " + fixtureTaskCount
    );
  }
  const primaryTask = db.prepare("SELECT id FROM tasks WHERE title = 'Perf fixture task 01' LIMIT 1").get();
  const primaryStats = primaryTask
    ? db.prepare(\`SELECT COUNT(*) AS event_count,
        COALESCE(SUM(LENGTH(CAST(COALESCE(payload, '') AS BLOB))), 0) AS payload_bytes
        FROM task_events WHERE task_id = ?\`).get(primaryTask.id)
    : null;
  const primaryEventCount = Number(primaryStats?.event_count || 0);
  const primaryPayloadBytes = Number(primaryStats?.payload_bytes || 0);
  if (primaryEventCount < configuredEventCount) {
    throw new Error(
      "Fixture verification failed: expected at least " + configuredEventCount +
      " primary events, found " + primaryEventCount + ". Use a fresh fixture profile."
    );
  }
  const minimumPayloadBytes = Math.floor(targetPayloadBytes * 0.75);
  if (targetPayloadBytes > 0 && primaryPayloadBytes < minimumPayloadBytes) {
    throw new Error(
      "Fixture verification failed: expected at least " + minimumPayloadBytes +
      " payload bytes, found " + primaryPayloadBytes + ". Use a fresh fixture profile."
    );
  }
} finally {
  dbManager.close();
}
`;
  fs.writeFileSync(seedScript, script);
  try {
    const result = spawnSync(getElectronBinary(), [seedScript], {
      cwd: repoRoot,
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: "1",
        COWORK_USER_DATA_DIR: userDataDir,
        NODE_ENV: "test",
      },
      encoding: "utf8",
    });
    if ((result.status ?? 1) !== 0) {
      throw new Error(
        `Fixture seed failed with exit code ${result.status ?? 1}: ${
          result.stderr || result.stdout || "no output"
        }`,
      );
    }
  } finally {
    try {
      fs.unlinkSync(seedScript);
    } catch {
      // Best-effort cleanup.
    }
  }
}

async function launchApp(options, logs) {
  if (options.mode === "attach") {
    return {
      cdpPort: options.cdpPort ?? DEFAULT_CDP_PORT,
      devServerUrl: null,
      children: [],
      launched: false,
      userDataDir: null,
      temporaryProfile: false,
    };
  }

  if (
    options.requireDesktop &&
    !hasDesktopSession() &&
    process.env.COWORK_PROFILE_ALLOW_HEADLESS !== "1"
  ) {
    throw new Error("Desktop profiling requires a GUI session. Set COWORK_PROFILE_ALLOW_HEADLESS=1 or omit --require-desktop only when an xvfb-style display is configured.");
  }

  const cdpPort = options.cdpPort ?? (await findAvailablePort(DEFAULT_CDP_PORT));
  const env = {
    ...process.env,
    COWORK_DEV_LOG_CAPTURE: "1",
    COWORK_PROFILE_RUN: "1",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  let fixtureProfile = null;
  if (options.profileMode === "fixture") {
    fixtureProfile = createFixtureUserDataDir(options);
    env.COWORK_USER_DATA_DIR = fixtureProfile.userDataDir;
    delete env.COWORK_PROFILE;
    delete env.COWORK_PROFILE_ID;
  }
  if (options.quiet) {
    env.COWORK_PROFILE_QUIET = "1";
    env.COWORK_STARTUP_QUIET = "1";
    env.COWORK_BACKGROUND_AUTOSTART = "0";
    env.COWORK_DEV_BRAND_APP = env.COWORK_DEV_BRAND_APP || "0";
    env.COWORK_DISABLE_UPDATE_CHECK = env.COWORK_DISABLE_UPDATE_CHECK || "1";
  }

  if (!options.noBuild) {
    if (options.mode === "prod") {
      runCommand("build renderer", npmCommand, ["run", "build:react"], env);
    }
    runCommand("build electron", npmCommand, ["run", "build:electron"], env);
  }

  if (options.profileMode === "fixture" && fixtureProfile) {
    seedFixtureProfile(fixtureProfile.userDataDir, options, env);
  }

  const children = [];
  let devServerUrl = null;
  if (options.mode === "dev") {
    const devServerPort =
      options.devServerPort ?? (await findAvailablePort(DEFAULT_DEV_SERVER_PORT));
    devServerUrl = `http://127.0.0.1:${devServerPort}`;
    env.NODE_ENV = "development";
    env.COWORK_DEV_SERVER_PORT = String(devServerPort);
    env.COWORK_DEV_SERVER_URL = devServerUrl;
    const react = spawn(
      npmCommand,
      ["run", "dev:react", "--", "--host", "127.0.0.1", "--port", String(devServerPort), "--strictPort"],
      {
        cwd: repoRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    createLineCapture(react, "react", logs);
    children.push(react);
    await waitForPort(devServerPort, options.startupTimeoutMs);
  } else {
    env.NODE_ENV = "production";
    delete env.COWORK_DEV_SERVER_PORT;
    delete env.COWORK_DEV_SERVER_URL;
  }

  const electron = spawn(
    getElectronBinary(),
    ["--enable-precise-memory-info", `--remote-debugging-port=${cdpPort}`, "."],
    {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    },
  );
  createLineCapture(electron, "electron", logs);
  children.push(electron);

  return {
    cdpPort,
    devServerUrl,
    children,
    launched: true,
    userDataDir: fixtureProfile?.userDataDir ?? null,
    temporaryProfile: fixtureProfile?.temporary ?? false,
  };
}

async function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode != null || child.signalCode != null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
    };
    child.once("exit", onExit);
  });
}

async function terminateChildren(children) {
  for (const child of [...children].reverse()) {
    if (!child || child.killed) continue;
    try {
      child.kill("SIGTERM");
    } catch {
      // Ignore shutdown races.
    }
    // eslint-disable-next-line no-await-in-loop
    const exited = await waitForChildExit(child, 5_000);
    if (!exited) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore shutdown races.
      }
    }
  }
}

async function waitForTarget(cdpPort, timeoutMs) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const targets = await requestJson(`http://127.0.0.1:${cdpPort}/json/list`);
      const page = targets.find(
        (target) =>
          target.type === "page" &&
          target.webSocketDebuggerUrl &&
          !String(target.url || "").startsWith("devtools://"),
      );
      if (page) return page;
    } catch (error) {
      lastError = error;
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(250);
  }
  throw new Error(
    `Timed out waiting for a CDP page target on port ${cdpPort}${
      lastError ? `: ${lastError.message}` : ""
    }`,
  );
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.ws = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.once("open", resolve);
      ws.once("error", reject);
      ws.on("message", (data) => {
        let message;
        try {
          message = JSON.parse(data.toString("utf8"));
        } catch {
          return;
        }
        if (message.id && this.pending.has(message.id)) {
          const pending = this.pending.get(message.id);
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) {
            pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
          } else {
            pending.resolve(message.result);
          }
          return;
        }
        if (message.method) {
          this.events.push(message);
          if (this.events.length > 500) this.events.splice(0, this.events.length - 500);
        }
      });
      ws.once("close", () => {
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error("CDP socket closed."));
        }
        this.pending.clear();
      });
    });
  }

  send(method, params = {}, timeoutMs = 10_000) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP socket is not open."));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for CDP ${method}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(payload);
    });
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      // Ignore shutdown races.
    }
  }
}

async function evaluate(cdp, expression, timeoutMs = 10_000) {
  const result = await cdp.send(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    },
    timeoutMs,
  );
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.text ||
        result.exceptionDetails.exception?.description ||
        "Runtime.evaluate failed.",
    );
  }
  return result.result?.value;
}

function functionExpression(fn, ...args) {
  return `(${fn.toString()})(...${JSON.stringify(args)})`;
}

function snapshotInPage(metricNames) {
  const visibleTaskRows = () =>
    Array.from(document.querySelectorAll(".cli-task-item"))
      .map((element, index) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const titleElement = element.querySelector(
          ".cli-task-title, .cli-task-agent-name, .task-item-rename-input",
        );
        const title =
          (titleElement?.textContent || element.getAttribute("title") || element.textContent || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 160);
        return {
          index,
          taskId: element.getAttribute("data-task-id") || null,
          title,
          selected: element.classList.contains("task-item-selected"),
          synthetic: element.classList.contains("task-item-group-root"),
          visible:
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== "hidden" &&
            style.display !== "none",
          top: rect.top,
          height: rect.height,
        };
      })
      .filter((row) => row.visible && !row.synthetic);

  const state = window.__coworkRendererPerfState__;
  const metric = (name) => {
    const samples = state?.metrics?.get?.(name)?.samples;
    return Array.isArray(samples) ? samples.slice() : [];
  };
  const renders = state?.renders
    ? Array.from(state.renders.entries()).map(([name, bucket]) => ({
        name,
        total: bucket.total,
        windowTotal: bucket.windowTotal,
        uniqueKeys: bucket.keys?.size ?? 0,
        topKeys: bucket.keys
          ? Array.from(bucket.keys.entries())
              .sort((a, b) => b[1] - a[1])
              .slice(0, 10)
          : [],
      }))
    : [];
  const counters = state?.counters
    ? Object.fromEntries(
        Array.from(state.counters.entries()).map(([name, bucket]) => [name, bucket.value]),
      )
    : {};
  const startupMarks = state?.startupMarks
    ? Array.from(state.startupMarks.values()).map((mark) => ({
        name: mark.name,
        atMs: mark.atMs,
        details: mark.details || null,
        emitted: Boolean(mark.emitted),
      }))
    : [];
  const perfMarks = Array.isArray(state?.perfMarks)
    ? state.perfMarks.map((mark) => ({
        name: mark.name,
        atMs: mark.atMs,
        details: mark.details || null,
      }))
    : [];
  const rows = visibleTaskRows();
  return {
    url: window.location.href,
    title: document.title,
    performanceNow: performance.now(),
    startupMarks,
    metrics: Object.fromEntries(metricNames.map((name) => [name, metric(name)])),
    perfMarks,
    renders,
    counters,
    taskRows: rows,
    selectedTaskTitle: rows.find((row) => row.selected)?.title || null,
    selectedTaskIndex: rows.find((row) => row.selected)?.index ?? null,
    bodyTextLength: document.body?.innerText?.length ?? 0,
    rendererHeapUsedBytes: performance.memory?.usedJSHeapSize ?? null,
    documentNodeCount: document.getElementsByTagName("*").length,
    virtualFeedDomNodes: document.querySelectorAll("[data-task-feed-virtual-row]").length,
  };
}

function clickTaskInPage(request) {
  const rows = Array.from(document.querySelectorAll(".cli-task-item"))
    .map((element, domIndex) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      const titleElement = element.querySelector(
        ".cli-task-title, .cli-task-agent-name, .task-item-rename-input",
      );
      const title =
        (titleElement?.textContent || element.getAttribute("title") || element.textContent || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 160);
      return {
        element,
        domIndex,
        taskId: element.getAttribute("data-task-id") || null,
        title,
        selected: element.classList.contains("task-item-selected"),
        synthetic: element.classList.contains("task-item-group-root"),
        visible:
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none",
      };
    })
    .filter((row) => row.visible && !row.synthetic);
  if (rows.length === 0) {
    return { ok: false, error: "No visible sidebar task rows found." };
  }
  let target = rows[request.index % rows.length];
  if (target.selected && rows.length > 1) {
    target = rows.find((row) => !row.selected) || target;
  }
  const selectedBefore = rows.find((row) => row.selected)?.title || null;
  target.element.scrollIntoView({ block: "center", inline: "nearest" });
  const startedAt = performance.now();
  target.element.click();
  return {
    ok: true,
    startedAt,
    domIndex: target.domIndex,
    taskId: target.taskId,
    title: target.title,
    selectedBefore,
  };
}

function ensureSidebarOpenInPage() {
  const toggle = document.querySelector(".title-bar-sidebar-toggle");
  const label = String(toggle?.getAttribute("aria-label") || toggle?.getAttribute("title") || "");
  if (toggle instanceof HTMLElement && /show sidebar/i.test(label)) {
    toggle.click();
    return { clicked: true, label };
  }
  return { clicked: false, label };
}

async function getSnapshot(cdp) {
  return evaluate(cdp, functionExpression(snapshotInPage, METRIC_NAMES));
}

function firstSampleAfter(values, threshold) {
  return values.find((value) => Number.isFinite(value) && value >= threshold) ?? null;
}

function findPerfMark(snapshot, name, predicate = () => true) {
  const marks = Array.isArray(snapshot?.perfMarks) ? snapshot.perfMarks : [];
  return marks.find((mark) => mark.name === name && predicate(mark)) ?? null;
}

function metricLength(snapshot, name) {
  return snapshot.metrics?.[name]?.length ?? 0;
}

function metricDelta(before, after, name) {
  const beforeLength = metricLength(before, name);
  return (after.metrics?.[name] ?? []).slice(beforeLength);
}

async function waitForAppReady(cdp, options) {
  const startedAt = Date.now();
  let latest = null;
  while (Date.now() - startedAt < options.startupTimeoutMs) {
    try {
      // eslint-disable-next-line no-await-in-loop
      latest = await getSnapshot(cdp);
      if (
        latest.taskRows.length < options.minTaskRows &&
        !latest.startupMarks.some((mark) => mark.name === "sidebar_ready")
      ) {
        // eslint-disable-next-line no-await-in-loop
        await evaluate(cdp, functionExpression(ensureSidebarOpenInPage), 2_000);
      }
      const sidebarReady = latest.startupMarks.some((mark) => mark.name === "sidebar_ready");
      if (sidebarReady && latest.taskRows.length >= options.minTaskRows) return latest;
    } catch {
      // The renderer may not be ready for Runtime.evaluate yet.
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(250);
  }
  const rows = latest?.taskRows?.length ?? 0;
  const marks = latest?.startupMarks?.map((mark) => mark.name).join(", ") || "none";
  throw new Error(
    `Timed out waiting for sidebar readiness. Visible task rows=${rows}, startup marks=${marks}.`,
  );
}

async function waitForSwitchMarks(cdp, clickInfo, options) {
  const waitStartedAt = Date.now();
  let latest = null;
  let switchStartMark = null;
  while (Date.now() - waitStartedAt < options.switchTimeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    latest = await getSnapshot(cdp);
    switchStartMark ||= findPerfMark(
      latest,
      "task_switch_start",
      (mark) =>
        mark.atMs >= clickInfo.startedAt &&
        (!clickInfo.taskId || mark.details?.taskId === clickInfo.taskId),
    );
    const switchId =
      typeof switchStartMark?.details?.switchId === "string"
        ? switchStartMark.details.switchId
        : null;
    const headerAt = switchId
      ? findPerfMark(latest, "task_header_ready", (mark) => mark.details?.switchId === switchId)
      : null;
    const timelineAt = switchId
      ? findPerfMark(
          latest,
          "timeline_data_received",
          (mark) => mark.details?.switchId === switchId,
        )
      : null;
    if (headerAt != null && timelineAt != null) {
      return { snapshot: latest, switchStartMark, switchId, timedOut: false };
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(50);
  }
  return {
    snapshot: latest ?? (await getSnapshot(cdp)),
    switchStartMark,
    switchId:
      typeof switchStartMark?.details?.switchId === "string"
        ? switchStartMark.details.switchId
        : null,
    timedOut: true,
  };
}

async function runTaskSwitches(cdp, options) {
  const switches = [];
  for (let index = 0; index < options.switches; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    const before = await getSnapshot(cdp);
    // eslint-disable-next-line no-await-in-loop
    const clicked = await evaluate(
      cdp,
      functionExpression(clickTaskInPage, { index: options.startIndex + index }),
    );
    if (!clicked?.ok) {
      switches.push({
        index,
        ok: false,
        error: clicked?.error || "Click failed.",
      });
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const waitResult = await waitForSwitchMarks(cdp, clicked, options);
    if (options.settleMs > 0) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(options.settleMs);
    }
    // eslint-disable-next-line no-await-in-loop
    const after = await getSnapshot(cdp);
    const switchId = waitResult.switchId;
    const switchStartMark = switchId
      ? findPerfMark(after, "task_switch_start", (mark) => mark.details?.switchId === switchId)
      : waitResult.switchStartMark;
    const effectiveStartedAt = switchStartMark?.atMs ?? clicked.startedAt;
    const headerMark = switchId
      ? findPerfMark(after, "task_header_ready", (mark) => mark.details?.switchId === switchId)
      : null;
    const timelineMark = switchId
      ? findPerfMark(after, "timeline_data_received", (mark) => mark.details?.switchId === switchId)
      : null;
    const firstRowsMark = switchId
      ? findPerfMark(
          after,
          "timeline_first_rows_ready",
          (mark) => mark.details?.switchId === switchId,
        )
      : null;

    switches.push({
      index,
      ok: !waitResult.timedOut && headerMark != null && timelineMark != null,
      timedOut: waitResult.timedOut,
      taskId: clicked.taskId,
      switchId,
      clickedTitle: clicked.title,
      selectedBefore: clicked.selectedBefore,
      selectedAfter: after.selectedTaskTitle,
      clickedAt: clicked.startedAt,
      startedAt: effectiveStartedAt,
      wallMs: after.performanceNow - clicked.startedAt,
      headerReadyMs: headerMark == null ? null : headerMark.atMs - effectiveStartedAt,
      timelineDataReceivedMs:
        timelineMark == null ? null : timelineMark.atMs - effectiveStartedAt,
      timelineFirstRowsReadyMs:
        firstRowsMark == null ? null : firstRowsMark.atMs - effectiveStartedAt,
      frameGapsMs: metricDelta(before, after, "renderer.frame_gap_ms"),
      longTasksMs: metricDelta(before, after, "renderer.long_task_ms"),
      rendererHeapBeforeBytes: before.rendererHeapUsedBytes,
      rendererHeapAfterBytes: after.rendererHeapUsedBytes,
      rendererHeapDeltaBytes:
        Number.isFinite(before.rendererHeapUsedBytes) && Number.isFinite(after.rendererHeapUsedBytes)
          ? after.rendererHeapUsedBytes - before.rendererHeapUsedBytes
          : null,
      documentNodeCount: after.documentNodeCount,
      virtualFeedDomNodes: after.virtualFeedDomNodes,
    });
  }
  return switches;
}

export function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

export function summarizeValues(values) {
  const numeric = values.filter((value) => Number.isFinite(value));
  if (numeric.length === 0) {
    return { n: 0, p50: 0, p95: 0, max: 0, values: [] };
  }
  return {
    n: numeric.length,
    p50: percentile(numeric, 0.5),
    p95: percentile(numeric, 0.95),
    max: Math.max(...numeric),
    values: numeric,
  };
}

function extractTrailingJson(text, prefix) {
  const index = text.indexOf(prefix);
  if (index < 0) return null;
  try {
    return JSON.parse(text.slice(index + prefix.length).trim());
  } catch {
    return null;
  }
}

function pushMetric(bucket, key, value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return;
  if (!bucket[key]) bucket[key] = [];
  bucket[key].push(numeric);
}

function summarizeChannelMetrics(channelMap) {
  return Object.fromEntries(
    Object.entries(channelMap).map(([channel, bucket]) => [
      channel,
      Object.fromEntries(Object.entries(bucket).map(([key, values]) => [key, summarizeValues(values)])),
    ]),
  );
}

export function parseLogMetrics(logs) {
  const startupLanes = {};
  const ipc = {};
  const ipcRenderer = {};
  const backgroundBeforeSidebar = [];
  let sidebarReadySeen = false;

  for (const entry of logs) {
    const message = String(entry.line || "");
    if (message.includes("[Startup] sidebar_ready")) {
      sidebarReadySeen = true;
    }
    if (
      !sidebarReadySeen &&
      BACKGROUND_BEFORE_SIDEBAR_PATTERN.test(message) &&
      !/quiet mode; not started|auto-connect skipped in quiet mode|background autostart is disabled/i.test(message) &&
      backgroundBeforeSidebar.length < 20
    ) {
      backgroundBeforeSidebar.push({
        source: entry.source,
        receivedAt: entry.receivedAt,
        line: message,
      });
    }

    const lane = extractTrailingJson(message, "[StartupLane]");
    if (lane?.lane && Number.isFinite(Number(lane.elapsedMs))) {
      if (!startupLanes[lane.lane]) startupLanes[lane.lane] = [];
      startupLanes[lane.lane].push(Number(lane.elapsedMs));
    }

    const ipcMetrics = extractTrailingJson(message, "[IpcPerf]");
    if (ipcMetrics?.channel) {
      if (!ipc[ipcMetrics.channel]) ipc[ipcMetrics.channel] = {};
      for (const key of ["dbMs", "jsonMs", "serializedBytes", "payloadBytes", "rowCount"]) {
        pushMetric(ipc[ipcMetrics.channel], key, ipcMetrics[key]);
      }
    }

    const rendererIpcMetrics = extractTrailingJson(message, "[IpcRendererPerf]");
    if (rendererIpcMetrics?.channel) {
      if (!ipcRenderer[rendererIpcMetrics.channel]) ipcRenderer[rendererIpcMetrics.channel] = {};
      for (const key of ["receiveMs", "jsonMs", "serializedBytes", "rowCount"]) {
        pushMetric(ipcRenderer[rendererIpcMetrics.channel], key, rendererIpcMetrics[key]);
      }
    }
  }

  return {
    startupLanes: Object.fromEntries(
      Object.entries(startupLanes).map(([lane, values]) => [lane, summarizeValues(values)]),
    ),
    ipc: summarizeChannelMetrics(ipc),
    ipcRenderer: summarizeChannelMetrics(ipcRenderer),
    backgroundBeforeSidebar,
  };
}

function startupMarkValue(startupMarks, name) {
  return startupMarks.find((mark) => mark.name === name)?.atMs ?? null;
}

function buildReport(options, launchInfo, target, initialSnapshot, finalSnapshot, switches, logs) {
  const logMetrics = parseLogMetrics(logs);
  const startupMarks = finalSnapshot.startupMarks.length > 0
    ? finalSnapshot.startupMarks
    : initialSnapshot.startupMarks;
  const headerValues = switches.map((item) => item.headerReadyMs).filter(Number.isFinite);
  const timelineValues = switches
    .map((item) => item.timelineDataReceivedMs)
    .filter(Number.isFinite);
  const firstRowsValues = switches
    .map((item) => item.timelineFirstRowsReadyMs)
    .filter(Number.isFinite);
  const wallValues = switches.map((item) => item.wallMs).filter(Number.isFinite);
  const frameGaps = switches.flatMap((item) => item.frameGapsMs || []);
  const longTasks = switches.flatMap((item) => item.longTasksMs || []);

  return {
    generatedAt: new Date().toISOString(),
    repoRoot,
    options,
    target: {
      title: target.title,
      url: target.url,
      cdpPort: launchInfo.cdpPort,
      devServerUrl: launchInfo.devServerUrl,
      launched: launchInfo.launched,
      userDataDir: launchInfo.userDataDir,
      temporaryProfile: launchInfo.temporaryProfile,
    },
    evidence: {
      logCaptureAvailable: logs.length > 0,
      externalLogPath: options.logPath ? path.resolve(options.logPath) : null,
      fixtureProfile: options.profileMode === "fixture",
      quietMode: options.quiet,
    },
    startup: {
      marks: startupMarks,
      appShellReadyMs: startupMarkValue(startupMarks, "app_shell_ready"),
      sidebarReadyMs: startupMarkValue(startupMarks, "sidebar_ready"),
      mainViewReadyMs: startupMarkValue(startupMarks, "main_view_ready"),
      composerReadyMs: startupMarkValue(startupMarks, "composer_ready"),
      lanes: logMetrics.startupLanes,
      backgroundBeforeSidebar: logMetrics.backgroundBeforeSidebar,
    },
    summary: {
      taskSwitch: {
        attempted: switches.length,
        ok: switches.filter((item) => item.ok).length,
        failed: switches.filter((item) => !item.ok).length,
        wallMs: summarizeValues(wallValues),
        headerReadyMs: summarizeValues(headerValues),
        timelineDataReceivedMs: summarizeValues(timelineValues),
        timelineFirstRowsReadyMs: summarizeValues(firstRowsValues),
      },
      renderer: {
        frameGapMs: summarizeValues(frameGaps),
        longTaskMs: summarizeValues(longTasks),
        heapInitialBytes: initialSnapshot.rendererHeapUsedBytes,
        heapFinalBytes: finalSnapshot.rendererHeapUsedBytes,
        heapGrowthBytes:
          Number.isFinite(initialSnapshot.rendererHeapUsedBytes) &&
          Number.isFinite(finalSnapshot.rendererHeapUsedBytes)
            ? finalSnapshot.rendererHeapUsedBytes - initialSnapshot.rendererHeapUsedBytes
            : null,
        documentNodeCount: finalSnapshot.documentNodeCount,
        virtualFeedDomNodes: finalSnapshot.virtualFeedDomNodes,
      },
      ipc: logMetrics.ipc,
      ipcRenderer: logMetrics.ipcRenderer,
      renders: finalSnapshot.renders,
    },
    switches,
  };
}

function addP95Failure(failures, label, summary, limit) {
  if (!summary || summary.n === 0) {
    failures.push(`${label}: no samples`);
    return;
  }
  if (summary.p95 > limit) {
    failures.push(`${label}: p95=${summary.p95.toFixed(1)}ms over budget ${limit}ms`);
  }
}

function addMaxFailure(failures, label, summary, limit, unit = "ms") {
  if (!summary || summary.n === 0) return;
  if (summary.max > limit) {
    failures.push(`${label}: max=${summary.max.toFixed(1)}${unit} over budget ${limit}${unit}`);
  }
}

function addStartupFailure(failures, label, value, limit) {
  if (!Number.isFinite(value)) {
    failures.push(`${label}: missing startup mark`);
    return;
  }
  if (value > limit) {
    failures.push(`${label}: ${value.toFixed(1)}ms over budget ${limit}ms`);
  }
}

export function evaluateBudgets(report, budget) {
  if (!budget) return [];
  const failures = [];
  const taskSwitch = report.summary.taskSwitch;
  const renderer = report.summary.renderer;

  if (taskSwitch.failed > 0) {
    failures.push(`${taskSwitch.failed} task switch(es) failed or timed out`);
  }
  addP95Failure(
    failures,
    "task header ready",
    taskSwitch.headerReadyMs,
    budget.taskHeaderReadyP95Ms,
  );
  addP95Failure(
    failures,
    "timeline data received",
    taskSwitch.timelineDataReceivedMs,
    budget.timelineDataReceivedP95Ms,
  );
  if (taskSwitch.timelineFirstRowsReadyMs.n > 0) {
    addP95Failure(
      failures,
      "timeline first rows ready",
      taskSwitch.timelineFirstRowsReadyMs,
      budget.timelineFirstRowsReadyP95Ms,
    );
  }
  addMaxFailure(failures, "renderer long task", renderer.longTaskMs, budget.longTaskMaxMs);
  addMaxFailure(failures, "renderer frame gap", renderer.frameGapMs, budget.frameGapMaxMs);
  if (Number.isFinite(budget.rendererHeapGrowthMaxBytes)) {
    if (!Number.isFinite(renderer.heapGrowthBytes)) {
      failures.push("renderer heap growth: missing measurement");
    } else if (renderer.heapGrowthBytes > budget.rendererHeapGrowthMaxBytes) {
      failures.push(
        `renderer heap growth: ${renderer.heapGrowthBytes.toFixed(0)}B over budget ${budget.rendererHeapGrowthMaxBytes}B`,
      );
    }
  }
  if (
    Number.isFinite(renderer.virtualFeedDomNodes) &&
    Number.isFinite(budget.virtualFeedDomNodesMax) &&
    renderer.virtualFeedDomNodes > budget.virtualFeedDomNodesMax
  ) {
    failures.push(
      `virtual feed DOM nodes: ${renderer.virtualFeedDomNodes} over budget ${budget.virtualFeedDomNodesMax}`,
    );
  }
  addStartupFailure(
    failures,
    "app shell ready",
    report.startup.appShellReadyMs,
    budget.appShellReadyMs,
  );
  addStartupFailure(
    failures,
    "sidebar ready",
    report.startup.sidebarReadyMs,
    budget.sidebarReadyMs,
  );

  const timelineSerialized = report.summary.ipc?.["task:timelinePage"]?.serializedBytes;
  if (!timelineSerialized || timelineSerialized.n === 0) {
    failures.push("timeline page serialized: no IPC samples");
  } else {
    if (timelineSerialized.p95 > budget.timelinePageSerializedP95Bytes) {
      failures.push(
        `timeline page serialized: p95=${timelineSerialized.p95.toFixed(0)}B over budget ${budget.timelinePageSerializedP95Bytes}B`,
      );
    }
    if (timelineSerialized.max > budget.timelinePageSerializedMaxBytes) {
      failures.push(
        `timeline page serialized: max=${timelineSerialized.max.toFixed(0)}B over budget ${budget.timelinePageSerializedMaxBytes}B`,
      );
    }
  }

  if (!report.evidence?.logCaptureAvailable) {
    failures.push("background before sidebar_ready: no log evidence");
  } else if (report.evidence?.quietMode && report.startup.backgroundBeforeSidebar.length > 0) {
    failures.push(
      `quiet mode background work before sidebar_ready: ${report.startup.backgroundBeforeSidebar.length} line(s)`,
    );
  } else if (report.startup.backgroundBeforeSidebar.length > budget.backgroundBeforeSidebarMax) {
    failures.push(
      `background work before sidebar_ready: ${report.startup.backgroundBeforeSidebar.length} line(s) over budget ${budget.backgroundBeforeSidebarMax}`,
    );
  }
  return failures;
}

function formatSummary(summary, unit = "ms") {
  if (!summary || summary.n === 0) return "n=0";
  return `n=${summary.n} p50=${summary.p50.toFixed(1)}${unit} p95=${summary.p95.toFixed(1)}${unit} max=${summary.max.toFixed(1)}${unit}`;
}

function defaultOutputPath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(repoRoot, "logs", `perf-electron-task-switch-${stamp}.json`);
}

function printReport(report, budget, budgetFailures, outputPath) {
  console.log("");
  console.log("Electron task switch profile");
  console.log(`  mode: ${report.options.mode}`);
  console.log(`  target: ${report.target.title || "(untitled)"} ${report.target.url || ""}`);
  console.log(`  switches: ${report.summary.taskSwitch.ok}/${report.summary.taskSwitch.attempted} ok`);
  console.log(`  app shell ready: ${formatMaybeMs(report.startup.appShellReadyMs)}`);
  console.log(`  sidebar ready: ${formatMaybeMs(report.startup.sidebarReadyMs)}`);
  console.log(`  header ready: ${formatSummary(report.summary.taskSwitch.headerReadyMs)}`);
  console.log(`  timeline data: ${formatSummary(report.summary.taskSwitch.timelineDataReceivedMs)}`);
  console.log(`  timeline rows: ${formatSummary(report.summary.taskSwitch.timelineFirstRowsReadyMs)}`);
  console.log(`  frame gaps: ${formatSummary(report.summary.renderer.frameGapMs)}`);
  console.log(`  long tasks: ${formatSummary(report.summary.renderer.longTaskMs)}`);
  console.log(`  renderer heap growth: ${report.summary.renderer.heapGrowthBytes || 0}B`);
  console.log(`  virtual feed DOM nodes: ${report.summary.renderer.virtualFeedDomNodes || 0}`);
  if (budget) {
    console.log(`  budget profile: ${budget.profile}`);
    if (budgetFailures.length === 0) {
      console.log("  budgets: passed");
    } else {
      console.log(`  budgets: ${budgetFailures.length} failure(s)`);
      for (const failure of budgetFailures) {
        console.log(`    - ${failure}`);
      }
    }
  } else {
    console.log("  budgets: skipped");
  }
  if (report.startup.backgroundBeforeSidebar.length > 0) {
    console.log("  background before sidebar_ready:");
    for (const entry of report.startup.backgroundBeforeSidebar.slice(0, 5)) {
      console.log(`    - [${entry.source}] ${entry.line.slice(0, 180)}`);
    }
  }
  console.log(`  report: ${outputPath}`);
}

function formatMaybeMs(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}ms` : "missing";
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const budget = getBudget(options.budgetProfile);
  const logs = [];
  let launchInfo = null;
  let cdp = null;

  try {
    launchInfo = await launchApp(options, logs);
    const target = await waitForTarget(launchInfo.cdpPort, options.startupTimeoutMs);
    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Page.bringToFront");

    const initialSnapshot = await waitForAppReady(cdp, options);
    const switches = await runTaskSwitches(cdp, options);
    const finalSnapshot = await getSnapshot(cdp);
    const reportLogs = [...readExternalLogLines(options.logPath), ...logs];
    const report = buildReport(
      options,
      launchInfo,
      target,
      initialSnapshot,
      finalSnapshot,
      switches,
      reportLogs,
    );
    const budgetFailures = evaluateBudgets(report, budget);
    report.budget = budget;
    report.budgetFailures = budgetFailures;
    report.logs = reportLogs.slice(-500);

    const outputPath = path.resolve(options.output || defaultOutputPath());
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    printReport(report, budget, budgetFailures, outputPath);

    if (budgetFailures.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    cdp?.close();
    if (launchInfo?.children && !options.keepOpen) {
      await terminateChildren(launchInfo.children);
    }
    if (
      launchInfo?.temporaryProfile &&
      launchInfo.userDataDir &&
      !options.keepProfile &&
      !options.keepOpen
    ) {
      try {
        fs.rmSync(launchInfo.userDataDir, { recursive: true, force: true });
      } catch (error) {
        console.warn(
          `[profile] failed to remove fixture profile ${launchInfo.userDataDir}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(`[profile] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
