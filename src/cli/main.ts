#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import {
  ControlPlaneClient,
  ControlPlaneRequestError,
  type ControlPlaneFrame,
} from "./control-plane-client";
import {
  createDefaultConfig,
  loadCliConfig,
  removeProfileToken,
  resolveConnection,
  saveCliConfig,
  upsertProfile,
  type CliConfig,
  type ResolvedConnection,
} from "./config-store";
import {
  buildTaskTitle,
  extractArrayPayload,
  formatApproval,
  formatTask,
  formatTaskEventFrame,
  formatWorkspace,
  isTerminalTaskFrame,
  matchesTask,
  printJson,
  type ApprovalLike,
  type TaskLike,
  type WorkspaceLike,
} from "./format";
import { discoverLocalControlPlane } from "./local-control-plane-discovery";
import { promptMarker, renderWelcomeScreen } from "./terminal-ui";

type Any = Record<string, any>;

interface ParsedArgs {
  command: string;
  rest: string[];
  flags: Map<string, string | boolean>;
}

interface CommandContext {
  parsed: ParsedArgs;
  config: CliConfig;
  connection: ResolvedConnection;
  json: boolean;
  discoveryError?: string;
  discoverySource?: string;
  autoDiscovered?: boolean;
}

const VALUE_FLAGS = new Set([
  "--url",
  "--token",
  "--profile",
  "--device-name",
  "--workspace-id",
  "--workspace",
  "--cwd",
  "--limit",
  "--model",
  "--api-key",
  "--base-url",
  "--provider",
  "--name",
  "--title",
  "--permission-mode",
  "--session-id",
  "--days",
  "--older-than",
  "--newer-than",
  "--after",
  "--before",
  "--source",
  "--end-reason",
  "--min-tokens",
  "--max-tokens",
  "--min-cost",
  "--max-cost",
  "--output",
  "--query",
  "--category",
  "--tool",
  "--rule-id",
  "--task-id",
  "--transport",
  "--command",
  "--format",
]);

const METHODS = {
  HEALTH: "health",
  STATUS: "status",
  CONFIG_GET: "config.get",
  LLM_CONFIGURE: "llm.configure",
  WORKSPACE_LIST: "workspace.list",
  WORKSPACE_CREATE: "workspace.create",
  TASK_CREATE: "task.create",
  TASK_CANCEL: "task.cancel",
  TASK_LIST: "task.list",
  TASK_EVENTS: "task.events",
  TASK_GET: "task.get",
  APPROVAL_LIST: "approval.list",
  APPROVAL_RESPOND: "approval.respond",
} as const;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.command === "help" || hasFlag(parsed, "--help") || hasFlag(parsed, "-h")) {
    usage();
    return 0;
  }
  if (hasFlag(parsed, "--version") || hasFlag(parsed, "-v")) {
    const config = loadCliConfig();
    const baseConnection = resolveConnection({
      config,
      profile: getFlag(parsed, "--profile"),
      url: getFlag(parsed, "--url"),
      token: getFlag(parsed, "--token"),
    });
    return version({
      parsed,
      config,
      connection: baseConnection,
      json: hasFlag(parsed, "--json"),
    });
  }
  if (!parsed.command) {
    return interactive(argv);
  }

  const config = loadCliConfig();
  const baseConnection = resolveConnection({
    config,
    profile: getFlag(parsed, "--profile"),
    url: getFlag(parsed, "--url"),
    token: getFlag(parsed, "--token"),
  });
  const { connection, discoveryError, discoverySource, autoDiscovered } =
    resolveConnectionWithLocalDiscovery(baseConnection, parsed);
  const ctx: CommandContext = {
    parsed,
    config,
    connection,
    discoveryError,
    discoverySource,
    autoDiscovered,
    json: hasFlag(parsed, "--json"),
  };

  try {
    switch (parsed.command) {
      case "version":
      case "--version":
      case "-v":
        return await version(ctx);
      case "status":
        return await status(ctx);
      case "doctor":
        return await doctor(ctx);
      case "login":
        return login(ctx);
      case "logout":
        return logout(ctx);
      case "whoami":
        return whoami(ctx);
      case "config":
        return configCommand(ctx);
      case "daemon":
        return await daemon(ctx);
      case "workspace":
      case "workspaces":
        return await workspace(ctx);
      case "run":
        return await runTask(ctx);
      case "tail":
        return await tail(ctx);
      case "approvals":
        return await approvals(ctx);
      case "approve":
        return await respondApproval(ctx, true);
      case "reject":
        return await respondApproval(ctx, false);
      case "providers":
      case "provider":
        return await providers(ctx);
      case "sessions":
      case "session":
        return await sessions(ctx);
      case "tasks":
      case "task":
        return await tasks(ctx);
      case "logs":
      case "log":
        return await logs(ctx);
      case "tools":
      case "tool":
        return await tools(ctx);
      case "mcp":
        return await mcp(ctx);
      case "skills":
      case "skill":
        return await skills(ctx);
      case "models":
      case "model":
        return await models(ctx);
      case "backup":
        return await backup(ctx);
      case "security":
        return await security(ctx);
      case "prompt-size":
        return await promptSize(ctx);
      case "prompt-preview":
        return await promptPreview(ctx);
      case "completions":
      case "completion":
        return completions(ctx);
      case "dashboard":
        return await dashboard(ctx);
      case "open":
        return await openCommand(ctx);
      default:
        process.stderr.write(`Unknown command: ${parsed.command}\n\n`);
        usage();
        return 1;
    }
  } catch (error) {
    return handleError(error);
  }
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      if (VALUE_FLAGS.has(arg)) {
        const value = argv[i + 1];
        if (!value || value.startsWith("--")) {
          flags.set(arg, "");
        } else {
          flags.set(arg, value);
          i += 1;
        }
      } else {
        flags.set(arg, true);
      }
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      flags.set(arg, true);
      continue;
    }
    positional.push(arg);
  }
  const [command = "", ...rest] = positional;
  return { command, rest, flags };
}

export function parseInteractiveCommand(input: string): string[] {
  const trimmed = input.trim();
  if (!trimmed) return [];
  if (!trimmed.startsWith("/")) return ["run", trimmed];
  const commandLine = trimmed.slice(1).trim();
  if (!commandLine) return [];
  if (commandLine === "exit" || commandLine === "quit") return ["exit"];
  if (commandLine === "?") return ["help"];
  return splitCommandLine(commandLine);
}

async function interactive(initialArgv: string[]): Promise<number> {
  const globalFlags = initialArgv;
  printBanner();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: promptMarker(),
  });

  try {
    rl.prompt();
    for await (const line of rl) {
      const args = parseInteractiveCommand(line);
      if (args[0] === "exit") break;
      if (args.length === 0) {
        rl.prompt();
        continue;
      }
      const code = await main([...globalFlags, ...args]);
      if (code !== 0) process.stdout.write(`Command exited with code ${code}.\n`);
      rl.prompt();
    }
    return 0;
  } finally {
    rl.close();
  }
}

