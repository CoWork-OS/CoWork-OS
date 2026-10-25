import { spawn } from "node:child_process";
import * as path from "node:path";

export interface SecretCliResult {
  code: number | null;
  stdout: string;
  /** Kept only to tell failures apart; never logged, stored or shown. */
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

export type SecretCliRunner = (
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<SecretCliResult>;

export const SECRET_CLI_TIMEOUT_MS = 30_000;
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;

/**
 * Run a vault CLI (`op`, `bws`): no shell, stdin closed so a CLI that wants to prompt fails
 * instead of hanging, bounded output, and a hard timeout. The environment is the caller's
 * allowlist, never the app's own.
 */
export const runSecretCli: SecretCliRunner = (file, args, env) =>
  new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let timedOut = false;
    const finish = (result: Partial<SecretCliResult>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, timedOut, ...result });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      resolve({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        spawnError: (error as NodeJS.ErrnoException).code || "spawn_failed",
      });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      finish({});
    }, SECRET_CLI_TIMEOUT_MS);
    child.stdout?.on("data", (data: Buffer) => {
      stdoutBytes += data.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        child.kill("SIGKILL");
        finish({ code: null, stdout: "" });
        return;
      }
      stdout += data.toString("utf8");
    });
    child.stderr?.on("data", (data: Buffer) => {
      if (stderr.length < MAX_STDERR_BYTES)
        stderr += data.toString("utf8").slice(0, MAX_STDERR_BYTES);
    });
    child.on("error", (error: NodeJS.ErrnoException) =>
      finish({ spawnError: error.code || "spawn_failed" }),
    );
    child.on("close", (code) => finish({ code }));
  });

const BASE_ENV_KEYS = [
  "HOME",
  "USER",
  "LOGNAME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "LANG",
  "LC_ALL",
];

/**
 * A minimal environment for a vault CLI. An app opened from the Finder has a short PATH, so
 * the usual install locations of `op`, `bws` and `bw` come first.
 */
export function secretCliEnv(
  source: NodeJS.ProcessEnv,
  extra: Record<string, string | undefined> = {},
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NO_COLOR: "1" };
  for (const key of BASE_ENV_KEYS) if (source[key]) env[key] = source[key];
  const home = source.HOME || "";
  const known =
    platform === "win32"
      ? []
      : [
          ...(platform === "darwin" ? ["/opt/homebrew/bin"] : []),
          "/usr/local/bin",
          "/usr/bin",
          "/bin",
          ...(home ? [path.join(home, ".cargo", "bin"), path.join(home, ".local", "bin")] : []),
        ];
  const inherited = String(source.PATH || "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  env.PATH = Array.from(new Set([...known, ...inherited])).join(path.delimiter);
  for (const [key, value] of Object.entries(extra)) if (value) env[key] = value;
  return env;
}

const VAULT_TOKEN_ENV_NAMES = new Set([
  "OP_SERVICE_ACCOUNT_TOKEN",
  "OP_CONNECT_TOKEN",
  "BWS_ACCESS_TOKEN",
  "BW_SESSION",
  "BW_CLIENTID",
  "BW_CLIENTSECRET",
  "BW_PASSWORD",
]);

/**
 * The app's environment minus the tokens that open a vault. Child processes that inherit the
 * environment (MCP servers) get the values a reference resolved to, never the vault itself.
 */
export function withoutVaultTokens(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (VAULT_TOKEN_ENV_NAMES.has(key) || key.startsWith("OP_SESSION_")) continue;
    copy[key] = value;
  }
  return copy;
}
