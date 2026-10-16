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
import { existsSync, mkdirSync, readFileSync } from "fs";
import * as net from "net";
import * as path from "path";
import { isValidDesktopHost } from "../../shared/bot-computer";

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
  /** Opens an SSH tunnel from a local port to a port on the server's loopback. */
  openTunnel?: (host: string, localPort: number, remotePort: number) => ChildProcess;
  /** Every server bots' desktops are set to run on, so leftovers there are stopped too. */
  desktopHosts?: () => string[];
  /** The uid CoWork runs as (default: the process uid); decides how the home folder is mounted. */
  hostUid?: number;
  /** Whether the person is using the bot's desktop (its viewer is open): idle stop skips it. */
  inUse?: (botId: string) => boolean;
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

/** Turns SSH failures into what the person should do about them. */
function explainRemoteError(host: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
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
  return error instanceof Error ? error : new Error(message);
}

export interface BotDesktopStatus {
  state: "unavailable" | "stopped" | "starting" | "running";
  runtime?: ContainerRuntimeName;
  /** Why it is unavailable, in words for the person. */
  reason?: string;
}

const CONTAINER_PREFIX = "cowork-desktop-";
const IMAGE_NAME = "cowork-bot-desktop";
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
    const host = this.deps.desktopHostFor?.(botId);
    return isValidDesktopHost(host) ? host : undefined;
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
   * Runs `work` with the bot's desktop, starting it first if needed. Tasks of the same bot take
   * turns, first come first served, and give up after the wait runs out.
   */
  async withDesktop<T>(
    botId: string,
    work: (session: BotDesktopSession) => Promise<T>,
    options: { onStarting?: () => void } = {},
  ): Promise<T> {
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
  }

  /** Rebuilds the desktop from the image; the bot's home folder (files, sign-ins) is kept. */
  async reset(botId: string): Promise<void> {
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

  /** Stops bot desktops left running by an earlier CoWork session (it quit or crashed). */
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

  /** A still of the bot's desktop for its panel, only if it is already running. */
  async captureIfRunning(botId: string): Promise<Buffer | null> {
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
    // Moved to another place (this computer or a server): stop it where it was.
    if (record && record.host !== this.desktopHost(botId)) {
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
      onStarting?.();
      pending = this.start(botId).finally(() => this.starting.delete(botId));
      this.starting.set(botId, pending);
    }
    await pending;
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
    // The container runs as uid 1000. Docker Desktop maps file ownership, but on a Linux host
    // with another uid a bind-mounted folder would be unwritable, so a named volume holds the
    // bot's files there instead (as on a server).
    const hostUid = this.deps.hostUid ?? process.getuid?.() ?? CONTAINER_UID;
    const bindHome = !host && (process.platform !== "linux" || hostUid === CONTAINER_UID);
    let home: string;
    if (bindHome) {
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
    this.records.set(botId, { password, viewPassword, host, lastUsedAt: this.now() });
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
    for (const file of ["Dockerfile", "start-desktop.sh"]) {
      hash.update(file);
      hash.update(readFileSync(path.join(dir, file)));
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
