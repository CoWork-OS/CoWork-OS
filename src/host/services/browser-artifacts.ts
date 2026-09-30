import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Artifact, ArtifactRevision, Task, Workspace } from "../../shared/types";
import { isTempWorkspaceId } from "../../shared/types";
import type { HostCapabilities } from "../../shared/host-api/contracts";
import { WEB_API_VERSION, WEB_ARTIFACT_DOWNLOAD_PATH } from "../../shared/host-api/contracts";
import { evaluateWorkspaceFilesystemAccess } from "../../electron/security/access-profile-paths";
import {
  WebApplicationError,
  type WebRequestContext,
  type WebRpcMethod,
} from "../web/WebApplication";

export { WEB_ARTIFACT_DOWNLOAD_PATH as BROWSER_ARTIFACT_DOWNLOAD_PATH };

const LIST_METHOD = "task.artifacts.list";
const CREATE_HANDLE_METHOD = "artifact.download.create";
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_OFFSET = 100_000;
const DEFAULT_HANDLE_TTL_MS = 60_000;
const MAX_HANDLE_TTL_MS = 5 * 60_000;
const MAX_ACTIVE_HANDLES = 1_024;
const DEFAULT_MAX_REQUEST_BYTES = 4 * 1024;
const DEFAULT_REQUEST_BODY_TIMEOUT_MS = 15_000;
const MAX_REQUEST_BODY_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/i;
const HANDLE_RE = /^[A-Za-z0-9_-]{43}$/;

export type BrowserArtifactSelector = { artifactId: string } | { artifactRevisionId: string };

export interface BrowserArtifactResource {
  artifact: Artifact;
  task: Pick<Task, "id" | "workspaceId">;
  /** Must be the current effective workspace permissions for this profile. */
  workspace: Workspace;
  /** Required when resolving an artifactRevisionId selector. */
  revision?: Pick<
    ArtifactRevision,
    "id" | "artifactId" | "taskId" | "path" | "mimeType" | "sha256" | "size" | "status"
  >;
}

export interface BrowserArtifactTaskPage {
  task: Pick<Task, "id" | "workspaceId">;
  /** Must be the current effective workspace permissions for this profile. */
  workspace: Workspace;
  /** At most `limit + 1` records, ordered newest first. */
  artifacts: Artifact[];
  hasMore: boolean;
}

export interface BrowserArtifactListRequest {
  taskId: string;
  workspaceId: string;
  limit: number;
  offset: number;
}

export interface BrowserArtifactEntry {
  artifactId: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: number;
}

export interface BrowserArtifactListResult {
  taskId: string;
  workspaceId: string;
  artifacts: BrowserArtifactEntry[];
  limit: number;
  offset: number;
  nextOffset: number;
  hasMore: boolean;
}

export interface BrowserArtifactHandleResult {
  handle: string;
  artifactId: string;
  fileName: string;
  mimeType: string;
  size: number;
  expiresAt: number;
}

export interface BrowserArtifactsOptions {
  getCapabilities: (
    context: WebRequestContext,
  ) => Pick<HostCapabilities, "artifacts.read"> | Promise<Pick<HostCapabilities, "artifacts.read">>;
  /** Resolve the canonical artifact row and its task/profile scope on every use. */
  resolveArtifact: (
    selector: BrowserArtifactSelector,
    context: WebRequestContext,
  ) =>
    | BrowserArtifactResource
    | null
    | undefined
    | Promise<BrowserArtifactResource | null | undefined>;
  /** Resolve one authorized task page; return null for an unknown or inaccessible task. */
  listTaskArtifacts: (
    request: BrowserArtifactListRequest,
    context: WebRequestContext,
  ) =>
    | BrowserArtifactTaskPage
    | null
    | undefined
    | Promise<BrowserArtifactTaskPage | null | undefined>;
  maxPageSize?: number;
  now?: () => number;
  handleTtlMs?: number;
  maxActiveHandles?: number;
  maxRequestBytes?: number;
  /** Absolute deadline for JSON request bodies. Values are capped at one minute. */
  requestBodyTimeoutMs?: number;
  maxArtifactBytes?: number;
  maxResponseBytes?: number;
}

interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface ArtifactFingerprint {
  artifactId: string;
  taskId: string;
  workspaceId: string;
  path: string;
  mimeType: string;
  sha256: string;
  size: number;
  createdAt: number;
  revisionId?: string;
}

