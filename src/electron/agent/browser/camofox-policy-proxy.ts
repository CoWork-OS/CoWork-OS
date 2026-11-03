/**
 * CoWork's network-policy proxy for Camofox.
 *
 * Every browser CoWork drives sends its traffic through a policy proxy (browser-network-proxy.ts):
 * it refuses cloud metadata and private network addresses, pins DNS, and applies the
 * workspace's domain rules to every request, redirect and subresource. Camofox is a server
 * the user starts, so CoWork cannot hand it a proxy at launch. Instead the user starts it
 * with PROXY_HOST/PROXY_PORT pointing at this proxy on a fixed loopback port, and CoWork
 * proves that before every new tab with a check page only this proxy can serve.
 *
 * The proxy wants PROXY_USERNAME/PROXY_PASSWORD, a password CoWork never sends to the Camofox
 * API: a process that takes over Camofox's port receives the access key but still cannot fetch
 * the check page. The check page also loads scripts from 127.0.0.1 and localhost on this port.
 * Through the proxy they are refused like any loopback target; a browser that skips the proxy
 * for loopback reaches the port directly and gets a canary, and the tab is refused.
 *
 * The proxy only runs while a task holds a lease. A request must pass the policy of every
 * task using Camofox at that moment; with no lease the port is closed, so Camofox cannot
 * reach anything on its own.
 */

import { randomBytes, timingSafeEqual } from "crypto";
import {
  createBrowserNetworkProxy,
  type BrowserNetworkProxy,
} from "../../security/browser-network-proxy";
import { CAMOFOX_PROXY_USERNAME } from "../../../shared/camofox";

/** `.invalid` never resolves (RFC 6761), so only a browser using this proxy can load it. */
export const CAMOFOX_CHECK_HOST_SUFFIX = ".cowork-camofox-check.invalid";
const LOOPBACK_CHECK_PATH = "/cowork-loopback-check/";
const CHECK_TTL_MS = 60_000;
const MAX_PENDING_CHECKS = 32;

export interface CamofoxProxyLease {
  release(): Promise<void>;
}

export interface CamofoxProxyCheck {
  url: string;
  /** On the page when Camofox fetched it through this proxy. */
  token: string;
  /** Written by the page's last script, so the loopback scripts before it had their turn. */
  marker: string;
  /** Written only when Camofox fetched a loopback script around this proxy. */
  canary: string;
  done(): void;
}

interface PendingCheck {
  token: string;
  marker: string;
  canary: string;
  expiresAt: number;
}

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

/** document.write of `text` without `text` itself appearing in the page source. */
function writeSplit(text: string): string {
  const half = Math.floor(text.length / 2);
  return `document.write("<p>" + "${text.slice(0, half)}" + "${text.slice(half)}" + "</p>");`;
}

type CreateProxy = typeof createBrowserNetworkProxy;

export class CamofoxPolicyProxy {
  private proxy: BrowserNetworkProxy | null = null;
  private port: number | null = null;
  private password: string | null = null;
  private starting: Promise<void> | null = null;
  private readonly leases = new Map<string, (url: string) => void>();
  private readonly checks = new Map<string, PendingCheck>();

