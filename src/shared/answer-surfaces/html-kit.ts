/**
 * The design kit for inline HTML answer surfaces: themes, component classes and element
 * defaults that make a model-written page look like the app's native answer components.
 * Injected with the rich-frame design tokens (light or dark) and swapped in place when
 * the app theme changes. Palettes mirror the native surface themes in answer-surface.css.
 */

/** Theme palettes, chosen with `data-theme` on <html> or any container. */
const PALETTES: Record<string, [string, string, string, string, string, string, string]> = {
  // [accent, gradient partner, chart slots 1-5]
  accent: ["#4f6bed", "#8b5cf6", "#4f6bed", "#f59e0b", "#ec4899", "#10b981", "#8b5cf6"],
  ocean: ["#0ea5e9", "#6366f1", "#0ea5e9", "#6366f1", "#14b8a6", "#f59e0b", "#ec4899"],
  violet: ["#8b5cf6", "#ec4899", "#8b5cf6", "#ec4899", "#06b6d4", "#f59e0b", "#10b981"],
  sunset: ["#f97316", "#ec4899", "#f97316", "#ec4899", "#8b5cf6", "#eab308", "#06b6d4"],
  forest: ["#10b981", "#0ea5e9", "#10b981", "#0ea5e9", "#84cc16", "#f59e0b", "#8b5cf6"],
  ember: ["#ef4444", "#f59e0b", "#ef4444", "#f59e0b", "#8b5cf6", "#0ea5e9", "#10b981"],
  rose: ["#f43f5e", "#a855f7", "#f43f5e", "#a855f7", "#f59e0b", "#06b6d4", "#10b981"],
  mono: ["#52525b", "#18181b", "#3f3f46", "#a1a1aa", "#71717a", "#d4d4d8", "#27272a"],
};

export const HTML_KIT_THEMES = Object.keys(PALETTES);

function paletteCss(name: string): string {
  const [accent, accent2, c1, c2, c3, c4, c5] = PALETTES[name];
  const selector = name === "accent" ? ':root, [data-theme="accent"]' : `[data-theme="${name}"]`;
  return `${selector} {
  --cw-accent: ${accent};
  --cw-accent-2: ${accent2};
  --cw-c1: ${c1};
  --cw-c2: ${c2};
  --cw-c3: ${c3};
  --cw-c4: ${c4};
  --cw-c5: ${c5};
}`;
}

const TONES: Record<string, string> = {
  blue: "#3b82f6",
  teal: "#14b8a6",
  green: "#22c55e",
  yellow: "#eab308",
  orange: "#f97316",
  red: "#ef4444",
  pink: "#ec4899",
  purple: "#8b5cf6",
  gray: "#8b8b95",
};

export const HTML_KIT_TONES = Object.keys(TONES);

const TOKENS_CSS = [
  ...Object.keys(PALETTES).map(paletteCss),
  `:root {
${Object.entries(TONES)
  .map(([name, color]) => `  --cw-tone-${name}: ${color};`)
  .join("\n")}
  --cw-radius: 18px;
  --cw-radius-inner: 12px;
  --cw-gap: 14px;
}`,
  // Derived colors are recomputed wherever a palette or tone changes.
  `:root, [data-theme] {
  --cw-accent-soft: color-mix(in srgb, var(--cw-accent) 14%, transparent);
  --cw-accent-ink: color-mix(in srgb, var(--cw-accent) 72%, var(--rf-text));
  --cw-gradient: linear-gradient(135deg, var(--cw-accent) 0%, var(--cw-accent-2) 100%);
  --cw-tone: var(--cw-accent);
}`,
  ...Object.keys(TONES).map(
    (name) => `.cw-tone-${name} {
  --cw-tone: var(--cw-tone-${name});
}`,
  ),
  `.cw-tone-accent {
  --cw-tone: var(--cw-accent);
}`,
  `[class*="cw-tone-"], .cw-tag, .cw-metric, .cw-progress, .cw-icon-chip, .cw-callout {
  --cw-tone-soft: color-mix(in srgb, var(--cw-tone) 15%, transparent);
  --cw-tone-ink: color-mix(in srgb, var(--cw-tone) 70%, var(--rf-text));
}`,
].join("\n\n");

