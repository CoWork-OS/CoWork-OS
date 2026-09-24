import { describe, expect, it } from "vitest";
import { checkCsvArithmetic, CsvArithmeticVerifier } from "../csv-arithmetic-verifier";

const budget = (total = "135.00", posters = "21") =>
  `item,quantity,unit_cost,total\nBooks,12,8,96\nPosters,6,3.5,${posters}\nRefreshments,8,2.25,18\nTOTAL,,,${total}\n`;

describe("CSV arithmetic verification", () => {
  it("catches the observed saved grand-total error", () => {
    expect(checkCsvArithmetic(budget("135.50"))).toEqual([
      "TOTAL is 135.50; expected 135.00 from quantity × unit_cost.",
    ]);
  });

  it("checks both line products and the grand total independently", () => {
    expect(checkCsvArithmetic(budget("136.00", "22"))).toEqual([
      "Row 3 total is 22.00; expected 21.00 from quantity × unit_cost.",
      "TOTAL is 136.00; expected 135.00 from quantity × unit_cost.",
    ]);
  });

  it("accepts correct totals and decimal cents without floating-point drift", () => {
    expect(checkCsvArithmetic(budget())).toEqual([]);
    expect(
      checkCsvArithmetic(
        'item,quantity,unit_cost,total\r\n"Item, with ""quotes""",3,0.10,0.30\r\nTOTAL,,,0.30\r\n',
      ),
    ).toEqual([]);
  });

  it("accepts reordered columns, a BOM, and quoted newlines", () => {
    expect(
      checkCsvArithmetic(
        '\uFEFFtotal,item,unit cost,quantity\n0.30,"two\nlines",0.10,3\n0.30,Grand total,,',
      ),
    ).toEqual([]);
  });

  it.each([
    "item,quantity,unit_cost,total,tax\na,1,2,2,0\n",
    "item,quantity,unit_cost,total\na,1.5,2,3\n",
    "item,quantity,unit_cost,total\na,1,0.333,0.33\n",
    "item,quantity,unit_cost,total\na,1,2,=B2*C2\n",
    "item,quantity,unit_cost,total\na,1,2,2\nSubtotal,,,2\nTOTAL,,,2\n",
    "item,quantity,unit_cost,total\na,1,2,2\nTOTAL,,,2\nb,1,1,1\n",
    'item,quantity,unit_cost,total\n"unfinished,1,2,2',
    'item,quantity,unit_cost,total\n"a"extra,1,2,2',
  ])("skips unsupported or malformed data without inventing its semantics", (csv) => {
    expect(checkCsvArithmetic(csv)).toBeNull();
  });

  it("does not block completion for an unmodified source CSV", () => {
    const verifier = new CsvArithmeticVerifier("/workspace");
    verifier.recordRead("source.csv", budget("135.50"), false);
    expect(verifier.getWarning()).toBeNull();
  });

  it("requires a complete successful read after a correction, accepting absolute/relative aliases", () => {
    const verifier = new CsvArithmeticVerifier("/workspace");
    verifier.recordMutation("budget.csv");
    verifier.recordRead("/workspace/budget.csv", budget("135.50"), false);
    expect(verifier.getWarning()).toContain("expected 135.00");
    verifier.recordMutation("/workspace/budget.csv");
    verifier.recordRead("budget.csv", budget(), true);
    expect(verifier.getWarning()).toContain("Re-read");
    verifier.recordRead("budget.csv", budget(), false);
    expect(verifier.getWarning()).toBeNull();
  });

  it("does not keep blocking on a finding the saved file can no longer confirm", () => {
    const verifier = new CsvArithmeticVerifier("/workspace");
    verifier.recordMutation("budget.csv");
    verifier.recordRead("budget.csv", budget("135.50"), false);
    verifier.recordMutation("budget.csv");
    verifier.recordRead("budget.csv", `${budget()}\n\n`, false);
    expect(verifier.getWarning()).toBeNull();

    verifier.recordMutation("budget.csv");
    verifier.recordRead("budget.csv", budget("135.50"), false);
    verifier.recordMutation("budget.csv");
    verifier.recordRead("budget.csv", "unsupported format", false);
    expect(verifier.getWarning()).toBeNull();
  });

  it("follows renamed files and forgets deleted ones", () => {
    const verifier = new CsvArithmeticVerifier("/workspace");
    verifier.recordMutation("q1.csv");
    verifier.recordRead("q1.csv", budget("135.50"), false);
    verifier.recordRename("q1.csv", "q1_final.csv");
    verifier.recordMutation("q1_final.csv");
    verifier.recordRead("q1_final.csv", budget(), false);
    expect(verifier.getWarning()).toBeNull();

    verifier.recordMutation("q2.csv");
    verifier.recordRead("q2.csv", budget("135.50"), false);
    verifier.recordDeletion("q2.csv");
    expect(verifier.getWarning()).toBeNull();
  });
});
