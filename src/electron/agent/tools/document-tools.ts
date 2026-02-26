/**
 * DocumentTools — LLM-callable tools for generating documents, presentations,
 * and spreadsheets.  Registered in ToolRegistry alongside other tool classes.
 *
 * Tools:
 *   generate_document     → PDF (or HTML fallback)
 *   generate_presentation → PPTX
 *   generate_spreadsheet  → XLSX
 */

import * as path from "path";
import { LLMTool } from "../llm/types";
import { generatePDF } from "../../utils/document-generators/pdf-generator";
import { generatePPTX } from "../../utils/document-generators/pptx-generator";
import { generateXLSX } from "../../utils/document-generators/xlsx-generator";

function sanitizeFilename(raw: string, maxLen = 80): string {
  const base = path.basename(String(raw || "").trim() || "document");
  return base.replace(/[^a-zA-Z0-9_\-. ]/g, "_").slice(0, maxLen);
}

export class DocumentTools {
  constructor(
    private workspacePath: string,
    private taskId: string,
    private registerArtifact?: (taskId: string, filePath: string, mimeType: string) => void,
  ) {}

  setWorkspace(workspace: { path: string }): void {
    this.workspacePath = workspace.path;
  }

  // ── Tool definitions ────────────────────────────────────────────

  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: "generate_document",
        description:
          "Generate a styled PDF document from markdown content or structured sections. " +
          "Use this when the user asks you to create a report, document, or PDF. " +
          "Returns the file path of the generated document.",
        input_schema: {
          type: "object" as const,
          properties: {
            filename: {
              type: "string",
              description: 'Output filename (e.g. "quarterly-report.pdf")',
            },
            title: { type: "string", description: "Document title" },
            author: { type: "string", description: "Author name (optional)" },
            markdown: {
              type: "string",
              description: "Full document content in markdown format",
            },
            sections: {
              type: "array",
              description: "Alternative: structured sections with headings",
              items: {
                type: "object",
                properties: {
                  heading: { type: "string" },
                  content: { type: "string" },
                },
                required: ["content"],
              },
            },
          },
          required: ["filename"],
        },
      },
      {
        name: "generate_presentation",
        description:
          "Generate a PowerPoint (PPTX) presentation from structured slide data. " +
          "Use this when the user asks you to create a presentation, deck, or slides. " +
          "Returns the file path of the generated presentation.",
        input_schema: {
          type: "object" as const,
          properties: {
            filename: {
              type: "string",
              description: 'Output filename (e.g. "pitch-deck.pptx")',
            },
            title: { type: "string", description: "Presentation title" },
            author: { type: "string", description: "Author name (optional)" },
            slides: {
              type: "array",
              description: "Array of slide definitions",
              items: {
                type: "object",
                properties: {
                  title: { type: "string", description: "Slide title" },
                  subtitle: { type: "string", description: "Slide subtitle (title slides only)" },
                  bullets: {
                    type: "array",
                    items: { type: "string" },
                    description: "Bullet points for content slides",
                  },
                  content: { type: "string", description: "Free-text content paragraph" },
                  notes: { type: "string", description: "Speaker notes" },
                  layout: {
                    type: "string",
                    enum: ["title", "content", "section", "blank"],
                    description: "Slide layout type (default: content)",
                  },
                },
              },
            },
          },
          required: ["filename", "slides"],
        },
      },
      {
        name: "generate_spreadsheet",
        description:
          "Generate an Excel (XLSX) spreadsheet from structured data with headers and rows. " +
          "Use this when the user asks you to create a spreadsheet, table, or data export. " +
          "Returns the file path of the generated spreadsheet.",
        input_schema: {
          type: "object" as const,
          properties: {
            filename: {
              type: "string",
              description: 'Output filename (e.g. "analysis.xlsx")',
            },
            title: { type: "string", description: "Workbook title" },
            sheets: {
              type: "array",
              description: "Array of sheet definitions",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", description: "Sheet tab name" },
                  headers: {
                    type: "array",
                    items: { type: "string" },
                    description: "Column header names",
                  },
                  rows: {
                    type: "array",
                    description: "Data rows (arrays of values)",
                    items: {
                      type: "array",
                      items: {},
                    },
                  },
                  columnWidths: {
                    type: "array",
                    items: { type: "number" },
                    description: "Optional column widths",
                  },
                },
                required: ["name", "headers", "rows"],
              },
            },
          },
          required: ["filename", "sheets"],
        },
      },
    ];
  }

  // ── Tool execution ──────────────────────────────────────────────

  async generateDocument(input: Any): Promise<Any> {
    const filename = sanitizeFilename(input.filename || "document.pdf");
    const outputPath = path.join(this.workspacePath, filename);

    const result = await generatePDF(outputPath, {
      title: input.title,
      author: input.author,
      markdown: input.markdown,
      sections: input.sections,
    });

    if (result.success && this.registerArtifact) {
      const mime = result.path.endsWith(".pdf") ? "application/pdf" : "text/html";
      this.registerArtifact(this.taskId, result.path, mime);
    }

    return {
      success: result.success,
      path: result.path,
      size: result.size,
      message: `Document generated: ${path.basename(result.path)} (${formatBytes(result.size)})`,
    };
  }

  async generatePresentation(input: Any): Promise<Any> {
    const filename = sanitizeFilename(input.filename || "presentation.pptx");
    const outputPath = path.join(this.workspacePath, filename);

    const result = await generatePPTX(outputPath, {
      title: input.title,
      author: input.author,
      slides: input.slides || [],
    });

    if (result.success && this.registerArtifact) {
      this.registerArtifact(
        this.taskId,
        result.path,
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      );
    }

    return {
      success: result.success,
      path: result.path,
      size: result.size,
      slideCount: result.slideCount,
      message: `Presentation generated: ${path.basename(result.path)} (${result.slideCount} slides, ${formatBytes(result.size)})`,
    };
  }

  async generateSpreadsheet(input: Any): Promise<Any> {
    const filename = sanitizeFilename(input.filename || "data.xlsx");
    const outputPath = path.join(this.workspacePath, filename);

    const result = await generateXLSX(outputPath, {
      title: input.title,
      sheets: input.sheets || [],
    });

    if (result.success && this.registerArtifact) {
      this.registerArtifact(
        this.taskId,
        result.path,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
    }

    return {
      success: result.success,
      path: result.path,
      size: result.size,
      sheetCount: result.sheetCount,
      message: `Spreadsheet generated: ${path.basename(result.path)} (${result.sheetCount} sheet(s), ${formatBytes(result.size)})`,
    };
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
