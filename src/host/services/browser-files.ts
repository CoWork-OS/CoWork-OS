import { constants as fsConstants, type Stats } from "node:fs";
import crypto from "node:crypto";
import * as fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Workspace } from "../../shared/types";
import { isTempWorkspaceId } from "../../shared/types";
import {
  WEB_API_VERSION,
  WEB_WORKSPACE_FILE_MEDIA_PATH_PREFIX,
  WEB_WORKSPACE_FILE_DOWNLOAD_PATH,
  WEB_WORKSPACE_FILE_UPLOAD_PATH,
} from "../../shared/host-api/contracts";
import { evaluateWorkspaceFilesystemAccess } from "../../electron/security/access-profile-paths";
import {
  WebApplicationError,
  type WebRequestContext,
  type WebRpcMethod,
} from "../web/WebApplication";

const FILE_LIST_METHOD = "workspace.files.list";
const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_SCANNED_ENTRIES = 1_000;
const DEFAULT_MAX_PATH_CHARS = 4_096;
const DEFAULT_MAX_REQUEST_BYTES = 8 * 1024;
const DEFAULT_MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ACTIVE_UPLOAD_BYTES = 128 * 1024 * 1024;
const DEFAULT_REQUEST_BODY_TIMEOUT_MS = 15_000;
const MAX_REQUEST_BODY_TIMEOUT_MS = 60_000;
const DEFAULT_UPLOAD_BODY_TIMEOUT_MS = 5 * 60_000;
const MAX_UPLOAD_BODY_TIMEOUT_MS = 30 * 60_000;
const UPLOAD_TEMP_PREFIX = ".cowork-upload-";
const UPLOAD_TEMP_NAME_PATTERN =
  /^\.cowork-upload-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const STALE_UPLOAD_TEMP_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_STALE_UPLOAD_TEMP_SCAN = 1_000;
const DEFAULT_MEDIA_HANDLE_TTL_MS = 5 * 60_000;
const MAX_MEDIA_HANDLE_TTL_MS = 15 * 60_000;
const DEFAULT_MAX_ACTIVE_MEDIA_HANDLES = 256;
const MAX_ACTIVE_MEDIA_HANDLES = 2_048;
const MEDIA_HANDLE_RE = /^[A-Za-z0-9_-]{43}$/;
const VIDEO_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

export interface BrowserWorkspaceFileTarget {
  workspaceId: string;
  /** Canonical slash-separated path relative to the authorized workspace root. */
  relativePath: string;
}

export interface BrowserWorkspaceFileEntry {
  name: string;
  relativePath: string;
  type: "file" | "directory";
  size: number;
}

export interface BrowserWorkspaceFileListing {
  workspaceId: string;
  relativePath: string;
  entries: BrowserWorkspaceFileEntry[];
  truncated: boolean;
}

export interface BrowserWorkspaceMediaHandle {
  handle: string;
  fileName: string;
  mimeType: string;
  size: number;
  expiresAt: number;
}

export interface BrowserWorkspaceFilesOptions {
  /**
   * Resolve the workspace authorized for this host identity. Return null for
   * unknown or profile-inaccessible workspaces. Permissions must be the
   * effective permissions for this browser profile, not an unscoped DB row.
   */
  resolveWorkspace: (
    workspaceId: string,
    context: WebRequestContext,
  ) => Workspace | null | undefined | Promise<Workspace | null | undefined>;
  getCapabilities: (context: WebRequestContext) =>
    | {
        "files.read"?: { available: boolean };
        "files.upload"?: { available: boolean };
      }
    | Promise<{
        "files.read"?: { available: boolean };
        "files.upload"?: { available: boolean };
      }>;
  maxEntries?: number;
  maxScannedEntries?: number;
  maxPathChars?: number;
  maxRequestBytes?: number;
  /** Absolute deadline for JSON request bodies. Values are capped at one minute. */
  requestBodyTimeoutMs?: number;
  /** Maximum number of bytes in one streamed response; larger files fail closed. */
  maxDownloadBytes?: number;
  /** Maximum number of bytes accepted for one browser upload. */
  maxUploadBytes?: number;
  /** Absolute deadline for receiving a streamed upload body; values are capped at 30 minutes. */
  uploadBodyTimeoutMs?: number;
  /** Maximum bytes staged by concurrent browser uploads for one workspace. */
  maxWorkspaceActiveUploadBytes?: number;
  /** Maximum bytes staged by concurrent browser uploads across this service. */
  maxActiveUploadBytes?: number;
  mediaHandleTtlMs?: number;
  maxActiveMediaHandles?: number;
}

export interface BrowserTaskMediaFileSnapshot {
  bytes: Buffer;
  sizeBytes: number;
  identity: {
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
  };
}

/**
 * Bounded browser workspace file access. File bytes stream over HTTP and never
 * enter WebApplication's JSON-RPC response path.
 */
export class BrowserWorkspaceFiles {
  private activeUploadBytes = 0;
  private readonly activeUploadBytesByWorkspace = new Map<string, number>();
  private readonly mediaHandles = new Map<string, MediaHandleRecord>();

  constructor(private readonly options: BrowserWorkspaceFilesOptions) {}

