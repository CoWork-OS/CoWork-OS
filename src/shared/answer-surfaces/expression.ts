/**
 * A small, bounded expression language for interactive answer surfaces.
 *
 * Model-written formulas (shopping quantities, savings growth, split totals) run in the
 * renderer on every control change, so they never go through `eval` or `new Function`.
 * The grammar covers arithmetic, comparisons, boolean logic, a ternary and a fixed set
 * of numeric functions; identifiers read the surface's control values.
 */

export type ExpressionValue = number | string | boolean;
export type ExpressionScope = Readonly<Record<string, ExpressionValue>>;

type Node =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "ident"; name: string }
  | { kind: "unary"; op: "-" | "+" | "!"; arg: Node }
  | { kind: "binary"; op: string; left: Node; right: Node }
  | { kind: "ternary"; test: Node; whenTrue: Node; whenFalse: Node }
  | { kind: "call"; name: string; args: Node[] };

type Token =
  | { type: "num"; value: number }
  | { type: "str"; value: string }
  | { type: "ident"; value: string }
  | { type: "op"; value: string };

export const MAX_EXPRESSION_LENGTH = 400;
const MAX_TOKENS = 200;
const MAX_DEPTH = 32;
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OPERATORS = [
  "&&",
  "||",
  "==",
  "!=",
  "<=",
  ">=",
  "+",
  "-",
  "*",
  "/",
  "%",
  "^",
  "<",
  ">",
  "!",
  "?",
  ":",
  "(",
  ")",
  ",",
];

const FUNCTIONS: Record<string, { min: number; max: number; fn: (...args: number[]) => number }> = {
  min: { min: 1, max: 20, fn: (...args) => Math.min(...args) },
  max: { min: 1, max: 20, fn: (...args) => Math.max(...args) },
  abs: { min: 1, max: 1, fn: Math.abs },
  sqrt: { min: 1, max: 1, fn: Math.sqrt },
  pow: { min: 2, max: 2, fn: Math.pow },
  exp: { min: 1, max: 1, fn: Math.exp },
  log: { min: 1, max: 1, fn: Math.log },
  log10: { min: 1, max: 1, fn: Math.log10 },
  floor: { min: 1, max: 1, fn: Math.floor },
  ceil: { min: 1, max: 1, fn: Math.ceil },
  round: {
    min: 1,
    max: 2,
    fn: (value, decimals = 0) => roundTo(value, decimals),
  },
  clamp: { min: 3, max: 3, fn: (value, lo, hi) => Math.min(Math.max(value, lo), hi) },
};

export class ExpressionError extends Error {}

function roundTo(value: number, decimals: number): number {
  const places = Math.max(0, Math.min(10, Math.trunc(decimals)));
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (/[0-9.]/.test(char)) {
      const match = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(index));
      if (!match) throw new ExpressionError(`Unexpected "${char}"`);
      tokens.push({ type: "num", value: Number(match[0]) });
      index += match[0].length;
    } else if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(index));
      tokens.push({ type: "ident", value: match![0] });
      index += match![0].length;
    } else if (char === '"' || char === "'") {
      const end = source.indexOf(char, index + 1);
      if (end < 0) throw new ExpressionError("Unterminated string");
      tokens.push({ type: "str", value: source.slice(index + 1, end) });
      index = end + 1;
    } else {
      const op = OPERATORS.find((candidate) => source.startsWith(candidate, index));
      if (!op) throw new ExpressionError(`Unexpected "${char}"`);
      tokens.push({ type: "op", value: op });
      index += op.length;
    }
    if (tokens.length > MAX_TOKENS) throw new ExpressionError("Expression is too long");
  }
  return tokens;
}

