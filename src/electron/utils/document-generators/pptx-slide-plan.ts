/**
 * Slide planning shared by both PPTX renderers.
 *
 * generatePPTX renders through the bundled artifact-tool runtime when it is
 * installed and through pptxgenjs otherwise. Both renderers draw this plan, so
 * the layout of every slide, and the content each slide carries, is decided
 * once and identically for both.
 *
 * The plan never drops or invents content:
 * - an explicit slideType/layout is kept unless honoring it would need
 *   invented data (a chart without values, a KPI slide without numbers);
 * - untyped slides get a layout from their structure, never from a rotation;
 * - each slide receives only what its layout can show, and the rest continues
 *   on "(cont.)" slides;
 * - every adaptation is reported as a warning for the tool result.
 */

export type PresentationSlideType =
  | "cover"
  | "content"
  | "image"
  | "quote"
  | "timeline"
  | "comparison"
  | "process"
  | "chart"
  | "table"
  | "section"
  | "product"
  | "metric"
  | "closing"
  | "blank";

const SLIDE_TYPES = new Set<string>([
  "cover",
  "content",
  "image",
  "quote",
  "timeline",
  "comparison",
  "process",
  "chart",
  "table",
  "section",
  "product",
  "metric",
  "closing",
  "blank",
]);

/** Items one slide of each layout shows; both renderers are laid out for these. */
export const SLIDE_CAPACITY = {
  contentList: 5,
  contentColumns: 8,
  image: 3,
  closing: 4,
  process: 5,
  timeline: 5,
  comparisonColumn: 5,
  metric: 4,
  tableRows: 6,
  chartBars: 12,
  chartCategories: 8,
  chartSeries: 4,
} as const;

/** Layouts that show a lone `content` paragraph as their subtitle line. */
const CONTENT_AS_SUBTITLE = new Set<PresentationSlideType>([
  "cover",
  "section",
  "image",
  "product",
  "closing",
]);

/** Requested slide, as received from the tool call (shape is not trusted). */
export interface PresentationSlideInput {
  title?: unknown;
  subtitle?: unknown;
  bullets?: unknown;
  content?: unknown;
  notes?: unknown;
  intent?: unknown;
  visualBrief?: unknown;
  slideType?: unknown;
  layout?: unknown;
  layoutHint?: unknown;
  quote?: unknown;
  attribution?: unknown;
  data?: unknown;
  image?: unknown;
}

export interface PlannedSlideImage {
  id?: string;
  path?: string;
  url?: string;
  width?: number;
  height?: number;
  alt?: string;
}

export interface PlannedMetric {
  value: string;
  label: string;
  detail: string;
}

export interface PlannedMilestone {
  label: string;
  detail: string;
}

export interface PlannedColumn {
  title: string;
  items: string[];
}

export interface PlannedTable {
  headers: string[];
  rows: string[][];
}

export interface PlannedChartSeries {
  name: string;
  values: Array<number | null>;
}

export interface PlannedChart {
  categories: string[];
  series: PlannedChartSeries[];
  /** Largest absolute value across every part of the chart, for a shared scale. */
  max: number;
}

export interface PlannedSlide {
  type: PresentationSlideType;
  /** Visual variant; layouts alternate between equivalent designs with it. */
  motif: number;
  /** 1-based number of the requested slide this slide renders. */
  source: number;
  /** Numbering offset for process steps continued from an earlier slide. */
  offset: number;
  title: string;
  subtitle: string;
  bullets: string[];
  quote: string;
  attribution: string;
  metrics: PlannedMetric[];
  milestones: PlannedMilestone[];
  columns: PlannedColumn[];
  table?: PlannedTable;
  chart?: PlannedChart;
  image?: PlannedSlideImage;
  notes: string;
  intent: string;
  visualBrief: string;
}

export interface PresentationPlan {
  slides: PlannedSlide[];
  requestedSlideCount: number;
  warnings: string[];
}

interface PlanDeck {
  title?: string;
  subject?: string;
  assets?: ReadonlyArray<{ id?: unknown; path?: unknown; url?: unknown }>;
}