  async list(context: WebRequestContext, rawTarget: unknown): Promise<BrowserWorkspaceFileListing> {
    await this.assertCapability(context);
    const target = parseTarget(rawTarget, this.maxPathChars);
    const workspace = await this.resolveWorkspace(target.workspaceId, context);
    const location = await this.resolveAuthorizedPath(workspace, target.relativePath, "directory");
    const directoryHandle = await fs
      .opendir(location.absolutePath, { bufferSize: 32 })
      .catch(() => {
        throw unavailable();
      });
    const entries: BrowserWorkspaceFileEntry[] = [];
    let scanned = 0;
    let truncated = false;

    try {
      while (scanned < this.maxScannedEntries) {
        const entry = await directoryHandle.read().catch(() => {
          throw unavailable();
        });
        if (!entry) break;
        scanned += 1;

        if (
          entry.name.startsWith(UPLOAD_TEMP_PREFIX) ||
          entry.name.includes("\\") ||
          entry.name.includes("\0")
        ) {
          continue;
        }
        const relativePath = joinRelativePath(target.relativePath, entry.name);
        if (relativePath.length > this.maxPathChars) {
          truncated = true;
          continue;
        }

        const childPath = path.join(location.absolutePath, entry.name);
        const realPath = await fs.realpath(childPath).catch(() => null);
        if (
          !realPath ||
          !isWithin(location.rootPath, realPath) ||
          isReservedUploadTempPath(location.rootPath, realPath)
        ) {
          continue;
        }
        if (!this.hasReadAccess(workspace, realPath)) continue;

        const stats = await fs.stat(realPath).catch(() => null);
        if (!stats || (!stats.isFile() && !stats.isDirectory())) continue;

        entries.push({
          name: entry.name,
          relativePath,
          type: stats.isDirectory() ? "directory" : "file",
          size: stats.isFile() ? stats.size : 0,
        });
      }

      if (scanned >= this.maxScannedEntries) {
        const nextEntry = await directoryHandle.read().catch(() => {
          throw unavailable();
        });
        truncated = truncated || Boolean(nextEntry);
      }
    } finally {
      await directoryHandle.close().catch(() => undefined);
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    truncated = truncated || entries.length > this.maxEntries;
    return {
      workspaceId: target.workspaceId,
      relativePath: target.relativePath,
      entries: entries.slice(0, this.maxEntries),
      truncated,
    };
  }

  /**
   * Read one workspace-relative attachment from an access-checked, identity-
   * verified file handle. Callers use the returned bytes as a frozen admission
   * snapshot and must not reopen the original path later.
   */
  async readTaskMedia(
    context: WebRequestContext,
    workspaceId: string,
    relativePath: string,
    maxBytes: number,
    expectedSizeBytes: number,
  ): Promise<BrowserTaskMediaFileSnapshot> {
    await this.assertCapability(context);
    const target = parseTarget({ workspaceId, relativePath }, this.maxPathChars);
    if (!target.relativePath) throw invalidTarget();
    const boundedMaxBytes = boundedInteger(maxBytes, 1, 1, 64 * 1024 * 1024);
    const workspace = await this.resolveWorkspace(target.workspaceId, context);
    const location = await this.resolveAuthorizedPath(workspace, target.relativePath, "file");
    const handle = await openVerifiedFile(
      location,
      workspace,
      (candidate) => this.hasReadAccess(workspace, candidate),
      (filePath, flags) => this.openReadHandle(filePath, flags),
    );

    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size <= 0) throw unavailable();
      if (before.size > boundedMaxBytes) {
        throw new WebApplicationError(
          "UNSUPPORTED_CAPABILITY",
          "This attachment exceeds the browser media size limit.",
          413,
        );
      }
      if (
        !Number.isSafeInteger(expectedSizeBytes) ||
        expectedSizeBytes <= 0 ||
        before.size !== expectedSizeBytes
      ) {
        throw new WebApplicationError(
          "INVALID_REQUEST",
          "Visual attachment size changed after it was selected.",
          400,
        );
      }

      // The descriptor reservation is based on the selected file's expected size.
      // Never let a post-stat growth turn that small reservation into a maxBytes
      // read: fill an exactly sized buffer, then probe only one sentinel byte.
      const bytes = Buffer.allocUnsafe(expectedSizeBytes);
      let offset = 0;
      while (offset < expectedSizeBytes) {
        const { bytesRead } = await handle.read(bytes, offset, expectedSizeBytes - offset, offset);
        if (bytesRead <= 0) break;
        offset += bytesRead;
      }
      if (offset !== expectedSizeBytes) throw unavailable();
      const extraByte = Buffer.allocUnsafe(1);
      const { bytesRead: extraBytesRead } = await handle.read(extraByte, 0, 1, expectedSizeBytes);
      if (extraBytesRead > 0) throw unavailable();

      const after = await handle.stat();
      if (
        !hasSameIdentity(identityOf(before), identityOf(after)) ||
        bytes.length !== expectedSizeBytes ||
        bytes.length === 0
      ) {
        throw unavailable();
      }
      return { bytes, sizeBytes: bytes.length, identity: identityOf(after) };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /**
   * Issue a short-lived, session-bound URL for inline video playback. The
   * caller receives metadata only; byte ranges are streamed from a fresh,
   * permission-checked file handle by handleMediaRequest.
   */
  async createMediaHandle(
    context: WebRequestContext,
    rawTarget: unknown,
  ): Promise<BrowserWorkspaceMediaHandle> {
    await this.assertCapability(context);
    const target = parseTarget(rawTarget, this.maxPathChars);
    if (!target.relativePath) throw invalidTarget();
    const workspace = await this.resolveWorkspace(target.workspaceId, context);
    const location = await this.resolveAuthorizedPath(workspace, target.relativePath, "file");
    const mimeType = videoMimeForPath(target.relativePath);
    if (!mimeType)
      throw new WebApplicationError(
        "UNSUPPORTED_CAPABILITY",
        "Video preview is unavailable for this file type.",
        415,
      );

    const handle = await openVerifiedFile(
      location,
      workspace,
      (candidate) => this.hasReadAccess(workspace, candidate),
      (filePath, flags) => this.openReadHandle(filePath, flags),
    );
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || !Number.isSafeInteger(stats.size) || stats.size <= 0) {
        throw unavailable();
      }
      const signature = await readFilePrefix(handle, stats.size);
      const after = await handle.stat();
      const currentPath = await fs
        .realpath(path.resolve(location.rootPath, location.relativePath))
        .catch(() => null);
      if (
        !hasSameIdentity(identityOf(stats), identityOf(after)) ||
        currentPath !== location.absolutePath ||
        !isValidVideoSignature(mimeType, signature)
      ) {
        throw unavailable();
      }

      this.pruneExpiredMediaHandles();
      if (this.mediaHandles.size >= this.maxActiveMediaHandles) {
        throw new WebApplicationError("RATE_LIMITED", "Too many active video previews.", 429, true);
      }
      const rawHandle = crypto.randomBytes(32).toString("base64url");
      const expiresAt = Date.now() + this.mediaHandleTtlMs;
      this.mediaHandles.set(hashMediaHandle(rawHandle), {
        workspaceId: target.workspaceId,
        relativePath: target.relativePath,
        identity: identityOf(after),
        mimeType,
        audience: context.audience,
        sessionId: context.sessionId as string,
        installationId: context.identity.installationId,
        profileId: context.identity.profileId,
        generation: context.identity.generation,
        expiresAt,
      });
      return {
        handle: rawHandle,
        fileName: path.posix.basename(target.relativePath),
        mimeType,
        size: after.size,
        expiresAt,
      };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /** Serve authenticated, repeatable GET/HEAD byte ranges for one video handle. */
  async handleMediaRequest(
    context: WebRequestContext,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    const url = parseRequestUrl(req.url);
    if (!url.pathname.startsWith(WEB_WORKSPACE_FILE_MEDIA_PATH_PREFIX)) return false;

    let handle: fs.FileHandle | undefined;
    try {
      if (url.search) throw invalidTarget();
      if (req.method !== "GET" && req.method !== "HEAD") {
        throw new WebApplicationError("INVALID_REQUEST", "Method not allowed.", 405);
      }
      const rawHandle = url.pathname.slice(WEB_WORKSPACE_FILE_MEDIA_PATH_PREFIX.length);
      if (!MEDIA_HANDLE_RE.test(rawHandle)) throw invalidTarget();
      await this.assertCapability(context);
      const key = hashMediaHandle(rawHandle);
      const record = this.mediaHandles.get(key);
      if (!record || record.expiresAt <= Date.now()) {
        this.mediaHandles.delete(key);
        throw unavailable();
      }
      if (
        record.audience !== context.audience ||
        record.sessionId !== context.sessionId ||
        record.installationId !== context.identity.installationId ||
        record.profileId !== context.identity.profileId ||
        record.generation !== context.identity.generation
      ) {
        throw unavailable();
      }

      const workspace = await this.resolveWorkspace(record.workspaceId, context);
      const location = await this.resolveAuthorizedPath(workspace, record.relativePath, "file");
      if (!location.fileIdentity || !hasSameIdentity(record.identity, location.fileIdentity)) {
        throw unavailable();
      }
      handle = await openVerifiedFile(
        location,
        workspace,
        (candidate) => this.hasReadAccess(workspace, candidate),
        (filePath, flags) => this.openReadHandle(filePath, flags),
      );
      const stats = await handle.stat();
      const signature = await readFilePrefix(handle, stats.size);
      const latestPath = await fs
        .realpath(path.resolve(location.rootPath, location.relativePath))
        .catch(() => null);
      if (
        !hasSameIdentity(record.identity, identityOf(stats)) ||
        latestPath !== location.absolutePath ||
        !isValidVideoSignature(record.mimeType, signature)
      ) {
        throw unavailable();
      }

      const rangeHeader = getSingleHeader(req.headers.range);
      const range =
        req.headers.range !== undefined && rangeHeader === undefined
          ? { kind: "invalid" as const }
          : parseMediaRange(rangeHeader, stats.size);
      const baseHeaders: Record<string, string | number> = {
        "Content-Type": record.mimeType,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Accept-Ranges": "bytes",
      };
      if (range.kind === "invalid") {
        res.writeHead(416, { ...baseHeaders, "Content-Range": `bytes */${stats.size}` });
        res.end();
        return true;
      }
      if (range.kind === "partial") {
        baseHeaders["Content-Range"] = `bytes ${range.start}-${range.end}/${stats.size}`;
      }
      baseHeaders["Content-Length"] = range.length;
      res.writeHead(range.kind === "partial" ? 206 : 200, baseHeaders);
      if (req.method === "HEAD" || range.length === 0) {
        res.end();
      } else {
        await pipeline(
          handle.createReadStream({ start: range.start, end: range.end, autoClose: false }),
          res,
        );
      }
      return true;
    } catch (error) {
      const webError = error instanceof WebApplicationError ? error : unavailable();
      if (!res.headersSent && !res.writableEnded) {
        closeIncompleteRequestAfterError(req, res);
        writeError(res, webError);
      } else if (!res.writableEnded) res.destroy();
      return true;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  /**
   * Handle POST /api/web/v1/workspace-files/download after the WebApplication
   * has authenticated the session, validated Origin/Host, and checked CSRF.
   * The request body is {workspaceId, relativePath}; the path is never put in
   * the URL and file bytes are streamed directly to the HTTP response.
   */
  async handleDownloadRequest(
    context: WebRequestContext,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    const url = parseRequestUrl(req.url);
    if (url.pathname !== WEB_WORKSPACE_FILE_DOWNLOAD_PATH) return false;

    try {
      if (url.search) throw invalidTarget();
      if (req.method !== "POST") {
        throw new WebApplicationError("INVALID_REQUEST", "Method not allowed.", 405);
      }
      await this.assertCapability(context);
      const target = parseTarget(
        await readJsonRequest(req, this.maxRequestBytes, this.requestBodyTimeoutMs),
        this.maxPathChars,
      );
      if (!target.relativePath) throw invalidTarget();
      const workspace = await this.resolveWorkspace(target.workspaceId, context);
      const location = await this.resolveAuthorizedPath(workspace, target.relativePath, "file");
      const handle = await openVerifiedFile(
        location,
        workspace,
        (candidate) => this.hasReadAccess(workspace, candidate),
        (filePath, flags) => this.openReadHandle(filePath, flags),
      );

      try {
        const stats = await handle.stat();
        if (!stats.isFile()) throw unavailable();
        if (stats.size > this.maxDownloadBytes) {
          throw new WebApplicationError(
            "UNSUPPORTED_CAPABILITY",
            "This file exceeds the browser download size limit.",
            413,
          );
        }
        const fileName = path.posix.basename(target.relativePath);
        res.writeHead(200, {
          "Content-Type": contentTypeFor(fileName),
          "Content-Disposition": contentDisposition(fileName),
          "Content-Length": stats.size,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
        });
        if (stats.size === 0) {
          res.end();
        } else {
          await pipeline(
            handle.createReadStream({ start: 0, end: stats.size - 1, autoClose: false }),
            res,
          );
        }
      } finally {
        await handle.close().catch(() => undefined);
      }
      return true;
    } catch (error) {
      const webError = error instanceof WebApplicationError ? error : unavailable();
      if (!res.headersSent && !res.writableEnded) {
        closeIncompleteRequestAfterError(req, res);
        writeError(res, webError);
      } else if (!res.writableEnded) res.destroy();
      return true;
    }
  }

  /**
   * Handle POST /api/web/v1/workspace-files/upload after WebApplication has
   * authenticated the session, checked Origin/Host, and validated CSRF. The
   * request body is one raw file; its workspace-relative target is carried in
   * bounded headers so file bytes never pass through JSON/base64 RPC.
   */
  async handleUploadRequest(
    context: WebRequestContext,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    const url = parseRequestUrl(req.url);
    if (url.pathname !== WEB_WORKSPACE_FILE_UPLOAD_PATH) return false;

    let location: ResolvedUploadPath | undefined;
    let workspace: Workspace | undefined;
    let tempPath: string | undefined;
    let finalIdentity: OwnedFileIdentity | undefined;
    let finalPath: string | undefined;
    let finalLinked = false;
    let success = false;
    let reservedBytes = 0;
    let handle: fs.FileHandle | undefined;
    let responseError: WebApplicationError | undefined;
    let bodyTimedOut = false;

    try {
      if (url.search) throw invalidTarget();
      if (req.method !== "POST") {
        throw new WebApplicationError("INVALID_REQUEST", "Method not allowed.", 405);
      }
      await this.assertUploadCapability(context);
      const target = parseUploadTarget(req.headers, this.maxPathChars);
      const contentLength = assertUploadHeaders(req, this.maxUploadBytes);
      workspace = await this.resolveWorkspace(target.workspaceId, context);
      location = await this.resolveAuthorizedUploadPath(workspace, target.relativePath);
      finalPath = location.absolutePath;
      await this.verifyUploadDirectory(location, workspace);
      await this.cleanupStaleUploadTemps(location, workspace);
      if (await lstatIfPresent(finalPath)) throw uploadConflict();

      const tempName = `${UPLOAD_TEMP_PREFIX}${crypto.randomUUID()}.tmp`;
      tempPath = path.join(location.parentPath, tempName);
      handle = await this.openUploadTempHandle(
        tempPath,
        fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_WRONLY |
          (fsConstants.O_NOFOLLOW || 0),
        0o600,
      );
      const initialStats = await handle.stat();
      if (!initialStats.isFile() || initialStats.size !== 0) throw unavailable();
      finalIdentity = ownedIdentityOf(initialStats);
      await this.verifyUploadDirectory(location, workspace);
      await this.verifyOwnedFile(tempPath, finalIdentity, 0);

      const digest = crypto.createHash("sha256");
      let size = 0;
      const requestIterator = req.iterator({ destroyOnReturn: false });
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeoutTimer = setTimeout(() => {
          bodyTimedOut = true;
          req.pause();
          reject(new WebApplicationError("INVALID_REQUEST", "Workspace upload timed out.", 408));
        }, this.uploadBodyTimeoutMs);
      });
      try {
        while (true) {
          const nextChunk = await Promise.race([requestIterator.next(), timeoutPromise]);
          if (nextChunk.done) break;
          if (req.aborted) throw interruptedUpload();
          const chunk = Buffer.isBuffer(nextChunk.value)
            ? nextChunk.value
            : Buffer.from(nextChunk.value);
          if (chunk.length === 0) continue;
          if (size + chunk.length > this.maxUploadBytes) throw uploadTooLarge();
          if (contentLength !== undefined && size + chunk.length > contentLength) {
            throw invalidTarget();
          }
          this.reserveUploadBytes(workspace.id, chunk.length);
          reservedBytes += chunk.length;
          size += chunk.length;
          digest.update(chunk);
          await writeAll(handle, chunk);
        }
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
      }
      if (req.aborted || !req.complete) throw interruptedUpload();
      if (contentLength !== undefined && size !== contentLength) throw interruptedUpload();

      await handle.sync();
      const completedStats = await handle.stat();
      if (
        !completedStats.isFile() ||
        completedStats.size !== size ||
        !sameOwnedIdentity(finalIdentity, ownedIdentityOf(completedStats))
      ) {
        throw unavailable();
      }
      await handle.close();
      handle = undefined;

      await this.verifyUploadDirectory(location, workspace);
      await this.verifyOwnedFile(tempPath, finalIdentity, size);
      if (await lstatIfPresent(finalPath)) throw uploadConflict();

      await this.linkUploadTemp(tempPath, finalPath);
      finalLinked = true;
      await this.verifyUploadDirectory(location, workspace);
      await this.verifyOwnedFile(finalPath, finalIdentity, size);
      await this.unlinkOwnedFile(tempPath, finalIdentity);

      const responseBody = JSON.stringify({
        apiVersion: WEB_API_VERSION,
        workspaceId: target.workspaceId,
        relativePath: target.relativePath,
        size,
        sha256: digest.digest("hex"),
      });
      res.writeHead(201, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(responseBody),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(responseBody);
      success = true;
      return true;
    } catch (error) {
      responseError =
        error instanceof WebApplicationError
          ? error
          : bodyTimedOut
            ? new WebApplicationError("INVALID_REQUEST", "Workspace upload timed out.", 408)
            : req.aborted
              ? interruptedUpload()
              : unavailable();
    } finally {
      await handle?.close().catch(() => undefined);
      if (tempPath && finalIdentity) {
        await this.unlinkOwnedFile(tempPath, finalIdentity);
      }
      if (!success && finalLinked && finalPath && finalIdentity) {
        await this.unlinkOwnedFile(finalPath, finalIdentity);
      }
      if (workspace && reservedBytes > 0) {
        this.releaseUploadBytes(workspace.id, reservedBytes);
      }
    }

    if (responseError && !res.headersSent && !res.writableEnded) {
      closeIncompleteRequestAfterError(req, res);
      writeError(res, responseError);
    } else if (responseError && !res.writableEnded) {
      res.destroy();
    }
    return true;
  }

  private get maxEntries(): number {
    return boundedInteger(this.options.maxEntries, DEFAULT_MAX_ENTRIES, 1, 500);
  }

  private get maxScannedEntries(): number {
    return boundedInteger(
      this.options.maxScannedEntries,
      DEFAULT_MAX_SCANNED_ENTRIES,
      this.maxEntries,
      10_000,
    );
  }

  private get maxPathChars(): number {
    return boundedInteger(this.options.maxPathChars, DEFAULT_MAX_PATH_CHARS, 64, 16_384);
  }

  private get maxRequestBytes(): number {
    return boundedInteger(this.options.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES, 256, 64 * 1024);
  }

  private get requestBodyTimeoutMs(): number {
    return boundedInteger(
      this.options.requestBodyTimeoutMs,
      DEFAULT_REQUEST_BODY_TIMEOUT_MS,
      1,
      MAX_REQUEST_BODY_TIMEOUT_MS,
    );
  }

  private get maxDownloadBytes(): number {
    return boundedInteger(
      this.options.maxDownloadBytes,
      DEFAULT_MAX_DOWNLOAD_BYTES,
      1,
      1024 * 1024 * 1024,
    );
  }

  private get maxUploadBytes(): number {
    return boundedInteger(
      this.options.maxUploadBytes,
      DEFAULT_MAX_UPLOAD_BYTES,
      1,
      1024 * 1024 * 1024,
    );
  }

  private get uploadBodyTimeoutMs(): number {
    return boundedInteger(
      this.options.uploadBodyTimeoutMs,
      DEFAULT_UPLOAD_BODY_TIMEOUT_MS,
      1,
      MAX_UPLOAD_BODY_TIMEOUT_MS,
    );
  }

  private get maxWorkspaceActiveUploadBytes(): number {
    return boundedInteger(
      this.options.maxWorkspaceActiveUploadBytes,
      DEFAULT_MAX_ACTIVE_UPLOAD_BYTES,
      1,
      2 * 1024 * 1024 * 1024,
    );
  }

  private get maxActiveUploadBytes(): number {
    return boundedInteger(
      this.options.maxActiveUploadBytes,
      2 * DEFAULT_MAX_ACTIVE_UPLOAD_BYTES,
      1,
      4 * 1024 * 1024 * 1024,
    );
  }

  private get mediaHandleTtlMs(): number {
    return boundedInteger(
      this.options.mediaHandleTtlMs,
      DEFAULT_MEDIA_HANDLE_TTL_MS,
      1_000,
      MAX_MEDIA_HANDLE_TTL_MS,
    );
  }

  private get maxActiveMediaHandles(): number {
    return boundedInteger(
      this.options.maxActiveMediaHandles,
      DEFAULT_MAX_ACTIVE_MEDIA_HANDLES,
      1,
      MAX_ACTIVE_MEDIA_HANDLES,
    );
  }

  revokeSession(sessionId: string): void {
    for (const [key, record] of this.mediaHandles) {
      if (record.sessionId === sessionId) this.mediaHandles.delete(key);
    }
  }

  dispose(): void {
    this.mediaHandles.clear();
  }

  private pruneExpiredMediaHandles(): void {
    const now = Date.now();
    for (const [key, record] of this.mediaHandles) {
      if (record.expiresAt <= now) this.mediaHandles.delete(key);
    }
  }

  private async assertCapability(context: WebRequestContext): Promise<void> {
    const capabilities = await this.options.getCapabilities(context);
    if (capabilities["files.read"]?.available !== true) {
      throw new WebApplicationError(
        "UNSUPPORTED_CAPABILITY",
        "Workspace file access is unavailable on this host.",
        403,
      );
    }
  }

  private async assertUploadCapability(context: WebRequestContext): Promise<void> {
    const capabilities = await this.options.getCapabilities(context);
    if (capabilities["files.upload"]?.available !== true) {
      throw new WebApplicationError(
        "UNSUPPORTED_CAPABILITY",
        "Workspace file uploads are unavailable on this host.",
        403,
      );
    }
  }

  private async resolveWorkspace(
    workspaceId: string,
    context: WebRequestContext,
  ): Promise<Workspace> {
    if (!context.sessionId || !context.identity.profileId || isTempWorkspaceId(workspaceId)) {
      throw unavailable();
    }
    let workspace: Workspace | null | undefined;
    try {
      workspace = await this.options.resolveWorkspace(workspaceId, context);
    } catch {
      throw unavailable();
    }
    if (
      !workspace ||
      workspace.id !== workspaceId ||
      workspace.isTemp === true ||
      isTempWorkspaceId(workspace.id) ||
      !workspace.path ||
      !workspace.permissions
    ) {
      throw unavailable();
    }
    return workspace;
  }

  private async resolveAuthorizedPath(
    workspace: Workspace,
    relativePath: string,
    expectedType: "directory" | "file",
  ): Promise<ResolvedBrowserPath> {
    if (workspace.permissions.read !== true) throw unavailable();
    let rootPath: string;
    try {
      rootPath = await fs.realpath(workspace.path);
    } catch {
      throw unavailable();
    }
    const absolutePath = path.resolve(rootPath, ...relativePath.split("/").filter(Boolean));
    if (!isWithin(rootPath, absolutePath)) throw invalidTarget();

    let canonicalPath: string;
    try {
      canonicalPath = await fs.realpath(absolutePath);
    } catch {
      throw unavailable();
    }
    if (!isWithin(rootPath, canonicalPath) || !this.hasReadAccess(workspace, canonicalPath)) {
      throw unavailable();
    }
    if (isReservedUploadTempPath(rootPath, canonicalPath)) throw unavailable();
    const stats = await fs.stat(canonicalPath).catch(() => null);
    if (!stats || (expectedType === "directory" ? !stats.isDirectory() : !stats.isFile())) {
      throw unavailable();
    }
    return {
      rootPath,
      absolutePath: canonicalPath,
      relativePath,
      fileIdentity: expectedType === "file" ? identityOf(stats) : undefined,
    };
  }

  private hasReadAccess(workspace: Workspace, absolutePath: string): boolean {
    try {
      return (
        evaluateWorkspaceFilesystemAccess(workspace, absolutePath, "read").decision === "allow"
      );
    } catch {
      return false;
    }
  }

  private hasWriteAccess(workspace: Workspace, absolutePath: string): boolean {
    if (workspace.permissions.write !== true) return false;
    try {
      return (
        evaluateWorkspaceFilesystemAccess(workspace, absolutePath, "write").decision === "allow"
      );
    } catch {
      return false;
    }
  }

  private async resolveAuthorizedUploadPath(
    workspace: Workspace,
    relativePath: string,
  ): Promise<ResolvedUploadPath> {
    if (!relativePath || !workspace.permissions.write) throw unavailable();
    let rootPath: string;
    try {
      rootPath = await fs.realpath(workspace.path);
    } catch {
      throw unavailable();
    }
    const rootStats = await fs.lstat(rootPath).catch(() => null);
    if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) throw unavailable();
    const directoryIdentities: DirectoryIdentity[] = [
      { path: rootPath, lexicalPath: rootPath, dev: rootStats.dev, ino: rootStats.ino },
    ];

    const segments = relativePath.split("/");
    const parentSegments = segments.slice(0, -1);
    let parentPath = rootPath;
    for (const segment of parentSegments) {
      const candidatePath = path.join(parentPath, segment);
      const stats = await fs.lstat(candidatePath).catch(() => null);
      if (!stats?.isDirectory() || stats.isSymbolicLink()) throw unavailable();
      const canonicalPath = await fs.realpath(candidatePath).catch(() => null);
      if (!canonicalPath || !isWithin(rootPath, canonicalPath)) throw unavailable();
      const latestStats = await fs.lstat(candidatePath).catch(() => null);
      if (
        !latestStats?.isDirectory() ||
        latestStats.isSymbolicLink() ||
        latestStats.dev !== stats.dev ||
        latestStats.ino !== stats.ino
      ) {
        throw unavailable();
      }
      directoryIdentities.push({
        path: canonicalPath,
        lexicalPath: candidatePath,
        dev: stats.dev,
        ino: stats.ino,
      });
      parentPath = canonicalPath;
    }

    const absolutePath = path.join(parentPath, segments[segments.length - 1]);
    if (!isWithin(rootPath, absolutePath) || !this.hasWriteAccess(workspace, absolutePath)) {
      throw unavailable();
    }
    return { rootPath, parentPath, absolutePath, directoryIdentities };
  }

  private async verifyUploadDirectory(
    location: ResolvedUploadPath,
    workspace: Workspace,
  ): Promise<void> {
    const latestRootPath = await fs.realpath(workspace.path).catch(() => null);
    if (latestRootPath !== location.rootPath) throw unavailable();
    for (const expected of location.directoryIdentities) {
      const lexicalStats = await fs.lstat(expected.lexicalPath).catch(() => null);
      const stats = await fs.lstat(expected.path).catch(() => null);
      const latestCanonicalPath = await fs.realpath(expected.path).catch(() => null);
      if (
        !lexicalStats?.isDirectory() ||
        lexicalStats.isSymbolicLink() ||
        lexicalStats.dev !== expected.dev ||
        lexicalStats.ino !== expected.ino ||
        !stats?.isDirectory() ||
        stats.isSymbolicLink() ||
        stats.dev !== expected.dev ||
        stats.ino !== expected.ino ||
        latestCanonicalPath !== expected.path
      ) {
        throw unavailable();
      }
    }
    if (!this.hasWriteAccess(workspace, location.absolutePath)) throw unavailable();
  }

  private async cleanupStaleUploadTemps(
    location: ResolvedUploadPath,
    workspace: Workspace,
  ): Promise<void> {
    await this.verifyUploadDirectory(location, workspace);
    const directory = await fs.opendir(location.parentPath, { bufferSize: 16 }).catch(() => {
      throw unavailable();
    });
    let scanned = 0;
    try {
      while (scanned < MAX_STALE_UPLOAD_TEMP_SCAN) {
        const entry = await directory.read().catch(() => {
          throw unavailable();
        });
        if (!entry) break;
        scanned += 1;
        if (!entry.isFile() || !UPLOAD_TEMP_NAME_PATTERN.test(entry.name)) continue;

        await this.verifyUploadDirectory(location, workspace);
        const tempPath = path.join(location.parentPath, entry.name);
        const stats = await lstatIfPresent(tempPath);
        if (
          !stats?.isFile() ||
          stats.isSymbolicLink() ||
          Date.now() - stats.mtimeMs < STALE_UPLOAD_TEMP_AGE_MS
        ) {
          continue;
        }
        await this.verifyUploadDirectory(location, workspace);
        const currentStats = await lstatIfPresent(tempPath);
        if (
          !currentStats?.isFile() ||
          currentStats.isSymbolicLink() ||
          !sameOwnedIdentity(ownedIdentityOf(stats), ownedIdentityOf(currentStats)) ||
          currentStats.mtimeMs !== stats.mtimeMs ||
          Date.now() - currentStats.mtimeMs < STALE_UPLOAD_TEMP_AGE_MS
        ) {
          continue;
        }
        await this.unlinkOwnedFile(tempPath, ownedIdentityOf(currentStats));
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
  }

  private async verifyOwnedFile(
    filePath: string,
    expectedIdentity: OwnedFileIdentity,
    expectedSize: number,
  ): Promise<void> {
    const stats = await fs.lstat(filePath).catch(() => null);
    if (
      !stats?.isFile() ||
      stats.isSymbolicLink() ||
      stats.size !== expectedSize ||
      !sameOwnedIdentity(expectedIdentity, ownedIdentityOf(stats))
    ) {
      throw unavailable();
    }
  }

  private reserveUploadBytes(workspaceId: string, bytes: number): void {
    const workspaceBytes = this.activeUploadBytesByWorkspace.get(workspaceId) || 0;
    if (
      this.activeUploadBytes + bytes > this.maxActiveUploadBytes ||
      workspaceBytes + bytes > this.maxWorkspaceActiveUploadBytes
    ) {
      throw uploadQuotaExceeded();
    }
    this.activeUploadBytes += bytes;
    this.activeUploadBytesByWorkspace.set(workspaceId, workspaceBytes + bytes);
  }

  private releaseUploadBytes(workspaceId: string, bytes: number): void {
    this.activeUploadBytes = Math.max(0, this.activeUploadBytes - bytes);
    const workspaceBytes = Math.max(
      0,
      (this.activeUploadBytesByWorkspace.get(workspaceId) || 0) - bytes,
    );
    if (workspaceBytes === 0) this.activeUploadBytesByWorkspace.delete(workspaceId);
    else this.activeUploadBytesByWorkspace.set(workspaceId, workspaceBytes);
  }

  /** @internal Overridable so race tests can replace the target directory at the open boundary. */
  protected openUploadTempHandle(
    filePath: string,
    flags: number,
    mode: number,
  ): Promise<fs.FileHandle> {
    return fs.open(filePath, flags, mode);
  }

  /** @internal Overridable so race tests can replace the target directory at commit. */
  protected linkUploadTemp(tempPath: string, finalPath: string): Promise<void> {
    return fs.link(tempPath, finalPath);
  }

  private async unlinkOwnedFile(filePath: string, identity: OwnedFileIdentity): Promise<void> {
    const stats = await fs.lstat(filePath).catch(() => null);
    if (
      !stats?.isFile() ||
      stats.isSymbolicLink() ||
      !sameOwnedIdentity(identity, ownedIdentityOf(stats))
    ) {
      return;
    }
    await fs.unlink(filePath).catch(() => undefined);
  }

  /** @internal Overridable for host-specific safe-open behavior and race tests. */
  protected openReadHandle(filePath: string, flags: number): Promise<fs.FileHandle> {
    return fs.open(filePath, flags);
  }
}

/** RPC surface for metadata only; file content is served by handleDownloadRequest. */
export function createBrowserWorkspaceFileMethods(
  files: BrowserWorkspaceFiles,
): Record<string, WebRpcMethod> {
  return {
    [FILE_LIST_METHOD]: {
      capability: "files.read",
      validateParams: (value) => parseTarget(value),
      handler: (context, params) => files.list(context, params),
    },
    "workspace.file.media.create": {
      capability: "files.read",
      validateParams: (value) => {
        const target = parseTarget(value);
        if (!target.relativePath) throw invalidTarget();
        return target;
      },
      handler: (context, params) => files.createMediaHandle(context, params),
    },
  };
}

interface ResolvedBrowserPath {
  rootPath: string;
  absolutePath: string;
  relativePath: string;
  fileIdentity?: FileIdentity;
}

interface ResolvedUploadPath {
  rootPath: string;
  parentPath: string;
  absolutePath: string;
  directoryIdentities: DirectoryIdentity[];
}

interface DirectoryIdentity {
  path: string;
  lexicalPath: string;
  dev: number;
  ino: number;
}

interface OwnedFileIdentity {
  dev: number;
  ino: number;
}

interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

type ParsedMediaRange =
  | { kind: "full"; start: 0; end: number; length: number }
  | { kind: "partial"; start: number; end: number; length: number }
  | { kind: "invalid" };

interface MediaHandleRecord {
  workspaceId: string;
  relativePath: string;
  identity: FileIdentity;
  mimeType: string;
  audience: string;
  sessionId: string;
  installationId: string;
  profileId: string;
  generation: string;
  expiresAt: number;
}

function parseTarget(
  value: unknown,
  maxPathChars = DEFAULT_MAX_PATH_CHARS,
): BrowserWorkspaceFileTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidTarget();
  const record = value as Record<string, unknown>;
  if (
    typeof record.workspaceId !== "string" ||
    record.workspaceId.length < 1 ||
    record.workspaceId.length > 128 ||
    typeof record.relativePath !== "string"
  ) {
    throw invalidTarget();
  }
  const relativePath = normalizeRelativePath(record.relativePath, maxPathChars);
  if (relativePath.split("/").some((segment) => segment.startsWith(UPLOAD_TEMP_PREFIX))) {
    throw invalidTarget();
  }
  return { workspaceId: record.workspaceId, relativePath };
}

function parseUploadTarget(
  headers: IncomingMessage["headers"],
  maxPathChars: number,
): BrowserWorkspaceFileTarget {
  const workspaceId = getSingleHeader(headers["x-cowork-workspace-id"]);
  const encodedPath = getSingleHeader(headers["x-cowork-relative-path"]);
  if (
    !workspaceId ||
    workspaceId.length > 128 ||
    !encodedPath ||
    encodedPath.length > maxPathChars * 6
  ) {
    throw invalidTarget();
  }
  let relativePath: string;
  try {
    relativePath = decodeURIComponent(encodedPath);
  } catch {
    throw invalidTarget();
  }
  const target = parseTarget({ workspaceId, relativePath }, maxPathChars);
  if (!target.relativePath) throw invalidTarget();
  return target;
}

function assertUploadHeaders(req: IncomingMessage, maxBytes: number): number | undefined {
  const contentType = getSingleHeader(req.headers["content-type"]);
  if (!contentType || !/^application\/octet-stream(?:\s*;|$)/i.test(contentType)) {
    throw new WebApplicationError(
      "INVALID_REQUEST",
      "Content-Type must be application/octet-stream.",
      415,
    );
  }
  const contentEncoding = getSingleHeader(req.headers["content-encoding"]);
  if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
    throw new WebApplicationError(
      "INVALID_REQUEST",
      "Compressed workspace uploads are not supported.",
      415,
    );
  }
  if (getSingleHeader(req.headers["if-none-match"]) !== "*") {
    throw new WebApplicationError(
      "CONFLICT",
      "Workspace uploads require the If-None-Match: * precondition.",
      428,
    );
  }
  return parseContentLength(req, maxBytes);
}

function parseContentLength(req: IncomingMessage, maxBytes: number): number | undefined {
  const value = getSingleHeader(req.headers["content-length"]);
  if (value === undefined) return undefined;
  if (!/^(0|[1-9]\d*)$/.test(value)) throw invalidTarget();
  const size = Number(value);
  if (!Number.isSafeInteger(size)) throw invalidTarget();
  if (size > maxBytes) throw uploadTooLarge();
  return size;
}

async function writeAll(handle: fs.FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const result = await handle.write(chunk, offset, chunk.length - offset, null);
    if (result.bytesWritten <= 0) throw unavailable();
    offset += result.bytesWritten;
  }
}

