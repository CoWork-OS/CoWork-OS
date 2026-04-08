/**
 * Document Parser Tools
 *
 * Exposes a `parse_document` agent tool that reads and extracts text from
 * common document formats (PDF, DOCX, XLSX, PPTX, Markdown, CSV, JSON).
 *
 * Delegates to the same parsing utilities used by the IPC file-preview handlers
 * (mammoth, pdf review extraction, ExcelJS, extractPptxContentFromFile) — no new deps.
 */

import * as fsSync from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import type { SensitiveSourceRef, Workspace } from "../../../shared/types";
import type { AgentDaemon } from "../daemon";
import type { LLMTool } from "../llm/types";
import { extractPdfText } from "../../utils/pdf-text";
import {
  buildSensitiveSourceRefForPath,
  buildUntrustedContentBanner,
  isUntrustedExternalSource,
} from "../security/export-permission-context";

export interface ParseDocumentInput {
  path: string;
  /** Output format: "text" (plain text) or "structured" (sections/tables as markdown). Default: "text". */
  format?: "text" | "structured";
  /** Maximum output characters. Default: 50000. */
  max_chars?: number;
}

export interface ParseDocumentResult {
  content: string;
  format: string;
  /** File extension that was detected */
  detected_type: string;
  /** True if the output was truncated to max_chars */
  truncated: boolean;
  char_count: number;
  pdf_extraction?: {
    status: "complete" | "recovered" | "ocr" | "preview" | "empty";
    mode: string;
    used_fallback: boolean;
    preview_limited: boolean;
    note: string;
    page_count: number;
  };
  provenance?: SensitiveSourceRef;
}

const DEFAULT_MAX_CHARS = 50_000;
const PDF_MAX_PAGES = 16;
const PDF_MAX_CHARS_PER_PAGE = 1_600;
const PDF_MAX_OCR_PAGES = 4;

export class DocumentParserTools {
  constructor(
    private workspace: Workspace,
    private daemon?: AgentDaemon,
    private taskId?: string,
  ) {}

  async parseDocument(input: ParseDocumentInput): Promise<ParseDocumentResult> {
    const filePath = this.resolveRequestedPath(input.path);
    const maxChars = Math.min(Math.max(input.max_chars ?? DEFAULT_MAX_CHARS, 100), 500_000);
    const format = input.format ?? "text";
    const ext = path.extname(filePath).toLowerCase().slice(1);
    const provenance = buildSensitiveSourceRefForPath(this.workspace, filePath);

    let content = "";
    let pdfExtraction: ParseDocumentResult["pdf_extraction"];

    switch (ext) {
      case "pdf":
        {
          const pdfResult = await this.parsePdf(filePath);
          content = pdfResult.text;
          pdfExtraction = pdfResult.pdf_extraction;
        }
        break;
      case "docx":
        content = await this.parseDocx(filePath);
        break;
      case "xlsx":
      case "xls":
        content = await this.parseXlsx(filePath, format);
        break;
      case "pptx":
        content = await this.parsePptx(filePath);
        break;
      case "csv":
        content = await this.parseCsv(filePath, format, maxChars);
        break;
      case "json":
      case "jsonl":
        content = await this.parseJson(filePath, maxChars);
        break;
      case "md":
      case "markdown":
      case "txt":
      case "text":
      case "rst":
      case "org":
        content = await fs.readFile(filePath, "utf-8");
        break;
      default:
        // Try to read as text
        try {
          content = await fs.readFile(filePath, "utf-8");
        } catch {
          throw new Error(
            `Unsupported file type ".${ext}". Supported: pdf, docx, xlsx, pptx, csv, json, md, txt.`,
          );
        }
    }

    if (isUntrustedExternalSource(provenance)) {
      if (this.daemon && this.taskId) {
        this.daemon.recordSensitiveSourceRead(this.taskId, provenance);
      }
      content = buildUntrustedContentBanner(provenance) + content;
    }

    const truncated = content.length > maxChars;
    const finalContent = truncated ? content.slice(0, maxChars) + "\n[Truncated]" : content;

    return {
      content: finalContent,
      format,
      detected_type: ext || "unknown",
      truncated,
      char_count: finalContent.length,
      provenance,
      ...(pdfExtraction ? { pdf_extraction: pdfExtraction } : {}),
    };
  }

  private resolveRequestedPath(requestedPath: string): string {
    const rawPath = String(requestedPath || "").trim();
    if (!rawPath) {
      throw new Error("Document path is required.");
    }
    if (rawPath.includes("\0")) {
      throw new Error("Document path is invalid.");
    }

    const candidatePath = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(this.workspace.path, rawPath);

    if (!fsSync.existsSync(candidatePath)) {
      throw new Error(`File not found: ${rawPath}`);
    }

    const resolvedPath = fsSync.realpathSync(candidatePath);
    if (!this.isPathAllowed(resolvedPath)) {
      throw new Error(
        "Access denied: document path must be inside the workspace or an approved allowed path.",
      );
    }

    return resolvedPath;
  }

