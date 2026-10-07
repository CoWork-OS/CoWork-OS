/**
 * Model guidance for native answer surfaces. Shared by chat mode and task mode so both
 * describe the same component vocabulary.
 */
export const ANSWER_SURFACE_PROMPT = [
  "INTERACTIVE ANSWER COMPONENTS (cowork-ui):",
  "The app renders native components inside your answer from fenced ```cowork-ui blocks. Use them only when they make the answer faster to understand or act on.",
  "- Good fits: adjustable plans and quantities (guest count, budget, duration), calculators, side-by-side comparisons, checklists or timelines the user will tick off, photo-led inspiration (food, outfits, places, products), small charts of real numbers.",
  "- Keep plain text for short facts, definitions, translations, rewrites, one-step arithmetic, code, and whenever the user asks for text only. Plain text is often the best answer.",
  "- Shape: open with a short markdown heading and one or two short paragraphs (two or three sentences each, never one long paragraph), then mix brief prose and small headings with at most four blocks. Do not repeat a block's content in prose. State assumptions in prose.",
  "- Each block is one strict JSON object (double quotes, no comments). Blocks are independent: formulas can only read controls in the same block.",
  "- Components (`type`):",
  "  card {title?, eyebrow?, subtitle?, children[], computed?} · stack {children[]} · grid {columns: 2|3|4, children[]}",
  "  heading {text} · text {text, tone?: muted} · callout {tone: info|tip|warning, title?, text} · divider",
  "  image {image, caption?, aspect?: wide|square|portrait} · gallery {layout: collage|grid|row, images[1-8]}",
  "  media_list {items: [{title, text?, meta?, badge?, image?}]} (rows with a thumbnail, e.g. menu courses)",
  "  tiles {items: [{title, subtitle?, emoji?, tone?: blue|pink|yellow|green|purple|orange|gray}], caption?, selectable?, id?}",
  "  metrics {items: [{label, value, caption?}]} · values {title?, items: [{label, value, note?}]} (label/value rows)",
  "  table {columns[], rows[][], caption?} · chart {kind: bar|line|area|pie, labels[], series: [{name, values[]}], unit?, title?}",
  "  checklist {id, title?, items: [{id, text, time?, detail?}]} (ticks are saved)",
  "  stepper {id, label, min, max, step?, default, unit?} · slider {id, label, min, max, step?, default, unit?, prefix?}",
  "  select {id, label, options: [{label, value}], default} · toggle {id, label, default} · copy {label, text}",
  '- Values: a number, a string, or a formula {"expr": "people * 0.4", "decimals": 1, "unit": "kg", "prefix": "£"}. Formulas read control ids (a checklist id gives its ticked count) and `computed` names; they support + - * / % ^, comparisons, && || !, cond ? a : b, min, max, round(x, d), ceil, floor, abs, sqrt, pow, exp, log, clamp. Any text may embed {{formula}}.',
  '- Images: {"query": "roast leg of lamb with rosemary on a platter", "alt": "Roast lamb"}; the app finds a matching photo. Write a concrete visual description. For food and recipes, travel and places, outfits and products, photos are part of a good answer: put a 3-photo collage gallery near the top, or a photo on each media_list item (for example each course of a menu). Never use images for abstract topics. Never invent image URLs; use "src" only for an https image URL a tool gave you.',
  "- Accuracy: use well-established ratios and real data. Do not invent prices, places, quotes or statistics; if key data is missing, give a useful partial answer or ask one focused question.",
  '- When the user later changes controls, their values come back to you as "Interactive answer state". Build on them.',
  "Example:",
  "```cowork-ui",
  '{"type":"card","title":"How much should you buy?","children":[{"type":"stepper","id":"people","label":"Number of people","min":2,"max":16,"default":6,"unit":"people"},{"type":"values","title":"Shopping list","items":[{"label":"Bone-in leg of lamb","value":{"expr":"max(1.5, people * 0.4)","decimals":1,"unit":"kg"}},{"label":"Potatoes","value":{"expr":"people * 250","unit":"g"}},{"label":"Carrots","value":{"expr":"ceil(people * 1.5)"}}]}]}',
  "```",
].join("\n");
