import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, request, type IncomingMessage, type Server } from "http";
import { promises as dns } from "dns";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { CamofoxClient } from "../camofox-client";
import { CamofoxPolicyProxy } from "../camofox-policy-proxy";
import { createBrowserNetworkProxy } from "../../../security/browser-network-proxy";
import {
  CamofoxBrowserSession,
  checkCamofoxConnection,
  toCamofoxCookie,
  type CamofoxSessionContext,
} from "../camofox-session";
import type { CamofoxEnabledSettings } from "../camofox-settings";

/**
 * A stand-in for the Camofox server, bound to 127.0.0.1. In "proxied" mode it loads pages
 * through the configured HTTP proxy the way Camofox does with PROXY_HOST/PROXY_PORT and
 * PROXY_USERNAME/PROXY_PASSWORD; in "direct" mode it resolves and fetches pages itself, like
 * a Camofox started without them. "unauthenticated" uses the proxy without the password (a
 * process that took Camofox's port); "loopback-direct" uses it except for 127.0.0.1 and
 * localhost, like a Firefox without network.proxy.allow_hijacking_localhost.
 */
const ACCESS_KEY = "test-access-key";
const PROXY_PASSWORD = "test-proxy-password";
const PROXY_AUTH = `Basic ${Buffer.from(`cowork:${PROXY_PASSWORD}`).toString("base64")}`;

type FakeMode = "proxied" | "direct" | "unauthenticated" | "loopback-direct";

interface FakeCamofox {
  origin: string;
  mode: FakeMode;
  /** CAMOFOX_ACCESS_KEY the fake was "started" with; "" accepts unauthenticated requests. */
  accessKey: string;
  openTabs: Set<string>;
  /** Camofox userId (identity) each tab was opened in. */
  tabUsers: Map<string, string>;
  cookieImports: unknown[][];
  /** Camofox userId each cookie import went to, in order. */
  cookieUsers: string[];
  deletedSessions: string[];
  close(): Promise<void>;
}

const servers: Server[] = [];
let proxy: CamofoxPolicyProxy;
let tmpDir: string;

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
  });
}