interface RawSeries {
  name: string;
  values: Array<number | null>;
  raw: string[];
}

interface SourcePool {
  number: number;
  title: string;
  subtitle: string;
  content: string;
  bullets: string[];
  quote: string;
  attribution: string;
  dataItems: PlannedMetric[];
  headers: string[];
  rows: string[][];
  categories: string[];
  series: RawSeries[];
  image?: PlannedSlideImage;
  notes: string;
  intent: string;
  visualBrief: string;
  hint: string;
}

export function cleanSlideText(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text =
    typeof value === "string"
      ? value
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  return text.replace(/\s+/g, " ").trim();
}

export function formatChartValue(value: number | null): string {
  return value === null ? "–" : String(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(cleanSlideText).filter(Boolean) : [];
}

function optionalText(value: unknown): string | undefined {
  const text = cleanSlideText(value);
  return text || undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function chartValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^\s*[+-]?\d+(?:\.\d+)?\s*$/.test(value)) return Number(value);
  return null;
}

/** Splits items into the fewest parts of at most `capacity`, keeping parts even. */
function chunkEvenly<T>(items: readonly T[], capacity: number): T[][] {
  if (items.length <= capacity) return [items.slice()];
  return splitInto(items, Math.ceil(items.length / capacity));
}

function splitInto<T>(items: readonly T[], parts: number): T[][] {
  const size = Math.max(1, Math.ceil(items.length / parts));
  return Array.from({ length: parts }, (_, part) => items.slice(part * size, (part + 1) * size));
}

function readRows(
  data: Record<string, unknown>,
  headers: string[],
): { headers: string[]; rows: string[][] } {
  if (!Array.isArray(data.rows)) return { headers, rows: [] };
  let resolvedHeaders = headers;
  const rows = data.rows.map((row): string[] => {
    if (Array.isArray(row)) return row.map(cleanSlideText);
    const record = asRecord(row);
    const keys = Object.keys(record);
    if (keys.length === 0) return [cleanSlideText(row)];
    // Row objects: line values up with the headers, or adopt the keys as headers.
    if (resolvedHeaders.length === 0) resolvedHeaders = keys;
    const known = resolvedHeaders.every((header) => header in record);
    return known
      ? resolvedHeaders.map((header) => cleanSlideText(record[header]))
      : keys.map((key) => cleanSlideText(record[key]));
  });
  return { headers: resolvedHeaders, rows: rows.filter((row) => row.some(Boolean)) };
}

function readImage(value: unknown): PlannedSlideImage | undefined {
  const record = asRecord(value);
  const image: PlannedSlideImage = {
    id: optionalText(record.id),
    path: typeof record.path === "string" && record.path.trim() ? record.path : undefined,
    url: optionalText(record.url),
    width: optionalNumber(record.width),
    height: optionalNumber(record.height),
    alt: optionalText(record.alt),
  };
  return image.id || image.path || image.url ? image : undefined;
}

function readPool(input: unknown, number: number): SourcePool {
  const slide: PresentationSlideInput =
    typeof input === "string" ? { title: input } : (asRecord(input) as PresentationSlideInput);
  const data = asRecord(slide.data);
  const { headers, rows } = readRows(data, textList(data.headers));
  const series = (Array.isArray(data.series) ? data.series : []).map((entry): RawSeries => {
    const record = asRecord(entry);
    const values = Array.isArray(record.values) ? record.values : [];
    return {
      name: cleanSlideText(record.name),
      values: values.map(chartValue),
      raw: values.map(cleanSlideText),
    };
  });
  const dataItems = (Array.isArray(data.items) ? data.items : [])
    .map((item) => {
      const record: Record<string, unknown> =
        typeof item === "object" ? asRecord(item) : { label: item };
      return {
        value: cleanSlideText(record.value),
        label: cleanSlideText(record.label),
        detail: cleanSlideText(record.detail),
      };
    })
    .filter((item) => item.value || item.label || item.detail);
  const title = cleanSlideText(slide.title);
  const intent = cleanSlideText(slide.intent);
  const visualBrief = cleanSlideText(slide.visualBrief);

  return {
    number,
    title,
    subtitle: cleanSlideText(slide.subtitle),
    content: cleanSlideText(slide.content),
    bullets: textList(slide.bullets),
    quote: cleanSlideText(slide.quote),
    attribution: cleanSlideText(slide.attribution),
    dataItems,
    headers,
    rows,
    categories: Array.isArray(data.categories) ? data.categories.map(cleanSlideText) : [],
    series,
    image: readImage(slide.image),
    notes: typeof slide.notes === "string" ? slide.notes.trim() : "",
    intent,
    visualBrief,
    hint: `${title} ${cleanSlideText(slide.layoutHint) || intent || visualBrief}`.toLowerCase(),
  };
}

