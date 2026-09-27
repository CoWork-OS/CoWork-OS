/* eslint-disable no-console */
const fs = require("node:fs");
const path = require("node:path");
const { inflateRawSync } = require("node:zlib");
const ExcelJS = require("exceljs");
const { PDFParse } = require("pdf-parse");
const { DOMParser } = require("@xmldom/xmldom");

const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 2048;
const MAX_ZIP_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_XLSX_ZIP_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_XLSX_ZIP_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_XML_BYTES = 2 * 1024 * 1024;
const MAX_LIVE_PDF_CGROUP_MEMORY_BYTES = 512 * 1024 * 1024;
const PRESENTATION_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types";

function ensureFile(absPath) {
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return { ok: false, error: "missing" };
  }
  if (!stat.isFile()) return { ok: false, error: "not_file" };
  if (stat.size <= 0) return { ok: false, error: "empty" };
  if (stat.size > MAX_ARTIFACT_BYTES) {
    return { ok: false, error: "too_large", size: stat.size, limit: MAX_ARTIFACT_BYTES };
  }
  return { ok: true, size: stat.size };
}

function hasQualifyingPdfMemoryBound(memoryLimitBytes) {
  return (
    Number.isSafeInteger(memoryLimitBytes) &&
    memoryLimitBytes > 0 &&
    memoryLimitBytes <= MAX_LIVE_PDF_CGROUP_MEMORY_BYTES
  );
}

async function verifyPdf(absPath, runId, options = {}) {
  if (options.mode !== "fixtures" && !hasQualifyingPdfMemoryBound(options.pdfMemoryLimitBytes)) {
    return {
      ok: false,
      error: "pdf_memory_bound_unavailable",
      required:
        "live PDF parsing requires a finite Linux cgroup v2 memory limit of 512 MiB or less",
    };
  }
  const file = ensureFile(absPath);
  if (!file.ok) return file;
  const input = new Uint8Array(fs.readFileSync(absPath));
  let parser;
  try {
    parser = new PDFParse({ data: input });
    const result = await parser.getText();
    const text = typeof result.text === "string" ? result.text : "";
    if (result.total !== 1) return { ok: false, error: "pdf_page_count", pages: result.total };
    if (!/QA Battery Report/i.test(text)) return { ok: false, error: "pdf_title_missing" };
    if (!text.includes(runId)) return { ok: false, error: "pdf_run_id_missing" };
    return {
      ok: true,
      pages: result.total,
      semanticCheck: "PDF.js text extraction and page count",
    };
  } catch (error) {
    return { ok: false, error: "pdf_parse_failed", detail: String(error.message || error) };
  } finally {
    if (parser) await parser.destroy();
  }
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function preflightZip(buffer, options = {}) {
  const maxUncompressedBytes =
    Number.isSafeInteger(options.maxUncompressedBytes) && options.maxUncompressedBytes > 0
      ? options.maxUncompressedBytes
      : MAX_ZIP_UNCOMPRESSED_BYTES;
  const maxEntryBytes =
    Number.isSafeInteger(options.maxEntryBytes) && options.maxEntryBytes > 0
      ? options.maxEntryBytes
      : Number.MAX_SAFE_INTEGER;
  const minimumEocdSize = 22;
  const searchStart = Math.max(0, buffer.length - 22 - 0xffff);
  let eocd = -1;
  for (let offset = buffer.length - minimumEocdSize; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + minimumEocdSize + commentLength === buffer.length) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP end record missing or has trailing bytes");

  const diskNumber = buffer.readUInt16LE(eocd + 4);
  const centralDirectoryDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralDirectorySize = buffer.readUInt32LE(eocd + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocd + 16);
  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new Error("Multi-disk ZIP packages are unsupported");
  }
  if (
    entryCount === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    throw new Error("ZIP64 packages are unsupported by the bounded grader");
  }
  if (entryCount > MAX_ZIP_ENTRIES) throw new Error(`ZIP entry count exceeds ${MAX_ZIP_ENTRIES}`);
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  if (
    centralDirectoryOffset < 0 ||
    centralDirectoryEnd !== eocd ||
    centralDirectoryEnd > buffer.length
  ) {
    throw new Error("ZIP central directory bounds are invalid");
  }

  const entries = new Map();
  let cursor = centralDirectoryOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > centralDirectoryEnd || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("ZIP central directory entry is malformed");
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const startDisk = buffer.readUInt16LE(cursor + 34);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const entryEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (entryEnd > centralDirectoryEnd || nameLength === 0)
      throw new Error("ZIP entry name or bounds are invalid");
    if (
      startDisk !== 0 ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      throw new Error("ZIP64 or multi-disk entry is unsupported");
    }
    if (flags & 0x0001) throw new Error("Encrypted ZIP entries are unsupported");
    if (method !== 0 && method !== 8)
      throw new Error(`Unsupported ZIP compression method ${method}`);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const normalized = path.posix.normalize(name);
    if (
      !name ||
      name.includes("\0") ||
      name.includes("\\") ||
      path.posix.isAbsolute(name) ||
      normalized === ".." ||
      normalized.startsWith("../")
    ) {
      throw new Error("Unsafe ZIP entry path");
    }
    if (entries.has(name)) throw new Error(`Duplicate ZIP entry ${name}`);
    if (uncompressedSize > maxEntryBytes) {
      throw new Error(`ZIP entry expanded size exceeds ${maxEntryBytes} bytes: ${name}`);
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > maxUncompressedBytes) {
      throw new Error(`ZIP expanded size exceeds ${maxUncompressedBytes} bytes`);
    }
    if (uncompressedSize > 0 && compressedSize === 0)
      throw new Error("ZIP entry has an impossible compression size");
    if (uncompressedSize > 64 * Math.max(compressedSize, 1)) {
      throw new Error("ZIP entry compression ratio exceeds the safe limit");
    }

    if (
      localHeaderOffset + 30 > centralDirectoryOffset ||
      buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50
    ) {
      throw new Error(`ZIP local header missing for ${name}`);
    }
    const localFlags = buffer.readUInt16LE(localHeaderOffset + 6);
    const localMethod = buffer.readUInt16LE(localHeaderOffset + 8);
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataOffset + compressedSize;
    const localName = buffer
      .subarray(localHeaderOffset + 30, localHeaderOffset + 30 + localNameLength)
      .toString("utf8");
    if (
      localFlags !== flags ||
      localMethod !== method ||
      localName !== name ||
      dataEnd > centralDirectoryOffset
    ) {
      throw new Error(`ZIP local entry mismatch for ${name}`);
    }
    entries.set(name, { name, method, crc, compressedSize, uncompressedSize, dataOffset });
    cursor = entryEnd;
  }
  if (cursor !== centralDirectoryEnd) throw new Error("ZIP central directory has unexpected data");
  return entries;
}