function printBanner(): void {
  process.stdout.write(`${renderWelcomeScreen({ version: getCliVersion() })}\n`);
}

function getCliVersion(): string {
  const candidates = [
    path.resolve(__dirname, "..", "..", "..", "package.json"),
    path.resolve(__dirname, "..", "..", "package.json"),
  ];
  for (const packageJsonPath of candidates) {
    try {
      const pkg = require(packageJsonPath) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      // Try the next layout; source and dist have different __dirname depth.
    }
  }
  return "dev";
}

function splitCommandLine(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const ch of input) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (escaped) current += "\\";
  if (current) args.push(current);
  return args;
}

function resolveConnectionWithLocalDiscovery(
  connection: ResolvedConnection,
  parsed: ParsedArgs,
): {
  connection: ResolvedConnection;
  discoveryError?: string;
  discoverySource?: string;
  autoDiscovered?: boolean;
} {
  if (connection.token || hasFlag(parsed, "--no-discover")) return { connection };
  const discovered = discoverLocalControlPlane(getFlag(parsed, "--profile") || connection.profileName);
  if (discovered.token) {
    return {
      connection: {
        ...connection,
        url: getFlag(parsed, "--url") || discovered.url || connection.url,
        token: discovered.token,
      },
      discoverySource: discovered.source,
      autoDiscovered: true,
    };
  }
  return { connection, discoveryError: discovered.error };
}

async function doctor(ctx: CommandContext): Promise<number> {
  if (!hasFlag(ctx.parsed, "--remote")) {
    return runDirectCommandProcess(ctx, ["--doctor"]);
  }

  const checks: string[] = [];
  checks.push(`profile: ${ctx.connection.profileName}`);
  checks.push(`url: ${ctx.connection.url}`);
  checks.push(`token: ${ctx.connection.token ? "configured" : "missing"}`);
  if (ctx.autoDiscovered && ctx.discoverySource) checks.push(`discovered: ${ctx.discoverySource}`);

  if (!ctx.connection.token) {
    printLinesOrJson(ctx, { ok: false, checks }, [
      "CoWork CLI doctor",
      ...checks.map((line) => `- ${line}`),
      "",
      "Missing token. Run:",
      "  cowork login --token <control-plane-token>",
    ]);
    return 1;
  }

  const client = await connectedClient(ctx);
  try {
    const health = await client.request(METHODS.HEALTH);
    const config = await client.request(METHODS.CONFIG_GET);
    printLinesOrJson(ctx, { ok: true, checks, health, config }, [
      "CoWork CLI doctor",
      ...checks.map((line) => `- ${line}`),
      "- control plane: reachable",
      ...formatConfigWarnings(config),
    ]);
    return 0;
  } finally {
    client.close();
  }
}

async function version(ctx: CommandContext): Promise<number> {
  return runDirectCommandProcess(ctx, ["--version"]);
}

async function status(ctx: CommandContext): Promise<number> {
  return runDirectCommandProcess(ctx, ["--status"]);
}

function login(ctx: CommandContext): number {
  const url = getFlag(ctx.parsed, "--url") || ctx.connection.url;
  const token = getFlag(ctx.parsed, "--token") || process.env.COWORK_CONTROL_PLANE_TOKEN || "";
  const profile = getFlag(ctx.parsed, "--profile") || ctx.connection.profileName || "local";
  if (!token) {
    process.stderr.write("Missing token. Provide --token or set COWORK_CONTROL_PLANE_TOKEN.\n");
    return 1;
  }
  const next = upsertProfile(ctx.config, profile, { url, token }, true);
  saveCliConfig(next);
  printLinesOrJson(ctx, { ok: true, profile, url }, [
    `Saved profile "${profile}".`,
    `Control plane: ${url}`,
  ]);
  return 0;
}

function logout(ctx: CommandContext): number {
  const profile = getFlag(ctx.parsed, "--profile") || ctx.connection.profileName || "local";
  saveCliConfig(removeProfileToken(ctx.config, profile));
  printLinesOrJson(ctx, { ok: true, profile }, [`Removed stored token for profile "${profile}".`]);
  return 0;
}

function whoami(ctx: CommandContext): number {
  if (!hasFlag(ctx.parsed, "--remote")) {
    printLinesOrJson(ctx, { profile: ctx.connection.profileName, runtime: "local", controlPlaneRequired: false }, [
      `Profile: ${ctx.connection.profileName}`,
      "Runtime: local",
      "Control Plane: not required for local CLI commands",
    ]);
    return 0;
  }

  printLinesOrJson(ctx, { ...ctx.connection, autoDiscovered: ctx.autoDiscovered, discoverySource: ctx.discoverySource }, [
    `Profile: ${ctx.connection.profileName}`,
    `URL: ${ctx.connection.url}`,
    `Token: ${ctx.connection.token ? (ctx.autoDiscovered ? "auto-discovered" : "configured") : "missing"}`,
    ...(ctx.discoverySource ? [`Source: ${ctx.discoverySource}`] : []),
    ...(!ctx.connection.token && ctx.discoveryError ? [`Auto-discovery: ${ctx.discoveryError}`] : []),
  ]);
  return ctx.connection.token ? 0 : 1;
}

function configCommand(ctx: CommandContext): number {
  if (ctx.parsed.rest[0] === "reset") {
    saveCliConfig(createDefaultConfig());
    process.stdout.write("Reset CoWork CLI config.\n");
    return 0;
  }
  printJson(ctx.config);
  return 0;
}

