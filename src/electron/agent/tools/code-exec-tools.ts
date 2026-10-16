/**
 * Code Execution Tools
 *
 * Exposes sandboxed code execution to the agent as an `execute_code` tool.
 * Delegates to the existing ISandbox infrastructure (MacOSSandbox / DockerSandbox / NoSandbox).
 *
 * Supported languages: python, javascript, shell
 * Timeout: 1–300 seconds (default 30)
 * Output cap: 100 KB per stream
 */

import { ISandbox, SandboxOptions, createSandbox } from "../sandbox/sandbox-factory";
import { createSecureTempFile } from "../sandbox/security-utils";
import type { Workspace, SpaceSandboxConfig } from "../../../shared/types";
import { describeSpaceExecution } from "../../../shared/space-sandbox";
import type { LLMTool } from "../llm/types";
import { canEnableSubprocessNetwork } from "../../security/subprocess-network-policy";

export interface CodeExecInput {
  language: "python" | "javascript" | "shell";
  code: string;
  /** Timeout in seconds. Clamped to [1, 300]. Default: 30. */
  timeout_seconds?: number;
  /** Allow outbound network access inside the sandbox. Default: false. */
  allow_network?: boolean;
}

export interface CodeExecResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  timed_out: boolean;
  output_truncated: boolean;
  language: string;
  error?: string;
  outcome_unknown?: boolean;
}

const MAX_OUTPUT_BYTES = 100 * 1024; // 100 KB
const DEFAULT_TIMEOUT_SECONDS = 30;
const MIN_TIMEOUT_SECONDS = 1;
// Data processing, model inference and test scripts commonly need a few minutes;
// a 60 s ceiling forced them into run_command. The process still runs in the OS
// sandbox with the same output cap, network and approval rules.
const MAX_TIMEOUT_SECONDS = 300;

/** Run time in seconds that execute_code allows for a requested timeout_seconds. */
export function resolveCodeExecTimeoutSeconds(requested: unknown): number {
  const seconds =
    typeof requested === "number" && Number.isFinite(requested)
      ? requested
      : DEFAULT_TIMEOUT_SECONDS;
  return Math.min(MAX_TIMEOUT_SECONDS, Math.max(MIN_TIMEOUT_SECONDS, Math.round(seconds)));
}

export class CodeExecTools {
  private sandbox: ISandbox | null = null;
  private initializing?: Promise<ISandbox>;
  private readonly lifecycle = new AbortController();
  private closing?: Promise<void>;

  constructor(private workspace: Workspace) {}

  private async getSandbox(): Promise<ISandbox> {
    this.lifecycle.signal.throwIfAborted();
    if (this.sandbox) return this.sandbox;
    this.initializing ??= createSandbox(
      this.workspace,
      this.workspace.permissions?.sandboxType || "auto",
    );
    try {
      const sandbox = await this.initializing;
      this.sandbox = sandbox;
      this.lifecycle.signal.throwIfAborted();
      return sandbox;
    } finally {
      this.initializing = undefined;
    }
  }

  private assertNetworkExecutionAllowed(input: CodeExecInput): void {
    if (input.allow_network !== true) return;

    const permissions = this.workspace.permissions || ({} as Workspace["permissions"]);
    if (permissions.network !== true) {
      throw new Error("execute_code network access is disabled for this workspace.");
    }
    if (permissions.accessNetworkMode === "disabled") {
      throw new Error("execute_code network access is disabled by the active access profile.");
    }
    if (permissions.accessNetworkMode === "on-request") {
      throw new Error(
        "execute_code cannot enforce per-request network grants; use web_fetch, http_request, or web_search, or keep code networking disabled.",
      );
    }
    // The process sandboxes currently expose a coarse network on/off switch;
    // they cannot enforce per-domain egress for arbitrary user code. Refuse
    // the combination instead of pretending the profile remains effective.
    if ((permissions.accessDomainRules || []).length > 0) {
      throw new Error(
        "execute_code network access cannot be combined with domain-scoped network rules; use a profile without domain rules or keep network disabled.",
      );
    }
    if (!canEnableSubprocessNetwork(permissions)) {
      throw new Error("execute_code network access is disabled by administrator policy.");
    }
  }

