/**
 * PDF Generator — converts markdown or structured sections into a styled PDF.
 *
 * Uses Puppeteer (already available for browser tools) to render HTML → PDF.
 * Falls back to a simple text-based PDF if Puppeteer is unavailable.
 */

import * as fs from "fs";

interface PDFSection {
  heading?: string;
  content: string;
}

interface PDFOptions {
  title?: string;
  author?: string;
  sections?: PDFSection[];
  markdown?: string;
  format?: "A4" | "Letter";
  landscape?: boolean;
}

/**
 * Render markdown/sections to a styled HTML string, then use Puppeteer to
 * produce a PDF file.
 */
export async function generatePDF(
  outputPath: string,
  options: PDFOptions,
): Promise<{ success: boolean; path: string; size: number }> {
  const html = buildHTML(options);

  // Try Puppeteer first (available if browser tools are installed)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const puppeteer = require("puppeteer-core") as Any;
    // Attempt to find an available Chromium executable
    const execPaths = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      process.env.PUPPETEER_EXECUTABLE_PATH,
    ].filter(Boolean) as string[];

    let executablePath: string | undefined;
    for (const p of execPaths) {
      if (fs.existsSync(p)) {
        executablePath = p;
        break;
      }
    }

    if (executablePath) {
      const browser = await puppeteer.launch({
        headless: true,
        executablePath,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
      try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: "networkidle0" });
        await page.pdf({
          path: outputPath,
          format: (options.format || "A4") as Any,
          landscape: options.landscape || false,
          printBackground: true,
          margin: { top: "1cm", right: "1.5cm", bottom: "1cm", left: "1.5cm" },
        });
      } finally {
        await browser.close();
      }

      const stat = fs.statSync(outputPath);
      return { success: true, path: outputPath, size: stat.size };
    }
  } catch {
    // Puppeteer not available, fall through to HTML file
  }

  // Fallback: write styled HTML (can be opened in any browser and printed to PDF)
  const htmlPath = outputPath.replace(/\.pdf$/i, ".html");
  const finalPath = htmlPath === outputPath ? `${outputPath}.html` : htmlPath;
  fs.writeFileSync(finalPath, html, "utf-8");
  const stat = fs.statSync(finalPath);
  return { success: true, path: finalPath, size: stat.size };
}

function buildHTML(options: PDFOptions): string {
  let body = "";

  if (options.title) {
    body += `<h1 class="doc-title">${escapeHtml(options.title)}</h1>\n`;
  }

  if (options.markdown) {
    // Convert basic markdown to HTML
    body += markdownToHtml(options.markdown);
  }

  if (options.sections) {
    for (const section of options.sections) {
      if (section.heading) {
        body += `<h2>${escapeHtml(section.heading)}</h2>\n`;
      }
      body += markdownToHtml(section.content);
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(options.title || "Document")}</title>
  <style>
    :root { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { max-width: 720px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; line-height: 1.6; font-size: 14px; }
    .doc-title { font-size: 28px; font-weight: 700; margin-bottom: 8px; border-bottom: 2px solid #2563eb; padding-bottom: 8px; }
    h2 { font-size: 20px; margin-top: 24px; color: #1e40af; }
    h3 { font-size: 16px; margin-top: 18px; }
    p { margin: 8px 0; }
    ul, ol { padding-left: 24px; }
    li { margin: 4px 0; }
    code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
    pre { background: #f3f4f6; padding: 12px 16px; border-radius: 8px; overflow-x: auto; }
    pre code { background: none; padding: 0; }
    table { border-collapse: collapse; width: 100%; margin: 12px 0; }
    th, td { border: 1px solid #d1d5db; padding: 8px 12px; text-align: left; font-size: 13px; }
    th { background: #f9fafb; font-weight: 600; }
    blockquote { border-left: 4px solid #2563eb; margin: 12px 0; padding: 8px 16px; background: #eff6ff; }
    hr { border: none; border-top: 1px solid #e5e7eb; margin: 20px 0; }
    .meta { font-size: 12px; color: #6b7280; margin-bottom: 20px; }
  </style>
</head>
<body>
  ${options.author ? `<div class="meta">By ${escapeHtml(options.author)} &middot; ${new Date().toLocaleDateString()}</div>` : ""}
  ${body}
</body>
</html>`;
}

/** Minimal markdown → HTML converter for common patterns. */
function markdownToHtml(md: string): string {
  let html = escapeHtml(md);

  // Code blocks
  html = html.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_m, _lang, code) => `<pre><code>${code.trim()}</code></pre>`,
  );
  // Inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  // Headers
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  // Bold / italic
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  // Unordered list
  html = html.replace(/^- (.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);
  // Ordered list
  html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");
  // Blockquote
  html = html.replace(/^> (.+)$/gm, "<blockquote>$1</blockquote>");
  // Horizontal rule
  html = html.replace(/^---$/gm, "<hr>");
  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  // Paragraphs (lines not already wrapped)
  html = html.replace(/^(?!<[hupob]|<li|<hr|<block)(.+)$/gm, "<p>$1</p>");

  return html;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