function slideLabel(pool: SourcePool): string {
  return pool.title ? `Slide ${pool.number} "${pool.title}"` : `Slide ${pool.number}`;
}

function continuationTitle(title: string): string {
  return title ? `${title} (cont.)` : "(cont.)";
}

function hasNumericSeries(pool: SourcePool): boolean {
  return pool.series.some((series) => series.values.some((value) => value !== null));
}

const LEADING_NUMBER =
  /^([+\-−]?[$€£¥]?\d[\d,]*(?:\.\d+)?(?:\s?%|[KMBkmb]n?|bn|x|pp|bps)?)(?![\w.])\s*(?:[-–—:|]\s*)?(.*)$/;
const TRAILING_NUMBER =
  /^(.+?)\s*[:=–—-]\s*([+\-−]?[$€£¥]?\d[\d,]*(?:\.\d+)?(?:\s?%|[KMBkmb]n?|bn|x|pp|bps)?)$/;

/** Reads "42% churn reduction" or "Revenue: $1.2M"; anything else stays plain text. */
function parseMetricText(text: string): PlannedMetric {
  const leading = text.match(LEADING_NUMBER);
  if (leading) return { value: leading[1].trim(), label: leading[2].trim(), detail: "" };
  const trailing = text.match(TRAILING_NUMBER);
  if (trailing) return { value: trailing[2].trim(), label: trailing[1].trim(), detail: "" };
  return { value: "", label: text, detail: "" };
}

function formatDataItem(item: PlannedMetric): string {
  const head = item.label && item.value ? `${item.label}: ${item.value}` : item.label || item.value;
  return head && item.detail ? `${head} — ${item.detail}` : head || item.detail;
}

function explicitSlideType(input: unknown): PresentationSlideType | undefined {
  const slide = asRecord(input);
  const candidates = [cleanSlideText(slide.slideType), cleanSlideText(slide.layout)];
  for (const [index, raw] of candidates.entries()) {
    const value = raw.toLowerCase();
    if (!value) continue;
    // `layout: "content"` is the backward-compatible default, not a layout choice.
    if (index === 1 && value === "content") continue;
    if (value === "title") return "cover";
    if (SLIDE_TYPES.has(value)) return value as PresentationSlideType;
  }
  return undefined;
}

function inferSlideType(pool: SourcePool, index: number, count: number): PresentationSlideType {
  const hint = pool.hint;
  if (index === 0) return "cover";
  if (pool.rows.length > 0) return "table";
  if (hasNumericSeries(pool)) return "chart";
  if (pool.image) return /product|screen|demo|app|mock|shot/.test(hint) ? "product" : "image";
  if (pool.quote) return "quote";
  if (
    count > 2 &&
    index === count - 1 &&
    /next|close|thank|question|appendix|wrap|landing/.test(hint) &&
    pool.bullets.length + (pool.content && pool.subtitle ? 1 : 0) <= SLIDE_CAPACITY.closing
  ) {
    return "closing";
  }
  if (/timeline|roadmap|milestone|schedule|phase/.test(hint)) return "timeline";
  if (/process|workflow|steps|how it works|flow/.test(hint)) return "process";
  // Structured KPI items are metrics; plain text bullets never become KPI numbers.
  if (pool.dataItems.some((item) => item.value)) return "metric";
  if (/compare|versus| vs |tradeoff|option/.test(hint) && pool.headers.length >= 2) {
    return "comparison";
  }
  return "content";
}