function loadThroughProxy(
  url: string,
  proxyPort: number,
  auth?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: "GET",
        path: url,
        headers: { host: target.host, ...(auth ? { "proxy-authorization": auth } : {}) },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode || 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** The text of the page's document.write calls (string literals joined with +). */
function documentWrites(code: string): string {
  return [...code.matchAll(/document\.write\(((?:"[^"]*"\s*\+?\s*)+)\)/g)]
    .map((call) => [...call[1].matchAll(/"([^"]*)"/g)].map((part) => part[1]).join(""))
    .join("");
}

/** Runs a page's scripts in order, as far as the check page needs: document.write only. */
async function runScripts(
  html: string,
  fetchScript: (src: string) => Promise<string | null>,
): Promise<string> {
  const script = /<script(?: src="([^"]+)")?>([\s\S]*?)<\/script>/;
  let out = "";
  let rest = html;
  for (let match = script.exec(rest); match; match = script.exec(rest)) {
    out += rest.slice(0, match.index);
    const code = match[1] ? await fetchScript(match[1]) : match[2];
    if (code) out += documentWrites(code);
    rest = rest.slice(match.index + match[0].length);
  }
  return out + rest;
}

async function startFakeCamofox(
  mode: FakeMode,
  proxyPort: number,
  accessKey = ACCESS_KEY,
): Promise<FakeCamofox> {
  const pages = new Map<string, { url: string; body: string }>();
  const fake: FakeCamofox = {
    origin: "",
    mode,
    accessKey,
    openTabs: new Set(),
    tabUsers: new Map(),
    cookieImports: [],
    cookieUsers: [],
    deletedSessions: [],
    close: async () => {},
  };
  let next = 0;
  const viaProxy = (url: string) =>
    loadThroughProxy(url, proxyPort, fake.mode === "unauthenticated" ? undefined : PROXY_AUTH);
  const fetchScript = async (src: string) => {
    const loopback = ["127.0.0.1", "localhost"].includes(new URL(src).hostname);
    if (loopback && fake.mode === "loopback-direct") {
      const response = await fetch(src).catch(() => null);
      return response?.ok ? await response.text() : null;
    }
    const response = await viaProxy(src).catch(() => null);
    return response?.status === 200 ? response.body : null;
  };
  const load = async (url: string) => {
    if (fake.mode === "direct") {
      const response = await fetch(url);
      return { status: response.status, body: await response.text() };
    }
    const page = await viaProxy(url);
    return { status: page.status, body: await runScripts(page.body, fetchScript) };
  };
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const body =
      req.method === "GET" || req.method === "DELETE"
        ? {}
        : JSON.parse((await readBody(req)) || "{}");
    if (url.pathname === "/health") return send(200, { ok: true, engine: "camoufox" });
    if (fake.accessKey && req.headers.authorization !== `Bearer ${fake.accessKey}`) {
      return send(401, { error: "Unauthorized" });
    }
    if (req.method === "GET" && url.pathname === "/tabs") {
      return send(200, { running: true, tabs: [] });
    }
    if (req.method === "POST" && url.pathname === "/tabs") {
      try {
        const page = await load(body.url);
        const tabId = `tab-${++next}`;
        pages.set(tabId, { url: body.url, body: page.body });
        fake.openTabs.add(tabId);
        fake.tabUsers.set(tabId, body.userId);
        return send(200, {
          tabId,
          url: body.url,
          httpStatus: page.status,
          navigationOk: page.status < 400,
        });
      } catch (error) {
        return send(500, { error: `NS_ERROR_UNKNOWN_HOST ${(error as Error).message}` });
      }
    }
    const tabMatch = /^\/tabs\/([^/]+)(?:\/(\w+))?$/.exec(url.pathname);
    if (
      req.method === "POST" &&
      url.pathname.startsWith("/sessions/") &&
      url.pathname.endsWith("/cookies")
    ) {
      fake.cookieImports.push(body.cookies);
      fake.cookieUsers.push(decodeURIComponent(url.pathname.split("/")[2]));
      return send(200, { ok: true, count: body.cookies.length });
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/sessions/")) {
      fake.deletedSessions.push(decodeURIComponent(url.pathname.split("/")[2]));
      fake.openTabs.clear();
      return send(200, { ok: true });
    }
    if (!tabMatch || !pages.has(tabMatch[1])) return send(404, { error: "Tab not found" });
    const tabId = tabMatch[1];
    const action = tabMatch[2];
    if (req.method === "DELETE") {
      fake.openTabs.delete(tabId);
      pages.delete(tabId);
      return send(200, { ok: true });
    }
    if (action === "snapshot") {
      const page = pages.get(tabId)!;
      return send(200, { url: page.url, snapshot: page.body, refsCount: 0, truncated: false });
    }
    if (action === "navigate") {
      try {
        const page = await load(body.url);
        pages.set(tabId, { url: body.url, body: page.body });
        return send(200, {
          ok: true,
          tabId,
          url: body.url,
          httpStatus: page.status,
          navigationOk: page.status < 400,
        });
      } catch (error) {
        return send(500, { error: (error as Error).message });
      }
    }
    if (action === "click") return send(200, { ok: true, url: pages.get(tabId)!.url });
    return send(200, { ok: true });
  });
  const port = await listen(server);
  fake.origin = `http://127.0.0.1:${port}`;
  return fake;
}

function settingsFor(origin: string, proxyPort: number, persistentIdentity = false) {
  return {
    enabled: true,
    serverUrl: origin,
    origin,
    proxyPort,
    persistentIdentity,
    accessKey: ACCESS_KEY,
    proxyPassword: PROXY_PASSWORD,
  } satisfies CamofoxEnabledSettings;
}

function clientFor(origin: string): CamofoxClient {
  return new CamofoxClient({ origin, accessKey: ACCESS_KEY });
}

function context(overrides: Partial<CamofoxSessionContext> = {}): CamofoxSessionContext {
  return {
    taskId: "task-1",
    identityScope: "workspace-1",
    mayUseSavedCookies: true,
    // The workspace allows only allowed.test (plus the proxy's own check pages).
    assertRequestAllowed: (url) => {
      if (!new URL(url).hostname.startsWith("allowed.test")) throw new Error("denied by policy");
    },
    preflightNavigation: async (url) => String(url),
    savedCookiesForHost: () => [],
    approveSavedCookies: async () => true,
    resolveScreenshotPath: async () => ({
      absolutePath: path.join(tmpDir, "shot.png"),
      relativePath: "shot.png",
    }),
    registerScreenshot: async () => {},
    logEvent: () => {},
    ...overrides,
  };
}

const noEffect = async () => {};

beforeEach(async () => {
  // The test sites resolve to 127.0.0.1, so the proxy may not refuse loopback addresses here.
  // It still refuses loopback names, as the real one does for the check's loopback scripts.
  proxy = new CamofoxPolicyProxy((assert, options) =>
    createBrowserNetworkProxy(
      (url) => {
        if (["127.0.0.1", "localhost"].includes(new URL(url).hostname)) {
          throw new Error("loopback target");
        }
        assert(url);
      },
      { ...options, allowsLoopback: undefined },
    ),
  );
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "camofox-test-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function targetSite(): Promise<number> {
  return await listen(createServer((_req, res) => res.end("<h1>TARGET PAGE</h1>")));
}

describe("CamofoxBrowserSession through the policy proxy", () => {
  it("opens pages Camofox loads through CoWork's proxy and refuses what the policy denies", async () => {
    const sitePort = await targetSite();
    vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "127.0.0.1", family: 4 }] as Any);
    const proxyPort = await freePort();
    const fake = await startFakeCamofox("proxied", proxyPort);
    const session = new CamofoxBrowserSession(
      settingsFor(fake.origin, proxyPort),
      clientFor(fake.origin),
      proxy,
      context(),
    );

    const opened = await session.execute(
      "browser_navigate",
      { url: `http://allowed.test:${sitePort}/` },
      noEffect,
    );
    expect(opened).toMatchObject({ success: true, browserProvider: "camofox" });
    expect(session.active).toBe(true);
    expect(proxy.running).toBe(true);

    const snapshot = await session.execute("browser_snapshot", {}, noEffect);
    expect(snapshot).toMatchObject({ success: true, refSupport: true });
    expect(String(snapshot.snapshot)).toContain("TARGET PAGE");

    const denied = await session.execute(
      "browser_navigate",
      { url: `http://denied.test:${sitePort}/` },
      noEffect,
    );
    expect(denied).toMatchObject({ success: false });
    const afterDenied = await session.execute("browser_snapshot", {}, noEffect);
    expect(String(afterDenied.snapshot)).not.toContain("TARGET PAGE");

    await session.execute("browser_close", {}, noEffect);
    expect(session.active).toBe(false);
    expect(proxy.running).toBe(false);
    expect(fake.deletedSessions).toHaveLength(1);
  }, 20_000);

  it("refuses a Camofox that browses directly and leaves no tab open", async () => {
    const proxyPort = await freePort();
    const fake = await startFakeCamofox("direct", proxyPort);
    const session = new CamofoxBrowserSession(
      settingsFor(fake.origin, proxyPort),
      clientFor(fake.origin),
      proxy,
      context(),
    );
    const result = await session.execute(
      "browser_navigate",
      { url: "https://example.com/" },
      noEffect,
    );
    expect(result).toMatchObject({ success: false, setupRequired: true });
    expect(String(result.error)).toMatch(/policy proxy/);
    expect(String(result.startCommand)).toContain(`PROXY_PORT=${proxyPort}`);
    expect(fake.openTabs.size).toBe(0);
    await session.close();
    expect(proxy.running).toBe(false);
  }, 20_000);

  it("refuses a process on Camofox's port that cannot log in to the proxy", async () => {
    const proxyPort = await freePort();
    const fake = await startFakeCamofox("unauthenticated", proxyPort);
    const session = new CamofoxBrowserSession(
      settingsFor(fake.origin, proxyPort),
      clientFor(fake.origin),
      proxy,
      context(),
    );
    const result = await session.execute(
      "browser_navigate",
      { url: "https://example.com/" },
      noEffect,
    );
    expect(result).toMatchObject({ success: false, setupRequired: true });
    expect(String(result.error)).toMatch(/policy proxy/);
    expect(fake.openTabs.size).toBe(0);
    await session.close();
  }, 20_000);

  it("refuses a Camofox that loads loopback addresses around the proxy", async () => {
    const proxyPort = await freePort();
    const fake = await startFakeCamofox("loopback-direct", proxyPort);
    const session = new CamofoxBrowserSession(
      settingsFor(fake.origin, proxyPort),
      clientFor(fake.origin),
      proxy,
      context(),
    );
    const result = await session.execute(
      "browser_navigate",
      { url: "https://example.com/" },
      noEffect,
    );
    expect(result).toMatchObject({ success: false, setupRequired: true });
    expect(String(result.error)).toMatch(/127\.0\.0\.1 and localhost/);
    expect(fake.openTabs.size).toBe(0);
    await session.close();
  }, 20_000);

  it("does not accept a check page that lacks the proxy's token", async () => {
    // A Camofox behind some other proxy that answers every name with a page.
    const proxyPort = await freePort();
    const impostorPort = await listen(createServer((_req, res) => res.end("<h1>catch-all</h1>")));
    const fake = await startFakeCamofox("proxied", impostorPort);
    const session = new CamofoxBrowserSession(
      settingsFor(fake.origin, proxyPort),
      clientFor(fake.origin),
      proxy,
      context(),
    );
    const result = await session.execute(
      "browser_navigate",
      { url: "https://example.com/" },
      noEffect,
    );
    expect(result).toMatchObject({ success: false, setupRequired: true });
    expect(fake.openTabs.size).toBe(0);
    await session.close();
  }, 20_000);

  it("keeps a persistent identity's session and only closes its tabs", async () => {
    const sitePort = await targetSite();
    vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "127.0.0.1", family: 4 }] as Any);
    const proxyPort = await freePort();
    const fake = await startFakeCamofox("proxied", proxyPort);
    const session = new CamofoxBrowserSession(
      settingsFor(fake.origin, proxyPort, true),
      clientFor(fake.origin),
      proxy,
      context(),
    );
    await session.execute(
      "browser_navigate",
      { url: `http://allowed.test:${sitePort}/` },
      noEffect,
    );
    expect(fake.openTabs.size).toBe(1);
    await session.close();
    expect(fake.deletedSessions).toHaveLength(0);
    expect(fake.openTabs.size).toBe(0);
  }, 20_000);
});