async function daemon(ctx: CommandContext): Promise<number> {
  const sub = ctx.parsed.rest[0] || "status";
  if (sub === "status") {
    return doctor({ ...ctx, parsed: { ...ctx.parsed, command: "doctor", rest: [] } });
  }
  if (sub !== "start") {
    process.stderr.write("Usage: cowork daemon status | cowork daemon start [--background]\n");
    return 1;
  }

  const packageRoot = path.resolve(__dirname, "..", "..");
  const daemonBin = path.join(packageRoot, "bin", "coworkd-node.js");
  const args = ["--print-control-plane-token", ...ctx.parsed.rest.slice(1)];
  if (hasFlag(ctx.parsed, "--background")) {
    const child = spawn(process.execPath, [daemonBin, ...args], {
      cwd: packageRoot,
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    process.stdout.write("Started CoWork daemon in the background.\n");
    process.stdout.write("Check logs from your process manager, or run foreground mode to read the token.\n");
    return 0;
  }
  const child = spawn(process.execPath, [daemonBin, ...args], {
    cwd: packageRoot,
    stdio: "inherit",
    env: process.env,
  });
  return new Promise((resolve) => child.on("close", (code) => resolve(code ?? 0)));
}

async function workspace(ctx: CommandContext): Promise<number> {
  const sub = ctx.parsed.rest[0] || "list";
  if (!hasFlag(ctx.parsed, "--remote")) {
    if (sub === "list") {
      return runDirectCommandProcess(ctx, ["--workspace-list"]);
    }
    if (sub === "create") {
      const target = ctx.parsed.rest[1] || getFlag(ctx.parsed, "--cwd") || process.cwd();
      const resolved = path.resolve(target);
      const name = getFlag(ctx.parsed, "--name") || path.basename(resolved) || "Workspace";
      return runDirectCommandProcess(ctx, ["--workspace-create", "--cwd", resolved, "--name", name]);
    }
    process.stderr.write("Usage: cowork workspace list | cowork workspace create [path] [--name <name>]\n");
    return 1;
  }

  const client = await connectedClient(ctx);
  try {
    if (sub === "list") {
      const payload = await client.request(METHODS.WORKSPACE_LIST);
      const workspaces = extractArrayPayload<WorkspaceLike>(payload, "workspaces");
      printLinesOrJson(ctx, payload, workspaces.length ? workspaces.map(formatWorkspace) : ["No workspaces configured."]);
      return 0;
    }
    if (sub === "create") {
      const target = ctx.parsed.rest[1] || getFlag(ctx.parsed, "--cwd") || process.cwd();
      const resolved = path.resolve(target);
      const name = getFlag(ctx.parsed, "--name") || path.basename(resolved) || "Workspace";
      const payload = await client.request(METHODS.WORKSPACE_CREATE, { name, path: resolved });
      printLinesOrJson(ctx, payload, [`Created workspace: ${formatWorkspace((payload as Any).workspace || {})}`]);
      return 0;
    }
    process.stderr.write("Usage: cowork workspace list | cowork workspace create [path] [--name <name>]\n");
    return 1;
  } finally {
    client.close();
  }
}

async function runTask(ctx: CommandContext): Promise<number> {
  const prompt = ctx.parsed.rest.join(" ").trim();
  if (!prompt) {
    process.stderr.write('Usage: cowork run "task prompt" [--cwd <path>] [--workspace-id <id>] [--shell] [--detach]\n');
    return 1;
  }
  if (isLikelyCommandPrompt(prompt) && !hasFlag(ctx.parsed, "--force")) {
    process.stderr.write(
      `"${prompt}" looks like a CLI command. Did you mean \`cowork ${prompt}\`?\nUse \`cowork run --force ${prompt}\` to run it as a task.\n`,
    );
    return 1;
  }
  if (!hasFlag(ctx.parsed, "--remote")) {
    if (hasFlag(ctx.parsed, "--detach")) {
      return await runDirectDetachedTaskProcess(ctx, prompt);
    }
    return runDirectTaskProcess(ctx, prompt);
  }
  const client = await connectedClient(ctx);
  try {
    const cwd = path.resolve(getFlag(ctx.parsed, "--cwd") || process.cwd());
    const workspaceId = await resolveWorkspaceId(client, ctx, cwd);
    const params: Record<string, unknown> = {
      workspaceId,
      title: getFlag(ctx.parsed, "--title") || buildTaskTitle(prompt),
      prompt,
      ...(hasFlag(ctx.parsed, "--shell") ? { shellAccess: true } : {}),
      ...(getFlag(ctx.parsed, "--permission-mode") ? { permissionMode: getFlag(ctx.parsed, "--permission-mode") } : {}),
    };
    const created = await client.request(METHODS.TASK_CREATE, params, 30000);
    const task = ((created as Any).task || {}) as TaskLike;
    const taskId = String((created as Any).taskId || task.id || "");
    if (ctx.json || hasFlag(ctx.parsed, "--no-follow")) {
      printJson(created);
      return 0;
    }
    if (hasFlag(ctx.parsed, "--detach")) {
      process.stdout.write(`Created detached task: ${taskId}  ${task.title || buildTaskTitle(prompt)}\n`);
      process.stdout.write(`Tail: cowork tasks attach ${taskId} --remote\n`);
      process.stdout.write(`Cancel: cowork tasks cancel ${taskId} --remote\n`);
      return 0;
    }
    process.stdout.write(`Created task: ${formatTask(task)}\n`);
    process.stdout.write(`Tail: cowork tail ${taskId}\n\n`);
    return await streamTask(client, taskId, Number(getFlag(ctx.parsed, "--limit") || 200));
  } finally {
    client.close();
  }
}

function runDirectTaskProcess(ctx: CommandContext, prompt: string): Promise<number> {
  return runDirectCommandProcess(ctx, buildDirectTaskArgs(ctx, prompt));
}

async function runDirectDetachedTaskProcess(ctx: CommandContext, prompt: string): Promise<number> {
  const runtime = resolveDirectRuntime();
  const readyFile = path.join(os.tmpdir(), `cowork-cli-detached-${randomUUID()}.json`);
  const directRunArgs = [
    ...buildDirectTaskArgs(ctx, prompt),
    "--detached-worker",
    "--ready-file",
    readyFile,
    ...(ctx.json ? ["--json"] : []),
  ];
  const child = spawn(runtime.executable, [runtime.scriptPath, ...directRunArgs], {
    cwd: path.resolve(getFlag(ctx.parsed, "--cwd") || process.cwd()),
    detached: true,
    stdio: "ignore",
    env: runtime.usesElectron
      ? { ...process.env, ELECTRON_RUN_AS_NODE: "1", COWORK_HEADLESS: "1" }
      : { ...process.env, COWORK_HEADLESS: "1" },
  });
  child.unref();
  const ready = await waitForDetachedReadyFile(readyFile, 30000);
  if (ctx.json) {
    printJson({ type: "detached_task", ...ready, pid: child.pid || null });
    return 0;
  }
  if (ready?.taskId) {
    process.stdout.write(`Created detached task: ${ready.taskId}  ${ready.title || prompt}\n`);
    process.stdout.write(`Tail: cowork tasks attach ${ready.taskId}\n`);
    process.stdout.write(`Cancel: cowork tasks cancel ${ready.taskId}\n`);
  } else {
    process.stdout.write("Started detached task runner. Task id was not available before timeout.\n");
  }
  return 0;
}

function buildDirectTaskArgs(ctx: CommandContext, prompt: string): string[] {
  return [
    "--prompt",
    prompt,
    "--cwd",
    path.resolve(getFlag(ctx.parsed, "--cwd") || process.cwd()),
    ...(getFlag(ctx.parsed, "--title") ? ["--title", getFlag(ctx.parsed, "--title")!] : []),
    ...(getFlag(ctx.parsed, "--workspace-id")
      ? ["--workspace-id", getFlag(ctx.parsed, "--workspace-id")!]
      : []),
    ...(hasFlag(ctx.parsed, "--shell") ? ["--shell"] : []),
  ];
}

async function waitForDetachedReadyFile(
  readyFile: string,
  timeoutMs: number,
): Promise<{ taskId?: string; title?: string; status?: string; workspaceId?: string } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = await fs.readFile(readyFile, "utf8");
      await fs.unlink(readyFile).catch(() => {});
      const parsed = JSON.parse(text) as { taskId?: string; title?: string; status?: string; workspaceId?: string };
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return null;
}

function runDirectCommandProcess(ctx: CommandContext, directArgs: string[]): Promise<number> {
  const runtime = resolveDirectRuntime();
  const directRunArgs = [...directArgs, ...(ctx.json ? ["--json"] : [])];
  const args = [runtime.scriptPath, ...directRunArgs];

  return new Promise((resolve, reject) => {
    const child = spawn(runtime.executable, args, {
      cwd: path.resolve(getFlag(ctx.parsed, "--cwd") || process.cwd()),
      stdio: "inherit",
      env: runtime.usesElectron
        ? { ...process.env, ELECTRON_RUN_AS_NODE: "1", COWORK_HEADLESS: "1" }
        : { ...process.env, COWORK_HEADLESS: "1" },
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal === "SIGINT") resolve(130);
      else if (signal === "SIGTERM") resolve(143);
      else resolve(code ?? 0);
    });
  });
}