interface HandleRecord {
  selector: BrowserArtifactSelector;
  fingerprint: ArtifactFingerprint;
  identity: FileIdentity;
  audience: string;
  sessionId: string;
  installationId: string;
  profileId: string;
  generation: string;
  expiresAt: number;
}

interface ResolvedPath {
  rootPath: string;
  canonicalPath: string;
  stats: Stats;
}

type ParsedRange =
  | { kind: "full"; start: 0; end: number; length: number }
  | { kind: "partial"; start: number; end: number; length: number }
  | { kind: "invalid" };

/**
 * Read-only browser artifact access. Artifact contents stay on the streaming
 * HTTP route; generic RPC only returns metadata and short-lived handles.
 */
export class BrowserArtifacts {
  private readonly handles = new Map<string, HandleRecord>();

  constructor(private readonly options: BrowserArtifactsOptions) {}

  async listTaskArtifacts(
    context: WebRequestContext,
    rawRequest: unknown,
  ): Promise<BrowserArtifactListResult> {
    await this.assertCapability(context);
    requireSession(context);
    const request = parseListRequest(rawRequest, this.maxPageSize);
    let page: BrowserArtifactTaskPage | null | undefined;
    try {
      page = await this.options.listTaskArtifacts(request, context);
    } catch {
      throw unavailable();
    }
    if (
      !page ||
      page.task.id !== request.taskId ||
      page.task.workspaceId !== request.workspaceId ||
      page.workspace.id !== request.workspaceId ||
      page.workspace.permissions?.read !== true ||
      page.workspace.isTemp === true ||
      isTempWorkspaceId(page.workspace.id) ||
      !Array.isArray(page.artifacts) ||
      page.artifacts.length > request.limit + 1 ||
      typeof page.hasMore !== "boolean"
    ) {
      throw unavailable();
    }

    const entries: BrowserArtifactEntry[] = [];
    for (const artifact of page.artifacts) {
      const resource: BrowserArtifactResource = {
        artifact,
        task: page.task,
        workspace: page.workspace,
      };
      try {
        this.assertResource(resource);
        const location = await this.resolveReadablePath(resource);
        if (
          !location.stats.isFile() ||
          location.stats.size !== artifact.size ||
          artifact.size > this.maxArtifactBytes
        ) {
          continue;
        }
        entries.push({
          artifactId: artifact.id,
          name: safeFileName(artifact.path),
          mimeType: safeMimeType(artifact.mimeType),
          size: artifact.size,
          createdAt: artifact.createdAt,
        });
      } catch {
        // Missing, stale, or profile-inaccessible artifacts are omitted.
      }
    }

    const hasMore = page.hasMore || entries.length > request.limit;
    return {
      taskId: request.taskId,
      workspaceId: request.workspaceId,
      artifacts: entries.slice(0, request.limit),
      limit: request.limit,
      offset: request.offset,
      nextOffset: request.offset + Math.min(request.limit, page.artifacts.length),
      hasMore,
    };
  }

  async createDownloadHandle(
    context: WebRequestContext,
    rawSelector: unknown,
  ): Promise<BrowserArtifactHandleResult> {
    await this.assertCapability(context);
    requireSession(context);
    const selector = parseSelector(rawSelector);
    const resource = await this.resolveResource(selector, context);
    this.assertResource(resource, selector);

    const handle = await this.openVerifiedResource(resource);
    let identity: FileIdentity;
    try {
      const stats = await handle.stat();
      const actualHash = await hashHandle(handle, stats.size);
      const afterHash = await handle.stat();
      await this.assertPathStillMatches(resource, identityOf(afterHash));
      if (
        !sameIdentity(identityOf(stats), identityOf(afterHash)) ||
        actualHash !== resource.artifact.sha256.toLowerCase()
      ) {
        throw unavailable();
      }
      identity = identityOf(afterHash);
    } finally {
      await handle.close().catch(() => undefined);
    }

    this.pruneExpiredHandles();
    if (this.handles.size >= this.maxActiveHandles) {
      throw new WebApplicationError(
        "RATE_LIMITED",
        "Too many pending artifact downloads.",
        429,
        true,
      );
    }

    const rawHandle = randomBytes(32).toString("base64url");
    const key = hashToken(rawHandle);
    const expiresAt = this.now() + this.handleTtlMs;
    this.handles.set(key, {
      selector,
      fingerprint: fingerprint(resource),
      identity,
      audience: context.audience,
      sessionId: context.sessionId,
      installationId: context.identity.installationId,
      profileId: context.identity.profileId,
      generation: context.identity.generation,
      expiresAt,
    });

    return {
      handle: rawHandle,
      artifactId: resource.artifact.id,
      fileName: safeFileName(resource.artifact.path),
      mimeType: safeMimeType(resource.artifact.mimeType),
      size: resource.artifact.size,
      expiresAt,
    };
  }

