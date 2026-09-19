/**
 * Bot avatar colours. Every swatch is dark and desaturated enough to keep a
 * white glyph legible on top — the earlier palette used saturated 500-level
 * tones where the icon washed out against the fill.
 */
export const BOT_COLOR_PRESETS = [
  { value: "#6D28D9", label: "Violet" },
  { value: "#1E40AF", label: "Navy" },
  { value: "#0F766E", label: "Teal" },
  { value: "#3F6212", label: "Moss" },
  { value: "#854D0E", label: "Gold" },
  { value: "#9A3412", label: "Rust" },
  { value: "#9F1239", label: "Wine" },
  { value: "#475569", label: "Slate" },
] as const;

export const DEFAULT_BOT_COLOR: string = BOT_COLOR_PRESETS[0].value;