function resolveDirectRuntime(): {
  executable: string;
  scriptPath: string;
  appPath: string;
  usesElectron: boolean;
} {
  const scriptPath = path.join(__dirname, "direct-run.js");
  const appPath = path.resolve(__dirname, "..", "..", "..");
  try {
    const electronBinary = require("electron");
    if (typeof electronBinary === "string" && electronBinary.trim()) {
      return { executable: electronBinary, scriptPath, appPath, usesElectron: true };
    }
  } catch {
    // Fall back to the current Node process.
  }
  return { executable: process.execPath, scriptPath, appPath, usesElectron: false };
}

async function tail(ctx: CommandContext): Promise<number> {
  const taskId = ctx.parsed.rest[0];
  if (!taskId) {
    process.stderr.write("Usage: cowork tail <taskId> [--limit <n>] [--json]\n");
    return 1;
  }
  if (!hasFlag(ctx.parsed, "--remote")) {
    return runDirectCommandProcess(ctx, [
      "--tail",
      "--task-id",
      taskId,
      "--limit",
      String(parseLimit(ctx, 200)),
    ]);
  }

  const client = await connectedClient(ctx);
  try {
    return await streamTask(client, taskId, Number(getFlag(ctx.parsed, "--limit") || 200), ctx.json);
  } finally {
    client.close();
  }
}

async function approvals(ctx: CommandContext): Promise<number> {
  if (!hasFlag(ctx.parsed, "--remote")) {
    return runDirectCommandProcess(ctx, ["--approvals-list", "--limit", String(parseLimit(ctx, 100))]);
  }

  const client = await connectedClient(ctx);
  try {
    const payload = await client.request(METHODS.APPROVAL_LIST, { limit: parseLimit(ctx, 100), offset: 0 });
    const rows = extractArrayPayload<ApprovalLike>(payload, "approvals");
    printLinesOrJson(ctx, payload, rows.length ? rows.map(formatApproval) : ["No pending approvals."]);
    return 0;
  } finally {
    client.close();
  }
}

async function respondApproval(ctx: CommandContext, approved: boolean): Promise<number> {
  const approvalId = ctx.parsed.rest[0];
  if (!approvalId) {
    process.stderr.write(`Usage: cowork ${approved ? "approve" : "reject"} <approvalId>\n`);
    return 1;
  }
  if (!hasFlag(ctx.parsed, "--remote")) {
    return runLocalApprovalResponseProcess(ctx, approvalId, approved);
  }

  const client = await connectedClient(ctx);
  try {
    const payload = await client.request(METHODS.APPROVAL_RESPOND, { approvalId, approved });
    printLinesOrJson(ctx, payload, [`${approved ? "Approved" : "Rejected"} approval ${approvalId}.`]);
    return 0;
  } finally {
    client.close();
  }
}

function runLocalApprovalResponseProcess(
  ctx: CommandContext,
  approvalId: string,
  approved: boolean,
): Promise<number> {
  const runtime = resolveDirectRuntime();
  if (!runtime.usesElectron) {
    process.stderr.write(
      "Local approval response requires the Electron runtime. Use the desktop app or rerun with --remote.\n",
    );
    return Promise.resolve(1);
  }

  const args = [
    runtime.appPath,
    "--cowork-cli-approval-response",
    "--approval-id",
    approvalId,
    approved ? "--approved" : "--rejected",
  ];

  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(runtime.executable, args, {
      cwd: process.cwd(),
      stdio: "ignore",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "" },
    });
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        process.stdout.write(
          `Sent ${approved ? "approval" : "rejection"} ${approvalId} to the running CoWork OS app.\n`,
        );
      }
      resolve(code);
    };
    const timeout = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Best-effort.
      }
      process.stderr.write(
        "No running CoWork OS desktop app accepted the local approval response. Open the app, then retry, or use --remote.\n",
      );
      finish(1);
    }, 4000);
    child.on("error", reject);
    child.on("close", (code) => finish(code ?? 0));
  });
}

async function providers(ctx: CommandContext): Promise<number> {
  const sub = ctx.parsed.rest[0] || "list";
  if (!hasFlag(ctx.parsed, "--remote") && sub === "fallback") {
    const action = ctx.parsed.rest[1] || "list";
    if (action === "list") return runDirectCommandProcess(ctx, ["--providers-fallback-list"]);
    if (action === "add") {
      const providerType = ctx.parsed.rest[2] || getFlag(ctx.parsed, "--provider");
      if (!providerType) {
        process.stderr.write("Usage: cowork providers fallback add <provider> [--model <model>]\n");
        return 1;
      }
      return runDirectCommandProcess(ctx, [
        "--providers-fallback-add",
        "--provider",
        providerType,
        ...(getFlag(ctx.parsed, "--model") ? ["--model", getFlag(ctx.parsed, "--model")!] : []),
      ]);
    }
    if (action === "remove") {
      const providerType = ctx.parsed.rest[2] || getFlag(ctx.parsed, "--provider");
      if (!providerType) {
        process.stderr.write("Usage: cowork providers fallback remove <provider>\n");
        return 1;
      }
      return runDirectCommandProcess(ctx, ["--providers-fallback-remove", "--provider", providerType]);
    }
    process.stderr.write("Usage: cowork providers fallback list|add|remove\n");
    return 1;
  }
  if (!hasFlag(ctx.parsed, "--remote") && (sub === "list" || sub === "status")) {
    return runDirectCommandProcess(ctx, ["--providers-list"]);
  }
  if (!hasFlag(ctx.parsed, "--remote") && sub === "configure") {
    const providerType = ctx.parsed.rest[1] || getFlag(ctx.parsed, "--provider");
    if (!providerType) {
      process.stderr.write("Usage: cowork providers configure <provider> [--api-key <key>] [--model <model>] [--base-url <url>]\n");
      return 1;
    }
    return runDirectCommandProcess(ctx, [
      "--providers-configure",
      "--provider",
      providerType,
      ...(getFlag(ctx.parsed, "--api-key") || providerEnvKey(providerType)
        ? ["--api-key", getFlag(ctx.parsed, "--api-key") || providerEnvKey(providerType)]
        : []),
      ...(getFlag(ctx.parsed, "--model") ? ["--model", getFlag(ctx.parsed, "--model")!] : []),
      ...(getFlag(ctx.parsed, "--base-url") ? ["--base-url", getFlag(ctx.parsed, "--base-url")!] : []),
    ]);
  }

  const client = await connectedClient(ctx);
  try {
    if (sub === "list" || sub === "status") {
      const config = await client.request(METHODS.CONFIG_GET);
      const llm = (config as Any).llm || {};
      printLinesOrJson(ctx, llm, formatProviders(llm));
      return 0;
    }
    if (sub === "configure") {
      const providerType = ctx.parsed.rest[1] || getFlag(ctx.parsed, "--provider");
      if (!providerType) {
        process.stderr.write("Usage: cowork providers configure <provider> [--api-key <key>] [--model <model>] [--base-url <url>]\n");
        return 1;
      }
      const apiKey = getFlag(ctx.parsed, "--api-key") || providerEnvKey(providerType);
      const model = getFlag(ctx.parsed, "--model");
      const baseUrl = getFlag(ctx.parsed, "--base-url");
      const payload = await client.request(METHODS.LLM_CONFIGURE, {
        providerType,
        ...(apiKey ? { apiKey } : {}),
        ...(model ? { model } : {}),
        ...(baseUrl ? { settings: { baseUrl } } : {}),
      });
      printLinesOrJson(ctx, payload, [`Configured provider "${providerType}".`]);
      return 0;
    }
    process.stderr.write("Usage: cowork providers list | cowork providers configure <provider>\n");
    return 1;
  } finally {
    client.close();
  }
}

