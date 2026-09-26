import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  EXTERNAL_RUNTIME_AGENT_LABELS,
  type ExternalRuntimeConfig,
  type WorkspacePermissions,
} from "../../shared/types";
import type { AdminPolicies } from "../admin/policies";

/** ACP adapters cannot enforce CoWork's bounded filesystem/network policy. */
export function assertAcpxExecutionAuthority(
  permissions: WorkspacePermissions,
  runtimePolicy: AdminPolicies["runtime"],
): void {
  if (
    permissions.accessSandboxMode !== "danger-full-access" ||
    permissions.accessProfileScoped ||
    permissions.accessProfileUnavailable ||
    permissions.shell !== true ||
    permissions.read !== true ||
    permissions.write !== true ||
    permissions.network !== true ||
    permissions.accessNetworkMode !== "enabled" ||
    (permissions.accessFilesystemRules?.length || 0) > 0 ||
    (permissions.accessDomainRules?.length || 0) > 0 ||
    runtimePolicy.requireSandboxForShell ||
    runtimePolicy.network.defaultAction !== "allow" ||
    runtimePolicy.network.allowedDomains.length > 0 ||
    runtimePolicy.network.blockedDomains.length > 0
  ) {
    throw new Error(
      "External ACP execution cannot enforce this task's access boundary. Use the native runtime for bounded tasks.",
    );
  }
}

export interface AcpxRuntimeEvent {
  type: string;
  payload: Record<string, unknown>;
}

export interface AcpxPromptResult {
  assistantText: string;
  stopReason?: string;
  sessionId?: string;
}

export class AcpxRuntimeUnavailableError extends Error {
  readonly code = "ACPX_UNAVAILABLE";

  constructor(message = "acpx is not installed or is not available on PATH") {
    super(message);
    this.name = "AcpxRuntimeUnavailableError";
  }
}

export function getAcpxSessionName(taskId: string): string {
  return `cowork-${taskId}`;
}

export function getAcpxPermissionArgs(
  permissionMode: ExternalRuntimeConfig["permissionMode"],
): string[] {
  switch (permissionMode) {
    case "approve-all":
      return ["--approve-all"];
    case "approve-reads":
      return ["--approve-reads"];
    case "deny-all":
    default:
      return ["--deny-all"];
  }
}

export function getAcpxAgentDisplayName(agent: ExternalRuntimeConfig["agent"]): string {
  return EXTERNAL_RUNTIME_AGENT_LABELS[agent] || "Codex";
}

export function buildAcpxBaseArgs(input: {
  cwd: string;
  runtimeConfig: ExternalRuntimeConfig;
}): string[] {
  const args = [
    "--format",
    "json",
    "--json-strict",
    "--cwd",
    input.cwd,
    ...getAcpxPermissionArgs(input.runtimeConfig.permissionMode),
    "--non-interactive-permissions",
    "fail",
  ];
  if (
    typeof input.runtimeConfig.ttlSeconds === "number" &&
    Number.isFinite(input.runtimeConfig.ttlSeconds) &&
    input.runtimeConfig.ttlSeconds >= 0
  ) {
    args.push("--ttl", String(Math.max(0, Math.round(input.runtimeConfig.ttlSeconds))));
  }
  return args;
}

export function buildAcpxCommandArgs(input: {
  cwd: string;
  runtimeConfig: ExternalRuntimeConfig;
  commandArgs: string[];
}): string[] {
  return [...buildAcpxBaseArgs(input), input.runtimeConfig.agent, ...input.commandArgs];
}

type AcpxLauncherSpec = {
  command: string;
  prefixArgs: string[];
  label: string;
};

let preferredAcpxLauncherLabel: string | null = null;

/**
 * Pinned so the npx fallback cannot silently pull new, unreviewed code at runtime.
 * Bump deliberately after checking the release.
 */
export const ACPX_PINNED_VERSION = "0.19.3";

