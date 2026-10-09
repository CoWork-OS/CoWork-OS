/**
 * Restores cached formula results in an .xlsx file changed by another program.
 *
 * Tools such as openpyxl keep formulas but drop every cached result when they save, so viewers
 * that do not recalculate (CoWork's preview, Quick Look, data-only readers) show "=D2*E2"
 * instead of the value. This computes the missing results with CoWork's formula evaluator and
 * writes them into the worksheet XML in place: formulas, number formats, frozen panes and every
 * other part of the file stay exactly as the program saved them. Results that are already cached
 * are never changed, and formulas the evaluator does not cover are reported, not replaced.
 */
import ExcelJS from "exceljs";
import JSZip from "jszip";
import * as fs from "fs/promises";
import * as path from "path";
import { readDocumentArchiveBuffer } from "../../security/document-archive";
import { findDateFormattedTextCells } from "./spreadsheet-cells";
import { computeWorkbookFormulaResults, type UncachedFormula } from "./spreadsheet-formulas";

export interface FormulaCacheRestoreResult {
  /** Formula cells that had no cached result and now carry one. */
  restored: number;
  /** Formula cells still without a cached result, with the reason. */
  uncached: UncachedFormula[];
  /** Text cells formatted as dates ("Expenses!B2"): they are not real Excel dates. */
  dateFormattedText: string[];
  /** Whether the file was rewritten. */
  rewritten: boolean;
}