async function lstatIfPresent(filePath: string): Promise<Stats | null> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw unavailable();
  }
}

function ownedIdentityOf(stats: Stats): OwnedFileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameOwnedIdentity(
  expected: OwnedFileIdentity | undefined,
  actual: OwnedFileIdentity,
): boolean {
  return Boolean(
    expected &&
    expected.dev !== 0 &&
    expected.ino !== 0 &&
    actual.dev !== 0 &&
    actual.ino !== 0 &&
    expected.dev === actual.dev &&
    expected.ino === actual.ino,
  );
}

function normalizeRelativePath(value: string, maxPathChars: number): string {
  if (value.length > maxPathChars || value.includes("\0") || value.includes("\\")) {
    throw invalidTarget();
  }
  if (value === "" || value === ".") return "";
  if (
    value.startsWith("/") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw invalidTarget();
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) => !segment || segment === "." || segment === ".." || /^[A-Za-z]:/.test(segment),
    )
  ) {
    throw invalidTarget();
  }
  return segments.join("/");
}

function joinRelativePath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isReservedUploadTempPath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  return relative.split(path.sep).some((segment) => segment.startsWith(UPLOAD_TEMP_PREFIX));
}

async function openVerifiedFile(
  location: ResolvedBrowserPath,
  workspace: Workspace,
  hasReadAccess: (absolutePath: string) => boolean,
  openReadHandle: (filePath: string, flags: number) => Promise<fs.FileHandle>,
): Promise<fs.FileHandle> {
  let currentCanonicalPath: string;
  try {
    currentCanonicalPath = await fs.realpath(
      path.resolve(location.rootPath, location.relativePath),
    );
  } catch {
    throw unavailable();
  }
  if (
    currentCanonicalPath !== location.absolutePath ||
    !isWithin(location.rootPath, currentCanonicalPath) ||
    isReservedUploadTempPath(location.rootPath, currentCanonicalPath) ||
    !hasReadAccess(currentCanonicalPath)
  ) {
    throw unavailable();
  }

  const noFollow = fsConstants.O_NOFOLLOW || 0;
  let handle: fs.FileHandle;
  try {
    handle = await openReadHandle(currentCanonicalPath, fsConstants.O_RDONLY | noFollow);
  } catch {
    throw unavailable();
  }
  try {
    const stats = await handle.stat();
    const latestCanonicalPath = await fs
      .realpath(path.resolve(location.rootPath, location.relativePath))
      .catch(() => null);
    const latestRootPath = await fs.realpath(workspace.path).catch(() => null);
    if (
      !stats.isFile() ||
      !hasSameIdentity(location.fileIdentity, identityOf(stats)) ||
      latestCanonicalPath !== currentCanonicalPath ||
      latestRootPath !== location.rootPath ||
      !isWithin(location.rootPath, latestCanonicalPath) ||
      isReservedUploadTempPath(location.rootPath, latestCanonicalPath) ||
      !hasReadAccess(latestCanonicalPath)
    ) {
      throw unavailable();
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (error instanceof WebApplicationError) throw error;
    throw unavailable();
  }
}

function identityOf(stats: Stats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs };
}

