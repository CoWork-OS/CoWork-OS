import * as fs from "fs";
import * as path from "path";
import JSZip from "jszip";

export interface EpubChapter {
  title: string;
  content: string;
}

export interface EpubOptions {
  title: string;
  author?: string;
  language?: string;
  description?: string;
  publisher?: string;
  chapters: EpubChapter[];
}

export async function generateEPUB(
  outputPath: string,
  options: EpubOptions,
): Promise<{ success: boolean; path: string; size: number; chapterCount: number }> {
  const zip = new JSZip();
  const chapters = Array.isArray(options.chapters) ? options.chapters : [];
  const safeTitle = escapeHtml(options.title || "Untitled");
  const language = options.language || "en";

  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" />
  </rootfiles>
</container>`,
  );

  zip.file(
    "OEBPS/styles.css",
    `body{font-family:Georgia,serif;line-height:1.7;color:#111;margin:0;padding:0 1.2rem 2rem;background:#fff}h1,h2,h3{font-family:Inter,system-ui,sans-serif}h1{font-size:2.6rem;margin:2rem 0 1rem}h2{font-size:1.8rem;margin:2rem 0 1rem}p{margin:0 0 1rem}nav ol{padding-left:1.4rem}.chapter{page-break-after:always}.meta{color:#555;font-size:.95rem}`,
  );

  const spineItems: string[] = [];
  const manifestItems: string[] = [
    `<item id="css" href="styles.css" media-type="text/css" />`,
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />`,
    `<item id="titlepage" href="titlepage.xhtml" media-type="application/xhtml+xml" />`,
  ];

  zip.file(
    "OEBPS/titlepage.xhtml",
    renderXhtmlDocument(
      safeTitle,
      `
        <article class="chapter">
          <h1>${safeTitle}</h1>
          ${options.author ? `<p class="meta">By ${escapeHtml(options.author)}</p>` : ""}
          ${options.description ? `<p>${escapeHtml(options.description)}</p>` : ""}
        </article>`,
    ),
  );
  spineItems.push(`<itemref idref="titlepage" />`);

  chapters.forEach((chapter, index) => {
    const fileName = `chapter-${String(index + 1).padStart(3, "0")}.xhtml`;
    const id = `ch${index + 1}`;
    manifestItems.push(`<item id="${id}" href="${fileName}" media-type="application/xhtml+xml" />`);
    spineItems.push(`<itemref idref="${id}" />`);
    zip.file(
      `OEBPS/${fileName}`,
      renderXhtmlDocument(
        `${safeTitle} - ${escapeHtml(chapter.title)}`,
        `
          <article class="chapter">
            <h2>${escapeHtml(chapter.title)}</h2>
            ${markdownToXhtml(chapter.content)}
          </article>`,
      ),
    );
  });

  zip.file(
    "OEBPS/nav.xhtml",
    renderXhtmlDocument(
      `${safeTitle} Contents`,
      `
        <nav epub:type="toc" id="toc">
          <h1>Contents</h1>
          <ol>
            <li><a href="titlepage.xhtml">Title Page</a></li>
            ${chapters
              .map(
                (chapter, index) =>
                  `<li><a href="chapter-${String(index + 1).padStart(3, "0")}.xhtml">${escapeHtml(chapter.title)}</a></li>`,
              )
              .join("\n")}
          </ol>
        </nav>`,
    ),
  );

  manifestItems.push(
    `<item id="toc" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />`,
  );

  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0" xml:lang="${escapeAttribute(language)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:${createUuid()}</dc:identifier>
    <dc:title>${safeTitle}</dc:title>
    ${options.author ? `<dc:creator>${escapeHtml(options.author)}</dc:creator>` : ""}
    <dc:language>${escapeHtml(language)}</dc:language>
    ${options.publisher ? `<dc:publisher>${escapeHtml(options.publisher)}</dc:publisher>` : ""}
    ${options.description ? `<dc:description>${escapeHtml(options.description)}</dc:description>` : ""}
  </metadata>
  <manifest>
    ${manifestItems.join("\n    ")}
  </manifest>
  <spine>
    ${spineItems.join("\n    ")}
  </spine>
</package>`,
  );

  const content = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    mimeType: "application/epub+zip",
  });

  fs.writeFileSync(outputPath, content);
  const stat = fs.statSync(outputPath);
  return { success: true, path: outputPath, size: stat.size, chapterCount: chapters.length };
}

function renderXhtmlDocument(title: string, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>${title}</title>
    <link rel="stylesheet" type="text/css" href="styles.css" />
  </head>
  <body>
    ${body}
  </body>
</html>`;
}

function markdownToXhtml(md: string): string {
  let html = escapeHtml(String(md || ""));
  html = html.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_m, _lang, code) => `<pre><code>${code.trim()}</code></pre>`,
  );
  html = html.replace(/^\s*[-*] (.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  html = html.replace(/^(?!<[hupol]|<li|<pre|<ul|<ol|<strong|<em)(.+)$/gm, "<p>$1</p>");
  return html;
}

function escapeHtml(str: string): string {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttribute(str: string): string {
  return escapeHtml(str).replace(/'/g, "&#39;");
}

function createUuid(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
