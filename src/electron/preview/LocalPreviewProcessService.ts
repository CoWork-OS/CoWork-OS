import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import type {
  LocalPreviewCommandTemplate,
  LocalPreviewHealthResult,
  LocalPreviewLogEvent,
  LocalPreviewProcessInfo,
  LocalPreviewStartRequest,
  LocalPreviewTemplateId,
} from "../../shared/local-preview";
import { createLogger } from "../utils/logger";

const logger = createLogger("LocalPreviewProcessService");

export const LOCAL_PREVIEW_HOST = "127.0.0.1" as const;
export const LOCAL_PREVIEW_TEMPLATES: readonly LocalPreviewCommandTemplate[] = [
  {
    id: "npm-dev",
    label: "npm run dev",
    executable: "npm",
    args: ["run", "dev", "--", "--host", "${HOST}", "--port", "${PORT}"],
    description: "Run the project’s explicitly named dev script through npm.",
  },
  {
    id: "pnpm-dev",
    label: "pnpm dev",
    executable: "pnpm",
    args: ["dev", "--host", "${HOST}", "--port", "${PORT}"],
    description: "Run the project’s explicitly named dev script through pnpm.",
  },
  {
    id: "yarn-dev",
    label: "yarn dev",
    executable: "yarn",
    args: ["dev", "--host", "${HOST}", "--port", "${PORT}"],
    description: "Run the project’s explicitly named dev script through Yarn.",
  },
  {
    id: "bun-dev",
    label: "bun dev",
    executable: "bun",
    args: ["run", "dev", "--host", "${HOST}", "--port", "${PORT}"],
    description: "Run the project’s explicitly named dev script through Bun.",
  },
];

const MAX_LOG_LINES = 400;
const MAX_LOG_LINE_LENGTH = 8_000;
const HEALTH_TIMEOUT_MS = 1_500;
const START_HEALTH_TIMEOUT_MS = 12_000;
const STOP_PROCESS_TIMEOUT_MS = 1_500;
const HOST_PLACEHOLDER = "${HOST}";
const PORT_PLACEHOLDER = "${PORT}";
const SENSITIVE_LOG_PATTERN =
  /(authorization|token|api[-_ ]?key|secret|password|passwd|cookie|set-cookie|session)\s*[=:]\s*([^\s"';&]+)/gi;
const PREVIEW_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "TERM",
  "COLORTERM",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "WINDIR",
]);

type PreviewRuntime = {
  key: string;
  info: LocalPreviewProcessInfo;
  request: LocalPreviewStartRequest;
  child: ChildProcess;
  stopRequested: boolean;
  logListeners: Map<string, (event: LocalPreviewLogEvent) => void>;
};

export interface LocalPreviewProcessServiceDeps {
  templates?: readonly LocalPreviewCommandTemplate[];
  spawnProcess?: typeof spawn;
  allowLocalPreviewUrl?: (url: string) => void;
  revokeLocalPreviewUrl?: (url: string) => void;
  now?: () => number;
}

function cloneTemplate(template: LocalPreviewCommandTemplate): LocalPreviewCommandTemplate {
  return { ...template, args: [...template.args] };
}

function normalizeHealthPath(rawPath?: string): string {
  const value = String(rawPath || "/").trim() || "/";
  if (value.length > 256 || /[\\\s]/.test(value) || value.includes("..")) {
    throw new Error("Preview health path must be a short URL path without traversal.");
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//")) {
    throw new Error("Preview health path must be relative to the loopback preview URL.");
  }
  return value.startsWith("/") ? value : `/${value}`;
}

function normalizePort(port?: number): number {
  const value = port === undefined ? 0 : Number(port);
  if (!Number.isInteger(value) || value < 0 || value > 65_535 || (value > 0 && value < 1024)) {
    throw new Error("Preview port must be 0 or an available port between 1024 and 65535.");
  }
  return value;
}

function isTemplateId(value: unknown): value is LocalPreviewTemplateId {
  return LOCAL_PREVIEW_TEMPLATES.some((template) => template.id === value);
}

function substituteTemplate(template: LocalPreviewCommandTemplate, port: number): string[] {
  return template.args.map((arg) =>
    arg.replaceAll(HOST_PLACEHOLDER, LOCAL_PREVIEW_HOST).replaceAll(PORT_PLACEHOLDER, String(port)),
  );
}

