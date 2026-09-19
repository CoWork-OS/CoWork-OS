import { createHash, randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";

import {
  COMPOSER_DRAFT_MAX_ATTACHMENTS,
  COMPOSER_DRAFT_MAX_ATTACHMENT_MIME_LENGTH,
  COMPOSER_DRAFT_MAX_ATTACHMENT_NAME_LENGTH,
  COMPOSER_DRAFT_MAX_ATTACHMENT_SIZE,
  COMPOSER_DRAFT_MAX_ATTACHMENT_TOTAL_BYTES,
  type DraftAttachmentRef,
} from "../../../shared/composer-drafts";
import { isApprovedImportFile } from "../../security/file-import-approvals";

export const MAX_COMPOSER_DRAFT_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface PutComposerDraftAttachmentInput {
  draftKey: string;
  workspaceId: string;
  name: string;
  mimeType?: string;
  dataBase64?: string;
  sourcePath?: string;
}

export interface LiveComposerDraftAttachment {
  draftKey: string;
  workspaceId: string;
  refId: string;
}

export interface ComposerDraftAttachmentUsage {
  count: number;
  bytes: number;
}

interface AttachmentMetadata extends DraftAttachmentRef {
  draftKey: string;
  workspaceId: string;
}

export class ComposerDraftAttachmentStore {
  private readonly rootDir: string;
  private readonly putLocks = new Map<string, Promise<unknown>>();

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  async put(input: PutComposerDraftAttachmentInput): Promise<DraftAttachmentRef> {
    const draftKey = requireText(input.draftKey, "draftKey");
    const workspaceId = requireText(input.workspaceId, "workspaceId");
    const lockKey = `${workspaceId}\u0000${draftKey}`;
    const previous = this.putLocks.get(lockKey) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(() => this.putUnlocked({ ...input, draftKey, workspaceId }));
    this.putLocks.set(lockKey, operation);
    try {
      return await operation;
    } finally {
      if (this.putLocks.get(lockKey) === operation) this.putLocks.delete(lockKey);
    }
  }

  private async putUnlocked(input: PutComposerDraftAttachmentInput): Promise<DraftAttachmentRef> {
    const draftKey = requireText(input.draftKey, "draftKey");
    const workspaceId = requireText(input.workspaceId, "workspaceId");
    const name = requireText(input.name, "name").slice(0, 512);
    const mimeType = input.mimeType?.trim().slice(0, 255) || undefined;
    const bytes = await this.readInputBytes(input);
    if (bytes.byteLength > MAX_COMPOSER_DRAFT_ATTACHMENT_BYTES) {
      throw new Error("Draft attachment exceeds the 25 MB limit.");
    }
    const usage = await this.getDraftUsage(draftKey, workspaceId);
    if (usage.count >= COMPOSER_DRAFT_MAX_ATTACHMENTS) {
      throw new Error(`You can attach up to ${COMPOSER_DRAFT_MAX_ATTACHMENTS} files.`);
    }
    if (usage.bytes + bytes.byteLength > COMPOSER_DRAFT_MAX_ATTACHMENT_TOTAL_BYTES) {
      throw new Error("Draft attachments exceed the 100 MB per-draft limit.");
    }

    const refId = randomUUID();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const ref: DraftAttachmentRef = {
      refId,
      name,
      ...(mimeType ? { mimeType } : {}),
      size: bytes.byteLength,
      sha256,
      status: "available",
    };
    const metadata: AttachmentMetadata = { ...ref, draftKey, workspaceId };
    const directory = this.workspaceDirectory(workspaceId);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700).catch(() => undefined);

    const dataPath = path.join(directory, `${refId}.bin`);
    const metadataPath = path.join(directory, `${refId}.json`);
    const tempDataPath = path.join(directory, `.${refId}.bin.tmp`);
    const tempMetadataPath = path.join(directory, `.${refId}.json.tmp`);
    try {
      await fs.writeFile(tempDataPath, bytes, { mode: 0o600, flag: "wx" });
      await fs.chmod(tempDataPath, 0o600);
      await fs.writeFile(tempMetadataPath, JSON.stringify(metadata), { mode: 0o600, flag: "wx" });
      await fs.chmod(tempMetadataPath, 0o600);
      await fs.rename(tempDataPath, dataPath);
      await fs.rename(tempMetadataPath, metadataPath);
      return ref;
    } catch (error) {
      await Promise.allSettled([
        fs.unlink(tempDataPath),
        fs.unlink(tempMetadataPath),
        fs.unlink(dataPath),
        fs.unlink(metadataPath),
      ]);
      throw error;
    }
  }

  async resolve(
    draftKey: string,
    workspaceId: string,
    refId: string,
  ): Promise<{ ref: DraftAttachmentRef; path: string } | null> {
    const metadata = await this.readMetadata(draftKey, workspaceId, refId);
    if (!metadata) return null;
    const filePath = path.join(this.workspaceDirectory(workspaceId), `${refId}.bin`);
    try {
      const bytes = await fs.readFile(filePath);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (sha256 !== metadata.sha256 || bytes.byteLength !== metadata.size) return null;
      return { ref: { ...metadata, status: "available" }, path: filePath };
    } catch (error: Any) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async release(draftKey: string, workspaceId: string, refId: string): Promise<boolean> {
    const metadata = await this.readMetadata(draftKey, workspaceId, refId);
    if (!metadata) return false;
    const directory = this.workspaceDirectory(workspaceId);
    let removed = false;
    for (const filePath of [
      path.join(directory, `${refId}.bin`),
      path.join(directory, `${refId}.json`),
    ]) {
      try {
        await fs.unlink(filePath);
        removed = true;
      } catch (error: Any) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return removed;
  }

  async releaseDraft(draftKey: string, workspaceId: string): Promise<number> {
    const directory = this.workspaceDirectory(workspaceId);
    let entries: string[];
    try {
      entries = await fs.readdir(directory);
    } catch (error: Any) {
      if (error?.code === "ENOENT") return 0;
      throw error;
    }
    let released = 0;
    for (const entry of entries.filter((name) => name.endsWith(".json"))) {
      const refId = entry.slice(0, -5);
      const metadata = await this.readMetadata(draftKey, workspaceId, refId);
      if (!metadata) continue;
      if (await this.release(draftKey, workspaceId, refId)) released += 1;
    }
    return released;
  }

  async getDraftUsage(
    draftKey: string,
    workspaceId: string,
  ): Promise<ComposerDraftAttachmentUsage> {
    const directory = this.workspaceDirectory(workspaceId);
    let entries: string[];
    try {
      entries = await fs.readdir(directory);
    } catch (error: Any) {
      if (error?.code === "ENOENT") return { count: 0, bytes: 0 };
      throw error;
    }
    let count = 0;
    let bytes = 0;
    for (const entry of entries.filter((name) => name.endsWith(".json"))) {
      const metadata = await this.readMetadata(draftKey, workspaceId, entry.slice(0, -5));
      if (!metadata) continue;
      count += 1;
      bytes += metadata.size;
    }
    return { count, bytes };
  }

  /** Remove staged files that are no longer referenced by a live draft row. */
  async reconcile(liveAttachments: Iterable<LiveComposerDraftAttachment>): Promise<number> {
    const liveKeys = new Set(
      Array.from(liveAttachments, (attachment) =>
        attachmentKey(attachment.workspaceId, attachment.draftKey, attachment.refId),
      ),
    );
    let removed = 0;
    let workspaceDirectories: string[];
    try {
      workspaceDirectories = await fs.readdir(this.rootDir);
    } catch (error: Any) {
      if (error?.code === "ENOENT") return 0;
      throw error;
    }

    for (const workspaceDirectoryName of workspaceDirectories) {
      const directory = path.join(this.rootDir, workspaceDirectoryName);
      let entries: string[];
      try {
        entries = await fs.readdir(directory);
      } catch (error: Any) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        const entryPath = path.join(directory, entry);
        if (entry.startsWith(".") && entry.endsWith(".tmp")) {
          if (await unlinkIfPresent(entryPath)) removed += 1;
          continue;
        }
        if (entry.endsWith(".bin") && !entries.includes(`${entry.slice(0, -4)}.json`)) {
          if (await unlinkIfPresent(entryPath)) removed += 1;
          continue;
        }
        if (!entry.endsWith(".json")) continue;

        const metadata = await readMetadataFile(entryPath);
        const refId = entry.slice(0, -5);
        const live =
          metadata &&
          liveKeys.has(attachmentKey(metadata.workspaceId, metadata.draftKey, metadata.refId));
        if (live) continue;

        if (await unlinkIfPresent(entryPath)) removed += 1;
        if (await unlinkIfPresent(path.join(directory, `${refId}.bin`))) removed += 1;
      }
    }
    return removed;
  }

  /**
   * Move attachment ownership when a draft changes from the temporary
   * "new" task key to the task created by a successful send.
   */
  async rekeyDraft(
    sourceDraftKey: string,
    destinationDraftKey: string,
    workspaceId: string,
  ): Promise<number> {
    const sourceKey = requireText(sourceDraftKey, "sourceDraftKey");
    const destinationKey = requireText(destinationDraftKey, "destinationDraftKey");
    const normalizedWorkspaceId = requireText(workspaceId, "workspaceId");
    if (sourceKey === destinationKey) return 0;

    const directory = this.workspaceDirectory(normalizedWorkspaceId);
    let entries: string[];
    try {
      entries = await fs.readdir(directory);
    } catch {
      return 0;
    }

    const movedRefIds: string[] = [];
    try {
      for (const entry of entries.filter((name) => name.endsWith(".json"))) {
        const refId = entry.slice(0, -5);
        const metadata = await this.readMetadata(sourceKey, normalizedWorkspaceId, refId);
        if (!metadata) continue;
        await this.replaceMetadata(directory, refId, { ...metadata, draftKey: destinationKey });
        movedRefIds.push(refId);
      }
      return movedRefIds.length;
    } catch (error) {
      await Promise.allSettled(
        movedRefIds.map(async (refId) => {
          const metadata = await this.readMetadata(destinationKey, normalizedWorkspaceId, refId);
          if (metadata) {
            await this.replaceMetadata(directory, refId, { ...metadata, draftKey: sourceKey });
          }
        }),
      );
      throw error;
    }
  }

  private async readMetadata(
    draftKey: string,
    workspaceId: string,
    refId: string,
  ): Promise<AttachmentMetadata | null> {
    const normalizedRefId = requireText(refId, "refId");
    if (!/^[0-9a-f-]{20,64}$/i.test(normalizedRefId)) return null;
    try {
      const raw = await fs.readFile(
        path.join(this.workspaceDirectory(workspaceId), `${normalizedRefId}.json`),
        "utf8",
      );
      const metadata = parseAttachmentMetadata(raw);
      if (
        !metadata ||
        metadata.draftKey !== draftKey ||
        metadata.workspaceId !== workspaceId ||
        metadata.refId !== normalizedRefId
      ) {
        return null;
      }
      return metadata;
    } catch (error: Any) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  private async replaceMetadata(
    directory: string,
    refId: string,
    metadata: AttachmentMetadata,
  ): Promise<void> {
    const metadataPath = path.join(directory, `${refId}.json`);
    const tempMetadataPath = path.join(directory, `.${refId}.${randomUUID()}.json.tmp`);
    try {
      await fs.writeFile(tempMetadataPath, JSON.stringify(metadata), { mode: 0o600, flag: "wx" });
      await fs.chmod(tempMetadataPath, 0o600);
      await fs.rename(tempMetadataPath, metadataPath);
    } catch (error) {
      await fs.unlink(tempMetadataPath).catch(() => undefined);
      throw error;
    }
  }

  private workspaceDirectory(workspaceId: string): string {
    const workspaceHash = createHash("sha256").update(workspaceId).digest("hex");
    return path.join(this.rootDir, workspaceHash);
  }

  private async readInputBytes(input: PutComposerDraftAttachmentInput): Promise<Buffer> {
    if (input.dataBase64 && input.sourcePath) {
      throw new Error("Provide either attachment bytes or a source path, not both.");
    }
    if (input.dataBase64) {
      const encoded = input.dataBase64.trim();
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        throw new Error("Draft attachment data is not valid base64.");
      }
      if (encoded.length > Math.ceil((MAX_COMPOSER_DRAFT_ATTACHMENT_BYTES * 4) / 3) + 4096) {
        throw new Error("Draft attachment exceeds the 25 MB limit.");
      }
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.length === 0) throw new Error("Draft attachment is empty.");
      return bytes;
    }
    const sourcePath = requireText(input.sourcePath, "sourcePath");
    if (!path.isAbsolute(sourcePath)) {
      throw new Error("Draft attachment source must be an absolute path.");
    }
    if (!isApprovedImportFile(sourcePath)) {
      throw new Error("Draft attachment source was not selected by the native file picker.");
    }
    const linkStat = await fs.lstat(sourcePath);
    if (linkStat.isSymbolicLink()) {
      throw new Error("Draft attachment source must not be a symbolic link.");
    }
    const noFollow = fsSync.constants.O_NOFOLLOW ?? 0;
    const handle = await fs.open(sourcePath, fsSync.constants.O_RDONLY | noFollow);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error("Draft attachment source is not a file.");
      if (
        stat.size > MAX_COMPOSER_DRAFT_ATTACHMENT_BYTES ||
        stat.size > COMPOSER_DRAFT_MAX_ATTACHMENT_SIZE
      ) {
        throw new Error("Draft attachment exceeds the 25 MB limit.");
      }
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }
}

