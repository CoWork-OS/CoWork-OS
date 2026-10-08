/**
 * Excel number formats for spreadsheet previews.
 *
 * Renders a cell value through its Excel number format code ("€#,##0.00;[Red]-€#,##0.00",
 * "0.0%", "yyyy-mm-dd"), so the preview shows what Excel shows while the raw value stays
 * editable. Supports sections (positive;negative;zero;text), currency and quoted literals,
 * colours (ignored), grouping, fixed and optional decimals, percentages, thousands scaling and
 * date/time codes. Returns null for General and for features it does not cover (conditions,
 * elapsed time, scientific notation, fractions), so callers fall back to the raw value.
 * Separators are always "." and ",", as the app is English-only.
 */

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const EXCEL_1904_EPOCH_MS = Date.UTC(1904, 0, 1);
const MS_PER_DAY = 86_400_000;
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type Part =
  | { kind: "literal"; text: string }
  | { kind: "digit"; ch: "0" | "#" | "?" }
  | { kind: "comma" }
  | { kind: "point" }
  | { kind: "percent" }
  | { kind: "date"; token: string }
  | { kind: "ampm"; token: string }
  | { kind: "text" };

/**
 * ExcelJS reports Excel's locale-dependent built-in date formats (ids 14 and 22) by these codes;
 * Excel shows them as the en-US short date and date-time.
 */
const BUILT_IN_FORMAT_DISPLAY: Record<string, string> = {
  "mm-dd-yy": "m/d/yyyy",
  'm/d/yy "h":mm': "m/d/yyyy h:mm",
};

class UnsupportedFormat extends Error {}

function excelSerialToDate(serial: number, date1904 = false): Date {
  return new Date(
    (date1904 ? EXCEL_1904_EPOCH_MS : EXCEL_EPOCH_MS) + Math.round(serial * MS_PER_DAY),
  );
}

