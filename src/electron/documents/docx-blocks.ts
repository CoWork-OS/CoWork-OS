import JSZip from "jszip";

export type DocxBlockKind = "heading" | "paragraph" | "table";

export interface ParsedDocxBlock {
  id: string;
  type: DocxBlockKind;
  text: string;
  level?: number;
  rows?: string[][];
  order: number;
  startIndex: number;
  endIndex: number;
  xml: string;
}

function decodeXmlText(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractTextRuns(xml: string): string {
  const parts: string[] = [];
  const textRegex = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  let match: RegExpExecArray | null;
  while ((match = textRegex.exec(xml)) !== null) {
    parts.push(decodeXmlText(match[1]));
  }
  return parts.join("").replace(/\s+/g, " ").trim();
}

function parseTableRows(tableXml: string): string[][] {
  const rows: string[][] = [];
  const rowRegex = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRegex.exec(tableXml)) !== null) {
    const rowXml = rowMatch[1];
    const cells: string[] = [];
    const cellRegex = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRegex.exec(rowXml)) !== null) {
      cells.push(extractTextRuns(cellMatch[1]));
    }
    rows.push(cells);
  }
  return rows;
}

function parseTopLevelElements(
  bodyXml: string,
): Array<{ kind: "paragraph" | "table"; xml: string; start: number; end: number }> {
  const elements: Array<{ kind: "paragraph" | "table"; xml: string; start: number; end: number }> =
    [];
  const elementRegex = /<w:(p|tbl)\b[^>]*>[\s\S]*?<\/w:\1>/g;
  let match: RegExpExecArray | null;
  while ((match = elementRegex.exec(bodyXml)) !== null) {
    const kind = match[1] === "tbl" ? "table" : "paragraph";
    elements.push({
      kind,
      xml: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return elements;
}

export function parseDocxBlocksFromXml(xmlContent: string): ParsedDocxBlock[] {
  const bodyMatch = xmlContent.match(/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/);
  if (!bodyMatch || bodyMatch.index === undefined) {
    throw new Error("Invalid DOCX file: missing w:body");
  }

  const bodyXml = bodyMatch[1];
  const bodyOffset = bodyMatch.index + bodyMatch[0].indexOf(bodyXml);
  const elements = parseTopLevelElements(bodyXml);

  return elements
    .map((element, index): ParsedDocxBlock | null => {
      if (element.kind === "table") {
        const rows = parseTableRows(element.xml);
        const text = rows
          .map((row) => row.join(" | "))
          .join("\n")
          .trim();
        return {
          id: `tbl-${index + 1}`,
          type: "table",
          text,
          rows,
          order: index,
          startIndex: bodyOffset + element.start,
          endIndex: bodyOffset + element.end,
          xml: element.xml,
        };
      }

      const text = extractTextRuns(element.xml);
      if (!text) return null;
      const headingMatch = element.xml.match(/<w:pStyle\s+w:val="Heading([1-6])"\s*\/>/);
      const level = headingMatch ? parseInt(headingMatch[1], 10) : undefined;
      return {
        id: `p-${index + 1}`,
        type: level ? "heading" : "paragraph",
        text,
        level,
        order: index,
        startIndex: bodyOffset + element.start,
        endIndex: bodyOffset + element.end,
        xml: element.xml,
      };
    })
    .filter((block): block is ParsedDocxBlock => block !== null);
}

export async function parseDocxBlocksFromBuffer(buffer: Buffer): Promise<ParsedDocxBlock[]> {
  const zip = await JSZip.loadAsync(buffer);
  const documentXml = zip.file("word/document.xml");
  if (!documentXml) {
    throw new Error("Invalid DOCX file: missing word/document.xml");
  }
  const xmlContent = await documentXml.async("text");
  return parseDocxBlocksFromXml(xmlContent);
}
