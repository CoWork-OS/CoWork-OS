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
 * The proxy only runs while a task holds a lease. A request must pass the policy of every
 * task using Camofox at that moment; with no lease the port is closed, so Camofox cannot
 * reach anything on its own.
 */

import { randomBytes } from "crypto";
import {
  createBrowserNetworkProxy,
  type BrowserNetworkProxy,
} from "../../security/browser-network-proxy";

/** `.invalid` never resolves (RFC 6761), so only a browser using this proxy can load it. */
export const CAMOFOX_CHECK_HOST_SUFFIX = ".cowork-camofox-check.invalid";
const CHECK_TTL_MS = 60_000;
const MAX_PENDING_CHECKS = 32;

export interface CamofoxProxyLease {
  release(): Promise<void>;
}

export interface CamofoxProxyCheck {
  url: string;
  token: string;
  done(): void;
}

type CreateProxy = typeof createBrowserNetworkProxy;

export class CamofoxPolicyProxy {
  private proxy: BrowserNetworkProxy | null = null;
  private port: number | null = null;
  private starting: Promise<void> | null = null;
  private readonly leases = new Map<string, (url: string) => void>();
  private readonly checks = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    private readonly createProxy: CreateProxy = createBrowserNetworkProxy,
    private readonly now: () => number = Date.now,
  ) {}

  /** Starts the proxy on `port` if needed and adds this task's policy to it. */
  async acquire(
    port: number,
    leaseId: string,
    assertAllowed: (url: string) => void,
  ): Promise<CamofoxProxyLease> {
    if (this.starting) await this.starting.catch(() => {});
    if (this.proxy && this.port !== port) {
      const others = [...this.leases.keys()].filter((id) => id !== leaseId);
      if (others.length > 0) {
        throw new Error(
          `CoWork's Camofox policy proxy is running on port ${this.port} for another task. ` +
            "Finish that task before changing the proxy port.",
        );
      }
      await this.stop();
    }
    this.leases.set(leaseId, assertAllowed);
    if (!this.proxy) {
      this.starting = this.start(port);
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
    const id = randomBytes(12).toString("hex");
    const token = randomBytes(16).toString("hex");
    this.checks.set(id, { token, expiresAt: this.now() + CHECK_TTL_MS });
    return {
      url: `http://${id}${CAMOFOX_CHECK_HOST_SUFFIX}/`,
      token,
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

  private async start(port: number): Promise<void> {
    this.proxy = await this.createProxy((url) => this.assertAllowed(url), {
      port,
      answer: (target) => this.answer(target),
      // Camofox's own unauthenticated-by-default API and this proxy live on loopback; a page,
      // or a name that resolves to 127.0.0.1, must not reach them through here.
      allowsLoopback: () => false,
    });
    this.port = port;
  }

  private async stop(): Promise<void> {
    const proxy = this.proxy;
    this.proxy = null;
    this.port = null;
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
    const check = this.checks.get(id);
    const token = check && check.expiresAt > this.now() ? check.token : "expired";
    return (
      "<!doctype html><html><head><title>CoWork proxy check</title></head>" +
      `<body><h1>${token}</h1></body></html>`
    );
  }

  private sweepChecks(): void {
    const now = this.now();
    for (const [id, check] of this.checks) {
      if (check.expiresAt <= now) this.checks.delete(id);
    }
  }
}

let shared: CamofoxPolicyProxy | null = null;

export function getCamofoxPolicyProxy(): CamofoxPolicyProxy {
  if (!shared) shared = new CamofoxPolicyProxy();
  return shared;
}
