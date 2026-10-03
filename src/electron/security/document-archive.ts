import { createReadStream } from "fs";
import JSZip from "jszip";
import type { Readable } from "stream";

export const DOCUMENT_ARCHIVE_LIMITS = {
  inputBytes: 50 * 1024 * 1024,
  entryBytes: 16 * 1024 * 1024,
  expandedBytes: 64 * 1024 * 1024,
  entries: 2048,
  timeoutMs: 10_000,
};

function checkDirectory(buffer: Buffer): void {
  // Count actual central-directory records before JSZip allocates its entry map.
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (
      buffer.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + buffer.readUInt16LE(i + 20) === buffer.length
    ) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("Invalid document archive directory");
  const count = buffer.readUInt16LE(end + 10);
  const size = buffer.readUInt32LE(end + 12);
  const offset = buffer.readUInt32LE(end + 16);
  if (
    buffer.readUInt16LE(end + 4) ||
    buffer.readUInt16LE(end + 6) ||
    count !== buffer.readUInt16LE(end + 8) ||
    count > DOCUMENT_ARCHIVE_LIMITS.entries ||
    size === 0xffffffff ||
    offset === 0xffffffff ||
    offset + size !== end
  ) {
    throw new Error("Document archive directory exceeds limits or uses unsupported ZIP layout");
  }
  let cursor = offset;
  let actual = 0;
  while (cursor < end) {
    if (
      cursor + 46 > end ||
      buffer.readUInt32LE(cursor) !== 0x02014b50 ||
      ++actual > DOCUMENT_ARCHIVE_LIMITS.entries
    )
      throw new Error("Invalid document archive entries");
    cursor +=
      46 +
      buffer.readUInt16LE(cursor + 28) +
      buffer.readUInt16LE(cursor + 30) +
      buffer.readUInt16LE(cursor + 32);
  }
  if (cursor !== end || actual !== count) throw new Error("Invalid document archive entry count");
}

/** Check actual inflated bytes, including parts subsequently consumed by Mammoth or writers. */
export async function loadDocumentArchive(buffer: Buffer): Promise<JSZip> {
  if (buffer.length > DOCUMENT_ARCHIVE_LIMITS.inputBytes)
    throw new Error("Document archive input exceeds limit");
  checkDirectory(buffer);
  const zip = await JSZip.loadAsync(buffer);
  let total = 0;
  const deadline = Date.now() + DOCUMENT_ARCHIVE_LIMITS.timeoutMs;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    await new Promise<void>((resolve, reject) => {
      const stream = entry.nodeStream("nodebuffer") as Readable;
      let bytes = 0;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          stream.destroy();
          reject(error);
        } else resolve();
      };
      const timer = setTimeout(
        () => finish(new Error("Document archive expansion timed out")),
        Math.max(1, deadline - Date.now()),
      );
      stream.on("data", (chunk: Uint8Array) => {
        if (settled) return;
        bytes += chunk.byteLength;
        total += chunk.byteLength;
        if (
          bytes > DOCUMENT_ARCHIVE_LIMITS.entryBytes ||
          total > DOCUMENT_ARCHIVE_LIMITS.expandedBytes ||
          Date.now() > deadline
        ) {
          finish(new Error("Document archive expansion exceeds limit"));
        }
      });
      stream.on("error", (error: Error) => finish(error));
      stream.on("end", () => finish());
      stream.resume();
    });
  }
  return zip;
}

export async function readDocumentArchiveBuffer(filePath: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    bytes += chunk.length;
    if (bytes > DOCUMENT_ARCHIVE_LIMITS.inputBytes)
      throw new Error("Document archive input exceeds limit");
    chunks.push(chunk as Buffer);
  }
  const buffer = Buffer.concat(chunks);
  await loadDocumentArchive(buffer);
  return buffer;
}
