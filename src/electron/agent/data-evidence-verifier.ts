import path from "node:path";

interface CsvSourceSchema {
  absolutePath: string;
  basename: string;
  columns: Set<string>;
  hasCurrencyMarker: boolean;
  rows: string[][];
}

const CURRENCY_CODES =
  "USD|EUR|GBP|JPY|CAD|AUD|CHF|CNY|INR|NZD|SEK|NOK|DKK|PLN|BRL|MXN|ZAR|AED|SGD|HKD";

function parseCsvRows(content: string): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (quoted) {
      if (character === '"' && content[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
        closedQuote = true;
      } else {
        field += character;
      }
      continue;
    }
    if (character === ",") {
      row.push(field);
      field = "";
      closedQuote = false;
    } else if (character === "\n" || character === "\r") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      closedQuote = false;
      if (character === "\r" && content[index + 1] === "\n") index += 1;
    } else if (character === '"' && field.length === 0 && !closedQuote) {
      quoted = true;
    } else if (closedQuote && /\s/.test(character)) {
      continue;
    } else if (closedQuote || character === '"') {
      return null;
    } else {
      field += character;
    }
  }
  if (quoted) return null;
  if (field || row.length || closedQuote) rows.push([...row, field]);
  return rows;
}

function normalizeColumn(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function parseNumericCell(value: string): number | null {
  const withoutCurrency = value
    .replace(/[$€£¥₹]/g, "")
    .replace(new RegExp(`\\b(?:${CURRENCY_CODES})\\b`, "gi"), "")
    .trim();
  const normalized = /^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(withoutCurrency)
    ? withoutCurrency.replace(/,/g, "")
    : withoutCurrency;
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function sumColumn(rows: string[][], columnIndex: number): number | null {
  const values = rows.map((row) => parseNumericCell(row[columnIndex] || ""));
  if (values.length === 0 || values.some((value) => value === null)) return null;
  return (values as number[]).reduce((total, value) => total + value, 0);
}

function formatColumnTotal(rows: string[][], columnIndex: number): string | null {
  const total = sumColumn(rows, columnIndex);
  if (total === null) return null;
  const precision = Math.min(
    8,
    rows.reduce((max, row) => {
      const value = row[columnIndex] || "";
      const decimal =
        value
          .replace(/[$€£¥₹]/g, "")
          .replace(new RegExp(`\\b(?:${CURRENCY_CODES})\\b`, "gi"), "")
          .trim()
          .match(/\.(\d+)$/)?.[1].length || 0;
      return Math.max(max, decimal);
    }, 0),
  );
  return total.toFixed(precision);
}

function parseMarkdownCells(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return [];
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.replace(/[*`_]/g, "").trim());
}

function normalizeGroupValue(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (
    [
      "",
      "none",
      "empty",
      "unspecified",
      "undesignated",
      "unknown",
      "null",
      "nil",
      "n a",
      "not applicable",
      "not provided",
      "not specified",
      "not assigned",
      "unassigned",
      "missing",
      "missing region",
      "no region",
      "no region specified",
      "region missing",
      "region not specified",
      "unspecified region",
    ].includes(normalized)
  ) {
    return "__unspecified__";
  }
  return normalized;
}

function isMarkdownSeparator(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

// The claimed value must directly follow its label (optionally after markdown
// emphasis, ":", "=", "|", "is" or "was"). A looser window reads qualifiers such
// as "in 2024" or "(Q3 2024)" as the claim.
const CLAIMED_VALUE =
  "[*_\\s]*(?:[:=|]|\\b(?:is|was|of)\\b)?[*_\\s$€£¥₹]*(-?\\d[\\d,]*(?:\\.\\d+)?)";

function validateReportedCsvMetrics(
  source: CsvSourceSchema,
  report: string,
  request: string,
): string[] {
  const issues: string[] = [];
  const rows = source.rows;
  if (rows.length === 0) return issues;
  const columns = Array.from(source.columns);

  const orderIdIndex = columns.findIndex((column) =>
    /^(?:order_id|order_number|order_no|order)$/.test(column),
  );
  const expectedOrders =
    orderIdIndex >= 0
      ? new Set(rows.map((row) => (row[orderIdIndex] || "").trim())).size
      : rows.length;
  const orderCount = (report.match(
    new RegExp(`\\b(?:total orders|order count|number of orders)\\b${CLAIMED_VALUE}`, "i"),
  ) || [])[1];
  if (orderCount && Number(orderCount.replace(/,/g, "")) !== expectedOrders) {
    issues.push(
      `The source has ${expectedOrders} orders, but the report claims ${orderCount}. Correct the total.`,
    );
  }

  const amountIndex = Array.from(source.columns).findIndex((column) =>
    /^(?:amount|total_amount|order_amount|value|revenue|sales|income)$/.test(column),
  );
  const expectedAmount = amountIndex >= 0 ? sumColumn(rows, amountIndex) : null;
  const reportedAmount = (report.match(
    new RegExp(`\\b(?:(?:grand\\s+)?total|combined|overall)\\s+amount\\b${CLAIMED_VALUE}`, "i"),
  ) || [])[1];
  if (
    reportedAmount &&
    expectedAmount !== null &&
    parseNumericCell(reportedAmount) !== null &&
    Math.abs((parseNumericCell(reportedAmount) as number) - expectedAmount) > 0.005
  ) {
    issues.push(
      `The source total amount is ${expectedAmount}; the report claims ${reportedAmount}. Correct the total.`,
    );
  }

  const unitsIndex = Array.from(source.columns).findIndex((column) =>
    /^(?:units?|quantity|qty|units_sold)$/.test(column),
  );
  const expectedUnits = unitsIndex >= 0 ? sumColumn(rows, unitsIndex) : null;
  const reportedUnits = (report.match(
    new RegExp(`\\btotal units(?: sold)?\\b${CLAIMED_VALUE}`, "i"),
  ) || [])[1];
  if (
    reportedUnits &&
    expectedUnits !== null &&
    parseNumericCell(reportedUnits) !== null &&
    Math.abs((parseNumericCell(reportedUnits) as number) - expectedUnits) > 0.005
  ) {
    issues.push(
      `The source total units is ${expectedUnits}; the report claims ${reportedUnits}. Correct the total.`,
    );
  }

  const buildGroups = (groupIndex: number) => {
    const groups = new Map<string, { count: number; amounts: number[]; units: number[] }>();
    for (const row of rows) {
      const key = normalizeGroupValue(row[groupIndex] || "");
      const stats = groups.get(key) || { count: 0, amounts: [], units: [] };
      stats.count += 1;
      if (amountIndex >= 0) {
        const amount = parseNumericCell(row[amountIndex] || "");
        if (amount !== null) stats.amounts.push(amount);
      }
      if (unitsIndex >= 0) {
        const units = parseNumericCell(row[unitsIndex] || "");
        if (units !== null) stats.units.push(units);
      }
      groups.set(key, stats);
    }
    return groups;
  };

  const reportLines = report.split(/\r?\n/);
  for (let index = 0; index < reportLines.length; index += 1) {
    const headers = parseMarkdownCells(reportLines[index]).map(normalizeColumn);
    if (headers.length === 0) continue;
    const reportGroupIndex = headers.findIndex((header) =>
      /^(?:region|area|country|state|city|department|category|product)$/.test(header),
    );
    if (reportGroupIndex < 0) continue;
    // Only check a table against the source column it names; a Product table
    // says nothing about the source's regions.
    const groupIndex = columns.indexOf(headers[reportGroupIndex]);
    if (groupIndex < 0) continue;
    const groups = buildGroups(groupIndex);
    // Top-N or filtered tables intentionally list a subset of groups.
    const tableContext = [request, ...reportLines.slice(Math.max(0, index - 3), index)].join("\n");
    const listsSubsetOfGroups =
      /\b(?:top|bottom|highest|lowest|best|worst|largest|smallest|leading)\b(?:\s+\d+|\s+(?:one|two|three|four|five|ten))?|\bonly\b|\bexcluding\b|\bfiltered\b/i.test(
        tableContext,
      );
    const countIndex = headers.findIndex((header) =>
      /^(?:orders?|total_orders|order_count|total_count|count|records?)$/.test(header),
    );
    const reportAmountIndex = headers.findIndex((header) =>
      /^(?:amount|total_amount|combined_amount|value|revenue|sales|income)$/.test(header),
    );
    const reportUnitsIndex = headers.findIndex((header) =>
      /^(?:units?|total_units|total_units_sold|quantity|total_quantity|qty|units_sold)$/.test(
        header,
      ),
    );

    const reportedGroups = new Set<string>();
    for (let rowIndex = index + 1; rowIndex < reportLines.length; rowIndex += 1) {
      const cells = parseMarkdownCells(reportLines[rowIndex]);
      if (cells.length === 0) break;
      if (isMarkdownSeparator(cells)) continue;
      if (cells.length <= reportGroupIndex) continue;
      const label = cells[reportGroupIndex];
      const key = normalizeGroupValue(label);
      if (reportedGroups.has(key)) {
        issues.push(
          `The grouped table lists ${JSON.stringify(label)} more than once. Combine duplicate source groups into one row.`,
        );
        continue;
      }
      reportedGroups.add(key);
      const expected = groups.get(key);
      if (
        !expected &&
        ["total", "grand total", "overall", "overall total", "all groups", "all regions"].includes(
          key,
        )
      ) {
        if (countIndex >= 0) {
          const count = parseNumericCell(cells[countIndex] || "");
          if (count !== rows.length) {
            issues.push(
              `The total row should contain ${rows.length} source rows; the report claims ${cells[countIndex] || "no count"}.`,
            );
          }
        }
        if (reportAmountIndex >= 0 && expectedAmount !== null) {
          const amount = parseNumericCell(cells[reportAmountIndex] || "");
          if (amount === null || Math.abs(amount - expectedAmount) > 0.005) {
            issues.push(
              `The total row amount is ${expectedAmount} in the source; the report claims ${cells[reportAmountIndex] || "no amount"}.`,
            );
          }
        }
        if (reportUnitsIndex >= 0 && expectedUnits !== null) {
          const units = parseNumericCell(cells[reportUnitsIndex] || "");
          if (units === null || Math.abs(units - expectedUnits) > 0.005) {
            issues.push(
              `The total row units are ${expectedUnits} in the source; the report claims ${cells[reportUnitsIndex] || "no units"}.`,
            );
          }
        }
        continue;
      }
      if (!expected) {
        issues.push(
          `The report includes ${JSON.stringify(label)} in its grouped table, but that group is absent from the source.`,
        );
        continue;
      }

      if (countIndex >= 0) {
        const actual = parseNumericCell(cells[countIndex] || "");
        if (actual !== expected.count) {
          issues.push(
            `${label} has ${expected.count} source rows; the report claims ${cells[countIndex] || "no count"}.`,
          );
        }
      }
      if (reportAmountIndex >= 0 && expected.amounts.length === expected.count) {
        const amount = parseNumericCell(cells[reportAmountIndex] || "");
        const total = expected.amounts.reduce((sum, value) => sum + value, 0);
        if (amount === null || Math.abs(amount - total) > 0.005) {
          issues.push(
            `${label} amount totals ${total} in the source; the report claims ${cells[reportAmountIndex] || "no amount"}.`,
          );
        }
      }
      if (reportUnitsIndex >= 0 && expected.units.length === expected.count) {
        const units = parseNumericCell(cells[reportUnitsIndex] || "");
        const total = expected.units.reduce((sum, value) => sum + value, 0);
        if (units === null || Math.abs(units - total) > 0.005) {
          issues.push(
            `${label} units total ${total} in the source; the report claims ${cells[reportUnitsIndex] || "no units"}.`,
          );
        }
      }
    }
    for (const [key, expected] of groups) {
      if (!listsSubsetOfGroups && !reportedGroups.has(key)) {
        const label = key === "__unspecified__" ? "Unspecified" : key;
        issues.push(
          `The grouped table omits ${label}, which has ${expected.count} source rows. Include every source group.`,
        );
      }
    }
    break;
  }

  return issues;
}

function hasCurrencyMarker(text: string): boolean {
  return (
    /[$€£¥₹]\s*[-+]?\d/.test(text) ||
    new RegExp(`\\b(?:${CURRENCY_CODES})\\b`, "i").test(text) ||
    /\b(?:dollars?|euros?|pounds?|yen|rupees?)\b/i.test(text)
  );
}

function hasCurrencyAnnotation(text: string): boolean {
  return (
    /[$€£¥₹]\s*[-+]?\d/.test(text) ||
    new RegExp(
      `\\b(?:${CURRENCY_CODES})\\s*[-+]?\\d|[-+]?\\d[\\d,.]*\\s*(?:${CURRENCY_CODES})\\b`,
      "i",
    ).test(text) ||
    /\b[-+]?\d[\d,.]*\s*(?:dollars?|euros?|pounds?|yen|rupees?)\b/i.test(text)
  );
}

export class CsvReportEvidenceVerifier {
  private readonly sources = new Map<string, CsvSourceSchema>();

  constructor(private readonly workspacePath: string) {}

  recordRead(filePath: string, content: string, truncated: boolean): void {
    if (!/\.csv$/i.test(filePath) || truncated || content.length > 100_000) return;
    const parsedRows = parseCsvRows(content);
    const columns = parsedRows?.[0]?.map(normalizeColumn);
    if (!parsedRows || !columns || columns.length < 2 || !columns.some(Boolean)) return;
    const dataRows = parsedRows.slice(1).filter((row) => row.some((cell) => cell.trim()));
    if (dataRows.some((row) => row.length !== columns.length)) return;
    // Duplicate or blank headers would collapse in the Set below and misalign
    // column indexes with row cells; skip such files instead of guessing.
    if (new Set(columns).size !== columns.length || columns.some((column) => !column)) return;
    const absolutePath = path.resolve(this.workspacePath, filePath);
    this.sources.set(absolutePath, {
      absolutePath,
      basename: path.basename(filePath).toLowerCase(),
      columns: new Set(columns),
      hasCurrencyMarker: hasCurrencyMarker(content),
      rows: dataRows,
    });
  }

  getEvidenceSummary(requestText: string): string | null {
    const source = this.selectSource(requestText);
    if (!source || source.rows.length === 0) return null;
    const rows = source.rows;
    const columns = Array.from(source.columns);
    const amountIndex = columns.findIndex((column) =>
      /^(?:amount|total_amount|order_amount|value|revenue|sales|income)$/.test(column),
    );
    const unitsIndex = columns.findIndex((column) =>
      /^(?:units?|quantity|qty|units_sold)$/.test(column),
    );
    const groupIndex = columns.findIndex((column) =>
      /^(?:region|area|country|state|city|department|category|product)$/.test(column),
    );
    const metrics = [`${rows.length} data rows`];
    if (amountIndex >= 0) {
      const total = formatColumnTotal(rows, amountIndex);
      if (total !== null) metrics.push(`sum(${columns[amountIndex]})=${total}`);
    }
    if (unitsIndex >= 0) {
      const total = formatColumnTotal(rows, unitsIndex);
      if (total !== null) metrics.push(`sum(${columns[unitsIndex]})=${total}`);
    }

    if (groupIndex >= 0) {
      const groups = new Map<string, { label: string; rows: string[][] }>();
      for (const row of rows) {
        const value = row[groupIndex] || "";
        const key = normalizeGroupValue(value);
        const existing = groups.get(key) || {
          label: key === "__unspecified__" ? "Unspecified" : value.trim(),
          rows: [],
        };
        existing.rows.push(row);
        groups.set(key, existing);
      }
      const groupDetails = Array.from(groups.values())
        .sort((left, right) => left.label.localeCompare(right.label))
        .slice(0, 20)
        .map(({ label, rows: groupRows }) => {
          const groupMetrics = [`${groupRows.length} rows`];
          if (amountIndex >= 0) {
            const total = formatColumnTotal(groupRows, amountIndex);
            if (total !== null) groupMetrics.push(`${columns[amountIndex]}=${total}`);
          }
          if (unitsIndex >= 0) {
            const total = formatColumnTotal(groupRows, unitsIndex);
            if (total !== null) groupMetrics.push(`${columns[unitsIndex]}=${total}`);
          }
          return `${label || "Unspecified"} (${groupMetrics.join(", ")})`;
        });
      metrics.push(`by ${columns[groupIndex]}: ${groupDetails.join("; ")}`);
    }

    return [
      "SOURCE CSV CALCULATIONS (computed from the complete file read; use these as authoritative):",
      `${source.basename}: ${metrics.join("; ")}.`,
    ].join("\n");
  }

  validateMarkdownWrite(params: {
    filePath: string;
    content: string;
    requestText: string;
  }): string[] {
    if (!/\.md$/i.test(params.filePath) || params.content.length > 100_000) return [];
    if (
      !/\b(?:summary|report|summari[sz]e|analy[sz]e|daily|revenue|sales)\b/i.test(
        params.requestText,
      )
    ) {
      return [];
    }

    const source = this.selectSource(params.requestText);
    if (!source) return [];

    const report = params.content;
    const request = params.requestText;
    const columns = source.columns;
    const issues: string[] = [];
    const hasDateColumn = Array.from(columns).some((column) =>
      /(?:^|_)(?:date|day|timestamp|datetime|time)(?:_|$)|_at$/.test(column),
    );
    const requestsDailyGrouping =
      /\b(?:daily\s+(?:orders?|summary|report|breakdown|totals?|revenue|metrics?|statistics?)|by\s+date|per[\s-]+day|day[\s-]+by[\s-]+day)\b/i.test(
        request,
      );
    const disclosesNoDate =
      /\bno date column\b|\bdoes not contain (?:a )?date\b|\bcannot (?:be )?group(?:ed)? by date\b|\bdaily grouping (?:is )?(?:unavailable|not possible)\b/i.test(
        report,
      );
    // A report that says daily data is unavailable may still use the words
    // "daily breakdown"; only explicit day buckets count as invented then.
    const inventsDateBuckets =
      /\bday\s*#?\s*\d+\b|\|\s*day\s*\|/i.test(report) ||
      (!disclosesNoDate &&
        /\baverage daily\b|\bdaily (?:breakdown|totals?|revenue|metrics?)\b|\btop[- ]selling days\b/i.test(
          report,
        ));
    if (!hasDateColumn && inventsDateBuckets) {
      issues.push(
        "The CSV has no date column, so do not create day numbers, daily averages, or daily breakdowns. Use an overall aggregate and state that date grouping is unavailable.",
      );
    } else if (!hasDateColumn && requestsDailyGrouping && !disclosesNoDate) {
      issues.push(
        "The CSV has no date column. State that daily grouping is unavailable; do not imply that the report contains daily data.",
      );
    }

    const requestSpecifiesCurrency = new RegExp(
      `\\b(?:use|in|currency\\s*(?:is|:|=)|format\\s+(?:as|in))\\s*(?:[$€£¥₹]|\\b(?:${CURRENCY_CODES})\\b|\\b(?:dollars?|euros?|pounds?|yen|rupees?)\\b)`,
      "i",
    ).test(request);
    if (!source.hasCurrencyMarker && !requestSpecifiesCurrency && hasCurrencyAnnotation(report)) {
      issues.push(
        "The source and request do not specify a currency. Remove currency symbols, codes, and names; label amounts as currency unspecified.",
      );
    }

    const sourceDefinesRevenue = Array.from(columns).some((column) =>
      /^(?:revenue|sales|income|gross_sales|total_revenue)$/.test(column),
    );
    const requestDefinesRevenue = /\b(?:revenue|sales|income)\b/i.test(request);
    if (
      !sourceDefinesRevenue &&
      !requestDefinesRevenue &&
      /\b(?:total|average|daily|regional)\s+(?:revenue|sales|income)\b|\|\s*(?:revenue|sales|income)\s*\|/i.test(
        report,
      )
    ) {
      issues.push(
        "The source has a generic amount field, not a revenue/sales field. Label the metric as amount unless the request or source defines it as revenue.",
      );
    }

    const hasCostField = Array.from(columns).some((column) =>
      /(?:^|_)(?:cost|unit_cost|cogs|profit|margin)(?:_|$)/.test(column),
    );
    if (
      !hasCostField &&
      /\b(?:higher|lower|gross|net|improved|reduced)\s+margins?\b|\bprofit\s*(?:[:=]|of\s+[$€£¥₹]?\s*\d)/i.test(
        report,
      )
    ) {
      issues.push(
        "The source has no cost or profit fields. Remove claims about profit or margins, or state that they cannot be calculated from this data.",
      );
    }

    const userAskedForRecommendations =
      /\b(?:recommendations?|suggestions?|what should|next steps?)\b/i.test(request);
    if (!userAskedForRecommendations && /^[ \t]*#{1,6}[ \t]*recommendations?\b/im.test(report)) {
      issues.push(
        "The request asks for a summary, not recommendations. Remove the recommendations section unless it is explicitly requested and supported by the data.",
      );
    }

    issues.push(...validateReportedCsvMetrics(source, report, request));

    return issues;
  }

  private selectSource(requestText: string): CsvSourceSchema | null {
    const candidates = Array.from(this.sources.values());
    const mentioned = candidates.filter((source) =>
      requestText.toLowerCase().includes(source.basename),
    );
    if (mentioned.length === 1) return mentioned[0];
    return candidates.length === 1 ? candidates[0] : null;
  }
}
