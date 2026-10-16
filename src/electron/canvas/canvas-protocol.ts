/**
 * Canvas Protocol Handler
 *
 * Registers a custom 'canvas://' URL scheme that serves files from
 * canvas session directories to the canvas BrowserWindows.
 *
 * URL Format: canvas://{sessionId}/{filename}
 * Example: canvas://abc123-def456/index.html
 */

import type { Protocol } from "electron";
import * as path from "path";
import * as fs from "fs";
import { Readable } from "stream";
import { CanvasManager } from "./canvas-manager";

// MIME type mapping
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".pdf": "application/pdf",
  ".xml": "application/xml",
  ".txt": "text/plain",
  ".md": "text/markdown",
};

/**
 * Get MIME type for a file extension
 */
function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

/**
 * Create an error response
 */
function createErrorResponse(statusCode: number, message: string): Response {
  return new Response(message, {
    status: statusCode,
    headers: {
      "Content-Type": "text/plain",
    },
  });
}

/** Largest single range response; the player asks again for the rest. */
const MAX_RANGE_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * Parse a single `bytes=` Range header against a file size. Returns null when the
 * range cannot be satisfied (multi-range requests are not supported). Open-ended
 * ranges are capped so one request never buffers a whole large clip.
 */
export function parseByteRange(
  header: string,
  size: number,
): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || "").trim());
  if (!match || size <= 0) return null;
  const [, rawStart, rawEnd] = match;
  let start: number;
  let end: number;
  if (rawStart === "" && rawEnd === "") return null;
  if (rawStart === "") {
    // Suffix range: the last N bytes.
    const suffix = Number(rawEnd);
    if (suffix <= 0) return null;
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size)
    return null;
  end = Math.min(end, start + MAX_RANGE_CHUNK_BYTES - 1);
  return { start, end };
}

/**
 * Electron's protocol module, loaded on first use: the headless daemon imports the canvas
 * manager (and this module) without Electron installed, so it must not load at import time.
 */
function electronProtocol(): Protocol {
  // A static import would load Electron in the headless daemon, where it is not installed.
  // oxlint-disable-next-line typescript-eslint(no-require-imports)
  return (require("electron") as typeof import("electron")).protocol;
}

/**
 * Register the canvas:// protocol scheme as privileged
 * Must be called before app.ready
 */
export function registerCanvasScheme(): void {
  electronProtocol().registerSchemesAsPrivileged([
    {
      scheme: "canvas",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/**
 * Register the canvas:// protocol handler
 * Must be called after app.ready
 */
export function registerCanvasProtocol(
  targetProtocol: Protocol = electronProtocol(),
  allowedSessionId?: string,
): void {
  targetProtocol.handle("canvas", async (request) => {
    try {
      const url = new URL(request.url);
      const sessionId = url.hostname;
      if (!allowedSessionId || sessionId !== allowedSessionId)
        return createErrorResponse(403, "Forbidden: Different canvas session");
      let filePath = decodeURIComponent(url.pathname);

      // Security: prevent path traversal attacks
      if (filePath.includes("..") || filePath.includes("//")) {
        console.warn(`[CanvasProtocol] Blocked path traversal attempt: ${filePath}`);
        return createErrorResponse(403, "Forbidden: Invalid path");
      }

      // Get the canvas manager
      const manager = CanvasManager.getInstance();
      const session = manager.getSession(sessionId);

      if (!session) {
        console.warn(`[CanvasProtocol] Session not found: ${sessionId}`);
        return createErrorResponse(404, "Session not found");
      }

      // Default to index.html for root requests
      if (filePath === "/" || filePath === "") {
        filePath = "/index.html";
      }

      // Remove leading slash
      const relativePath = filePath.startsWith("/") ? filePath.slice(1) : filePath;
      const fullPath = path.join(session.sessionDir, relativePath);

      // Security: ensure the resolved path is within the session directory
      const resolvedPath = path.resolve(fullPath);
      const resolvedSessionDir = path.resolve(session.sessionDir);
      if (
        resolvedPath !== resolvedSessionDir &&
        !resolvedPath.startsWith(resolvedSessionDir + path.sep)
      ) {
        console.warn(`[CanvasProtocol] Path escape attempt: ${fullPath}`);
        return createErrorResponse(403, "Forbidden: Path outside session");
      }

      // Check if file exists
      if (!fs.existsSync(fullPath)) {
        console.warn(`[CanvasProtocol] File not found: ${fullPath}`);
        return createErrorResponse(404, "File not found");
      }

      // Get file stats
      const stats = fs.statSync(fullPath);
      if (stats.isDirectory()) {
        // Try index.html in directory
        const indexPath = path.join(fullPath, "index.html");
        if (fs.existsSync(indexPath)) {
          const content = fs.readFileSync(indexPath);
          return new Response(content, {
            status: 200,
            headers: {
              "Content-Type": "text/html",
              "Content-Length": content.length.toString(),
            },
          });
        }
        return createErrorResponse(403, "Directory listing not allowed");
      }

      const mimeType = getMimeType(fullPath);

      // <video>/<audio> seek by byte range; without 206 support Chromium
      // cannot scrub or reliably loop generated clips.
      const rangeHeader = request.headers.get("range");
      if (rangeHeader) {
        const range = parseByteRange(rangeHeader, stats.size);
        if (!range) {
          return new Response(null, {
            status: 416,
            headers: { "Content-Range": `bytes */${stats.size}` },
          });
        }
        const length = range.end - range.start + 1;
        const chunk = Buffer.alloc(length);
        const fd = fs.openSync(fullPath, "r");
        try {
          fs.readSync(fd, chunk, 0, length, range.start);
        } finally {
          fs.closeSync(fd);
        }
        return new Response(chunk, {
          status: 206,
          headers: {
            "Content-Type": mimeType,
            "Content-Length": length.toString(),
            "Content-Range": `bytes ${range.start}-${range.end}/${stats.size}`,
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-cache",
          },
        });
      }

      // Stream the file so large media is never buffered whole in the main process.
      const body = Readable.toWeb(fs.createReadStream(fullPath)) as ReadableStream<Uint8Array>;

      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": mimeType,
          "Content-Length": stats.size.toString(),
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-cache", // Disable caching for development
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("[CanvasProtocol] Error handling request:", error);
      return createErrorResponse(500, `Internal error: ${message}`);
    }
  });

  console.log("[CanvasProtocol] Registered canvas:// protocol handler");
}
