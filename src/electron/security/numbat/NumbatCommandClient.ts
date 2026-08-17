import { spawn } from "node:child_process";
import type { ResolvedNumbatBinary } from "./NumbatBinaryResolver";
import { redactAgentSecurityString } from "./NumbatRedaction";

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function commandEnvironment(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
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
  return { ...environment, ...extra };
}

export async function runNumbatCommand(input: {
  binary: ResolvedNumbatBinary;
  args: string[];
  timeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
}): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(input.binary.path, input.args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: commandEnvironment(input.environment),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`Numbat command timed out after ${input.timeoutMs ?? 30_000} ms`));
    }, input.timeoutMs ?? 30_000);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(new Error("Numbat command output exceeded the safety limit"));
        return;
      }
      stdout.push(chunk);
    });
    child.stdout.on("error", (error) => {
      child.kill("SIGKILL");
      finish(new Error(`Failed to read Numbat command output: ${error.message}`));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_OUTPUT_BYTES) stderr.push(chunk);
    });
    child.stderr.on("error", (error) => {
      child.kill("SIGKILL");
      finish(new Error(`Failed to read Numbat command diagnostics: ${error.message}`));
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        const detail = redactAgentSecurityString(
          Buffer.concat(stderr).toString("utf8").trim(),
          2_048,
        );
        finish(new Error(`Numbat command exited with code ${code}${detail ? `: ${detail}` : ""}`));
        return;
      }
      finish();
    });
  });
}
