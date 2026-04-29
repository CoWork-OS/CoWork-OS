import * as fs from "fs/promises";
import JSZip from "jszip";
import {
  AlignmentType,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
} from "docx";
import type {
  EditableDocumentBlock,
  EditableDocumentRun,
} from "../../shared/document-preview";
import { parseDocxBlocksFromXml } from "../documents/docx-blocks";

function textFromRuns(runs: EditableDocumentRun[] | undefined, fallback = ""): string {
  const text = runs?.map((run) => run.text).join("") ?? "";
  return text || fallback;
}

function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function decodeXmlText(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function blockPlainText(block: EditableDocumentBlock): string {
  if (block.type === "table") {
    return (block.rows || []).map((row) => row.join("\t")).join("\n");
  }
  return textFromRuns(block.runs, block.text || "");
}

function buildTextRuns(runs: EditableDocumentRun[] | undefined, fallback = ""): TextRun[] {
  const source = runs && runs.length > 0 ? runs : [{ text: fallback }];
  const textRuns = source
    .filter((run) => run.text.length > 0)
    .map((run) =>
      new TextRun({
        text: run.text,
        bold: run.bold,
        italics: run.italic,
        underline: run.underline ? {} : undefined,
      }),
    );
  return textRuns.length > 0 ? textRuns : [new TextRun("")];
}

function headingLevel(level: number | undefined): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
  if (level === 1) return HeadingLevel.HEADING_1;
  if (level === 2) return HeadingLevel.HEADING_2;
  if (level === 3) return HeadingLevel.HEADING_3;
  if (level === 4) return HeadingLevel.HEADING_4;
  if (level === 5) return HeadingLevel.HEADING_5;
  return HeadingLevel.HEADING_6;
}

function blockToParagraphs(block: EditableDocumentBlock): Array<Paragraph | Table> {
  if (block.type === "table") {
    const rows = block.rows || [];
    if (rows.length === 0) return [];
    return [
      new Table({
        rows: rows.map(
          (row) =>
            new TableRow({
              children: row.map(
                (cell) =>
                  new TableCell({
                    children: [new Paragraph(cell || "")],
                  }),
              ),
            }),
        ),
      }),
    ];
  }

  const children = buildTextRuns(block.runs, block.text);
  if (block.type === "heading") {
    return [
      new Paragraph({
        heading: headingLevel(block.level),
        children,
      }),
    ];
  }

  if (block.type === "bullet") {
    return [
      new Paragraph({
        children,
        bullet: { level: 0 },
      }),
    ];
  }

  if (block.type === "numbered") {
    return [
      new Paragraph({
        children,
        numbering: { reference: "default-numbering", level: 0 },
      }),
    ];
  }

  const text = textFromRuns(block.runs, block.text);
  return [
    new Paragraph({
      alignment: text.trim().length === 0 ? AlignmentType.LEFT : undefined,
      children,
    }),
  ];
}

function replaceTextRunsInXml(xml: string, text: string): string {
  const textMatches = Array.from(xml.matchAll(/<w:t\b([^>]*)>([\s\S]*?)<\/w:t>/g));
  if (textMatches.length === 0) return xml;

  const originalLengths = textMatches.map((match) => decodeXmlText(match[2] || "").length);
  const totalOriginalLength = originalLengths.reduce((sum, length) => sum + length, 0);
  let offset = 0;
  let index = 0;

  return xml.replace(/<w:t\b([^>]*)>[\s\S]*?<\/w:t>/g, (_match, attrs: string) => {
    const isLast = index === textMatches.length - 1;
    const length = totalOriginalLength > 0
      ? originalLengths[index] + (isLast ? Math.max(0, text.length - totalOriginalLength) : 0)
      : isLast
      ? text.length
      : 0;
    const nextText = text.slice(offset, offset + length);
    offset += length;
    index += 1;
    const needsPreserve = /^\s|\s$/.test(nextText);
    const normalizedAttrs = needsPreserve && !/\bxml:space=/.test(attrs)
      ? `${attrs} xml:space="preserve"`
      : attrs;
    return `<w:t${normalizedAttrs}>${escapeXmlText(nextText)}</w:t>`;
  });
}

function replaceTableCellsInXml(xml: string, rows: string[][]): string {
  let rowIndex = 0;
  return xml.replace(/<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/g, (rowXml) => {
    const row = rows[rowIndex++] || [];
    let cellIndex = 0;
    return rowXml.replace(/<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g, (cellXml) => {
      const text = row[cellIndex++] || "";
      return replaceTextRunsInXml(cellXml, text);
    });
  });
}