describe("saved cookies", () => {
  const savedCookie = {
    url: "https://allowed.test/",
    name: "sid",
    value: "SECRET",
    domain: ".allowed.test",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax" as const,
    expirationDate: 2_000_000_000,
  };

  async function sessionWith(
    overrides: Partial<CamofoxSessionContext>,
    persistentIdentity = false,
  ) {
    const sitePort = await targetSite();
    vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "127.0.0.1", family: 4 }] as Any);
    const proxyPort = await freePort();
    const fake = await startFakeCamofox("proxied", proxyPort);
    const newSession = (taskId: string) =>
      new CamofoxBrowserSession(
        settingsFor(fake.origin, proxyPort, persistentIdentity),
        clientFor(fake.origin),
        proxy,
        context({ taskId, savedCookiesForHost: () => [{ ...savedCookie }], ...overrides }),
      );
    return {
      session: newSession("task-1"),
      newSession,
      fake,
      url: `http://allowed.test:${sitePort}/`,
    };
  }

  /** The identities of the tabs Camofox has open. */
  const openIdentities = (fake: FakeCamofox) =>
    [...fake.openTabs].map((tabId) => fake.tabUsers.get(tabId));

  it("loads them only after the user approves", async () => {
    const approve = vi.fn(async () => true);
    const { session, fake, url } = await sessionWith({ approveSavedCookies: approve });
    const result = await session.execute(
      "browser_navigate",
      { url, use_saved_cookies: true },
      noEffect,
    );
    expect(result).toMatchObject({ success: true, savedCookiesLoaded: 1 });
    expect(approve).toHaveBeenCalledWith("allowed.test", 1);
    expect(fake.cookieImports).toEqual([
      [
        {
          name: "sid",
          value: "SECRET",
          domain: ".allowed.test",
          path: "/",
          expires: 2_000_000_000,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
      ],
    ]);
    expect(JSON.stringify(result)).not.toContain("SECRET");
    await session.close();
  }, 20_000);

  it("sends nothing when the user declines, or for a bot", async () => {
    const declined = await sessionWith({ approveSavedCookies: async () => false });
    const result = await declined.session.execute(
      "browser_navigate",
      { url: declined.url, use_saved_cookies: true },
      noEffect,
    );
    expect(result).toMatchObject({ success: false });
    expect(declined.fake.cookieImports).toHaveLength(0);
    await declined.session.close();

    const bot = await sessionWith({ mayUseSavedCookies: false });
    const botResult = await bot.session.execute(
      "browser_navigate",
      { url: bot.url, use_saved_cookies: true },
      noEffect,
    );
    expect(String(botResult.error)).toMatch(/bot/);
    expect(bot.fake.cookieImports).toHaveLength(0);
    expect(bot.fake.openTabs.size).toBe(0);
    await bot.session.close();
  }, 20_000);

  it("never loads them into the workspace's shared identity", async () => {
    const { session, newSession, fake, url } = await sessionWith({}, true);
    await session.execute("browser_navigate", { url }, noEffect);
    const [shared] = openIdentities(fake);
    expect(shared).toMatch(/^cowork-(?!task-)/);

    const result = await session.execute(
      "browser_navigate",
      { url, use_saved_cookies: true },
      noEffect,
    );
    expect(result).toMatchObject({ success: true, savedCookiesLoaded: 1 });
    expect(String(result.message)).toMatch(/this task only/);
    const [taskOnly] = fake.cookieUsers;
    expect(taskOnly).toMatch(/^cowork-task-/);
    // The shared identity's tabs are closed; the task goes on in its own identity.
    expect(openIdentities(fake)).toEqual([taskOnly]);
    expect(await session.execute("browser_snapshot", {}, noEffect)).toMatchObject({
      success: true,
    });

    await session.close();
    expect(fake.deletedSessions).toEqual([taskOnly]);

    // A later task in the workspace gets the shared identity, which never held the cookies.
    const later = newSession("task-2");
    await later.execute("browser_navigate", { url }, noEffect);
    expect(openIdentities(fake)).toEqual([shared]);
    expect(fake.cookieUsers).toEqual([taskOnly]);
    await later.close();
  }, 20_000);

  it("stays in the shared identity when the user declines", async () => {
    const approve = vi.fn(async () => false);
    const { session, fake, url } = await sessionWith({ approveSavedCookies: approve }, true);
    const result = await session.execute(
      "browser_navigate",
      { url, use_saved_cookies: true },
      noEffect,
    );
    expect(result).toMatchObject({ success: false });
    expect(approve).toHaveBeenCalledTimes(1);
    expect(fake.cookieImports).toHaveLength(0);
    expect(openIdentities(fake)).toEqual([expect.stringMatching(/^cowork-(?!task-)/)]);
    await session.close();
    expect(fake.deletedSessions).toHaveLength(0);
  }, 20_000);

  it("maps vault cookies to Camofox cookies", () => {
    expect(
      toCamofoxCookie({
        ...savedCookie,
        domain: undefined,
        sameSite: "unspecified",
        expirationDate: undefined,
      }),
    ).toEqual({
      name: "sid",
      value: "SECRET",
      domain: "allowed.test",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: true,
    });
  });
});