function formatCommand(template: LocalPreviewCommandTemplate, args: string[]): string {
  return [template.executable, ...args]
    .map((part) => (/^[a-zA-Z0-9_./:=+-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(" ");
}

function redactLogOutput(output: string): string {
  return output.replace(SENSITIVE_LOG_PATTERN, "$1=[REDACTED]").slice(0, MAX_LOG_LINE_LENGTH);
}

function appendLogLines(existing: string[], output: string): string[] {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => redactLogOutput(line));
  if (lines.length === 0) return existing;
  return [...existing, ...lines].slice(-MAX_LOG_LINES);
}

function buildPreviewEnvironment(port: number): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (PREVIEW_ENV_KEYS.has(key) || /^LC_[A-Z0-9_]+$/.test(key)) {
      environment[key] = value;
    }
  }
  environment.HOST = LOCAL_PREVIEW_HOST;
  environment.HOSTNAME = LOCAL_PREVIEW_HOST;
  environment.PORT = String(port);
  environment.BROWSER = "none";
  environment.COWORK_LOCAL_PREVIEW = "1";
  delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
}

function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    }
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // The process may have already exited.
    }
  }
}

async function waitForProcessExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), STOP_PROCESS_TIMEOUT_MS)),
  ]);
  if (exited) return;
  try {
    if (process.platform === "win32") {
      if (child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
          stdio: "ignore",
          windowsHide: true,
        });
      }
    } else if (child.pid) {
      process.kill(-child.pid, "SIGKILL");
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may have exited between the timeout and the forced kill.
    }
  }
}

async function resolveDirectory(rawPath: string): Promise<string> {
  const resolved = await fs.realpath(rawPath);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) throw new Error("Preview working directory must be a directory.");
  return resolved;
}

async function allocateLoopbackPort(requestedPort: number): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error("Unable to allocate a local preview port."));
        else resolve(port);
      });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: LOCAL_PREVIEW_HOST, port: requestedPort });
  });
}

async function checkUrl(
  url: string,
  timeoutMs = HEALTH_TIMEOUT_MS,
): Promise<{
  ok: boolean;
  statusCode?: number;
  latencyMs: number;
  error?: string;
}> {
  const startedAt = Date.now();
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result: { ok: boolean; statusCode?: number; error?: string }) => {
      if (settled) return;
      settled = true;
      resolve({ ...result, latencyMs: Date.now() - startedAt });
    };
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      response.resume();
      response.once("end", () => {
        const statusCode = response.statusCode;
        finish({
          ok: typeof statusCode === "number" && statusCode >= 200 && statusCode < 400,
          statusCode,
        });
      });
    });
    request.once("error", (error) => finish({ ok: false, error: error.message }));
    request.once("timeout", () => {
      request.destroy();
      finish({ ok: false, error: "Health check timed out." });
    });
  });
}

export class LocalPreviewProcessService {
  private readonly templates: readonly LocalPreviewCommandTemplate[];
  private readonly spawnProcess: typeof spawn;
  private readonly allowLocalPreviewUrl?: (url: string) => void;
  private readonly revokeLocalPreviewUrl?: (url: string) => void;
  private readonly now: () => number;
  private readonly runtimes = new Map<string, PreviewRuntime>();
  private readonly runtimeIdsByKey = new Map<string, string>();
  private readonly starts = new Map<string, Promise<LocalPreviewProcessInfo>>();

  constructor(deps: LocalPreviewProcessServiceDeps = {}) {
    this.templates = deps.templates || LOCAL_PREVIEW_TEMPLATES;
    this.spawnProcess = deps.spawnProcess || spawn;
    this.allowLocalPreviewUrl = deps.allowLocalPreviewUrl;
    this.revokeLocalPreviewUrl = deps.revokeLocalPreviewUrl;
    this.now = deps.now || Date.now;
  }

  listTemplates(): LocalPreviewCommandTemplate[] {
    return this.templates.map(cloneTemplate);
  }

  async start(
    request: LocalPreviewStartRequest & { workspacePath: string },
  ): Promise<LocalPreviewProcessInfo> {
    const template = this.templates.find((candidate) => candidate.id === request.templateId);
    if (!template || !isTemplateId(template.id)) {
      throw new Error("Unsupported local preview command template.");
    }
    const workspacePath = await resolveDirectory(request.workspacePath);
    const workingDirectory = await resolveDirectory(request.workingDirectory || workspacePath);
    const relative = path.relative(workspacePath, workingDirectory);
    if (relative && (relative.startsWith("..") || path.isAbsolute(relative))) {
      throw new Error("Preview working directory must stay within the workspace.");
    }
    const key = `${request.workspaceId}:${workingDirectory}`;
    const existingId = this.runtimeIdsByKey.get(key);
    const existing = existingId ? this.runtimes.get(existingId) : undefined;
    if (existing && (existing.info.status === "starting" || existing.info.status === "ready")) {
      throw new Error("A local preview is already running for this workspace directory.");
    }
    const inFlight = this.starts.get(key);
    if (inFlight) return await inFlight;

    const startPromise = this.startInternal({
      ...request,
      workspacePath,
      workingDirectory,
    });
    this.starts.set(key, startPromise);
    try {
      return await startPromise;
    } finally {
      this.starts.delete(key);
    }
  }

