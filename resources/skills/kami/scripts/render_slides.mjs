#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ensureNoPlaceholders,
  loadDeck,
  loadNodeRuntime,
  resolveBrowserExecutable,
} from "./runtime-utils.mjs";

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : "true";
    parsed[key] = value;
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
if (args.check === "true") {
  const browserExecutable = resolveBrowserExecutable();
  const { PptxGenJS, chromium } = loadNodeRuntime(import.meta.url);
  console.log(`[kami] node module pptxgenjs: ${PptxGenJS ? "ok" : "missing"}`);
  console.log(`[kami] node module playwright: ${chromium ? "ok" : "missing"}`);
  console.log(
    `[kami] browser executable: ${browserExecutable ? `ok (${browserExecutable})` : "missing"}`,
  );
  process.exit(browserExecutable ? 0 : 1);
}

const sourceArg = args.source;
const outputDirArg = args["output-dir"];
const format = String(args.format || "pptx").toLowerCase();

if (!sourceArg || !outputDirArg) {
  console.error(
    "Usage: node render_slides.mjs --source <deck.mjs> --output-dir <dir> --format <pptx|pdf|both>",
  );
  process.exit(2);
}

const sourcePath = path.resolve(sourceArg);
const outputDir = path.resolve(outputDirArg);
const outputPptx = path.join(outputDir, "output.pptx");
const outputPdf = path.join(outputDir, "output.pdf");
const outputHtml = path.join(outputDir, "output.html");

const shouldRenderPptx = format === "pptx" || format === "both";
const shouldRenderPdf = format === "pdf" || format === "both";

const themeDefaults = {
  parchment: "#f5f4ed",
  ivory: "#faf9f5",
  brand: "#1B365D",
  text: "#141413",
  darkWarm: "#3d3d3a",
  olive: "#5e5d59",
  stone: "#87867f",
  border: "#e8e6dc",
  serif: "Newsreader",
  sans: "Inter",
};

function hex(value, fallback) {
  const normalized = String(value || fallback || "").trim();
  return normalized.startsWith("#") ? normalized.slice(1) : normalized;
}

function normalizeTheme(deck) {
  const theme = { ...themeDefaults, ...(deck.theme || {}) };
  return {
    ...theme,
    parchmentHex: hex(theme.parchment, themeDefaults.parchment),
    ivoryHex: hex(theme.ivory, themeDefaults.ivory),
    brandHex: hex(theme.brand, themeDefaults.brand),
    textHex: hex(theme.text, themeDefaults.text),
    darkWarmHex: hex(theme.darkWarm, themeDefaults.darkWarm),
    oliveHex: hex(theme.olive, themeDefaults.olive),
    stoneHex: hex(theme.stone, themeDefaults.stone),
    borderHex: hex(theme.border, themeDefaults.border),
  };
}

function lineArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (value == null) return [];
  return [String(value)];
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function slideTitle(slide) {
  return slide.title || slide.message || slide.quote || "Untitled slide";
}

function addParagraphs(slide, lines, options) {
  if (!lines.length) return;
  slide.addText(
    lines.map((line) => ({
      text: line,
      options: {
        breakLine: true,
        fontFace: options.fontFace,
        fontSize: options.fontSize,
        color: options.color,
        bullet: options.bullet ? { type: "bullet" } : undefined,
        paraSpaceAfterPt: options.spaceAfter ?? 8,
      },
    })),
    {
      x: options.x,
      y: options.y,
      w: options.w,
      h: options.h,
      margin: 0,
      valign: "top",
    },
  );
}

