export const RICH_FRAME_DESIGN_LANGUAGE_PROMPT = [
  "Default rich-frame design language:",
  "- Use this design language for compact inline answer surfaces unless the user explicitly requests different colors, icons, shapes, or a UI library.",
  "- Overall shape: theme-aware card, subtle border, 28-32px rounded corners, generous internal padding, no heavy shadows.",
  "- The HTML document body must not paint its own stage; render one generated card/surface directly, letting the host provide the surrounding background.",
  "- Typography: system sans-serif, theme-aware primary text, soft gray secondary text, large numeric values, compact labels, no negative letter spacing.",
  "- Palette: deep green #1f5f2b, medium green #3f944a, soft green #74ca87, pale green #a8dfb9, light blue #a9cff7, vivid blue #5aa2f2, neutral grays #f6f6f6/#e8e8e8/#8b8b8b.",
  "- Icons: simple 2px stroke inline SVGs inside soft gray circular wells; do not use external icon libraries unless requested.",
  "- Charts: calm, readable, minimal axes/gridlines; rounded bars/segments; use green as the main positive/primary signal and blue as secondary/accent.",
  "- Dark mode: avoid hard-coded white page backgrounds. Prefer CSS variables or transparent body backgrounds so the host can provide dark frame tokens.",
  "- Motion: static by default. Use subtle animation only for progress/sync/loading states or when motion explains the state.",
  "- Recommended classes: rf-card, rf-header, rf-title, rf-value, rf-subtitle, rf-divider, rf-row, rf-icon, rf-amount, rf-bar, rf-fill, rf-segment, rf-pill, rf-chart.",
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
  --rf-text: #101114;
  --rf-muted: #8b8b8b;
  --rf-border: #e8e8e8;
  --rf-soft: #f6f6f6;
  --rf-track: #eeeeee;
  --rf-green-900: #1f5f2b;
  --rf-green-700: #3f944a;
  --rf-green-500: #74ca87;
  --rf-green-200: #a8dfb9;
  --rf-blue-300: #a9cff7;
  --rf-blue-500: #5aa2f2;
  --rf-radius: 30px;
  color-scheme: light;
}
`.trim();

const RICH_FRAME_DARK_TOKENS = `
:root {
  --rf-bg: #17191d;
  --rf-text: #f4f6f8;
  --rf-muted: #a5adb8;
  --rf-border: rgba(255, 255, 255, 0.14);
  --rf-soft: rgba(255, 255, 255, 0.07);
  --rf-track: rgba(255, 255, 255, 0.11);
  --rf-green-900: #8fe3a4;
  --rf-green-700: #72d184;
  --rf-green-500: #54b86a;
  --rf-green-200: rgba(114, 209, 132, 0.24);
  --rf-blue-300: #8cc7ff;
  --rf-blue-500: #5aa2f2;
  --rf-radius: 30px;
  color-scheme: dark;
}
`.trim();

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
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif;
  color: var(--rf-text);
  letter-spacing: 0;
}

:where(.rf-card, .card, main, .frame) {
  width: 100%;
  min-height: 100%;
  background: var(--rf-bg);
  border: 1px solid var(--rf-border);
  border-radius: var(--rf-radius);
  padding: clamp(24px, 5vw, 52px);
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
  gap: 20px;
}

:where(.rf-title, h1) {
  margin: 0;
  color: var(--rf-text);
  font-size: clamp(34px, 7vw, 62px);
  line-height: 1.08;
  font-weight: 650;
  letter-spacing: 0;
}

:where(.rf-value, .value) {
  color: var(--rf-text);
  font-size: clamp(34px, 6vw, 58px);
  line-height: 1;
  font-weight: 500;
  white-space: nowrap;
}

:where(.rf-subtitle, .subtitle, .muted) {
  margin-top: 10px;
  color: var(--rf-muted);
  font-size: clamp(22px, 4vw, 36px);
  line-height: 1.18;
  font-weight: 400;
}

:where(.rf-divider, hr) {
  width: 100%;
  height: 1px;
  margin: clamp(24px, 5vw, 44px) 0;
  border: 0;
  background: var(--rf-border);
}

:where(.rf-list, .list) {
  display: flex;
  flex-direction: column;
  gap: clamp(22px, 4vw, 42px);
}

:where(.rf-row, .row) {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: clamp(16px, 3vw, 28px);
}

:where(.rf-icon, .icon) {
  width: clamp(48px, 9vw, 76px);
  height: clamp(48px, 9vw, 76px);
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--rf-soft);
  color: var(--rf-text);
  flex: 0 0 auto;
}

:where(.rf-icon svg, .icon svg) {
  width: 54%;
  height: 54%;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

:where(.rf-label, .label) {
  min-width: 0;
  color: var(--rf-text);
  font-size: clamp(24px, 4.5vw, 42px);
  line-height: 1.12;
  font-weight: 450;
}

:where(.rf-amount, .amount) {
  color: var(--rf-text);
  font-size: clamp(24px, 4.5vw, 42px);
  line-height: 1;
  font-weight: 420;
  white-space: nowrap;
}

:where(.rf-bar, .bar) {
  position: relative;
  width: 100%;
  height: clamp(7px, 1.1vw, 10px);
  margin-top: 10px;
  border-radius: 999px;
  overflow: hidden;
  background: repeating-linear-gradient(
    -45deg,
    var(--rf-track) 0,
    var(--rf-track) 4px,
    #f7f7f7 4px,
    #f7f7f7 8px
  );
}

:where(.rf-fill, .fill) {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--rf-green-700);
}

:where(.rf-segments, .segments) {
  display: flex;
  gap: 4px;
  width: 100%;
  height: clamp(64px, 11vw, 100px);
  overflow: hidden;
  border-radius: 12px;
}

:where(.rf-segment, .segment) {
  min-width: 7px;
  background: var(--rf-green-700);
}

:where(.rf-chart, .chart) {
  width: 100%;
  min-height: clamp(220px, 38vw, 420px);
}

:where(.rf-pill, .pill) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 42px;
  padding: 0 24px;
  border-radius: 999px;
  background: var(--rf-soft);
  color: var(--rf-text);
  font-size: clamp(18px, 3vw, 28px);
  font-weight: 500;
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

:where(.rf-icon, .icon, .rf-pill, .pill) {
  background: var(--rf-soft) !important;
  border-color: var(--rf-border) !important;
}

:where(.rf-bar, .bar) {
  background: var(--rf-track) !important;
}

:where(.chart, .rf-chart) {
  background-color: transparent !important;
}
`.trim();