async function sessions(ctx: CommandContext): Promise<number> {
  const sub = ctx.parsed.rest[0] || "list";
  if (sub === "list") {
    return runDirectCommandProcess(ctx, [
      "--sessions-list",
      "--limit",
      String(parseLimit(ctx, 50)),
      ...(hasFlag(ctx.parsed, "--include-archived") ? ["--include-archived"] : []),
    ]);
  }
  if (sub === "show") {
    const id = ctx.parsed.rest[1];
    if (!id) return usageError("Usage: cowork sessions show <sessionId>");
    return runDirectCommandProcess(ctx, ["--sessions-show", "--session-id", id, "--limit", String(parseLimit(ctx, 200))]);
  }
  if (sub === "export") {
    const id = ctx.parsed.rest[1];
    if (!id) return usageError("Usage: cowork sessions export <sessionId> [--output <file>]");
    return runDirectCommandProcess(ctx, [
      "--sessions-export",
      "--session-id",
      id,
      ...(getFlag(ctx.parsed, "--output") ? ["--output", getFlag(ctx.parsed, "--output")!] : []),
      "--limit",
      String(parseLimit(ctx, 1000)),
    ]);
  }
  if (sub === "rename") {
    const id = ctx.parsed.rest[1];
    const name = ctx.parsed.rest.slice(2).join(" ").trim() || getFlag(ctx.parsed, "--name");
    if (!id || !name) return usageError("Usage: cowork sessions rename <sessionId> <name>");
    return runDirectCommandProcess(ctx, ["--sessions-rename", "--session-id", id, "--name", name]);
  }
  if (sub === "archive") {
    const id = ctx.parsed.rest[1];
    if (!id) return usageError("Usage: cowork sessions archive <sessionId>");
    return runDirectCommandProcess(ctx, ["--sessions-archive", "--session-id", id]);
  }
  if (sub === "delete") {
    const id = ctx.parsed.rest[1];
    if (!id) return usageError("Usage: cowork sessions delete <sessionId> --yes");
    return runDirectCommandProcess(ctx, ["--sessions-delete", "--session-id", id, ...(hasFlag(ctx.parsed, "--yes") ? ["--yes"] : [])]);
  }
  if (sub === "prune") {
    return runDirectCommandProcess(ctx, [
      "--sessions-prune",
      ...sessionPruneDirectArgs(ctx),
      ...(hasFlag(ctx.parsed, "--yes") ? ["--yes"] : []),
      ...(hasFlag(ctx.parsed, "--dry-run") ? ["--dry-run"] : []),
      ...(hasFlag(ctx.parsed, "--include-archived") ? ["--include-archived"] : []),
      ...(hasFlag(ctx.parsed, "--all") ? ["--all"] : []),
      ...(hasFlag(ctx.parsed, "--vacuum") ? ["--vacuum"] : []),
    ]);
  }
  process.stderr.write("Usage: cowork sessions list|show|export|rename|archive|delete|prune\n");
  return 1;
}

async function tasks(ctx: CommandContext): Promise<number> {
  const sub = ctx.parsed.rest[0] || "list";
  if (!hasFlag(ctx.parsed, "--remote")) {
    if (sub === "list") {
      return runDirectCommandProcess(ctx, [
        "--tasks-list",
        "--limit",
        String(parseLimit(ctx, 50)),
        ...(hasFlag(ctx.parsed, "--active") ? ["--active"] : []),
        ...(hasFlag(ctx.parsed, "--cli") ? ["--cli"] : []),
      ]);
    }
    if (sub === "cancel") {
      const taskId = ctx.parsed.rest[1] || getFlag(ctx.parsed, "--task-id");
      if (!taskId) return usageError("Usage: cowork tasks cancel <taskId>");
      return runDirectCommandProcess(ctx, ["--tasks-cancel", "--task-id", taskId]);
    }
    if (sub === "attach") {
      const taskId = ctx.parsed.rest[1] || getFlag(ctx.parsed, "--task-id");
      if (!taskId) return usageError("Usage: cowork tasks attach <taskId>");
      return runDirectCommandProcess(ctx, [
        "--tasks-attach",
        "--task-id",
        taskId,
        "--limit",
        String(parseLimit(ctx, 200)),
      ]);
    }
    if (sub === "stale") {
      return runDirectCommandProcess(ctx, ["--tasks-stale", "--limit", String(parseLimit(ctx, 100))]);
    }
    if (sub === "cleanup") {
      return runDirectCommandProcess(ctx, [
        "--tasks-cleanup",
        ...(hasFlag(ctx.parsed, "--interrupted-cli") ? ["--interrupted-cli"] : []),
        ...(hasFlag(ctx.parsed, "--yes") ? ["--yes"] : []),
        "--limit",
        String(parseLimit(ctx, 1000)),
      ]);
    }
    return usageError("Usage: cowork tasks list|cancel|attach|stale|cleanup");
  }

  const client = await connectedClient(ctx);
  try {
    if (sub === "list") {
      const payload = await client.request(METHODS.TASK_LIST, { limit: parseLimit(ctx, 50), offset: 0 });
      const rows = extractArrayPayload<TaskLike>(payload, "tasks");
      const filtered = hasFlag(ctx.parsed, "--active")
        ? rows.filter((task) => !["completed", "failed", "cancelled"].includes(String(task.status || "")))
        : rows;
      printLinesOrJson(ctx, payload, filtered.length ? filtered.map(formatTask) : ["No matching remote tasks found."]);
      return 0;
    }
    if (sub === "cancel") {
      const taskId = ctx.parsed.rest[1] || getFlag(ctx.parsed, "--task-id");
      if (!taskId) return usageError("Usage: cowork tasks cancel <taskId> --remote");
      const payload = await client.request(METHODS.TASK_CANCEL, { taskId });
      printLinesOrJson(ctx, payload, [`Cancelled task ${taskId}.`]);
      return 0;
    }
    if (sub === "attach") {
      const taskId = ctx.parsed.rest[1] || getFlag(ctx.parsed, "--task-id");
      if (!taskId) return usageError("Usage: cowork tasks attach <taskId> --remote");
      return await streamTask(client, taskId, parseLimit(ctx, 200), ctx.json);
    }
    return usageError("Remote usage: cowork tasks list|cancel|attach --remote");
  } finally {
    client.close();
  }
}