function resolveSlideType(
  input: unknown,
  pool: SourcePool,
  index: number,
  count: number,
  warnings: string[],
): PresentationSlideType {
  const explicit = explicitSlideType(input);
  if (!explicit) return inferSlideType(pool, index, count);

  if (explicit === "chart" && !hasNumericSeries(pool)) {
    const fallback = pool.rows.length > 0 ? "table" : "content";
    warnings.push(
      `${slideLabel(pool)}: the chart has no numeric series values, so no chart was drawn ` +
        `(values are never invented); its data is shown as ${fallback === "table" ? "a table" : "a list"} instead. ` +
        "Provide data.series[].values to draw the chart.",
    );
    return fallback;
  }

  if (explicit === "metric") {
    const texts = [pool.content, ...pool.bullets].filter(Boolean);
    const hasMetricValues =
      pool.dataItems.some((item) => item.value) ||
      texts.some((text) => parseMetricText(text).value !== "");
    if (!hasMetricValues) {
      warnings.push(
        `${slideLabel(pool)}: the metric slide has no numeric values, so its text is shown as a list ` +
          "instead of as KPI numbers. Provide data.items with values to draw KPIs.",
      );
      return "content";
    }
  }

  return explicit;
}

function buildChart(pool: SourcePool): { chart: PlannedChart; issues: string[] } {
  const length = Math.max(
    pool.categories.length,
    ...pool.series.map((series) => series.values.length),
  );
  const categories = Array.from({ length }, (_, index) => pool.categories[index] ?? "");
  const series = pool.series.map((entry) => ({
    name: entry.name,
    values: Array.from({ length }, (_, index) => entry.values[index] ?? null),
  }));
  const values = series
    .flatMap((entry) => entry.values)
    .filter((value): value is number => value !== null);
  const max = Math.max(...values.map((value) => Math.abs(value)), 0) || 1;

  const issues: string[] = [];
  const unlabeled = length - pool.categories.filter(Boolean).length;
  if (unlabeled > 0) issues.push(`${unlabeled} data point(s) have no category label`);
  const missing = series.reduce(
    (total, entry) => total + entry.values.filter((value) => value === null).length,
    0,
  );
  if (missing > 0) {
    issues.push(
      `${missing} value(s) are missing or not numeric and are shown as "–" (not invented)`,
    );
  }
  return { chart: { categories, series, max }, issues };
}

function chartAsTable(chart: PlannedChart): PlannedTable {
  return {
    headers: ["", ...chart.series.map((series, index) => series.name || `Series ${index + 1}`)],
    rows: chart.categories.map((category, index) => [
      category,
      ...chart.series.map((series) => formatChartValue(series.values[index])),
    ]),
  };
}

function seriesAsText(series: RawSeries): string {
  const values = series.raw.filter(Boolean).join(", ");
  return series.name ? `${series.name}: ${values}` : values;
}

function plannedSlide(
  pool: SourcePool,
  type: PresentationSlideType,
  fields: Partial<PlannedSlide> = {},
): PlannedSlide {
  return {
    type,
    motif: 0,
    source: pool.number,
    offset: 0,
    title: pool.title,
    subtitle: "",
    bullets: [],
    quote: "",
    attribution: "",
    metrics: [],
    milestones: [],
    columns: [],
    notes: "",
    intent: pool.intent,
    visualBrief: pool.visualBrief,
    ...fields,
  };
}

function continuation(
  pool: SourcePool,
  type: PresentationSlideType,
  fields: Partial<PlannedSlide>,
): PlannedSlide {
  return plannedSlide(pool, type, { title: continuationTitle(pool.title), ...fields });
}

function contentPages(items: string[]): string[][] {
  return items.length <= SLIDE_CAPACITY.contentList
    ? [items]
    : chunkEvenly(items, SLIDE_CAPACITY.contentColumns);
}

