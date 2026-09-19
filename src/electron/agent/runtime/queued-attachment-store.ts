import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";

import type { ImageAttachment } from "../../../shared/types";
import { getUserDataDir } from "../../utils/user-data-dir";

const MAX_ATTACHMENTS_PER_MESSAGE = 5;
const MAX_TOTAL_IMAGE_BYTES = 125 * 1024 * 1024;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
// Five maximum-size video attachments is the largest payload accepted by the
// existing IPC validation. The store applies this as backpressure rather than
// evicting undelivered records; a full store therefore fails the new enqueue.
const MAX_STORE_BYTES = MAX_ATTACHMENTS_PER_MESSAGE * MAX_VIDEO_BYTES;
const KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FILENAME_MAX_LENGTH = 255;

const VISUAL_MIME_TYPES = new Set<ImageAttachment["mimeType"]>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);
const MIME_EXTENSIONS: Record<ImageAttachment["mimeType"], string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
};

export const QUEUED_ATTACHMENT_RECOVERY_ERROR_CODE = "QUEUED_ATTACHMENT_RECOVERY_BLOCKED" as const;

export interface QueuedAttachmentRef {
  key: string;
  mimeType: ImageAttachment["mimeType"];
  filename?: string;
  sizeBytes: number;
}

export interface QueuedAttachmentPersistence {
  refs: QueuedAttachmentRef[];
  images: ImageAttachment[];
}

export interface QueuedAttachmentRecord {
  taskId: string;
  messageId: string;
  ref: QueuedAttachmentRef;
  manifestPath: string;
  contentPath: string;
  mtimeMs: number;
}

interface QueuedAttachmentManifest extends QueuedAttachmentRef {
  schema: "cowork_queued_attachment";
  version: 1;
  taskId: string;
  messageId: string;
  byteLength: number;
  sha256: string;
}

export class QueuedAttachmentRecoveryError extends Error {
  readonly code = QUEUED_ATTACHMENT_RECOVERY_ERROR_CODE;
  readonly taskId: string;
  readonly messageId: string;
  readonly key?: string;

  constructor(taskId: string, messageId: string, message: string, key?: string) {
    super(message);
    this.name = "QueuedAttachmentRecoveryError";
    this.taskId = taskId;
    this.messageId = messageId;
    this.key = key;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizedId(value: string, label: string): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > 200) {
    throw new Error(`Queued attachment ${label} is invalid.`);
  }
  return result;
}

function normalizedFilename(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("Queued attachment filename is invalid.");
  const result = value.trim();
  if (!result || result.length > FILENAME_MAX_LENGTH || /[\\/\0]/.test(result)) {
    throw new Error("Queued attachment filename is invalid.");
  }
  return result;
}

function validateMime(value: unknown): ImageAttachment["mimeType"] {
  if (typeof value !== "string" || !VISUAL_MIME_TYPES.has(value as ImageAttachment["mimeType"])) {
    throw new Error("Queued attachment mime type is invalid.");
  }
  return value as ImageAttachment["mimeType"];
}

