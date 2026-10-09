import { createHash } from "crypto";
import * as path from "path";
import { resolveDocumentOutputs } from "./skills/document";
import { requestsMatchingOutputs } from "./executor-verification-repair-utils";

/**
 * Keeps matching DOCX/PDF deliverables on one source. When a request asks for
 * matching files, create_document must write them in one call with `formats`;
 * a single-format call for one of them is redirected to that call.
 */

type MatchingDocumentFormat = "docx" | "pdf";

const MATCHING_DOCUMENT_FORMATS: MatchingDocumentFormat[] = ["docx", "pdf"];
const DOCX_REQUEST_PATTERN = /\.docx\b|\bdocx\b|\bword\s+(?:document|doc|file|version|copy)\b/i;
const PDF_REQUEST_PATTERN = /\.pdf\b|\bpdf\b/i;
const NAMED_DOCUMENT_PATTERN = /([\w][\w.-]*)\.(docx|pdf)\b/gi;

/** Planning note added to document tasks that ask for matching DOCX/PDF files. */
export const MATCHING_DOCUMENT_FORMATS_PLAN_HINT = `MATCHING DOCUMENTS:
The request asks for matching document files. For matching formats, create them in one step with a single create_document call using formats (for example formats: ["docx", "pdf"], with filenames {"docx": "brief.docx", "pdf": "brief.pdf"} when the names are given), so every file is written from the same content. Do not plan a separate step that exports or converts one of the files.`;

export type MatchingDocumentDecision =
  | { action: "allow"; warning?: string }
  | { action: "block"; reason: string; suggestion: string }
  | { action: "already_written"; result: Record<string, unknown> };

interface NamedDocument {
  name: string;
  stem: string;
}

interface WrittenDocumentFile {
  path: string;
  format?: string;
  pageCount?: number;
  fittedToMaxPages?: boolean;
}

interface WrittenDocument {
  signature: string;
  viaFormats: boolean;
  files: WrittenDocumentFile[];
}

function collectNamedDocuments(prompt: string): Record<MatchingDocumentFormat, NamedDocument[]> {
  const named: Record<MatchingDocumentFormat, NamedDocument[]> = { docx: [], pdf: [] };
  for (const match of String(prompt || "").matchAll(NAMED_DOCUMENT_PATTERN)) {
    const format = match[2].toLowerCase() as MatchingDocumentFormat;
    const name = `${match[1]}.${format}`;
    if (!named[format].some((entry) => entry.name.toLowerCase() === name.toLowerCase())) {
      named[format].push({ name, stem: match[1] });
    }
  }
  return named;
}

function hasSameStemDocumentPair(named: Record<MatchingDocumentFormat, NamedDocument[]>): boolean {
  const pdfStems = new Set(named.pdf.map((entry) => entry.stem.toLowerCase()));
  return named.docx.some((entry) => pdfStems.has(entry.stem.toLowerCase()));
}

/**
 * True when the request asks for matching DOCX and PDF files: the same file
 * name in both formats, or wording such as "a Word document and a matching PDF".
 */