function buildRichFrameDesignCss(theme: RichFrameTheme, hostBackground?: string): string {
  const safeHostBackground = sanitizeCssColor(hostBackground, "transparent");
  return [
    theme === "dark" ? RICH_FRAME_DARK_TOKENS : RICH_FRAME_LIGHT_TOKENS,
    `:root {\n  --rf-host-bg: ${safeHostBackground};\n}`,
    RICH_FRAME_BASE_CSS,
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
  const themedHtml = html.replace(/<html\b([^>]*)>/i, (match, attrs: string) => {
    if (/\bstyle\s*=/i.test(attrs)) return match;
    return `<html${attrs} style="color-scheme: ${theme};">`;
  });
  const htmlForInjection = themedHtml === html ? html : themedHtml;

  if (/<\/head>/i.test(htmlForInjection)) {
    return htmlForInjection.replace(/<\/head>/i, `${styleTag}\n</head>`);
  }
  if (/<head\b[^>]*>/i.test(htmlForInjection)) {
    return htmlForInjection.replace(/<head\b[^>]*>/i, (match) => `${match}\n${styleTag}`);
  }
  if (/<html\b[^>]*>/i.test(htmlForInjection)) {
    return htmlForInjection.replace(
      /<html\b[^>]*>/i,
      (match) => `${match}\n<head>${styleTag}</head>`,
    );
  }
  return `${styleTag}\n${htmlForInjection}`;
}