  async restart(previewId: string): Promise<LocalPreviewProcessInfo> {
    const runtime = this.getRuntime(previewId);
    const request = { ...runtime.request };
    await this.stop(previewId);
    return await this.start({ ...request, workspacePath: runtime.info.workspacePath });
  }

  async stop(previewId: string): Promise<LocalPreviewProcessInfo> {
    const runtime = this.getRuntime(previewId);
    runtime.stopRequested = true;
    killProcessTree(runtime.child);
    await waitForProcessExit(runtime.child);
    this.revokeLocalPreviewUrl?.(runtime.info.url);
    runtime.info = {
      ...runtime.info,
      status: "stopped",
      updatedAt: this.now(),
    };
    if (this.runtimeIdsByKey.get(runtime.key) === previewId) {
      this.runtimeIdsByKey.delete(runtime.key);
    }
    return this.cloneInfo(runtime.info);
  }

  get(previewId: string): LocalPreviewProcessInfo | null {
    const runtime = this.runtimes.get(previewId);
    return runtime ? this.cloneInfo(runtime.info) : null;
  }

  list(workspaceId?: string): LocalPreviewProcessInfo[] {
    return Array.from(this.runtimes.values())
      .filter((runtime) => !workspaceId || runtime.info.workspaceId === workspaceId)
      .map((runtime) => this.cloneInfo(runtime.info));
  }

  async health(previewId: string): Promise<LocalPreviewHealthResult> {
    const runtime = this.getRuntime(previewId);
    const result = await checkUrl(runtime.info.healthUrl);
    if (result.ok && runtime.info.status === "starting") {
      runtime.info = { ...runtime.info, status: "ready", updatedAt: this.now() };
    }
    return {
      previewId,
      url: runtime.info.healthUrl,
      ...result,
      checkedAt: this.now(),
    };
  }

  subscribeLogs(previewId: string, listener: (event: LocalPreviewLogEvent) => void): () => void {
    const runtime = this.getRuntime(previewId);
    const listenerKey = `listener-${this.now()}-${Math.random().toString(36).slice(2, 8)}`;
    runtime.logListeners.set(listenerKey, listener);
    return () => runtime.logListeners.delete(listenerKey);
  }

  async stopAll(): Promise<void> {
    const active = Array.from(this.runtimes.values()).filter(
      (runtime) => runtime.info.status === "starting" || runtime.info.status === "ready",
    );
    await Promise.all(active.map((runtime) => this.stop(runtime.info.id)));
  }