class Parser {
  private position = 0;
  private depth = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    const node = this.ternary();
    if (this.position < this.tokens.length) throw new ExpressionError("Unexpected trailing input");
    return node;
  }

  private peekOp(...ops: string[]): string | null {
    const token = this.tokens[this.position];
    return token?.type === "op" && ops.includes(token.value) ? token.value : null;
  }

  private expectOp(op: string): void {
    if (!this.peekOp(op)) throw new ExpressionError(`Expected "${op}"`);
    this.position += 1;
  }

  private enter(): void {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) throw new ExpressionError("Expression is nested too deeply");
  }

  private ternary(): Node {
    this.enter();
    const test = this.binary(0);
    if (this.peekOp("?")) {
      this.position += 1;
      const whenTrue = this.ternary();
      this.expectOp(":");
      const whenFalse = this.ternary();
      this.depth -= 1;
      return { kind: "ternary", test, whenTrue, whenFalse };
    }
    this.depth -= 1;
    return test;
  }

  private static readonly LEVELS: string[][] = [
    ["||"],
    ["&&"],
    ["==", "!="],
    ["<", "<=", ">", ">="],
    ["+", "-"],
    ["*", "/", "%"],
  ];

  private binary(level: number): Node {
    if (level >= Parser.LEVELS.length) return this.power();
    let left = this.binary(level + 1);
    let op: string | null;
    while ((op = this.peekOp(...Parser.LEVELS[level]))) {
      this.position += 1;
      const right = this.binary(level + 1);
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  private power(): Node {
    const base = this.unary();
    if (this.peekOp("^")) {
      this.position += 1;
      this.enter();
      const exponent = this.power();
      this.depth -= 1;
      return { kind: "binary", op: "^", left: base, right: exponent };
    }
    return base;
  }

  private unary(): Node {
    const op = this.peekOp("-", "+", "!");
    if (op) {
      this.position += 1;
      this.enter();
      const arg = this.unary();
      this.depth -= 1;
      return { kind: "unary", op: op as "-" | "+" | "!", arg };
    }
    return this.primary();
  }

  private primary(): Node {
    const token = this.tokens[this.position];
    if (!token) throw new ExpressionError("Unexpected end of expression");
    this.position += 1;
    if (token.type === "num") return { kind: "num", value: token.value };
    if (token.type === "str") return { kind: "str", value: token.value };
    if (token.type === "ident") {
      if (token.value === "true" || token.value === "false") {
        return { kind: "bool", value: token.value === "true" };
      }
      if (this.peekOp("(")) {
        this.position += 1;
        const args: Node[] = [];
        if (!this.peekOp(")")) {
          args.push(this.ternary());
          while (this.peekOp(",")) {
            this.position += 1;
            args.push(this.ternary());
          }
        }
        this.expectOp(")");
        const fn = FUNCTIONS[token.value];
        if (!fn) throw new ExpressionError(`Unknown function "${token.value}"`);
        if (args.length < fn.min || args.length > fn.max) {
          throw new ExpressionError(`Wrong number of arguments for "${token.value}"`);
        }
        return { kind: "call", name: token.value, args };
      }
      return { kind: "ident", name: token.value };
    }
    if (token.value === "(") {
      const inner = this.ternary();
      this.expectOp(")");
      return inner;
    }
    throw new ExpressionError(`Unexpected "${token.value}"`);
  }
}

const compiled = new Map<string, Node | ExpressionError>();
const MAX_COMPILED = 500;

/** Parses once per distinct source; parse errors are cached too. */
export function compileExpression(source: string): Node {
  const cached = compiled.get(source);
  if (cached instanceof ExpressionError) throw cached;
  if (cached) return cached;
  let result: Node | ExpressionError;
  if (source.length > MAX_EXPRESSION_LENGTH) {
    result = new ExpressionError("Expression is too long");
  } else {
    try {
      result = new Parser(tokenize(source)).parse();
    } catch (error) {
      result = error instanceof ExpressionError ? error : new ExpressionError("Invalid expression");
    }
  }
  if (compiled.size >= MAX_COMPILED) compiled.clear();
  compiled.set(source, result);
  if (result instanceof ExpressionError) throw result;
  return result;
}

function toNumber(value: ExpressionValue): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new ExpressionError(`"${value}" is not a number`);
  return parsed;
}

function truthy(value: ExpressionValue): boolean {
  return typeof value === "string" ? value.length > 0 : Boolean(value);
}

function evaluateNode(node: Node, scope: ExpressionScope): ExpressionValue {
  switch (node.kind) {
    case "num":
    case "str":
    case "bool":
      return node.value;
    case "ident": {
      if (!Object.prototype.hasOwnProperty.call(scope, node.name)) {
        throw new ExpressionError(`Unknown value "${node.name}"`);
      }
      return scope[node.name];
    }
    case "unary": {
      const arg = evaluateNode(node.arg, scope);
      if (node.op === "!") return !truthy(arg);
      return node.op === "-" ? -toNumber(arg) : toNumber(arg);
    }
    case "ternary":
      return truthy(evaluateNode(node.test, scope))
        ? evaluateNode(node.whenTrue, scope)
        : evaluateNode(node.whenFalse, scope);
    case "call":
      return FUNCTIONS[node.name].fn(...node.args.map((arg) => toNumber(evaluateNode(arg, scope))));
    case "binary": {
      if (node.op === "&&") {
        return truthy(evaluateNode(node.left, scope)) && truthy(evaluateNode(node.right, scope));
      }
      if (node.op === "||") {
        return truthy(evaluateNode(node.left, scope)) || truthy(evaluateNode(node.right, scope));
      }
      const left = evaluateNode(node.left, scope);
      const right = evaluateNode(node.right, scope);
      if (node.op === "==" || node.op === "!=") {
        const equal =
          typeof left === "string" || typeof right === "string"
            ? String(left) === String(right)
            : toNumber(left) === toNumber(right);
        return node.op === "==" ? equal : !equal;
      }
      const a = toNumber(left);
      const b = toNumber(right);
      switch (node.op) {
        case "+":
          return a + b;
        case "-":
          return a - b;
        case "*":
          return a * b;
        case "/":
          return a / b;
        case "%":
          return a % b;
        case "^":
          return a ** b;
        case "<":
          return a < b;
        case "<=":
          return a <= b;
        case ">":
          return a > b;
        case ">=":
          return a >= b;
      }
    }
  }
  throw new ExpressionError("Invalid expression");
}

/** Evaluates `source` against `scope`. Returns null when the formula is invalid or not finite. */
export function evaluateExpression(source: string, scope: ExpressionScope): ExpressionValue | null {
  try {
    const value = evaluateNode(compileExpression(source), scope);
    if (typeof value === "number" && !Number.isFinite(value)) return null;
    return value;
  } catch {
    return null;
  }
}

/** The identifiers a formula reads, for validating that every one is a declared control. */
export function expressionIdentifiers(source: string): string[] {
  const names = new Set<string>();
  const visit = (node: Node) => {
    switch (node.kind) {
      case "ident":
        names.add(node.name);
        return;
      case "unary":
        visit(node.arg);
        return;
      case "binary":
        visit(node.left);
        visit(node.right);
        return;
      case "ternary":
        visit(node.test);
        visit(node.whenTrue);
        visit(node.whenFalse);
        return;
      case "call":
        node.args.forEach(visit);
        return;
      default:
        return;
    }
  };
  visit(compileExpression(source));
  return [...names];
}

export function isValidIdentifier(value: string): boolean {
  return IDENTIFIER_PATTERN.test(value) && value !== "true" && value !== "false";
}

export { roundTo };