export function requestsMatchingDocumentFormats(prompt: string): boolean {
  const text = String(prompt || "");
  if (hasSameStemDocumentPair(collectNamedDocuments(text))) return true;
  return (
    requestsMatchingOutputs(text) &&
    DOCX_REQUEST_PATTERN.test(text) &&
    PDF_REQUEST_PATTERN.test(text)
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when the request names the file as something to read from ("convert report.pdf"). */
export function promptTreatsFileAsSource(prompt: string, filename: string): boolean {
  const name = path.basename(String(filename || "")).trim();
  if (!name) return false;
  const pattern = new RegExp(
    String.raw`\b(?:convert(?:ing)?|turn(?:ing)?|transform(?:ing)?|from|based\s+on|using|summari[sz]e|read|open|attached|uploaded|of)\s+` +
      String.raw`(?:(?:the|my|this|that|our|attached|existing|uploaded)\s+){0,2}` +
      "[\"'\\u0060\\u201c\\u2018]?" +
      escapeRegExp(name) +
      String.raw`(?![\w.-])`,
    "i",
  );
  return pattern.test(String(prompt || ""));
}

/**
 * The files the request pairs with `target` in the other create_document
 * format, or null when the request does not ask for files matching it.
 */
export function resolveMatchingDocumentSiblings(
  prompt: string,
  target: { filename: string; format: string },
): Array<{ filename: string; format: MatchingDocumentFormat }> | null {
  const format = MATCHING_DOCUMENT_FORMATS.find((candidate) => candidate === target.format);
  if (!format) return null;
  const other: MatchingDocumentFormat = format === "docx" ? "pdf" : "docx";
  const text = String(prompt || "");
  const named = collectNamedDocuments(text);
  const targetName = path.basename(target.filename);
  const targetStem = targetName.slice(0, -(format.length + 1));
  const sameStem = named[other].find(
    (entry) => entry.stem.toLowerCase() === targetStem.toLowerCase(),
  );

  let siblingName: string | undefined;
  if (sameStem) {
    siblingName = sameStem.name;
  } else {
    const matchingWording =
      requestsMatchingOutputs(text) &&
      DOCX_REQUEST_PATTERN.test(text) &&
      PDF_REQUEST_PATTERN.test(text);
    if (!matchingWording) return null;
    const targetNamed = named[format].some(
      (entry) => entry.name.toLowerCase() === targetName.toLowerCase(),
    );
    if (named[other].length === 0) {
      // "a Word document and a matching PDF": the PDF takes the Word document's name.
      if (named[format].length > 0 && !targetNamed) return null;
      siblingName = `${targetStem}.${other}`;
    } else if (named[other].length === 1 && targetNamed) {
      // An explicit pair with different names ("brief.docx and brief-print.pdf").
      siblingName = named[other][0].name;
    } else {
      return null;
    }
  }

  const directory = path.dirname(target.filename);
  const filename = directory && directory !== "." ? path.join(directory, siblingName) : siblingName;
  return [{ filename, format: other }];
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** What a create_document call renders: its blocks and the layout options. */
function documentContentSignature(input: Record<string, unknown>): string {
  const maxPages = input.maxPages === undefined || input.maxPages === null ? null : input.maxPages;
  return createHash("sha256")
    .update(
      stableStringify({
        content: input.content ?? null,
        pageNumbers: input.pageNumbers === true,
        maxPages: typeof maxPages === "string" ? Number(maxPages) : maxPages,
      }),
    )
    .digest("hex");
}

function describeOptions(input: Record<string, unknown>): string {
  const options: string[] = [];
  if (input.pageNumbers === true) options.push("pageNumbers: true");
  if (input.maxPages !== undefined && input.maxPages !== null && input.maxPages !== "") {
    options.push(`maxPages: ${JSON.stringify(input.maxPages)}`);
  }
  return options.length > 0 ? ` and the same options (${options.join(", ")})` : "";
}

export class MatchingDocumentFormatsGuard {
  /** Blocks per file before a single-format call is let through with a warning. */
  static readonly MAX_BLOCKS_PER_FILE = 2;

  private readonly blocksByFile = new Map<string, number>();
  private readonly written = new Map<string, WrittenDocument>();

  constructor(private readonly workspacePath?: string) {}

  private normalize(filename: string): string {
    let value = String(filename || "").trim();
    if (this.workspacePath && path.isAbsolute(value)) {
      const relative = path.relative(this.workspacePath, value);
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) value = relative;
    }
    return value
      .replace(/\\/g, "/")
      .replace(/^(?:\.\/)+/, "")
      .toLowerCase();
  }

  /**
   * Decide what to do with a create_document call before it runs. `preview`
   * evaluates without counting a block (used when a batch is only inspected).
   */
  evaluate(params: {
    input: unknown;
    prompt: string;
    fileExists: (filename: string) => boolean;
    createdEarlierInTask?: (filename: string) => boolean;
    preview?: boolean;
  }): MatchingDocumentDecision {
    const input = params.input as Record<string, unknown> | null;
    if (!input || typeof input !== "object") return { action: "allow" };
    if (input.formats !== undefined && input.formats !== null) return { action: "allow" };
    if (!String(params.prompt || "").trim()) return { action: "allow" };

    let target: { filename: string; format: string };
    try {
      [target] = resolveDocumentOutputs(input as Parameters<typeof resolveDocumentOutputs>[0]);
    } catch {
      // The tool itself reports invalid input.
      return { action: "allow" };
    }
    if (!target) return { action: "allow" };
    const siblings = resolveMatchingDocumentSiblings(params.prompt, target);
    if (!siblings || siblings.length === 0) return { action: "allow" };

    const key = this.normalize(target.filename);
    const signature = documentContentSignature(input);
    const earlier = this.written.get(key);
    if (
      earlier?.viaFormats &&
      earlier.signature === signature &&
      params.fileExists(target.filename)
    ) {
      const writtenFile = earlier.files.find((file) => this.normalize(file.path) === key);
      const names = earlier.files.map((file) => file.path);
      return {
        action: "already_written",
        result: {
          success: true,
          alreadyWritten: true,
          path: writtenFile?.path || target.filename,
          files: writtenFile ? [writtenFile] : [{ path: target.filename, format: target.format }],
          message:
            `${target.filename} was already written from the same content by the earlier ` +
            `create_document call with formats (${names.join(", ")}). It was not rewritten; ` +
            "use and link the existing file.",
        },
      };
    }

    const writtenThisTask = (filename: string) =>
      this.written.has(this.normalize(filename)) ||
      params.createdEarlierInTask?.(filename) === true;
    for (const sibling of siblings) {
      // Never overwrite a file the user supplied ("turn report.pdf into report.docx").
      if (promptTreatsFileAsSource(params.prompt, sibling.filename)) return { action: "allow" };
      if (params.fileExists(sibling.filename) && !writtenThisTask(sibling.filename)) {
        return { action: "allow" };
      }
    }

    const outputs = [target, ...siblings].sort(
      (a, b) =>
        MATCHING_DOCUMENT_FORMATS.indexOf(a.format as MatchingDocumentFormat) -
        MATCHING_DOCUMENT_FORMATS.indexOf(b.format as MatchingDocumentFormat),
    );
    const formats = JSON.stringify(outputs.map((output) => output.format));
    const filenames = JSON.stringify(
      Object.fromEntries(outputs.map((output) => [output.format, output.filename])),
    );
    const call =
      `Call create_document once with formats: ${formats} (filenames: ${filenames}) and the ` +
      `same content${describeOptions(input)} so both are written from one source.`;
    const alreadyWrittenSiblings = siblings.filter((sibling) => writtenThisTask(sibling.filename));
    let context = "This request needs matching files.";
    if (earlier?.viaFormats) {
      context =
        `${target.filename} was written together with ${siblings.map((s) => s.filename).join(", ")} ` +
        "by one create_document call with formats; writing it alone with different content would " +
        "make the files differ.";
    } else if (alreadyWrittenSiblings.length > 0) {
      context =
        `This request needs matching files, and ${alreadyWrittenSiblings
          .map((sibling) => sibling.filename)
          .join(", ")} was already written by an earlier single-format call. ` +
        "Rewrite all of them together.";
    }

    const blocks = this.blocksByFile.get(key) ?? 0;
    if (blocks >= MatchingDocumentFormatsGuard.MAX_BLOCKS_PER_FILE) {
      return {
        action: "allow",
        warning:
          `${target.filename} was written on its own although the request needs matching files, ` +
          `so it may not match ${siblings.map((s) => s.filename).join(", ")}. ${call}`,
      };
    }
    if (!params.preview) this.blocksByFile.set(key, blocks + 1);
    return {
      action: "block",
      reason: `${context} ${call}`,
      suggestion:
        `Do not write ${target.filename} by itself. Use one create_document call with formats ` +
        `${formats} and filenames ${filenames}, then link every file.`,
    };
  }

  /** Remember what a successful create_document call wrote. */
  recordCreateDocument(input: unknown, result: unknown): void {
    const record = input as Record<string, unknown> | null;
    if (!record || typeof record !== "object") return;
    const outcome = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
    if (outcome.success === false || outcome.alreadyWritten === true) return;

    let files: WrittenDocumentFile[] = [];
    if (Array.isArray(outcome.files)) {
      files = outcome.files
        .filter(
          (file): file is Record<string, unknown> =>
            Boolean(file) &&
            typeof file === "object" &&
            typeof (file as Record<string, unknown>).path === "string",
        )
        .map((file) => ({
          path: String(file.path),
          ...(typeof file.format === "string" ? { format: file.format } : {}),
          ...(typeof file.pageCount === "number" ? { pageCount: file.pageCount } : {}),
          ...(typeof file.fittedToMaxPages === "boolean"
            ? { fittedToMaxPages: file.fittedToMaxPages }
            : {}),
        }));
    }
    if (files.length === 0) {
      try {
        files = resolveDocumentOutputs(record as Parameters<typeof resolveDocumentOutputs>[0]).map(
          (output) => ({ path: output.filename, format: output.format }),
        );
      } catch {
        return;
      }
    }
    const entry: WrittenDocument = {
      signature: documentContentSignature(record),
      viaFormats: files.length > 1,
      files,
    };
    for (const file of files) this.written.set(this.normalize(file.path), entry);
  }

  /** Forget files another tool changed, so they no longer count as written from one source. */
  forget(paths: string[]): void {
    for (const filePath of paths) this.written.delete(this.normalize(filePath));
  }
}