  private async startInternal(
    request: LocalPreviewStartRequest & { workspacePath: string; workingDirectory: string },
  ): Promise<LocalPreviewProcessInfo> {
    const template = this.templates.find((candidate) => candidate.id === request.templateId)!;
    const port = await allocateLoopbackPort(normalizePort(request.port));
    const args = substituteTemplate(template, port);
    const healthPath = normalizeHealthPath(request.healthPath);
    const url = `http://${LOCAL_PREVIEW_HOST}:${port}/`;
    const healthUrl = new URL(healthPath, url).href;
    const id = `local-preview-${this.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = this.now();
    const info: LocalPreviewProcessInfo = {
      id,
      taskId: request.taskId,
      workspaceId: request.workspaceId,
      workspacePath: request.workspacePath,
      workingDirectory: request.workingDirectory,
      templateId: request.templateId,
      command: formatCommand(template, args),
      host: LOCAL_PREVIEW_HOST,
      port,
      url,
      healthUrl,
      status: "starting",
      pid: undefined,
      startedAt: now,
      updatedAt: now,
      logs: [],
    };
    const child = this.spawnProcess(template.executable, args, {
      cwd: request.workingDirectory,
      env: buildPreviewEnvironment(port),
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const runtime: PreviewRuntime = {
      key: `${request.workspaceId}:${request.workingDirectory}`,
      info: { ...info, pid: child.pid },
      request: { ...request },
      child,
      stopRequested: false,
      logListeners: new Map(),
    };
    this.runtimes.set(id, runtime);
    this.runtimeIdsByKey.set(runtime.key, id);
    this.allowLocalPreviewUrl?.(url);
    this.attachOutput(runtime, "stdout", child.stdout);
    this.attachOutput(runtime, "stderr", child.stderr);
    child.once("error", (error) => {
      this.updateAfterExit(runtime, null, error.message);
    });
    child.once("exit", (code) => {
      this.updateAfterExit(runtime, code ?? null);
    });

    const healthDeadline = this.now() + START_HEALTH_TIMEOUT_MS;
    while (this.now() < healthDeadline) {
      if (runtime.info.status === "failed" || runtime.info.status === "stopped") break;
      const result = await checkUrl(healthUrl, HEALTH_TIMEOUT_MS);
      if (result.ok) {
        runtime.info = { ...runtime.info, status: "ready", updatedAt: this.now() };
        return this.cloneInfo(runtime.info);
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (runtime.info.status === "failed" || runtime.info.status === "stopped") {
      throw new Error(
        runtime.info.lastError || "Local preview process exited before becoming healthy.",
      );
    }
    runtime.stopRequested = true;
    killProcessTree(runtime.child);
    await waitForProcessExit(runtime.child);
    this.revokeLocalPreviewUrl?.(runtime.info.url);
    runtime.info = {
      ...runtime.info,
      status: "failed",
      lastError: "Local preview process did not become healthy before the startup timeout.",
      updatedAt: this.now(),
    };
    if (this.runtimeIdsByKey.get(runtime.key) === runtime.info.id) {
      this.runtimeIdsByKey.delete(runtime.key);
    }
    throw new Error(runtime.info.lastError);
  }

  private attachOutput(
    runtime: PreviewRuntime,
    stream: "stdout" | "stderr",
    output: NodeJS.ReadableStream | null,
  ): void {
    output?.on("data", (chunk: Buffer | string) => {
      const text = redactLogOutput(String(chunk));
      runtime.info = {
        ...runtime.info,
        logs: appendLogLines(runtime.info.logs, text),
        updatedAt: this.now(),
      };
      const event: LocalPreviewLogEvent = {
        previewId: runtime.info.id,
        stream,
        output: text,
        timestamp: this.now(),
      };
      for (const listener of runtime.logListeners.values()) listener(event);
    });
  }

  private updateAfterExit(runtime: PreviewRuntime, exitCode: number | null, error?: string): void {
    if (runtime.info.status === "stopped" && runtime.stopRequested) return;
    this.revokeLocalPreviewUrl?.(runtime.info.url);
    runtime.info = {
      ...runtime.info,
      status: runtime.stopRequested ? "stopped" : "failed",
      exitCode,
      lastError:
        error || (runtime.stopRequested ? undefined : `Preview exited with code ${exitCode}.`),
      updatedAt: this.now(),
    };
    if (this.runtimeIdsByKey.get(runtime.key) === runtime.info.id) {
      this.runtimeIdsByKey.delete(runtime.key);
    }
    if (!runtime.stopRequested) {
      logger.warn("Local preview process exited", {
        previewId: runtime.info.id,
        exitCode,
        error: error || undefined,
      });
    }
  }

  private getRuntime(previewId: string): PreviewRuntime {
    const runtime = this.runtimes.get(previewId);
    if (!runtime) throw new Error("Local preview process not found.");
    return runtime;
  }

  private cloneInfo(info: LocalPreviewProcessInfo): LocalPreviewProcessInfo {
    return { ...info, logs: [...info.logs] };
  }
}

let localPreviewProcessService: LocalPreviewProcessService | null = null;

export function getLocalPreviewProcessService(): LocalPreviewProcessService {
  if (!localPreviewProcessService) {
    // Imported lazily to keep this service independently testable and avoid a
    // browser-policy initialization cycle during Electron startup.
    const { getBrowserWorkbenchService } =
      require("../browser/browser-workbench-service") as typeof import("../browser/browser-workbench-service");
    localPreviewProcessService = new LocalPreviewProcessService({
      allowLocalPreviewUrl: (url) => getBrowserWorkbenchService().allowLocalPreviewUrl(url),
      revokeLocalPreviewUrl: (url) => getBrowserWorkbenchService().revokeLocalPreviewUrl(url),
    });
  }
  return localPreviewProcessService;
}
