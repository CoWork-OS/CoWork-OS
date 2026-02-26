import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType as _AlignmentType,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
} from "docx";
import PDFDocument from "pdfkit";
import * as mammoth from "mammoth";
import JSZip from "jszip";
import { Workspace } from "../../../shared/types";

export interface ContentBlock {
  type: string; // 'heading' | 'paragraph' | 'list' | 'table' | 'code'
  text: string;
  level?: number; // For headings: 1-6
  items?: string[]; // For lists
  rows?: string[][]; // For tables
  language?: string; // For code blocks
}

export interface DocumentOptions {
  title?: string;
  author?: string;
  subject?: string;
  /** Font size in points (default: 12) */
  fontSize?: number;
  /** Page margins in inches */
  margins?: {
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
  };
}

/**
 * Represents a document section identified by a heading
 */
interface DocumentSection {
  headingLevel: number;
  headingText: string;
  sectionNumber?: string;
  startIndex: number;
  endIndex: number;
  xmlContent: string;
}

/**
 * DocumentBuilder creates Word documents (.docx) and PDFs using docx and pdfkit
 */
export class DocumentBuilder {
  constructor(private workspace: Workspace) {}

  async create(
    outputPath: string,
    format: "docx" | "pdf" | "md",
    content: ContentBlock[] | ContentBlock | string | undefined,
    options: DocumentOptions = {},
  ): Promise<void> {
    // Normalize content to always be an array
    const normalizedContent = this.normalizeContent(content);
    const ext = path.extname(outputPath).toLowerCase();

    // Allow format override via extension
    if (ext === ".md" || format === "md") {
      await this.createMarkdown(outputPath, normalizedContent);
      return;
    }

    if (ext === ".pdf" || format === "pdf") {
      await this.createPDF(outputPath, normalizedContent, options);
      return;
    }

    // Default to Word document
    await this.createDocx(outputPath, normalizedContent, options);
  }

  /**
   * Normalizes content input to always be an array of ContentBlocks
   * Throws an error if content is empty or invalid to prevent creating empty documents
   */
  private normalizeContent(
    content: ContentBlock[] | ContentBlock | string | undefined,
  ): ContentBlock[] {
    // Handle undefined/null - FAIL instead of creating empty document
    if (!content) {
      throw new Error(
        "Document content is required. Please provide content as an array of blocks " +
          '(e.g., [{ type: "paragraph", text: "Your text here" }]) or as a string.',
      );
    }

    // Handle string input - convert to a single paragraph
    if (typeof content === "string") {
      if (content.trim().length === 0) {
        throw new Error("Document content cannot be empty. Please provide text content.");
      }
      return [{ type: "paragraph", text: content }];
    }

    // Handle single object (not an array)
    if (!Array.isArray(content)) {
      if (!content.text || content.text.trim().length === 0) {
        throw new Error(
          "Content block must have non-empty text. " +
            `Received block with type "${content.type}" but empty or missing text.`,
        );
      }
      return [content];
    }

    // Already an array - ensure it's not empty
    if (content.length === 0) {
      throw new Error(
        "Document content array cannot be empty. " +
          'Please provide at least one content block (e.g., [{ type: "paragraph", text: "Your text" }]).',
      );
    }

    // Validate each block has content
    const emptyBlocks = content.filter((block) => !block.text || block.text.trim().length === 0);
    if (emptyBlocks.length > 0) {
      console.warn(
        `[DocumentBuilder] Found ${emptyBlocks.length} empty content blocks, filtering them out`,
      );
      const validBlocks = content.filter((block) => block.text && block.text.trim().length > 0);
      if (validBlocks.length === 0) {
        throw new Error(
          "All content blocks have empty text. Please provide content blocks with actual text. " +
            `Received ${content.length} blocks but all had empty or missing text fields.`,
        );
      }
      return validBlocks;
    }

    return content;
  }

