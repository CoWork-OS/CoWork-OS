/**
 * DocumentTools — LLM-callable tools for generating documents, presentations,
 * and spreadsheets.  Registered in ToolRegistry alongside other tool classes.
 *
 * Tools:
 *   generate_document     → PDF (or HTML fallback)
 *   generate_presentation → PPTX
 *   generate_spreadsheet  → XLSX
 */

import * as fs from "fs";
import * as path from "path";
import { LLMTool } from "../llm/types";
import { generatePDF } from "../../utils/document-generators/pdf-generator";
import { generatePPTX } from "../../utils/document-generators/pptx-generator";
import { generateXLSX } from "../../utils/document-generators/xlsx-generator";
import { generateEPUB } from "../../utils/document-generators/epub-generator";
import { generateLandingPage } from "../../utils/document-generators/html-page-generator";
import { compileLatex } from "../../utils/document-generators/latex-compiler";
import { getVoiceService } from "../../voice";

function sanitizeFilename(raw: string, maxLen = 80): string {
  const base = path.basename(String(raw || "").trim() || "document");
  return base.replace(/[^a-zA-Z0-9_\-. ]/g, "_").slice(0, maxLen);
}

export class DocumentTools {
  constructor(
    private workspacePath: string,
    private taskId: string,
    private registerArtifact?: (
      taskId: string,
      filePath: string,
      mimeType: string,
      metadata?: Record<string, unknown>,
    ) => void,
  ) {}

  setWorkspace(workspace: { path: string }): void {
    this.workspacePath = workspace.path;
  }