function hasSameIdentity(expected: FileIdentity | undefined, actual: FileIdentity): boolean {
  if (
    !expected ||
    expected.dev === 0 ||
    expected.ino === 0 ||
    actual.dev === 0 ||
    actual.ino === 0
  ) {
    return false;
  }
  return (
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.size === actual.size &&
    expected.mtimeMs === actual.mtimeMs
  );
}

function hashMediaHandle(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function videoMimeForPath(relativePath: string): string | undefined {
  return VIDEO_MIME_BY_EXTENSION[path.posix.extname(relativePath).toLowerCase()];
}

async function readFilePrefix(handle: fs.FileHandle, size: number): Promise<Buffer> {
  const prefix = Buffer.alloc(Math.min(16, size));
  let offset = 0;
  while (offset < prefix.length) {
    const { bytesRead } = await handle.read(prefix, offset, prefix.length - offset, offset);
    if (bytesRead <= 0) break;
    offset += bytesRead;
  }
  return prefix.subarray(0, offset);
}

function isValidVideoSignature(mimeType: string, prefix: Buffer): boolean {
  if (mimeType === "video/webm") {
    return (
      prefix.length >= 4 && prefix.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
    );
  }
  return (
    (mimeType === "video/mp4" || mimeType === "video/quicktime") &&
    prefix.length >= 8 &&
    prefix.subarray(4, 8).toString("ascii") === "ftyp"
  );
}

function parseMediaRange(value: string | undefined, size: number): ParsedMediaRange {
  if (!Number.isSafeInteger(size) || size < 0) return { kind: "invalid" };
  if (value === undefined) {
    return { kind: "full", start: 0, end: Math.max(0, size - 1), length: size };
  }
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size === 0) return { kind: "invalid" };

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { kind: "invalid" };
    const start = Math.max(0, size - suffixLength);
    return { kind: "partial", start, end: size - 1, length: size - start };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= size
  ) {
    return { kind: "invalid" };
  }
  const end = Math.min(requestedEnd, size - 1);
  return { kind: "partial", start, end, length: end - start + 1 };
}

