import * as fs from "fs";

export interface LandingPageSection {
  title: string;
  content: string;
}

export interface LandingPageOptions {
  title: string;
  subtitle?: string;
  description?: string;
  author?: string;
  accentColor?: string;
  badge?: string;
  callToAction?: {
    label: string;
    href: string;
  };
  sections?: LandingPageSection[];
  footer?: string;
}

export function buildLandingPageHTML(options: LandingPageOptions): string {
  const accentColor = (options.accentColor || "#7c3aed").replace("#", "");
  const sections = Array.isArray(options.sections) ? options.sections : [];
  const cta = options.callToAction;
  const sectionMarkup = sections
    .map(
      (section) => `
        <section class="card">
          <h2>${escapeHtml(section.title)}</h2>
          <div class="rich">${markdownToHtml(section.content)}</div>
        </section>`,
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(options.title)}</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at top left, rgba(124, 58, 237, 0.25), transparent 30%),
        radial-gradient(circle at top right, rgba(59, 130, 246, 0.2), transparent 26%),
        linear-gradient(180deg, #0b1020 0%, #101829 52%, #0b1020 100%);
      color: #e5e7eb;
    }
    .shell {
      width: min(1100px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 48px 0 72px;
    }
    .hero {
      position: relative;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 28px;
      padding: 44px;
      background: rgba(6, 11, 24, 0.78);
      backdrop-filter: blur(16px);
      box-shadow: 0 20px 80px rgba(0, 0, 0, 0.35);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      border-radius: 999px;
      background: rgba(${hexToRgb(accentColor)}, 0.15);
      color: #f5f3ff;
      font-size: 13px;
      letter-spacing: 0.03em;
      text-transform: uppercase;
    }
    h1 {
      margin: 18px 0 8px;
      font-size: clamp(42px, 8vw, 86px);
      line-height: 0.95;
      letter-spacing: -0.05em;
      max-width: 11ch;
    }
    .subtitle {
      margin: 0;
      max-width: 60ch;
      font-size: 18px;
      line-height: 1.7;
      color: #cbd5e1;
    }
    .hero-grid {
      display: grid;
      grid-template-columns: 1.4fr 0.8fr;
      gap: 20px;
      margin-top: 28px;
    }
    .panel, .card {
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 22px;
      background: rgba(15, 23, 42, 0.75);
      padding: 22px;
    }
    .panel h3, .card h2 {
      margin: 0 0 12px;
      font-size: 20px;
      color: #fff;
    }
    .panel p, .rich p {
      margin: 0 0 12px;
      color: #d1d5db;
      line-height: 1.7;
    }
    .rich ul, .rich ol {
      margin: 0 0 16px 20px;
      color: #d1d5db;
      line-height: 1.7;
    }
    .cta {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-top: 18px;
      padding: 14px 20px;
      border-radius: 999px;
      background: #fff;
      color: #0f172a;
      text-decoration: none;
      font-weight: 700;
    }
    .meta {
      display: grid;
      gap: 14px;
    }
    .meta .stat {
      padding: 16px;
      border-radius: 18px;
      background: rgba(255, 255, 255, 0.04);
    }
    .meta .label {
      display: block;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #94a3b8;
      margin-bottom: 6px;
    }
    .meta .value {
      font-size: 16px;
      color: #fff;
      line-height: 1.5;
    }
    .sections {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 18px;
      margin-top: 22px;
    }
    .footer {
      margin-top: 28px;
      color: #94a3b8;
      font-size: 13px;
      text-align: center;
    }
    @media (max-width: 900px) {
      .hero-grid, .sections {
        grid-template-columns: 1fr;
      }
      .hero {
        padding: 28px;
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      ${options.badge ? `<div class="badge">${escapeHtml(options.badge)}</div>` : ""}
      <div class="hero-grid">
        <div>
          <h1>${escapeHtml(options.title)}</h1>
          ${options.subtitle ? `<p class="subtitle">${escapeHtml(options.subtitle)}</p>` : ""}
          ${options.description ? `<p class="subtitle">${escapeHtml(options.description)}</p>` : ""}
          ${cta ? `<a class="cta" href="${escapeAttribute(sanitizeHref(cta.href))}">${escapeHtml(cta.label)}</a>` : ""}
        </div>
        <aside class="meta">
          ${
            options.author
              ? `<div class="stat"><span class="label">Author</span><span class="value">${escapeHtml(options.author)}</span></div>`
              : ""
          }
          <div class="stat">
            <span class="label">Artifacts</span>
            <span class="value">Novel workspace landing page and story summary</span>
          </div>
        </aside>
      </div>
    </section>
    ${sectionMarkup ? `<section class="sections">${sectionMarkup}</section>` : ""}
    ${options.footer ? `<p class="footer">${escapeHtml(options.footer)}</p>` : ""}
  </main>
</body>
</html>`;
}

export async function generateLandingPage(
  outputPath: string,
  options: LandingPageOptions,
): Promise<{ success: boolean; path: string; size: number }> {
  const html = buildLandingPageHTML(options);
  fs.writeFileSync(outputPath, html, "utf-8");
  const stat = fs.statSync(outputPath);
  return { success: true, path: outputPath, size: stat.size };
}

function markdownToHtml(md: string): string {
  let html = escapeHtml(md || "");
  html = html.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_m, _lang, code) => `<pre><code>${code.trim()}</code></pre>`,
  );
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => {
    const safeHref = escapeAttribute(sanitizeHref(href));
    return `<a href="${safeHref}">${label}</a>`;
  });
  html = html.replace(/^\s*[-*] (.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  html = html.replace(/^(?!<[hupol]|<li|<pre|<ul|<ol|<a|<strong|<em)(.+)$/gm, "<p>$1</p>");
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

function sanitizeHref(raw: string): string {
  const href = String(raw || "").trim();
  if (!href) return "#";

  if (
    href.startsWith("#") ||
    href.startsWith("/") ||
    href.startsWith("./") ||
    href.startsWith("../")
  ) {
    return href;
  }

  try {
    const parsed = new URL(href);
    if (["http:", "https:", "mailto:", "tel:"].includes(parsed.protocol)) {
      return parsed.toString();
    }
  } catch {
    // Relative links without a leading slash remain allowed.
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) {
      return href;
    }
  }

  return "#";
}

const DEFAULT_ACCENT_RGB = "124, 58, 237"; // #7c3aed

function hexToRgb(hex: string): string {
  const cleaned = String(hex || "")
    .replace("#", "")
    .trim();
  const normalized =
    cleaned.length === 3
      ? cleaned
          .split("")
          .map((c) => `${c}${c}`)
          .join("")
      : cleaned.slice(0, 6);
  if (!/^[0-9a-fA-F]+$/.test(normalized) || normalized.length < 3) {
    return DEFAULT_ACCENT_RGB;
  }
  const value = Number.parseInt(normalized, 16);
  if (Number.isNaN(value)) {
    return DEFAULT_ACCENT_RGB;
  }
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `${r}, ${g}, ${b}`;
}