function splitSections(code: string): string[] {
  const sections: string[] = [];
  let current = "";
  let inQuote = false;
  let inBracket = false;
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === "\\" && !inQuote) {
      current += ch + (code[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (ch === '"') inQuote = !inQuote;
    else if (!inQuote && ch === "[") inBracket = true;
    else if (!inQuote && ch === "]") inBracket = false;
    if (ch === ";" && !inQuote && !inBracket) {
      sections.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  sections.push(current);
  return sections;
}

function tokenize(section: string): Part[] {
  const parts: Part[] = [];
  const literal = (text: string) => parts.push({ kind: "literal", text });
  let i = 0;
  while (i < section.length) {
    const ch = section[i];
    const rest = section.slice(i);
    if (ch === '"') {
      const end = section.indexOf('"', i + 1);
      if (end < 0) throw new UnsupportedFormat("unterminated quote");
      literal(section.slice(i + 1, end));
      i = end + 1;
    } else if (ch === "\\") {
      literal(section[i + 1] ?? "");
      i += 2;
    } else if (ch === "_") {
      literal(" "); // _x reserves the width of x
      i += 2;
    } else if (ch === "*") {
      i += 2; // fill character: ignored in a fixed-width preview
    } else if (ch === "[") {
      const end = section.indexOf("]", i);
      if (end < 0) throw new UnsupportedFormat("unterminated bracket");
      const inner = section.slice(i + 1, end);
      if (inner.startsWith("$")) {
        const symbol = inner.slice(1).split("-")[0];
        if (symbol) literal(symbol); // [$€-816] → "€"; [$-409] locale only → nothing
      } else if (!/^(?:black|blue|cyan|green|magenta|red|white|yellow|color\s*\d+)$/i.test(inner)) {
        throw new UnsupportedFormat(`bracket ${inner}`); // conditions [>100], elapsed [h]
      }
      i = end + 1;
    } else if (ch === "0" || ch === "#" || ch === "?") {
      parts.push({ kind: "digit", ch });
      i += 1;
    } else if (ch === ",") {
      parts.push({ kind: "comma" });
      i += 1;
    } else if (ch === ".") {
      parts.push({ kind: "point" });
      i += 1;
    } else if (ch === "%") {
      parts.push({ kind: "percent" });
      i += 1;
    } else if (ch === "@") {
      parts.push({ kind: "text" });
      i += 1;
    } else if (/^(?:AM\/PM|A\/P)/i.test(rest)) {
      const token = /^AM\/PM/i.test(rest) ? rest.slice(0, 5) : rest.slice(0, 3);
      parts.push({ kind: "ampm", token });
      i += token.length;
    } else if (/^general/i.test(rest)) {
      throw new UnsupportedFormat("General inside a custom section");
    } else if (/[ymdhs]/i.test(ch)) {
      let j = i;
      while (j < section.length && section[j].toLowerCase() === ch.toLowerCase()) j += 1;
      parts.push({ kind: "date", token: section.slice(i, j).toLowerCase() });
      i = j;
    } else if (/[eE]/.test(ch) && /^[eE][+-]/.test(rest)) {
      throw new UnsupportedFormat("scientific");
    } else if (ch === "/") {
      // "/" between digit placeholders is a fraction; between date tokens it is a separator.
      const prev = parts[parts.length - 1];
      if (prev?.kind === "digit") throw new UnsupportedFormat("fraction");
      literal(ch);
      i += 1;
    } else {
      literal(ch);
      i += 1;
    }
  }
  return parts;
}

function fixed(value: number, decimals: number): string {
  // Excel rounds half away from zero on the decimal value (1.005 → 1.01); toFixed works in binary.
  const shifted = Number(`${value}e${decimals}`);
  if (!Number.isFinite(shifted)) return value.toFixed(decimals);
  return (Math.round(shifted) / 10 ** decimals).toFixed(decimals);
}

function formatNumber(value: number, parts: Part[]): string {
  const first = parts.findIndex((p) => p.kind === "digit");
  if (first < 0) return parts.map((p) => (p.kind === "literal" ? p.text : "")).join("");
  let last = parts.length - 1;
  while (parts[last].kind !== "digit") last -= 1;
  const body = parts.slice(first, last + 1);
  if (body.some((p) => p.kind !== "digit" && p.kind !== "comma" && p.kind !== "point")) {
    throw new UnsupportedFormat("literal between digit placeholders");
  }
  let scaled = value * 100 ** parts.filter((p) => p.kind === "percent").length;
  // Commas straight after the last placeholder divide by 1000 each ("#,##0," → thousands).
  for (let k = last + 1; k < parts.length && parts[k].kind === "comma"; k += 1) scaled /= 1000;
  const pointAt = body.findIndex((p) => p.kind === "point");
  const intParts = pointAt < 0 ? body : body.slice(0, pointAt);
  const fracDigits = pointAt < 0 ? [] : body.slice(pointAt + 1).filter((p) => p.kind === "digit");
  const minInt = intParts.filter((p) => p.kind === "digit" && p.ch === "0").length;
  const minFrac = fracDigits.filter((p) => p.kind === "digit" && p.ch === "0").length;
  let [intText, fracText = ""] = fixed(scaled, fracDigits.length).split(".");
  while (fracText.length > minFrac && fracText.endsWith("0")) fracText = fracText.slice(0, -1);
  if (intText === "0" && minInt === 0) intText = "";
  intText = intText.padStart(minInt, "0");
  if (intParts.some((p) => p.kind === "comma"))
    intText = intText.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const literalText = (slice: Part[]) =>
    slice.map((p) => (p.kind === "literal" ? p.text : p.kind === "percent" ? "%" : "")).join("");
  return (
    literalText(parts.slice(0, first)) +
    intText +
    (pointAt >= 0 ? `.${fracText}` : "") +
    literalText(parts.slice(last + 1))
  );
}

function formatDate(date: Date, parts: Part[]): string {
  const hasAmPm = parts.some((p) => p.kind === "ampm");
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const hours = date.getUTCHours();
  return parts
    .map((p, index) => {
      if (p.kind === "literal") return p.text;
      // In a date code "," and "." are separators ("dddd, mmmm d", "d.m.yyyy").
      if (p.kind === "comma") return ",";
      if (p.kind === "point") return ".";
      if (p.kind === "ampm") {
        const pm = hours >= 12;
        return p.token.length > 3 ? (pm ? "PM" : "AM") : pm ? "P" : "A";
      }
      if (p.kind !== "date") return "";
      const t = p.token;
      if (t.startsWith("y"))
        return t.length <= 2 ? pad(date.getUTCFullYear() % 100) : String(date.getUTCFullYear());
      if (t.startsWith("d")) {
        if (t.length >= 4) return DAYS[date.getUTCDay()];
        if (t.length === 3) return DAYS[date.getUTCDay()].slice(0, 3);
        return t.length === 2 ? pad(date.getUTCDate()) : String(date.getUTCDate());
      }
      if (t.startsWith("h")) {
        const h = hasAmPm ? hours % 12 || 12 : hours;
        return t.length >= 2 ? pad(h) : String(h);
      }
      if (t.startsWith("s"))
        return t.length >= 2 ? pad(date.getUTCSeconds()) : String(date.getUTCSeconds());
      // "m": minutes right after an hour token or right before a seconds token, otherwise month.
      const prev = parts
        .slice(0, index)
        .reverse()
        .find((q) => q.kind === "date") as { token: string } | undefined;
      const next = parts.slice(index + 1).find((q) => q.kind === "date") as
        | { token: string }
        | undefined;
      if (t.length <= 2 && (prev?.token.startsWith("h") || next?.token.startsWith("s"))) {
        return t.length === 2 ? pad(date.getUTCMinutes()) : String(date.getUTCMinutes());
      }
      const month = date.getUTCMonth();
      if (t.length >= 5) return MONTHS[month][0];
      if (t.length === 4) return MONTHS[month];
      if (t.length === 3) return MONTHS[month].slice(0, 3);
      return t.length === 2 ? pad(month + 1) : String(month + 1);
    })
    .join("");
}

function formatGeneral(value: number): string {
  return String(Number(value.toPrecision(15)));
}

/**
 * Formats a number, boolean or Date through an Excel number format code. Returns null for
 * General/unsupported codes or non-numeric values, so callers show the raw value instead.
 */
export function formatSpreadsheetValue(
  value: number | Date | boolean | string | null | undefined,
  numFmt: string | undefined,
  options: { date1904?: boolean } = {},
): string | null {
  if (!numFmt || /^general$/i.test(numFmt.trim()) || numFmt === "@") return null;
  if (value === null || value === undefined || typeof value === "boolean") return null;
  try {
    const sections = splitSections(BUILT_IN_FORMAT_DISPLAY[numFmt] ?? numFmt);
    if (typeof value === "string") {
      const textSection =
        sections.length >= 4 ? sections[3] : sections.find((s) => s.includes("@"));
      if (!textSection) return null;
      return tokenize(textSection)
        .map((p) => (p.kind === "literal" ? p.text : p.kind === "text" ? value : ""))
        .join("");
    }
    const serial =
      value instanceof Date
        ? (value.getTime() - (options.date1904 ? EXCEL_1904_EPOCH_MS : EXCEL_EPOCH_MS)) / MS_PER_DAY
        : value;
    if (!Number.isFinite(serial)) return null;
    let section = sections[0];
    let magnitude = serial;
    let sign = "";
    if (serial < 0 && sections.length >= 2 && sections[1] !== "") {
      section = sections[1];
      magnitude = -serial; // the negative section carries its own "-" or parentheses
    } else if (serial === 0 && sections.length >= 3 && sections[2] !== "") {
      section = sections[2];
    } else if (serial < 0) {
      magnitude = -serial;
      sign = "-";
    }
    if (/^general$/i.test(section.trim())) return sign + formatGeneral(magnitude);
    const parts = tokenize(section);
    if (parts.some((p) => p.kind === "date" || p.kind === "ampm")) {
      if (serial < 0) return null;
      return formatDate(
        value instanceof Date ? value : excelSerialToDate(serial, options.date1904),
        parts,
      );
    }
    if (value instanceof Date) return null;
    return sign + formatNumber(magnitude, parts);
  } catch {
    return null;
  }
}
