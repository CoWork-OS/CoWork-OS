import * as fs from 'fs/promises';
import * as path from 'path';
import JSZip from 'jszip';

type PptxRelationship = {
  type?: string;
  target: string;
};

export interface PptxExtractOptions {
  maxSlidesToProcess?: number;
  textCandidateLimit?: number;
  outputCharLimit?: number;
  maxFileSizeBytes?: number;
}

const DEFAULT_MAX_SLIDES_TO_PROCESS = 250;
const DEFAULT_TEXT_CANDIDATE_LIMIT = 200 * 1024;
const DEFAULT_MAX_PPTX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

export async function extractPptxContentFromFile(filePath: string, options: PptxExtractOptions = {}): Promise<string> {
  const maxSlidesToProcess = Math.max(1, options.maxSlidesToProcess ?? DEFAULT_MAX_SLIDES_TO_PROCESS);
  const textCandidateLimit = Math.max(1024, options.textCandidateLimit ?? DEFAULT_TEXT_CANDIDATE_LIMIT);
  const outputCharLimit = typeof options.outputCharLimit === 'number' && Number.isFinite(options.outputCharLimit)
    ? Math.max(1, Math.floor(options.outputCharLimit))
    : undefined;
  const maxFileSizeBytes = Math.max(1024, options.maxFileSizeBytes ?? DEFAULT_MAX_PPTX_FILE_SIZE_BYTES);

  const stats = await fs.stat(filePath);
  if (stats.size > maxFileSizeBytes) {
    throw new Error(`PPTX file too large. Max supported size is ${Math.round(maxFileSizeBytes / (1024 * 1024))}MB.`);
  }

  const zipData = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(zipData);
  const metadata = await extractPptxMetadataFromZip(zip);

  const slideEntries = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => {
      const aMatch = a.match(/slide(\d+)\.xml$/i);
      const bMatch = b.match(/slide(\d+)\.xml$/i);
      const aIndex = aMatch ? Number(aMatch[1]) : 0;
      const bIndex = bMatch ? Number(bMatch[1]) : 0;
      return aIndex - bIndex;
    });

  const slideText: string[] = [];
  const truncationNotices: string[] = [];
  const maxSlides = Math.min(slideEntries.length, maxSlidesToProcess);
  const slidesToProcess = slideEntries.slice(0, maxSlides);
  let accumulatedLength = 0;
  let processedSlideCount = 0;

  for (const entryName of slidesToProcess) {
    const file = zip.file(entryName);
    if (!file) continue;
    processedSlideCount += 1;

    const match = entryName.match(/slide(\d+)\.xml$/i);
    const slideNumber = match ? Number(match[1]) : slideText.length + 1;
    const relationships = await extractPptxSlideRelationships(zip, entryName);
    const xml = await file.async('string');
    const extracted = extractPptxContentFromXml(xml, relationships);
    if (!extracted) continue;

    const notes = await extractPptxNotesFromZip(zip, relationships, slideNumber);
    const blocks = [`Slide ${slideNumber}:\n${extracted}`];
    if (notes) {
      blocks.push(`\n[Presenter notes]\n${notes}`);
    }
    const blockText = blocks.join('\n');
    slideText.push(blockText);
    accumulatedLength += blockText.length;

    if (accumulatedLength > textCandidateLimit) {
      truncationNotices.push(`... truncated after ${Math.round(textCandidateLimit / 1024)}KB of extracted text ...`);
      break;
    }
  }

  if (slideEntries.length > maxSlides) {
    truncationNotices.push(`... truncated due to slide count limit (${maxSlides}/${slideEntries.length}) ...`);
  }

  let allText = slideText.join('\n\n');
  if (!allText) {
    allText = '[No extractable slide text found in this PPTX file.]';
  }

  const metadataText = metadata.length > 0 ? `[PPTX Metadata]\n${metadata.join('\n')}\n\n` : '';
  const summaryLine = `[PPTX Slides: ${processedSlideCount === slideEntries.length ? slideEntries.length : `${processedSlideCount}/${slideEntries.length}`}]\n\n`;
  let resultText = `${summaryLine}${metadataText}${allText}`;
  if (truncationNotices.length > 0) {
    resultText = `${resultText}\n\n[${truncationNotices.join(' ')}]`;
  }

  if (outputCharLimit && resultText.length > outputCharLimit) {
    resultText = `${resultText.slice(0, outputCharLimit)}\n\n[... Content truncated. Showing first ${Math.round(outputCharLimit / 1024)}KB of extracted text ...]`;
  }

  return resultText;
}

function decodePptxXmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec) => String.fromCodePoint(Number(dec)))
    .trim();
}

function extractPptxXmlField(xml: string, tagCandidates: string[], isDate = false): string {
  for (const tagName of tagCandidates) {
    const match = xml.match(new RegExp(`<(?:\\w+:)?${tagName}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tagName}>`, 'i'));
    if (!match?.[1]) continue;

    const cleaned = decodePptxXmlText(match[1].trim());
    if (!cleaned) continue;

    if (isDate) {
      const date = new Date(cleaned);
      if (!Number.isNaN(date.getTime())) {
        return date.toISOString();
      }
    }

    return cleaned;
  }
  return '';
}

async function extractPptxMetadataFromZip(zip: JSZip): Promise<string[]> {
  const metadata: string[] = [];

  const coreFile = zip.file('docProps/core.xml');
  if (coreFile) {
    const coreXml = await coreFile.async('string');
    const title = extractPptxXmlField(coreXml, ['title']);
    const subject = extractPptxXmlField(coreXml, ['subject']);
    const creator = extractPptxXmlField(coreXml, ['creator']);
    const created = extractPptxXmlField(coreXml, ['created'], true);
    const modified = extractPptxXmlField(coreXml, ['modified'], true);
    const lastModifiedBy = extractPptxXmlField(coreXml, ['lastModifiedBy']);
    const description = extractPptxXmlField(coreXml, ['description']);

    const values: string[] = [];
    if (title) values.push(`Title: ${title}`);
    if (subject) values.push(`Subject: ${subject}`);
    if (creator) values.push(`Author: ${creator}`);
    if (created) values.push(`Created: ${created}`);
    if (modified) values.push(`Modified: ${modified}`);
    if (lastModifiedBy) values.push(`Last Modified By: ${lastModifiedBy}`);
    if (description) values.push(`Description: ${description}`);
    if (values.length > 0) metadata.push(values.join(' | '));
  }

  const appFile = zip.file('docProps/app.xml');
  if (appFile) {
    const appXml = await appFile.async('string');
    const appName = extractPptxXmlField(appXml, ['Application']);
    const presentationFormat = extractPptxXmlField(appXml, ['PresentationFormat']);
    const slides = extractPptxXmlField(appXml, ['Slides']);

    const values: string[] = [];
    if (appName) values.push(`Application: ${appName}`);
    if (presentationFormat) values.push(`Format: ${presentationFormat}`);
    if (slides) values.push(`Declared Slides: ${slides}`);
    if (values.length > 0) metadata.push(values.join(' | '));
  }

  return metadata;
}