const COMPONENTS_CSS = `
/* Element defaults: un-classed HTML still reads as part of the app. */
:where(body) {
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
}

:where(h1, h2, h3, h4) {
  margin: 0 0 6px;
  color: var(--rf-text);
  line-height: 1.25;
  letter-spacing: -0.01em;
}

:where(h1) { font-size: 22px; font-weight: 700; }
:where(h2) { font-size: 18px; font-weight: 680; }
:where(h3) { font-size: 16px; font-weight: 650; }
:where(h4) { font-size: 14px; font-weight: 650; }
:where(p) { margin: 0 0 8px; }
:where(a) { color: var(--cw-accent-ink); }

:where(input:not([type="range"]):not([type="checkbox"]):not([type="radio"]), select, textarea) {
  box-sizing: border-box;
  padding: 8px 12px;
  border: 1px solid var(--rf-border);
  border-radius: 10px;
  background: var(--rf-soft);
  color: var(--rf-text);
  font: inherit;
  font-variant-numeric: tabular-nums;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

:where(input, select, textarea):focus-visible {
  border-color: var(--cw-accent);
  box-shadow: 0 0 0 3px var(--cw-accent-soft);
}

:where(input[type="checkbox"], input[type="radio"]) {
  width: 17px;
  height: 17px;
  accent-color: var(--cw-accent);
}

:where(button) {
  font: inherit;
  cursor: pointer;
}

:where(input[type="range"]) {
  width: 100%;
  height: 6px;
  margin: 10px 0;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--cw-accent) 0%, var(--cw-accent-2) var(--fill, 50%), var(--rf-track) var(--fill, 50%));
  cursor: pointer;
  appearance: none;
}

:where(input[type="range"])::-webkit-slider-thumb {
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: 50%;
  background: #ffffff;
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--cw-accent) 35%, transparent), 0 2px 6px rgba(0, 0, 0, 0.25);
  appearance: none;
}

:where(table) {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}

:where(th, td) {
  padding: 9px 12px;
  border-bottom: 1px solid var(--rf-border);
  text-align: left;
}

:where(th) {
  color: var(--rf-muted);
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

/* Layout */
.cw-stack { display: flex; flex-direction: column; gap: var(--cw-gap); }
.cw-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.cw-grid { display: grid; gap: var(--cw-gap); grid-template-columns: repeat(2, minmax(0, 1fr)); }
.cw-grid-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.cw-grid-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.cw-span-2 { grid-column: span 2; }
.cw-span-3 { grid-column: span 3; }
@media (max-width: 560px) {
  .cw-grid, .cw-grid-3, .cw-grid-4 { grid-template-columns: minmax(0, 1fr); }
  .cw-span-2, .cw-span-3 { grid-column: auto; }
}

/* Card */
.cw-card {
  position: relative;
  overflow: hidden;
  padding: 20px 22px 22px;
  border: 1px solid var(--rf-border);
  border-radius: var(--cw-radius);
  background: var(--rf-bg);
  color: var(--rf-text);
  box-shadow: var(--rf-shadow);
}

.cw-card .cw-card { padding: 14px 16px; border-radius: var(--cw-radius-inner); background: var(--rf-soft); box-shadow: none; }
.cw-card-tinted { border-color: color-mix(in srgb, var(--cw-accent) 24%, transparent); background: color-mix(in srgb, var(--cw-accent) 6%, var(--rf-bg)); }
.cw-card-gradient::before {
  content: "";
  position: absolute;
  inset: 0 0 auto;
  height: 170px;
  background: var(--cw-gradient);
  opacity: 0.14;
  mask-image: linear-gradient(to bottom, #000, transparent);
  pointer-events: none;
}
.cw-card > * { position: relative; }

.cw-eyebrow { color: var(--cw-accent-ink); font-size: 11.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
.cw-title { margin: 2px 0 0; font-size: 19px; font-weight: 700; letter-spacing: -0.01em; line-height: 1.3; }
.cw-subtitle, .cw-muted { color: var(--rf-muted); }
.cw-subtitle { margin: 2px 0 0; font-size: 14px; }
.cw-num { font-variant-numeric: tabular-nums; }
.cw-divider { height: 1px; margin: 4px 0; border: 0; background: var(--rf-border); }

/* Hero: the headline result on the theme gradient. */
.cw-hero {
  position: relative;
  overflow: hidden;
  padding: 20px 22px;
  border-radius: var(--cw-radius);
  background: var(--cw-gradient);
  color: #ffffff;
  box-shadow: 0 18px 40px -24px color-mix(in srgb, var(--cw-accent) 80%, transparent);
  isolation: isolate;
}
.cw-hero::before {
  content: "";
  position: absolute;
  z-index: -1;
  top: -45%;
  right: -12%;
  width: 62%;
  aspect-ratio: 1;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(255, 255, 255, 0.32), transparent 65%);
}
.cw-hero-soft { background: linear-gradient(135deg, color-mix(in srgb, var(--cw-accent) 16%, var(--rf-bg)), color-mix(in srgb, var(--cw-accent-2) 12%, var(--rf-bg))); color: var(--rf-text); box-shadow: none; }
.cw-hero-label { font-size: 14px; font-weight: 600; opacity: 0.9; }
.cw-hero-value { margin: 4px 0 2px; font-size: 42px; font-weight: 750; letter-spacing: -0.03em; line-height: 1.05; font-variant-numeric: tabular-nums; }
.cw-hero-caption { font-size: 13.5px; opacity: 0.86; }

/* Metrics */
.cw-metrics { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
.cw-metric {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 14px 16px;
  border: 1px solid var(--rf-border);
  border-radius: var(--cw-radius-inner);
  background: var(--rf-soft);
}
.cw-metrics-colorful .cw-metric { border-color: color-mix(in srgb, var(--cw-tone) 22%, transparent); background: linear-gradient(150deg, color-mix(in srgb, var(--cw-tone) 20%, transparent), color-mix(in srgb, var(--cw-tone) 6%, transparent)); }
.cw-metrics-colorful .cw-metric-value { color: var(--cw-tone-ink); }
.cw-metric-label { color: var(--rf-muted); font-size: 13px; font-weight: 500; }
.cw-metric-value { font-size: 24px; font-weight: 720; letter-spacing: -0.02em; line-height: 1.2; font-variant-numeric: tabular-nums; }

.cw-delta { display: inline-flex; align-self: flex-start; gap: 3px; align-items: center; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 650; background: var(--rf-soft); color: var(--rf-muted); }
.cw-delta.up, .cw-delta.good { background: color-mix(in srgb, #22c55e 15%, transparent); color: color-mix(in srgb, #16a34a 78%, var(--rf-text)); }
.cw-delta.down, .cw-delta.bad { background: color-mix(in srgb, #ef4444 14%, transparent); color: color-mix(in srgb, #dc2626 78%, var(--rf-text)); }
.cw-hero .cw-delta { background: rgba(255, 255, 255, 0.2); color: #ffffff; }

/* Icons */
.cw-icon, [data-icon] > svg { width: 1.1em; height: 1.1em; flex: 0 0 auto; vertical-align: -0.18em; }
.cw-icon-chip { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 10px; background: var(--cw-tone-soft); color: var(--cw-tone-ink); }
.cw-hero .cw-icon-chip { background: rgba(255, 255, 255, 0.2); color: #ffffff; }

/* Controls */
.cw-field { display: flex; flex-direction: column; gap: 6px; }
.cw-field > label, .cw-label { color: var(--rf-muted); font-size: 13.5px; }
.cw-field-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.cw-value { color: var(--cw-accent-ink); font-weight: 650; font-variant-numeric: tabular-nums; }
.cw-input-wrap { display: inline-flex; align-items: baseline; gap: 4px; padding: 7px 12px; border: 1px solid var(--rf-border); border-radius: 12px; background: var(--rf-soft); }
.cw-input-wrap:focus-within { border-color: var(--cw-accent); box-shadow: 0 0 0 3px var(--cw-accent-soft); }
.cw-input-wrap input { width: 7em; padding: 0; border: 0; background: transparent; font-weight: 650; text-align: right; box-shadow: none; }
.cw-affix { color: var(--rf-muted); font-size: 0.92em; }

.cw-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 16px; border: 1px solid var(--rf-border); border-radius: 999px; background: var(--rf-bg); color: var(--rf-text); font-weight: 600; transition: transform 0.12s ease, background 0.15s ease; }
.cw-btn:hover { background: var(--rf-soft); }
.cw-btn:active { transform: scale(0.97); }
.cw-btn-primary { border-color: transparent; background: var(--cw-gradient); color: #ffffff; box-shadow: 0 6px 16px -8px var(--cw-accent); }
.cw-btn-primary:hover { background: var(--cw-gradient); filter: brightness(1.05); }

.cw-segmented, .cw-tabs { display: inline-flex; flex-wrap: wrap; gap: 4px; padding: 4px; border-radius: 12px; background: var(--rf-soft); }
.cw-segmented > button, .cw-tabs > button { padding: 6px 14px; border: 0; border-radius: 9px; background: transparent; color: var(--rf-muted); font-weight: 550; transition: background 0.15s ease, color 0.15s ease; }
.cw-segmented > button[aria-pressed="true"], .cw-segmented > button.active { background: var(--cw-accent); color: #ffffff; box-shadow: 0 4px 12px -6px var(--cw-accent); }
.cw-tabs { display: flex; }
.cw-tabs > button { flex: 1 0 auto; }
.cw-tabs > button[aria-selected="true"], .cw-tabs > button.active { background: var(--rf-bg); color: var(--rf-text); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08), 0 0 0 1px var(--rf-border); }

/* Tags, progress, callouts, lists */
.cw-tags { display: flex; flex-wrap: wrap; gap: 8px; }
.cw-tag { display: inline-flex; align-items: center; gap: 6px; padding: 4px 11px; border-radius: 999px; background: var(--cw-tone-soft); color: var(--cw-tone-ink); font-size: 13px; font-weight: 600; }

.cw-progress { position: relative; height: 8px; overflow: hidden; border-radius: 999px; background: var(--rf-track); }
.cw-progress > span { position: absolute; inset: 0 auto 0 0; width: calc(var(--value, 0) * 1%); border-radius: inherit; background: linear-gradient(90deg, var(--cw-tone), color-mix(in srgb, var(--cw-tone) 62%, #ffffff)); transition: width 0.45s cubic-bezier(0.2, 0.8, 0.2, 1); }

.cw-callout { display: flex; gap: 10px; padding: 12px 14px; border: 1px solid color-mix(in srgb, var(--cw-tone) 24%, transparent); border-radius: var(--cw-radius-inner); background: color-mix(in srgb, var(--cw-tone) 10%, transparent); --cw-tone: var(--cw-tone-blue); }
.cw-callout.tip { --cw-tone: var(--cw-tone-purple); }
.cw-callout.warning { --cw-tone: var(--cw-tone-yellow); }
.cw-callout.success { --cw-tone: var(--cw-tone-green); }

.cw-list { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.cw-list > li { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 0; border-bottom: 1px solid var(--rf-border); }
.cw-list > li:last-child { border-bottom: 0; }

/* Charts drawn by cowork.chart() */
.cw-chart { position: relative; width: 100%; }
.cw-chart svg { display: block; width: 100%; overflow: visible; }
.cw-chart-grid { stroke: var(--rf-border); stroke-dasharray: 3 5; }
.cw-chart-axis { fill: var(--rf-muted); font-size: 11.5px; font-variant-numeric: tabular-nums; }
.cw-chart-end { font-size: 12px; font-weight: 650; font-variant-numeric: tabular-nums; }
.cw-chart-guide { stroke: var(--rf-border); stroke-dasharray: 4 4; }
.cw-chart-legend { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 0 0 8px; color: var(--rf-muted); font-size: 13px; }
.cw-chart-legend > span { display: inline-flex; align-items: center; gap: 7px; }
.cw-chart-key { display: inline-block; width: 14px; height: 3px; border-radius: 2px; background: currentColor; }
.cw-chart-key.dashed { height: 0; border-top: 2px dashed currentColor; background: none; }
.cw-chart-tip { position: absolute; z-index: 2; min-width: 120px; padding: 8px 10px; border: 1px solid var(--rf-border); border-radius: 10px; background: var(--rf-bg); box-shadow: 0 10px 28px -12px rgba(0, 0, 0, 0.35); font-size: 12.5px; pointer-events: none; }
.cw-chart-tip b { display: block; margin-bottom: 4px; }
.cw-chart-tip div { display: flex; justify-content: space-between; gap: 12px; }
.cw-chart-donut { display: flex; align-items: center; gap: 22px; }
.cw-chart-donut svg { flex: 0 0 auto; width: min(46%, 220px); }
.cw-chart-donut ul { display: flex; flex: 1 1 auto; flex-direction: column; gap: 8px; min-width: 0; margin: 0; padding: 0; list-style: none; font-size: 13.5px; }
.cw-chart-donut li { display: flex; align-items: center; gap: 9px; }
.cw-chart-donut li > span:nth-child(2) { flex: 1 1 auto; color: var(--rf-muted); }
.cw-chart-donut li > b { font-variant-numeric: tabular-nums; }
.cw-chart-swatch { flex: 0 0 auto; width: 9px; height: 9px; border-radius: 3px; }
.cw-chart-center { fill: var(--rf-text); font-size: 20px; font-weight: 720; }
.cw-chart-center-label { fill: var(--rf-muted); font-size: 11.5px; }

/* Entrance: content rises in once. */
@keyframes cw-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.cw-card > *, .cw-hero, .cw-metric { animation: cw-rise 0.45s cubic-bezier(0.2, 0.8, 0.2, 1) backwards; }
.cw-card > :nth-child(2) { animation-delay: 0.05s; }
.cw-card > :nth-child(3) { animation-delay: 0.1s; }
.cw-card > :nth-child(n + 4) { animation-delay: 0.15s; }
`.trim();

export const HTML_KIT_CSS = `${TOKENS_CSS}\n\n${COMPONENTS_CSS}`;