async function logs(ctx: CommandContext): Promise<number> {
  const sub = ctx.parsed.rest[0] || "latest";
  if (sub === "latest") return runDirectCommandProcess(ctx, ["--logs-latest", "--limit", String(parseLimit(ctx, 80))]);
  if (sub === "tail") return runDirectCommandProcess(ctx, ["--logs-tail", "--limit", String(parseLimit(ctx, 80))]);
  if (sub === "grep") {
    const query = ctx.parsed.rest.slice(1).join(" ").trim() || getFlag(ctx.parsed, "--query");
    if (!query) return usageError("Usage: cowork logs grep <query>");
    return runDirectCommandProcess(ctx, ["--logs-grep", "--query", query, "--limit", String(parseLimit(ctx, 80))]);
  }
  process.stderr.write("Usage: cowork logs latest|tail|grep\n");
  return 1;
}

async function tools(ctx: CommandContext): Promise<number> {
  const sub = ctx.parsed.rest[0] || "list";
  if (sub === "list") return runDirectCommandProcess(ctx, ["--tools-list"]);
  if (sub === "info" || sub === "enable" || sub === "disable") {
    const target = ctx.parsed.rest[1] || getFlag(ctx.parsed, "--category") || getFlag(ctx.parsed, "--tool");
    if (!target) return usageError(`Usage: cowork tools ${sub} <category-or-tool>`);
    return runDirectCommandProcess(ctx, [`--tools-${sub}`, "--name", target]);
  }
  process.stderr.write("Usage: cowork tools list|info|enable|disable\n");
  return 1;
}

async function mcp(ctx: CommandContext): Promise<number> {
  const sub = ctx.parsed.rest[0] || "list";
  if (sub === "list") return runDirectCommandProcess(ctx, ["--mcp-list"]);
  if (sub === "add") {
    const name = getFlag(ctx.parsed, "--name") || ctx.parsed.rest[1];
    if (!name) return usageError("Usage: cowork mcp add --name <name> (--command <cmd> | --url <url>)");
    return runDirectCommandProcess(ctx, [
      "--mcp-add",
      "--name",
      name,
      ...(getFlag(ctx.parsed, "--transport") ? ["--transport", getFlag(ctx.parsed, "--transport")!] : []),
      ...(getFlag(ctx.parsed, "--command") ? ["--command", getFlag(ctx.parsed, "--command")!] : []),
      ...(getFlag(ctx.parsed, "--url") ? ["--url", getFlag(ctx.parsed, "--url")!] : []),
      "--cwd",
      path.resolve(getFlag(ctx.parsed, "--cwd") || process.cwd()),
    ]);
  }
  if (sub === "remove" || sub === "enable" || sub === "disable" || sub === "test") {
    const id = ctx.parsed.rest[1] || getFlag(ctx.parsed, "--name");
    if (!id && sub !== "test") return usageError(`Usage: cowork mcp ${sub} <serverId>`);
    return runDirectCommandProcess(ctx, [`--mcp-${sub}`, ...(id ? ["--name", id] : [])]);
  }
  process.stderr.write("Usage: cowork mcp list|add|remove|enable|disable|test\n");
  return 1;
}

async function skills(ctx: CommandContext): Promise<number> {
  const sub = ctx.parsed.rest[0] || "list";
  if (sub === "list") return runDirectCommandProcess(ctx, ["--skills-list", "--limit", String(parseLimit(ctx, 200))]);
  if (sub === "info") {
    const id = ctx.parsed.rest.slice(1).join(" ").trim();
    if (!id) return usageError("Usage: cowork skills info <skillId-or-name>");
    return runDirectCommandProcess(ctx, ["--skills-info", "--name", id]);
  }
  if (sub === "audit") return runDirectCommandProcess(ctx, ["--skills-audit"]);
  process.stderr.write("Usage: cowork skills list|info|audit\n");
  return 1;
}

async function models(ctx: CommandContext): Promise<number> {
  const sub = ctx.parsed.rest[0] || "list";
  if (sub === "list") return runDirectCommandProcess(ctx, ["--models-list", "--limit", String(parseLimit(ctx, 100))]);
  process.stderr.write("Usage: cowork models list\n");
  return 1;
}

async function backup(ctx: CommandContext): Promise<number> {
  const sub = ctx.parsed.rest[0] || "create";
  if (sub === "create") {
    return runDirectCommandProcess(ctx, [
      "--backup-create",
      ...(getFlag(ctx.parsed, "--output") ? ["--output", getFlag(ctx.parsed, "--output")!] : []),
      "--limit",
      String(parseLimit(ctx, 500)),
      ...(hasFlag(ctx.parsed, "--include-secrets") ? ["--include-secrets"] : []),
      ...(hasFlag(ctx.parsed, "--yes") ? ["--yes"] : []),
    ]);
  }
  if (sub === "restore") {
    const file = ctx.parsed.rest[1] || getFlag(ctx.parsed, "--output");
    if (!file) return usageError("Usage: cowork backup restore <backup.json> [--dry-run] [--yes]");
    return runDirectCommandProcess(ctx, [
      "--backup-restore",
      "--output",
      file,
      ...(hasFlag(ctx.parsed, "--dry-run") ? ["--dry-run"] : []),
      ...(hasFlag(ctx.parsed, "--yes") ? ["--yes"] : []),
    ]);
  }
  process.stderr.write("Usage: cowork backup create|restore\n");
  return 1;
}