  // ── Tool definitions ────────────────────────────────────────────

  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: "compile_latex",
        description:
          "Compile a workspace .tex file into a PDF using a system LaTeX engine. " +
          "Use this after writing LaTeX/TikZ source when the user asks for a compiled paper or PDF. " +
          "Uses tectonic, latexmk, xelatex, lualatex, or pdflatex when installed.",
        input_schema: {
          type: "object" as const,
          properties: {
            sourcePath: {
              type: "string",
              description: 'Workspace-relative or absolute path to the .tex file (e.g. "paper.tex")',
            },
            outputPath: {
              type: "string",
              description: 'Optional workspace-contained PDF path (e.g. "paper.pdf")',
            },
            engine: {
              type: "string",
              enum: ["auto", "tectonic", "latexmk", "xelatex", "lualatex", "pdflatex"],
              description: "Optional compiler preference. Defaults to auto.",
            },
          },
          required: ["sourcePath"],
        },
      },
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
      {
        name: "generate_epub",
        description:
          "Generate an EPUB ebook from chapter content. " +
          "Use this when the user asks for a novel, manuscript, or ebook export. " +
          "Returns the file path of the generated EPUB.",
        input_schema: {
          type: "object" as const,
          properties: {
            filename: {
              type: "string",
              description: 'Output filename (e.g. "novel.epub")',
            },
            title: { type: "string", description: "Book title" },
            author: { type: "string", description: "Author name (optional)" },
            language: { type: "string", description: "Language code (default: en)" },
            description: { type: "string", description: "Back-cover description (optional)" },
            publisher: { type: "string", description: "Publisher name (optional)" },
            chapters: {
              type: "array",
              description: "Ordered chapter list",
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  content: { type: "string" },
                },
                required: ["title", "content"],
              },
            },
          },
          required: ["filename", "title", "chapters"],
        },
      },
      {
        name: "generate_landing_page",
        description:
          "Generate a polished standalone HTML landing page. " +
          "Use this when the user asks for a project site, book landing page, or public summary page. " +
          "Returns the file path of the generated HTML page.",
        input_schema: {
          type: "object" as const,
          properties: {
            filename: {
              type: "string",
              description: 'Output filename (e.g. "index.html")',
            },
            title: { type: "string", description: "Page title" },
            subtitle: { type: "string", description: "Supporting subtitle" },
            description: { type: "string", description: "Longer description or intro" },
            author: { type: "string", description: "Author or byline" },
            accentColor: { type: "string", description: "Accent color hex code" },
            badge: { type: "string", description: "Small badge label" },
            callToAction: {
              type: "object",
              properties: {
                label: { type: "string" },
                href: { type: "string" },
              },
            },
            sections: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  content: { type: "string" },
                },
                required: ["title", "content"],
              },
            },
            footer: { type: "string", description: "Footer text" },
          },
          required: ["filename", "title"],
        },
      },
      {
        name: "generate_narration_audio",
        description:
          "Generate narrated MP3 audio from text using the configured voice service. " +
          "Use this when the user asks for audiobook narration or spoken chapter output. " +
          "Returns the file path of the generated audio file.",
        input_schema: {
          type: "object" as const,
          properties: {
            filename: {
              type: "string",
              description: 'Output filename (e.g. "chapter-01.mp3")',
            },
            text: { type: "string", description: "Narration text to synthesize" },
            title: { type: "string", description: "Optional label for the narration track" },
          },
          required: ["filename", "text"],
        },
      },
    ];
  }

  // ── Tool execution ──────────────────────────────────────────────

  async compileLatex(input: Any): Promise<Any> {
    const result = await compileLatex({
      workspacePath: this.workspacePath,
      sourcePath: input.sourcePath,
      outputPath: input.outputPath,
      engine: input.engine || "auto",
    });

    if (result.success && this.registerArtifact) {
      this.registerArtifact(this.taskId, result.pdfPath, "application/pdf", {
        sourcePath: result.sourcePath,
        logPath: result.logPath,
        engine: result.engine,
        type: "latex_pdf",
      });
    }

    return {
      success: result.success,
      sourcePath: result.sourcePath,
      pdfPath: result.pdfPath,
      path: result.pdfPath,
      logPath: result.logPath,
      engine: result.engine,
      size: result.size,
      error: result.error,
      diagnostic: result.diagnostic,
      mimeType: "application/pdf",
      message: result.success
        ? `LaTeX compiled: ${path.basename(result.pdfPath)} (${formatBytes(result.size || 0)})`
        : `LaTeX compile failed: ${result.error || result.diagnostic}`,
    };
  }

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

  async generateEPUB(input: Any): Promise<Any> {
    const filename = sanitizeFilename(input.filename || "novel.epub");
    const outputPath = path.join(this.workspacePath, filename);

    const result = await generateEPUB(outputPath, {
      title: String(input.title || "Untitled"),
      author: input.author,
      language: input.language,
      description: input.description,
      publisher: input.publisher,
      chapters: Array.isArray(input.chapters) ? input.chapters : [],
    });

    if (result.success && this.registerArtifact) {
      this.registerArtifact(
        this.taskId,
        result.path,
        "application/epub+zip",
      );
    }

    return {
      success: result.success,
      path: result.path,
      size: result.size,
      chapterCount: result.chapterCount,
      message: `EPUB generated: ${path.basename(result.path)} (${result.chapterCount} chapter(s), ${formatBytes(result.size)})`,
    };
  }

  async generateLandingPage(input: Any): Promise<Any> {
    const filename = sanitizeFilename(input.filename || "index.html");
    const outputPath = path.join(this.workspacePath, filename);

    const result = await generateLandingPage(outputPath, {
      title: String(input.title || "Untitled"),
      subtitle: input.subtitle,
      description: input.description,
      author: input.author,
      accentColor: input.accentColor,
      badge: input.badge,
      callToAction: input.callToAction,
      sections: Array.isArray(input.sections) ? input.sections : [],
      footer: input.footer,
    });

    if (result.success && this.registerArtifact) {
      this.registerArtifact(this.taskId, result.path, "text/html");
    }

    return {
      success: result.success,
      path: result.path,
      size: result.size,
      message: `Landing page generated: ${path.basename(result.path)} (${formatBytes(result.size)})`,
    };
  }

  async generateNarrationAudio(input: Any): Promise<Any> {
    const MAX_NARRATION_TEXT_LENGTH = 25_000; // TTS providers typically limit input
    const filename = sanitizeFilename(input.filename || "narration.mp3");
    const outputPath = path.join(this.workspacePath, filename);
    const text = String(input.text || "").trim();

    if (!text) {
      return {
        success: false,
        error: "text is required",
      };
    }
    if (text.length > MAX_NARRATION_TEXT_LENGTH) {
      return {
        success: false,
        error: `Text exceeds max length (${MAX_NARRATION_TEXT_LENGTH} chars). Split into shorter segments.`,
      };
    }

    const voiceService = getVoiceService();
    const audioBuffer = await voiceService.speak(text);
    if (!audioBuffer || audioBuffer.length === 0) {
      return {
        success: false,
        error:
          "Narration audio could not be generated. Check voice settings and API keys in Settings > Voice.",
      };
    }

    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(outputPath, audioBuffer);
    const stat = await fs.promises.stat(outputPath);
    if (this.registerArtifact) {
      this.registerArtifact(this.taskId, outputPath, "audio/mpeg");
    }

    return {
      success: true,
      path: outputPath,
      size: stat.size,
      message: `Narration audio generated: ${path.basename(outputPath)} (${formatBytes(stat.size)})`,
    };
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
