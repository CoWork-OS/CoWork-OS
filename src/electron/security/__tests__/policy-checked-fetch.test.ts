import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GuardrailManager } from "../../guardrails/guardrail-manager";
import { fetchWithPolicyCheckedRedirects } from "../policy-checked-fetch";
import { createPactTransport } from "../../pact/transport-node";
import { PactTransportError } from "../../pact/transport";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function listen(handler: Handler): Promise<{ server: Server; origin: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

const seen: { path: string; headers: IncomingMessage["headers"] }[] = [];
let a: { server: Server; origin: string };
let b: { server: Server; origin: string };

beforeAll(async () => {
  vi.spyOn(GuardrailManager, "isDomainAllowed").mockReturnValue(true);
  b = await listen((req, res) => {
    seen.push({ path: `b${req.url}`, headers: req.headers });
    if (req.url === "/final") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    res.writeHead(404).end();
  });
  a = await listen((req, res) => {
    seen.push({ path: `a${req.url}`, headers: req.headers });
    if (req.url === "/start") {
      res.writeHead(302, { location: `${b.origin}/final` }).end();
      return;
    }
    if (req.url === "/loop") {
      res.writeHead(302, { location: "/loop" }).end();
      return;
    }
    if (req.url === "/big") {
      res.writeHead(200).end("x".repeat(300 * 1024));
      return;
    }
    if (req.url === "/slow") {
      setTimeout(() => res.writeHead(200).end("late"), 15_000);
      return;
    }
    res.writeHead(404).end();
  });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await Promise.all([a, b].map(({ server }) => new Promise((resolve) => server.close(resolve))));
});

const context = { networkEnabled: true, accessNetworkMode: "enabled" as const };

describe("shared policy-checked redirects", () => {
  it("follows redirects, records the chain and resets caller headers across origins", async () => {
    seen.length = 0;
    const decisions: string[] = [];
    const { response, chain, finalUrl } = await fetchWithPolicyCheckedRedirects(
      `${a.origin}/start`,
      { headers: { Authorization: "Bearer secret", Accept: "application/json" } },
      {
        toolName: "test",
        networkContext: context,
        publicHeaders: { Accept: "application/json" },
        onDecision: (decision) => decisions.push(decision.url),
      },
    );
    expect(response.status).toBe(200);
    expect(chain).toEqual([`${a.origin}/start`, `${b.origin}/final`]);
    expect(finalUrl).toBe(`${b.origin}/final`);
    expect(seen[0]?.headers.authorization).toBe("Bearer secret");
    expect(seen[1]?.headers.authorization).toBeUndefined();
    // Each hop is evaluated once.
    expect(decisions).toEqual([`${a.origin}/start`, `${b.origin}/final`]);
  });

  it("refuses a cross-origin redirect that would carry a body", async () => {
    await expect(
      fetchWithPolicyCheckedRedirects(
        `${a.origin}/start`,
        { method: "PUT", body: "secret" },
        { toolName: "test", networkContext: context },
      ),
    ).rejects.toThrow(/Cross-origin/);
  });

  it("stops after the redirect limit and on a policy-denied hop", async () => {
    await expect(
      fetchWithPolicyCheckedRedirects(
        `${a.origin}/loop`,
        {},
        { toolName: "test", networkContext: context },
      ),
    ).rejects.toThrow(/Too many redirects/);
    await expect(
      fetchWithPolicyCheckedRedirects(
        `${a.origin}/start`,
        {},
        {
          toolName: "test",
          networkContext: {
            ...context,
            profileDomainRules: [{ pattern: "127.0.0.1", access: "deny" }],
          },
        },
      ),
    ).rejects.toThrow(/Network access denied/);
  });
});

describe("PACT transport over the shared client", () => {
  const transport = createPactTransport({ networkContext: context });

  it("follows card redirects and reports the chain", async () => {
    const response = await transport.request({
      purpose: "card",
      method: "GET",
      url: `${a.origin}/start`,
    });
    expect(response.status).toBe(200);
    expect(response.chain).toHaveLength(2);
  });

  it("never follows redirects on credential-bearing purposes", async () => {
    const response = await transport.request({
      purpose: "message",
      method: "POST",
      url: `${a.origin}/start`,
      body: "{}",
    });
    expect(response.status).toBe(302);
    expect(response.chain).toHaveLength(1);
  });

  it("caps response size per purpose", async () => {
    await expect(
      transport.request({ purpose: "card", method: "GET", url: `${a.origin}/big` }),
    ).rejects.toMatchObject({ code: "too_large" });
  });

  it("maps a policy denial to a typed error", async () => {
    const denied = createPactTransport({
      networkContext: {
        ...context,
        profileDomainRules: [{ pattern: "127.0.0.1", access: "deny" }],
      },
    });
    await expect(
      denied.request({ purpose: "card", method: "GET", url: `${a.origin}/start` }),
    ).rejects.toBeInstanceOf(PactTransportError);
  });

  it("aborts when the caller cancels", async () => {
    const controller = new AbortController();
    const pending = transport.request({
      purpose: "card",
      method: "GET",
      url: `${a.origin}/slow`,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });
});
