import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  AGENT_SECURITY_PROTOCOL_VERSION,
  type AgentSecurityHookPayload,
  type AgentSecurityHookResponse,
  type AgentSecurityMode,
  type AgentSecurityRuleProfile,
} from "../../../shared/agent-security";
import { hookEventToLifecycle } from "./NumbatEventAdapter";
import type { ResolvedNumbatBinary } from "./NumbatBinaryResolver";
import { redactAgentSecurityString } from "./NumbatRedaction";

const MAX_CONTROL_OUTPUT_BYTES = 1024 * 1024;

export interface NumbatHookInvocation {
  binary: ResolvedNumbatBinary;
  payload: AgentSecurityHookPayload;
  mode: AgentSecurityMode;
  ruleProfile: AgentSecurityRuleProfile;
  customRuleDirs: string[];
  recommendedRulesDir?: string;
  outputFile: string;
  stateDb: string;
  timeoutMs: number;
}

function buildChildEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "HOME",
    "USERPROFILE",
    "PATH",
    "SystemRoot",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
  ]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

function parseControlResponse(raw: string): AgentSecurityHookResponse {
  if (!raw.trim()) {
    return {
      protocol_version: AGENT_SECURITY_PROTOCOL_VERSION,
      decision: "no_override",
      health: "ok",
    };
  }
  const parsed = JSON.parse(raw) as Partial<AgentSecurityHookResponse>;
  if (parsed.protocol_version !== AGENT_SECURITY_PROTOCOL_VERSION) {
    throw new Error("Numbat returned an unsupported control protocol version");
  }
  if (parsed.decision !== "deny" && parsed.decision !== "no_override") {
    throw new Error("Numbat returned an invalid control decision");
  }
  if (parsed.health !== "ok" && parsed.health !== "degraded") {
    throw new Error("Numbat returned an invalid health state");
  }
  return parsed as AgentSecurityHookResponse;
}

function buildArgs(input: NumbatHookInvocation): string[] {
  const args = [
    "hook",
    hookEventToLifecycle(input.payload.hook_event_name),
    "--agent",
    "cowork-os",
    "--emit",
    "all",
    "--output",
    "file",
    "--output-file",
    input.outputFile,
    "--state-db",
    input.stateDb,
  ];
  if (input.ruleProfile === "recommended" && input.recommendedRulesDir) {
    args.push("--rules-dir", input.recommendedRulesDir);
  }
  if (input.ruleProfile === "custom") {
    for (const ruleDir of input.customRuleDirs) args.push("--rules-dir", ruleDir);
  }
  if (input.mode === "enforce") args.push("--enforce");
  return args;
}

export async function invokeNumbatHook(
  input: NumbatHookInvocation,
): Promise<AgentSecurityHookResponse> {
  fs.mkdirSync(path.dirname(input.outputFile), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(input.stateDb), { recursive: true, mode: 0o700 });
  const payload = JSON.stringify(input.payload);
  if (Buffer.byteLength(payload, "utf8") > 512 * 1024) {
    throw new Error("CoWork Numbat hook payload exceeds the local safety limit");
  }

  return await new Promise<AgentSecurityHookResponse>((resolve, reject) => {
    const child = spawn(input.binary.path, buildArgs(input), {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: buildChildEnvironment(),
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const finish = (error?: Error, response?: AgentSecurityHookResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(response!);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`Numbat hook timed out after ${input.timeoutMs} ms`));
    }, input.timeoutMs);
    timer.unref?.();

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_CONTROL_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(new Error("Numbat control output exceeded the safety limit"));
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stdout.on("error", (error) => {
      child.kill("SIGKILL");
      finish(new Error(`Failed to read Numbat hook output: ${error.message}`));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_CONTROL_OUTPUT_BYTES) stderrChunks.push(chunk);
    });
    child.stderr.on("error", (error) => {
      child.kill("SIGKILL");
      finish(new Error(`Failed to read Numbat hook diagnostics: ${error.message}`));
    });
    child.stdin.on("error", (error) => {
      finish(new Error(`Failed to send the Numbat hook payload: ${error.message}`));
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (settled) return;
      const stderr = redactAgentSecurityString(
        Buffer.concat(stderrChunks).toString("utf8").trim(),
        2_048,
      );
      if (code !== 0 && code !== 2) {
        finish(new Error(`Numbat hook exited with code ${code}${stderr ? `: ${stderr}` : ""}`));
        return;
      }
      try {
        const response = parseControlResponse(Buffer.concat(stdoutChunks).toString("utf8"));
        if (code === 2 && response.decision !== "deny") {
          finish(new Error("Numbat used its deny exit code without a deny response"));
          return;
        }
        finish(undefined, response);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stdin.end(payload);
  });
}
