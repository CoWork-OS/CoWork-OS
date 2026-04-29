import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import JSZip from "jszip";
import { Document, Packer, Paragraph, Table, TableCell, TableRow } from "docx";
import { describe, expect, it } from "vitest";

import { buildDocumentPreviewFromFile } from "../document-preview";

describe("document preview extraction", () => {
  it("extracts DOCX HTML, text, and editable block metadata", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-docx-preview-"));
    const outPath = path.join(tmpDir, "sample.docx");
    const doc = new Document({
      sections: [
        {
          children: [
            new Paragraph({ text: "Sample Document", heading: "Heading1" }),
            new Paragraph("First paragraph."),
            new Table({
              rows: [
                new TableRow({
                  children: [
                    new TableCell({ children: [new Paragraph("Name")] }),
                    new TableCell({ children: [new Paragraph("Status")] }),
                  ],
                }),
              ],
            }),
          ],
        },
      ],
    });
    await fs.writeFile(outPath, await Packer.toBuffer(doc));

    const preview = await buildDocumentPreviewFromFile(outPath);

    expect(preview.format).toBe("DOCX");
    expect(preview.previewMode).toBe("html");
    expect(preview.text).toContain("Sample Document");
    expect(preview.htmlContent).toContain("Sample Document");
    expect(preview.canEdit).toBe(true);
    expect(preview.blocks?.some((block) => block.type === "table")).toBe(true);
  });

  it("extracts readable text from RTF", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-rtf-preview-"));
    const outPath = path.join(tmpDir, "sample.rtf");
    await fs.writeFile(outPath, "{\\rtf1\\ansi Hello\\par World}", "utf-8");

    const preview = await buildDocumentPreviewFromFile(outPath);

    expect(preview.format).toBe("RTF");
    expect(preview.previewMode).toBe("text");
    expect(preview.text).toContain("Hello");
    expect(preview.text).toContain("World");
    expect(preview.canEdit).toBe(false);
  });

  it("extracts text from ODT content.xml", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-odt-preview-"));
    const outPath = path.join(tmpDir, "sample.odt");
    const zip = new JSZip();
    zip.file(
      "content.xml",
      `<?xml version="1.0" encoding="UTF-8"?>
      <office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
        <office:body><office:text><text:h>ODT Title</text:h><text:p>OpenDocument paragraph.</text:p></office:text></office:body>
      </office:document-content>`,
    );
    await fs.writeFile(outPath, await zip.generateAsync({ type: "nodebuffer" }));

    const preview = await buildDocumentPreviewFromFile(outPath);

    expect(preview.format).toBe("ODT");
    expect(preview.previewMode).toBe("text");
    expect(preview.text).toContain("ODT Title");
    expect(preview.text).toContain("OpenDocument paragraph.");
  });

  it("returns structured unavailable metadata for DOC when no converter works", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-doc-preview-"));
    const outPath = path.join(tmpDir, "legacy.doc");
    await fs.writeFile(outPath, "legacy binary placeholder", "utf-8");

    const preview = await buildDocumentPreviewFromFile(outPath, {
      runCommand: async () => {
        throw new Error("converter missing");
      },
    });

    expect(preview.format).toBe("DOC");
    expect(preview.previewMode).toBe("unavailable");
    expect(preview.conversionStatus).toBe("unavailable");
    expect(preview.conversionMessage).toContain("legacy Word");
  });
});
