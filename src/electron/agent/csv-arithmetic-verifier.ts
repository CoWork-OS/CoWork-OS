import path from "node:path";

// Deliberately narrow: an item/quantity/unit_cost/total table with an optional
// final TOTAL row. Tax, discounts, formulas, subtotals and rounding policies
// need an explicit schema and are not inferred here.
export function checkCsvArithmetic(content: string): string[] | null {
  if (content.length > 100_000) return null;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (quoted) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else field += ch;
    } else if (ch === "," || ch === "\n" || ch === "\r") {
      row.push(field);
      field = "";
      closedQuote = false;
      if (ch !== ",") {
        if (ch === "\r" && content[i + 1] === "\n") i++;
        rows.push(row);
        row = [];
      }
    } else if (ch === '"' && !field && !closedQuote) quoted = true;
    else {
      if (closedQuote || ch === '"') return null;
      field += ch;
    }
  }
  if (quoted) return null;
  if (field || row.length || closedQuote) rows.push([...row, field]);
  // Trailing blank lines are not data rows.
  while (rows.length && rows[rows.length - 1].every((cell) => !cell.trim())) rows.pop();
  if (rows.length < 2 || rows.length > 1_000) return null;
  const header = rows[0].map((cell) =>
    cell
      .replace(/^\uFEFF/, "")
      .trim()
      .toLowerCase()
      .replace(/ /g, "_"),
  );
  if (
    header.length !== 4 ||
    new Set(header).size !== 4 ||
    !["item", "quantity", "unit_cost", "total"].every((name) => header.includes(name))
  )
    return null;
  const [item, quantity, cost, total] = ["item", "quantity", "unit_cost", "total"].map((name) =>
    header.indexOf(name),
  );
  const cents = (value: string): bigint | null => {
    if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(value)) return null;
    const [whole, fraction = ""] = value.split(".");
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  };
  const money = (value: bigint) => `${value / 100n}.${String(value % 100n).padStart(2, "0")}`;
  const errors: string[] = [];
  let sum = 0n;
  for (let index = 1; index < rows.length; index++) {
    const cells = rows[index].map((cell) => cell.trim());
    if (cells.length !== 4 || !cells[item]) return null;
    const actual = cents(cells[total]);
    if (actual === null) return null;
    if (/^(?:grand[ _])?total$/i.test(cells[item])) {
      if (index !== rows.length - 1 || index === 1 || cells[quantity] || cells[cost]) return null;
      if (actual !== sum)
        errors.push(`TOTAL is ${money(actual)}; expected ${money(sum)} from quantity × unit_cost.`);
    } else {
      if (!/^\d{1,12}$/.test(cells[quantity])) return null;
      const unitCost = cents(cells[cost]);
      if (unitCost === null) return null;
      const expected = BigInt(cells[quantity]) * unitCost;
      sum += expected;
      if (actual !== expected)
        errors.push(
          `Row ${index + 1} total is ${money(actual)}; expected ${money(expected)} from quantity × unit_cost.`,
        );
    }
  }
  return errors;
}

/** Uses only successful, already-authorized file tool results; performs no I/O. */
export class CsvArithmeticVerifier {
  private touched = new Set<string>();
  private findings = new Map<string, string[]>();

  constructor(private workspacePath: string) {}

  recordMutation(filePath: string): void {
    if (!/\.csv$/i.test(filePath)) return;
    const key = path.resolve(this.workspacePath, filePath);
    this.touched.add(key);
    if (this.findings.has(key)) {
      this.findings.set(key, ["Re-read the complete saved CSV to verify the correction."]);
    }
  }

  recordRead(filePath: string, content: string, truncated: boolean): void {
    const key = path.resolve(this.workspacePath, filePath);
    if (!this.touched.has(key) || truncated) return;
    const errors = checkCsvArithmetic(content);
    // A saved file outside the narrow schema can't be judged here; don't keep
    // blocking completion on a finding it can no longer confirm.
    if (errors === null || errors.length === 0) this.findings.delete(key);
    else this.findings.set(key, errors);
  }

  recordRename(oldPath: string, newPath: string): void {
    const oldKey = path.resolve(this.workspacePath, oldPath);
    const newKey = path.resolve(this.workspacePath, newPath);
    const findings = this.findings.get(oldKey);
    this.findings.delete(oldKey);
    if (this.touched.delete(oldKey)) this.touched.add(newKey);
    if (findings && /\.csv$/i.test(newPath)) {
      this.touched.add(newKey);
      this.findings.set(newKey, findings);
    }
  }

  recordDeletion(filePath: string): void {
    const key = path.resolve(this.workspacePath, filePath);
    this.findings.delete(key);
    this.touched.delete(key);
  }

  getWarning(): string | null {
    if (!this.findings.size) return null;
    const details = [...this.findings]
      .slice(0, 5)
      .map(
        ([filePath, errors]) =>
          `${JSON.stringify(path.relative(this.workspacePath, filePath))}: ${errors.slice(0, 5).join(" ")}`,
      );
    return `CSV arithmetic verification failed. ${details.join(" ")} Correct the arithmetic and read the saved file again before claiming verification is complete.`;
  }
}
