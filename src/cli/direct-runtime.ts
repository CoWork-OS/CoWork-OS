import type { ChildProcess } from "child_process";
import type { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DIRECT_RUN_INJECTED_SYSTEM_CA_ENV } from "../electron/utils/direct-run-lifecycle";

export interface DirectRuntime {
  executable: string;
  scriptPath: string;
  appPath: string;
  usesElectron: boolean;
}

export interface DirectRuntimeLaunch {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

/** Preserve abnormal child exits instead of reporting them as successful CLI commands. */
export function resolveChildProcessExitCode(
  code: number | null,
  signal: NodeJS.Signals | null,
): number {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  if (signal) return 1;
  return code ?? 1;
}

/**
 * Signals the CLI passes on to the direct runner it started. Sent to the CLI's pid alone, they
 * would otherwise end only the CLI and leave the runner going, reparented to init and still
 * holding the output pipe and the profile database. SIGINT is not forwarded: Ctrl+C in a terminal
 * already reaches the whole foreground process group, runner included.
 */
export const FORWARDED_DIRECT_RUNNER_SIGNALS = ["SIGTERM", "SIGHUP"] as const;

/**
 * Forwards {@link FORWARDED_DIRECT_RUNNER_SIGNALS} to `child` until `stop` runs. `received` is
 * the last signal passed on, if any: the CLI was asked to stop and should end with the runner.
 */
export function forwardSignalsToChild(
  child: Pick<ChildProcess, "kill">,
  target: Pick<EventEmitter, "on" | "off"> = process,
): { stop: () => void; received: () => NodeJS.Signals | null } {
  let received: NodeJS.Signals | null = null;
  const forwarders = FORWARDED_DIRECT_RUNNER_SIGNALS.map((signal) => {
    const forward = () => {
      received = signal;
      child.kill(signal);
    };
    target.on(signal, forward);
    return { signal, forward };
  });
  return {
    stop: () => {
      for (const { signal, forward } of forwarders) target.off(signal, forward);
    },
    received: () => received,
  };
}

/** Signals that stop a direct run. */
export const DIRECT_RUNNER_STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * Calls `onStop` for the first stop signal only, and keeps absorbing repeats until the returned
 * function removes the listeners. Repeats are expected: a process-group kill reaches the runner
 * directly and again through the CLI's forwarding, and with no listener left the repeat would
 * kill the runner before its task is cancelled.
 */
export function onFirstStopSignal(
  onStop: (signal: NodeJS.Signals) => void,
  target: Pick<EventEmitter, "on" | "off"> = process,
): () => void {
  let stopped = false;
  const listener = (signal: NodeJS.Signals) => {
    if (stopped) return;
    stopped = true;
    onStop(signal);
  };
  for (const signal of DIRECT_RUNNER_STOP_SIGNALS) target.on(signal, listener);
  return () => {
    for (const signal of DIRECT_RUNNER_STOP_SIGNALS) target.off(signal, listener);
  };
}

export function shouldRunDirectRunEntrypoint(options: {
  isMainModule: boolean;
  isElectron: boolean;
  argv: string[];
}): boolean {
  if (options.isMainModule) return true;
  if (!options.isElectron || options.argv.includes("--cowork-cli-direct-run")) return false;
  return path.basename(options.argv[1] || "") === "direct-run.js";
}

/**
 * Build a local direct-run invocation.
 *
 * Electron-backed installs must enter through the app so the runner shares the
 * desktop user-data directory and can use Electron APIs such as safeStorage.
 */
export function buildDirectRuntimeLaunch(
  runtime: DirectRuntime,
  directArgs: string[],
  inheritedEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  invocationCwd: string = process.cwd(),
  legacyCliUserDataRoot: string | null = detectLegacyCliUserDataRoot(inheritedEnv),
): DirectRuntimeLaunch {
  const env: NodeJS.ProcessEnv = { ...inheritedEnv, COWORK_HEADLESS: "1" };
  const cwd = path.resolve(invocationCwd);

  // Only macOS needs the app entry (safeStorage Keychain identity). Elsewhere keep
  // the Node-mode runner: it needs no display and keeps the existing CLI data root.
  if (runtime.usesElectron && platform !== "darwin") {
    return {
      executable: runtime.executable,
      args: [runtime.scriptPath, ...directArgs],
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      cwd,
    };
  }

  if (runtime.usesElectron) {
    delete env.ELECTRON_RUN_AS_NODE;
    preserveLegacyCliUserDataRoot(env, legacyCliUserDataRoot);
    enableMacSystemCa(env, platform);
    return {
      executable: runtime.executable,
      args: [runtime.appPath, "--cowork-cli-direct-run", ...directArgs],
      env,
      cwd,
    };
  }

  return {
    executable: runtime.executable,
    args: [runtime.scriptPath, ...directArgs],
    env,
    cwd,
  };
}

/**
 * Before app-mode direct runs, the CLI (ELECTRON_RUN_AS_NODE) stored its data in
 * ~/.cowork. Keep using it when it holds a database so existing CLI tasks,
 * sessions and settings stay visible.
 */
function detectLegacyCliUserDataRoot(env: NodeJS.ProcessEnv): string | null {
  const home = env.HOME || env.USERPROFILE || os.homedir() || "";
  if (!home) return null;
  const root = path.join(home, ".cowork");
  return fs.existsSync(path.join(root, "cowork-os.db")) ? root : null;
}

function preserveLegacyCliUserDataRoot(
  env: NodeJS.ProcessEnv,
  legacyCliUserDataRoot: string | null,
): void {
  if (!legacyCliUserDataRoot) return;
  if (String(env.COWORK_USER_DATA_DIR || "").trim()) return;
  env.COWORK_USER_DATA_DIR = legacyCliUserDataRoot;
}

function enableMacSystemCa(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): void {
  if (platform !== "darwin" || String(env.COWORK_DEV_USE_SYSTEM_CA || "").trim() === "0") {
    return;
  }

  const nodeOptions = String(env.NODE_OPTIONS || "").trim();
  if (/(?:^|\s)--use-(?:system|bundled|openssl)-ca(?:\s|$)/.test(nodeOptions)) {
    return;
  }

  env.NODE_OPTIONS = [nodeOptions, "--use-system-ca"].filter(Boolean).join(" ");
  // Lets the Electron runner remove the flag from its env after startup so agent
  // shells and MCP servers running older Node versions don't inherit it.
  env[DIRECT_RUN_INJECTED_SYSTEM_CA_ENV] = "1";
}