function parsePptxRelationshipsFromXml(xml: string, sourcePath: string): Record<string, PptxRelationship> {
  const relationships: Record<string, PptxRelationship> = {};
  const relationshipPattern = /<Relationship\b[^>]*\/?>/gi;

  for (const match of xml.matchAll(relationshipPattern)) {
    const relationshipXml = match[0];
    if (/\bTargetMode\s*=\s*(["'])External\1/i.test(relationshipXml)) continue;

    const idMatch = relationshipXml.match(/\bId\s*=\s*(["'])(.*?)\1/i);
    const targetMatch = relationshipXml.match(/\bTarget\s*=\s*(["'])(.*?)\1/i);
    const typeMatch = relationshipXml.match(/\bType\s*=\s*(["'])(.*?)\1/i);
    if (!idMatch || !targetMatch || !typeMatch) continue;

    const id = idMatch[2];
    const rawTarget = decodePptxRelationshipTarget(targetMatch[2]);
    const normalizedTarget = rawTarget.replace(/^[/\\]+/, '').replace(/\\/g, '/');
    const target = path.posix.normalize(path.posix.join(sourcePath, normalizedTarget));
    relationships[id] = { target, type: typeMatch[2] };
  }

  return relationships;
}

function decodePptxRelationshipTarget(target: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

async function extractPptxSlideRelationships(zip: JSZip, slideEntryName: string): Promise<Record<string, PptxRelationship>> {
  const relsPath = `ppt/slides/_rels/${path.posix.basename(slideEntryName)}.rels`;
  const relsFile = zip.file(relsPath);
  if (!relsFile) return {};

  const relsXml = await relsFile.async('string');
  return parsePptxRelationshipsFromXml(relsXml, path.posix.dirname(slideEntryName));
}

async function extractPptxNotesFromZip(
  zip: JSZip,
  relationships: Record<string, PptxRelationship>,
  slideNumber: number
): Promise<string | null> {
  const notesRelation = Object.values(relationships).find((relation) => relation.type?.includes('/notesSlide'));
  const notesPath = notesRelation?.target ?? `ppt/notesSlides/notesSlide${slideNumber}.xml`;

  const notesFile = zip.file(notesPath);
  if (!notesFile) {
    const fallback = zip.file(`ppt/notesSlides/notesSlide${slideNumber}.xml`);
    if (!fallback) return null;
    const fallbackXml = await fallback.async('string');
    const notesText = extractTextFromPptxXml(fallbackXml);
    return notesText || null;
  }

  const notesXml = await notesFile.async('string');
  const notesText = extractTextFromPptxXml(notesXml);
  return notesText || null;
}

function extractTextFromPptxXml(xml: string): string {
  if (!xml) return '';
  const withLineBreaks = xml.replace(/<(?:\w+:)?br\b[^>]*\/?>/g, '\n');

  return withLineBreaks
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec) => String.fromCodePoint(Number(dec)))
    .replace(/\u000B/g, '')
    .replace(/\u000C/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractPptxTablesFromXml(xml: string): string[] {
  if (!xml) return [];

  const tables: string[] = [];
  const tableMatches = xml.matchAll(/<(?:\w+:)?tbl\b[\s\S]*?<\/(?:\w+:)?tbl>/gi);

  for (const tableMatch of tableMatches) {
    const tableXml = tableMatch[0];
    const rows = extractPptxRowsFromTableXml(tableXml);
    if (rows.length === 0) continue;

    const maxCols = Math.max(...rows.map((row) => row.length));
    const normalizedRows = rows.map((row) => {
      const padded = [...row];
      while (padded.length < maxCols) padded.push('');
      return padded.map((cell) => escapePptxTableCell(cell));
    });

    const header = `| ${normalizedRows[0].join(' | ')} |`;
    const separator = `| ${normalizedRows[0].map(() => '---').join(' | ')} |`;
    const lines = [
      header,
      separator,
      ...normalizedRows.slice(1).map((row) => `| ${row.join(' | ')} |`),
    ];

    if (lines.length > 1) {
      tables.push(`\n${lines.join('\n')}`);
    }
  }

  return tables;
}

function extractPptxRowsFromTableXml(tableXml: string): string[][] {
  const rowMatches = tableXml.matchAll(/<(?:\w+:)?tr\b[\s\S]*?<\/(?:\w+:)?tr>/gi);
  const rows: { text: string; colSpan: number; rowSpan: number }[][] = [];

  for (const rowMatch of rowMatches) {
    const cellMatches = rowMatch[0].matchAll(/<(?:\w+:)?tc\b[\s\S]*?<\/(?:\w+:)?tc>/gi);
    const row: { text: string; colSpan: number; rowSpan: number }[] = Array.from(cellMatches).map((cellMatch) => {
      const cellXml = cellMatch[0];
      return {
        text: extractTextFromPptxXml(cellXml).replace(/\s+/g, ' ').trim(),
        colSpan: extractPptxTableSpan(cellXml, 'gridSpan'),
        rowSpan: extractPptxTableSpan(cellXml, 'rowSpan'),
      };
    });
    rows.push(row);
  }

  return expandPptxTableRows(rows);
}

function extractPptxTableSpan(cellXml: string, spanType: 'gridSpan' | 'rowSpan'): number {
  const tcPr = cellXml.match(/<(?:\w+:)?tcPr\b[\s\S]*?<\/(?:\w+:)?tcPr>/i)?.[0];
  if (!tcPr) return 1;

  const tagMatch = tcPr.match(
    new RegExp(`(?:\\w+:)?${spanType}\\b[^>]*?(?:\\b(?:w:)?val|\\bval)=([\"'])(\\d+)\\1`, 'i')
  );
  const legacyTagMatch = !tagMatch
    ? tcPr.match(new RegExp(`(?:\\w+:)?${spanType}\\b[^>]*?(?:\\b(?:w:)?val|\\bval)=\"(\\d+)\"`, 'i'))
    : null;
  const unquotedTagMatch = !tagMatch && !legacyTagMatch
    ? tcPr.match(new RegExp(`(?:\\w+:)?${spanType}\\b[^>]*?(?:\\b(?:w:)?val|\\bval)=([^\\s"'>/]+)`, 'i'))
    : null;
  const valueText = (tagMatch?.[2] || legacyTagMatch?.[1] || unquotedTagMatch?.[1])?.trim();
  if (!valueText) return 1;

  const value = Number(valueText);
  return Number.isFinite(value) && value > 1 ? value : 1;
}

function expandPptxTableRows(rows: { text: string; colSpan: number; rowSpan: number }[][]): string[][] {
  const expandedRows: string[][] = [];
  const activeRowSpans: number[] = [];
  let maxColumns = 0;

  for (const row of rows) {
    const expandedRow: string[] = [];
    let columnIndex = 0;

    for (const cell of row) {
      while (activeRowSpans[columnIndex] > 0) {
        if (!expandedRow[columnIndex]) {
          expandedRow[columnIndex] = '';
        }
        columnIndex += 1;
      }

      const colSpan = Math.max(1, Math.floor(cell.colSpan || 1));
      const rowSpan = Math.max(1, Math.floor(cell.rowSpan || 1));

      while (expandedRow.length < columnIndex + colSpan) {
        expandedRow.push('');
      }

      for (let offset = 0; offset < colSpan; offset += 1) {
        expandedRow[columnIndex + offset] = offset === 0 ? cell.text : '';
        if (rowSpan > 1) {
          while (activeRowSpans.length <= columnIndex + offset) {
            activeRowSpans.push(0);
          }
          activeRowSpans[columnIndex + offset] = Math.max(activeRowSpans[columnIndex + offset], rowSpan - 1);
        }
      }

      columnIndex += colSpan;
    }

    while (expandedRow.length < activeRowSpans.length) {
      expandedRow.push('');
    }

    maxColumns = Math.max(maxColumns, expandedRow.length);
    expandedRows.push(expandedRow.map((cell) => cell || ''));

    for (let column = 0; column < activeRowSpans.length; column += 1) {
      if (activeRowSpans[column] > 0) {
        activeRowSpans[column] -= 1;
      }
    }
  }

  return expandedRows.map((row) => {
    const normalized = [...row];
    while (normalized.length < maxColumns) {
      normalized.push('');
    }
    return normalized;
  });
}

function escapePptxTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
}

function extractPptxContentFromXml(xml: string, relationships: Record<string, PptxRelationship> = {}): string {
  if (!xml) return '';

  const replacements: Array<{ index: number; length: number; text: string }> = [];

  for (const tableMatch of xml.matchAll(/<(?:\w+:)?tbl\b[\s\S]*?<\/(?:\w+:)?tbl>/gi)) {
    const tableText = extractPptxTablesFromXml(tableMatch[0])[0];
    if (!tableText) continue;
    replacements.push({
      index: tableMatch.index as number,
      length: tableMatch[0].length,
      text: `\n${tableText}\n`,
    });
  }

  for (const imageMatch of xml.matchAll(/<(?:\w+:)?pic\b[\s\S]*?<\/(?:\w+:)?pic>/gi)) {
    const shapeXml = imageMatch[0];
    const nameMatch = shapeXml.match(/name=(['"])(.*?)\1/i);
    const descMatch = shapeXml.match(/descr=(['"])(.*?)\1/i);
    const embedMatch = shapeXml.match(/r:embed=(['"])(.*?)\1/i);
    const embedRelation = embedMatch?.[2] ? relationships[embedMatch[2]] : undefined;

    const name = nameMatch ? nameMatch[2].trim() : 'Image';
    const parts = [name];
    if (descMatch?.[2]?.trim()) {
      parts.push(descMatch[2].trim());
    }
    if (embedMatch?.[2]?.trim()) {
      parts.push(`resource ${embedMatch[2].trim()}`);
    }
    if (embedRelation?.target) {
      parts.push(`file ${path.posix.basename(embedRelation.target)}`);
    }

    replacements.push({
      index: imageMatch.index as number,
      length: imageMatch[0].length,
      text: `\n[Image/Diagram: ${parts.join(' - ')}]\n`,
    });
  }

  for (const graphicMatch of xml.matchAll(/<(?:\w+:)?graphicFrame\b[\s\S]*?<\/(?:\w+:)?graphicFrame>/gi)) {
    const shapeXml = graphicMatch[0];
    const nameMatch = shapeXml.match(/name=(['"])(.*?)\1/i);
    const descMatch = shapeXml.match(/descr=(['"])(.*?)\1/i);
    const chartMatch = shapeXml.match(/<(?:\w+:)?chart\b[^>]*r:id=(['"])(.*?)\1/i);
    const diagramMatch = shapeXml.match(/<(?:\w+:)?relIds\b[\s\S]*?(?:\s|>)[^<]*?r:id=(['"])(.*?)\1/i);
    const typeMatch = chartMatch || diagramMatch;
    const relationId = typeMatch?.[2];
    const relation = relationId ? relationships[relationId] : undefined;
    const isChart = /<(?:\w+:)?chart\b/i.test(shapeXml);
    const isDiagram = /<(?:\w+:)?relIds/i.test(shapeXml) || /<(?:\w+:)?dgm:/i.test(shapeXml);

    const label = isChart ? 'Chart' : isDiagram ? 'Diagram' : 'Graphic';
    const parts = [label];
    const name = nameMatch ? nameMatch[2].trim() : null;
    if (name) parts.push(name);
    if (descMatch?.[2]?.trim()) {
      parts.push(descMatch[2].trim());
    }
    if (relationId?.trim()) {
      parts.push(`resource ${relationId.trim()}`);
    }
    if (relation?.target) {
      parts.push(`file ${path.posix.basename(relation.target)}`);
    }

    replacements.push({
      index: graphicMatch.index as number,
      length: graphicMatch[0].length,
      text: `\n[${parts.join(' - ')}]\n`,
    });
  }

  if (replacements.length === 0) {
    return extractTextFromPptxXml(xml);
  }

  const sorted = replacements.sort((a, b) => b.index - a.index);
  let processed = xml;
  for (const replacement of sorted) {
    processed = `${processed.slice(0, replacement.index)}${replacement.text}${processed.slice(replacement.index + replacement.length)}`;
  }

  return extractTextFromPptxXml(processed);
}