async function security(ctx: CommandContext): Promise<number> {
  const sub = ctx.parsed.rest[0] || "audit";
  if (sub === "audit") return runDirectCommandProcess(ctx, ["--security-audit"]);
  if (sub === "rules") {
    const action = ctx.parsed.rest[1] || "list";
    if (action === "list") {
      return runDirectCommandProcess(ctx, [
        "--security-rules-list",
        ...(getFlag(ctx.parsed, "--workspace-id") ? ["--workspace-id", getFlag(ctx.parsed, "--workspace-id")!] : []),
      ]);
    }
    if (action === "remove") {
      const ruleId = ctx.parsed.rest[2] || getFlag(ctx.parsed, "--rule-id");
      if (!ruleId) return usageError("Usage: cowork security rules remove <ruleId> --yes");
      return runDirectCommandProcess(ctx, ["--security-rules-remove", "--rule-id", ruleId, ...(hasFlag(ctx.parsed, "--yes") ? ["--yes"] : [])]);
    }
  }
  process.stderr.write("Usage: cowork security audit | cowork security rules list|remove\n");
  return 1;
}

async function promptSize(ctx: CommandContext): Promise<number> {
  const text = ctx.parsed.rest.join(" ").trim();
  if (!text) return usageError("Usage: cowork prompt-size <prompt text>");
  return runDirectCommandProcess(ctx, ["--prompt-size", "--prompt", text]);
}

async function promptPreview(ctx: CommandContext): Promise<number> {
  const text = ctx.parsed.rest.join(" ").trim();
  if (!text) return usageError("Usage: cowork prompt-preview <prompt text>");
  return runDirectCommandProcess(ctx, ["--prompt-preview", "--prompt", text]);
}

function completions(ctx: CommandContext): number {
  const shell = ctx.parsed.rest[0] || getFlag(ctx.parsed, "--shell") || "zsh";
  process.stdout.write(renderCompletions(shell));
  return 0;
}

async function dashboard(ctx: CommandContext): Promise<number> {
  const sub = ctx.parsed.rest[0] || "open";
  if (sub === "status") return runDirectCommandProcess(ctx, ["--dashboard-status"]);
  if (sub !== "open") return usageError("Usage: cowork dashboard [open|status]");
  return launchDesktopApp([]);
}

async function openCommand(ctx: CommandContext): Promise<number> {
  const target = ctx.parsed.rest[0] || "dashboard";
  if (target === "dashboard") return launchDesktopApp([]);
  if (target === "task") {
    const taskId = ctx.parsed.rest[1];
    if (!taskId) return usageError("Usage: cowork open task <taskId>");
    return launchDesktopApp([`cowork://task/${taskId}`]);
  }
  return usageError("Usage: cowork open dashboard | cowork open task <taskId>");
}