  /**
   * Handle POST /api/web/v1/artifacts/download after WebApplication has
   * authenticated the cookie and checked exact Origin/Host and CSRF.
   * The request body carries the one-use handle; Range stays in its header.
   */
  async handleDownloadRequest(
    context: WebRequestContext,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    const url = parseRequestUrl(req.url);
    if (url.pathname !== WEB_ARTIFACT_DOWNLOAD_PATH) return false;

    let handle: fs.FileHandle | undefined;
    try {
      if (url.search) throw invalidRequest();
      if (req.method !== "POST") {
        throw new WebApplicationError("INVALID_REQUEST", "Method not allowed.", 405);
      }
      await this.assertCapability(context);
      const request = parseRedeemRequest(
        await readJsonRequest(req, this.maxRequestBytes, this.requestBodyTimeoutMs),
      );
      const record = this.consumeHandle(request.handle, context);
      const resource = await this.resolveResource(record.selector, context);
      this.assertResource(resource, record.selector);
      if (!sameFingerprint(record.fingerprint, fingerprint(resource))) throw unavailable();

      handle = await this.openVerifiedResource(resource, record.identity);
      const stats = await handle.stat();
      const rawRangeHeader = req.headers.range;
      const rangeHeader =
        rawRangeHeader === undefined
          ? undefined
          : typeof rawRangeHeader === "string"
            ? rawRangeHeader.trim()
            : "";
      const range = parseRange(rangeHeader, stats.size);
      if (range.kind === "invalid") {
        writeRangeError(res, stats.size);
        return true;
      }
      if (range.length > this.maxResponseBytes) {
        throw new WebApplicationError(
          "UNSUPPORTED_CAPABILITY",
          "This artifact range exceeds the browser download limit.",
          413,
        );
      }

      const headers: Record<string, string | number> = {
        "Content-Type": safeMimeType(resource.artifact.mimeType),
        "Content-Disposition": contentDisposition(safeFileName(resource.artifact.path)),
        "Content-Length": range.length,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Accept-Ranges": "bytes",
        ETag: `"${resource.artifact.sha256.toLowerCase()}"`,
      };
      if (range.kind === "partial") {
        headers["Content-Range"] = `bytes ${range.start}-${range.end}/${stats.size}`;
      }
      res.writeHead(range.kind === "partial" ? 206 : 200, headers);
      if (range.length === 0) {
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

  /** Remove outstanding handles when WebApplication revokes its cookie session. */
  revokeSession(sessionId: string): void {
    for (const [key, record] of this.handles) {
      if (record.sessionId === sessionId) this.handles.delete(key);
    }
  }

  /** Clear ephemeral handle state during host shutdown. */
  dispose(): void {
    this.handles.clear();
  }

  private get now(): () => number {
    return this.options.now || Date.now;
  }

  private get maxPageSize(): number {
    return boundedInteger(this.options.maxPageSize, MAX_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  }

  private get handleTtlMs(): number {
    return boundedInteger(
      this.options.handleTtlMs,
      DEFAULT_HANDLE_TTL_MS,
      1_000,
      MAX_HANDLE_TTL_MS,
    );
  }

  private get maxActiveHandles(): number {
    return boundedInteger(this.options.maxActiveHandles, MAX_ACTIVE_HANDLES, 1, 8_192);
  }

  private get maxRequestBytes(): number {
    return boundedInteger(this.options.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES, 256, 16 * 1024);
  }

  private get requestBodyTimeoutMs(): number {
    return boundedInteger(
      this.options.requestBodyTimeoutMs,
      DEFAULT_REQUEST_BODY_TIMEOUT_MS,
      1,
      MAX_REQUEST_BODY_TIMEOUT_MS,
    );
  }

  private get maxArtifactBytes(): number {
    return boundedInteger(
      this.options.maxArtifactBytes,
      DEFAULT_MAX_ARTIFACT_BYTES,
      1,
      1024 * 1024 * 1024,
    );
  }

  private get maxResponseBytes(): number {
    return boundedInteger(
      this.options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      1,
      256 * 1024 * 1024,
    );
  }

  private async assertCapability(context: WebRequestContext): Promise<void> {
    requireSession(context);
    try {
      const capabilities = await this.options.getCapabilities(context);
      if (capabilities["artifacts.read"]?.available === true) return;
    } catch {
      // Capability lookup errors fail closed without leaking host details.
    }
    throw new WebApplicationError(
      "UNSUPPORTED_CAPABILITY",
      "Artifact downloads are unavailable on this host.",
      403,
    );
  }

  private async resolveResource(
    selector: BrowserArtifactSelector,
    context: WebRequestContext,
  ): Promise<BrowserArtifactResource> {
    let resource: BrowserArtifactResource | null | undefined;
    try {
      resource = await this.options.resolveArtifact(selector, context);
    } catch {
      throw unavailable();
    }
    if (!resource) throw unavailable();
    return resource;
  }

  private assertResource(
    resource: BrowserArtifactResource,
    selector?: BrowserArtifactSelector,
  ): void {
    const { artifact, task, workspace, revision } = resource;
    if (
      !artifact ||
      !task ||
      !workspace ||
      !isSafeId(artifact.id) ||
      !isSafeId(artifact.taskId) ||
      artifact.taskId !== task.id ||
      !isSafeId(task.id) ||
      !isSafeId(task.workspaceId) ||
      task.workspaceId !== workspace.id ||
      !workspace.path ||
      workspace.permissions?.read !== true ||
      workspace.isTemp === true ||
      isTempWorkspaceId(workspace.id) ||
      typeof artifact.path !== "string" ||
      artifact.path.length === 0 ||
      artifact.path.length > 4_096 ||
      artifact.path.includes("\0") ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size < 0 ||
      !Number.isFinite(artifact.createdAt) ||
      !SHA256_RE.test(artifact.sha256)
    ) {
      throw unavailable();
    }
    if (selector && "artifactId" in selector && artifact.id !== selector.artifactId) {
      throw unavailable();
    }
    if (selector && "artifactRevisionId" in selector) {
      if (
        !revision ||
        revision.id !== selector.artifactRevisionId ||
        revision.taskId !== task.id ||
        revision.artifactId !== artifact.id ||
        revision.path !== artifact.path ||
        revision.sha256.toLowerCase() !== artifact.sha256.toLowerCase() ||
        revision.size !== artifact.size ||
        (revision.status !== "committed" && revision.status !== "superseded")
      ) {
        throw unavailable();
      }
    }
  }

  private async resolveReadablePath(resource: BrowserArtifactResource): Promise<ResolvedPath> {
    this.assertResource(resource);
    const artifactPath = path.resolve(resource.artifact.path);
    if (!path.isAbsolute(resource.artifact.path)) throw unavailable();

    let rootPath: string;
    let canonicalPath: string;
    try {
      [rootPath, canonicalPath] = await Promise.all([
        fs.realpath(resource.workspace.path),
        fs.realpath(artifactPath),
      ]);
    } catch {
      throw unavailable();
    }
    const access = this.evaluateReadAccess(resource.workspace, canonicalPath);
    if (
      access.decision !== "allow" ||
      (!isWithin(rootPath, canonicalPath) && access.reason !== "profile_filesystem_allow")
    ) {
      throw unavailable();
    }
    const stats = await fs.stat(canonicalPath).catch(() => null);
    if (!stats?.isFile()) throw unavailable();
    return { rootPath, canonicalPath, stats };
  }

  private async openVerifiedResource(
    resource: BrowserArtifactResource,
    expectedIdentity?: FileIdentity,
  ): Promise<fs.FileHandle> {
    const location = await this.resolveReadablePath(resource);
    if (
      location.stats.size !== resource.artifact.size ||
      location.stats.size > this.maxArtifactBytes ||
      (expectedIdentity && !sameIdentity(expectedIdentity, identityOf(location.stats)))
    ) {
      throw unavailable();
    }
    const noFollow = fsConstants.O_NOFOLLOW || 0;
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(location.canonicalPath, fsConstants.O_RDONLY | noFollow);
    } catch {
      throw unavailable();
    }
    try {
      const openedStats = await handle.stat();
      const openedIdentity = identityOf(openedStats);
      await this.assertPathStillMatches(resource, openedIdentity, location);
      if (
        !openedStats.isFile() ||
        openedStats.size !== resource.artifact.size ||
        (expectedIdentity && !sameIdentity(expectedIdentity, openedIdentity)) ||
        !sameIdentity(identityOf(location.stats), openedIdentity)
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

  private async assertPathStillMatches(
    resource: BrowserArtifactResource,
    identity: FileIdentity,
    previous?: ResolvedPath,
  ): Promise<void> {
    const current = await this.resolveReadablePath(resource);
    if (
      (previous &&
        (current.rootPath !== previous.rootPath ||
          current.canonicalPath !== previous.canonicalPath)) ||
      !sameIdentity(identity, identityOf(current.stats))
    ) {
      throw unavailable();
    }
  }

  private evaluateReadAccess(
    workspace: Workspace,
    canonicalPath: string,
  ): { decision: "allow" | "deny"; reason: string } {
    try {
      return evaluateWorkspaceFilesystemAccess(workspace, canonicalPath, "read");
    } catch {
      return { decision: "deny", reason: "invalid_path" };
    }
  }

  private consumeHandle(rawHandle: string, context: WebRequestContext): HandleRecord {
    this.pruneExpiredHandles();
    const key = hashToken(rawHandle);
    const record = this.handles.get(key);
    if (!record || !isSameContext(record, context) || record.expiresAt <= this.now()) {
      if (record?.expiresAt && record.expiresAt <= this.now()) this.handles.delete(key);
      throw unavailable();
    }
    this.handles.delete(key);
    return record;
  }

  private pruneExpiredHandles(): void {
    const now = this.now();
    for (const [key, record] of this.handles) {
      if (record.expiresAt <= now) this.handles.delete(key);
    }
  }
}

export function createBrowserArtifactMethods(
  artifacts: BrowserArtifacts,
): Record<string, WebRpcMethod> {
  return {
    [LIST_METHOD]: {
      capability: "artifacts.read",
      validateParams: (value) => parseListRequest(value, MAX_PAGE_SIZE),
      handler: (context, params) => artifacts.listTaskArtifacts(context, params),
    },
    [CREATE_HANDLE_METHOD]: {
      capability: "artifacts.read",
      mutation: true,
      validateParams: parseSelector,
      handler: (context, params) => artifacts.createDownloadHandle(context, params),
    },
  };
}

function parseListRequest(value: unknown, maxPageSize: number): BrowserArtifactListRequest {
  if (!isRecord(value)) throw invalidRequest();
  const taskId = parseId(value.taskId);
  const workspaceId = parseId(value.workspaceId);
  const limit = value.limit === undefined ? DEFAULT_PAGE_SIZE : value.limit;
  const offset = value.offset === undefined ? 0 : value.offset;
  if (
    !Number.isInteger(limit) ||
    Number(limit) < 1 ||
    Number(limit) > maxPageSize ||
    !Number.isInteger(offset) ||
    Number(offset) < 0 ||
    Number(offset) > MAX_OFFSET
  ) {
    throw invalidRequest();
  }
  return { taskId, workspaceId, limit: Number(limit), offset: Number(offset) };
}

function parseSelector(value: unknown): BrowserArtifactSelector {
  if (!isRecord(value)) throw invalidRequest();
  const hasArtifactId = Object.hasOwn(value, "artifactId");
  const hasRevisionId = Object.hasOwn(value, "artifactRevisionId");
  if (hasArtifactId === hasRevisionId) throw invalidRequest();
  if (hasArtifactId) return { artifactId: parseId(value.artifactId) };
  return { artifactRevisionId: parseId(value.artifactRevisionId) };
}

function parseRedeemRequest(value: unknown): { handle: string } {
  if (!isRecord(value) || typeof value.handle !== "string" || !HANDLE_RE.test(value.handle)) {
    throw invalidRequest();
  }
  return { handle: value.handle };
}

function parseId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || id.length > 128) throw invalidRequest();
  return id;
}

function requireSession(context: WebRequestContext): void {
  if (
    !context.sessionId ||
    !context.audience ||
    !context.identity.installationId ||
    !context.identity.profileId ||
    !context.identity.generation
  ) {
    throw unavailable();
  }
}

function fingerprint(resource: BrowserArtifactResource): ArtifactFingerprint {
  return {
    artifactId: resource.artifact.id,
    taskId: resource.task.id,
    workspaceId: resource.workspace.id,
    path: resource.artifact.path,
    mimeType: resource.artifact.mimeType,
    sha256: resource.artifact.sha256.toLowerCase(),
    size: resource.artifact.size,
    createdAt: resource.artifact.createdAt,
    ...(resource.revision ? { revisionId: resource.revision.id } : {}),
  };
}

function sameFingerprint(left: ArtifactFingerprint, right: ArtifactFingerprint): boolean {
  return (
    left.artifactId === right.artifactId &&
    left.taskId === right.taskId &&
    left.workspaceId === right.workspaceId &&
    left.path === right.path &&
    left.mimeType === right.mimeType &&
    left.sha256 === right.sha256 &&
    left.size === right.size &&
    left.createdAt === right.createdAt &&
    left.revisionId === right.revisionId
  );
}

function isSameContext(record: HandleRecord, context: WebRequestContext): boolean {
  return (
    record.audience === context.audience &&
    record.sessionId === context.sessionId &&
    record.installationId === context.identity.installationId &&
    record.profileId === context.identity.profileId &&
    record.generation === context.identity.generation
  );
}

function identityOf(stats: Stats): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  if (!left.dev || !left.ino || !right.dev || !right.ino) return false;
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function hashHandle(handle: fs.FileHandle, size: number): Promise<string> {
  const hash = createHash("sha256");
  if (size > 0) {
    const stream = handle.createReadStream({ start: 0, end: size - 1, autoClose: false });
    for await (const chunk of stream) hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

function parseRange(value: string | undefined, size: number): ParsedRange {
  if (value === undefined) {
    return { kind: "full", start: 0, end: Math.max(0, size - 1), length: size };
  }
  if (!Number.isSafeInteger(size) || size < 0) return { kind: "invalid" };
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size === 0) return { kind: "invalid" };

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { kind: "invalid" };
    const start = Math.max(0, size - suffixLength);
    const end = size - 1;
    return { kind: "partial", start, end, length: end - start + 1 };
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
  const contentLength = getSingleHeader(req.headers["content-length"]);
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new WebApplicationError("INVALID_REQUEST", "Request body is too large.", 413);
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
    const onAborted = () => finish(invalidRequest(), true);
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
    throw invalidRequest();
  }
}

function parseRequestUrl(value: string | undefined): URL {
  try {
    return new URL(value || "/", "http://browser-artifacts.invalid");
  } catch {
    return new URL("/invalid", "http://browser-artifacts.invalid");
  }
}

function getSingleHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value) && value.length === 1) return value[0].trim();
  return undefined;
}

function safeFileName(rawPath: string): string {
  const baseName = path.basename(rawPath);
  const safe = baseName
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .replace(/[\\/";]/g, "_")
    .trim()
    .slice(0, 180);
  return safe && safe !== "." ? safe : "artifact";
}

function safeMimeType(value: string): string {
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(value)
    ? value.toLowerCase()
    : "application/octet-stream";
}

function contentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\;]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback || "artifact"}"; filename*=UTF-8''${encoded}`;
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

function writeRangeError(res: ServerResponse, size: number): void {
  const body = JSON.stringify({
    apiVersion: WEB_API_VERSION,
    error: {
      code: "INVALID_REQUEST",
      message: "The requested artifact range is not available.",
      retryable: false,
    },
  });
  res.writeHead(416, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Content-Range": `bytes */${size}`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function hashToken(handle: string): string {
  return createHash("sha256").update(handle).digest("hex");
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isSafeId(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  return Number.isInteger(value) && value! >= min && value! <= max ? value! : fallback;
}

function invalidRequest(): WebApplicationError {
  return new WebApplicationError("INVALID_REQUEST", "Invalid artifact request.", 400);
}

function unavailable(): WebApplicationError {
  return new WebApplicationError("UNSUPPORTED_CAPABILITY", "Artifact is unavailable.", 404);
}