describe("tool routing", () => {
  it("refuses tools Camofox cannot carry out and actions before a tab is open", async () => {
    const proxyPort = await freePort();
    const session = new CamofoxBrowserSession(
      settingsFor("http://127.0.0.1:1", proxyPort),
      clientFor("http://127.0.0.1:1"),
      proxy,
      context(),
    );
    const drag = await session.execute("browser_drag", {}, noEffect);
    expect(drag).toMatchObject({ success: false, browserProvider: "camofox" });
    expect(String(drag.error)).toMatch(/browser_close/);
    const click = await session.execute("browser_click", { ref: "e1" }, noEffect);
    expect(String(click.error)).toMatch(/browser_navigate first/);
  });

  it("refuses non-web URLs before touching Camofox", async () => {
    const proxyPort = await freePort();
    const session = new CamofoxBrowserSession(
      settingsFor("http://127.0.0.1:1", proxyPort),
      clientFor("http://127.0.0.1:1"),
      proxy,
      context({ preflightNavigation: async (url) => String(url) }),
    );
    const result = await session.execute(
      "browser_navigate",
      { url: "file:///etc/hosts" },
      noEffect,
    );
    expect(String(result.error)).toMatch(/http/);
    expect(proxy.running).toBe(false);
  });
});

describe("checkCamofoxConnection", () => {
  it("reports an unreachable server, a direct one, and a proxied one", async () => {
    const proxyPort = await freePort();
    const down = await checkCamofoxConnection(
      settingsFor("http://127.0.0.1:1", proxyPort),
      clientFor("http://127.0.0.1:1"),
      proxy,
      () => {},
    );
    expect(down).toMatchObject({ reachable: false });

    const direct = await startFakeCamofox("direct", proxyPort);
    const directResult = await checkCamofoxConnection(
      settingsFor(direct.origin, proxyPort),
      clientFor(direct.origin),
      proxy,
      () => {},
    );
    expect(directResult).toMatchObject({ reachable: true, proxied: false });
    expect(directResult.startCommand).toContain("PROXY_HOST=127.0.0.1");

    const proxied = await startFakeCamofox("proxied", proxyPort);
    const proxiedResult = await checkCamofoxConnection(
      settingsFor(proxied.origin, proxyPort),
      clientFor(proxied.origin),
      proxy,
      () => {},
    );
    expect(proxiedResult).toEqual({ reachable: true, proxied: true });
    expect(proxied.deletedSessions).toHaveLength(1);
    expect(proxy.running).toBe(false);
  }, 20_000);
});

