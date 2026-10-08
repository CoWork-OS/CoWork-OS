/**
 * Cached formula results for the spreadsheet writers (create_spreadsheet, generate_spreadsheet)
 * and the spreadsheet viewer's save path.
 *
 * ExcelJS writes formulas without a value, and many viewers never recalculate: CoWork's own
 * preview, Quick Look, mobile viewers, and LibreOffice by default for .xlsx files. They show blank
 * totals. This evaluator computes a small, safe subset of Excel (arithmetic, comparisons, "&",
 * cell and range references across sheets, and common aggregate functions) without eval, and
 * stores the result next to the formula. Anything outside the subset keeps no cached result and
 * is reported, so callers can say so; Excel calculates it on open (see fullCalcOnLoad).
 */
import type ExcelJS from "exceljs";

type Scalar = number | string | boolean | null; // null is a blank cell
type RangeValue = { kind: "range"; values: Scalar[] };
type Value = Scalar | RangeValue;

type Node =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "bool"; value: boolean }
  | {
      kind: "ref";
      sheet?: string;
      r1: number;
      c1: number;
      r2: number;
      c2: number;
      isRange: boolean;
      wholeColumn: boolean;
    }
  | { kind: "unary"; op: string; arg: Node }
  | { kind: "percent"; arg: Node }
  | { kind: "binary"; op: string; left: Node; right: Node }
  | { kind: "call"; name: string; args: Node[] };

/** Thrown for anything the evaluator does not compute; the message is the reason reported. */
class UnsupportedFormula extends Error {}

const MAX_FORMULA_LENGTH = 2_000;
const MAX_RANGE_CELLS = 100_000;
const MAX_PARSE_DEPTH = 64;
/** Formula cells evaluated at once along one dependency chain; deeper chains stay uncached. */
const MAX_DEPENDENCY_CHAIN = 500;
const MAX_ROW = 1_048_576;
const MAX_COLUMN = 16_384;
const EXCEL_1900_EPOCH_MS = Date.UTC(1899, 11, 30);
const EXCEL_1904_EPOCH_MS = Date.UTC(1904, 0, 1);
const MS_PER_DAY = 86_400_000;