  private isPathAllowed(targetPath: string): boolean {
    if (this.workspace.permissions.unrestrictedFileAccess) {
      return true;
    }

    const allowedRoots = [this.workspace.path, ...(this.workspace.permissions.allowedPaths || [])]
      .map((root) => {
        try {
          return fsSync.existsSync(root) ? fsSync.realpathSync(root) : path.resolve(root);
        } catch {
          return null;
        }
      })
      .filter((root): root is string => Boolean(root));

    return allowedRoots.some(
      (root) => targetPath === root || targetPath.startsWith(`${root}${path.sep}`),
    );
  }

  private async parsePdf(filePath: string): Promise<{
    text: string;
    pdf_extraction: NonNullable<ParseDocumentResult["pdf_extraction"]>;
  }> {
    const extracted = await extractPdfText(filePath, {
      includeOcr: true,
      maxFallbackPages: PDF_MAX_PAGES,
      maxFallbackCharsPerPage: PDF_MAX_CHARS_PER_PAGE,
      maxFallbackOcrPages: PDF_MAX_OCR_PAGES,
    });
    return {
      text: extracted.text || "",
      pdf_extraction: {
        status: extracted.extractionStatus,
        mode: extracted.extractionMode,
        used_fallback: extracted.usedFallback,
        preview_limited: extracted.previewLimited,
        note: extracted.extractionNote,
        page_count: extracted.pageCount,
      },
    };
  }

  private async parseDocx(filePath: string): Promise<string> {
    const mammoth = await import("mammoth");
    const buffer = await fs.readFile(filePath);
    const result = await mammoth.extractRawText({ buffer });
    return result.value || "";
  }

  private async parseXlsx(filePath: string, format: "text" | "structured"): Promise<string> {
    const ExcelJS = await import("exceljs");
    const workbook = new ExcelJS.default.Workbook();
    await workbook.xlsx.readFile(filePath);

    const lines: string[] = [];
    workbook.eachSheet((sheet) => {
      if (format === "structured") {
        lines.push(`\n## Sheet: ${sheet.name}\n`);
        sheet.eachRow((row) => {
          const cells = (row.values as unknown[])
            .slice(1)
            .map((v) => String(v ?? ""))
            .join(" | ");
          lines.push(`| ${cells} |`);
        });
      } else {
        lines.push(`Sheet: ${sheet.name}`);
        sheet.eachRow((row) => {
          const cells = (row.values as unknown[])
            .slice(1)
            .map((v) => String(v ?? ""))
            .join("\t");
          lines.push(cells);
        });
      }
    });

    return lines.join("\n");
  }

  private async parsePptx(filePath: string): Promise<string> {
    const { extractPptxContentFromFile } = await import("../../utils/pptx-extractor");
    return extractPptxContentFromFile(filePath);
  }

  private async parseCsv(filePath: string, format: "text" | "structured", maxChars: number): Promise<string> {
    const raw = await fs.readFile(filePath, "utf-8");
    if (format !== "structured") return raw;

    // Convert CSV to markdown table (first 200 rows)
    const rows = raw.split("\n").slice(0, 200).filter(Boolean);
    if (rows.length === 0) return "";

    const header = rows[0];
    const separator = header.split(",").map(() => "---").join(" | ");
    const mdRows = rows.map((r) => `| ${r.split(",").join(" | ")} |`);
    mdRows.splice(1, 0, `| ${separator} |`);
    return mdRows.join("\n");
  }

  private async parseJson(filePath: string, maxChars: number): Promise<string> {
    const raw = await fs.readFile(filePath, "utf-8");
    try {
      const parsed = JSON.parse(raw);
      return JSON.stringify(parsed, null, 2).slice(0, maxChars);
    } catch {
      return raw;
    }
  }

  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: "parse_document",
        description:
          "Read and extract text from a local document file. Supports PDF, DOCX, XLSX, PPTX, CSV, JSON, and Markdown. " +
          "Output is capped at max_chars (default 50,000). Use format='structured' for tabular data (CSV/XLSX) " +
          "to receive markdown tables. Prefer read_file for plain text files.",
        input_schema: {
          type: "object" as const,
          properties: {
            path: {
              type: "string",
              description: "Absolute or workspace-relative path to the document file",
            },
            format: {
              type: "string",
              enum: ["text", "structured"],
              description:
                '"text" returns plain text (default). "structured" returns markdown tables for CSV/XLSX.',
            },
            max_chars: {
              type: "number",
              description: "Maximum output characters. Default: 50000. Max: 500000.",
            },
          },
          required: ["path"],
        },
      } satisfies LLMTool,
    ];
  }
}
