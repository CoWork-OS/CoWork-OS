import * as fs from 'fs/promises';
import { Workspace } from '../../../shared/types';

/**
 * DocumentBuilder creates Word documents and PDFs
 * Note: For MVP, we'll create Markdown/plain text. In production, use proper libraries
 */
export class DocumentBuilder {
  constructor(private workspace: Workspace) {}

  async create(
    outputPath: string,
    format: 'docx' | 'pdf',
    content: Array<{ type: string; text: string; level?: number }>
  ): Promise<void> {
    // For MVP: Create Markdown format regardless of requested format
    // In production, use 'docx' library for .docx and 'pdfkit' for .pdf

    const markdown = this.contentToMarkdown(content);
    await fs.writeFile(outputPath, markdown, 'utf-8');
  }

  private contentToMarkdown(content: Array<{ type: string; text: string; level?: number }>): string {
    return content
      .map(block => {
        switch (block.type) {
          case 'heading': {
            const level = block.level || 1;
            return `${'#'.repeat(level)} ${block.text}\n`;
          }
          case 'paragraph':
            return `${block.text}\n`;
          case 'list':
            return block.text
              .split('\n')
              .map(line => `- ${line}`)
              .join('\n') + '\n';
          default:
            return `${block.text}\n`;
        }
      })
      .join('\n');
  }
}

/**
 * TODO: For production implementation:
 *
 * For DOCX, use 'docx' library:
 * import { Document, Packer, Paragraph, HeadingLevel, TextRun } from 'docx';
 *
 * const doc = new Document({
 *   sections: [{
 *     children: content.map(block => {
 *       if (block.type === 'heading') {
 *         return new Paragraph({
 *           text: block.text,
 *           heading: HeadingLevel[`HEADING_${block.level}`]
 *         });
 *       }
 *       return new Paragraph({ children: [new TextRun(block.text)] });
 *     })
 *   }]
 * });
 *
 * const buffer = await Packer.toBuffer(doc);
 * await fs.writeFile(outputPath, buffer);
 *
 * For PDF, use 'pdfkit':
 * import PDFDocument from 'pdfkit';
 * const doc = new PDFDocument();
 * doc.pipe(fs.createWriteStream(outputPath));
 * // Add content...
 * doc.end();
 */