async function readJsonRequest(
  req: IncomingMessage,
  maxBytes: number,
  timeoutMs: number,
): Promise<unknown> {
  const contentType = getSingleHeader(req.headers["content-type"]);
  if (!contentType || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new WebApplicationError("INVALID_REQUEST", "Content-Type must be application/json.", 415);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const removeErrorListenerOnClose = () => {
      req.off("error", onError);
      req.off("close", removeErrorListenerOnClose);
    };
    const cleanup = (retainErrorListenerUntilClose = false) => {
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("aborted", onAborted);
      if (retainErrorListenerUntilClose && !req.complete) {
        req.once("close", removeErrorListenerOnClose);
      } else {
        req.off("error", onError);
      }
    };
    const finish = (error?: Error, retainErrorListenerUntilClose = false) => {
      if (settled) return;
      settled = true;
      cleanup(retainErrorListenerUntilClose);
      if (error) reject(error);
      else resolve();
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        finish(new WebApplicationError("INVALID_REQUEST", "Request body is too large.", 413), true);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onError = (error: Error) => finish(error);
    const onAborted = () =>
      finish(new WebApplicationError("INVALID_REQUEST", "Request interrupted.", 400), true);
    const timer = setTimeout(() => {
      req.pause();
      finish(new WebApplicationError("INVALID_REQUEST", "Request body timed out.", 408), true);
    }, timeoutMs);
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
  });
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw invalidTarget();
  }
}

