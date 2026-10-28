/**
 * A bot's own desktop on this computer: a Linux desktop in a container that only that bot
 * uses ("Works on: Its own desktop").
 *
 * - One container per bot, built from resources/bot-desktop on first use, run as user "bot"
 *   with no capabilities, no new privileges, memory/CPU/process limits, and only the viewer
 *   port published, on 127.0.0.1. The only host folder it sees is the bot's own home folder,
 *   so its files and browser sign-ins survive a restart or reset.
 * - Tasks of the same bot take turns on its desktop (first come, first served, bounded wait).
 * - A desktop stops after an hour without use, and when CoWork quits.
 * - All container commands are run with argument lists, never through a shell on the host.
 * - A bot can run its desktop on your own server instead: an SSH host from your SSH config.
 *   Docker then runs there over SSH (`docker --host ssh://<host>`), the bot's files live in a
 *   volume on that server, and the viewer comes through an SSH tunnel to 127.0.0.1. Unknown
 *   host keys are never accepted; connect with `ssh <host>` once to trust the server.
 */

import { execFile, spawn, type ChildProcess } from "child_process";
import { createHash, randomBytes } from "crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  rmSync,
} from "fs";
import * as net from "net";
import * as path from "path";
import {
  isValidDesktopGroup,
  isValidDesktopHost,
  normalizeBotDesktopNetwork,
  type BotDesktopNetwork,
} from "../../shared/bot-computer";

export type ContainerRuntimeName = "docker" | "podman";

export interface RunResult {
  stdout: Buffer;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: { timeoutMs?: number; input?: string },
) => Promise<RunResult>;

export interface BotDesktopDeps {
  /** Folder that holds each bot's home folder (inside CoWork's app data). */
  dataDir: () => string;
  /** Folder with the desktop's Dockerfile. */
  resourcesDir: () => string | null;
  run?: CommandRunner;
  /** Candidate runtime binaries, in order; the first whose daemon answers is used. */
  runtimeCandidates?: string[];
  now?: () => number;
  idleStopMs?: number;
  waitMs?: number;
  /** The SSH host a bot's desktop runs on, or undefined for this computer. */
  desktopHostFor?: (botId: string) => string | undefined;
  /** The shared desktop a bot uses with other bots, or undefined for a desktop of its own. */
  desktopGroupFor?: (botId: string) => string | undefined;
  /** What a bot's desktop may reach on the network; unset means internet only. */
  desktopNetworkFor?: (botId: string) => unknown;
  /** Opens an SSH tunnel from a local port to a port on the server's loopback. */
  openTunnel?: (host: string, localPort: number, remotePort: number) => ChildProcess;
  /** Every server bots' desktops are set to run on, so leftovers there are stopped too. */
  desktopHosts?: () => string[];
  /** The uid CoWork runs as (default: the process uid); decides how the home folder is mounted. */
  hostUid?: number;
  /**
   * Whether the person is using a desktop (its viewer is open): idle stop skips it. Gets the
   * desktop key (see desktopKey), which is the bot's id unless bots share the desktop.
   */
  inUse?: (desktopKey: string) => boolean;
  /** Dedicated task-computer quota; legacy desktops retain their existing behavior. */
  maxEnvironmentDesktops?: number;
}

const defaultOpenTunnel = (host: string, localPort: number, remotePort: number): ChildProcess =>
  spawn(
    "ssh",
    [
      "-N",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=30",
      "-L",
      `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
      "--",
      host,
    ],
    { stdio: "ignore", env: { ...process.env, PATH: withCommonBinPaths(process.env.PATH) } },
  );

async function freeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForLocalPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (open) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/**
 * Turns failures to reach or sign in to the server into what the person should do about them.
 * Docker reports those as "error during connect … dial-stdio … stderr=<ssh's message>"; any other
 * error came from a command that did run on the server (its own "Permission denied", say) and is
 * passed on as it is.
 */
function explainRemoteError(host: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const original = error instanceof Error ? error : new Error(message);
  if (!/error during connect|dial-stdio|^ssh: /im.test(message)) return original;
  if (
    /host key verification failed|no matching host key|REMOTE HOST IDENTIFICATION/i.test(message)
  ) {
    return new Error(
      `CoWork doesn't trust ${host} yet. Run "ssh ${host}" once in Terminal to check and accept its host key.`,
    );
  }
  if (/permission denied|authentication/i.test(message)) {
    return new Error(`CoWork couldn't sign in to ${host} over SSH. Set up an SSH key for it.`);
  }
  if (/could not resolve|connection refused|timed out|no route/i.test(message)) {
    return new Error(`CoWork couldn't reach ${host} over SSH.`);
  }
  const detail = /stderr=([^\n]*)/.exec(message)?.[1]?.trim();
  return new Error(
    `CoWork couldn't connect to ${host} over SSH${detail ? ` (${detail})` : ""}. Check that ` +
      `"ssh ${host}" works in Terminal without asking for anything, and that Docker runs there.`,
  );
}

export interface BotDesktopStatus {
  state: "unavailable" | "stopped" | "starting" | "running";
  runtime?: ContainerRuntimeName;
  /** Why it is unavailable, in words for the person. */
  reason?: string;
}