const COMPARISON_OPERATORS = ["<>", "<=", ">=", "=", "<", ">"];
const REFERENCE_PATTERN =
  /^(?:(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_.]*))!)?(\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?|\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3})(?![A-Za-z0-9_(])/;

function columnNumber(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function parseFormula(source: string): Node {
  if (source.length > MAX_FORMULA_LENGTH) throw new UnsupportedFormula("formula is too long");
  let pos = 0;
  const skipSpace = () => {
    while (pos < source.length && /\s/.test(source[pos])) pos += 1;
  };
  const peek = (token: string) => {
    skipSpace();
    return source.startsWith(token, pos);
  };
  const expect = (token: string) => {
    if (!peek(token)) throw new UnsupportedFormula(`expected "${token}"`);
    pos += token.length;
  };

  const reference = (match: RegExpExecArray): Node => {
    const sheet = match[1]?.replace(/''/g, "'") ?? match[2];
    const [first, second] = match[3].replace(/\$/g, "").split(":");
    const cell = (text: string) => {
      const parts = /^([A-Za-z]{1,3})(\d*)$/.exec(text);
      if (!parts) throw new UnsupportedFormula("invalid reference");
      return { column: columnNumber(parts[1]), row: parts[2] ? Number(parts[2]) : 0 };
    };
    const start = cell(first);
    const end = second ? cell(second) : start;
    const wholeColumn = start.row === 0;
    const node: Node = {
      kind: "ref",
      sheet,
      r1: wholeColumn ? 1 : Math.min(start.row, end.row),
      r2: wholeColumn ? MAX_ROW : Math.max(start.row, end.row),
      c1: Math.min(start.column, end.column),
      c2: Math.max(start.column, end.column),
      isRange: Boolean(second),
      wholeColumn,
    };
    if (node.r1 < 1 || node.r2 > MAX_ROW || node.c2 > MAX_COLUMN) {
      throw new UnsupportedFormula("reference is outside the worksheet");
    }
    return node;
  };

  const primary = (depth: number): Node => {
    if (depth > MAX_PARSE_DEPTH) throw new UnsupportedFormula("formula is nested too deeply");
    skipSpace();
    const rest = source.slice(pos);
    if (rest.startsWith("(")) {
      pos += 1;
      const inner = comparison(depth + 1);
      expect(")");
      return inner;
    }
    if (rest.startsWith('"')) {
      const text = /^"((?:[^"]|"")*)"/.exec(rest);
      if (!text) throw new UnsupportedFormula("unterminated text");
      pos += text[0].length;
      return { kind: "str", value: text[1].replace(/""/g, '"') };
    }
    const number = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
    if (number) {
      pos += number[0].length;
      return { kind: "num", value: Number(number[0]) };
    }
    const call = /^([A-Za-z_][A-Za-z0-9_.]*)\s*\(/.exec(rest);
    if (call) {
      pos += call[0].length;
      const args: Node[] = [];
      if (!peek(")")) {
        args.push(comparison(depth + 1));
        while (peek(",")) {
          pos += 1;
          args.push(comparison(depth + 1));
        }
      }
      expect(")");
      return { kind: "call", name: call[1].toUpperCase().replace(/^_XLFN\./, ""), args };
    }
    const ref = REFERENCE_PATTERN.exec(rest);
    if (ref) {
      pos += ref[0].length;
      return reference(ref);
    }
    const bool = /^(TRUE|FALSE)(?![A-Za-z0-9_(])/i.exec(rest);
    if (bool) {
      pos += bool[0].length;
      return { kind: "bool", value: bool[1].toUpperCase() === "TRUE" };
    }
    // Named ranges, array constants, structured table references, error literals.
    throw new UnsupportedFormula(`unsupported syntax near "${rest.slice(0, 16)}"`);
  };
  const percent = (depth: number): Node => {
    let node = primary(depth);
    while (peek("%")) {
      pos += 1;
      node = { kind: "percent", arg: node };
    }
    return node;
  };
  const unary = (depth: number): Node => {
    if (peek("-") || peek("+")) {
      const op = source[pos];
      pos += 1;
      return { kind: "unary", op, arg: unary(depth + 1) };
    }
    return percent(depth);
  };
  const binary =
    (operators: string[], next: (depth: number) => Node) =>
    (depth: number): Node => {
      let left = next(depth);
      for (;;) {
        const op = operators.find((candidate) => peek(candidate));
        if (!op) return left;
        pos += op.length;
        left = { kind: "binary", op, left, right: next(depth) };
      }
    };
  // Excel precedence, lowest first: comparison, &, + -, * /, ^, unary minus, %.
  const power = binary(["^"], unary);
  const product = binary(["*", "/"], power);
  const sum = binary(["+", "-"], product);
  const concat = binary(["&"], sum);
  const comparison = binary(COMPARISON_OPERATORS, concat);

  const root = comparison(0);
  skipSpace();
  if (pos !== source.length) {
    throw new UnsupportedFormula(`unsupported syntax near "${source.slice(pos, pos + 16)}"`);
  }
  return root;
}

function toNumber(value: Scalar): number {
  if (value === null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  const trimmed = value.trim();
  if (trimmed !== "" && Number.isFinite(Number(trimmed))) return Number(trimmed);
  throw new UnsupportedFormula("#VALUE!");
}

function toScalar(value: Value): Scalar {
  if (value !== null && typeof value === "object") {
    if (value.values.length !== 1) throw new UnsupportedFormula("a range is used as one value");
    return value.values[0];
  }
  return value;
}

function compareValues(left: Scalar, right: Scalar, op: string): boolean {
  let a: number | string | boolean = typeof left === "string" ? left.toLowerCase() : (left ?? 0);
  let b: number | string | boolean = typeof right === "string" ? right.toLowerCase() : (right ?? 0);
  if (left === null && typeof b === "string") a = "";
  if (right === null && typeof a === "string") b = "";
  if (typeof a !== typeof b) {
    // Excel orders values of different types as numbers < text < booleans.
    const rank = (v: unknown) => (typeof v === "number" ? 0 : typeof v === "string" ? 1 : 2);
    a = rank(a);
    b = rank(b);
  }
  switch (op) {
    case "=":
      return a === b;
    case "<>":
      return a !== b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    default:
      return a >= b;
  }
}

/** SUMIF/COUNTIF criteria: a value, or text such as ">100", "<>Venue", "V*" (wildcards). */
function criteriaMatcher(criteria: Scalar): (value: Scalar) => boolean {
  if (typeof criteria === "number" || typeof criteria === "boolean") {
    return (value) => value === criteria;
  }
  const parts = /^(<=|>=|<>|=|<|>)?([\s\S]*)$/.exec(criteria ?? "");
  const op = parts?.[1] ?? "=";
  const operand = parts?.[2] ?? "";
  const numeric =
    operand.trim() !== "" && Number.isFinite(Number(operand)) ? Number(operand) : null;
  if (numeric !== null) {
    return (value) => typeof value === "number" && compareValues(value, numeric, op);
  }
  if (operand === "" && (op === "=" || op === "<>")) {
    return (value) => (value === null || value === "") === (op === "=");
  }
  if (op === "=" || op === "<>") {
    const pattern = new RegExp(
      `^${operand
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/~\\?([*?])|([*?])/g, (_match, escaped: string, wildcard: string) =>
          escaped ? `\\${escaped}` : wildcard === "*" ? "[\\s\\S]*" : "[\\s\\S]",
        )}$`,
      "i",
    );
    return (value) => (typeof value === "string" && pattern.test(value)) === (op === "=");
  }
  return (value) => typeof value === "string" && compareValues(value, operand, op);
}

function numbersIn(args: Value[]): number[] {
  const numbers: number[] = [];
  for (const arg of args) {
    if (arg !== null && typeof arg === "object") {
      // Inside ranges only numbers count; text, booleans and blanks are skipped.
      for (const value of arg.values) if (typeof value === "number") numbers.push(value);
    } else if (arg !== null) {
      numbers.push(toNumber(arg)); // direct arguments: TRUE is 1, "3" is 3
    }
  }
  return numbers;
}

function asRange(value: Value | undefined): RangeValue {
  if (value !== null && value !== undefined && typeof value === "object") return value;
  throw new UnsupportedFormula("expected a range");
}

function roundTo(value: number, digits: number, mode: "nearest" | "up" | "down"): number {
  const factor = 10 ** Math.trunc(digits);
  const shifted = Number((Math.abs(value) * factor).toPrecision(15));
  const rounded =
    mode === "nearest"
      ? Math.round(shifted)
      : mode === "up"
        ? Math.ceil(shifted)
        : Math.floor(shifted);
  return (Math.sign(value) * rounded) / factor;
}

function conditionalAggregate(
  valueRange: RangeValue | null,
  pairs: Array<[RangeValue, Scalar]>,
  aggregate: "sum" | "count" | "average",
): number {
  const length = pairs[0][0].values.length;
  if (pairs.some(([range]) => range.values.length !== length)) {
    throw new UnsupportedFormula("criteria ranges differ in size");
  }
  if (valueRange && valueRange.values.length !== length) {
    throw new UnsupportedFormula("the value range differs in size from the criteria range");
  }
  const matchers = pairs.map(([range, criteria]) => [range, criteriaMatcher(criteria)] as const);
  const source = valueRange ?? pairs[0][0];
  let total = 0;
  let count = 0;
  for (let index = 0; index < length; index += 1) {
    if (!matchers.every(([range, matches]) => matches(range.values[index]))) continue;
    if (aggregate === "count") {
      count += 1;
      continue;
    }
    const value = source.values[index];
    if (typeof value === "number") {
      total += value;
      count += 1;
    }
  }
  if (aggregate === "count") return count;
  if (aggregate === "average") {
    if (count === 0) throw new UnsupportedFormula("#DIV/0!");
    return total / count;
  }
  return total;
}

function criteriaPairs(args: Value[]): Array<[RangeValue, Scalar]> {
  if (args.length === 0 || args.length % 2 !== 0) {
    throw new UnsupportedFormula("criteria must come in range/criteria pairs");
  }
  const pairs: Array<[RangeValue, Scalar]> = [];
  for (let index = 0; index < args.length; index += 2) {
    pairs.push([asRange(args[index]), toScalar(args[index + 1])]);
  }
  return pairs;
}

const FUNCTIONS: Record<string, (args: Value[]) => Scalar> = {
  SUM: (args) => numbersIn(args).reduce((total, value) => total + value, 0),
  AVERAGE: (args) => {
    const numbers = numbersIn(args);
    if (numbers.length === 0) throw new UnsupportedFormula("#DIV/0!");
    return numbers.reduce((total, value) => total + value, 0) / numbers.length;
  },
  MIN: (args) => {
    const numbers = numbersIn(args);
    return numbers.length > 0 ? Math.min(...numbers) : 0;
  },
  MAX: (args) => {
    const numbers = numbersIn(args);
    return numbers.length > 0 ? Math.max(...numbers) : 0;
  },
  COUNT: (args) =>
    args.reduce<number>((count, arg) => {
      if (arg !== null && typeof arg === "object") {
        return count + arg.values.filter((value) => typeof value === "number").length;
      }
      return count + (typeof arg === "number" ? 1 : 0);
    }, 0),
  COUNTA: (args) =>
    args.reduce<number>((count, arg) => {
      if (arg !== null && typeof arg === "object") {
        return count + arg.values.filter((value) => value !== null).length;
      }
      return count + 1;
    }, 0),
  ABS: ([value]) => Math.abs(toNumber(toScalar(value ?? null))),
  ROUND: ([value, digits = 0]) =>
    roundTo(toNumber(toScalar(value ?? null)), toNumber(toScalar(digits)), "nearest"),
  ROUNDUP: ([value, digits = 0]) =>
    roundTo(toNumber(toScalar(value ?? null)), toNumber(toScalar(digits)), "up"),
  ROUNDDOWN: ([value, digits = 0]) =>
    roundTo(toNumber(toScalar(value ?? null)), toNumber(toScalar(digits)), "down"),
  IF: ([test, whenTrue = true, whenFalse = false]) =>
    toNumber(toScalar(test ?? null)) !== 0 ? toScalar(whenTrue) : toScalar(whenFalse),
  SUMIF: ([range, criteria, valueRange]) =>
    conditionalAggregate(
      valueRange === undefined ? null : asRange(valueRange),
      [[asRange(range), toScalar(criteria ?? null)]],
      "sum",
    ),
  AVERAGEIF: ([range, criteria, valueRange]) =>
    conditionalAggregate(
      valueRange === undefined ? null : asRange(valueRange),
      [[asRange(range), toScalar(criteria ?? null)]],
      "average",
    ),
  COUNTIF: ([range, criteria]) =>
    conditionalAggregate(null, [[asRange(range), toScalar(criteria ?? null)]], "count"),
  SUMIFS: ([valueRange, ...rest]) =>
    conditionalAggregate(asRange(valueRange), criteriaPairs(rest), "sum"),
  COUNTIFS: (args) => conditionalAggregate(null, criteriaPairs(args), "count"),
};

export interface UncachedFormula {
  sheet: string;
  address: string;
  formula: string;
  reason: string;
}

export interface FormulaComputationReport {
  /** Formula cells that now carry a cached result. */
  computed: number;
  /** Formula cells left without a cached result, with the reason. */
  uncached: UncachedFormula[];
}

function isFormulaValue(value: ExcelJS.CellValue): value is ExcelJS.CellFormulaValue {
  return Boolean(
    value && typeof value === "object" && ("formula" in value || "sharedFormula" in value),
  );
}

/**
 * Stores a cached result on every formula cell the evaluator understands, recomputing results
 * that are already there. Formula cells it cannot evaluate are left as they are and reported.
 */
export function computeWorkbookFormulaResults(
  workbook: ExcelJS.Workbook,
): FormulaComputationReport {
  const report: FormulaComputationReport = { computed: 0, uncached: [] };
  const epoch = workbook.properties?.date1904 ? EXCEL_1904_EPOCH_MS : EXCEL_1900_EPOCH_MS;
  const memo = new Map<string, Scalar | UnsupportedFormula>();
  const inProgress = new Set<string>();

  const findSheet = (name: string | undefined, current: ExcelJS.Worksheet): ExcelJS.Worksheet => {
    if (!name) return current;
    const lower = name.toLowerCase();
    const sheet = workbook.worksheets.find((candidate) => candidate.name.toLowerCase() === lower);
    if (!sheet) throw new UnsupportedFormula(`sheet "${name}" does not exist`);
    return sheet;
  };

  const readCell = (sheet: ExcelJS.Worksheet, row: number, column: number): Scalar => {
    const cell = sheet.findCell(row, column);
    const value = cell?.value;
    if (value === null || value === undefined) return null;
    if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
      return value;
    }
    if (value instanceof Date) return (value.getTime() - epoch) / MS_PER_DAY;
    if (cell && isFormulaValue(value)) return evaluateCell(sheet, cell);
    if ("richText" in value) return value.richText.map((part) => part.text).join("");
    if ("text" in value) return String(value.text ?? "");
    throw new UnsupportedFormula("a referenced cell holds an error");
  };

  const evaluate = (node: Node, sheet: ExcelJS.Worksheet): Value => {
    switch (node.kind) {
      case "num":
      case "str":
      case "bool":
        return node.value;
      case "ref": {
        const target = findSheet(node.sheet, sheet);
        // Whole-column references (D:D) cover the used rows; explicit ranges keep their shape.
        const lastRow = node.wholeColumn ? Math.max(target.rowCount, 1) : node.r2;
        const rows = lastRow - node.r1 + 1;
        const columns = node.c2 - node.c1 + 1;
        if (rows * columns > MAX_RANGE_CELLS) throw new UnsupportedFormula("range is too large");
        const values: Scalar[] = [];
        for (let row = node.r1; row <= lastRow; row += 1) {
          for (let column = node.c1; column <= node.c2; column += 1) {
            values.push(readCell(target, row, column));
          }
        }
        return node.isRange ? { kind: "range", values } : values[0];
      }
      case "unary": {
        const value = toNumber(toScalar(evaluate(node.arg, sheet)));
        return node.op === "-" ? -value : value;
      }
      case "percent":
        return toNumber(toScalar(evaluate(node.arg, sheet))) / 100;
      case "binary": {
        const left = toScalar(evaluate(node.left, sheet));
        const right = toScalar(evaluate(node.right, sheet));
        if (node.op === "&") return `${left ?? ""}${right ?? ""}`;
        if (COMPARISON_OPERATORS.includes(node.op)) return compareValues(left, right, node.op);
        const a = toNumber(left);
        const b = toNumber(right);
        if (node.op === "+") return a + b;
        if (node.op === "-") return a - b;
        if (node.op === "*") return a * b;
        if (node.op === "/") {
          if (b === 0) throw new UnsupportedFormula("#DIV/0!");
          return a / b;
        }
        return a ** b;
      }
      case "call": {
        const fn = FUNCTIONS[node.name];
        if (!fn) throw new UnsupportedFormula(`${node.name} is not evaluated by CoWork`);
        return fn(node.args.map((arg) => evaluate(arg, sheet)));
      }
    }
  };

  const evaluateCell = (sheet: ExcelJS.Worksheet, cell: ExcelJS.Cell): Scalar => {
    const key = `${sheet.id}:${cell.row}:${cell.col}`;
    const known = memo.get(key);
    if (known instanceof UnsupportedFormula) throw known;
    if (known !== undefined) return known;
    if (inProgress.has(key)) throw new UnsupportedFormula("circular reference");
    if (inProgress.size >= MAX_DEPENDENCY_CHAIN) {
      throw new UnsupportedFormula("dependency chain is too deep");
    }
    inProgress.add(key);
    try {
      const result = toScalar(evaluate(parseFormula(cell.formula), sheet));
      // Excel keeps 15 significant digits: 0.1 + 0.2 is stored as 0.3.
      const stored = typeof result === "number" ? Number(result.toPrecision(15)) : result;
      if (typeof stored === "number" && !Number.isFinite(stored)) {
        throw new UnsupportedFormula("#NUM!");
      }
      memo.set(key, stored);
      return stored;
    } catch (error) {
      const failure =
        error instanceof UnsupportedFormula
          ? error
          : new UnsupportedFormula(error instanceof Error ? error.message : String(error));
      memo.set(key, failure);
      throw failure;
    } finally {
      inProgress.delete(key);
    }
  };

  for (const sheet of workbook.worksheets) {
    sheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const value = cell.value;
        if (!isFormulaValue(value)) return;
        try {
          const result = evaluateCell(sheet, cell);
          // A formula over a blank cell shows 0 in Excel.
          cell.value = { ...value, result: result ?? 0 } as ExcelJS.CellValue;
          report.computed += 1;
        } catch (error) {
          report.uncached.push({
            sheet: sheet.name,
            address: cell.address,
            formula: cell.formula,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      });
    });
  }
  return report;
}

const MAX_REPORTED_UNCACHED = 20;

export interface FormulaReportSummary {
  computed: number;
  uncached: UncachedFormula[];
  uncachedOmitted?: number;
}

/** The formula part of a spreadsheet tool result: counts, a bounded uncached list and a note. */
export function summarizeFormulaReport(report: FormulaComputationReport): {
  formulas: FormulaReportSummary;
  warning?: string;
} {
  const omitted = report.uncached.length - MAX_REPORTED_UNCACHED;
  return {
    formulas: {
      computed: report.computed,
      uncached: report.uncached.slice(0, MAX_REPORTED_UNCACHED),
      ...(omitted > 0 ? { uncachedOmitted: omitted } : {}),
    },
    ...(report.uncached.length > 0
      ? {
          warning:
            `${report.uncached.length} formula cell(s) have no saved result because CoWork ` +
            "cannot evaluate them (see formulas.uncached). They stay live and Excel calculates " +
            "them when the file is opened, but previews that do not recalculate show the formula.",
        }
      : {}),
  };
}