  /**
   * Creates a Word document (.docx)
   */
  private async createDocx(
    outputPath: string,
    content: ContentBlock[],
    options: DocumentOptions,
  ): Promise<void> {
    const children: Paragraph[] = [];

    for (const block of content) {
      switch (block.type) {
        case "heading": {
          const level = Math.min(Math.max(block.level || 1, 1), 6);
          const headingLevel = this.getHeadingLevel(level);
          children.push(
            new Paragraph({
              text: block.text,
              heading: headingLevel,
              spacing: { before: 240, after: 120 },
            }),
          );
          break;
        }

        case "paragraph":
          children.push(
            new Paragraph({
              children: [new TextRun({ text: block.text, size: (options.fontSize || 12) * 2 })],
              spacing: { after: 200 },
            }),
          );
          break;

        case "list": {
          const items = block.items || block.text.split("\n").filter((line) => line.trim());
          for (const item of items) {
            children.push(
              new Paragraph({
                children: [new TextRun({ text: item, size: (options.fontSize || 12) * 2 })],
                bullet: { level: 0 },
                spacing: { after: 100 },
              }),
            );
          }
          break;
        }

        case "table": {
          if (block.rows && block.rows.length > 0) {
            const table = new Table({
              width: { size: 100, type: WidthType.PERCENTAGE },
              rows: block.rows.map(
                (row, rowIndex) =>
                  new TableRow({
                    children: row.map(
                      (cell) =>
                        new TableCell({
                          children: [
                            new Paragraph({
                              children: [
                                new TextRun({
                                  text: cell,
                                  bold: rowIndex === 0,
                                  size: (options.fontSize || 12) * 2,
                                }),
                              ],
                            }),
                          ],
                          borders: {
                            top: { style: BorderStyle.SINGLE, size: 1 },
                            bottom: { style: BorderStyle.SINGLE, size: 1 },
                            left: { style: BorderStyle.SINGLE, size: 1 },
                            right: { style: BorderStyle.SINGLE, size: 1 },
                          },
                        }),
                    ),
                  }),
              ),
            });
            children.push(new Paragraph({ children: [] })); // Spacing before table
            children.push(table as Any);
            children.push(new Paragraph({ children: [] })); // Spacing after table
          }
          break;
        }

        case "code":
          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: block.text,
                  font: "Courier New",
                  size: 20, // 10pt
                  shading: { fill: "F0F0F0" },
                }),
              ],
              spacing: { before: 200, after: 200 },
            }),
          );
          break;

        default:
          children.push(
            new Paragraph({
              children: [new TextRun({ text: block.text, size: (options.fontSize || 12) * 2 })],
            }),
          );
      }
    }

    const doc = new Document({
      creator: options.author || "CoWork OS",
      title: options.title,
      subject: options.subject,
      sections: [
        {
          properties: {
            page: {
              margin: {
                top: (options.margins?.top || 1) * 1440, // Convert inches to twips
                bottom: (options.margins?.bottom || 1) * 1440,
                left: (options.margins?.left || 1) * 1440,
                right: (options.margins?.right || 1) * 1440,
              },
            },
          },
          children,
        },
      ],
    });

    const buffer = await Packer.toBuffer(doc);
    await fsPromises.writeFile(outputPath, buffer);
  }

  /**
   * Creates a PDF document
   */
  private async createPDF(
    outputPath: string,
    content: ContentBlock[],
    options: DocumentOptions,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        size: "LETTER",
        margins: {
          top: (options.margins?.top || 1) * 72,
          bottom: (options.margins?.bottom || 1) * 72,
          left: (options.margins?.left || 1) * 72,
          right: (options.margins?.right || 1) * 72,
        },
        info: {
          Title: options.title || "",
          Author: options.author || "CoWork OS",
          Subject: options.subject || "",
        },
      });

      const stream = fs.createWriteStream(outputPath);
      doc.pipe(stream);

      const baseFontSize = options.fontSize || 12;

      for (const block of content) {
        switch (block.type) {
          case "heading": {
            const level = Math.min(Math.max(block.level || 1, 1), 6);
            const fontSize = baseFontSize + (7 - level) * 2; // h1 = base+12, h6 = base+2
            doc.font("Helvetica-Bold").fontSize(fontSize).text(block.text, { paragraphGap: 10 });
            doc.moveDown(0.5);
            break;
          }

          case "paragraph":
            doc
              .font("Helvetica")
              .fontSize(baseFontSize)
              .text(block.text, { paragraphGap: 8, lineGap: 4 });
            doc.moveDown(0.5);
            break;

          case "list": {
            const items = block.items || block.text.split("\n").filter((line) => line.trim());
            doc.font("Helvetica").fontSize(baseFontSize);
            for (const item of items) {
              doc.text(`• ${item}`, { indent: 20, paragraphGap: 4 });
            }
            doc.moveDown(0.5);
            break;
          }

          case "table": {
            if (block.rows && block.rows.length > 0) {
              doc.font("Helvetica").fontSize(baseFontSize - 1);
              const columnCount = block.rows[0].length;
              const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
              const colWidth = pageWidth / columnCount;

              for (let rowIndex = 0; rowIndex < block.rows.length; rowIndex++) {
                const row = block.rows[rowIndex];
                const startY = doc.y;

                // Draw cells
                for (let colIndex = 0; colIndex < row.length; colIndex++) {
                  const x = doc.page.margins.left + colIndex * colWidth;
                  doc.font(rowIndex === 0 ? "Helvetica-Bold" : "Helvetica");
                  doc.text(row[colIndex], x, startY, {
                    width: colWidth - 10,
                    continued: false,
                  });
                }

                // Draw horizontal line
                doc
                  .moveTo(doc.page.margins.left, doc.y + 5)
                  .lineTo(doc.page.margins.left + pageWidth, doc.y + 5)
                  .stroke();

                doc.moveDown(0.3);
              }
              doc.moveDown(0.5);
            }
            break;
          }

          case "code":
            doc
              .font("Courier")
              .fontSize(baseFontSize - 2)
              .fillColor("#333333")
              .text(block.text, { paragraphGap: 8 });
            doc.fillColor("#000000");
            doc.moveDown(0.5);
            break;

          default:
            doc.font("Helvetica").fontSize(baseFontSize).text(block.text);
            doc.moveDown(0.5);
        }
      }

      doc.end();

      stream.on("finish", resolve);
      stream.on("error", reject);
    });
  }

  /**
   * Creates a Markdown document (fallback)
   */
  private async createMarkdown(outputPath: string, content: ContentBlock[]): Promise<void> {
    const markdown = content
      .map((block) => {
        switch (block.type) {
          case "heading": {
            const level = Math.min(Math.max(block.level || 1, 1), 6);
            return `${"#".repeat(level)} ${block.text}\n`;
          }
          case "paragraph":
            return `${block.text}\n`;
          case "list": {
            const items = block.items || block.text.split("\n").filter((line) => line.trim());
            return items.map((item) => `- ${item}`).join("\n") + "\n";
          }
          case "table": {
            if (!block.rows || block.rows.length === 0) return "";
            const header = block.rows[0];
            const separator = header.map(() => "---").join(" | ");
            const _rows = block.rows.map((row) => row.join(" | ")).join("\n");
            return `${header.join(" | ")}\n${separator}\n${block.rows
              .slice(1)
              .map((row) => row.join(" | "))
              .join("\n")}\n`;
          }
          case "code":
            return `\`\`\`${block.language || ""}\n${block.text}\n\`\`\`\n`;
          default:
            return `${block.text}\n`;
        }
      })
      .join("\n");

    await fsPromises.writeFile(outputPath, markdown, "utf-8");
  }

  private getHeadingLevel(level: number): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
    switch (level) {
      case 1:
        return HeadingLevel.HEADING_1;
      case 2:
        return HeadingLevel.HEADING_2;
      case 3:
        return HeadingLevel.HEADING_3;
      case 4:
        return HeadingLevel.HEADING_4;
      case 5:
        return HeadingLevel.HEADING_5;
      case 6:
        return HeadingLevel.HEADING_6;
      default:
        return HeadingLevel.HEADING_1;
    }
  }

  /**
   * Reads an existing DOCX file and extracts its content as HTML
   */
  async readDocument(
    inputPath: string,
  ): Promise<{ html: string; text: string; messages: string[] }> {
    const buffer = await fsPromises.readFile(inputPath);
    const result = await mammoth.convertToHtml({ buffer });
    const textResult = await mammoth.extractRawText({ buffer });

    return {
      html: result.value,
      text: textResult.value,
      messages: result.messages.map((m) => m.message),
    };
  }

  /**
   * Appends new content sections to an existing DOCX file.
   * This method directly manipulates the DOCX XML structure to preserve
   * the original document formatting while adding new content at the end.
   */
  async appendToDocument(
    inputPath: string,
    outputPath: string,
    newContent: ContentBlock[],
    _options: DocumentOptions = {},
  ): Promise<{ success: boolean; sectionsAdded: number }> {
    console.log(
      `[DocumentBuilder] appendToDocument: ${inputPath} -> ${outputPath}, ${newContent.length} blocks`,
    );

    // Read the DOCX file as a ZIP
    const docxBuffer = await fsPromises.readFile(inputPath);
    const zip = await JSZip.loadAsync(docxBuffer);

    // Get the main document.xml
    const documentXml = zip.file("word/document.xml");
    if (!documentXml) {
      throw new Error("Invalid DOCX file: missing word/document.xml");
    }

    let xmlContent = await documentXml.async("text");

    // Generate OOXML for the new content
    const newXmlContent = this.contentBlocksToOoxml(newContent);

    // Find the insertion point - before </w:body> or before <w:sectPr
    // The sectPr element contains section properties and must stay at the end
    const sectPrMatch = xmlContent.match(/<w:sectPr[^>]*>[\s\S]*?<\/w:sectPr>/);
    const bodyEndMatch = xmlContent.match(/<\/w:body>/);

    if (sectPrMatch && sectPrMatch.index !== undefined) {
      // Insert before sectPr
      xmlContent =
        xmlContent.slice(0, sectPrMatch.index) +
        newXmlContent +
        xmlContent.slice(sectPrMatch.index);
      console.log(`[DocumentBuilder] Inserted content before <w:sectPr>`);
    } else if (bodyEndMatch && bodyEndMatch.index !== undefined) {
      // Insert before </w:body>
      xmlContent =
        xmlContent.slice(0, bodyEndMatch.index) +
        newXmlContent +
        xmlContent.slice(bodyEndMatch.index);
      console.log(`[DocumentBuilder] Inserted content before </w:body>`);
    } else {
      throw new Error("Could not find insertion point in document.xml");
    }

    // Update the document.xml in the ZIP
    zip.file("word/document.xml", xmlContent);

    // Write the modified DOCX
    const outputBuffer = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    });
    await fsPromises.writeFile(outputPath, outputBuffer);

    console.log(
      `[DocumentBuilder] Successfully appended ${newContent.length} sections to ${outputPath}`,
    );

    return {
      success: true,
      sectionsAdded: newContent.length,
    };
  }

  /**
   * Converts ContentBlocks to OOXML (Office Open XML) format
   * This creates proper Word paragraph/table elements
   */
  private contentBlocksToOoxml(blocks: ContentBlock[]): string {
    const xmlParts: string[] = [];

    for (const block of blocks) {
      switch (block.type) {
        case "heading": {
          const level = Math.min(Math.max(block.level || 1, 1), 6);
          // Word heading styles are "Heading1" through "Heading6"
          const styleId = `Heading${level}`;
          xmlParts.push(this.createOoxmlParagraph(block.text, styleId));
          break;
        }

        case "paragraph":
          xmlParts.push(this.createOoxmlParagraph(block.text));
          break;

        case "list": {
          const items = block.items || block.text.split("\n").filter((line) => line.trim());
          for (const item of items) {
            xmlParts.push(this.createOoxmlListItem(item));
          }
          break;
        }

        case "table": {
          if (block.rows && block.rows.length > 0) {
            xmlParts.push(this.createOoxmlTable(block.rows));
          }
          break;
        }

        default:
          xmlParts.push(this.createOoxmlParagraph(block.text));
      }
    }

    return xmlParts.join("\n");
  }

  /**
   * Creates an OOXML paragraph element
   */
  private createOoxmlParagraph(text: string, styleId?: string): string {
    const escapedText = this.escapeXml(text);
    const styleXml = styleId ? `<w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>` : "";
    return `<w:p>${styleXml}<w:r><w:t>${escapedText}</w:t></w:r></w:p>`;
  }

  /**
   * Creates an OOXML list item (bullet point)
   */
  private createOoxmlListItem(text: string): string {
    const escapedText = this.escapeXml(text);
    // Simple bullet using a bullet character - more compatible than numPr
    return `<w:p><w:pPr><w:ind w:left="720"/></w:pPr><w:r><w:t>• ${escapedText}</w:t></w:r></w:p>`;
  }

  /**
   * Creates an OOXML table element
   */
  private createOoxmlTable(rows: string[][]): string {
    const tableRows = rows
      .map((row, rowIndex) => {
        const cells = row
          .map((cellText) => {
            const escapedText = this.escapeXml(cellText);
            const boldStyle = rowIndex === 0 ? "<w:rPr><w:b/></w:rPr>" : "";
            return `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/><w:tcBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/></w:tcBorders></w:tcPr><w:p><w:r>${boldStyle}<w:t>${escapedText}</w:t></w:r></w:p></w:tc>`;
          })
          .join("");
        return `<w:tr>${cells}</w:tr>`;
      })
      .join("");

    return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>${tableRows}</w:tbl>`;
  }

  /**
   * Escapes special XML characters
   */
  private escapeXml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  /**
   * Parses the document.xml content and identifies sections based on headings.
   * Sections are delimited by heading paragraphs (Heading1, Heading2, etc.)
   */
  private parseSections(xmlContent: string): DocumentSection[] {
    const sections: DocumentSection[] = [];

    // Find all paragraphs that are headings (have w:pStyle with Heading1-6)
    // Pattern: <w:p ...>...<w:pStyle w:val="Heading[1-6]"/>...</w:p>
    const paragraphRegex = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
    const headingStyleRegex = /<w:pStyle\s+w:val="Heading([1-6])"\s*\/>/;
    const _textRegex = /<w:t[^>]*>([^<]*)<\/w:t>/g;

    let match;
    const headingPositions: Array<{
      level: number;
      text: string;
      sectionNumber?: string;
      startIndex: number;
      endIndex: number;
    }> = [];

    // Find all heading paragraphs
    while ((match = paragraphRegex.exec(xmlContent)) !== null) {
      const paragraph = match[0];
      const styleMatch = paragraph.match(headingStyleRegex);

      if (styleMatch) {
        const level = parseInt(styleMatch[1], 10);

        // Extract text from the paragraph
        let text = "";
        let textMatch;
        const textRegexLocal = /<w:t[^>]*>([^<]*)<\/w:t>/g;
        while ((textMatch = textRegexLocal.exec(paragraph)) !== null) {
          text += textMatch[1];
        }

        // Try to extract section number (e.g., "8. " or "8 ")
        const sectionNumMatch = text.match(/^(\d+(?:\.\d+)*)[.\s]/);
        const sectionNumber = sectionNumMatch ? sectionNumMatch[1] : undefined;

        headingPositions.push({
          level,
          text: text.trim(),
          sectionNumber,
          startIndex: match.index,
          endIndex: match.index + paragraph.length,
        });
      }
    }

    // Now create sections from heading positions
    // Each section spans from its heading to the next same-level or higher-level heading
    for (let i = 0; i < headingPositions.length; i++) {
      const current = headingPositions[i];
      let endIndex: number;

      // Find the end of this section
      // It ends at the next heading of same or higher level (lower number)
      // Or at the sectPr element, or end of body
      let nextSectionStart: number | undefined;

      for (let j = i + 1; j < headingPositions.length; j++) {
        if (headingPositions[j].level <= current.level) {
          nextSectionStart = headingPositions[j].startIndex;
          break;
        }
      }

      if (nextSectionStart !== undefined) {
        endIndex = nextSectionStart;
      } else {
        // This is the last section at this level
        // End at sectPr or end of body
        const sectPrMatch = xmlContent.match(/<w:sectPr[^>]*>/);
        const bodyEndMatch = xmlContent.match(/<\/w:body>/);

        if (sectPrMatch && sectPrMatch.index !== undefined) {
          endIndex = sectPrMatch.index;
        } else if (bodyEndMatch && bodyEndMatch.index !== undefined) {
          endIndex = bodyEndMatch.index;
        } else {
          endIndex = xmlContent.length;
        }
      }

      sections.push({
        headingLevel: current.level,
        headingText: current.text,
        sectionNumber: current.sectionNumber,
        startIndex: current.startIndex,
        endIndex,
        xmlContent: xmlContent.slice(current.startIndex, endIndex),
      });
    }

    return sections;
  }

  /**
   * Moves a section to a new position in the document.
   * @param inputPath Path to the source DOCX file
   * @param outputPath Path to save the modified DOCX file
   * @param sectionIdentifier The section to move (can be section number like "8" or heading text)
   * @param afterSection The section after which to place it (section number or heading text)
   */
  async moveSectionAfter(
    inputPath: string,
    outputPath: string,
    sectionIdentifier: string,
    afterSection: string,
  ): Promise<{ success: boolean; message: string }> {
    console.log(
      `[DocumentBuilder] moveSectionAfter: Moving "${sectionIdentifier}" after "${afterSection}"`,
    );

    // Read the DOCX file
    const docxBuffer = await fsPromises.readFile(inputPath);
    const zip = await JSZip.loadAsync(docxBuffer);

    const documentXml = zip.file("word/document.xml");
    if (!documentXml) {
      throw new Error("Invalid DOCX file: missing word/document.xml");
    }

    let xmlContent = await documentXml.async("text");

    // Parse sections
    const sections = this.parseSections(xmlContent);
    console.log(
      `[DocumentBuilder] Found ${sections.length} sections:`,
      sections.map((s) => `${s.sectionNumber || "N/A"}: ${s.headingText.substring(0, 50)}`),
    );

    // Find the section to move
    const sectionToMove = this.findSection(sections, sectionIdentifier);
    if (!sectionToMove) {
      return {
        success: false,
        message: `Could not find section "${sectionIdentifier}". Available sections: ${sections.map((s) => s.sectionNumber || s.headingText).join(", ")}`,
      };
    }

    // Find the target section (after which to insert)
    const targetSection = this.findSection(sections, afterSection);
    if (!targetSection) {
      return {
        success: false,
        message: `Could not find target section "${afterSection}". Available sections: ${sections.map((s) => s.sectionNumber || s.headingText).join(", ")}`,
      };
    }

    // Check if move is needed
    if (sectionToMove.startIndex === targetSection.endIndex) {
      return { success: true, message: "Section is already in the correct position" };
    }

    // Perform the move
    const sectionContent = sectionToMove.xmlContent;

    // Remove the section from its current position
    let newXmlContent: string;

    if (sectionToMove.startIndex > targetSection.endIndex) {
      // Section is after target - remove it first, then insert
      newXmlContent =
        xmlContent.slice(0, sectionToMove.startIndex) + xmlContent.slice(sectionToMove.endIndex);

      // Insert at target position (unchanged since it's before the removed section)
      newXmlContent =
        newXmlContent.slice(0, targetSection.endIndex) +
        sectionContent +
        newXmlContent.slice(targetSection.endIndex);
    } else {
      // Section is before target - need to adjust indices
      // First, calculate where target ends after section removal
      const sectionLength = sectionToMove.endIndex - sectionToMove.startIndex;
      const adjustedTargetEnd = targetSection.endIndex - sectionLength;

      // Remove section first
      newXmlContent =
        xmlContent.slice(0, sectionToMove.startIndex) + xmlContent.slice(sectionToMove.endIndex);

      // Insert at adjusted target position
      newXmlContent =
        newXmlContent.slice(0, adjustedTargetEnd) +
        sectionContent +
        newXmlContent.slice(adjustedTargetEnd);
    }

    // Update the document.xml in the ZIP
    zip.file("word/document.xml", newXmlContent);

    // Write the modified DOCX
    const outputBuffer = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    });
    await fsPromises.writeFile(outputPath, outputBuffer);

    console.log(
      `[DocumentBuilder] Successfully moved section "${sectionIdentifier}" after "${afterSection}"`,
    );

    return {
      success: true,
      message: `Moved section "${sectionToMove.headingText}" after "${targetSection.headingText}"`,
    };
  }

  /**
   * Finds a section by its number or heading text
   */
  private findSection(
    sections: DocumentSection[],
    identifier: string,
  ): DocumentSection | undefined {
    const normalizedId = identifier.trim().toLowerCase();

    // First try exact section number match
    const byNumber = sections.find(
      (s) => s.sectionNumber === identifier || s.sectionNumber === normalizedId,
    );
    if (byNumber) return byNumber;

    // Try with "Section " prefix
    const withPrefix = sections.find(
      (s) =>
        s.headingText.toLowerCase().startsWith(`section ${normalizedId}`) ||
        s.headingText.toLowerCase().startsWith(`${normalizedId}.`) ||
        s.headingText.toLowerCase().startsWith(`${normalizedId} `),
    );
    if (withPrefix) return withPrefix;

    // Try partial heading text match
    const byText = sections.find((s) => s.headingText.toLowerCase().includes(normalizedId));
    if (byText) return byText;

    return undefined;
  }

  /**
   * Inserts new content after a specific section in the document.
   * @param inputPath Path to the source DOCX file
   * @param outputPath Path to save the modified DOCX file
   * @param afterSection Section identifier (number or heading text) after which to insert
   * @param newContent Content blocks to insert
   */
  async insertAfterSection(
    inputPath: string,
    outputPath: string,
    afterSection: string,
    newContent: ContentBlock[],
  ): Promise<{ success: boolean; message: string; sectionsAdded: number }> {
    console.log(
      `[DocumentBuilder] insertAfterSection: After "${afterSection}", inserting ${newContent.length} blocks`,
    );

    // Read the DOCX file
    const docxBuffer = await fsPromises.readFile(inputPath);
    const zip = await JSZip.loadAsync(docxBuffer);

    const documentXml = zip.file("word/document.xml");
    if (!documentXml) {
      throw new Error("Invalid DOCX file: missing word/document.xml");
    }

    let xmlContent = await documentXml.async("text");

    // Parse sections
    const sections = this.parseSections(xmlContent);

    // Find the target section
    const targetSection = this.findSection(sections, afterSection);
    if (!targetSection) {
      return {
        success: false,
        message: `Could not find section "${afterSection}". Available sections: ${sections.map((s) => s.sectionNumber || s.headingText).join(", ")}`,
        sectionsAdded: 0,
      };
    }

    // Generate OOXML for the new content
    const newXmlContent = this.contentBlocksToOoxml(newContent);

    // Insert after the target section
    const insertionPoint = targetSection.endIndex;
    xmlContent =
      xmlContent.slice(0, insertionPoint) + newXmlContent + xmlContent.slice(insertionPoint);

    // Update the document.xml in the ZIP
    zip.file("word/document.xml", xmlContent);

    // Write the modified DOCX
    const outputBuffer = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    });
    await fsPromises.writeFile(outputPath, outputBuffer);

    console.log(
      `[DocumentBuilder] Successfully inserted ${newContent.length} blocks after section "${afterSection}"`,
    );

    return {
      success: true,
      message: `Inserted ${newContent.length} content blocks after "${targetSection.headingText}"`,
      sectionsAdded: newContent.length,
    };
  }

  /**
   * Lists all sections in a document
   */
  async listSections(inputPath: string): Promise<
    Array<{
      number?: string;
      title: string;
      level: number;
    }>
  > {
    const docxBuffer = await fsPromises.readFile(inputPath);
    const zip = await JSZip.loadAsync(docxBuffer);

    const documentXml = zip.file("word/document.xml");
    if (!documentXml) {
      throw new Error("Invalid DOCX file: missing word/document.xml");
    }

    const xmlContent = await documentXml.async("text");
    const sections = this.parseSections(xmlContent);

    return sections.map((s) => ({
      number: s.sectionNumber,
      title: s.headingText,
      level: s.headingLevel,
    }));
  }

  /**
   * Converts HTML from mammoth to ContentBlocks
   * This is a simplified conversion that preserves basic structure
   */
  private htmlToContentBlocks(html: string): ContentBlock[] {
    const blocks: ContentBlock[] = [];

    // Simple regex-based HTML parsing for common elements
    // Match headings
    const headingRegex = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
    // Match paragraphs
    const paragraphRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    // Match list items
    const listRegex = /<ul[^>]*>([\s\S]*?)<\/ul>/gi;
    const _listItemRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    // Match tables
    const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
    const _trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const _tdThRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;

    // Helper to strip HTML tags
    const stripTags = (str: string): string => str.replace(/<[^>]*>/g, "").trim();

    // Process in order of appearance
    let _lastIndex = 0;
    const processedRanges: Array<{ start: number; end: number }> = [];

    // Find all headings
    let match;
    while ((match = headingRegex.exec(html)) !== null) {
      const text = stripTags(match[2]);
      if (text) {
        blocks.push({
          type: "heading",
          text,
          level: parseInt(match[1], 10),
        });
        processedRanges.push({ start: match.index, end: match.index + match[0].length });
      }
    }

    // Find all paragraphs
    paragraphRegex.lastIndex = 0;
    while ((match = paragraphRegex.exec(html)) !== null) {
      // Skip if this range overlaps with an already processed element
      const overlaps = processedRanges.some(
        (r) =>
          (match!.index >= r.start && match!.index < r.end) ||
          (match!.index + match![0].length > r.start && match!.index + match![0].length <= r.end),
      );
      if (overlaps) continue;

      const text = stripTags(match[1]);
      if (text) {
        blocks.push({
          type: "paragraph",
          text,
        });
        processedRanges.push({ start: match.index, end: match.index + match[0].length });
      }
    }

    // Find all lists
    listRegex.lastIndex = 0;
    while ((match = listRegex.exec(html)) !== null) {
      const listHtml = match[1];
      const items: string[] = [];
      let itemMatch;
      const itemRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
      while ((itemMatch = itemRegex.exec(listHtml)) !== null) {
        const itemText = stripTags(itemMatch[1]);
        if (itemText) items.push(itemText);
      }
      if (items.length > 0) {
        blocks.push({
          type: "list",
          text: items.join("\n"),
          items,
        });
      }
    }

    // Find all tables
    tableRegex.lastIndex = 0;
    while ((match = tableRegex.exec(html)) !== null) {
      const tableHtml = match[1];
      const rows: string[][] = [];
      let rowMatch;
      const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
        const rowHtml = rowMatch[1];
        const cells: string[] = [];
        let cellMatch;
        const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
        while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
          cells.push(stripTags(cellMatch[1]));
        }
        if (cells.length > 0) rows.push(cells);
      }
      if (rows.length > 0) {
        blocks.push({
          type: "table",
          text: "",
          rows,
        });
      }
    }

    // Sort blocks by their original position would require more complex tracking
    // For now, we return them in the order found (headings, then paragraphs, then lists, then tables)
    // This may not preserve exact document order

    return blocks;
  }
}