const OFFICE_DOCUMENT_REL_TYPE = /\/officeDocument$/;
const XML_NAME_PREFIX = "(?:[A-Za-z_][\\w.-]*:)?";
const CELL_PATTERN = new RegExp(
  `<(${XML_NAME_PREFIX})c\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/\\1c>)`,
  "g",
);
const FORMULA_ELEMENT_PATTERN = new RegExp(
  `<(${XML_NAME_PREFIX})f\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/\\1f>)`,
);
const VALUE_ELEMENT_PATTERN = new RegExp(
  `<(${XML_NAME_PREFIX})v\\b[^>]*?(?:\\/>|>([\\s\\S]*?)<\\/\\1v>)`,
);
const TYPE_ATTRIBUTE_PATTERN = /\st=(?:"[^"]*"|'[^']*')/;
const REFERENCE_ATTRIBUTE_PATTERN = /\sr=(?:"([^"]*)"|'([^']*)')/;
/** Characters XML 1.0 does not allow in text, even escaped. */
const INVALID_XML_CHARACTERS = /[^\t\n\r\x20-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

const XML_NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeXmlEntities(text: string): string {
  return text.replace(
    /&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g,
    (_match, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      const codePoint = dec ? Number(dec) : hex ? parseInt(hex, 16) : null;
      if (codePoint !== null) {
        return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "";
      }
      return XML_NAMED_ENTITIES[name ?? ""] ?? "";
    },
  );
}

function escapeXmlText(text: string): string {
  return text
    .replace(INVALID_XML_CHARACTERS, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function readAttribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)')`).exec(attributes);
  const raw = match ? (match[1] ?? match[2]) : undefined;
  return raw === undefined ? undefined : decodeXmlEntities(raw);
}

function elementAttributes(xml: string, localName: string): string[] {
  const pattern = new RegExp(`<${XML_NAME_PREFIX}${localName}\\b([^>]*?)\\/?>`, "g");
  return Array.from(xml.matchAll(pattern), (match) => match[1]);
}

/** Resolves a relationship target against the folder of the part that owns it. */
function resolvePartPath(ownerPart: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  return path.posix.normalize(path.posix.join(path.posix.dirname(ownerPart), target));
}

async function readRelationships(zip: JSZip, ownerPart: string): Promise<Map<string, string>> {
  const relsPath = path.posix.join(
    path.posix.dirname(ownerPart),
    "_rels",
    `${path.posix.basename(ownerPart)}.rels`,
  );
  const xml = await zip.file(relsPath.replace(/^\.\//, ""))?.async("string");
  const relationships = new Map<string, string>();
  for (const attributes of elementAttributes(xml ?? "", "Relationship")) {
    const id = readAttribute(attributes, "Id");
    const target = readAttribute(attributes, "Target");
    const type = readAttribute(attributes, "Type") ?? "";
    if (!target) continue;
    const part = resolvePartPath(ownerPart, target);
    if (id) relationships.set(id, part);
    if (OFFICE_DOCUMENT_REL_TYPE.test(type)) relationships.set("#officeDocument", part);
  }
  return relationships;
}

/** Worksheet XML part by sheet name, in workbook order. */
async function worksheetParts(zip: JSZip): Promise<Map<string, string>> {
  const packageRels = await readRelationships(zip, "");
  const workbookPart = packageRels.get("#officeDocument") ?? "xl/workbook.xml";
  const workbookXml = (await zip.file(workbookPart)?.async("string")) ?? "";
  const workbookRels = await readRelationships(zip, workbookPart);
  const parts = new Map<string, string>();
  for (const attributes of elementAttributes(workbookXml, "sheet")) {
    const name = readAttribute(attributes, "name");
    const relId = /\s[A-Za-z_][\w.-]*:id=(?:"([^"]*)"|'([^']*)')/.exec(attributes);
    const part = relId ? workbookRels.get(relId[1] ?? relId[2]) : undefined;
    if (name && part && zip.file(part)) parts.set(name, part);
  }
  return parts;
}

/** An empty `<v>` is a cached empty string only on a cell typed as a formula string. */
function hasCachedValue(attributes: string, content: string): boolean {
  const value = VALUE_ELEMENT_PATTERN.exec(content);
  if (!value) return false;
  return (value[2] ?? "").trim() !== "" || readAttribute(attributes, "t") === "str";
}

/** Addresses of the formula cells in one worksheet part that have no cached result. */
function formulaCellsWithoutCache(xml: string): Set<string> {
  const addresses = new Set<string>();
  for (const match of xml.matchAll(CELL_PATTERN)) {
    const content = match[3];
    if (!content || !FORMULA_ELEMENT_PATTERN.test(content) || hasCachedValue(match[2], content)) {
      continue;
    }
    const reference = REFERENCE_ATTRIBUTE_PATTERN.exec(match[2]);
    const address = reference?.[1] ?? reference?.[2];
    if (address) addresses.add(address.replace(/\$/g, "").toUpperCase());
  }
  return addresses;
}

type CachedResult = number | string | boolean;

/** Writes cached results into the formula cells of one worksheet part that lack one. */
function patchWorksheetXml(xml: string, results: Map<string, CachedResult>): string {
  return xml.replace(
    CELL_PATTERN,
    (whole, prefix: string, attributes: string, content: string | undefined) => {
      if (!content || hasCachedValue(attributes, content)) return whole;
      const formula = FORMULA_ELEMENT_PATTERN.exec(content);
      const reference = REFERENCE_ATTRIBUTE_PATTERN.exec(attributes);
      const address = (reference?.[1] ?? reference?.[2] ?? "").replace(/\$/g, "").toUpperCase();
      const result = results.get(address);
      if (!formula || result === undefined) return whole;
      const type = typeof result === "string" ? "str" : typeof result === "boolean" ? "b" : null;
      const text =
        typeof result === "boolean" ? (result ? "1" : "0") : escapeXmlText(String(result));
      const valuePrefix = formula[1];
      const valueElement = `<${valuePrefix}v>${text}</${valuePrefix}v>`;
      const withoutEmptyValue = content.replace(VALUE_ELEMENT_PATTERN, "");
      const formulaEnd = withoutEmptyValue.indexOf(formula[0]) + formula[0].length;
      const nextContent =
        withoutEmptyValue.slice(0, formulaEnd) + valueElement + withoutEmptyValue.slice(formulaEnd);
      const nextAttributes =
        attributes.replace(TYPE_ATTRIBUTE_PATTERN, "") + (type ? ` t="${type}"` : "");
      return `<${prefix}c${nextAttributes}>${nextContent}</${prefix}c>`;
    },
  );
}

/**
 * Computes and stores the cached results missing from an .xlsx file's formulas, editing only the
 * `<v>` values (and value types) of those cells. Also lists text cells formatted as dates, which
 * a number format alone does not turn into dates. The file is rewritten only when a result was
 * added, and never when it changed while being processed.
 */
export async function restoreXlsxFormulaCaches(
  filePath: string,
): Promise<FormulaCacheRestoreResult> {
  const before = await fs.stat(filePath);
  const buffer = await readDocumentArchiveBuffer(filePath);
  const zip = await JSZip.loadAsync(buffer);
  const parts = await worksheetParts(zip);

  const missingByPart = new Map<string, Set<string>>();
  for (const part of new Set(parts.values())) {
    const xml = (await zip.file(part)?.async("string")) ?? "";
    const missing = formulaCellsWithoutCache(xml);
    if (missing.size > 0) missingByPart.set(part, missing);
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const dateFormattedText = workbook.worksheets.flatMap((sheet) =>
    findDateFormattedTextCells(sheet).map((address) => `${sheet.name}!${address}`),
  );
  if (missingByPart.size === 0) {
    return { restored: 0, uncached: [], dateFormattedText, rewritten: false };
  }

  const report = computeWorkbookFormulaResults(workbook, { onlyMissing: true });
  let restored = 0;
  const patchedParts = new Map<string, string>();
  for (const sheet of workbook.worksheets) {
    const part = parts.get(sheet.name);
    const missing = part ? missingByPart.get(part) : undefined;
    if (!part || !missing) continue;
    const results = new Map<string, CachedResult>();
    for (const address of missing) {
      // Cell.result, not Cell.value.result: ExcelJS leaves a 0 or FALSE result out of the value.
      const result: unknown = sheet.getCell(address).result;
      if (typeof result === "number" || typeof result === "string" || typeof result === "boolean") {
        results.set(address, result);
      }
    }
    if (results.size === 0) continue;
    const xml = (await zip.file(part)?.async("string")) ?? "";
    patchedParts.set(part, patchWorksheetXml(xml, results));
    restored += results.size;
  }

  const uncached = report.uncached.filter((entry) => {
    const part = parts.get(entry.sheet);
    return Boolean(part && missingByPart.get(part)?.has(entry.address.toUpperCase()));
  });
  if (patchedParts.size === 0) {
    return { restored: 0, uncached, dateFormattedText, rewritten: false };
  }

  // createFolders: false keeps JSZip from adding "xl/" style folder entries the file never had.
  for (const [part, xml] of patchedParts) zip.file(part, xml, { createFolders: false });
  const output = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  const current = await fs.stat(filePath);
  if (current.mtimeMs !== before.mtimeMs || current.size !== before.size) {
    throw new Error("The workbook changed while its formula results were being restored.");
  }
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    await fs.writeFile(temporaryPath, output, { mode: before.mode & 0o777 });
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
  return { restored, uncached, dateFormattedText, rewritten: true };
}

const MAX_LISTED_CELLS = 8;

function listCells(cells: string[]): string {
  const shown = cells.slice(0, MAX_LISTED_CELLS).join(", ");
  return cells.length > MAX_LISTED_CELLS
    ? `${shown} and ${cells.length - MAX_LISTED_CELLS} more`
    : shown;
}

/** One-line description of a restore result for a tool result, or null when nothing happened. */
export function describeFormulaCacheRestore(
  label: string,
  result: FormulaCacheRestoreResult,
): string | null {
  const notes: string[] = [];
  if (result.restored > 0) {
    notes.push(
      `restored the saved results of ${result.restored} formula cell(s) that the save dropped; ` +
        "formulas and formatting are unchanged",
    );
  }
  if (result.uncached.length > 0) {
    notes.push(
      `${result.uncached.length} formula cell(s) still have no saved result because CoWork cannot ` +
        `evaluate them (${listCells(result.uncached.map((entry) => `${entry.sheet}!${entry.address}`))}); ` +
        "Excel calculates them on open",
    );
  }
  if (result.dateFormattedText.length > 0) {
    notes.push(
      `${result.dateFormattedText.length} cell(s) hold text with a date number format ` +
        `(${listCells(result.dateFormattedText)}), so they are not real Excel dates and show the ` +
        "raw text; write them as date values (e.g. datetime.date) instead",
    );
  }
  return notes.length > 0 ? `${label}: ${notes.join("; ")}.` : null;
}