const CONTAINER_PREFIX = "cowork-desktop-";
const IMAGE_NAME = "cowork-bot-desktop";
/** The files the desktop image is built from; its tag follows their contents. */
const BOT_DESKTOP_IMAGE_FILES = [
  "Dockerfile",
  "start-desktop.sh",
  "cowork-teach.py",
  "cowork-network.sh",
  "cowork-environment.py",
];
/** Applies the network limit; see resources/bot-desktop/cowork-network.sh. */
const NETWORK_LIMIT_PROGRAM = "/usr/local/bin/cowork-network";
const VIEWER_PORT = 6080;
const DEFAULT_IDLE_STOP_MS = 60 * 60 * 1000;
const DEFAULT_WAIT_MS = 2 * 60 * 1000;
const BUILD_TIMEOUT_MS = 20 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 60 * 1000;
/** A failed runtime probe (no Docker or Podman) is trusted this long before probing again. */
const RUNTIME_PROBE_TTL_MS = 60 * 1000;
/** A desktop known to run is not re-inspected for this long between actions. */
const RUNNING_CHECK_MS = 30 * 1000;
/** The desktop image's user; a Linux host with another uid cannot share a bind-mounted folder. */
const CONTAINER_UID = 1000;

const defaultRunner: CommandRunner = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        encoding: "buffer",
        maxBuffer: 32 * 1024 * 1024,
        timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
        env: { ...process.env, PATH: withCommonBinPaths(process.env.PATH) },
      },
      (error, stdout, stderr) => {
        const stderrText = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? "");
        if (error) {
          reject(new Error(stderrText.trim() || error.message));
          return;
        }
        resolve({
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ""),
          stderr: stderrText,
        });
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });

/** Apps started from the Dock get a short PATH; container CLIs usually live in these folders. */
function withCommonBinPaths(current?: string): string {
  const extra = [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/Applications/Docker.app/Contents/Resources/bin",
  ];
  const parts = (current || "").split(path.delimiter).filter(Boolean);
  for (const dir of extra) if (!parts.includes(dir)) parts.push(dir);
  return parts.join(path.delimiter);
}

/** A short, stable, name-safe key for a bot id. */
export function botDesktopKey(botId: string): string {
  return createHash("sha256").update(String(botId)).digest("hex").slice(0, 16);
}

/** Width and height from a PNG header, or zeros when it isn't one. */
export function pngSize(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || png.readUInt32BE(12) !== 0x49484452) return { width: 0, height: 0 };
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** A file in the bot's work folder on its desktop. */
export interface BotDesktopFile {
  /** Relative to the work folder, with forward slashes. */
  path: string;
  size: number;
  modifiedAt: number;
}

/** The largest file a bot can hand from its desktop to a conversation. */
export const BOT_DESKTOP_FILE_MAX_BYTES = 25 * 1024 * 1024;
const WORK_DIR = "/home/bot/work";
/** The desktop browser's profile lives in the work folder; it is not the bot's files. */
const HIDDEN_WORK_ENTRIES = new Set([".browser"]);

/**
 * A path inside the bot's work folder, normalized, or an error: no absolute paths, no "..",
 * nothing in the browser profile.
 */