function attachmentKey(workspaceId: string, draftKey: string, refId: string): string {
  return `${workspaceId}\u0000${draftKey}\u0000${refId}`;
}

async function unlinkIfPresent(filePath: string): Promise<boolean> {
  try {
    await fs.unlink(filePath);
    return true;
  } catch (error: Any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readMetadataFile(filePath: string): Promise<AttachmentMetadata | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return parseAttachmentMetadata(raw);
  } catch (error: Any) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function parseAttachmentMetadata(raw: string): AttachmentMetadata | null {
  const metadata = JSON.parse(raw) as Partial<AttachmentMetadata>;
  if (
    typeof metadata.draftKey !== "string" ||
    metadata.draftKey.length === 0 ||
    metadata.draftKey.length > 1024 ||
    typeof metadata.workspaceId !== "string" ||
    metadata.workspaceId.length === 0 ||
    metadata.workspaceId.length > 256 ||
    typeof metadata.refId !== "string" ||
    !/^[0-9a-f-]{20,64}$/i.test(metadata.refId) ||
    typeof metadata.name !== "string" ||
    metadata.name.length === 0 ||
    metadata.name.length > COMPOSER_DRAFT_MAX_ATTACHMENT_NAME_LENGTH ||
    (metadata.mimeType !== undefined &&
      (typeof metadata.mimeType !== "string" ||
        metadata.mimeType.length > COMPOSER_DRAFT_MAX_ATTACHMENT_MIME_LENGTH)) ||
    typeof metadata.size !== "number" ||
    !Number.isInteger(metadata.size) ||
    metadata.size < 0 ||
    metadata.size > COMPOSER_DRAFT_MAX_ATTACHMENT_SIZE ||
    typeof metadata.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/i.test(metadata.sha256) ||
    (metadata.status !== undefined &&
      metadata.status !== "available" &&
      metadata.status !== "unavailable")
  ) {
    return null;
  }
  return metadata as AttachmentMetadata;
}

function requireText(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${field} is required.`);
  return normalized;
}
