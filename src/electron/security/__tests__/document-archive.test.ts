import { afterEach, describe, expect, it } from "vitest";
import JSZip from "jszip";
import { DOCUMENT_ARCHIVE_LIMITS, loadDocumentArchive } from "../document-archive";
const original = { ...DOCUMENT_ARCHIVE_LIMITS };
afterEach(() => Object.assign(DOCUMENT_ARCHIVE_LIMITS, original));
async function archive(parts: string[]) {
  const zip = new JSZip();
  parts.forEach((part, i) => zip.file(`part${i}.xml`, part));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
describe("bounded document expansion", () => {
  it("retains ordinary parts", async () => {
    const zip = await loadDocumentArchive(await archive(["<text>Hello</text>"]));
    expect(await zip.file("part0.xml")!.async("string")).toBe("<text>Hello</text>");
  });
  it("rejects actual per-entry expansion before returning a parser input", async () => {
    DOCUMENT_ARCHIVE_LIMITS.entryBytes = 1024;
    await expect(loadDocumentArchive(await archive(["A".repeat(100_000)]))).rejects.toThrow(
      "expansion exceeds",
    );
  });
  it("rejects aggregate expansion and entry count independently", async () => {
    DOCUMENT_ARCHIVE_LIMITS.expandedBytes = 1500;
    await expect(
      loadDocumentArchive(await archive(["A".repeat(1000), "B".repeat(1000)])),
    ).rejects.toThrow("expansion exceeds");
    DOCUMENT_ARCHIVE_LIMITS.entries = 1;
    await expect(loadDocumentArchive(await archive(["a", "b"]))).rejects.toThrow(
      "directory exceeds",
    );
  });
  it("does not trust forged directory sizes or counts", async () => {
    const buffer = await archive(["A".repeat(100_000)]);
    const central = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    buffer.writeUInt32LE(1, central + 24);
    DOCUMENT_ARCHIVE_LIMITS.entryBytes = 1024;
    await expect(loadDocumentArchive(buffer)).rejects.toThrow();
    const ordinary = await archive(["a", "b"]);
    ordinary.writeUInt16LE(1, ordinary.length - 12);
    ordinary.writeUInt16LE(1, ordinary.length - 14);
    await expect(loadDocumentArchive(ordinary)).rejects.toThrow("entry count");
  });
});