export function normalizeDesktopFilePath(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim().replace(/\\/g, "/") : "";
  const relative = value.replace(/^~\/work\//, "").replace(/^\/home\/bot\/work\//, "");
  const parts = relative.split("/").filter((part) => part && part !== ".");
  if (
    !relative ||
    relative.startsWith("/") ||
    parts.length === 0 ||
    parts.some((part) => part === "..") ||
    HIDDEN_WORK_ENTRIES.has(parts[0]) ||
    relative.length > 1024
  ) {
    throw new Error("Use a file path inside ~/work on the bot's desktop, like report.pdf");
  }
  return parts.join("/");
}

interface DesktopRecord {
  /** Full-access viewer password (after take-over). */
  password: string;
  /** The SSH host it runs on, or undefined for this computer. */
  host?: string;
  /** View-only viewer password (watching). */
  viewPassword: string;
  viewerPort?: number;
  tunnel?: ChildProcess;
  lastUsedAt: number;
  /** When the container was last seen running. */
  checkedAt?: number;
  /** The network limit applied when it started. */
  network?: BotDesktopNetwork;
}

/** One bot's running desktop, handed to a task while it holds its turn. */
export interface BotDesktopSession {
  botId: string;
  /** Runs a program inside the desktop as user "bot" (argument list, no shell). */
  exec: (
    args: string[],
    options?: { timeoutMs?: number; detach?: boolean; input?: string },
  ) => Promise<RunResult>;
  screenshot: () => Promise<Buffer>;
}

export class BotDesktopManager {
  private static instance: BotDesktopManager | null = null;

  static getInstance(): BotDesktopManager {
    if (!BotDesktopManager.instance) {
      throw new Error("The bot desktop service is not ready yet.");
    }
    return BotDesktopManager.instance;
  }

  static configure(deps: BotDesktopDeps): BotDesktopManager {
    BotDesktopManager.instance?.dispose();
    BotDesktopManager.instance = new BotDesktopManager(deps);
    return BotDesktopManager.instance;
  }

  static resetForTesting(): void {
    BotDesktopManager.instance?.dispose();
    BotDesktopManager.instance = null;
  }

  private runtime: { name: ContainerRuntimeName; binary: string } | null = null;
  /** When the last probe found no runtime; probing again is skipped for a while. */
  private runtimeMissingAt: number | null = null;
  private readonly records = new Map<string, DesktopRecord>();
  private readonly starting = new Map<string, Promise<void>>();
  /** The image build per place (this computer is ""), so each server builds it once. */
  private readonly imagePromises = new Map<string, Promise<string>>();
  private readonly queues = new Map<string, Array<() => void>>();
  private readonly busy = new Set<string>();
  /** Desktops where the person is recording a task right now. */
  private readonly recording = new Set<string>();
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: BotDesktopDeps) {
    this.idleTimer = setInterval(() => void this.stopIdleDesktops(), 60_000);
    (this.idleTimer as { unref?: () => void }).unref?.();
  }

  dispose(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  private run(command: string, args: string[], options?: { timeoutMs?: number; input?: string }) {
    return (this.deps.run ?? defaultRunner)(command, args, options);
  }

  /** Where the bot's desktop runs: an SSH host, or undefined for this computer. */
  desktopHost(botId: string): string | undefined {
    if (this.keyHosts.has(botId)) return this.keyHosts.get(botId);
    const host = this.deps.desktopHostFor?.(botId);
    return isValidDesktopHost(host) ? host : undefined;
  }

  /** The SSH host of each desktop key (a bot, or a shared desktop on a host). */
  private readonly keyHosts = new Map<string, string | undefined>();
  private readonly environmentKeys = new Map<string, string>();
  private readonly environmentNetworks = new Map<string, BotDesktopNetwork>();

  /** A durable placement descriptor. It contains no credentials or executable input. */
  bindEnvironment(id: string, botId: string | undefined, lifetime: "persistent" | "task"): string {
    const host = botId ? this.desktopHost(botId) : undefined;
    const original = botId ? this.desktopKey(botId) : id;
    const network = botId ? this.networkFor(original) : "internet";
    const key = lifetime === "task" ? `task-computer:${id}` : `bot-computer:${original}`;
    const resource =
      "environment:" + JSON.stringify({ key, host, network, disposable: lifetime === "task" });
    this.restoreEnvironment(resource);
    return resource;
  }

  restoreEnvironment(resource: string): string {
    if (!resource.startsWith("environment:")) throw new Error("Invalid computer binding");
    const value = JSON.parse(resource.slice("environment:".length));
    if (
      typeof value.key !== "string" ||
      !/^(task|bot)-computer:[A-Za-z0-9:@._-]{1,256}$/.test(value.key) ||
      (value.host !== undefined && !isValidDesktopHost(value.host)) ||
      !["internet", "off"].includes(value.network)
    )
      throw new Error("Invalid computer placement");
    this.environmentKeys.set(resource, value.key);
    this.keyHosts.set(value.key, value.host);
    this.environmentNetworks.set(
      value.key,
      this.environmentNetworks.get(value.key) === "off" ? "off" : value.network,
    );
    return value.key;
  }

  /** Removes only a task-owned desktop and its private storage; persistent desktops survive. */
  async deleteEnvironment(resource: string): Promise<void> {
    const key = this.restoreEnvironment(resource);
    if (!key.startsWith("task-computer:") || JSON.parse(resource.slice(12)).disposable !== true) {
      throw new Error("This computer is persistent and cannot be deleted by task cleanup.");
    }
    if (this.busy.has(key)) throw new Error("Computer is still executing; cleanup is pending.");
    if (!(await this.detectRuntime()))
      throw new Error("Container runtime is unavailable for cleanup.");
    const host = this.desktopHost(key);
    const name = this.containerName(key);
    try {
      const owner = await this.container(host, [
        "inspect",
        "--format",
        '{{ index .Config.Labels "cowork.bot-desktop" }}',
        name,
      ]);
      if (owner.stdout.toString().trim() !== botDesktopKey(key))
        throw new Error("Computer ownership label does not match; cleanup refused.");
      await this.container(host, ["rm", "--force", name]);
    } catch (error) {
      if (
        !/No such (container|object)/i.test(error instanceof Error ? error.message : String(error))
      )
        throw error;
    }
    if (this.bindsHome(host)) rmSync(this.homeFolder(key), { recursive: true, force: true });
    else {
      try {
        await this.container(host, ["volume", "rm", `${name}-home`]);
      } catch (error) {
        if (!/no such volume/i.test(error instanceof Error ? error.message : String(error)))
          throw error;
      }
    }
    this.records.get(key)?.tunnel?.kill();
    this.records.delete(key);
  }

  /** Host-only control plane used to cancel a guest process while its work lease is held. */
  async controlEnvironment(resource: string, args: string[], input: string): Promise<RunResult> {
    const key = this.restoreEnvironment(resource);
    if (!this.records.has(key)) throw new Error("This computer is not running.");
    return this.session(key).exec(args, { input, timeoutMs: 20_000 });
  }

  /**
   * Which desktop a bot uses: its own (keyed by the bot), or a shared one that bots with the
   * same shared-desktop name use on the same host. Everything about a desktop (container, home
   * folder, turns) is keyed by this.
   */
  desktopKey(botId: string): string {
    if (botId.startsWith("environment:")) return this.restoreEnvironment(botId);
    if (this.environmentNetworks.has(botId)) return botId;
    const host = this.desktopHost(botId);
    const group = this.deps.desktopGroupFor?.(botId);
    if (!isValidDesktopGroup(group)) return botId;
    const key = `shared:${group}${host ? `@${host}` : ""}`;
    this.keyHosts.set(key, host);
    const members = this.keyMembers.get(key) ?? new Set<string>();
    members.add(botId);
    this.keyMembers.set(key, members);
    return key;
  }

  /** The bots seen using each shared desktop, so its network limit is the narrowest of theirs. */
  private readonly keyMembers = new Map<string, Set<string>>();

  /**
   * What a desktop may reach: the bot's setting, or for a shared desktop the narrowest setting
   * of the bots using it.
   */
  networkFor(key: string): BotDesktopNetwork {
    const pinned = this.environmentNetworks.get(key);
    if (pinned) return pinned;
    const members = this.keyMembers.get(key) ?? new Set([key]);
    for (const botId of members) {
      if (normalizeBotDesktopNetwork(this.deps.desktopNetworkFor?.(botId)) === "off") return "off";
    }
    return "internet";
  }

  /**
   * Whether the bot's files are a folder on this computer (bind-mounted) rather than a named
   * volume. The container runs as uid 1000: Docker Desktop maps file ownership, but on a Linux
   * host with another uid a bind-mounted folder would be unwritable, so a volume holds them
   * there, as on a server.
   */
  private bindsHome(host: string | undefined): boolean {
    if (host) return false;
    const hostUid = this.deps.hostUid ?? process.getuid?.() ?? CONTAINER_UID;
    return process.platform !== "linux" || hostUid === CONTAINER_UID;
  }

  /** Runs a container command for the bot's desktop, on its server when it has one. */
  private async container(
    host: string | undefined,
    args: string[],
    options?: { timeoutMs?: number; input?: string },
  ): Promise<RunResult> {
    const runtime = this.runtime!;
    if (!host) return this.run(runtime.binary, args, options);
    if (runtime.name !== "docker") {
      throw new Error("A bot desktop on your own server needs Docker on this computer.");
    }
    try {
      return await this.run(runtime.binary, ["--host", `ssh://${host}`, ...args], options);
    } catch (error) {
      throw explainRemoteError(host, error);
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Finds a container runtime whose daemon is running, or explains what is missing. */
  async detectRuntime(): Promise<{ name: ContainerRuntimeName; binary: string } | null> {
    if (this.runtime) return this.runtime;
    if (
      this.runtimeMissingAt !== null &&
      this.now() - this.runtimeMissingAt < RUNTIME_PROBE_TTL_MS
    ) {
      return null;
    }
    for (const binary of this.deps.runtimeCandidates ?? ["docker", "podman"]) {
      try {
        await this.run(binary, ["version", "--format", "{{.Server.Version}}"], {
          timeoutMs: 10_000,
        });
        const name: ContainerRuntimeName = path.basename(binary).startsWith("podman")
          ? "podman"
          : "docker";
        this.runtime = { name, binary };
        return this.runtime;
      } catch {
        // Not installed, or its daemon is not running: try the next one.
      }
    }
    this.runtimeMissingAt = this.now();
    return null;
  }

  async getStatus(botId: string): Promise<BotDesktopStatus> {
    botId = this.desktopKey(botId);
    const runtime = await this.detectRuntime();
    if (!runtime) {
      return {
        state: "unavailable",
        reason: "Install and open Docker Desktop or Podman to give this bot its own desktop.",
      };
    }
    if (this.starting.has(botId)) return { state: "starting", runtime: runtime.name };
    return {
      state: (await this.isRunning(botId)) ? "running" : "stopped",
      runtime: runtime.name,
    };
  }

  containerName(botId: string): string {
    return `${CONTAINER_PREFIX}${botDesktopKey(botId)}`;
  }

  homeFolder(botId: string): string {
    return path.join(this.deps.dataDir(), "bot-desktops", botDesktopKey(botId));
  }

  /**
   * The folder on this computer that a bot's desktop sees as ~/work, with the desktop key it
   * belongs to, or undefined when its files live in a volume (a desktop on a server, or a Linux
   * host whose uid the container cannot write as). Bots sharing a desktop share the folder.
   */
  hostWorkFolder(botId: string): { desktopKey: string; folder: string } | undefined {
    const key = this.desktopKey(botId);
    if (!this.bindsHome(this.desktopHost(key))) return undefined;
    return { desktopKey: key, folder: this.homeFolder(key) };
  }

  /**
   * Runs `work` with the bot's desktop, starting it first if needed. Tasks of the same bot take
   * turns, first come first served, and give up after the wait runs out.
   */
  async withDesktop<T>(
    botId: string,
    work: (session: BotDesktopSession) => Promise<T>,
    options: { onStarting?: () => void } = {},
  ): Promise<T> {
    botId = this.desktopKey(botId);
    await this.takeTurn(botId);
    try {
      await this.ensureRunning(botId, options.onStarting);
      const record = this.records.get(botId)!;
      record.lastUsedAt = this.now();
      return await work(this.session(botId));
    } finally {
      const record = this.records.get(botId);
      if (record) record.lastUsedAt = this.now();
      this.releaseTurn(botId);
    }
  }

  /**
   * The viewer address for the person (loopback only), starting the desktop if needed. It is
   * view-only unless the person has taken over.
   */
  async viewerUrl(botId: string, options: { viewOnly?: boolean } = {}): Promise<string> {
    botId = this.desktopKey(botId);
    await this.ensureRunning(botId);
    const record = this.records.get(botId)!;
    if (
      !record.viewerPort ||
      (record.host && (!record.tunnel || record.tunnel.exitCode !== null))
    ) {
      const remotePort = await this.readViewerPort(botId);
      record.viewerPort = record.host
        ? await this.openViewerTunnel(record, remotePort)
        : remotePort;
    }
    const port = record.viewerPort;
    record.lastUsedAt = this.now();
    const params = new URLSearchParams({
      autoconnect: "1",
      resize: "scale",
      reconnect: "1",
      view_only: options.viewOnly === false ? "0" : "1",
      // The view-only password cannot drive the desktop; the full one is handed out after
      // take-over only.
      password: options.viewOnly === false ? record.password : record.viewPassword,
    });
    return `http://127.0.0.1:${port}/vnc.html?${params.toString()}`;
  }

  async stop(botId: string): Promise<void> {
    botId = this.desktopKey(botId);
    const runtime = await this.detectRuntime();
    if (!runtime) return;
    const record = this.records.get(botId);
    record?.tunnel?.kill();
    await this.container(record?.host ?? this.desktopHost(botId), [
      "stop",
      "--time",
      "5",
      this.containerName(botId),
    ]).catch(() => undefined);
    this.records.delete(botId);
    this.recording.delete(botId);
  }

  /** Rebuilds the desktop from the image; the bot's home folder (files, sign-ins) is kept. */
  async reset(botId: string): Promise<void> {
    botId = this.desktopKey(botId);
    const runtime = await this.detectRuntime();
    if (!runtime) return;
    const record = this.records.get(botId);
    record?.tunnel?.kill();
    await this.container(record?.host ?? this.desktopHost(botId), [
      "rm",
      "--force",
      this.containerName(botId),
    ]).catch(() => undefined);
    this.records.delete(botId);
  }

  /**
   * CoWork is quitting: stops every running bot desktop. The stop runs as its own process so it
   * finishes after CoWork exits.
   */
  stopAllOnQuit(): void {
    if (!this.runtime) return;
    const byHost = new Map<string, string[]>();
    for (const [botId, record] of this.records) {
      record.tunnel?.kill();
      const names = byHost.get(record.host ?? "") ?? [];
      names.push(this.containerName(botId));
      byHost.set(record.host ?? "", names);
    }
    for (const [host, names] of byHost) {
      try {
        const child = spawn(
          this.runtime.binary,
          [...(host ? ["--host", `ssh://${host}`] : []), "stop", "--time", "5", ...names],
          {
            detached: true,
            stdio: "ignore",
            env: { ...process.env, PATH: withCommonBinPaths(process.env.PATH) },
          },
        );
        child.unref();
      } catch {
        // Left running; it stops after its idle time on the next start.
      }
    }
    this.records.clear();
  }

  /** Stops leftovers owned by this profile; another profile may still be using its desktops. */
  async stopLeftovers(): Promise<void> {
    const runtime = await this.detectRuntime();
    if (!runtime) return;
    // This computer, then each server a bot's desktop is set to run on (a crash leaves no
    // record of what was running there).
    const hosts = new Set<string | undefined>([undefined]);
    if (runtime.name === "docker") {
      for (const host of this.deps.desktopHosts?.() ?? []) {
        if (isValidDesktopHost(host)) hosts.add(host);
      }
    }
    for (const host of hosts) {
      const listed = await this.container(host, [
        "ps",
        "--filter",
        "label=cowork.bot-desktop",
        "--filter",
        `label=cowork.profile=${this.profileKey()}`,
        "--format",
        "{{.Names}}",
      ]).catch(() => null);
      const names = (listed?.stdout.toString("utf8") ?? "")
        .split(/\s+/)
        .filter((name) => name.startsWith(CONTAINER_PREFIX));
      if (names.length > 0) {
        await this.container(host, ["stop", "--time", "5", ...names]).catch(() => undefined);
      }
    }
  }

  /**
   * The newest files in the bot's work folder. On this computer they are read from its home
   * folder (also while the desktop is stopped); on a server, only while the desktop runs.
   */
  async listFiles(botId: string, limit = 20): Promise<BotDesktopFile[]> {
    botId = this.desktopKey(botId);
    const host = this.records.get(botId)?.host ?? this.desktopHost(botId);
    const files: BotDesktopFile[] = [];
    if (this.bindsHome(host)) {
      const home = this.homeFolder(botId);
      if (!existsSync(home)) return [];
      const walk = (dir: string, prefix: string, depth: number) => {
        if (depth > 6 || files.length > 2000) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (!prefix && HIDDEN_WORK_ENTRIES.has(entry.name)) continue;
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full, rel, depth + 1);
          else if (entry.isFile()) {
            const stat = statSync(full);
            files.push({ path: rel, size: stat.size, modifiedAt: stat.mtimeMs });
          }
        }
      };
      walk(home, "", 0);
    } else {
      if (!this.runtime || !this.records.has(botId)) return [];
      const result = await this.session(botId)
        .exec([
          "find",
          WORK_DIR,
          "-path",
          `${WORK_DIR}/.browser`,
          "-prune",
          "-o",
          "-type",
          "f",
          "-printf",
          "%T@\\t%s\\t%P\\n",
        ])
        .catch(() => null);
      for (const line of (result?.stdout.toString("utf8") ?? "").split("\n")) {
        const [time, size, rel] = line.split("\t");
        if (rel)
          files.push({ path: rel, size: Number(size) || 0, modifiedAt: Number(time) * 1000 });
      }
    }
    return files.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, Math.max(1, limit));
  }

  /** Where a work-folder file of a bot on this computer is, for Show in Finder. */
  localFilePath(botId: string, rawPath: unknown): string {
    botId = this.desktopKey(botId);
    if (this.desktopHost(botId)) throw new Error("This bot's desktop runs on a server.");
    if (!this.bindsHome(undefined)) throw new Error("This bot's files are kept in a volume.");
    const rel = normalizeDesktopFilePath(rawPath);
    let home: string;
    let full: string;
    try {
      home = realpathSync(this.homeFolder(botId));
      full = realpathSync(path.join(home, rel));
    } catch {
      throw new Error(`~/work/${rel} was not found on the bot's desktop.`);
    }
    // A link inside the work folder must not lead outside it.
    if (!full.startsWith(`${home}${path.sep}`))
      throw new Error("That file is outside the bot's work folder.");
    return full;
  }

  /** A file from the bot's work folder, to hand to a conversation. */
  async readFile(botId: string, rawPath: unknown): Promise<{ path: string; data: Buffer }> {
    botId = this.desktopKey(botId);
    const rel = normalizeDesktopFilePath(rawPath);
    if (this.bindsHome(this.records.get(botId)?.host ?? this.desktopHost(botId))) {
      const full = this.localFilePath(botId, rel);
      const stat = statSync(full);
      if (!stat.isFile()) throw new Error("That is not a file.");
      if (stat.size > BOT_DESKTOP_FILE_MAX_BYTES)
        throw new Error("That file is larger than 25 MB.");
      return { path: rel, data: readFileSync(full) };
    }
    await this.ensureRunning(botId);
    const session = this.session(botId);
    // stat does not follow links: a link (to /dev/zero, or a huge file) is refused, not read.
    const [type, rawSize] = (
      await session.exec(["stat", "--format", "%F\t%s", "--", `${WORK_DIR}/${rel}`])
    ).stdout
      .toString("utf8")
      .trim()
      .split("\t");
    const size = Number(rawSize);
    if (!type || !Number.isFinite(size))
      throw new Error("That file was not found on the bot's desktop.");
    if (type !== "regular file" && type !== "regular empty file")
      throw new Error("That is not a file.");
    if (size > BOT_DESKTOP_FILE_MAX_BYTES) throw new Error("That file is larger than 25 MB.");
    // Read at most one byte past the limit, so a file swapped after the check stays bounded.
    const result = await session.exec(
      ["head", "--bytes", String(BOT_DESKTOP_FILE_MAX_BYTES + 1), "--", `${WORK_DIR}/${rel}`],
      { timeoutMs: 120_000 },
    );
    if (result.stdout.length > BOT_DESKTOP_FILE_MAX_BYTES)
      throw new Error("That file is larger than 25 MB.");
    return { path: rel, data: result.stdout };
  }

  /**
   * Teach a task: starts recording what the person does on the desktop (keys, clicks, pointer
   * moves). The recording stays on the desktop only until finishRecording takes it.
   */
  async startRecording(botId: string): Promise<void> {
    botId = this.desktopKey(botId);
    await this.ensureRunning(botId);
    const session = this.session(botId);
    const status = async () =>
      (await session.exec(["cowork-teach", "status"], { timeoutMs: 15_000 })).stdout
        .toString("utf8")
        .trim();
    if ((await status()) === "recording") throw new Error("A recording is already running.");
    await session.exec(["cowork-teach", "record"], { detach: true, timeoutMs: 15_000 });
    // Detached, the recorder's own errors don't come back: check that it is running.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await status()) === "recording") {
        const record = this.records.get(botId);
        if (record) record.lastUsedAt = this.now();
        this.recording.add(botId);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error("Recording didn't start on the bot's desktop.");
  }

  /**
   * Stops recording. With keep, returns the recording (JSON lines) and deletes it from the
   * desktop; without, just deletes it.
   */
  async finishRecording(botId: string, keep: boolean): Promise<string> {
    botId = this.desktopKey(botId);
    if (!this.runtime || !this.records.has(botId)) {
      throw new Error("The bot's desktop isn't running, so there is no recording.");
    }
    try {
      const result = await this.session(botId).exec(["cowork-teach", keep ? "stop" : "cancel"], {
        timeoutMs: 30_000,
      });
      return keep ? result.stdout.toString("utf8") : "";
    } finally {
      this.recording.delete(botId);
    }
  }

  /** Whether the person is recording a task on this bot's desktop (the bot must not act). */
  isRecording(botId: string): boolean {
    return this.recording.has(this.desktopKey(botId));
  }

  /** A still of the bot's desktop for its panel, only if it is already running. */
  async captureIfRunning(botId: string): Promise<Buffer | null> {
    botId = this.desktopKey(botId);
    // A task holding the turn publishes its own frames; capturing alongside it would race.
    if (!this.runtime || !this.records.has(botId) || this.busy.has(botId)) return null;
    try {
      return await this.session(botId).screenshot();
    } catch {
      return null;
    }
  }

  private async stopIdleDesktops(): Promise<void> {
    const limit = this.deps.idleStopMs ?? DEFAULT_IDLE_STOP_MS;
    for (const [botId, record] of this.records) {
      if (this.busy.has(botId) || this.deps.inUse?.(botId)) continue;
      if (this.now() - record.lastUsedAt >= limit) await this.stop(botId);
    }
  }

  private session(botId: string): BotDesktopSession {
    const name = this.containerName(botId);
    const host = this.records.get(botId)?.host;
    const exec = (
      args: string[],
      options: { timeoutMs?: number; detach?: boolean; input?: string } = {},
    ) =>
      this.container(
        host,
        [
          "exec",
          ...(options.detach ? ["--detach"] : []),
          ...(options.input !== undefined ? ["--interactive"] : []),
          "--user",
          "bot",
          "--env",
          "DISPLAY=:1",
          name,
          ...args,
        ],
        { timeoutMs: options.timeoutMs, input: options.input },
      );
    return {
      botId,
      exec,
      screenshot: async () => {
        // Its own file per capture: two captures at once must not read each other's write.
        const capture = [
          'f=$(mktemp /tmp/cowork-shot.XXXXXX) && scrot --overwrite "$f.png" && cat "$f.png";',
          's=$?; rm -f "$f" "$f.png"; exit $s',
        ].join(" ");
        const result = await exec(["sh", "-c", capture], { timeoutMs: 20_000 });
        if (pngSize(result.stdout).width === 0) {
          throw new Error("Could not capture the bot's desktop.");
        }
        return result.stdout;
      },
    };
  }

  private async takeTurn(botId: string): Promise<void> {
    if (!this.busy.has(botId)) {
      this.busy.add(botId);
      return;
    }
    const waitMs = this.deps.waitMs ?? DEFAULT_WAIT_MS;
    await new Promise<void>((resolve, reject) => {
      const queue = this.queues.get(botId) ?? [];
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const current = this.queues.get(botId) ?? [];
        this.queues.set(
          botId,
          current.filter((entry) => entry !== wake),
        );
        reject(
          new Error(
            `This bot's desktop is busy with another of its tasks. Waited ${Math.round(waitMs / 1000)} seconds; try again later.`,
          ),
        );
      }, waitMs);
      queue.push(wake);
      this.queues.set(botId, queue);
    });
  }

  private releaseTurn(botId: string): void {
    const queue = this.queues.get(botId) ?? [];
    const next = queue.shift();
    if (next) {
      next();
      return;
    }
    this.queues.delete(botId);
    this.busy.delete(botId);
  }

  private async isRunning(botId: string): Promise<boolean> {
    const runtime = await this.detectRuntime();
    if (!runtime) return false;
    try {
      const result = await this.container(this.records.get(botId)?.host, [
        "inspect",
        "--format",
        "{{.State.Running}}",
        this.containerName(botId),
      ]);
      return result.stdout.toString("utf8").trim() === "true";
    } catch {
      return false;
    }
  }

  private async ensureRunning(botId: string, onStarting?: () => void): Promise<void> {
    const record = this.records.get(botId);
    // Moved to another place (this computer or a server), or its network setting changed: stop
    // it, so it starts again where and how it is now set.
    if (
      record &&
      (record.host !== this.desktopHost(botId) || record.network !== this.networkFor(botId))
    ) {
      await this.stop(botId);
    } else if (record) {
      if (this.now() - (record.checkedAt ?? 0) < RUNNING_CHECK_MS) return;
      if (await this.isRunning(botId)) {
        record.checkedAt = this.now();
        return;
      }
    }
    let pending = this.starting.get(botId);
    if (!pending) {
      if (/^(task|bot)-computer:/.test(botId)) {
        const configured =
          this.deps.maxEnvironmentDesktops ?? Number(process.env.COWORK_MAX_TASK_COMPUTERS || 2);
        const limit = Number.isInteger(configured) ? Math.max(1, Math.min(8, configured)) : 2;
        const allocated = new Set(
          [...this.records.keys(), ...this.starting.keys()].filter((key) =>
            /^(task|bot)-computer:/.test(key),
          ),
        );
        if (!allocated.has(botId) && allocated.size >= limit)
          throw Object.assign(
            new Error(
              `All ${limit} dedicated computer slots are in use. Stop an idle computer and reconcile this task.`,
            ),
            { notDispatched: true },
          );
      }
      onStarting?.();
      pending = this.start(botId).finally(() => this.starting.delete(botId));
      this.starting.set(botId, pending);
    }
    await pending;
  }

  private profileKey(): string {
    const folder = this.deps.dataDir();
    const canonical = existsSync(folder) ? realpathSync(folder) : path.resolve(folder);
    return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
  }

  private async start(botId: string): Promise<void> {
    const runtime = await this.detectRuntime();
    if (!runtime) {
      throw new Error(
        "Install and open Docker Desktop or Podman to give this bot its own desktop.",
      );
    }
    const host = this.desktopHost(botId);
    const image = await this.ensureImage(host);
    const name = this.containerName(botId);
    const password = randomBytes(6).toString("base64url").slice(0, 8);
    const viewPassword = randomBytes(6).toString("base64url").slice(0, 8);
    // A stopped container keeps its old passwords, so it is recreated; its files live in the
    // bot's home folder (a volume on a server), which is kept.
    await this.container(host, ["rm", "--force", name]).catch(() => undefined);
    let home: string;
    if (this.bindsHome(host)) {
      home = this.homeFolder(botId);
      mkdirSync(home, { recursive: true, mode: 0o700 });
    } else {
      home = `${name}-home`;
    }
    await this.container(
      host,
      [
        "run",
        "--detach",
        "--name",
        name,
        "--hostname",
        "bot-desktop",
        "--label",
        `cowork.bot-desktop=${botDesktopKey(botId)}`,
        "--label",
        `cowork.profile=${this.profileKey()}`,
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--memory",
        "4g",
        "--cpus",
        "2",
        "--pids-limit",
        "512",
        "--shm-size",
        "512m",
        "--publish",
        `127.0.0.1::${VIEWER_PORT}`,
        "--volume",
        `${home}:/home/bot/work`,
        image,
      ],
      { timeoutMs: 2 * 60 * 1000 },
    );
    const network = this.networkFor(botId);
    this.records.set(botId, { password, viewPassword, host, lastUsedAt: this.now(), network });
    try {
      await this.limitNetwork(botId, host, image, network);
    } catch (error) {
      this.records.delete(botId);
      await this.container(host, ["rm", "--force", name]).catch(() => undefined);
      throw new Error(
        `Could not limit this bot desktop's network, so it was not started: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    // The viewer passwords go in over stdin after start, so they are in no environment and
    // not in the container's config (docker inspect); start-desktop waits for the file.
    const writePasswords = [
      'umask 077 && mkdir -p "$HOME/.vnc" && cat > "$HOME/.vnc/passwd.tmp"',
      '&& mv "$HOME/.vnc/passwd.tmp" "$HOME/.vnc/passwd"',
    ].join(" ");
    await this.session(botId).exec(["sh", "-c", writePasswords], {
      input: `${password}\n__BEGIN_VIEWONLY__\n${viewPassword}\n`,
      timeoutMs: 30_000,
    });
    await this.waitUntilReady(botId);
    const record = this.records.get(botId);
    if (record) record.checkedAt = this.now();
  }

  /**
   * Applies the network limit from a short-lived helper container that shares the desktop's
   * network namespace and alone holds NET_ADMIN; the desktop keeps no capabilities. With
   * internet, DNS goes only to the resolvers the desktop was given.
   */
  private async limitNetwork(
    botId: string,
    host: string | undefined,
    image: string,
    network: BotDesktopNetwork,
  ): Promise<void> {
    let resolvers: string[] = [];
    if (network === "internet") {
      const resolvConf = await this.session(botId).exec(["cat", "/etc/resolv.conf"], {
        timeoutMs: 15_000,
      });
      resolvers = parseResolvers(resolvConf.stdout.toString("utf8"));
      if (resolvers.length === 0) throw new Error("the desktop has no IPv4 DNS resolver");
    }
    await this.container(
      host,
      [
        "run",
        "--rm",
        "--network",
        `container:${this.containerName(botId)}`,
        "--cap-drop",
        "ALL",
        "--cap-add",
        "NET_ADMIN",
        "--security-opt",
        "no-new-privileges",
        "--user",
        "0",
        "--entrypoint",
        NETWORK_LIMIT_PROGRAM,
        image,
        network,
        ...resolvers,
      ],
      { timeoutMs: 60_000 },
    );
  }

  private async waitUntilReady(botId: string): Promise<void> {
    const session = this.session(botId);
    const deadline = this.now() + 60_000;
    let lastError: unknown;
    while (this.now() < deadline) {
      try {
        await session.exec(["xdotool", "getdisplaygeometry"], { timeoutMs: 5_000 });
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    throw new Error(
      `The bot's desktop did not start: ${lastError instanceof Error ? lastError.message : "timed out"}`,
    );
  }

  /** Forwards a local port to the viewer on the server's loopback, over SSH. */
  private async openViewerTunnel(record: DesktopRecord, remotePort: number): Promise<number> {
    record.tunnel?.kill();
    const localPort = await freeLocalPort();
    const tunnel = (this.deps.openTunnel ?? defaultOpenTunnel)(record.host!, localPort, remotePort);
    record.tunnel = tunnel;
    if (!(await waitForLocalPort(localPort, 15_000))) {
      tunnel.kill();
      throw new Error(
        `CoWork couldn't open a secure connection to the desktop on ${record.host}. Check that "ssh ${record.host}" works without a prompt.`,
      );
    }
    return localPort;
  }

  private async readViewerPort(botId: string): Promise<number> {
    const result = await this.container(this.records.get(botId)?.host, [
      "port",
      this.containerName(botId),
      `${VIEWER_PORT}/tcp`,
    ]);
    const match = result.stdout.toString("utf8").match(/127\.0\.0\.1:(\d+)/);
    if (!match) throw new Error("The bot's desktop viewer is not available.");
    return Number(match[1]);
  }

  /**
   * The image tag follows the Dockerfile's contents, so an app update rebuilds it. Each place
   * (this computer or a server) builds it once; a server gets the build files over SSH.
   */
  private ensureImage(host?: string): Promise<string> {
    const key = host ?? "";
    let pending = this.imagePromises.get(key);
    if (!pending) {
      pending = this.buildImage(host).catch((error) => {
        this.imagePromises.delete(key);
        throw error;
      });
      this.imagePromises.set(key, pending);
    }
    return pending;
  }

  private async buildImage(host?: string): Promise<string> {
    const dir = this.deps.resourcesDir();
    if (!dir || !existsSync(path.join(dir, "Dockerfile"))) {
      throw new Error("The bot desktop files are missing from this CoWork installation.");
    }
    const hash = createHash("sha256");
    for (const file of BOT_DESKTOP_IMAGE_FILES) {
      const filePath = path.join(dir, file);
      if (!existsSync(filePath)) continue;
      hash.update(file);
      hash.update(readFileSync(filePath));
    }
    const tag = `${IMAGE_NAME}:${hash.digest("hex").slice(0, 12)}`;
    const exists = await this.container(host, ["image", "inspect", tag]).then(
      () => true,
      () => false,
    );
    if (!exists) {
      await this.container(host, ["build", "--tag", tag, dir], { timeoutMs: BUILD_TIMEOUT_MS });
    }
    return tag;
  }
}

/** The IPv4 nameservers in a resolv.conf; anything else (IPv6, options, junk) is left out. */
export function parseResolvers(resolvConf: string): string[] {
  const resolvers = new Set<string>();
  for (const line of resolvConf.split("\n")) {
    const match = /^\s*nameserver\s+(\S+)\s*$/.exec(line);
    if (match && net.isIPv4(match[1])) resolvers.add(match[1]);
  }
  return [...resolvers];
}

/** Where the desktop's Dockerfile ships: app resources when packaged, the repo in development. */
export function findBotDesktopResources(): string | null {
  const candidates: string[] = [];
  if (typeof process.resourcesPath === "string" && process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "bot-desktop"));
  }
  candidates.push(path.join(process.cwd(), "resources", "bot-desktop"));
  candidates.push(path.resolve(__dirname, "../../../resources/bot-desktop"));
  candidates.push(path.resolve(__dirname, "../../../../resources/bot-desktop"));
  return candidates.find((candidate) => existsSync(path.join(candidate, "Dockerfile"))) ?? null;
}