function tablePages(table: PlannedTable): PlannedTable[] {
  return chunkEvenly(table.rows, SLIDE_CAPACITY.tableRows).map((rows) => ({
    headers: table.headers,
    rows,
  }));
}

function chartPages(chart: PlannedChart): PlannedChart[] {
  const perSlide = Math.max(
    1,
    Math.min(
      SLIDE_CAPACITY.chartCategories,
      Math.floor(SLIDE_CAPACITY.chartBars / Math.max(chart.series.length, 1)),
    ),
  );
  const indexes = chunkEvenly(
    chart.categories.map((_, index) => index),
    perSlide,
  );
  return indexes.map((page) => ({
    categories: page.map((index) => chart.categories[index]),
    series: chart.series.map((series) => ({
      name: series.name,
      values: page.map((index) => series.values[index]),
    })),
    max: chart.max,
  }));
}

function planSlide(
  pool: SourcePool,
  type: PresentationSlideType,
  warnings: string[],
): PlannedSlide[] {
  const contentIsSubtitle =
    CONTENT_AS_SUBTITLE.has(type) && !pool.subtitle && Boolean(pool.content);
  const subtitle = contentIsSubtitle ? pool.content : pool.subtitle;
  const texts =
    contentIsSubtitle || !pool.content ? [...pool.bullets] : [pool.content, ...pool.bullets];
  const numericChart = hasNumericSeries(pool) ? buildChart(pool) : undefined;
  const table = pool.rows.length > 0 ? { headers: pool.headers, rows: pool.rows } : undefined;

  // Content that list layouts show as text when the layout has no dedicated place for it.
  const dataItemTexts = pool.dataItems.map(formatDataItem);
  const quoteTexts = pool.quote
    ? [pool.attribution ? `“${pool.quote}” — ${pool.attribution}` : `“${pool.quote}”`]
    : pool.attribution
      ? [`— ${pool.attribution}`]
      : [];
  const chartTexts = numericChart
    ? []
    : [...pool.categories.filter(Boolean), ...pool.series.map(seriesAsText).filter(Boolean)];
  const headerTexts = table || pool.headers.length === 0 ? [] : [pool.headers.join(" | ")];
  const extras = [...quoteTexts, ...chartTexts, ...headerTexts];

  const first = plannedSlide(pool, type, { subtitle, notes: pool.notes });
  const parts: PlannedSlide[] = [first];
  let leftover: string[] = [];
  let leftoverTable: PlannedTable | undefined = table;
  let leftoverChart = numericChart;
  let leftoverImage = pool.image;

  switch (type) {
    case "cover":
    case "section":
      leftover = [...texts, ...dataItemTexts, ...extras];
      break;

    case "blank":
      first.subtitle = "";
      leftover = [...(subtitle ? [subtitle] : []), ...texts, ...dataItemTexts, ...extras];
      break;

    case "closing":
    case "image":
    case "product": {
      const capacity =
        type === "closing" ? SLIDE_CAPACITY.closing : type === "image" ? SLIDE_CAPACITY.image : 0;
      const items = [...texts, ...dataItemTexts, ...extras];
      first.bullets = items.slice(0, capacity);
      leftover = items.slice(capacity);
      if (type !== "closing") {
        first.image = pool.image;
        leftoverImage = undefined;
        if (!pool.image) {
          warnings.push(
            `${slideLabel(pool)}: the ${type} slide has no image, so the picture area shows a placeholder.`,
          );
        }
      }
      break;
    }

    case "quote": {
      const items = [...texts, ...dataItemTexts, ...chartTexts, ...headerTexts];
      first.quote = pool.quote || items.shift() || "";
      first.attribution = pool.attribution || pool.subtitle;
      first.subtitle = "";
      if (pool.attribution && pool.subtitle) items.unshift(pool.subtitle);
      leftover = items;
      break;
    }

    case "metric": {
      const structured = pool.dataItems.some((item) => item.value);
      const metrics = structured ? [...pool.dataItems] : texts.map(parseMetricText);
      leftover = structured ? [...texts, ...extras] : [...dataItemTexts, ...extras];
      // Lead with the first real number; the remaining items keep their order.
      const heroIndex = metrics.findIndex((metric) => metric.value);
      if (heroIndex > 0) metrics.unshift(...metrics.splice(heroIndex, 1));
      const pages = chunkEvenly(metrics, SLIDE_CAPACITY.metric);
      first.metrics = pages[0];
      for (const page of pages.slice(1))
        parts.push(continuation(pool, "metric", { metrics: page }));
      break;
    }

    case "timeline": {
      const structured = pool.dataItems.length > 0;
      const milestones: PlannedMilestone[] = structured
        ? pool.dataItems.map((item) => ({
            label: item.label || item.value,
            detail: [item.label ? item.value : "", item.detail].filter(Boolean).join(" — "),
          }))
        : [...texts, ...extras].map((label) => ({ label, detail: "" }));
      leftover = structured ? [...texts, ...extras] : [];
      const pages = chunkEvenly(milestones, SLIDE_CAPACITY.timeline);
      first.milestones = pages[0];
      for (const page of pages.slice(1)) {
        parts.push(continuation(pool, "timeline", { milestones: page }));
      }
      break;
    }

    case "process": {
      const pages = chunkEvenly([...texts, ...dataItemTexts, ...extras], SLIDE_CAPACITY.process);
      first.bullets = pages[0];
      let offset = pages[0].length;
      for (const page of pages.slice(1)) {
        parts.push(continuation(pool, "process", { bullets: page, offset }));
        offset += page.length;
      }
      break;
    }

    case "comparison": {
      const titles = pool.headers.slice(0, 2);
      const extraHeaders = pool.headers.length > 2 ? [pool.headers.slice(2).join(" | ")] : [];
      const items = [...texts, ...dataItemTexts, ...quoteTexts, ...chartTexts, ...extraHeaders];
      const half = Math.ceil(items.length / 2);
      const pageCount = Math.max(1, Math.ceil(half / SLIDE_CAPACITY.comparisonColumn));
      const left = splitInto(items.slice(0, half), pageCount);
      const right = splitInto(items.slice(half), pageCount);
      const columnsFor = (page: number): PlannedColumn[] => [
        { title: titles[0] || "", items: left[page] },
        { title: titles[1] || "", items: right[page] },
      ];
      first.columns = columnsFor(0);
      for (let page = 1; page < pageCount; page += 1) {
        parts.push(continuation(pool, "comparison", { columns: columnsFor(page) }));
      }
      break;
    }

    case "chart": {
      leftover = [...texts, ...dataItemTexts, ...quoteTexts, ...headerTexts];
      break;
    }

    case "table": {
      const tableData = table ?? {
        headers: pool.headers,
        rows: [...texts, ...dataItemTexts, ...quoteTexts, ...chartTexts].map((item) => [item]),
      };
      if (table) leftover = [...texts, ...dataItemTexts, ...quoteTexts, ...chartTexts];
      if (tableData.rows.length === 0 && tableData.headers.length === 0) {
        warnings.push(`${slideLabel(pool)}: the table slide has no rows or headers to show.`);
      }
      const pages = tablePages(tableData);
      first.table = pages[0];
      for (const page of pages.slice(1)) parts.push(continuation(pool, "table", { table: page }));
      leftoverTable = undefined;
      break;
    }

    default: {
      const pages = contentPages([...texts, ...dataItemTexts, ...extras]);
      first.bullets = pages[0];
      for (const page of pages.slice(1))
        parts.push(continuation(pool, "content", { bullets: page }));
      break;
    }
  }

  if (type === "chart" && numericChart) {
    leftoverChart = undefined;
    parts.splice(0, parts.length, ...chartSlides(pool, numericChart, first, warnings));
  }

  for (const page of leftover.length > 0 ? contentPages(leftover) : []) {
    parts.push(continuation(pool, "content", { bullets: page }));
  }
  for (const page of leftoverTable ? tablePages(leftoverTable) : []) {
    parts.push(continuation(pool, "table", { table: page }));
  }
  if (leftoverChart) {
    const host = continuation(pool, "chart", {});
    parts.push(...chartSlides(pool, leftoverChart, host, warnings));
  }
  if (leftoverImage) parts.push(continuation(pool, "image", { image: leftoverImage }));
  return parts;
}