async function renderPptx(deck, theme) {
  const { PptxGenJS } = loadNodeRuntime(import.meta.url);
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "KAMI_WIDE", width: 13.33, height: 7.5 });
  pptx.layout = "KAMI_WIDE";
  pptx.author = deck.metadata?.author || "CoWork OS";
  pptx.title = deck.metadata?.title || slideTitle(deck.slides[0] || {});
  pptx.subject = deck.metadata?.subject || "Kami slide deck";
  pptx.company = "CoWork OS";

  for (const slideDef of deck.slides) {
    const slide = pptx.addSlide();
    slide.background = { color: theme.parchmentHex };
    if (slideDef.notes) {
      slide.addNotes(String(slideDef.notes));
    }

    switch (slideDef.kind) {
      case "cover": {
        slide.addText(String(slideDef.title || ""), {
          x: 1.0,
          y: 2.35,
          w: 11.33,
          h: 0.8,
          fontFace: theme.serif,
          fontSize: 30,
          color: theme.textHex,
          align: "center",
          margin: 0,
        });
        slide.addShape(pptx.ShapeType.line, {
          x: 6.17,
          y: 3.55,
          w: 1.0,
          h: 0,
          line: { color: theme.brandHex, width: 1.5 },
        });
        slide.addText(String(slideDef.subtitle || ""), {
          x: 1.0,
          y: 3.8,
          w: 11.33,
          h: 0.5,
          fontFace: theme.sans,
          fontSize: 16,
          color: theme.oliveHex,
          align: "center",
          margin: 0,
        });
        slide.addText(String(slideDef.footer || deck.metadata?.author || ""), {
          x: 1.0,
          y: 6.6,
          w: 11.33,
          h: 0.3,
          fontFace: theme.sans,
          fontSize: 11,
          color: theme.stoneHex,
          align: "center",
          margin: 0,
        });
        break;
      }
      case "toc": {
        slide.addText(String(slideDef.title || "Contents"), {
          x: 1.2,
          y: 0.75,
          w: 10.0,
          h: 0.5,
          fontFace: theme.serif,
          fontSize: 24,
          color: theme.textHex,
          margin: 0,
        });
        slide.addShape(pptx.ShapeType.line, {
          x: 1.2,
          y: 1.75,
          w: 11.0,
          h: 0,
          line: { color: theme.borderHex, width: 1 },
        });
        for (const [index, item] of lineArray(slideDef.items).entries()) {
          const y = 2.3 + index * 0.72;
          slide.addText(String(index + 1).padStart(2, "0"), {
            x: 1.2,
            y,
            w: 0.8,
            h: 0.3,
            fontFace: theme.serif,
            fontSize: 20,
            color: theme.brandHex,
            margin: 0,
          });
          slide.addText(item, {
            x: 2.3,
            y,
            w: 8.8,
            h: 0.3,
            fontFace: theme.serif,
            fontSize: 18,
            color: theme.textHex,
            margin: 0,
          });
        }
        break;
      }
      case "chapter": {
        slide.background = { color: theme.brandHex };
        slide.addText(String(slideDef.number || ""), {
          x: 0.8,
          y: 0.5,
          w: 1.5,
          h: 0.3,
          fontFace: theme.serif,
          fontSize: 20,
          color: "FFFFFF",
          margin: 0,
        });
        slide.addText(String(slideDef.title || ""), {
          x: 1.0,
          y: 3.0,
          w: 11.33,
          h: 0.8,
          fontFace: theme.serif,
          fontSize: 40,
          color: "FFFFFF",
          align: "center",
          margin: 0,
        });
        break;
      }
      case "metrics": {
        slide.addText(String(slideDef.title || ""), {
          x: 1.2,
          y: 0.8,
          w: 11.0,
          h: 0.4,
          fontFace: theme.serif,
          fontSize: 22,
          color: theme.textHex,
          align: "center",
          margin: 0,
        });
        slide.addShape(pptx.ShapeType.line, {
          x: 6.17,
          y: 1.95,
          w: 1.0,
          h: 0,
          line: { color: theme.brandHex, width: 1 },
        });
        const metrics = Array.isArray(slideDef.metrics) ? slideDef.metrics : [];
        const cardWidth = 2.6;
        const gap = 0.28;
        const totalWidth = metrics.length * cardWidth + Math.max(0, metrics.length - 1) * gap;
        const start = (13.33 - totalWidth) / 2;
        for (const [index, metric] of metrics.entries()) {
          const x = start + index * (cardWidth + gap);
          slide.addText(String(metric.value || ""), {
            x,
            y: 3.0,
            w: cardWidth,
            h: 0.7,
            fontFace: theme.serif,
            fontSize: 34,
            color: theme.brandHex,
            align: "center",
            margin: 0,
          });
          slide.addText(String(metric.label || ""), {
            x,
            y: 4.55,
            w: cardWidth,
            h: 0.3,
            fontFace: theme.sans,
            fontSize: 11,
            color: theme.oliveHex,
            align: "center",
            margin: 0,
          });
        }
        break;
      }
      case "quote": {
        slide.addText(`“${String(slideDef.quote || "")}”`, {
          x: 1.5,
          y: 2.7,
          w: 10.33,
          h: 1.6,
          fontFace: theme.serif,
          fontSize: 24,
          color: theme.textHex,
          align: "center",
          margin: 0,
        });
        slide.addText(String(slideDef.source || ""), {
          x: 1.5,
          y: 5.25,
          w: 10.33,
          h: 0.3,
          fontFace: theme.sans,
          fontSize: 11,
          color: theme.oliveHex,
          align: "center",
          margin: 0,
        });
        break;
      }
      case "ending": {
        slide.addText(String(slideDef.message || slideDef.title || "Thank you"), {
          x: 1.0,
          y: 3.0,
          w: 11.33,
          h: 0.7,
          fontFace: theme.serif,
          fontSize: 30,
          color: theme.textHex,
          align: "center",
          margin: 0,
        });
        slide.addShape(pptx.ShapeType.line, {
          x: 6.17,
          y: 4.45,
          w: 1.0,
          h: 0,
          line: { color: theme.brandHex, width: 1.5 },
        });
        slide.addText(String(slideDef.contact || slideDef.footer || ""), {
          x: 1.0,
          y: 4.75,
          w: 11.33,
          h: 0.3,
          fontFace: theme.sans,
          fontSize: 12,
          color: theme.oliveHex,
          align: "center",
          margin: 0,
        });
        break;
      }
      case "content":
      default: {
        if (slideDef.eyebrow) {
          slide.addText(String(slideDef.eyebrow).toUpperCase(), {
            x: 1.2,
            y: 0.65,
            w: 10.0,
            h: 0.2,
            fontFace: theme.sans,
            fontSize: 9,
            color: theme.stoneHex,
            margin: 0,
          });
        }
        slide.addText(String(slideDef.title || ""), {
          x: 1.2,
          y: 1.2,
          w: 11.0,
          h: 0.7,
          fontFace: theme.serif,
          fontSize: 24,
          color: theme.textHex,
          margin: 0,
        });
        const lines = lineArray(slideDef.body);
        addParagraphs(slide, lines, {
          x: 1.2,
          y: 2.65,
          w: 10.6,
          h: 3.5,
          fontFace: theme.sans,
          fontSize: 14,
          color: theme.darkWarmHex,
          bullet: true,
          spaceAfter: 10,
        });
        if (slideDef.pageNumber != null) {
          slide.addText(`— ${String(slideDef.pageNumber).padStart(2, "0")}`, {
            x: 11.5,
            y: 6.9,
            w: 0.8,
            h: 0.2,
            fontFace: theme.sans,
            fontSize: 9,
            color: theme.stoneHex,
            align: "right",
            margin: 0,
          });
        }
      }
    }
  }

  await pptx.writeFile({ fileName: outputPptx });
  console.log(`[kami] output.pptx: ${outputPptx}`);
}