function findOnPath(name: string, exts: string[]): string | null {
  const dirs = String(process.env.PATH || process.env.Path || "")
    .split(path.delimiter)
    .filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext}`);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/**
 * Windows: npm installs CLIs as `.cmd` shims, which Node will not spawn without a
 * shell, and a shell would re-parse the prompt text we pass as arguments (command
 * injection). Instead, read the JavaScript entry the shim wraps and run it with
 * node.exe directly, so arguments are passed verbatim and no shell is involved.
 * Returns null when the command cannot be resolved safely.
 */
export function resolveWindowsLauncher(
  spec: AcpxLauncherSpec,
  deps: { findOnPath?: typeof findOnPath; readFile?: (file: string) => string } = {},
): AcpxLauncherSpec | null {
  const find = deps.findOnPath || findOnPath;
  const readFile = deps.readFile || ((file: string) => fs.readFileSync(file, "utf8"));
  const exe = find(spec.command, [".exe"]);
  if (exe) return { ...spec, command: exe };
  const shim = find(spec.command, [".cmd"]);
  if (!shim) return null;
  let shimText: string;
  try {
    shimText = readFile(shim);
  } catch {
    return null;
  }
  // cmd-shim quotes the entry directly ("%dp0%\node_modules\x\cli.js"); npm's own
  // npx.cmd assigns it first (SET "NPX_CLI_JS=%~dp0\...\npx-cli.js") after a
  // npm-prefix.js helper, so take the last script that is not that helper.
  const entry = [...shimText.matchAll(/"(?:[A-Z_]+=)?%~?dp0%?\\?([^"%]+?\.(?:c|m)?js)"/gi)]
    .map((match) => match[1])
    .filter((file) => !/(?:^|\\)npm-prefix\.js$/i.test(file))
    .pop();
  if (!entry) return null;
  const shimDir = path.dirname(shim);
  const script = path.join(shimDir, entry);
  const siblingNode = path.join(shimDir, "node.exe");
  const node = (() => {
    try {
      if (fs.statSync(siblingNode).isFile()) return siblingNode;
    } catch {
      // fall back to PATH
    }
    return find("node", [".exe"]);
  })();
  if (!node) return null;
  return { ...spec, command: node, prefixArgs: [script, ...spec.prefixArgs] };
}

function getAcpxLaunchCandidates(): AcpxLauncherSpec[] {
  const baseCandidates: AcpxLauncherSpec[] = [
    { command: "acpx", prefixArgs: [], label: "acpx" },
    {
      command: "npx",
      prefixArgs: ["-y", `acpx@${ACPX_PINNED_VERSION}`],
      label: `npx acpx@${ACPX_PINNED_VERSION}`,
    },
  ];
  const candidates =
    process.platform === "win32"
      ? baseCandidates
          .map((candidate) => resolveWindowsLauncher(candidate))
          .filter((candidate): candidate is AcpxLauncherSpec => candidate !== null)
      : baseCandidates;
  if (!preferredAcpxLauncherLabel) return candidates;
  const preferred = candidates.find((candidate) => candidate.label === preferredAcpxLauncherLabel);
  const remaining = candidates.filter(
    (candidate) => candidate.label !== preferredAcpxLauncherLabel,
  );
  return preferred ? [preferred, ...remaining] : candidates;
}

export function resetAcpxLauncherPreferenceForTests(): void {
  preferredAcpxLauncherLabel = null;
}

export function parseAcpxJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = String(line || "").trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function quoteShellToken(value: string): string {
  return /\s|["'`$\\]/.test(value) ? JSON.stringify(value) : value;
}

function formatCommand(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((entry) => quoteShellToken(String(entry ?? "")))
      .filter((entry) => entry.length > 0)
      .join(" ");
  }
  return String(value || "");
}

function normalizeToolName(update: Record<string, unknown>): string {
  const rawInput =
    update.rawInput && typeof update.rawInput === "object" && !Array.isArray(update.rawInput)
      ? (update.rawInput as Record<string, unknown>)
      : {};
  const parsedCmd = Array.isArray(rawInput.parsed_cmd) ? rawInput.parsed_cmd[0] : undefined;
  if (parsedCmd && typeof parsedCmd === "object" && !Array.isArray(parsedCmd)) {
    const parsedType = String((parsedCmd as Record<string, unknown>).type || "").trim();
    if (parsedType) return parsedType;
  }
  const title = String(update.title || "").trim();
  if (title) return title;
  const kind = String(update.kind || "").trim();
  if (kind) return kind;
  return "tool";
}

