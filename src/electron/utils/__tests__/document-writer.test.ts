import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { buildDocumentPreviewFromFile } from "../document-preview";
import { writeEditableDocumentBlocksToDocxFile } from "../document-writer";

describe("document writer", () => {
  it("writes editable document blocks back to DOCX", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-docx-write-"));
    const outPath = path.join(tmpDir, "edited.docx");

    await writeEditableDocumentBlocksToDocxFile(outPath, [
      { type: "heading", level: 1, runs: [{ text: "Edited Document", bold: true }] },
      {
        type: "paragraph",
        runs: [
          { text: "This paragraph was " },
          { text: "saved", bold: true },
          { text: " from the in-app editor." },
        ],
      },
      { type: "bullet", runs: [{ text: "First item" }] },
      { type: "numbered", runs: [{ text: "Numbered item" }] },
    ]);

    const preview = await buildDocumentPreviewFromFile(outPath);

    expect(preview.text).toContain("Edited Document");
    expect(preview.text).toContain("saved");
    expect(preview.text).toContain("First item");
    expect(preview.text).toContain("Numbered item");
    expect(preview.canEdit).toBe(true);
  });

  it("preserves existing DOCX package parts when editing parsed blocks", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-docx-preserve-"));
    const outPath = path.join(tmpDir, "existing.docx");

    await writeEditableDocumentBlocksToDocxFile(outPath, [
      { type: "heading", level: 1, runs: [{ text: "Original Title" }] },
      { type: "paragraph", runs: [{ text: "Original paragraph" }] },
    ]);

    const beforeZip = await JSZip.loadAsync(await fs.readFile(outPath));
    beforeZip.file("word/header1.xml", "<w:hdr>Keep this header part</w:hdr>");
    await fs.writeFile(outPath, await beforeZip.generateAsync({ type: "nodebuffer" }));

    const preview = await buildDocumentPreviewFromFile(outPath);
    const blocks = preview.blocks || [];
    await writeEditableDocumentBlocksToDocxFile(
      outPath,
      blocks.map((block) => ({
        ...block,
        runs: [{ text: block.type === "paragraph" ? "Updated paragraph" : block.text }],
      })),
    );

    const afterZip = await JSZip.loadAsync(await fs.readFile(outPath));
    const afterPreview = await buildDocumentPreviewFromFile(outPath);
    expect(await afterZip.file("word/header1.xml")?.async("text")).toContain("Keep this header part");
    expect(afterPreview.text).toContain("Original Title");
    expect(afterPreview.text).toContain("Updated paragraph");
  });

  it("preserves existing DOCX text runs when saving unchanged formatted text", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-docx-runs-"));
    const outPath = path.join(tmpDir, "formatted.docx");

    await writeEditableDocumentBlocksToDocxFile(outPath, [
      {
        type: "paragraph",
        runs: [
          { text: "Plain " },
          { text: "bold", bold: true },
          { text: " tail" },
        ],
      },
    ]);

    const preview = await buildDocumentPreviewFromFile(outPath);
    await writeEditableDocumentBlocksToDocxFile(
      outPath,
      (preview.blocks || []).map((block) => ({ ...block, runs: [{ text: block.text }] })),
    );

    const afterZip = await JSZip.loadAsync(await fs.readFile(outPath));
    const documentXml = await afterZip.file("word/document.xml")?.async("text");
    const textNodes = Array.from(documentXml?.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g) || [])
      .map((match) => match[1]);
    expect(textNodes).toEqual(expect.arrayContaining(["Plain ", "bold", " tail"]));
  });

  it("inserts new DOCX blocks at their edited position", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-docx-insert-"));
    const outPath = path.join(tmpDir, "insert.docx");

    await writeEditableDocumentBlocksToDocxFile(outPath, [
      { type: "paragraph", runs: [{ text: "First paragraph" }] },
      { type: "paragraph", runs: [{ text: "Second paragraph" }] },
    ]);

    const preview = await buildDocumentPreviewFromFile(outPath);
    const blocks = preview.blocks || [];
    await writeEditableDocumentBlocksToDocxFile(outPath, [
      { ...blocks[0], runs: [{ text: blocks[0].text }] },
      { type: "paragraph", runs: [{ text: "Inserted paragraph" }] },
      { ...blocks[1], runs: [{ text: blocks[1].text }] },
    ]);

    const afterPreview = await buildDocumentPreviewFromFile(outPath);
    expect(afterPreview.text.indexOf("Inserted paragraph")).toBeLessThan(
      afterPreview.text.indexOf("Second paragraph"),
    );
  });
});