function fontFace(name, filePath, weight = 400) {
  if (!filePath || !fs.existsSync(filePath)) return "";
  return `@font-face{font-family:"${name}";src:url("${pathToFileURL(filePath).href}") format("woff2");font-weight:${weight};font-style:normal;}`;
}

function bodyHtml(lines) {
  return lineArray(lines)
    .map((line) => `<li>${escapeHtml(line)}</li>`)
    .join("");
}

function renderHtml(deck, theme) {
  const projectDir = path.dirname(path.dirname(sourcePath));
  const fontsDir = path.join(projectDir, "fonts");
  const serifFont = path.join(fontsDir, "Newsreader.woff2");
  const sansFont = path.join(fontsDir, "Inter.woff2");
  const sansMediumFont = path.join(fontsDir, "Inter-500.woff2");

  const slideMarkup = deck.slides
    .map((slideDef, index) => {
      switch (slideDef.kind) {
        case "cover":
          return `<section class="slide cover">
  <div class="cover-title">${escapeHtml(slideDef.title || "")}</div>
  <div class="cover-line"></div>
  <div class="cover-subtitle">${escapeHtml(slideDef.subtitle || "")}</div>
  <div class="cover-footer">${escapeHtml(slideDef.footer || deck.metadata?.author || "")}</div>
</section>`;
        case "toc":
          return `<section class="slide toc">
  <div class="toc-title">${escapeHtml(slideDef.title || "Contents")}</div>
  <div class="rule"></div>
  <div class="toc-list">${lineArray(slideDef.items)
    .map(
      (item, itemIndex) =>
        `<div class="toc-row"><span class="toc-number">${String(itemIndex + 1).padStart(2, "0")}</span><span class="toc-item">${escapeHtml(item)}</span></div>`,
    )
    .join("")}</div>
</section>`;
        case "chapter":
          return `<section class="slide chapter">
  <div class="chapter-number">${escapeHtml(slideDef.number || "")}</div>
  <div class="chapter-title">${escapeHtml(slideDef.title || "")}</div>
</section>`;
        case "metrics":
          return `<section class="slide metrics">
  <div class="slide-title centered">${escapeHtml(slideDef.title || "")}</div>
  <div class="center-line"></div>
  <div class="metrics-grid">${(Array.isArray(slideDef.metrics) ? slideDef.metrics : [])
    .map(
      (metric) =>
        `<div class="metric-card"><div class="metric-value">${escapeHtml(metric.value || "")}</div><div class="metric-label">${escapeHtml(metric.label || "")}</div></div>`,
    )
    .join("")}</div>
</section>`;
        case "quote":
          return `<section class="slide quote">
  <div class="quote-text">“${escapeHtml(slideDef.quote || "")}”</div>
  <div class="quote-source">${escapeHtml(slideDef.source || "")}</div>
</section>`;
        case "ending":
          return `<section class="slide ending">
  <div class="ending-message">${escapeHtml(slideDef.message || slideDef.title || "Thank you")}</div>
  <div class="center-line"></div>
  <div class="ending-contact">${escapeHtml(slideDef.contact || slideDef.footer || "")}</div>
</section>`;
        case "content":
        default:
          return `<section class="slide content">
  ${slideDef.eyebrow ? `<div class="eyebrow">${escapeHtml(String(slideDef.eyebrow).toUpperCase())}</div>` : ""}
  <div class="slide-title">${escapeHtml(slideDef.title || "")}</div>
  <ul class="body-list">${bodyHtml(slideDef.body)}</ul>
  ${slideDef.pageNumber != null ? `<div class="page-number">— ${escapeHtml(String(slideDef.pageNumber).padStart(2, "0"))}</div>` : ""}
</section>`;
      }
    })
    .join("\n");

  return `<!doctype html>
<html lang="${escapeHtml(deck.metadata?.language || "en")}">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(deck.metadata?.title || "Kami Slides")}</title>
  <style>
    ${fontFace("KamiSerif", serifFont, 500)}
    ${fontFace("KamiSans", sansFont, 400)}
    ${fontFace("KamiSans", sansMediumFont, 500)}
    @page { size: 13.33in 7.5in; margin: 0; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    html, body { margin: 0; padding: 0; background: #${theme.parchmentHex}; }
    body {
      font-family: "KamiSans", Inter, Arial, sans-serif;
      color: #${theme.textHex};
    }
    .slide {
      width: 13.33in;
      height: 7.5in;
      padding: 0.75in 0.95in;
      background: #${theme.parchmentHex};
      page-break-after: always;
      break-after: page;
      position: relative;
      overflow: hidden;
    }
    .slide:last-child { page-break-after: auto; break-after: auto; }
    .cover, .quote, .ending { display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; }
    .chapter {
      background: #${theme.brandHex};
      color: #ffffff;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      text-align: center;
    }
    .chapter-number {
      position: absolute;
      top: 0.45in;
      left: 0.75in;
      font-family: "KamiSerif", Newsreader, Georgia, serif;
      font-size: 21pt;
      color: #ffffff;
    }
    .chapter-title, .cover-title, .ending-message, .quote-text, .slide-title, .toc-title {
      font-family: "KamiSerif", Newsreader, Georgia, serif;
      font-weight: 500;
      letter-spacing: -0.01em;
    }
    .cover-title { font-size: 30pt; line-height: 1.15; max-width: 10.8in; }
    .cover-subtitle, .cover-footer, .quote-source, .ending-contact, .eyebrow, .page-number {
      font-family: "KamiSans", Inter, Arial, sans-serif;
    }
    .cover-line, .center-line, .rule {
      width: 1in;
      height: 1.5pt;
      background: #${theme.brandHex};
      margin: 0.28in 0;
    }
    .cover-subtitle, .ending-contact, .quote-source {
      color: #${theme.oliveHex};
      font-size: 12pt;
      line-height: 1.4;
      max-width: 10in;
    }
    .cover-footer {
      position: absolute;
      bottom: 0.45in;
      color: #${theme.stoneHex};
      font-size: 10pt;
    }
    .toc-title { font-size: 24pt; margin-top: 0.02in; }
    .rule { width: 11in; margin: 0.42in 0 0.36in; background: #${theme.borderHex}; }
    .toc-list { margin-top: 0.08in; }
    .toc-row { display: flex; align-items: baseline; gap: 0.32in; margin: 0.22in 0; }
    .toc-number { width: 0.7in; color: #${theme.brandHex}; font-family: "KamiSerif", Newsreader, Georgia, serif; font-size: 20pt; }
    .toc-item { font-family: "KamiSerif", Newsreader, Georgia, serif; font-size: 18pt; }
    .slide-title { font-size: 24pt; line-height: 1.18; max-width: 10.8in; }
    .slide-title.centered { text-align: center; max-width: none; }
    .eyebrow {
      color: #${theme.stoneHex};
      font-size: 9pt;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 0.26in;
    }
    .body-list {
      margin: 0.58in 0 0;
      padding-left: 0.28in;
      max-width: 10.3in;
    }
    .body-list li {
      margin: 0 0 0.18in;
      color: #${theme.darkWarmHex};
      font-size: 14pt;
      line-height: 1.35;
    }
    .page-number {
      position: absolute;
      right: 0.95in;
      bottom: 0.38in;
      color: #${theme.stoneHex};
      font-size: 9pt;
    }
    .metrics-grid {
      margin-top: 1.05in;
      display: flex;
      justify-content: center;
      gap: 0.32in;
    }
    .metric-card { width: 2.55in; text-align: center; }
    .metric-value {
      font-family: "KamiSerif", Newsreader, Georgia, serif;
      color: #${theme.brandHex};
      font-size: 34pt;
      line-height: 1.05;
    }
    .metric-label {
      margin-top: 0.18in;
      font-size: 11pt;
      color: #${theme.oliveHex};
    }
    .quote-text {
      max-width: 10.4in;
      font-size: 24pt;
      line-height: 1.25;
    }
    .quote-source { margin-top: 0.42in; }
    .ending-message { font-size: 30pt; }
    .chapter-title {
      color: #ffffff;
      font-size: 40pt;
      line-height: 1.12;
      max-width: 10.6in;
    }
  </style>
</head>
<body>
${slideMarkup}
</body>
</html>`;
}