export function mapAcpxSessionUpdate(
  update: Record<string, unknown>,
  agent: ExternalRuntimeConfig["agent"] = "codex",
): AcpxRuntimeEvent[] {
  const sessionUpdate = String(update.sessionUpdate || "");
  const events: AcpxRuntimeEvent[] = [];
  const agentName = getAcpxAgentDisplayName(agent);

  if (sessionUpdate === "tool_call") {
    const rawInput =
      update.rawInput && typeof update.rawInput === "object" && !Array.isArray(update.rawInput)
        ? (update.rawInput as Record<string, unknown>)
        : {};
    const command = formatCommand(rawInput.command);
    const cwd = String(rawInput.cwd || "");
    if (command) {
      events.push({
        type: "command_output",
        payload: {
          command,
          cwd,
          type: "start",
          output: `$ ${command}\n`,
        },
      });
    }
    events.push({
      type: "tool_call",
      payload: {
        tool: normalizeToolName(update),
        kind: String(update.kind || ""),
        title: String(update.title || ""),
        toolCallId: String(update.toolCallId || ""),
        status: String(update.status || ""),
        input: rawInput,
        command,
        cwd,
      },
    });
    return events;
  }

  if (sessionUpdate === "tool_call_update") {
    const rawOutput =
      update.rawOutput && typeof update.rawOutput === "object" && !Array.isArray(update.rawOutput)
        ? (update.rawOutput as Record<string, unknown>)
        : {};
    const command = formatCommand(rawOutput.command);
    const cwd = String(rawOutput.cwd || "");
    const formattedOutput = String(rawOutput.formatted_output || rawOutput.aggregated_output || "");
    if (formattedOutput) {
      events.push({
        type: "command_output",
        payload: {
          command,
          cwd,
          type: "stdout",
          output: formattedOutput,
        },
      });
    }
    const exitCode =
      typeof rawOutput.exit_code === "number" && Number.isFinite(rawOutput.exit_code)
        ? rawOutput.exit_code
        : undefined;
    const stderr = String(rawOutput.stderr || "");
    events.push({
      type: "tool_result",
      payload: {
        tool: normalizeToolName(update),
        toolCallId: String(update.toolCallId || ""),
        status: String(update.status || ""),
        success:
          String(update.status || "").toLowerCase() === "completed" &&
          (exitCode === undefined || exitCode === 0),
        error:
          exitCode !== undefined && exitCode !== 0
            ? stderr || `Command exited with ${exitCode}`
            : undefined,
        result: rawOutput,
        exitCode,
      },
    });
    return events;
  }

  if (sessionUpdate === "usage_update") {
    const used = typeof update.used === "number" ? update.used : undefined;
    events.push({
      type: "progress_update",
      payload: {
        phase: "acpx_runtime",
        message: used
          ? `${agentName} via ACP running (${used} tokens used)`
          : `${agentName} via ACP running`,
        state: "active",
        heartbeat: true,
      },
    });
    return events;
  }

  if (
    sessionUpdate.includes("thought") ||
    sessionUpdate.includes("progress") ||
    sessionUpdate.includes("status")
  ) {
    const friendlyMessage =
      sessionUpdate === "agent_thought_chunk"
        ? "Thinking"
        : sessionUpdate.includes("thought")
          ? `${agentName} is thinking`
          : sessionUpdate.includes("progress")
            ? `${agentName} is working`
            : `${agentName} updated its status`;
    events.push({
      type: "progress_update",
      payload: {
        phase: "acpx_runtime",
        message: friendlyMessage,
        state: "active",
      },
    });
    return events;
  }

  return events;
}

export class AcpxRuntimeRunner {
  private readonly sessionName: string;
  private activePromptProcess: ChildProcessWithoutNullStreams | null = null;

  constructor(
    private readonly input: {
      taskId: string;
      cwd: string;
      runtimeConfig: ExternalRuntimeConfig;
      emitEvent: (type: string, payload: Record<string, unknown>) => void;
    },
  ) {
    this.sessionName = getAcpxSessionName(input.taskId);
  }

  getSessionName(): string {
    return this.sessionName;
  }

  async createSession(): Promise<AcpxPromptResult> {
    return this.runCommand(["sessions", "new", "--name", this.sessionName]);
  }

  async ensureSession(): Promise<AcpxPromptResult> {
    return this.runCommand(["sessions", "ensure", "--name", this.sessionName]);
  }