function extractZipEntry(buffer, entries, name) {
  const entry = entries.get(name);
  if (!entry) throw new Error(`ZIP package part missing: ${name}`);
  if (entry.uncompressedSize > MAX_XML_BYTES)
    throw new Error(`XML package part exceeds ${MAX_XML_BYTES} bytes: ${name}`);
  const compressed = buffer.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  const data =
    entry.method === 0
      ? Buffer.from(compressed)
      : inflateRawSync(compressed, { maxOutputLength: MAX_XML_BYTES });
  if (data.length !== entry.uncompressedSize)
    throw new Error(`ZIP expanded size mismatch: ${name}`);
  if (crc32(data) !== entry.crc) throw new Error(`ZIP CRC mismatch: ${name}`);
  return data.toString("utf8");
}

function validateAllZipEntriesBounded(buffer, entries) {
  let totalUncompressed = 0;
  for (const entry of entries.values()) {
    const compressed = buffer.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
    const data =
      entry.method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: Math.max(entry.uncompressedSize, 1) });
    if (data.length !== entry.uncompressedSize) {
      throw new Error(`ZIP expanded size mismatch: ${entry.name}`);
    }
    if (crc32(data) !== entry.crc) {
      throw new Error(`ZIP CRC mismatch: ${entry.name}`);
    }
    totalUncompressed += data.length;
    if (totalUncompressed > MAX_XLSX_ZIP_UNCOMPRESSED_BYTES) {
      throw new Error(`XLSX expanded size exceeds ${MAX_XLSX_ZIP_UNCOMPRESSED_BYTES} bytes`);
    }
  }
  return { entries: entries.size, expandedBytes: totalUncompressed };
}

function parseXml(source, partName) {
  if (/<!DOCTYPE|<!ENTITY/i.test(source))
    throw new Error(`DTD/entity declarations are not accepted in ${partName}`);
  const parserErrors = [];
  const parser = new DOMParser({
    errorHandler: {
      warning: (message) => parserErrors.push(String(message)),
      error: (message) => parserErrors.push(String(message)),
      fatalError: (message) => parserErrors.push(String(message)),
    },
  });
  const document = parser.parseFromString(source, "application/xml");
  if (parserErrors.length) throw new Error(`Malformed XML in ${partName}: ${parserErrors[0]}`);
  if (!document || !document.documentElement) throw new Error(`XML root missing in ${partName}`);
  return document;
}

function requiredRoot(document, namespace, localName, partName) {
  const root = document.documentElement;
  if (root.namespaceURI !== namespace || root.localName !== localName) {
    throw new Error(`Unexpected XML root in ${partName}`);
  }
  return root;
}

function childrenByTag(parent, namespace, localName) {
  const result = [];
  for (let child = parent && parent.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1 && child.namespaceURI === namespace && child.localName === localName)
      result.push(child);
  }
  return result;
}

