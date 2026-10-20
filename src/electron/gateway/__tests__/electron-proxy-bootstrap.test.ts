import { execFile } from "node:child_process";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const execute = promisify(execFile);
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }),
  );
});

async function listen(server: ReturnType<typeof createServer>) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing local proxy fixture port");
  return `http://127.0.0.1:${address.port}`;
}

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

// Each bootstrap runs in a separate Node process. Never replace the test worker's
// global agents or inherit the developer's real proxy configuration.
const child = String.raw`
const http = require('node:http');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const logs = [];
const get = require(process.argv[1]);
const fromGet = createRequire(process.argv[1]);
const fromAgent = createRequire(fromGet.resolve('global-agent'));
fromAgent('roarr').ROARR.write = line => logs.push(JSON.parse(line));
get.initializeProxy();
const origin = new URL(process.argv[2]);
function finish(responses) { console.log(JSON.stringify({ responses, logs })); }
function send(destination, options, text) {
  return new Promise((resolve, reject) => {
    const callback = response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    };
    const req = destination ? http.request(destination, options, callback) : http.request(options, callback);
    req.setTimeout(2000, () => req.destroy(new Error('Local proxy fixture timeout')));
    req.on('error', reject);
    req.end(text);
  });
}
(async () => {
  const mode = process.argv[3];
  if (mode === 'request-error') {
    await assert.rejects(
      send(new URL('/reset', origin), {}, ''),
      { code: 'ECONNRESET' }
    );
    finish([]);
  } else if (mode === 'custom-agent') {
    const agent = new http.Agent({ keepAlive: false });
    try {
      const result = await send(new URL('/custom-agent', origin), {
        method: 'PATCH', agent, headers: { 'x-fixture': 'custom-agent' }
      }, 'custom-body');
      finish([result]);
    } finally { agent.destroy(); }
  } else {
    const proxied = await send(new URL('/through-proxy?marker=1', origin), {
      method: 'POST', agent: false, headers: { 'x-fixture': 'proxied' }
    }, 'streamed-proxy-body');
    const bypassed = await send(null, {
      hostname: 'localhost', family: 4, port: origin.port, path: '/bypassed',
      method: 'PUT', headers: { 'x-fixture': 'bypassed' }
    }, 'direct-body');
    finish([proxied, bypassed]);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

async function runBootstrap(
  origin: string,
  proxy: string,
  mode: "proxy" | "custom-agent" | "request-error" = "proxy",
  logging = false,
) {
  const builderRequire = createRequire(require.resolve("app-builder-lib"));
  const electronGet = builderRequire.resolve("@electron/get");
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      /^(?:GLOBAL_AGENT_|ROARR_|https?_proxy$|all_proxy$|no_proxy$|npm_config_proxy$|NODE_OPTIONS$|ELECTRON_GET_USE_PROXY$)/i.test(
        key,
      )
    )
      delete env[key];
  }
  env.GLOBAL_AGENT_HTTP_PROXY = proxy;
  env.GLOBAL_AGENT_NO_PROXY = "localhost";
  if (mode === "custom-agent") env.GLOBAL_AGENT_FORCE_GLOBAL_AGENT = "false";
  env.ROARR_LOG = String(logging);
  const { stdout } = await execute(process.execPath, ["-e", child, electronGet, origin, mode], {
    env,
    timeout: 5000,
    maxBuffer: 64 * 1024,
  });
  return JSON.parse(stdout.trim()) as {
    responses: Array<{
      status: number;
      body: { method: string; url: string; marker: string; body: string };
    }>;
    logs: Array<{
      message: string;
      context: Record<string, unknown>;
      sequence: number;
      time: number;
      version: string;
    }>;
  };
}

async function proxyFixture() {
  const seen: string[] = [];
  const origin = await listen(
    createServer((request, response) => {
      body(request)
        .then((text) => {
          response.writeHead(200, {
            "content-type": "application/json",
            "x-fixture-format": "%.1000000f",
          });
          response.end(
            JSON.stringify({
              method: request.method,
              url: request.url,
              marker: request.headers["x-fixture"],
              body: text,
            }),
          );
        })
        .catch((error: Error) => response.destroy(error));
    }),
  );
  const proxy = await listen(
    createServer((request, response) => {
      const target = new URL(request.url ?? "/", origin);
      // The fixture must never forward a request outside its own local server.
      if (target.origin !== origin) {
        response.writeHead(400);
        response.end("Unexpected proxy target");
        return;
      }
      if (target.pathname === "/reset") {
        request.socket.destroy();
        return;
      }
      seen.push(target.href);
      const forward = httpRequest(
        target,
        { method: request.method, headers: request.headers },
        (upstream) => {
          response.writeHead(upstream.statusCode ?? 502, upstream.headers);
          upstream.pipe(response);
        },
      );
      forward.on("error", (error) => response.destroy(error));
      request.pipe(forward);
    }),
  );
  return { origin, proxy, seen };
}

describe("electron/get scoped proxy bootstrap compatibility", () => {
  it("honors GLOBAL_AGENT proxy/no-proxy and preserves URL/options request overloads, methods, headers and bodies", async () => {
    const fixture = await proxyFixture();
    const result = await runBootstrap(fixture.origin, fixture.proxy);
    expect(result.logs).toEqual([]);
    expect(result.responses).toEqual([
      {
        status: 200,
        body: {
          method: "POST",
          url: "/through-proxy?marker=1",
          marker: "proxied",
          body: "streamed-proxy-body",
        },
      },
      {
        status: 200,
        body: { method: "PUT", url: "/bypassed", marker: "bypassed", body: "direct-body" },
      },
    ]);
    expect(fixture.seen).toEqual([`${fixture.origin}/through-proxy?marker=1`]);
  });

  it("preserves an explicit custom HTTP agent when GLOBAL_AGENT_FORCE_GLOBAL_AGENT is false", async () => {
    const fixture = await proxyFixture();
    expect((await runBootstrap(fixture.origin, fixture.proxy, "custom-agent")).responses).toEqual([
      {
        status: 200,
        body: {
          method: "PATCH",
          url: "/custom-agent",
          marker: "custom-agent",
          body: "custom-body",
        },
      },
    ]);
    expect(fixture.seen).toEqual([]);
  });

  it("preserves enabled proxy diagnostics and treats response format specifiers as context data", async () => {
    const fixture = await proxyFixture();
    const start = Date.now();
    const result = await runBootstrap(fixture.origin, fixture.proxy, "proxy", true);
    expect(result.responses.map((response) => response.status)).toEqual([200, 200]);
    expect(result.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "global agent has been initialized" }),
        expect.objectContaining({
          message: "proxying request",
          context: expect.objectContaining({
            destination: `${fixture.origin}/through-proxy?marker=1`,
          }),
        }),
        expect.objectContaining({
          message: "proxying response",
          context: expect.objectContaining({
            headers: expect.objectContaining({ "x-fixture-format": "%.1000000f" }),
            statusCode: 200,
          }),
        }),
      ]),
    );
    for (const [index, entry] of result.logs.entries()) {
      expect(entry.context.package).toBe("global-agent");
      expect(entry.version).toBe("1.0.0");
      expect(Number.isInteger(entry.time)).toBe(true);
      expect(entry.time).toBeGreaterThanOrEqual(start - 1000);
      expect(entry.time).toBeLessThanOrEqual(Date.now());
      if (index) expect(entry.sequence).toBeGreaterThan(result.logs[index - 1].sequence);
    }
  });

  it("retains structured request-error diagnostics without swallowing transport failures", async () => {
    const fixture = await proxyFixture();
    const result = await runBootstrap(fixture.origin, fixture.proxy, "request-error", true);
    expect(result.responses).toEqual([]);
    expect(result.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "request error",
          context: expect.objectContaining({
            error: expect.objectContaining({ code: "ECONNRESET", message: "socket hang up" }),
          }),
        }),
      ]),
    );
  });
});