  constructor(
    private readonly createProxy: CreateProxy = createBrowserNetworkProxy,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Starts the proxy on `port` if needed and adds this task's policy to it. Camofox must send
   * `password` (with CAMOFOX_PROXY_USERNAME) on every request.
   */
  async acquire(
    port: number,
    password: string,
    leaseId: string,
    assertAllowed: (url: string) => void,
  ): Promise<CamofoxProxyLease> {
    if (this.starting) await this.starting.catch(() => {});
    if (this.proxy && (this.port !== port || this.password !== password)) {
      const others = [...this.leases.keys()].filter((id) => id !== leaseId);
      if (others.length > 0) {
        throw new Error(
          `CoWork's Camofox policy proxy is running on port ${this.port} for another task. ` +
            "Finish that task before changing the proxy settings.",
        );
      }
      await this.stop();
    }
    this.leases.set(leaseId, assertAllowed);
    if (!this.proxy) {
      this.starting = this.start(port, password);
      try {
        await this.starting;
      } catch (error) {
        this.leases.delete(leaseId);
        const code = (error as NodeJS.ErrnoException)?.code;
        throw new Error(
          code === "EADDRINUSE"
            ? `Port ${port} is already in use, so CoWork cannot run Camofox's policy proxy there. ` +
                "Choose another port in Settings > Browser > Camofox and restart Camofox with it."
            : `CoWork could not start Camofox's policy proxy: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        this.starting = null;
      }
    }
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        if (this.leases.get(leaseId) === assertAllowed) this.leases.delete(leaseId);
        if (this.leases.size === 0) await this.stop();
      },
    };
  }

  /** A page only this proxy serves; Camofox loading it proves its traffic comes here. */
  issueCheck(): CamofoxProxyCheck {
    this.sweepChecks();
    while (this.checks.size >= MAX_PENDING_CHECKS) {
      this.checks.delete(this.checks.keys().next().value as string);
    }
    const id = hex(12);
    const check = { token: hex(16), marker: hex(16), canary: hex(16) };
    this.checks.set(id, { ...check, expiresAt: this.now() + CHECK_TTL_MS });
    return {
      url: `http://${id}${CAMOFOX_CHECK_HOST_SUFFIX}/`,
      ...check,
      done: () => {
        this.checks.delete(id);
      },
    };
  }

  get running(): boolean {
    return Boolean(this.proxy);
  }

  get leaseCount(): number {
    return this.leases.size;
  }

  private async start(port: number, password: string): Promise<void> {
    const expected = Buffer.from(`${CAMOFOX_PROXY_USERNAME}:${password}`);
    this.proxy = await this.createProxy((url) => this.assertAllowed(url), {
      port,
      authorize: (header) => credentialsMatch(header, expected),
      answer: (target) => this.answer(target),
      answerDirect: (path) => this.answerDirect(path),
      // Camofox's own API and this proxy live on loopback; a page, or a name that resolves to
      // 127.0.0.1, must not reach them through here.
      allowsLoopback: () => false,
    });
    this.port = port;
    this.password = password;
  }

  private async stop(): Promise<void> {
    const proxy = this.proxy;
    this.proxy = null;
    this.port = null;
    this.password = null;
    this.checks.clear();
    await proxy?.close();
  }

  private assertAllowed(url: string): void {
    if (this.leases.size === 0) throw new Error("No CoWork task is using Camofox");
    // Several tasks may share one Camofox server: a request must pass every one's policy.
    for (const assert of this.leases.values()) assert(url);
  }

  private answer(target: URL): string | null {
    const host = target.hostname.toLowerCase();
    if (!host.endsWith(CAMOFOX_CHECK_HOST_SUFFIX)) return null;
    const id = host.slice(0, -CAMOFOX_CHECK_HOST_SUFFIX.length);
    const check = this.liveCheck(id);
    if (!check) {
      return "<!doctype html><html><head><title>CoWork proxy check</title></head><body><h1>expired</h1></body></html>";
    }
    const script = (loopbackHost: string) =>
      `<script src="http://${loopbackHost}:${this.port}${LOOPBACK_CHECK_PATH}${id}.js"></script>`;
    return (
      "<!doctype html><html><head><title>CoWork proxy check</title></head>" +
      `<body><h1>${check.token}</h1>` +
      script("127.0.0.1") +
      script("localhost") +
      `<script>${writeSplit(check.marker)}</script></body></html>`
    );
  }

  /** Reached only around the proxy: the browser loaded a loopback script directly. */
  private answerDirect(path: string): { contentType: string; body: string } | null {
    if (!path.startsWith(LOOPBACK_CHECK_PATH) || !path.endsWith(".js")) return null;
    const check = this.liveCheck(path.slice(LOOPBACK_CHECK_PATH.length, -".js".length));
    if (!check) return null;
    return { contentType: "text/javascript; charset=utf-8", body: writeSplit(check.canary) };
  }

  private liveCheck(id: string): PendingCheck | null {
    const check = this.checks.get(id);
    return check && check.expiresAt > this.now() ? check : null;
  }

  private sweepChecks(): void {
    const now = this.now();
    for (const [id, check] of this.checks) {
      if (check.expiresAt <= now) this.checks.delete(id);
    }
  }
}

/** Basic credentials, compared in constant time. */
function credentialsMatch(header: string | undefined, expected: Buffer): boolean {
  const match = /^basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header || "");
  if (!match) return false;
  const given = Buffer.from(match[1], "base64");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

let shared: CamofoxPolicyProxy | null = null;

export function getCamofoxPolicyProxy(): CamofoxPolicyProxy {
  if (!shared) shared = new CamofoxPolicyProxy();
  return shared;
}