function validateSize(
  value: unknown,
  mimeType: ImageAttachment["mimeType"],
  label: string,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Queued attachment ${label} is invalid.`);
  }
  const max = mimeType.startsWith("video/") ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (value > max) throw new Error(`Queued attachment ${label} exceeds its size limit.`);
  return value;
}

function decodeBase64(value: string, expectedMimeType: ImageAttachment["mimeType"]): Buffer {
  const trimmed = value.trim();
  const dataUrlMatch = /^data:([^;,]+);base64,(.*)$/is.exec(trimmed);
  if (dataUrlMatch && dataUrlMatch[1].toLowerCase() !== expectedMimeType) {
    throw new Error("Queued attachment data MIME type does not match its declaration.");
  }
  const payload = dataUrlMatch ? dataUrlMatch[2] : trimmed;
  const compact = payload.replace(/\s+/g, "");
  const maxBytes = expectedMimeType.startsWith("video/") ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (compact.length > Math.ceil(maxBytes / 3) * 4) {
    throw new Error("Queued attachment data exceeds its size limit.");
  }
  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    throw new Error("Queued attachment data is not valid base64.");
  }
  const bytes = Buffer.from(compact, "base64");
  if (bytes.length === 0 || bytes.length > maxBytes || bytes.toString("base64") !== compact) {
    throw new Error("Queued attachment data is not valid base64.");
  }
  return bytes;
}

function ensureRegularSourceFile(filePath: string, maxBytes: number): Buffer {
  let fd: number | undefined;
  try {
    const sourceStat = fs.lstatSync(filePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw new Error("Queued attachment file must be a regular non-symlink file.");
    }
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) {
      throw new Error("Queued attachment file size is invalid.");
    }
    const bytes = fs.readFileSync(fd);
    if (bytes.length <= 0 || bytes.length > maxBytes) {
      throw new Error("Queued attachment file size is invalid.");
    }
    return bytes;
  } catch (error) {
    throw new Error(
      `Queued attachment file could not be read: ${String((error as Error).message)}`,
    );
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function fsyncDirectory(directory: string): void {
  try {
    const fd = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Directory fsync is not supported on every platform/filesystem. The file
    // itself is fsynced before rename, so this is only an extra durability hint.
  }
}

export class QueuedAttachmentStore {
  readonly rootDir: string;

  constructor(rootDir = path.join(getUserDataDir(), "runtime", "queued-attachments")) {
    this.rootDir = path.resolve(rootDir);
  }

  persist(
    taskId: string,
    messageId: string,
    images?: ImageAttachment[],
  ): QueuedAttachmentPersistence {
    const normalizedTaskId = normalizedId(taskId, "task id");
    const normalizedMessageId = normalizedId(messageId, "message id");
    if (images === undefined) return { refs: [], images: [] };
    if (!Array.isArray(images) || images.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new Error("Queued attachment count exceeds the message limit.");
    }
    if (images.length === 0) return { refs: [], images: [] };

    this.ensureRoot();
    const refs: QueuedAttachmentRef[] = [];
    const hydratedImages: ImageAttachment[] = [];
    const createdKeys: string[] = [];
    let totalImageBytes = 0;
    let storeUsageBytes = this.getStoreUsageBytes();
    try {
      for (const image of images) {
        const stored = this.readSource(image);
        const actualBytes = stored.bytes.length;
        const declaredSizeBytes = validateSize(image?.sizeBytes, stored.mimeType, "declared size");
        const maxBytes = stored.mimeType.startsWith("video/") ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
        if (actualBytes <= 0 || actualBytes > maxBytes) {
          throw new Error("Queued attachment file size is invalid.");
        }
        if (declaredSizeBytes !== actualBytes) {
          throw new Error("Queued attachment declared size does not match its bytes.");
        }
        if (!stored.mimeType.startsWith("video/")) {
          totalImageBytes += actualBytes;
          if (totalImageBytes > MAX_TOTAL_IMAGE_BYTES) {
            throw new Error("Queued image payload exceeds the total size limit.");
          }
        }

        const key = randomUUID();
        const ref: QueuedAttachmentRef = {
          key,
          mimeType: stored.mimeType,
          ...(stored.filename ? { filename: stored.filename } : {}),
          sizeBytes: declaredSizeBytes,
        };
        const manifest: QueuedAttachmentManifest = {
          schema: "cowork_queued_attachment",
          version: 1,
          ...ref,
          taskId: normalizedTaskId,
          messageId: normalizedMessageId,
          byteLength: actualBytes,
          sha256: createHash("sha256").update(stored.bytes).digest("hex"),
        };
        const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
        if (storeUsageBytes + actualBytes + manifestBytes.length > MAX_STORE_BYTES) {
          throw new Error(
            "Queued attachment storage is full; wait for delivery or remove completed tasks before retrying.",
          );
        }
        createdKeys.push(key);
        this.writeAtomically(this.contentPath(key, stored.mimeType), stored.bytes);
        this.writeAtomically(this.manifestPath(key), manifestBytes);
        storeUsageBytes += actualBytes + manifestBytes.length;
        refs.push(ref);
        hydratedImages.push({
          filePath: this.contentPath(key, stored.mimeType),
          mimeType: stored.mimeType,
          ...(stored.filename ? { filename: stored.filename } : {}),
          sizeBytes: declaredSizeBytes,
          tempFile: false,
        });
      }
    } catch (error) {
      for (const key of createdKeys) this.removeKey(key);
      throw error;
    }
    return { refs, images: hydratedImages };
  }

  hydrate(taskId: string, messageId: string, value: unknown): ImageAttachment[] {
    const normalizedTaskId = normalizedId(taskId, "task id");
    const normalizedMessageId = normalizedId(messageId, "message id");
    try {
      this.ensureRoot();
    } catch {
      throw this.recoveryError(
        normalizedTaskId,
        normalizedMessageId,
        "attachment storage directory is unavailable",
      );
    }
    if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      throw this.recoveryError(
        normalizedTaskId,
        normalizedMessageId,
        "attachment references are invalid",
      );
    }
    const refs = value.map((entry) =>
      this.validateRef(entry, normalizedTaskId, normalizedMessageId),
    );
    const images: ImageAttachment[] = [];
    let totalImageBytes = 0;
    for (const ref of refs) {
      const manifest = this.readManifest(ref.key, normalizedTaskId, normalizedMessageId);
      if (
        manifest.key !== ref.key ||
        manifest.mimeType !== ref.mimeType ||
        manifest.sizeBytes !== ref.sizeBytes ||
        manifest.byteLength !== manifest.sizeBytes ||
        manifest.filename !== ref.filename
      ) {
        throw this.recoveryError(
          normalizedTaskId,
          normalizedMessageId,
          "attachment metadata does not match its durable record",
          ref.key,
        );
      }
      const contentPath = this.contentPath(ref.key, manifest.mimeType);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(contentPath);
      } catch {
        throw this.recoveryError(
          normalizedTaskId,
          normalizedMessageId,
          "attachment bytes are missing",
          ref.key,
        );
      }
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw this.recoveryError(
          normalizedTaskId,
          normalizedMessageId,
          "attachment bytes are not a regular file",
          ref.key,
        );
      }
      const bytes = fs.readFileSync(contentPath);
      if (
        bytes.length !== manifest.byteLength ||
        createHash("sha256").update(bytes).digest("hex") !== manifest.sha256
      ) {
        throw this.recoveryError(
          normalizedTaskId,
          normalizedMessageId,
          "attachment bytes failed integrity validation",
          ref.key,
        );
      }
      if (!ref.mimeType.startsWith("video/")) {
        totalImageBytes += bytes.length;
        if (totalImageBytes > MAX_TOTAL_IMAGE_BYTES) {
          throw this.recoveryError(
            normalizedTaskId,
            normalizedMessageId,
            "attachment payload exceeds the total size limit",
            ref.key,
          );
        }
      }
      images.push({
        filePath: contentPath,
        mimeType: ref.mimeType,
        ...(ref.filename ? { filename: ref.filename } : {}),
        sizeBytes: ref.sizeBytes,
        tempFile: false,
      });
    }
    return images;
  }

  /**
   * Validate receipt references before their owning task row is removed. This
   * validates only the opaque reference shape; release() performs the
   * manifest ownership check immediately before unlinking files.
   */
  validateRefs(taskId: string, messageId: string, value: unknown): QueuedAttachmentRef[] {
    const normalizedTaskId = normalizedId(taskId, "task id");
    const normalizedMessageId = normalizedId(messageId, "message id");
    if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new Error("Queued attachment references are invalid.");
    }
    return value.map((entry) => this.validateRef(entry, normalizedTaskId, normalizedMessageId));
  }

  /**
   * Enumerate complete manifest records for conservative orphan cleanup. A
   * malformed or symlinked record is deliberately an error: callers must
   * retain it rather than guessing that it is safe to delete.
   */
  listRecords(): QueuedAttachmentRecord[] {
    this.ensureRoot();
    const records: QueuedAttachmentRecord[] = [];
    for (const entry of fs.readdirSync(this.rootDir, { withFileTypes: true })) {
      if (!entry.name.endsWith(".json")) continue;
      const manifestPath = path.join(this.rootDir, entry.name);
      const manifestStat = fs.lstatSync(manifestPath);
      if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
        throw new Error("Queued attachment storage contains an unsafe manifest entry.");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      } catch {
        throw new Error("Queued attachment storage contains a corrupt manifest.");
      }
      if (!isRecord(parsed)) throw new Error("Queued attachment manifest is invalid.");
      if (parsed.schema !== "cowork_queued_attachment" || parsed.version !== 1) {
        throw new Error("Queued attachment manifest schema is invalid.");
      }
      const key = this.validateKey(parsed.key);
      const mimeType = validateMime(parsed.mimeType);
      const filename = normalizedFilename(parsed.filename);
      const sizeBytes = validateSize(parsed.sizeBytes, mimeType, "manifest size");
      const byteLength = validateSize(parsed.byteLength, mimeType, "byte length");
      const taskId = normalizedId(String(parsed.taskId ?? ""), "task id");
      const messageId = normalizedId(String(parsed.messageId ?? ""), "message id");
      if (
        byteLength !== sizeBytes ||
        parsed.key !== key ||
        typeof parsed.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/i.test(parsed.sha256)
      ) {
        throw new Error("Queued attachment manifest integrity metadata is invalid.");
      }
      if (entry.name !== `${key}.json`) {
        throw new Error("Queued attachment manifest filename is invalid.");
      }
      const contentPath = this.contentPath(key, mimeType);
      let contentStat: fs.Stats | undefined;
      try {
        contentStat = fs.lstatSync(contentPath);
        if (contentStat.isSymbolicLink() || !contentStat.isFile()) {
          throw new Error("Queued attachment content entry is unsafe.");
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes("unsafe")) throw error;
        // A missing content file remains a record candidate. Its owner lookup
        // still decides whether the manifest may be removed.
      }
      const ref: QueuedAttachmentRef = {
        key,
        mimeType,
        ...(filename ? { filename } : {}),
        sizeBytes,
      };
      records.push({
        taskId,
        messageId,
        ref,
        manifestPath,
        contentPath,
        mtimeMs: Math.min(manifestStat.mtimeMs, contentStat?.mtimeMs ?? manifestStat.mtimeMs),
      });
    }
    return records;
  }

  /** Remove only crash-left temporary files after a conservative age cutoff. */
  cleanupStaleTemporaryFiles(cutoffMs: number): number {
    this.ensureRoot();
    let removed = 0;
    for (const entry of fs.readdirSync(this.rootDir, { withFileTypes: true })) {
      if (!/^\.[0-9a-f-]{36}\.tmp$/i.test(entry.name)) continue;
      const filePath = path.join(this.rootDir, entry.name);
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.mtimeMs >= cutoffMs) continue;
      fs.unlinkSync(filePath);
      removed += 1;
    }
    if (removed > 0) fsyncDirectory(this.rootDir);
    return removed;
  }

  /**
   * Remove only old UUID media files whose matching manifest is absent. This
   * covers a crash between content rename and manifest rename; any manifest,
   * including a malformed one, conservatively preserves its content.
   */
  cleanupOrphanedContentFiles(cutoffMs: number, isReferenced: (key: string) => boolean): number {
    this.ensureRoot();
    const extensions = new Set(Object.values(MIME_EXTENSIONS));
    let removed = 0;
    for (const entry of fs.readdirSync(this.rootDir, { withFileTypes: true })) {
      const extension = path.extname(entry.name).toLowerCase();
      if (!extensions.has(extension)) continue;
      const key = path.basename(entry.name, extension);
      if (!KEY_PATTERN.test(key)) continue;
      const manifestPath = this.manifestPath(key);
      try {
        fs.lstatSync(manifestPath);
        continue;
      } catch {
        // No manifest at all: the age cutoff below is the safety boundary.
      }
      if (isReferenced(key)) continue;
      const filePath = path.join(this.rootDir, entry.name);
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.mtimeMs >= cutoffMs) continue;
      fs.unlinkSync(filePath);
      removed += 1;
    }
    if (removed > 0) fsyncDirectory(this.rootDir);
    return removed;
  }

  /**
   * Validate queue-snapshot images created by persist(). Legacy snapshots may
   * still contain inline data or workspace paths, so return null when none of
   * the paths belongs to this store and let their existing compatibility path
   * handle them. A partially durable queue item is rejected as a whole.
   */
  hydrateStoredImages(
    taskId: string,
    messageId: string,
    images: ImageAttachment[] | undefined,
  ): ImageAttachment[] | null {
    if (!Array.isArray(images) || images.length === 0) return null;
    const storedImages = images.filter(
      (image) => typeof image?.filePath === "string" && this.isStorePath(image.filePath),
    );
    if (storedImages.length === 0) return null;
    if (storedImages.length !== images.length) {
      throw this.recoveryError(
        taskId,
        messageId,
        "queue snapshot mixes durable and non-durable attachment paths",
      );
    }
    const refs = storedImages.map((image) => {
      const filePath = path.resolve(image.filePath as string);
      const extension = path.extname(filePath).toLowerCase();
      const key = path.basename(filePath, extension);
      const mimeType = validateMime(image.mimeType);
      if (MIME_EXTENSIONS[mimeType] !== extension) {
        throw this.recoveryError(
          taskId,
          messageId,
          "queue snapshot attachment extension does not match its MIME type",
          key,
        );
      }
      return {
        key,
        mimeType,
        ...(image.filename ? { filename: image.filename } : {}),
        sizeBytes: image.sizeBytes,
      } satisfies QueuedAttachmentRef;
    });
    return this.hydrate(taskId, messageId, refs);
  }

  /**
   * Release records only after the target receipt has reached delivered. The
   * manifest ownership check prevents a ref from deleting another task's data;
   * all failures are best effort because delivery is already durable.
   */
  release(taskId: string, messageId: string, value: unknown): void {
    const normalizedTaskId = normalizedId(taskId, "task id");
    const normalizedMessageId = normalizedId(messageId, "message id");
    if (!Array.isArray(value)) return;
    try {
      this.ensureRoot();
    } catch {
      return;
    }
    for (const entry of value) {
      let ref: QueuedAttachmentRef;
      try {
        ref = this.validateRef(entry, normalizedTaskId, normalizedMessageId);
        const manifest = this.readManifest(ref.key, normalizedTaskId, normalizedMessageId);
        if (
          manifest.mimeType !== ref.mimeType ||
          manifest.sizeBytes !== ref.sizeBytes ||
          manifest.filename !== ref.filename
        ) {
          continue;
        }
        this.removeKey(ref.key);
        fsyncDirectory(this.rootDir);
      } catch {
        // Do not turn an already delivered message into a retryable failure.
      }
    }
  }

  private readSource(image: ImageAttachment): {
    bytes: Buffer;
    mimeType: ImageAttachment["mimeType"];
    filename?: string;
  } {
    if (!isRecord(image)) throw new Error("Queued attachment is invalid.");
    const mimeType = validateMime(image.mimeType);
    const filename = normalizedFilename(image.filename);
    const hasData = typeof image.data === "string" && image.data.trim().length > 0;
    const hasFilePath = typeof image.filePath === "string" && image.filePath.trim().length > 0;
    if (hasData === hasFilePath) {
      throw new Error("Queued attachment must provide exactly one source.");
    }
    if (mimeType.startsWith("video/") && hasData) {
      throw new Error("Queued video attachments must use a file path.");
    }
    if (hasFilePath) {
      const extension = path.extname(image.filePath as string).toLowerCase();
      const allowedExtensions =
        mimeType === "image/jpeg" ? [".jpg", ".jpeg"] : [MIME_EXTENSIONS[mimeType]];
      if (!allowedExtensions.includes(extension)) {
        throw new Error("Queued attachment file extension does not match its MIME type.");
      }
    }
    const bytes = hasData
      ? decodeBase64(image.data as string, mimeType)
      : ensureRegularSourceFile(
          this.requireAbsoluteSourcePath(image.filePath as string),
          mimeType.startsWith("video/") ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES,
        );
    return { bytes, mimeType, ...(filename ? { filename } : {}) };
  }

  private requireAbsoluteSourcePath(filePath: string): string {
    if (!path.isAbsolute(filePath)) {
      throw new Error("Queued attachment file path must be absolute.");
    }
    return filePath;
  }

  private ensureRoot(): void {
    fs.mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(this.rootDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Queued attachment storage directory is not safe.");
    }
    fs.chmodSync(this.rootDir, 0o700);
  }

  private isStorePath(filePath: string): boolean {
    const relative = path.relative(this.rootDir, path.resolve(filePath));
    return (
      relative.length > 0 && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    );
  }

  private getStoreUsageBytes(): number {
    let total = 0;
    for (const entry of fs.readdirSync(this.rootDir, { withFileTypes: true })) {
      const filePath = path.join(this.rootDir, entry.name);
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink()) {
        throw new Error("Queued attachment storage contains an unsafe symbolic link.");
      }
      if (stat.isFile()) total += stat.size;
    }
    return total;
  }

  private validateKey(value: unknown): string {
    if (typeof value !== "string" || !KEY_PATTERN.test(value)) {
      throw new Error("Queued attachment key is invalid.");
    }
    return value;
  }

  private validateRef(value: unknown, taskId: string, messageId: string): QueuedAttachmentRef {
    if (!isRecord(value)) {
      throw this.recoveryError(taskId, messageId, "attachment reference is invalid");
    }
    try {
      const key = this.validateKey(value.key);
      const mimeType = validateMime(value.mimeType);
      const sizeBytes = validateSize(value.sizeBytes, mimeType, "reference size");
      const filename = normalizedFilename(value.filename);
      return {
        key,
        mimeType,
        ...(filename ? { filename } : {}),
        sizeBytes,
      };
    } catch {
      throw this.recoveryError(taskId, messageId, "attachment reference is invalid");
    }
  }

  private readManifest(key: string, taskId: string, messageId: string): QueuedAttachmentManifest {
    let raw: string;
    try {
      const stat = fs.lstatSync(this.manifestPath(key));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe manifest");
      raw = fs.readFileSync(this.manifestPath(key), "utf8");
    } catch {
      throw this.recoveryError(taskId, messageId, "attachment manifest is missing", key);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw this.recoveryError(taskId, messageId, "attachment manifest is corrupt", key);
    }
    if (!isRecord(parsed)) {
      throw this.recoveryError(taskId, messageId, "attachment manifest is invalid", key);
    }
    try {
      const manifest: QueuedAttachmentManifest = {
        schema: parsed.schema === "cowork_queued_attachment" ? parsed.schema : ("" as never),
        version: parsed.version === 1 ? 1 : (0 as never),
        key: this.validateKey(parsed.key),
        mimeType: validateMime(parsed.mimeType),
        ...(normalizedFilename(parsed.filename)
          ? { filename: normalizedFilename(parsed.filename) }
          : {}),
        sizeBytes: validateSize(parsed.sizeBytes, validateMime(parsed.mimeType), "manifest size"),
        taskId: normalizedId(String(parsed.taskId ?? ""), "task id"),
        messageId: normalizedId(String(parsed.messageId ?? ""), "message id"),
        byteLength: validateSize(parsed.byteLength, validateMime(parsed.mimeType), "byte length"),
        sha256:
          typeof parsed.sha256 === "string" && /^[0-9a-f]{64}$/i.test(parsed.sha256)
            ? parsed.sha256
            : ("" as never),
      };
      if (
        manifest.schema !== "cowork_queued_attachment" ||
        manifest.version !== 1 ||
        manifest.key !== key ||
        manifest.taskId !== taskId ||
        manifest.messageId !== messageId ||
        !manifest.sha256
      ) {
        throw new Error("manifest ownership mismatch");
      }
      return manifest;
    } catch {
      throw this.recoveryError(taskId, messageId, "attachment manifest failed validation", key);
    }
  }

  private writeAtomically(targetPath: string, bytes: Buffer): void {
    this.ensureRoot();
    const tempPath = path.join(this.rootDir, `.${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = fs.openSync(
        tempPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o600,
      );
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tempPath, targetPath);
      fs.chmodSync(targetPath, 0o600);
      fsyncDirectory(this.rootDir);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // The rename completed or the temp file was never created.
      }
    }
  }

  private contentPath(key: string, mimeType: ImageAttachment["mimeType"]): string {
    this.validateKey(key);
    return path.join(this.rootDir, `${key}${MIME_EXTENSIONS[mimeType]}`);
  }

  private manifestPath(key: string): string {
    this.validateKey(key);
    return path.join(this.rootDir, `${key}.json`);
  }

  private removeKey(key: string): void {
    const contentPaths = Array.from(VISUAL_MIME_TYPES, (mimeType) =>
      this.contentPath(key, mimeType),
    );
    for (const filePath of [...contentPaths, this.manifestPath(key)]) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Best-effort rollback of a partial record.
      }
    }
  }

  private recoveryError(taskId: string, messageId: string, reason: string, key?: string) {
    return new QueuedAttachmentRecoveryError(
      taskId,
      messageId,
      `Queued attachment recovery blocked: ${reason}. Resend the message with its attachments.`,
      key,
    );
  }
}