  async prompt(prompt: string): Promise<AcpxPromptResult> {
    const agentName = getAcpxAgentDisplayName(this.input.runtimeConfig.agent);
    this.input.emitEvent("progress_update", {
      phase: "acpx_runtime",
      message: `Delegating to ${agentName} via ACP`,
      state: "active",
    });
    return this.runCommand(["prompt", "--session", this.sessionName, "--file", "-"], {
      stdin: prompt,
      trackAsActivePrompt: true,
    });
  }

  async cancel(): Promise<void> {
    try {
      // Use minimal args for cancel — global flags like --format and --cwd are
      // prompt-specific and may not be accepted by the cancel subcommand.
      await new Promise<void>((resolve) => {
        let finished = false;
        let fallbackStarted = false;
        const fallbackLauncher = getAcpxLaunchCandidates().find(
          (candidate) => candidate.label !== "acpx",
        );
        const resolveOnce = () => {
          if (finished) return;
          finished = true;
          resolve();
        };
        const startFallbackCancel = () => {
          if (finished || fallbackStarted || !fallbackLauncher) {
            return false;
          }
          fallbackStarted = true;
          const fallbackProc = spawn(
            fallbackLauncher.command,
            [
              ...fallbackLauncher.prefixArgs,
              this.input.runtimeConfig.agent,
              "cancel",
              "--session",
              this.sessionName,
            ],
            { cwd: this.input.cwd, env: process.env, stdio: "ignore" },
          );
          fallbackProc.on("close", () => {
            resolveOnce();
          });
          fallbackProc.on("error", () => {
            resolveOnce();
          });
          return true;
        };
        const primaryLauncher = getAcpxLaunchCandidates().find(
          (candidate) => candidate.label === "acpx",
        );
        if (!primaryLauncher) {
          if (!startFallbackCancel()) resolveOnce();
          return;
        }
        const proc = spawn(
          primaryLauncher.command,
          [
            ...primaryLauncher.prefixArgs,
            this.input.runtimeConfig.agent,
            "cancel",
            "--session",
            this.sessionName,
          ],
          { cwd: this.input.cwd, env: process.env, stdio: "ignore" },
        );
        proc.on("close", (code) => {
          if (finished) return;
          if (code === 0) {
            resolveOnce();
            return;
          }
          if (startFallbackCancel()) {
            return;
          }
          resolveOnce();
        });
        proc.on("error", (error: NodeJS.ErrnoException) => {
          if (finished) return;
          if (error.code === "ENOENT" && startFallbackCancel()) {
            return;
          }
          resolveOnce();
        });
      });
    } finally {
      if (this.activePromptProcess && !this.activePromptProcess.killed) {
        this.activePromptProcess.kill("SIGTERM");
      }
      this.activePromptProcess = null;
    }
  }

  async closeSession(): Promise<void> {
    try {
      await this.runCommand(["sessions", "close", this.sessionName]);
    } catch (error) {
      this.input.emitEvent("log", {
        message: `Failed to close ${getAcpxAgentDisplayName(this.input.runtimeConfig.agent)} acpx session cleanly.`,
        error: String((error as Any)?.message || error),
      });
    }
  }