function descendantsByTag(parent, namespace, localName) {
  return Array.from(parent.getElementsByTagNameNS(namespace, localName));
}

function parsePresentation(buffer) {
  const entries = preflightZip(buffer);
  const requiredParts = [
    "[Content_Types].xml",
    "ppt/presentation.xml",
    "ppt/_rels/presentation.xml.rels",
  ];
  for (const part of requiredParts)
    if (!entries.has(part)) throw new Error(`ZIP package part missing: ${part}`);

  const contentTypesDocument = parseXml(
    extractZipEntry(buffer, entries, "[Content_Types].xml"),
    "[Content_Types].xml",
  );
  const contentTypes = requiredRoot(
    contentTypesDocument,
    CONTENT_TYPES_NS,
    "Types",
    "[Content_Types].xml",
  );
  const presentationType = descendantsByTag(contentTypes, CONTENT_TYPES_NS, "Override").some(
    (item) =>
      item.getAttribute("PartName") === "/ppt/presentation.xml" &&
      item.getAttribute("ContentType") ===
        "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
  );
  if (!presentationType) throw new Error("PPTX presentation content type missing");

  const presentationDocument = parseXml(
    extractZipEntry(buffer, entries, "ppt/presentation.xml"),
    "ppt/presentation.xml",
  );
  const presentation = requiredRoot(
    presentationDocument,
    PRESENTATION_NS,
    "presentation",
    "ppt/presentation.xml",
  );
  const slideIdLists = childrenByTag(presentation, PRESENTATION_NS, "sldIdLst");
  const slideIds =
    slideIdLists.length === 1 ? childrenByTag(slideIdLists[0], PRESENTATION_NS, "sldId") : [];
  if (slideIds.length !== 2) throw new Error("PPTX presentation must reference exactly two slides");

  const relationshipsDocument = parseXml(
    extractZipEntry(buffer, entries, "ppt/_rels/presentation.xml.rels"),
    "ppt/_rels/presentation.xml.rels",
  );
  const relationshipRoot = requiredRoot(
    relationshipsDocument,
    PACKAGE_REL_NS,
    "Relationships",
    "ppt/_rels/presentation.xml.rels",
  );
  const relationships = new Map();
  for (const relationship of childrenByTag(relationshipRoot, PACKAGE_REL_NS, "Relationship")) {
    const id = relationship.getAttribute("Id");
    if (!id || relationships.has(id))
      throw new Error("PPTX relationship IDs must be present and unique");
    relationships.set(id, relationship);
  }

  const slideNames = [];
  for (const slideId of slideIds) {
    const relationshipId = slideId.getAttributeNS(REL_NS, "id");
    const relationship = relationships.get(relationshipId);
    if (
      !relationship ||
      !relationship.getAttribute("Type").endsWith("/slide") ||
      relationship.getAttribute("TargetMode") === "External"
    ) {
      throw new Error("PPTX presentation slide relationship is missing or invalid");
    }
    const target = relationship.getAttribute("Target");
    if (!target || path.posix.isAbsolute(target) || target.includes("\\") || target.includes("?")) {
      throw new Error("PPTX slide relationship target is invalid");
    }
    const packagePath = path.posix.normalize(path.posix.join("ppt", target));
    if (packagePath.startsWith("../") || !entries.has(packagePath)) {
      throw new Error(`PPTX slide relationship target missing: ${packagePath}`);
    }
    if (slideNames.includes(packagePath))
      throw new Error("PPTX slide relationships must target distinct slide parts");
    slideNames.push(packagePath);
  }

  const slideParts = [...entries.keys()].filter((name) =>
    /^ppt\/slides\/slide[0-9]+\.xml$/.test(name),
  );
  if (slideParts.length !== 2 || slideParts.some((name) => !slideNames.includes(name))) {
    throw new Error("PPTX package slide parts do not match presentation relationships");
  }
  const slides = slideNames.map((name) => {
    const document = parseXml(extractZipEntry(buffer, entries, name), name);
    const slide = requiredRoot(document, PRESENTATION_NS, "sld", name);
    const commonSlideData = childrenByTag(slide, PRESENTATION_NS, "cSld");
    const shapeTrees =
      commonSlideData.length === 1
        ? childrenByTag(commonSlideData[0], PRESENTATION_NS, "spTree")
        : [];
    if (shapeTrees.length !== 1) throw new Error(`PPTX shape tree missing in ${name}`);
    const shapeTree = shapeTrees[0];
    const text = descendantsByTag(shapeTree, DRAWING_NS, "t").map((node) => node.textContent || "");
    const bulletParagraphs = descendantsByTag(shapeTree, DRAWING_NS, "p")
      .filter((paragraph) => {
        const properties = childrenByTag(paragraph, DRAWING_NS, "pPr");
        return properties.some(
          (property) =>
            childrenByTag(property, DRAWING_NS, "buChar").length > 0 ||
            childrenByTag(property, DRAWING_NS, "buAutoNum").length > 0,
        );
      })
      .map((paragraph) =>
        descendantsByTag(paragraph, DRAWING_NS, "t")
          .map((node) => node.textContent || "")
          .join(""),
      );
    return { name, text, bulletParagraphs };
  });
  return { entries, slides };
}

