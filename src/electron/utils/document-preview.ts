import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import JSZip from "jszip";
import mammoth from "mammoth";
import { canEditDocumentInApp, getDocumentFormatLabel } from "../../shared/document-formats";
import type { DocumentPreview } from "../../shared/document-preview";
import { parseDocxBlocksFromBuffer } from "../documents/docx-blocks";

const execFileAsync = promisify(execFile);

type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

type BuildDocumentPreviewOptions = {
  runCommand?: CommandRunner;
};

function decodeXmlText(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function stripXmlTags(xml: string): string {
  return decodeXmlText(xml.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function htmlToText(html: string): string {
  return decodeXmlText(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function stripRtfToText(rtf: string): string {
  return rtf
    .replace(/\\'[0-9a-fA-F]{2}/g, (match) => String.fromCharCode(parseInt(match.slice(2), 16)))
    .replace(/\\par[d]?/g, "\n")
    .replace(/\\tab/g, "\t")
    .replace(/\\[a-zA-Z]+-?\d* ?/g, "")
    .replace(/[{}]/g, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractOdtTextFromXml(xml: string): string {
  const blocks: string[] = [];
  const blockRegex = /<(?:text:h|text:p|table:table)[\s\S]*?<\/(?:text:h|text:p|table:table)>/g;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(xml)) !== null) {
    const text = stripXmlTags(match[0]);
    if (text) blocks.push(text);
  }
  if (blocks.length > 0) return blocks.join("\n\n");
  return stripXmlTags(xml);
}

async function buildDocxLikePreview(filePath: string, format: string): Promise<DocumentPreview> {
  const buffer = await fs.readFile(filePath);
  const htmlResult = await mammoth.convertToHtml({ buffer });
  const textResult = await mammoth.extractRawText({ buffer });
  let blocks: DocumentPreview["blocks"];
  try {
    const parsedBlocks = await parseDocxBlocksFromBuffer(buffer);
    blocks = parsedBlocks.map((block) => ({
      id: block.id,
      type: block.type,
      text: block.text,
      level: block.level,
      rows: block.rows,
      order: block.order,
    }));
  } catch {
    blocks = undefined;
  }
  const htmlContent = htmlResult.value || "";
  const text = (textResult.value || htmlToText(htmlContent)).trim();
  return {
    format,
    previewMode: htmlContent ? "html" : "text",
    text,
    htmlContent: htmlContent || undefined,
    blocks,
    canEdit: canEditDocumentInApp(filePath),
    conversionStatus: "native",
  };
}

async function buildOdtPreview(filePath: string, format: string): Promise<DocumentPreview> {
  const buffer = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(buffer);
  const contentXml = await zip.file("content.xml")?.async("text");
  if (!contentXml) {
    return {
      format,
      previewMode: "unavailable",
      text: "",
      canEdit: false,
      conversionStatus: "failed",
      conversionMessage: "Could not find content.xml in this OpenDocument file.",
    };
  }
  return {
    format,
    previewMode: "text",
    text: extractOdtTextFromXml(contentXml),
    canEdit: false,
    conversionStatus: "native",
  };
}

async function convertDocWithTextutil(
  filePath: string,
  runCommand: CommandRunner,
): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    const result = await runCommand("textutil", ["-convert", "txt", "-stdout", filePath]);
    const text = result.stdout.trim();
    return text || null;
  } catch {
    return null;
  }
}

async function convertDocWithSoffice(
  filePath: string,
  runCommand: CommandRunner,
): Promise<string | null> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-doc-preview-"));
  try {
    await runCommand("soffice", [
      "--headless",
      "--convert-to",
      "txt:Text",
      "--outdir",
      tmpDir,
      filePath,
    ]);
    const expectedPath = path.join(
      tmpDir,
      `${path.basename(filePath, path.extname(filePath))}.txt`,
    );
    const text = (await fs.readFile(expectedPath, "utf-8")).trim();
    return text || null;
  } catch {
    return null;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function buildDocPreview(
  filePath: string,
  format: string,
  runCommand: CommandRunner,
): Promise<DocumentPreview> {
  const text =
    (await convertDocWithTextutil(filePath, runCommand)) ||
    (await convertDocWithSoffice(filePath, runCommand));
  if (text) {
    return {
      format,
      previewMode: "text",
      text,
      canEdit: false,
      conversionStatus: "converted",
      conversionMessage: "Preview generated from the legacy Word document.",
    };
  }
  return {
    format,
    previewMode: "unavailable",
    text: "",
    canEdit: false,
    conversionStatus: "unavailable",
    conversionMessage:
      "This legacy Word document needs Microsoft Word, Pages, TextEdit, or LibreOffice to open.",
  };
}

export async function buildDocumentPreviewFromFile(
  filePath: string,
  options: BuildDocumentPreviewOptions = {},
): Promise<DocumentPreview> {
  const extension = path.extname(filePath).toLowerCase();
  const format = getDocumentFormatLabel(filePath);
  const runCommand: CommandRunner =
    options.runCommand ||
    (async (command, args, commandOptions) => {
      const result = await execFileAsync(command, args, {
        ...commandOptions,
        encoding: "utf8",
      });
      return {
        stdout: String(result.stdout || ""),
        stderr: String(result.stderr || ""),
      };
    });

  if (
    extension === ".docx" ||
    extension === ".docm" ||
    extension === ".dotx" ||
    extension === ".dotm"
  ) {
    return buildDocxLikePreview(filePath, format);
  }

  if (extension === ".rtf") {
    const text = stripRtfToText(await fs.readFile(filePath, "utf-8"));
    return {
      format,
      previewMode: text ? "text" : "unavailable",
      text,
      canEdit: false,
      conversionStatus: text ? "native" : "failed",
      conversionMessage: text
        ? undefined
        : "No readable text could be extracted from this RTF file.",
    };
  }

  if (extension === ".odt" || extension === ".ott") {
    return buildOdtPreview(filePath, format);
  }

  if (extension === ".doc") {
    return buildDocPreview(filePath, format, runCommand);
  }

  return {
    format,
    previewMode: "unavailable",
    text: "",
    canEdit: false,
    conversionStatus: "unavailable",
    conversionMessage: "This document format opens in its native app.",
  };
}
