import { loadDocumentArchive, readDocumentArchiveBuffer } from "../../security/document-archive";

/** Local, bounded archive inspection; never executes document code or external programs. */
export async function inspectOfficeArtifact(
  filename: string,
  kind: "xlsx" | "docx",
): Promise<Record<string, unknown>> {
  const zip = await loadDocumentArchive(await readDocumentArchiveBuffer(filename));
  if (kind === "xlsx") {
    const workbook = (await zip.file("xl/workbook.xml")?.async("string")) || "";
    const sheetNames = Array.from(workbook.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g), (match) =>
      match[1]
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&"),
    );
    let formulaCount = 0;
    let cachedFormulaCount = 0;
    const formulaErrors: string[] = [];
    for (const entry of Object.values(zip.files).filter((file) =>
      /^xl\/worksheets\/sheet\d+\.xml$/.test(file.name),
    )) {
      const xml = await entry.async("string");
      for (const match of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        if (/<f(?:\s|>|\/)/.test(match[2])) {
          formulaCount++;
          if (/<v>[^<]+<\/v>/.test(match[2])) cachedFormulaCount++;
        }
        if (/\bt="e"/.test(match[1]))
          formulaErrors.push(
            `${entry.name}: ${/<v>([^<]*)<\/v>/.exec(match[2])?.[1] || "cell error"}`,
          );
      }
    }
    return {
      kind,
      sheetCount: sheetNames.length,
      sheetNames,
      formulaCount,
      cachedFormulaCount,
      chartCount: Object.keys(zip.files).filter((name) => /^xl\/charts\/chart\d+\.xml$/.test(name))
        .length,
      formulaErrors,
      note: "Counts describe the saved workbook. Formula caches are inspected; formulas are not recalculated.",
    };
  }
  const xml = (await zip.file("word/document.xml")?.async("string")) || "";
  return {
    kind,
    explicitPageBreaks: (
      xml.match(/<w:pageBreakBefore\b(?![^>]*w:val="(?:0|false)")|<w:br\b[^>]*w:type="page"/g) || []
    ).length,
    textColors: [
      ...new Set(
        Array.from(xml.matchAll(/<w:color\b[^>]*w:val="([A-Fa-f0-9]{6})"/g), (match) =>
          match[1].toUpperCase(),
        ),
      ),
    ],
    tableCount: (xml.match(/<w:tbl>/g) || []).length,
    renderedPageCount: null,
    paginationNote:
      "Page breaks describe structure. Actual Word pagination requires a compatible renderer; this inspection does not measure it.",
  };
}
