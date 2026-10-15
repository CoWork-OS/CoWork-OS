import { spawn } from "node:child_process";
import type {
  BrowserVaultFields,
  BrowserVaultItem,
  BrowserVaultSource,
} from "../../../shared/browser-vault";
import { loginOriginFor } from "./login-origin";

type Manager = Exclude<BrowserVaultSource, "local">;
export type PrivateCliRunner = (
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string,
) => Promise<string>;

/** Private child process: no shell, secret argv, inherited tokens, stderr forwarding, or command logging. */
export const runPrivateCli: PrivateCliRunner = (file, args, env, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let output = "";
    let bytes = 0;
    const fail = () => {
      child.kill();
      reject(new Error("Password manager unavailable. Unlock it and retry."));
    };
    const timer = setTimeout(fail, 30_000);
    child.stdout.on("data", (data: Buffer) => {
      bytes += data.length;
      if (bytes > 16 * 1024 * 1024) fail();
      else output += data.toString("utf8");
    });
    child.stderr.resume();
    child.on("error", () => {
      clearTimeout(timer);
      fail();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else fail();
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input === undefined ? undefined : `${input}\n`);
  });

const ENV_KEYS = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CONFIG_HOME",
  "BITWARDENCLI_APPDATA_DIR",
];
const TTL = 30 * 60_000;
type Unlock = { token: string; touchedAt: number; generation: number };

export class PasswordManagerVault {
  private sessions = new Map<string, Unlock>();
  private generations = new Map<string, number>();
  constructor(
    private run: PrivateCliRunner = runPrivateCli,
    private now = Date.now,
  ) {}
  private key(scope: string, source: Manager) {
    return `${scope}\0${source}`;
  }
  private binary(source: Manager) {
    return source === "onepassword" ? "op" : "bw";
  }
  private env(token = "", source?: Manager): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { NO_COLOR: "1" };
    for (const key of ENV_KEYS) if (process.env[key]) env[key] = process.env[key];
    if (token && source) env[source === "onepassword" ? "OP_SESSION" : "BW_SESSION"] = token;
    return env;
  }
  isUnlocked(scope: string, source: Manager) {
    const key = this.key(scope, source);
    const session = this.sessions.get(key);
    if (!session || this.now() - session.touchedAt >= TTL) {
      this.sessions.delete(key);
      return false;
    }
    return true;
  }
  lock(scope: string, source: Manager) {
    const key = this.key(scope, source);
    this.generations.set(key, (this.generations.get(key) || 0) + 1);
    this.sessions.delete(key);
  }
  async sources(scope: string) {
    return Promise.all(
      (["onepassword", "bitwarden"] as const).map(async (source) => {
        let installed = false;
        try {
          await this.run(this.binary(source), ["--version"], this.env());
          installed = true;
        } catch {
          /* metadata only */
        }
        return { source, installed, unlocked: this.isUnlocked(scope, source) };
      }),
    );
  }
  async unlock(scope: string, source: Manager, password: string) {
    const key = this.key(scope, source);
    const generation = this.generations.get(key) || 0;
    let token = "";
    if (source === "onepassword" && !password) {
      // Desktop-app integration owns its own unlock/biometric dialog.
      await this.run("op", ["whoami", "--format", "json"], this.env());
    } else if (source === "onepassword") {
      token = (await this.run("op", ["signin", "--raw"], this.env(), password)).trim();
      if (!token) throw new Error("1Password did not unlock.");
    } else {
      const env = this.env();
      env.COWORK_BW_MASTER = password;
      try {
        token = (
          await this.run(
            "bw",
            ["unlock", "--raw", "--nointeraction", "--passwordenv", "COWORK_BW_MASTER"],
            env,
          )
        ).trim();
      } finally {
        delete env.COWORK_BW_MASTER;
      }
      if (!token) throw new Error("Bitwarden did not unlock. Sign in with bw login first.");
    }
    if ((this.generations.get(key) || 0) !== generation)
      throw new Error("Manager was locked while unlocking.");
    this.sessions.set(key, { token, touchedAt: this.now(), generation });
  }
  private async call(scope: string, source: Manager, args: string[]) {
    if (!this.isUnlocked(scope, source)) throw new Error("Password manager is locked.");
    const key = this.key(scope, source);
    const session = this.sessions.get(key)!;
    const generation = session.generation;
    session.touchedAt = this.now();
    try {
      const result = await this.run(this.binary(source), args, this.env(session.token, source));
      if (!this.isUnlocked(scope, source) || (this.generations.get(key) || 0) !== generation)
        throw new Error("Manager locked during operation.");
      return result;
    } catch {
      throw new Error("Password manager unavailable. Unlock it and retry.");
    }
  }
  async list(scope: string, source: Manager): Promise<BrowserVaultItem[]> {
    const text = await this.call(
      scope,
      source,
      source === "onepassword"
        ? ["item", "list", "--categories", "Login", "--format", "json"]
        : ["list", "items", "--nointeraction"],
    );
    const rows: unknown = JSON.parse(text);
    if (!Array.isArray(rows)) throw new Error("Invalid password manager response.");
    const items: BrowserVaultItem[] = [];
    for (const row of rows.slice(0, 20_000)) {
      if (
        !row ||
        typeof row !== "object" ||
        typeof row.id !== "string" ||
        !/^[a-zA-Z0-9-]{1,128}$/.test(row.id)
      )
        continue;
      if (source === "bitwarden" && (row.type !== 1 || !row.login)) continue;
      const urls =
        source === "onepassword"
          ? (row.urls || []).map((u: { href?: string }) => u.href)
          : (row.login.uris || [])
              .filter((u: { match?: number }) => u.match !== 5)
              .map((u: { uri?: string }) => u.uri);
      const origins = [
        ...new Set<string>(
          urls
            .map((u: unknown) => (typeof u === "string" ? loginOriginFor(u) : null))
            .filter(Boolean),
        ),
      ];
      if (!origins.length) continue;
      items.push({
        id: `${source === "onepassword" ? "op" : "bw"}:${row.id}`,
        kind: "login",
        source,
        label: String(row.title || row.name || origins[0]).slice(0, 200),
        origin: origins[0],
        allowedOrigins: origins,
        username: String(
          source === "onepassword" ? row.additional_information || "" : row.login.username || "",
        ).slice(0, 500),
        hasOtp: source === "bitwarden" ? Boolean(row.login.totp) : undefined,
      });
    }
    return items;
  }
  async resolve(scope: string, item: BrowserVaultItem): Promise<BrowserVaultFields> {
    if (item.source === "local") throw new Error("Invalid manager.");
    const id = item.id.split(":")[1];
    if (!id || !/^[a-zA-Z0-9-]{1,128}$/.test(id)) throw new Error("Invalid login handle.");
    const password = await this.call(
      scope,
      item.source,
      item.source === "onepassword"
        ? ["item", "get", id, "--fields", "label=password", "--reveal"]
        : ["get", "password", id, "--nointeraction"],
    );
    return { username: item.username || "", password: password.replace(/[\r\n]+$/, "") };
  }
  async otp(scope: string, item: BrowserVaultItem) {
    if (item.source === "local") return "";
    try {
      const code = (
        await this.call(
          scope,
          item.source,
          item.source === "onepassword"
            ? ["item", "get", item.id.slice(3), "--otp"]
            : ["get", "totp", item.id.slice(3), "--nointeraction"],
        )
      ).trim();
      return /^\d{6,8}$/.test(code) ? code : "";
    } catch {
      return "";
    }
  }
}