  private async runCommand(
    commandArgs: string[],
    options?: {
      stdin?: string;
      trackAsActivePrompt?: boolean;
    },
  ): Promise<AcpxPromptResult> {
    const args = buildAcpxCommandArgs({
      cwd: this.input.cwd,
      runtimeConfig: this.input.runtimeConfig,
      commandArgs,
    });
    const launchCandidates = getAcpxLaunchCandidates();

    return new Promise<AcpxPromptResult>((resolve, reject) => {
      let lineBuffer = "";
      let stderr = "";
      let finalAssistantText = "";
      let stopReason: string | undefined;
      let sessionId: string | undefined;
      let lastProtocolError: string | undefined;
      let settled = false;
      let activeAttemptIndex = -1;

      const finishLine = (line: string) => {
        const parsed = parseAcpxJsonLine(line);
        if (!parsed) {
          this.input.emitEvent("log", {
            message: "Ignoring malformed acpx JSON line.",
            line,
          });
          return;
        }

        const errorObj =
          parsed.error && typeof parsed.error === "object" && !Array.isArray(parsed.error)
            ? (parsed.error as Record<string, unknown>)
            : undefined;
        if (errorObj) {
          lastProtocolError = String(errorObj.message || errorObj.code || "acpx protocol error");
        }

        const resultObj =
          parsed.result && typeof parsed.result === "object" && !Array.isArray(parsed.result)
            ? (parsed.result as Record<string, unknown>)
            : undefined;
        if (resultObj && typeof resultObj.sessionId === "string") {
          sessionId = resultObj.sessionId;
        }
        if (resultObj && typeof resultObj.stopReason === "string") {
          stopReason = resultObj.stopReason;
        }

        if (parsed.method === "session/update") {
          const params =
            parsed.params && typeof parsed.params === "object" && !Array.isArray(parsed.params)
              ? (parsed.params as Record<string, unknown>)
              : {};
          const update =
            params.update && typeof params.update === "object" && !Array.isArray(params.update)
              ? (params.update as Record<string, unknown>)
              : {};
          const sessionUpdate = String(update.sessionUpdate || "");
          if (sessionUpdate === "agent_message_chunk") {
            const content =
              update.content && typeof update.content === "object" && !Array.isArray(update.content)
                ? (update.content as Record<string, unknown>)
                : {};
            if (String(content.type || "") === "text") {
              finalAssistantText += String(content.text || "");
            }
            return;
          }
          const mapped = mapAcpxSessionUpdate(update, this.input.runtimeConfig.agent);
          for (const event of mapped) {
            this.input.emitEvent(event.type, event.payload);
          }
        }
      };

      const startAttempt = (attemptIndex: number) => {
        activeAttemptIndex = attemptIndex;
        const launcher = launchCandidates[attemptIndex];
        const launchArgs = [...launcher.prefixArgs, ...args];
        const proc = spawn(launcher.command, launchArgs, {
          cwd: this.input.cwd,
          env: process.env,
          stdio: ["pipe", "pipe", "pipe"],
        });
        if (options?.trackAsActivePrompt) {
          this.activePromptProcess = proc;
        }

        proc.stdout.on("data", (chunk) => {
          lineBuffer += chunk.toString();
          let newlineIndex = lineBuffer.indexOf("\n");
          while (newlineIndex >= 0) {
            const line = lineBuffer.slice(0, newlineIndex);
            lineBuffer = lineBuffer.slice(newlineIndex + 1);
            finishLine(line);
            newlineIndex = lineBuffer.indexOf("\n");
          }
        });

        proc.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
        });

        proc.once("error", (error: NodeJS.ErrnoException) => {
          if (settled || attemptIndex !== activeAttemptIndex) return;
          if (options?.trackAsActivePrompt) {
            this.activePromptProcess = null;
          }
          if (error.code === "ENOENT") {
            if (attemptIndex + 1 < launchCandidates.length) {
              startAttempt(attemptIndex + 1);
              return;
            }
            settled = true;
            reject(
              new AcpxRuntimeUnavailableError(
                `acpx is not installed and CoWork could not launch it via npx acpx@${ACPX_PINNED_VERSION}`,
              ),
            );
            return;
          }
          settled = true;
          reject(error);
        });

        proc.once("close", (code) => {
          if (settled || attemptIndex !== activeAttemptIndex) return;
          if (options?.trackAsActivePrompt) {
            this.activePromptProcess = null;
          }
          if (lineBuffer.trim()) {
            finishLine(lineBuffer);
          }
          if (lastProtocolError) {
            settled = true;
            reject(new Error(lastProtocolError));
            return;
          }
          if (code !== 0) {
            settled = true;
            reject(new Error(stderr.trim() || `acpx exited with code ${code}`));
            return;
          }
          preferredAcpxLauncherLabel = launcher.label;
          const trimmedAssistantText = finalAssistantText.trim();
          if (trimmedAssistantText) {
            this.input.emitEvent("assistant_message", { message: trimmedAssistantText });
          }
          settled = true;
          resolve({
            assistantText: trimmedAssistantText,
            stopReason,
            sessionId,
          });
        });

        if (options?.stdin !== undefined) {
          proc.stdin.write(options.stdin);
        }
        proc.stdin.end();
      };

      if (launchCandidates.length === 0) {
        reject(
          new AcpxRuntimeUnavailableError(
            `acpx could not be found. Install it with \`npm install -g acpx@${ACPX_PINNED_VERSION}\`.`,
          ),
        );
        return;
      }
      startAttempt(0);
    });
  }
}