  async executeCode(input: CodeExecInput, signal?: AbortSignal): Promise<CodeExecResult> {
    signal = AbortSignal.any([this.lifecycle.signal, ...(signal ? [signal] : [])]);
    signal.throwIfAborted();
    if (input.allow_network !== undefined && typeof input.allow_network !== "boolean") {
      throw new Error("execute_code allow_network must be a boolean.");
    }
    if (this.workspace.permissions?.shell !== true) {
      throw new Error("execute_code requires workspace shell permission.");
    }
    this.assertNetworkExecutionAllowed(input);
    const sandbox = await this.getSandbox();
    // SpaceSandbox re-checks administrator opt-in itself before every invocation.
    signal.throwIfAborted();
    const permissions = this.workspace.permissions || ({} as Workspace["permissions"]);
    const unrestrictedProfile =
      permissions.accessSandboxMode === "danger-full-access" &&
      permissions.accessApprovalPolicy === "never" &&
      permissions.unrestrictedFileAccess === true;
    if (
      sandbox.type === "none" &&
      (input.allow_network !== true || !canEnableSubprocessNetwork(permissions))
    ) {
      throw new Error(
        "execute_code cannot enforce network restrictions without an OS-level sandbox.",
      );
    }
    if (sandbox.type === "none" && !unrestrictedProfile) {
      throw new Error(
        "execute_code requires an OS-level sandbox. Configure Docker or macOS sandboxing before using this tool.",
      );
    }

    const timeoutSec = resolveCodeExecTimeoutSeconds(input.timeout_seconds);
    const options: SandboxOptions = {
      signal,
      timeout: timeoutSec * 1000,
      maxOutputSize: MAX_OUTPUT_BYTES,
      allowNetwork: input.allow_network === true,
      cwd: this.workspace.path,
    };

    const result =
      sandbox.type === "space" && input.language !== "shell"
        ? await sandbox.executeCode(input.code, input.language, options)
        : input.language === "shell"
          ? await sandbox.execute(input.code, [], options)
          : await this.executeScriptInSandbox(sandbox, input.language, input.code, options);

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exit_code: result.exitCode,
      timed_out: result.timedOut,
      output_truncated:
        result.stdout.includes("[Output truncated]") ||
        result.stderr.includes("[Output truncated]"),
      language: input.language,
      ...(result.error ? { error: result.error } : {}),
      ...(result.outcomeUnknown ? { outcome_unknown: true } : {}),
    };
  }

  private async executeScriptInSandbox(
    sandbox: ISandbox,
    language: "python" | "javascript",
    code: string,
    options: SandboxOptions,
  ) {
    const ext = language === "python" ? ".py" : ".js";
    const interpreter = language === "python" ? "python3" : "node";
    const { filePath, cleanup } = createSecureTempFile(ext, code);

    try {
      const allowedReadPaths = [...(options.allowedReadPaths || []), filePath];
      return await sandbox.execute(interpreter, [filePath], {
        ...options,
        allowedReadPaths,
      });
    } finally {
      cleanup();
    }
  }

  cleanup(): Promise<void> {
    this.lifecycle.abort();
    this.closing ??= (async () => {
      const sandbox = this.sandbox || (await this.initializing?.catch(() => undefined));
      await sandbox?.cleanup();
      this.sandbox = null;
    })();
    return this.closing;
  }

  static getToolDefinitions(spaceConfig?: SpaceSandboxConfig): LLMTool[] {
    return [
      {
        name: "execute_code",
        description: spaceConfig
          ? describeSpaceExecution(spaceConfig)
          : "Execute Python, JavaScript, or shell code in a sandboxed process with a configurable timeout. " +
            "Output is capped at 100 KB per stream. Network access is disabled by default. " +
            "Use for running scripts, data transformations, calculations, or verifying logic locally. " +
            "Only available in code/operations domain.",
        input_schema: {
          type: "object" as const,
          properties: {
            language: {
              type: "string",
              enum: ["python", "javascript", "shell"],
              description: "Programming language to execute",
            },
            code: {
              type: "string",
              description: "The code to execute. Shell code runs via /bin/sh -c.",
            },
            timeout_seconds: {
              type: "number",
              description: `Execution timeout in seconds. Range: ${MIN_TIMEOUT_SECONDS}–${MAX_TIMEOUT_SECONDS}. Default: ${DEFAULT_TIMEOUT_SECONDS}.`,
            },
            allow_network: {
              type: "boolean",
              description: "Allow outbound network access from the sandbox. Default: false.",
            },
          },
          required: ["language", "code"],
        },
      } satisfies LLMTool,
    ];
  }
}