async function verifyPptx(absPath, runId) {
  const file = ensureFile(absPath);
  if (!file.ok) return file;
  try {
    const { slides } = parsePresentation(fs.readFileSync(absPath));
    const firstText = slides[0].text.join(" ");
    if (!/QA Battery/i.test(firstText) || !firstText.includes(runId)) {
      return { ok: false, error: "pptx_title_or_run_id_missing", slide: slides[0].text };
    }
    const bullets = slides[1].bulletParagraphs;
    if (
      bullets.length !== 3 ||
      bullets.some((text, index) => text !== ["One", "Two", "Three"][index])
    ) {
      return { ok: false, error: "pptx_bullet_structure_or_content_mismatch", bullets };
    }
    return {
      ok: true,
      slides: slides.length,
      bullets: bullets.length,
      semanticCheck:
        "well-formed OOXML, resolved presentation relationships, slide text, and bullet paragraphs",
    };
  } catch (error) {
    return { ok: false, error: "pptx_parse_failed", detail: String(error.message || error) };
  }
}

function numericCell(value) {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && typeof value.result === "number") return value.result;
  return null;
}

async function verifySpreadsheet(absPath) {
  const file = ensureFile(absPath);
  if (!file.ok) return file;
  let zipSummary;
  try {
    const buffer = fs.readFileSync(absPath);
    const entries = preflightZip(buffer, {
      maxUncompressedBytes: MAX_XLSX_ZIP_UNCOMPRESSED_BYTES,
      maxEntryBytes: MAX_XLSX_ZIP_ENTRY_BYTES,
    });
    zipSummary = validateAllZipEntriesBounded(buffer, entries);
  } catch (error) {
    return {
      ok: false,
      error: "spreadsheet_zip_preflight_failed",
      detail: String(error.message || error),
    };
  }
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(absPath);
    const sheet = workbook.getWorksheet("Sheet1");
    if (!sheet) return { ok: false, error: "spreadsheet_sheet_missing" };
    if (
      sheet.getCell("A1").value !== "A" ||
      sheet.getCell("B1").value !== "B" ||
      sheet.getCell("C1").value !== "Sum"
    ) {
      return { ok: false, error: "spreadsheet_headers_mismatch" };
    }
    if (
      numericCell(sheet.getCell("A2").value) !== 2 ||
      numericCell(sheet.getCell("B2").value) !== 3
    ) {
      return { ok: false, error: "spreadsheet_inputs_mismatch" };
    }
    const sum = sheet.getCell("C2").value;
    if (!sum || typeof sum !== "object" || sum.formula !== "A2+B2") {
      return { ok: false, error: "spreadsheet_formula_mismatch", value: sum };
    }
    if (numericCell(sum) !== 5) {
      return {
        ok: false,
        error: "spreadsheet_cached_result_mismatch",
        expected: 5,
        actual: numericCell(sum),
      };
    }
    return {
      ok: true,
      formula: sum.formula,
      result: numericCell(sum),
      semanticCheck:
        "bounded OOXML ZIP validation plus ExcelJS values, formula, and cached result=5",
      zip: zipSummary,
    };
  } catch (error) {
    return { ok: false, error: "spreadsheet_parse_failed", detail: String(error.message || error) };
  }
}

async function verifyArtifact(kind, absPath, runId, options = {}) {
  if (kind === "pdf") return verifyPdf(absPath, runId, options);
  if (kind === "pptx") return verifyPptx(absPath, runId);
  if (kind === "xlsx") return verifySpreadsheet(absPath);
  throw new Error(`Unsupported artifact kind: ${kind}`);
}

function graderPrerequisites({ fixtures = false } = {}) {
  const modules = ["pdf-parse", "exceljs", "@xmldom/xmldom"];
  if (fixtures) modules.push("pdf-lib", "pptxgenjs", "jszip");
  const missing = modules.filter((name) => {
    try {
      require.resolve(name);
      return false;
    } catch {
      return true;
    }
  });
  return { ok: missing.length === 0, required: modules, missing };
}

module.exports = {
  ensureFile,
  graderPrerequisites,
  hasQualifyingPdfMemoryBound,
  preflightZip,
  validateAllZipEntriesBounded,
  verifyArtifact,
  verifyPdf,
  verifyPptx,
  verifySpreadsheet,
};