describe("hardening", () => {
  it("refuses a Camofox started without an access key", async () => {
    const proxyPort = await freePort();
    const open = await startFakeCamofox("proxied", proxyPort, "");
    const session = new CamofoxBrowserSession(
      settingsFor(open.origin, proxyPort),
      clientFor(open.origin),
      proxy,
      context(),
    );
    const result = await session.execute(
      "browser_navigate",
      { url: "https://example.com/" },
      noEffect,
    );
    expect(result).toMatchObject({ success: false, setupRequired: true });
    expect(String(result.error)).toMatch(/access key/);
    expect(open.openTabs.size).toBe(0);
    await session.close();
  });

  it("checks the proxy before loading saved cookies, and sends none when it fails", async () => {
    const proxyPort = await freePort();
    const direct = await startFakeCamofox("direct", proxyPort);
    const approve = vi.fn(async () => true);
    const session = new CamofoxBrowserSession(
      settingsFor(direct.origin, proxyPort),
      clientFor(direct.origin),
      proxy,
      context({
        savedCookiesForHost: () => [
          {
            url: "https://example.com/",
            name: "sid",
            value: "SECRET",
            domain: ".example.com",
            path: "/",
            secure: true,
            httpOnly: true,
            sameSite: "lax",
          },
        ],
        approveSavedCookies: approve,
      }),
    );
    const result = await session.execute(
      "browser_navigate",
      { url: "https://example.com/", use_saved_cookies: true },
      noEffect,
    );
    expect(result).toMatchObject({ success: false, setupRequired: true });
    expect(approve).not.toHaveBeenCalled();
    expect(direct.cookieImports).toHaveLength(0);
    await session.close();
  }, 20_000);

  it("only opens public web pages", async () => {
    const proxyPort = await freePort();
    const session = new CamofoxBrowserSession(
      settingsFor("http://127.0.0.1:1", proxyPort),
      clientFor("http://127.0.0.1:1"),
      proxy,
      context(),
    );
    for (const url of ["http://127.0.0.1:9377/tabs", "http://192.168.1.1/", "http://intranet/"]) {
      const result = await session.execute("browser_navigate", { url }, noEffect);
      expect(String(result.error)).toMatch(/public websites/);
    }
    const tab = await session.execute("browser_new_tab", { url: "file:///etc/hosts" }, noEffect);
    expect(String(tab.error)).toMatch(/http/);
    expect(proxy.running).toBe(false);
  });

  it("keeps cookie values and keys away from a non-web URL in the client", async () => {
    await expect(
      clientFor("http://127.0.0.1:1").createTab("u", "s", "file:///etc/hosts"),
    ).rejects.toThrow(/http/);
    await expect(clientFor("http://127.0.0.1:1").navigate("u", "t", "about:blank")).rejects.toThrow(
      /http/,
    );
  });
});

describe("looksLikePublicSuffix", () => {
  it("never sends cookies scoped to a whole suffix", async () => {
    const { looksLikePublicSuffix } = await import("../camofox-session");
    expect(looksLikePublicSuffix(".uk")).toBe(true);
    expect(looksLikePublicSuffix(".co.uk")).toBe(true);
    expect(looksLikePublicSuffix("com.au")).toBe(true);
    expect(looksLikePublicSuffix(".example.co.uk")).toBe(false);
    expect(looksLikePublicSuffix(".linkedin.com")).toBe(false);
    expect(looksLikePublicSuffix("www.example.com")).toBe(false);
  });
});