function createParagraphXml(block: EditableDocumentBlock): string {
  const text = escapeXmlText(blockPlainText(block));
  const heading =
    block.type === "heading" && block.level
      ? `<w:pPr><w:pStyle w:val="Heading${Math.min(Math.max(block.level, 1), 6)}"/></w:pPr>`
      : "";
  return `<w:p>${heading}<w:r><w:t>${text}</w:t></w:r></w:p>`;
}

function createTableXml(block: EditableDocumentBlock): string {
  const rows = block.rows || [];
  return `<w:tbl>${rows
    .map((row) =>
      `<w:tr>${row
        .map((cell) => `<w:tc><w:p><w:r><w:t>${escapeXmlText(cell)}</w:t></w:r></w:p></w:tc>`)
        .join("")}</w:tr>`,
    )
    .join("")}</w:tbl>`;
}

function createBlockXml(block: EditableDocumentBlock): string {
  if (block.type === "table") return createTableXml(block);
  return createParagraphXml(block);
}

function updateExistingBlockXml(originalXml: string, block: EditableDocumentBlock): string {
  if (block.type === "table") {
    return replaceTableCellsInXml(originalXml, block.rows || []);
  }
  return replaceTextRunsInXml(originalXml, blockPlainText(block));
}

async function patchExistingDocxBlocks(
  filePath: string,
  blocks: EditableDocumentBlock[],
): Promise<boolean> {
  const blocksById = new Map(blocks.filter((block) => block.id).map((block) => [block.id!, block]));
  if (blocksById.size === 0) return false;

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(filePath);
  } catch {
    return false;
  }

  const zip = await JSZip.loadAsync(buffer);
  const documentFile = zip.file("word/document.xml");
  if (!documentFile) {
    throw new Error("Invalid DOCX file: missing word/document.xml");
  }
  const documentXml = await documentFile.async("text");
  const originalBlocks = parseDocxBlocksFromXml(documentXml);
  const originalIds = new Set(originalBlocks.map((block) => block.id));
  const newBlocksBefore = new Map<string, EditableDocumentBlock[]>();
  let pendingNewBlocks: EditableDocumentBlock[] = [];
  for (const block of blocks) {
    if (block.id && originalIds.has(block.id)) {
      if (pendingNewBlocks.length > 0) {
        newBlocksBefore.set(block.id, pendingNewBlocks);
        pendingNewBlocks = [];
      }
      continue;
    }
    pendingNewBlocks.push(block);
  }

  let nextXml = "";
  let cursor = 0;
  for (const original of [...originalBlocks].sort((a, b) => a.startIndex - b.startIndex)) {
    nextXml += documentXml.slice(cursor, original.startIndex);
    const insertedBefore = newBlocksBefore.get(original.id) || [];
    nextXml += insertedBefore
      .filter((block) => block.type === "table" || blockPlainText(block).trim().length > 0)
      .map(createBlockXml)
      .join("");
    const edited = blocksById.get(original.id);
    if (edited) {
      nextXml += updateExistingBlockXml(original.xml, edited);
    }
    cursor = original.endIndex;
  }
  nextXml += documentXml.slice(cursor);

  const appendedXml = pendingNewBlocks
    .filter((block) => block.type === "table" || blockPlainText(block).trim().length > 0)
    .map(createBlockXml)
    .join("");
  if (appendedXml) {
    const sectPrIndex = nextXml.search(/<w:sectPr\b/);
    if (sectPrIndex >= 0) {
      nextXml = `${nextXml.slice(0, sectPrIndex)}${appendedXml}${nextXml.slice(sectPrIndex)}`;
    } else {
      nextXml = nextXml.replace("</w:body>", `${appendedXml}</w:body>`);
    }
  }

  zip.file("word/document.xml", nextXml);
  const output = await zip.generateAsync({ type: "nodebuffer" });
  await fs.writeFile(filePath, output);
  return true;
}

export async function writeEditableDocumentBlocksToDocxFile(
  filePath: string,
  blocks: EditableDocumentBlock[],
): Promise<void> {
  if (await patchExistingDocxBlocks(filePath, blocks)) {
    return;
  }

  const children = blocks.flatMap(blockToParagraphs);
  const document = new Document({
    numbering: {
      config: [
        {
          reference: "default-numbering",
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: "%1.",
              alignment: AlignmentType.LEFT,
            },
          ],
        },
      ],
    },
    sections: [
      {
        children: children.length > 0 ? children : [new Paragraph("")],
      },
    ],
  });
  const buffer = await Packer.toBuffer(document);
  await fs.writeFile(filePath, buffer);
}
