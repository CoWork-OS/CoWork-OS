import { createServer } from "http";
import { connect, Socket } from "net";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { pinnedFetch, resolvePinnedAddresses } from "./pinned-fetch";
import { isLoopbackAddress } from "./address-classes";
import { readLimitedBody } from "../gateway/channels/webhook-channel-utils";

export interface BrowserNetworkProxy {
  url: string;
  closeConnections(): void;
  close(): Promise<void>;
}

export interface BrowserNetworkProxyOptions {
  /**
   * Whether a loopback origin ("http://localhost:5173") may be reached. When set, loopback is
   * refused for every other target, including a DNS name that resolves to 127.0.0.1, so a
   * page cannot reach local services by naming them differently. Omitted: loopback is allowed.
   */
  allowsLoopback?: (origin: string) => boolean;
  /** Idle limit for requests and for tunnels until they are established. */
  idleTimeoutMs?: number;
  /** Idle limit for established tunnels, which carry WebSockets and HTTP/2 sessions. */
  tunnelIdleTimeoutMs?: number;
}

const IDLE_TIMEOUT_MS = 30_000;
/**
 * WebSockets (chat, live updates) and pooled HTTP/2 sessions sit quiet for minutes; cutting
 * them at 30 s made pages reconnect over and over.
 */
const TUNNEL_IDLE_TIMEOUT_MS = 10 * 60_000;
/**
 * Concurrent client connections. Chromium keeps at most 32 ordinary connections per proxy,
 * and WebSockets come on top of that; each tunnel also holds an upstream socket, so this
 * bounds descriptors at about twice the number.
 */
const MAX_CLIENT_CONNECTIONS = 128;

/** Chromium sends redirects through the proxy too; it never resolves the target itself. */
export async function createBrowserNetworkProxy(
  assertAllowed: (url: string) => void,
  options: BrowserNetworkProxyOptions = {},
): Promise<BrowserNetworkProxy> {
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const tunnelIdleTimeoutMs = options.tunnelIdleTimeoutMs ?? TUNNEL_IDLE_TIMEOUT_MS;
  const allowLoopback = (target: URL, origin: string) =>
    !options.allowsLoopback ||
    (isLoopbackAddress(target.hostname) && options.allowsLoopback(origin));
  const sockets = new Set<Socket>();
  const clients = new Set<Socket>();
  const server = createServer(async (req, res) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    res.on("close", () => controller.abort());
    try {
      const target = new URL(req.url || "");
      if (target.protocol !== "http:" || target.username || target.password)
        throw new Error("Invalid proxy target");
      assertAllowed(target.href);
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (
          value !== undefined &&
          ![
            "host",
            "connection",
            "proxy-authorization",
            "proxy-connection",
            "transfer-encoding",
            "content-length",
          ].includes(key)
        )
          headers[key] = Array.isArray(value) ? value.join(", ") : value;
      }
      const body = ["GET", "HEAD"].includes(req.method || "GET")
        ? undefined
        : new Uint8Array(await readLimitedBody(req, 5 * 1024 * 1024));
      assertAllowed(target.href);
      const response = await pinnedFetch(
        target.href,
        { method: req.method, headers, body, signal: controller.signal },
        true,
        { allowLoopback: allowLoopback(target, target.origin) },
      );
      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        if (
          ![
            "set-cookie",
            "content-encoding",
            "content-length",
            "transfer-encoding",
            "connection",
          ].includes(key)
        )
          res.setHeader(key, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) res.setHeader("set-cookie", cookies);
      if (!response.body) {
        res.end();
        return;
      }
      let bytes = 0;
      const limit = new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          callback(
            bytes > 50 * 1024 * 1024 ? new Error("Browser response exceeds limit") : null,
            chunk,
          );
        },
      });
      await pipeline(
        Readable.fromWeb(response.body as import("stream/web").ReadableStream),
        limit,
        res,
      );
    } catch {
      if (!res.headersSent) {
        res.writeHead(502);
        res.end("Browser network request refused");
      } else res.destroy();
      req.resume();
    } finally {
      clearTimeout(timer);
    }
  });
  server.on("connection", (socket) => {
    if (clients.size >= MAX_CLIENT_CONNECTIONS) {
      socket.destroy();
      return;
    }
    clients.add(socket);
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      clients.delete(socket);
      sockets.delete(socket);
    });
    socket.setTimeout(idleTimeoutMs, () => socket.destroy());
  });
  server.on("upgrade", (_req, socket) => socket.destroy());
  server.on("connect", (req, client, head) => {
    void (async () => {
      try {
        const target = new URL(`https://${req.url}`);
        if (
          target.username ||
          target.password ||
          target.pathname !== "/" ||
          target.search ||
          target.hash
        )
          throw new Error("Invalid CONNECT target");
        assertAllowed(target.href);
        // CONNECT names no scheme (https: or a ws: socket); loopback approvals are http: origins.
        const origin = `http://${target.host}`;
        const addresses = await resolvePinnedAddresses(target.href, AbortSignal.timeout(10_000), {
          allowLoopback: allowLoopback(target, origin),
        });
        if (client.destroyed) return;
        const selected = addresses.find((address) => address.family === 4) || addresses[0];
        const upstream = connect({
          host: selected.address,
          port: Number(target.port || 443),
          family: selected.family,
        });
        sockets.add(upstream);
        upstream.on("error", () => {
          upstream.destroy();
          client.destroy();
        });
        upstream.on("close", () => {
          sockets.delete(upstream);
          client.destroy();
        });
        client.on("close", () => upstream.destroy());
        upstream.setTimeout(idleTimeoutMs, () => upstream.destroy());
        upstream.once("connect", () => {
          // Recheck authority after asynchronous resolution, before exposing the tunnel.
          try {
            assertAllowed(target.href);
            if (isLoopbackAddress(selected.address) && !allowLoopback(target, origin))
              throw new Error("Loopback approval was withdrawn");
          } catch {
            upstream.destroy();
            return;
          }
          // The CONNECT socket is typed as a plain stream; over TCP it is the client Socket.
          if (client instanceof Socket) client.setTimeout(tunnelIdleTimeoutMs);
          upstream.setTimeout(tunnelIdleTimeoutMs);
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length) upstream.write(head);
          client.pipe(upstream);
          upstream.pipe(client);
        });
      } catch {
        client.destroy();
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    closeConnections: () => {
      for (const socket of sockets) socket.destroy();
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