function chartSlides(
  pool: SourcePool,
  built: { chart: PlannedChart; issues: string[] },
  host: PlannedSlide,
  warnings: string[],
): PlannedSlide[] {
  for (const issue of built.issues) warnings.push(`${slideLabel(pool)}: ${issue}.`);
  if (built.chart.series.length > SLIDE_CAPACITY.chartSeries) {
    warnings.push(
      `${slideLabel(pool)}: ${built.chart.series.length} series are more than one chart can show ` +
        `(${SLIDE_CAPACITY.chartSeries}), so the data is shown as a table.`,
    );
    return tablePages(chartAsTable(built.chart)).map((table, index) =>
      index === 0
        ? { ...host, type: "table" as const, table }
        : continuation(pool, "table", { table }),
    );
  }
  return chartPages(built.chart).map((chart, index) =>
    index === 0
      ? { ...host, type: "chart" as const, chart }
      : continuation(pool, "chart", { chart }),
  );
}

/**
 * Plans the slides to render for a requested deck. The plan is the single
 * source of truth for both renderers and for verifying the written file.
 */
export function planPresentationSlides(
  slides: readonly unknown[] | undefined,
  deck: PlanDeck = {},
): PresentationPlan {
  const requested = Array.isArray(slides) ? slides : [];
  const inputs: unknown[] =
    requested.length > 0
      ? requested
      : [{ title: deck.title || "Presentation", subtitle: deck.subject || "", layout: "title" }];
  const assetIds = new Set(
    (deck.assets || [])
      .filter((asset) => asset && (cleanSlideText(asset.path) || cleanSlideText(asset.url)))
      .map((asset) => cleanSlideText(asset.id))
      .filter(Boolean),
  );
  const warnings: string[] = [];
  const planned: PlannedSlide[] = [];

  inputs.forEach((input, index) => {
    const pool = readPool(input, index + 1);
    if (pool.image?.id && !pool.image.path && !pool.image.url && !assetIds.has(pool.image.id)) {
      warnings.push(
        `${slideLabel(pool)}: image asset "${pool.image.id}" was not found in assets, so no picture can be placed.`,
      );
    }
    const type = resolveSlideType(input, pool, index, inputs.length, warnings);
    const parts = planSlide(pool, type, warnings);
    if (parts.length > 1) {
      warnings.push(
        `${slideLabel(pool)} needed ${parts.length} slides to show all of its content; ` +
          `the extra slides are titled "${continuationTitle(pool.title)}".`,
      );
    }
    planned.push(...parts);
  });

  planned.forEach((slide, index) => {
    // Content slides alternate between a list and two columns; more than a
    // list holds always uses the two-column variant.
    const motif = index % 5;
    slide.motif =
      slide.type === "content" &&
      slide.bullets.length > SLIDE_CAPACITY.contentList &&
      motif % 2 === 0
        ? motif + 1
        : motif;
  });

  return { slides: planned, requestedSlideCount: requested.length, warnings };
}

/** Every text a rendered slide must contain; used to verify the written file. */
export function expectedSlideText(slide: PlannedSlide): string[] {
  const texts = [
    slide.title,
    slide.subtitle,
    ...slide.bullets,
    slide.quote,
    slide.attribution,
    ...slide.metrics.flatMap((metric) => [metric.value, metric.label, metric.detail]),
    ...slide.milestones.flatMap((milestone) => [milestone.label, milestone.detail]),
    ...slide.columns.flatMap((column) => [column.title, ...column.items]),
    ...(slide.table ? [...slide.table.headers, ...slide.table.rows.flat()] : []),
    ...(slide.chart
      ? [
          ...slide.chart.categories,
          ...slide.chart.series.flatMap((series) => [
            series.name,
            ...series.values
              .filter((value): value is number => value !== null)
              .map(formatChartValue),
          ]),
        ]
      : []),
  ];
  return texts.filter(Boolean);
}
