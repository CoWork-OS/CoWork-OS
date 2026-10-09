import { HTML_KIT_CSS } from "./answer-surfaces/html-kit";
import { asciiLowerCase, findOpeningTag, insertAfterTag } from "./html-tags";

const RICH_FRAME_EXAMPLE = [
  '<html data-theme="ocean"><body><div class="cw-card cw-card-gradient cw-stack">',
  '  <div><div class="cw-eyebrow">Savings plan</div><h2 class="cw-title">Reach $50,000</h2></div>',
  '  <div class="cw-hero"><div class="cw-hero-label">Save each month</div><div class="cw-hero-value" id="monthly">—</div><div class="cw-hero-caption" id="caption"></div></div>',
  '  <div class="cw-field"><div class="cw-field-row"><label for="years">Timeline</label><span class="cw-value" id="yearsOut"></span></div><input id="years" type="range" min="1" max="30" value="5"></div>',
  '  <div id="growth"></div>',
  "</div><script>",
  "const years = document.getElementById('years');",
  "function render() { const n = +years.value, r = 0.04 / 12, m = n * 12, monthly = 50000 * r / (Math.pow(1 + r, m) - 1);",
  "  cowork.tween('#monthly', monthly, { prefix: '$' }); yearsOut.textContent = n + ' years'; caption.textContent = 'at 4% a year';",
  "  cowork.chart('#growth', { type: 'area', prefix: '$', labels: [...Array(n + 1).keys()].map(String), series: [{ name: 'Balance', values: [...Array(n + 1).keys()].map((y) => monthly * (Math.pow(1 + r, y * 12) - 1) / r) }] });",
  "  cowork.state.set({ years: n }); }",
  "years.addEventListener('input', render);",
  "cowork.ready.then(() => { const s = cowork.state.get(); if (s.years) years.value = s.years; render(); });",
  "</script></body></html>",
].join("\n");

export const RICH_FRAME_DESIGN_LANGUAGE_PROMPT = [
  "Inline HTML design kit (injected into every inline frame; use it instead of writing your own styles):",
  "- Look: a modern, colorful app card, not a document. Lead with the result (a cw-hero or cw-metrics), then the inputs that change it, then detail. Keep text short; the frame sizes itself to the content.",
  "- Theme: put data-theme on <html> to match the topic: ocean (money, calm), violet (tech, creative), sunset (travel, food, fun), forest (health, nature), ember (energy, sport), rose (lifestyle, celebrations), mono (formal), accent (default). Light and dark mode are handled for you; never hard-code page backgrounds or text colors.",
  '- Classes: cw-card (+ cw-card-gradient | cw-card-tinted), cw-eyebrow, cw-title, cw-subtitle, cw-stack, cw-row, cw-grid (+ cw-grid-3 | cw-grid-4, cw-span-2), cw-hero (+ cw-hero-soft) with cw-hero-label / cw-hero-value / cw-hero-caption, cw-metrics (+ cw-metrics-colorful) with cw-metric / cw-metric-label / cw-metric-value, cw-delta (up | down), cw-field / cw-field-row / cw-value, cw-input-wrap + cw-affix, cw-btn (+ cw-btn-primary), cw-segmented and cw-tabs (buttons with aria-pressed / aria-selected), cw-tag, cw-progress (<div class="cw-progress"><span style="--value:40"></span></div>), cw-callout (tip | warning | success), cw-list, cw-icon-chip, cw-muted, cw-num, cw-divider. Tones for items: cw-tone-blue | teal | green | yellow | orange | red | pink | purple | gray.',
  "- Plain inputs, sliders, selects, buttons and tables are styled automatically; sliders show their fill.",
  '- Helpers on window.cowork: chart(target, {type: line | area | bar | donut, labels, series: [{name, values, muted?, tone?}], prefix?, unit?, stacked?, height?}) draws a themed SVG chart (call it again to redraw); icon(name) returns an SVG and <span data-icon="piggy-bank"></span> renders one (names: piggy-bank, wallet, coins, dollar, chart-line, trending-up, trending-down, target, calendar, clock, sun, leaf, plane, map-pin, home, utensils, heart, activity, users, rocket, zap, sparkles, star, check-circle, info, alert and more); format(n, {prefix, unit, decimals, compact}); tween(target, n, formatOptions) animates a number.',
  '- Use muted series for baselines ("kept as cash"), color with purpose, and keep every changeable value an input.',
  "Example:",
  RICH_FRAME_EXAMPLE,
].join("\n");

