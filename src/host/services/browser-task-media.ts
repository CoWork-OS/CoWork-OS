import { createHash } from "node:crypto";
import { basename, extname, posix } from "node:path";
import type { VisualAttachmentMimeType } from "../../shared/types";
import { WebApplicationError, type WebRequestContext } from "../web/WebApplication";
import type { BrowserTaskMediaFileSnapshot, BrowserWorkspaceFiles } from "./browser-files";

export const MAX_BROWSER_TASK_MEDIA_COUNT = 5;
export const MAX_BROWSER_TASK_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_BROWSER_TASK_VIDEO_BYTES = 64 * 1024 * 1024;
export const MAX_BROWSER_TASK_MEDIA_TOTAL_BYTES = 128 * 1024 * 1024;
export const MAX_BROWSER_TASK_MEDIA_FILENAME_CHARS = 255;
export const MAX_BROWSER_TASK_MEDIA_CAPTURE_BYTES = 256 * 1024 * 1024;

export interface BrowserTaskMediaDescriptor {
  relativePath: string;
  mimeType: VisualAttachmentMimeType;
  filename?: string;
  sizeBytes: number;
}

export interface BrowserCapturedTaskMedia extends BrowserTaskMediaDescriptor {
  bytes: Buffer;
  sha256: string;
  identity: BrowserTaskMediaFileSnapshot["identity"];
}

export type BrowserTaskMediaReader = Pick<BrowserWorkspaceFiles, "readTaskMedia">;

const MIME_EXTENSIONS: Record<VisualAttachmentMimeType, ReadonlySet<string>> = {
  "image/jpeg": new Set([".jpg", ".jpeg"]),
  "image/png": new Set([".png"]),
  "image/gif": new Set([".gif"]),
  "image/webp": new Set([".webp"]),
  "video/mp4": new Set([".mp4"]),
  "video/quicktime": new Set([".mov"]),
  "video/webm": new Set([".webm"]),
};

const VISUAL_MIME_TYPES = new Set<VisualAttachmentMimeType>(
  Object.keys(MIME_EXTENSIONS) as VisualAttachmentMimeType[],
);
let reservedCaptureBytes = 0;
const captureReservations = new WeakMap<BrowserCapturedTaskMedia[], number>();

export async function resolveBrowserTaskMedia(
  reader: BrowserTaskMediaReader,
  context: WebRequestContext,
  workspaceId: string,
  descriptors: BrowserTaskMediaDescriptor[] | undefined,
): Promise<BrowserCapturedTaskMedia[]> {
  if (descriptors === undefined) return [];
  const validated = parseBrowserTaskMediaDescriptors(descriptors) || [];
  let totalBytes = 0;
  for (const descriptor of validated) {
    const maxBytes = descriptor.mimeType.startsWith("video/")
      ? MAX_BROWSER_TASK_VIDEO_BYTES
      : MAX_BROWSER_TASK_IMAGE_BYTES;
    if (descriptor.sizeBytes > maxBytes)
      throw new Error("Visual attachment exceeds its size limit.");
    totalBytes += descriptor.sizeBytes;
    if (totalBytes > MAX_BROWSER_TASK_MEDIA_TOTAL_BYTES) {
      throw new Error("Visual attachments exceed the total size limit.");
    }
  }
  if (reservedCaptureBytes + totalBytes > MAX_BROWSER_TASK_MEDIA_CAPTURE_BYTES) {
    throw new WebApplicationError(
      "RATE_LIMITED",
      "Browser media capture is at capacity. Retry after an attachment finishes processing.",
      429,
      true,
    );
  }
  reservedCaptureBytes += totalBytes;
  const captures: BrowserCapturedTaskMedia[] = [];
  try {
    for (const descriptor of validated) {
      const maxBytes = descriptor.mimeType.startsWith("video/")
        ? MAX_BROWSER_TASK_VIDEO_BYTES
        : MAX_BROWSER_TASK_IMAGE_BYTES;
      const snapshot = await reader.readTaskMedia(
        context,
        workspaceId,
        descriptor.relativePath,
        maxBytes,
        descriptor.sizeBytes,
      );
      if (
        snapshot.sizeBytes !== descriptor.sizeBytes ||
        snapshot.bytes.length !== descriptor.sizeBytes
      ) {
        throw new Error("Visual attachment changed after it was selected.");
      }
      if (!matchesMediaSignature(snapshot.bytes, descriptor.mimeType)) {
        throw new Error("Visual attachment content does not match its declared media type.");
      }
      const filename = descriptor.filename || basename(descriptor.relativePath);
      captures.push(
        Object.freeze({
          relativePath: descriptor.relativePath,
          mimeType: descriptor.mimeType,
          filename,
          sizeBytes: snapshot.sizeBytes,
          sha256: createHash("sha256").update(snapshot.bytes).digest("hex"),
          identity: snapshot.identity,
          // The verified reader already returned an immutable-by-convention
          // host snapshot. Avoid a second full-size copy under the capture cap.
          bytes: snapshot.bytes,
        }),
      );
    }
  } catch (error) {
    reservedCaptureBytes = Math.max(0, reservedCaptureBytes - totalBytes);
    throw error;
  }
  captureReservations.set(captures, totalBytes);
  return captures;
}

