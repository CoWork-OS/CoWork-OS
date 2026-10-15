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
 */

import { execFile, spawn } from "child_process";
import { createHash, randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync } from "fs";
import * as path from "path";

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
  password: string;
  viewerPort?: number;
  lastUsedAt: number;
}

/** One bot's running desktop, handed to a task while it holds its turn. */
export interface BotDesktopSession {
  botId: string;
  /** Runs a program inside the desktop as user "bot" (argument list, no shell). */
  exec: (args: string[], options?: { timeoutMs?: number; detach?: boolean }) => Promise<RunResult>;
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
  private readonly records = new Map<string, DesktopRecord>();
  private readonly starting = new Map<string, Promise<void>>();
  private imagePromise: Promise<string> | null = null;
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

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Finds a container runtime whose daemon is running, or explains what is missing. */
  async detectRuntime(): Promise<{ name: ContainerRuntimeName; binary: string } | null> {
    if (this.runtime) return this.runtime;
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
    const port = record.viewerPort ?? (await this.readViewerPort(botId));
    record.viewerPort = port;
    record.lastUsedAt = this.now();
    const params = new URLSearchParams({
      autoconnect: "1",
      resize: "scale",
      reconnect: "1",
      view_only: options.viewOnly === false ? "0" : "1",
      password: record.password,
    });
    return `http://127.0.0.1:${port}/vnc.html?${params.toString()}`;
  }

  async stop(botId: string): Promise<void> {
    const runtime = await this.detectRuntime();
    if (!runtime) return;
    await this.run(runtime.binary, ["stop", "--time", "5", this.containerName(botId)]).catch(
      () => undefined,
    );
    this.records.delete(botId);
  }

  /** Rebuilds the desktop from the image; the bot's home folder (files, sign-ins) is kept. */
  async reset(botId: string): Promise<void> {
    const runtime = await this.detectRuntime();
    if (!runtime) return;
    await this.run(runtime.binary, ["rm", "--force", this.containerName(botId)]).catch(
      () => undefined,
    );
    this.records.delete(botId);
  }

  /**
   * CoWork is quitting: stops every running bot desktop. The stop runs as its own process so it
   * finishes after CoWork exits.
   */
  stopAllOnQuit(): void {
    const names = Array.from(this.records.keys()).map((botId) => this.containerName(botId));
    if (!this.runtime || names.length === 0) return;
    try {
      const child = spawn(this.runtime.binary, ["stop", "--time", "5", ...names], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, PATH: withCommonBinPaths(process.env.PATH) },
      });
      child.unref();
    } catch {
      // Left running; the next start stops it.
    }
    this.records.clear();
  }

  /** Stops bot desktops left running by an earlier CoWork session (it quit or crashed). */
  async stopLeftovers(): Promise<void> {
    const runtime = await this.detectRuntime();
    if (!runtime) return;
    const listed = await this.run(runtime.binary, [
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
      await this.run(runtime.binary, ["stop", "--time", "5", ...names]).catch(() => undefined);
    }
  }

  /** A still of the bot's desktop for its panel, only if it is already running. */
  async captureIfRunning(botId: string): Promise<Buffer | null> {
    if (!this.runtime || !this.records.has(botId)) return null;
    try {
      return await this.session(botId).screenshot();
    } catch {
      return null;
    }
  }

  private async stopIdleDesktops(): Promise<void> {
    const limit = this.deps.idleStopMs ?? DEFAULT_IDLE_STOP_MS;
    for (const [botId, record] of this.records) {
      if (this.busy.has(botId)) continue;
      if (this.now() - record.lastUsedAt >= limit) await this.stop(botId);
    }
  }

  private session(botId: string): BotDesktopSession {
    const runtime = this.runtime!;
    const name = this.containerName(botId);
    const exec = (args: string[], options: { timeoutMs?: number; detach?: boolean } = {}) =>
      this.run(
        runtime.binary,
        [
          "exec",
          ...(options.detach ? ["--detach"] : []),
          "--user",
          "bot",
          "--env",
          "DISPLAY=:1",
          name,
          ...args,
        ],
        { timeoutMs: options.timeoutMs },
      );
    return {
      botId,
      exec,
      screenshot: async () => {
        const result = await exec(
          ["sh", "-c", "scrot --overwrite /tmp/cowork-shot.png && cat /tmp/cowork-shot.png"],
          {
            timeoutMs: 20_000,
          },
        );
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
      const result = await this.run(runtime.binary, [
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
    if (this.records.has(botId) && (await this.isRunning(botId))) return;
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
    const image = await this.ensureImage();
    const name = this.containerName(botId);
    const password = randomBytes(6).toString("base64url").slice(0, 8);
    // A stopped container keeps its old password, so it is recreated; its files live in the
    // bot's home folder, which is kept.
    await this.run(runtime.binary, ["rm", "--force", name]).catch(() => undefined);
    const home = this.homeFolder(botId);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    await this.run(
      runtime.binary,
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
        "--env",
        `VNC_PASSWORD=${password}`,
        "--volume",
        `${home}:/home/bot/work`,
        image,
      ],
      { timeoutMs: 2 * 60 * 1000 },
    );
    this.records.set(botId, { password, lastUsedAt: this.now() });
    await this.waitUntilReady(botId);
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

  private async readViewerPort(botId: string): Promise<number> {
    const runtime = this.runtime!;
    const result = await this.run(runtime.binary, [
      "port",
      this.containerName(botId),
      `${VIEWER_PORT}/tcp`,
    ]);
    const match = result.stdout.toString("utf8").match(/127\.0\.0\.1:(\d+)/);
    if (!match) throw new Error("The bot's desktop viewer is not available.");
    return Number(match[1]);
  }

  /** The image tag follows the Dockerfile's contents, so an app update rebuilds it. */
  private ensureImage(): Promise<string> {
    if (!this.imagePromise) {
      this.imagePromise = this.buildImage().catch((error) => {
        this.imagePromise = null;
        throw error;
      });
    }
    return this.imagePromise;
  }

  private async buildImage(): Promise<string> {
    const runtime = this.runtime!;
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
    const exists = await this.run(runtime.binary, ["image", "inspect", tag]).then(
      () => true,
      () => false,
    );
    if (!exists) {
      await this.run(runtime.binary, ["build", "--tag", tag, dir], { timeoutMs: BUILD_TIMEOUT_MS });
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
