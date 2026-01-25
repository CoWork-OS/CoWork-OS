import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle
} from 'docx';
import PDFDocument from 'pdfkit';
import { Workspace } from '../../../shared/types';

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
 * DocumentBuilder creates Word documents (.docx) and PDFs using docx and pdfkit
 */
export class DocumentBuilder {
  constructor(private workspace: Workspace) {}

  async create(
    outputPath: string,
    format: 'docx' | 'pdf' | 'md',
    content: ContentBlock[],
    options: DocumentOptions = {}
  ): Promise<void> {
    const ext = path.extname(outputPath).toLowerCase();

    // Allow format override via extension
    if (ext === '.md' || format === 'md') {
      await this.createMarkdown(outputPath, content);
      return;
    }

    if (ext === '.pdf' || format === 'pdf') {
      await this.createPDF(outputPath, content, options);
      return;
    }

    // Default to Word document
    await this.createDocx(outputPath, content, options);
  }

  /**
   * Creates a Word document (.docx)
   */
  private async createDocx(
    outputPath: string,
    content: ContentBlock[],
    options: DocumentOptions
  ): Promise<void> {
    const children: Paragraph[] = [];

    for (const block of content) {
      switch (block.type) {
        case 'heading': {
          const level = Math.min(Math.max(block.level || 1, 1), 6);
          const headingLevel = this.getHeadingLevel(level);
          children.push(
            new Paragraph({
              text: block.text,
              heading: headingLevel,
              spacing: { before: 240, after: 120 }
            })
          );
          break;
        }

        case 'paragraph':
          children.push(
            new Paragraph({
              children: [new TextRun({ text: block.text, size: (options.fontSize || 12) * 2 })],
              spacing: { after: 200 }
            })
          );
          break;

        case 'list': {
          const items = block.items || block.text.split('\n').filter(line => line.trim());
          for (const item of items) {
            children.push(
              new Paragraph({
                children: [new TextRun({ text: item, size: (options.fontSize || 12) * 2 })],
                bullet: { level: 0 },
                spacing: { after: 100 }
              })
            );
          }
          break;
        }

        case 'table': {
          if (block.rows && block.rows.length > 0) {
            const table = new Table({
              width: { size: 100, type: WidthType.PERCENTAGE },
              rows: block.rows.map((row, rowIndex) =>
                new TableRow({
                  children: row.map(
                    cell =>
                      new TableCell({
                        children: [
                          new Paragraph({
                            children: [
                              new TextRun({
                                text: cell,
                                bold: rowIndex === 0,
                                size: (options.fontSize || 12) * 2
                              })
                            ]
                          })
                        ],
                        borders: {
                          top: { style: BorderStyle.SINGLE, size: 1 },
                          bottom: { style: BorderStyle.SINGLE, size: 1 },
                          left: { style: BorderStyle.SINGLE, size: 1 },
                          right: { style: BorderStyle.SINGLE, size: 1 }
                        }
                      })
                  )
                })
              )
            });
            children.push(new Paragraph({ children: [] })); // Spacing before table
            children.push(table as any);
            children.push(new Paragraph({ children: [] })); // Spacing after table
          }
          break;
        }

        case 'code':
          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: block.text,
                  font: 'Courier New',
                  size: 20, // 10pt
                  shading: { fill: 'F0F0F0' }
                })
              ],
              spacing: { before: 200, after: 200 }
            })
          );
          break;

        default:
          children.push(
            new Paragraph({
              children: [new TextRun({ text: block.text, size: (options.fontSize || 12) * 2 })]
            })
          );
      }
    }

    const doc = new Document({
      creator: options.author || 'CoWork-OSS',
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
                right: (options.margins?.right || 1) * 1440
              }
            }
          },
          children
        }
      ]
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
    options: DocumentOptions
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        size: 'LETTER',
        margins: {
          top: (options.margins?.top || 1) * 72,
          bottom: (options.margins?.bottom || 1) * 72,
          left: (options.margins?.left || 1) * 72,
          right: (options.margins?.right || 1) * 72
        },
        info: {
          Title: options.title || '',
          Author: options.author || 'CoWork-OSS',
          Subject: options.subject || ''
        }
      });

      const stream = fs.createWriteStream(outputPath);
      doc.pipe(stream);

      const baseFontSize = options.fontSize || 12;

      for (const block of content) {
        switch (block.type) {
          case 'heading': {
            const level = Math.min(Math.max(block.level || 1, 1), 6);
            const fontSize = baseFontSize + (7 - level) * 2; // h1 = base+12, h6 = base+2
            doc
              .font('Helvetica-Bold')
              .fontSize(fontSize)
              .text(block.text, { paragraphGap: 10 });
            doc.moveDown(0.5);
            break;
          }

          case 'paragraph':
            doc
              .font('Helvetica')
              .fontSize(baseFontSize)
              .text(block.text, { paragraphGap: 8, lineGap: 4 });
            doc.moveDown(0.5);
            break;

          case 'list': {
            const items = block.items || block.text.split('\n').filter(line => line.trim());
            doc.font('Helvetica').fontSize(baseFontSize);
            for (const item of items) {
              doc.text(`• ${item}`, { indent: 20, paragraphGap: 4 });
            }
            doc.moveDown(0.5);
            break;
          }

          case 'table': {
            if (block.rows && block.rows.length > 0) {
              doc.font('Helvetica').fontSize(baseFontSize - 1);
              const columnCount = block.rows[0].length;
              const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
              const colWidth = pageWidth / columnCount;

              for (let rowIndex = 0; rowIndex < block.rows.length; rowIndex++) {
                const row = block.rows[rowIndex];
                const startY = doc.y;

                // Draw cells
                for (let colIndex = 0; colIndex < row.length; colIndex++) {
                  const x = doc.page.margins.left + colIndex * colWidth;
                  doc.font(rowIndex === 0 ? 'Helvetica-Bold' : 'Helvetica');
                  doc.text(row[colIndex], x, startY, {
                    width: colWidth - 10,
                    continued: false
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

          case 'code':
            doc
              .font('Courier')
              .fontSize(baseFontSize - 2)
              .fillColor('#333333')
              .text(block.text, { paragraphGap: 8 });
            doc.fillColor('#000000');
            doc.moveDown(0.5);
            break;

          default:
            doc
              .font('Helvetica')
              .fontSize(baseFontSize)
              .text(block.text);
            doc.moveDown(0.5);
        }
      }

      doc.end();

      stream.on('finish', resolve);
      stream.on('error', reject);
    });
  }

  /**
   * Creates a Markdown document (fallback)
   */
  private async createMarkdown(outputPath: string, content: ContentBlock[]): Promise<void> {
    const markdown = content
      .map(block => {
        switch (block.type) {
          case 'heading': {
            const level = Math.min(Math.max(block.level || 1, 1), 6);
            return `${'#'.repeat(level)} ${block.text}\n`;
          }
          case 'paragraph':
            return `${block.text}\n`;
          case 'list': {
            const items = block.items || block.text.split('\n').filter(line => line.trim());
            return items.map(item => `- ${item}`).join('\n') + '\n';
          }
          case 'table': {
            if (!block.rows || block.rows.length === 0) return '';
            const header = block.rows[0];
            const separator = header.map(() => '---').join(' | ');
            const rows = block.rows.map(row => row.join(' | ')).join('\n');
            return `${header.join(' | ')}\n${separator}\n${block.rows.slice(1).map(row => row.join(' | ')).join('\n')}\n`;
          }
          case 'code':
            return `\`\`\`${block.language || ''}\n${block.text}\n\`\`\`\n`;
          default:
            return `${block.text}\n`;
        }
      })
      .join('\n');

    await fsPromises.writeFile(outputPath, markdown, 'utf-8');
  }

  private getHeadingLevel(level: number): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
    switch (level) {
      case 1: return HeadingLevel.HEADING_1;
      case 2: return HeadingLevel.HEADING_2;
      case 3: return HeadingLevel.HEADING_3;
      case 4: return HeadingLevel.HEADING_4;
      case 5: return HeadingLevel.HEADING_5;
      case 6: return HeadingLevel.HEADING_6;
      default: return HeadingLevel.HEADING_1;
    }
  }
}