function parseRequestUrl(value: string | undefined): URL {
  try {
    return new URL(value || "/", "http://browser-files.invalid");
  } catch {
    return new URL("/invalid", "http://browser-files.invalid");
  }
}

function getSingleHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value) && value.length === 1) return value[0].trim();
  return undefined;
}

function contentTypeFor(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  const types: Record<string, string> = {
    ".csv": "text/csv; charset=utf-8",
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json; charset=utf-8",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".webp": "image/webp",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  return types[extension] || "application/octet-stream";
}

function contentDisposition(fileName: string): string {
  const fallback = fileName
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\;]/g, "_")
    .slice(0, 160);
  const encoded = encodeURIComponent(fileName).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback || "download"}"; filename*=UTF-8''${encoded}`;
}

function writeError(res: ServerResponse, error: WebApplicationError): void {
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify({
    apiVersion: WEB_API_VERSION,
    error: { code: error.code, message: error.message, retryable: error.retryable },
  });
  res.writeHead(error.statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function closeIncompleteRequestAfterError(req: IncomingMessage, res: ServerResponse): void {
  if (req.complete || req.destroyed || res.headersSent || res.writableEnded) return;
  req.pause();
  res.shouldKeepAlive = false;
  res.setHeader("Connection", "close");
  res.once("finish", () => req.destroy());
}

function unavailable(): WebApplicationError {
  return new WebApplicationError("UNSUPPORTED_CAPABILITY", "Workspace file is unavailable.", 404);
}

function invalidTarget(): WebApplicationError {
  return new WebApplicationError("INVALID_REQUEST", "Invalid workspace file request.", 400);
}

function uploadConflict(): WebApplicationError {
  return new WebApplicationError("CONFLICT", "A file already exists at this workspace path.", 409);
}

function uploadTooLarge(): WebApplicationError {
  return new WebApplicationError(
    "INVALID_REQUEST",
    "This file exceeds the browser upload size limit.",
    413,
  );
}

function uploadQuotaExceeded(): WebApplicationError {
  return new WebApplicationError(
    "RATE_LIMITED",
    "Workspace upload capacity is temporarily full. Try again after another upload finishes.",
    429,
    true,
  );
}

function interruptedUpload(): WebApplicationError {
  return new WebApplicationError("INVALID_REQUEST", "Workspace upload was interrupted.", 400);
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  return Number.isInteger(value) && value! >= min && value! <= max ? value! : fallback;
}