async function connectedClient(ctx: CommandContext): Promise<ControlPlaneClient> {
  if (!ctx.connection.token) {
    const reason = ctx.discoveryError ? `\nAuto-discovery: ${ctx.discoveryError}` : "";
    throw new Error(
      [
        "No local CoWork GUI/control-plane connection is available yet.",
        reason,
        "Fix:",
        "  1. Make sure CoWork OS is running with Control Plane enabled.",
        "  2. Or run `cowork login --token <control-plane-token>` once.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  const client = createClient(ctx);
  try {
    await client.connect();
  } catch (error) {
    client.close();
    if (ctx.autoDiscovered) {
      const source = ctx.discoverySource ? `\nDiscovered from: ${ctx.discoverySource}` : "";
      throw new Error(
        [
          `Found local CoWork GUI settings for ${ctx.connection.url}, but the Control Plane is not reachable.`,
          source,
          `Connection error: ${error instanceof Error ? error.message : String(error)}`,
          "Fix:",
          "  1. In the CoWork OS desktop app, enable/start Control Plane, or restart the app after this update.",
          "  2. Then run `cowork doctor`.",
          "  3. As a fallback, run `cowork login --token <control-plane-token>` once.",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
    throw error;
  }
  return client;
}

function createClient(ctx: CommandContext): ControlPlaneClient {
  return new ControlPlaneClient({
    url: ctx.connection.url,
    token: ctx.connection.token,
    deviceName: getFlag(ctx.parsed, "--device-name") || "cowork-cli",
  });
}

async function resolveWorkspaceId(client: ControlPlaneClient, ctx: CommandContext, cwd: string): Promise<string> {
  const explicit = getFlag(ctx.parsed, "--workspace-id");
  if (explicit) return explicit;
  const named = getFlag(ctx.parsed, "--workspace");
  const payload = await client.request(METHODS.WORKSPACE_LIST);
  const workspaces = extractArrayPayload<WorkspaceLike>(payload, "workspaces");
  const match = workspaces.find((workspace) => {
    if (named && workspace.name === named) return true;
    return workspace.path ? path.resolve(workspace.path) === cwd : false;
  });
  if (match?.id) return match.id;
  if (hasFlag(ctx.parsed, "--no-create-workspace")) {
    throw new Error(`No workspace found for ${cwd}. Run: cowork workspace create ${cwd}`);
  }
  const created = await client.request(METHODS.WORKSPACE_CREATE, {
    name: named || path.basename(cwd) || "Workspace",
    path: cwd,
  });
  const workspace = (created as Any).workspace as WorkspaceLike | undefined;
  if (!workspace?.id) throw new Error("Workspace creation succeeded but no workspace id was returned.");
  process.stdout.write(`Created workspace: ${formatWorkspace(workspace)}\n`);
  return workspace.id;
}

async function streamTask(
  client: ControlPlaneClient,
  taskId: string,
  limit: number,
  json = false,
): Promise<number> {
  const history = await client.request(METHODS.TASK_EVENTS, { taskId, limit: sanitizeLimit(limit, 200) });
  const events = extractArrayPayload<ControlPlaneFrame>(history, "events");
  for (const event of events) {
    if (json) {
      printJson(event);
      continue;
    }
    const line = formatTaskEventFrame({ type: "event", event: "task.event", payload: event });
    if (line) process.stdout.write(`${line}\n`);
  }
  const existingTerminal = events.some((event) =>
    isTerminalTaskFrame({ type: "event", event: "task.event", payload: event }, taskId),
  );
  if (existingTerminal) return 0;

  return new Promise((resolve) => {
    const cleanup = client.onEvent((frame) => {
      if (!matchesTask(frame, taskId)) return;
      if (json) {
        printJson(frame);
      } else {
        const line = formatTaskEventFrame(frame);
        if (line) process.stdout.write(`${line}\n`);
      }
      if (isTerminalTaskFrame(frame, taskId)) {
        cleanup();
        resolve(frame.event === "task.failed" ? 1 : 0);
      }
    });
    const onSignal = () => {
      cleanup();
      resolve(130);
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}

function printLinesOrJson(ctx: CommandContext, jsonValue: unknown, lines: string[]): void {
  if (ctx.json) {
    printJson(jsonValue);
    return;
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

function formatConfigWarnings(config: unknown): string[] {
  const warnings = extractArrayPayload<string>(config, "warnings");
  if (warnings.length === 0) return ["- config: ready"];
  return ["- warnings:", ...warnings.map((warning) => `  - ${warning}`)];
}

function formatProviders(llm: Any): string[] {
  const providers = Array.isArray(llm.providers) ? llm.providers : [];
  const lines = [
    `Current provider: ${llm.currentProvider || "unknown"}`,
    `Current model: ${llm.currentModel || "default"}`,
  ];
  for (const provider of providers) {
    lines.push(`${provider.type || "unknown"}  ${provider.configured ? "configured" : "missing"}`);
  }
  return lines;
}

function parseLimit(ctx: CommandContext, fallback: number, flag = "--limit"): number {
  return sanitizeLimit(Number(getFlag(ctx.parsed, flag) || fallback), fallback);
}

function parseDays(ctx: CommandContext, fallback: number): number {
  const value = Number(getFlag(ctx.parsed, "--days") || fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(36500, Math.floor(value)));
}

function sessionPruneDirectArgs(ctx: CommandContext): string[] {
  const out: string[] = [];
  const pushValue = (flag: string, directFlag = flag) => {
    const value = getFlag(ctx.parsed, flag);
    if (!value) return;
    out.push(directFlag, value);
  };

  pushValue("--days");
  pushValue("--older-than");
  pushValue("--newer-than");
  pushValue("--after");
  pushValue("--before");
  pushValue("--source");
  pushValue("--title");
  pushValue("--cwd", "--cwd-filter");
  pushValue("--provider");
  pushValue("--model");
  pushValue("--end-reason");
  pushValue("--min-tokens");
  pushValue("--max-tokens");
  pushValue("--min-cost");
  pushValue("--max-cost");
  pushValue("--limit");

  return out;
}

function sanitizeLimit(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(2000, Math.floor(value)));
}

function providerEnvKey(providerType: string): string {
  const upper = providerType.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return process.env[`${upper}_API_KEY`] || "";
}

const RESERVED_RUN_PROMPTS = new Set([
  "doctor",
  "status",
  "version",
  "workspace",
  "workspaces",
  "tasks",
  "task",
  "tail",
  "approvals",
  "providers",
  "provider",
  "sessions",
  "session",
  "logs",
  "log",
  "tools",
  "tool",
  "mcp",
  "skills",
  "skill",
  "models",
  "model",
  "backup",
  "security",
  "dashboard",
  "open",
]);

function isLikelyCommandPrompt(prompt: string): boolean {
  const normalized = prompt.trim().toLowerCase();
  return Boolean(normalized) && RESERVED_RUN_PROMPTS.has(normalized);
}

function usageError(message: string): number {
  process.stderr.write(`${message}\n`);
  return 1;
}

function launchDesktopApp(extraArgs: string[]): Promise<number> {
  const runtime = resolveDirectRuntime();
  if (!runtime.usesElectron) {
    process.stderr.write("Launching the desktop app requires the Electron runtime from this installation.\n");
    return Promise.resolve(1);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(runtime.executable, [runtime.appPath, ...extraArgs], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "" },
    });
    child.on("error", reject);
    child.unref();
    process.stdout.write("Opened CoWork OS desktop app.\n");
    resolve(0);
  });
}

function renderCompletions(shell: string): string {
  const commands = [
    "doctor",
    "status",
    "version",
    "workspace",
    "run",
    "tail",
    "approvals",
    "approve",
    "reject",
    "providers",
    "sessions",
    "tasks",
    "logs",
    "tools",
    "mcp",
    "skills",
    "models",
    "backup",
    "security",
    "prompt-size",
    "prompt-preview",
    "dashboard",
    "open",
    "completions",
  ];
  if (shell === "bash") {
    return [
      "_cowork_complete() {",
      `  COMPREPLY=( $(compgen -W "${commands.join(" ")}" -- "\${COMP_WORDS[1]}") )`,
      "}",
      "complete -F _cowork_complete cowork",
      "",
    ].join("\n");
  }
  if (shell === "fish") {
    return commands.map((command) => `complete -c cowork -f -a ${command}`).join("\n") + "\n";
  }
  return [
    "#compdef cowork",
    `_arguments '1:command:(${commands.join(" ")})' '*::arg:_files'`,
    "",
  ].join("\n");
}

function getFlag(parsed: ParsedArgs, flag: string): string | undefined {
  const value = parsed.flags.get(flag);
  return typeof value === "string" && value.trim() ? value : undefined;
}

function hasFlag(parsed: ParsedArgs, flag: string): boolean {
  return parsed.flags.has(flag);
}

function handleError(error: unknown): number {
  if (error instanceof ControlPlaneRequestError) {
    const code = error.code ? ` [${error.code}]` : "";
    process.stderr.write(`Control plane error${code}: ${error.message}\n`);
    return 1;
  }
  if (error instanceof Error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  process.stderr.write(`${String(error)}\n`);
  return 1;
}

function usage(): void {
  process.stdout.write(
    [
      "CoWork OS CLI",
      "",
      "Local-first commands do not require the desktop Control Plane. Use --remote only when you intentionally want the WebSocket control-plane path.",
      "",
      "Usage:",
      "  cowork",
      "  cowork version",
      "  cowork status",
      "  cowork doctor",
      "  cowork login --token <token> [--url ws://127.0.0.1:18789]",
      "  cowork daemon start [--background]",
      "  cowork workspace list",
      "  cowork workspace create [path]",
      '  cowork run "task prompt" [--cwd <path>] [--workspace-id <id>] [--shell] [--detach] [--force]',
      '  cowork run "task prompt" --remote [--url <ws-url>] [--token <token>]',
      "  cowork tail <taskId>",
      "  cowork tasks list [--active] [--cli]",
      "  cowork tasks cancel <taskId>",
      "  cowork tasks attach <taskId>",
      "  cowork tasks stale",
      "  cowork tasks cleanup --interrupted-cli --yes",
      "  cowork approvals",
      "  cowork approve <approvalId>",
      "  cowork reject <approvalId>",
      "  cowork providers list",
      "  cowork providers configure <provider> [--api-key <key>] [--model <model>]",
      "  cowork providers fallback list|add|remove",
      "  cowork sessions list|show|export|rename|archive|delete|prune",
      "  cowork logs latest|tail|grep",
      "  cowork tools list|info|enable|disable",
      "  cowork mcp list|add|remove|enable|disable|test",
      "  cowork skills list|info|audit",
      "  cowork models list",
      "  cowork backup create|restore",
      "  cowork security audit",
      "  cowork security rules list|remove",
      "  cowork prompt-size <prompt text>",
      "  cowork prompt-preview <prompt text>",
      "  cowork completions zsh|bash|fish",
      "  cowork dashboard [open|status]",
      "  cowork open dashboard | cowork open task <taskId>",
      "",
      "Global flags:",
      "  --profile <name>       Use a saved CLI profile",
      "  --url <ws-url>          Override control-plane URL for --remote commands",
      "  --token <token>         Override control-plane token for --remote commands",
      "  --json                  Print JSON output",
      "",
      "Remote env:",
      "  COWORK_CONTROL_PLANE_URL",
      "  COWORK_CONTROL_PLANE_TOKEN",
    ].join("\n"),
  );
}

if (typeof require !== "undefined" && require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}