export function releaseBrowserTaskMedia(captures: BrowserCapturedTaskMedia[]): void {
  const bytes = captureReservations.get(captures);
  if (bytes === undefined) return;
  captureReservations.delete(captures);
  reservedCaptureBytes = Math.max(0, reservedCaptureBytes - bytes);
}

export function parseBrowserTaskMediaDescriptors(
  value: unknown,
): BrowserTaskMediaDescriptor[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_BROWSER_TASK_MEDIA_COUNT) {
    throw new Error("Attach up to five visual files per task.");
  }
  return value.map((entry) => {
    validateDescriptor(entry);
    return {
      relativePath: entry.relativePath,
      mimeType: entry.mimeType,
      sizeBytes: entry.sizeBytes,
      ...(entry.filename !== undefined ? { filename: entry.filename } : {}),
    };
  });
}

function validateDescriptor(value: unknown): asserts value is BrowserTaskMediaDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid visual attachment descriptor.");
  }
  const descriptor = value as Record<string, unknown>;
  const allowedKeys = new Set(["relativePath", "mimeType", "filename", "sizeBytes"]);
  if (Object.keys(descriptor).some((key) => !allowedKeys.has(key))) {
    throw new Error("Visual attachment descriptor contains unsupported fields.");
  }
  if (
    typeof descriptor.relativePath !== "string" ||
    !descriptor.relativePath ||
    descriptor.relativePath.length > 4096 ||
    descriptor.relativePath.includes("\0") ||
    descriptor.relativePath.includes("\\") ||
    descriptor.relativePath.startsWith("/") ||
    posix.isAbsolute(descriptor.relativePath) ||
    descriptor.relativePath
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Visual attachments must use a workspace-relative file path.");
  }
  if (
    typeof descriptor.mimeType !== "string" ||
    !VISUAL_MIME_TYPES.has(descriptor.mimeType as VisualAttachmentMimeType)
  ) {
    throw new Error("Visual attachment media type is unsupported.");
  }
  if (
    typeof descriptor.sizeBytes !== "number" ||
    !Number.isSafeInteger(descriptor.sizeBytes) ||
    descriptor.sizeBytes <= 0
  ) {
    throw new Error("Visual attachment size is invalid.");
  }
  if (
    descriptor.filename !== undefined &&
    (typeof descriptor.filename !== "string" ||
      descriptor.filename.length === 0 ||
      descriptor.filename.length > MAX_BROWSER_TASK_MEDIA_FILENAME_CHARS ||
      /[\0-\x1f\x7f/\\]/.test(descriptor.filename))
  ) {
    throw new Error("Visual attachment filename is invalid.");
  }
  const filename =
    typeof descriptor.filename === "string"
      ? descriptor.filename
      : basename(descriptor.relativePath);
  const extension = extname(filename).toLowerCase();
  if (!MIME_EXTENSIONS[descriptor.mimeType as VisualAttachmentMimeType].has(extension)) {
    throw new Error("Visual attachment filename does not match its media type.");
  }
  if (filename.endsWith(".tmp") || /(?:^|[._-])cachevideo(?:[._-]|$)/i.test(filename)) {
    throw new Error("Temporary or cached video files cannot be attached.");
  }
}

function matchesMediaSignature(bytes: Buffer, mimeType: VisualAttachmentMimeType): boolean {
  if (bytes.length < 4) return false;
  switch (mimeType) {
    case "image/jpeg":
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/png":
      return (
        bytes.length >= 8 &&
        bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      );
    case "image/gif":
      return (
        bytes.subarray(0, 6).equals(Buffer.from("GIF87a")) ||
        bytes.subarray(0, 6).equals(Buffer.from("GIF89a"))
      );
    case "image/webp":
      return (
        bytes.length >= 12 &&
        bytes.toString("ascii", 0, 4) === "RIFF" &&
        bytes.toString("ascii", 8, 12) === "WEBP"
      );
    case "video/mp4":
      return hasFtypBox(bytes) && bytes.toString("ascii", 8, 12) !== "qt  ";
    case "video/quicktime":
      return hasFtypBox(bytes) && bytes.toString("ascii", 8, 12) === "qt  ";
    case "video/webm":
      return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  }
}

function hasFtypBox(bytes: Buffer): boolean {
  return bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp";
}
