import { createServer } from "http";
import { connect, type Socket } from "net";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { pinnedFetch, resolvePinnedAddresses } from "./pinned-fetch";
import { readLimitedBody } from "../gateway/channels/webhook-channel-utils";

export interface BrowserNetworkProxy {
  url: string;
  closeConnections(): void;
  close(): Promise<void>;
}

/** Chromium sends redirects through the proxy too; it never resolves the target itself. */
export async function createBrowserNetworkProxy(
  assertAllowed: (url: string) => void,
): Promise<BrowserNetworkProxy> {
  const sockets = new Set<Socket>();
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
    if (sockets.size >= 64) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
    socket.setTimeout(30_000, () => socket.destroy());
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
        const addresses = await resolvePinnedAddresses(target.href, AbortSignal.timeout(10_000));
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
        upstream.setTimeout(30_000, () => upstream.destroy());
        upstream.once("connect", () => {
          // Recheck authority after asynchronous resolution, before exposing the tunnel.
          try {
            assertAllowed(target.href);
          } catch {
            upstream.destroy();
            return;
          }
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
