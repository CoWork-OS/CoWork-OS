import { describe, expect, it } from "vitest";
import { CsvReportEvidenceVerifier } from "../data-evidence-verifier";

const sourceCsv = [
  "order_id,region,amount,units",
  "A101,Lisbon,10.00,2",
  "A102,Lisbon,5.00,1",
  "A103,Porto,7.50,3",
].join("\n");

function createVerifier(content = sourceCsv, truncated = false) {
  const verifier = new CsvReportEvidenceVerifier("/workspace");
  verifier.recordRead("orders.csv", content, truncated);
  return verifier;
}

describe("CsvReportEvidenceVerifier", () => {
  it("blocks invented dates, currency, revenue, margins, and unrequested recommendations", () => {
    const verifier = createVerifier();
    const issues = verifier.validateMarkdownWrite({
      filePath: "daily-orders-summary.md",
      requestText: "Read orders.csv and create daily-orders-summary.md.",
      content: [
        "# Daily Orders Summary",
        "| Day | Total Revenue | Value |",
        "| Day 1 | €33.00 |",
        "Porto has lower margins.",
        "## Recommendations",
      ].join("\n"),
    });

    expect(issues).toHaveLength(5);
    expect(issues.join("\n")).toContain("no date column");
    expect(issues.join("\n")).toContain("do not specify a currency");
    expect(issues.join("\n")).toContain("generic amount field");
    expect(issues.join("\n")).toContain("no cost or profit fields");
    expect(issues.join("\n")).toContain("not recommendations");
  });

  it("allows a source-bound aggregate that discloses missing date and currency fields", () => {
    const verifier = createVerifier();
    const issues = verifier.validateMarkdownWrite({
      filePath: "daily-orders-summary.md",
      requestText: "Read orders.csv and create daily-orders-summary.md.",
      content: [
        "# Daily Orders Summary",
        "Total amount: 22.50 (currency unspecified).",
        "The source has no date column, so daily grouping is unavailable.",
        "The aggregate includes 3 orders and 6 units.",
      ].join("\n"),
    });

    expect(issues).toEqual([]);
  });

  it("provides deterministic totals and missing-value groups after a complete source read", () => {
    const verifier = createVerifier(
      [
        "order_id,region,amount,units",
        "A101,Lisbon,10.00,2",
        "A102,Lisbon,5.00,1",
        "A103,Porto,7.50,3",
        "A104,Porto,3.00,2",
        "A105,,7.50,5",
      ].join("\n"),
    );
    const summary = verifier.getEvidenceSummary("Read orders.csv and summarize it.");

    expect(summary).toContain("5 data rows; sum(amount)=33.00; sum(units)=13");
    expect(summary).toContain("Lisbon (2 rows, amount=15.00, units=3)");
    expect(summary).toContain("Porto (2 rows, amount=10.50, units=5)");
    expect(summary).toContain("Unspecified (1 rows, amount=7.50, units=5)");
  });

  it("does not infer daily grouping from a daily filename alone", () => {
    const verifier = createVerifier();
    const issues = verifier.validateMarkdownWrite({
      filePath: "daily-orders-summary.md",
      requestText: "Read orders.csv and create daily-orders-summary.md.",
      content: [
        "# Regional Orders Summary",
        "| Region | Total Amount | Units Sold | Order Count |",
        "| --- | ---: | ---: | ---: |",
        "| Lisbon | 15.00 | 3 | 2 |",
        "| Porto | 7.50 | 3 | 1 |",
        "- Total Amount: 22.50",
        "- Total Units Sold: 6",
        "- Total Orders: 3",
      ].join("\n"),
    });

    expect(issues).toEqual([]);
  });

  it("still requires a date limitation when daily grouping is explicitly requested", () => {
    const verifier = createVerifier();
    const issues = verifier.validateMarkdownWrite({
      filePath: "daily-orders-summary.md",
      requestText: "Create a daily summary from orders.csv.",
      content: "# Orders Summary\n- Total Orders: 3",
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("State that daily grouping is unavailable");
  });

  it("blocks incorrect source totals and grouped metrics before the report is written", () => {
    const verifier = createVerifier(
      [
        "order_id,region,amount,units",
        "A101,Lisbon,10.00,2",
        "A102,Lisbon,5.00,1",
        "A103,Porto,7.50,3",
        "A104,Porto,3.00,2",
        "A105,,7.50,5",
      ].join("\n"),
    );
    const issues = verifier.validateMarkdownWrite({
      filePath: "orders-summary.md",
      requestText: "Summarize orders.csv by region.",
      content: [
        "# Orders Summary",
        "- Total Orders: 5",
        "- Combined Amount: 33.00",
        "- Total Units: 13",
        "| Region | Orders | Amount | Units |",
        "| --- | ---: | ---: | ---: |",
        "| Lisbon | 3 | 20.00 | 8 |",
        "| Porto | 1 | 10.00 | 3 |",
        "| Unspecified | 1 | 3.00 | 2 |",
      ].join("\n"),
    });

    expect(issues).toHaveLength(8);
    expect(issues.join("\n")).toContain("Lisbon has 2 source rows");
    expect(issues.join("\n")).toContain("Lisbon amount totals 15");
    expect(issues.join("\n")).toContain("Lisbon units total 3");
    expect(issues.join("\n")).toContain("Porto has 2 source rows");
    expect(issues.join("\n")).toContain("Porto amount totals 10.5");
    expect(issues.join("\n")).toContain("Porto units total 5");
    expect(issues.join("\n")).toContain("Unspecified amount totals 7.5");
    expect(issues.join("\n")).toContain("Unspecified units total 5");
  });

  it("allows correct regional metrics and quoted CSV fields containing commas", () => {
    const verifier = createVerifier(
      [
        "order_id,region,amount,units",
        'A101,"New York, NY",1,2',
        'A102,"New York, NY",2,1',
        "A103,Porto,3,4",
      ].join("\n"),
    );
    const issues = verifier.validateMarkdownWrite({
      filePath: "orders-summary.md",
      requestText: "Summarize orders.csv by region.",
      content: [
        "# Orders Summary",
        "- Total Orders: 3",
        "- Combined Amount: 6",
        "- Total Units: 7",
        "| Region | Orders | Amount | Units |",
        "| --- | ---: | ---: | ---: |",
        "| New York, NY | 2 | 3 | 3 |",
        "| Porto | 1 | 3 | 4 |",
      ].join("\n"),
    });

    expect(issues).toEqual([]);
  });

  it("accepts common total-column headings and a descriptive missing-group label", () => {
    const verifier = createVerifier(
      [
        "order_id,region,amount,units",
        "A101,Lisbon,10.00,2",
        "A102,Lisbon,5.00,1",
        "A103,Porto,7.50,3",
        "A104,Porto,3.00,2",
        "A105,,7.50,5",
      ].join("\n"),
    );
    const issues = verifier.validateMarkdownWrite({
      filePath: "daily-orders-summary.md",
      requestText: "Create an order summary by region from orders.csv.",
      content: [
        "# Daily Orders Summary",
        "| Region | Total Amount | Units Sold | Order Count |",
        "| --- | ---: | ---: | ---: |",
        "| Lisbon | 15.00 | 3 | 2 |",
        "| Porto | 10.50 | 5 | 2 |",
        "| (No region specified) | 7.50 | 5 | 1 |",
        "| Total | 33.00 | 13 | 5 |",
        "- Grand Total Amount: 33.00",
        "- Total Units Sold: 13",
        "- Total Orders: 5",
      ].join("\n"),
    });

    expect(issues).toEqual([]);
  });

  it("blocks an incorrect aggregate row in a regional table", () => {
    const verifier = createVerifier(
      [
        "order_id,region,amount,units",
        "A101,Lisbon,10.00,2",
        "A102,Lisbon,5.00,1",
        "A103,Porto,7.50,3",
        "A104,Porto,3.00,2",
        "A105,,7.50,5",
      ].join("\n"),
    );
    const issues = verifier.validateMarkdownWrite({
      filePath: "orders-summary.md",
      requestText: "Create a regional order summary from orders.csv.",
      content: [
        "| Region | Total Amount | Units Sold | Order Count |",
        "| --- | ---: | ---: | ---: |",
        "| Lisbon | 15.00 | 3 | 2 |",
        "| Porto | 10.50 | 5 | 2 |",
        "| Unspecified | 7.50 | 5 | 1 |",
        "| Total | 30.00 | 13 | 5 |",
      ].join("\n"),
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("The total row amount is 33");
  });

  it("allows daily revenue when the source explicitly supplies date, revenue, and currency", () => {
    const verifier = createVerifier(
      ["date,region,revenue,currency,units", "2026-09-22,Lisbon,10.00,EUR,2"].join("\n"),
    );
    const issues = verifier.validateMarkdownWrite({
      filePath: "daily-orders-summary.md",
      requestText: "Create a daily revenue summary in EUR from orders.csv.",
      content: [
        "# Daily Revenue Summary",
        "| Date | Total Revenue (EUR) |",
        "| 2026-09-22 | 10.00 EUR |",
      ].join("\n"),
    });

    expect(issues).toEqual([]);
  });

  it("skips validation when the source CSV read was truncated", () => {
    const verifier = createVerifier(sourceCsv, true);
    const issues = verifier.validateMarkdownWrite({
      filePath: "daily-orders-summary.md",
      requestText: "Create a daily summary from orders.csv.",
      content: "Day 1 revenue is €10.00.",
    });

    expect(issues).toEqual([]);
  });
});