export const RICH_FRAME_DESIGN_STYLE_ID = "cowork-rich-frame-design-language";

export type RichFrameTheme = "light" | "dark";
export type RichFrameDesignOptions = {
  theme?: RichFrameTheme;
  hostBackground?: string;
};

function sanitizeCssColor(value: string | undefined, fallback: string): string {
  const trimmed = String(value || "").trim();
  if (!trimmed) return fallback;
  if (trimmed.toLowerCase() === "transparent") return "transparent";
  if (/^#[0-9a-f]{3,8}$/i.test(trimmed)) return trimmed;
  if (/^rgba?\([\d\s.,/%+-]+\)$/i.test(trimmed)) return trimmed;
  if (/^hsla?\([\d\s.,/%+-]+(?:deg|rad|turn)?[\d\s.,/%+-]*\)$/i.test(trimmed)) return trimmed;
  return fallback;
}

const RICH_FRAME_LIGHT_TOKENS = `
:root {
  --rf-bg: #ffffff;
  --rf-text: #111318;
  --rf-muted: #6b7280;
  --rf-border: rgba(15, 23, 42, 0.09);
  --rf-soft: #f5f6f8;
  --rf-track: #eceef2;
  --rf-shadow: 0 1px 2px rgba(15, 23, 42, 0.04), 0 12px 32px -18px rgba(15, 23, 42, 0.18);
  --rf-green-900: #166534;
  --rf-green-700: #16a34a;
  --rf-green-500: #22c55e;
  --rf-green-200: #bbf7d0;
  --rf-blue-300: #93c5fd;
  --rf-blue-500: #3b82f6;
  --rf-radius: 18px;
  color-scheme: light;
}
`.trim();

const RICH_FRAME_DARK_TOKENS = `
:root {
  --rf-bg: #1c1d21;
  --rf-text: #f3f4f6;
  --rf-muted: #9ca3af;
  --rf-border: rgba(255, 255, 255, 0.1);
  --rf-soft: rgba(255, 255, 255, 0.06);
  --rf-track: rgba(255, 255, 255, 0.1);
  --rf-shadow: none;
  --rf-green-900: #86efac;
  --rf-green-700: #4ade80;
  --rf-green-500: #22c55e;
  --rf-green-200: rgba(74, 222, 128, 0.22);
  --rf-blue-300: #93c5fd;
  --rf-blue-500: #60a5fa;
  --rf-radius: 18px;
  color-scheme: dark;
}
`.trim();

/*
 * Page frame plus the older rf-* classes, sized for chat width. New surfaces use the
 * cw-* kit (answer-surfaces/html-kit.ts), which is appended after this.
 */
const RICH_FRAME_BASE_CSS = `
* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  min-height: 100%;
  background: var(--rf-host-bg) !important;
}

body > :where(.stage, .frame-stage, .page, .screen, .viewport, .canvas, .shell, .app, .preview, .wrapper, .wrap, .container) {
  background: transparent !important;
}

body {
  color: var(--rf-text);
}

:where(.rf-card, .card, main, .frame) {
  width: 100%;
  background: var(--rf-bg);
  border: 1px solid var(--rf-border);
  border-radius: var(--rf-radius);
  box-shadow: var(--rf-shadow);
  padding: 20px 22px 22px;
  overflow: hidden;
}

:where(.rf-card, .card, main, .frame, .panel, .widget, .surface) {
  color: var(--rf-text);
}

:where(.rf-card, .card, main, .frame, .panel, .widget, .surface, .metric-card, .stat-card) {
  background-color: var(--rf-bg);
  border-color: var(--rf-border);
}

:where(.rf-header, .header) {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

:where(.rf-title) {
  margin: 0;
  font-size: 19px;
  line-height: 1.3;
  font-weight: 700;
}

:where(.rf-value, .value) {
  font-size: 32px;
  line-height: 1.1;
  font-weight: 720;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

:where(.rf-subtitle, .subtitle, .muted) {
  margin-top: 4px;
  color: var(--rf-muted);
  font-size: 14px;
}

:where(.rf-divider, hr) {
  width: 100%;
  height: 1px;
  margin: 16px 0;
  border: 0;
  background: var(--rf-border);
}

:where(.rf-list, .list) {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

:where(.rf-row) {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
}

:where(.rf-icon) {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--cw-accent-soft);
  color: var(--cw-accent-ink);
  flex: 0 0 auto;
}

:where(.rf-icon svg) {
  width: 55%;
  height: 55%;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

:where(.rf-label, .label) {
  min-width: 0;
  font-size: 15px;
  font-weight: 500;
}

:where(.rf-amount, .amount) {
  font-size: 15px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

:where(.rf-bar, .bar) {
  position: relative;
  width: 100%;
  height: 8px;
  margin-top: 8px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--rf-track);
}

:where(.rf-fill, .fill) {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--cw-gradient);
}

:where(.rf-segments, .segments) {
  display: flex;
  gap: 4px;
  width: 100%;
  height: 56px;
  overflow: hidden;
  border-radius: 12px;
}

:where(.rf-segment, .segment) {
  min-width: 7px;
  background: var(--cw-accent);
}

:where(.rf-chart, .chart) {
  width: 100%;
}

:where(.rf-pill, .pill) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px 12px;
  border-radius: 999px;
  background: var(--cw-accent-soft);
  color: var(--cw-accent-ink);
  font-size: 13px;
  font-weight: 600;
}

:where(.rf-positive, .positive) {
  color: var(--rf-green-700);
}

:where(.rf-blue, .blue) {
  color: var(--rf-blue-500);
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
    scroll-behavior: auto !important;
  }
}
`.trim();

const RICH_FRAME_DARK_COMPAT_CSS = `
:where(.rf-card, .card, main, .frame, .panel, .widget, .surface, .metric-card, .stat-card) {
  background: var(--rf-bg) !important;
  border-color: var(--rf-border) !important;
  color: var(--rf-text) !important;
}

:where(.rf-title, .rf-value, .rf-label, .rf-amount, h1, h2, h3, h4, .title, .value, .label, .amount) {
  color: var(--rf-text) !important;
}

:where(.rf-subtitle, .subtitle, .muted, small, .caption) {
  color: var(--rf-muted) !important;
}

:where(.chart, .rf-chart) {
  background-color: transparent !important;
}
`.trim();

/** The injected design CSS for a theme; frames swap it in place when the app theme changes. */
export function buildRichFrameDesignCss(theme: RichFrameTheme, hostBackground?: string): string {
  const safeHostBackground = sanitizeCssColor(hostBackground, "transparent");
  return [
    theme === "dark" ? RICH_FRAME_DARK_TOKENS : RICH_FRAME_LIGHT_TOKENS,
    `:root {\n  --rf-host-bg: ${safeHostBackground};\n}`,
    RICH_FRAME_BASE_CSS,
    HTML_KIT_CSS,
    theme === "dark" ? RICH_FRAME_DARK_COMPAT_CSS : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export const RICH_FRAME_DESIGN_CSS = buildRichFrameDesignCss("light");

function normalizeRichFrameTheme(theme?: RichFrameTheme): RichFrameTheme {
  return theme === "dark" ? "dark" : "light";
}

export function applyRichFrameDesignLanguage(
  htmlContent: string,
  options: RichFrameDesignOptions = {},
): string {
  const html = String(htmlContent || "");
  if (!html.trim()) return html;
  if (html.includes(`id="${RICH_FRAME_DESIGN_STYLE_ID}"`)) return html;
  if (/\bdata-cowork-rich-frame-design\s*=\s*["']off["']/i.test(html)) return html;

  const theme = normalizeRichFrameTheme(options.theme);
  const styleTag = `<style id="${RICH_FRAME_DESIGN_STYLE_ID}">\n${buildRichFrameDesignCss(theme, options.hostBackground)}\n</style>`;
  // Linear scans (html-tags.ts): this runs in main on up to a megabyte of model HTML.
  let htmlForInjection = html;
  const htmlTag = findOpeningTag(html, "html");
  if (htmlTag && !/\bstyle\s*=/i.test(htmlTag.text)) {
    const themedTag = `${htmlTag.text.slice(0, -1)} style="color-scheme: ${theme};">`;
    htmlForInjection = `${html.slice(0, htmlTag.start)}${themedTag}${html.slice(htmlTag.end)}`;
  }

  const headClose = asciiLowerCase(htmlForInjection).indexOf("</head>");
  if (headClose !== -1) {
    return `${htmlForInjection.slice(0, headClose)}${styleTag}\n${htmlForInjection.slice(headClose)}`;
  }
  return (
    insertAfterTag(htmlForInjection, "head", `\n${styleTag}`) ??
    insertAfterTag(htmlForInjection, "html", `\n<head>${styleTag}</head>`) ??
    `${styleTag}\n${htmlForInjection}`
  );
}
