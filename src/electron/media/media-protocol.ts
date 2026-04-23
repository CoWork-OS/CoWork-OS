import { randomUUID } from "crypto";
import { protocol } from "electron";
import * as fs from "fs";
import * as path from "path";
import { Readable } from "stream";

const MEDIA_SCHEME = "media";
const TOKEN_TTL_MS = 60 * 60 * 1000;
const ALLOWED_MIME_TYPES = new Set(["video/mp4", "video/webm", "audio/mpeg", "audio/mp3", "audio/wav"]);
const ALLOWED_EXTENSIONS = new Set([".mp4", ".webm", ".mp3", ".wav"]);

type MediaTokenRecord = {
  resolvedPath: string;
  workspaceRoot: string;
  mimeType: string;
  expiresAt: number;
};

const mediaTokenStore = new Map<string, MediaTokenRecord>();

function purgeExpiredTokens(now = Date.now()): void {
  for (const [token, record] of mediaTokenStore.entries()) {
    if (record.expiresAt <= now) {
      mediaTokenStore.delete(token);
    }
  }
}

function isPathWithinWorkspace(resolvedPath: string, workspaceRoot: string): boolean {
  const normalizedWorkspace = path.resolve(workspaceRoot);
  const normalizedFile = path.resolve(resolvedPath);
  const relative = path.relative(normalizedWorkspace, normalizedFile);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isSupportedMediaFile(resolvedPath: string, mimeType: string): boolean {
  const ext = path.extname(resolvedPath).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext) && ALLOWED_MIME_TYPES.has(mimeType.toLowerCase());
}

function createErrorResponse(statusCode: number, message: string): Response {
  return new Response(message, {
    status: statusCode,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "private, no-store",
    },
  });
}

function parseRangeHeader(rangeHeader: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match) return null;

  const startRaw = match[1];
  const endRaw = match[2];
  let start = startRaw ? Number.parseInt(startRaw, 10) : Number.NaN;
  let end = endRaw ? Number.parseInt(endRaw, 10) : Number.NaN;

  if (Number.isNaN(start) && Number.isNaN(end)) return null;

  if (Number.isNaN(start)) {
    const suffixLength = end;
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else if (Number.isNaN(end)) {
    end = size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) {
    return null;
  }

  return {
    start,
    end: Math.min(end, size - 1),
  };
}

export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
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

export function createMediaPlaybackUrl(params: {
  resolvedPath: string;
  workspaceRoot: string;
  mimeType: string;
}): string {
  purgeExpiredTokens();

  const resolvedPath = path.resolve(params.resolvedPath);
  const workspaceRoot = path.resolve(params.workspaceRoot);
  const mimeType = String(params.mimeType || "").toLowerCase();

  if (!isPathWithinWorkspace(resolvedPath, workspaceRoot)) {
    throw new Error("Access denied: media path is outside the workspace");
  }
  if (!isSupportedMediaFile(resolvedPath, mimeType)) {
    throw new Error("Unsupported media type");
  }

  const token = randomUUID();
  mediaTokenStore.set(token, {
    resolvedPath,
    workspaceRoot,
    mimeType,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });

  return `${MEDIA_SCHEME}://local/${token}`;
}

export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    purgeExpiredTokens();

    let token = "";
    try {
      const url = new URL(request.url);
      token = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    } catch {
      return createErrorResponse(400, "Invalid media URL");
    }

    if (!token) {
      return createErrorResponse(400, "Missing media token");
    }

    const record = mediaTokenStore.get(token);
    if (!record) {
      return createErrorResponse(404, "Media token not found");
    }

    if (record.expiresAt <= Date.now()) {
      mediaTokenStore.delete(token);
      return createErrorResponse(403, "Media token expired");
    }

    const resolvedPath = path.resolve(record.resolvedPath);
    const workspaceRoot = path.resolve(record.workspaceRoot);
    if (
      !isPathWithinWorkspace(resolvedPath, workspaceRoot) ||
      !isSupportedMediaFile(resolvedPath, record.mimeType)
    ) {
      mediaTokenStore.delete(token);
      return createErrorResponse(403, "Forbidden");
    }

    if (!fs.existsSync(resolvedPath)) {
      mediaTokenStore.delete(token);
      return createErrorResponse(404, "Media file not found");
    }

    const stats = await fs.promises.stat(resolvedPath);
    if (!stats.isFile()) {
      return createErrorResponse(404, "Media file not found");
    }

    const baseHeaders = {
      "Content-Type": record.mimeType,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
    };

    const rangeHeader = request.headers.get("range");
    if (!rangeHeader) {
      const stream = fs.createReadStream(resolvedPath);
      return new Response(Readable.toWeb(stream) as BodyInit, {
        status: 200,
        headers: {
          ...baseHeaders,
          "Content-Length": String(stats.size),
        },
      });
    }

    const range = parseRangeHeader(rangeHeader, stats.size);
    if (!range) {
      return new Response(null, {
        status: 416,
        headers: {
          ...baseHeaders,
          "Content-Range": `bytes */${stats.size}`,
        },
      });
    }

    const contentLength = range.end - range.start + 1;
    const stream = fs.createReadStream(resolvedPath, { start: range.start, end: range.end });
    return new Response(Readable.toWeb(stream) as BodyInit, {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Length": String(contentLength),
        "Content-Range": `bytes ${range.start}-${range.end}/${stats.size}`,
      },
    });
  });
}