async function renderPdf(deck, theme) {
  const { chromium } = loadNodeRuntime(import.meta.url);
  const executablePath = resolveBrowserExecutable();
  if (!chromium) {
    throw new Error("Playwright runtime is unavailable.");
  }
  if (!executablePath) {
    throw new Error(
      "No Chromium-based browser executable was found for PDF export. Install Chrome, Chromium, Edge, or Brave.",
    );
  }

  const html = renderHtml(deck, theme);
  fs.writeFileSync(outputHtml, html, "utf-8");

  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage({
      viewport: { width: 1333, height: 750 },
    });
    await page.goto(pathToFileURL(outputHtml).href, { waitUntil: "load" });
    await page.emulateMedia({ media: "screen" });
    await page.pdf({
      path: outputPdf,
      width: "13.33in",
      height: "7.5in",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });
  } finally {
    await browser.close();
  }

  console.log(`[kami] output.html: ${outputHtml}`);
  console.log(`[kami] output.pdf: ${outputPdf}`);
}

async function main() {
  ensureNoPlaceholders(sourcePath);
  const deck = await loadDeck(sourcePath);
  const theme = normalizeTheme(deck);
  fs.mkdirSync(outputDir, { recursive: true });

  if (shouldRenderPptx) {
    await renderPptx(deck, theme);
  }
  if (shouldRenderPdf) {
    await renderPdf(deck, theme);
  }
}

main().catch((error) => {
  console.error(`[kami] ${error.message}`);
  process.exit(1);
});
