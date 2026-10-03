/**
 * Loopback listener guard for the macOS shell sandbox.
 *
 * When outbound networking is denied, the seatbelt profile may still allow a
 * command to accept TCP connections so that local dev servers, test servers
 * (supertest, Playwright webServer) and watchers work. Seatbelt cannot scope
 * that to loopback: a `(local tcp "localhost:*")` filter also matches 0.0.0.0,
 * :: and LAN addresses (verified on macOS 26), so a server bound to all
 * interfaces would be reachable from the network. This guard closes that gap
 * after the fact: it polls the TCP listener table and stops any guarded
 * process group that listens on a non-loopback address.
 *
 * The profile rule and this guard must always be used together; see
 * MacOSSandbox's `allowLoopbackListen` option.
 */

import { execFile } from "child_process";
import { createLogger } from "../../utils/logger";

const log = createLogger("LoopbackListenerGuard");

export const LOOPBACK_GUARD_POLL_INTERVAL_MS = 500;

export interface TcpListener {
  pid: number;
  /** Local address as printed by netstat, e.g. "127.0.0.1.5173" or "*.8000". */
  address: string;
}

export interface LoopbackListenerViolation {
  pid: number;
  address: string;
}

type CommandRunner = (file: string, args: string[]) => Promise<string>;

function runCommand(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: "utf8",
        timeout: 2_000,
        maxBuffer: 4 * 1024 * 1024,
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

/**
 * Parse `netstat -anv -p tcp` (macOS) into listening sockets with their
 * owning PID. Current macOS prints a `process:pid` column; rows without one
 * are skipped.
 */
export function parseNetstatListeners(output: string): TcpListener[] {
  const listeners: TcpListener[] = [];
  for (const line of String(output || "").split("\n")) {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 6 || !/^tcp[46]*$/.test(tokens[0] || "")) continue;
    if (tokens[5] !== "LISTEN") continue;
    const owner = tokens.slice(6).find((token) => /^.+:\d+$/.test(token));
    const pid = owner ? Number(owner.slice(owner.lastIndexOf(":") + 1)) : NaN;
    if (!Number.isInteger(pid) || pid <= 0) continue;
    listeners.push({ pid, address: tokens[3] || "" });
  }
  return listeners;
}

/**
 * True when a netstat local address ("host.port") is bound to a loopback
 * interface only.
 */
export function isLoopbackListenAddress(address: string): boolean {
  const lastDot = address.lastIndexOf(".");
  const host = lastDot > 0 ? address.slice(0, lastDot) : address;
  if (/^127\.\d+\.\d+\.\d+$/.test(host)) return true;
  if (host === "::1" || host === "::ffff:127.0.0.1") return true;
  // Link-local addresses scoped to the loopback interface (fe80::1%lo0).
  if (/%lo\d*$/.test(host)) return true;
  return false;
}

/** Parse `ps -o pid=,pgid= -p ...` output into a pid -> pgid map. */
export function parsePsProcessGroups(output: string): Map<number, number> {
  const groups = new Map<number, number>();
  for (const line of String(output || "").split("\n")) {
    const [pidText, pgidText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const pgid = Number(pgidText);
    if (Number.isInteger(pid) && pid > 0 && Number.isInteger(pgid) && pgid > 0) {
      groups.set(pid, pgid);
    }
  }
  return groups;
}

interface GuardWatch {
  processGroupId: number;
  onViolation: (violation: LoopbackListenerViolation) => void;
}

export class LoopbackListenerGuard {
  private readonly watches = new Map<number, GuardWatch>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;

  constructor(
    private readonly runner: CommandRunner = runCommand,
    private readonly pollIntervalMs = LOOPBACK_GUARD_POLL_INTERVAL_MS,
  ) {}

  /**
   * Watch a process group (the sandboxed command must lead its own group).
   * `onViolation` fires at most once; the watch is removed before it runs.
   */
  watch(
    processGroupId: number,
    onViolation: (violation: LoopbackListenerViolation) => void,
  ): () => void {
    if (!Number.isInteger(processGroupId) || processGroupId <= 0) return () => undefined;
    const id = processGroupId;
    this.watches.set(id, { processGroupId, onViolation });
    this.schedule(0);
    return () => {
      if (this.watches.get(id)?.onViolation === onViolation) this.watches.delete(id);
      if (this.watches.size === 0) this.stopTimer();
    };
  }

  get watchedCount(): number {
    return this.watches.size;
  }

  /** Run one check now. Exposed for tests. */
  async checkNow(): Promise<void> {
    if (this.watches.size === 0) return;
    let listeners: TcpListener[];
    try {
      listeners = parseNetstatListeners(await this.runner("netstat", ["-anv", "-p", "tcp"]));
    } catch (error) {
      log.warn("Could not read the TCP listener table", error);
      return;
    }
    const exposed = listeners.filter((listener) => !isLoopbackListenAddress(listener.address));
    if (exposed.length === 0) return;
    let groups: Map<number, number>;
    try {
      const pids = Array.from(new Set(exposed.map((listener) => listener.pid)));
      groups = parsePsProcessGroups(
        await this.runner("ps", ["-o", "pid=,pgid=", "-p", pids.join(",")]),
      );
    } catch {
      // ps exits non-zero when none of the PIDs exist any more.
      return;
    }
    for (const listener of exposed) {
      const watch = this.watches.get(groups.get(listener.pid) ?? -1);
      if (!watch) continue;
      this.watches.delete(watch.processGroupId);
      try {
        watch.onViolation({ pid: listener.pid, address: listener.address });
      } catch (error) {
        log.error("Loopback guard violation handler failed", error);
      }
    }
    if (this.watches.size === 0) this.stopTimer();
  }

  private schedule(delayMs: number): void {
    if (this.timer || this.polling) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.polling = true;
      void this.checkNow().finally(() => {
        this.polling = false;
        if (this.watches.size > 0) this.schedule(this.pollIntervalMs);
      });
    }, delayMs);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

let sharedGuard: LoopbackListenerGuard | null = null;

export function getLoopbackListenerGuard(): LoopbackListenerGuard {
  sharedGuard ||= new LoopbackListenerGuard();
  return sharedGuard;
}
