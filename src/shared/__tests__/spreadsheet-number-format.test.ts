import { describe, expect, it } from "vitest";

import { formatSpreadsheetValue } from "../spreadsheet-number-format";

const EURO = "€#,##0.00;[Red]-€#,##0.00";
const OCT_1_2026 = new Date(Date.UTC(2026, 9, 1));

describe("formatSpreadsheetValue", () => {
  it("renders the euro format saved by the repaired budget workbook", () => {
    expect(
      [150, 96.5, 45, 28.75, 320.25].map((value) => formatSpreadsheetValue(value, EURO)),
    ).toEqual(["€150.00", "€96.50", "€45.00", "€28.75", "€320.25"]);
    expect(formatSpreadsheetValue(-30, EURO)).toBe("-€30.00");
    expect(formatSpreadsheetValue(0, EURO)).toBe("€0.00");
    expect(formatSpreadsheetValue(1234567.891, EURO)).toBe("€1,234,567.89");
  });

  it("handles currency literals, sections and grouping", () => {
    expect(formatSpreadsheetValue(-30, "€#,##0.00")).toBe("-€30.00");
    expect(formatSpreadsheetValue(1234.5, "$#,##0.00")).toBe("$1,234.50");
    expect(formatSpreadsheetValue(1234.5, "[$€-816]#,##0.00")).toBe("€1,234.50");
    expect(formatSpreadsheetValue(1234.5, '#,##0.00 "EUR"')).toBe("1,234.50 EUR");
    expect(formatSpreadsheetValue(1234.5, "#,##0.00\\ [$€-1]")).toBe("1,234.50 €");
    expect(formatSpreadsheetValue(-1234.5, "#,##0.00;(#,##0.00)")).toBe("(1,234.50)");
    expect(formatSpreadsheetValue(0, '#,##0.00;-#,##0.00;"-"')).toBe("-");
    expect(formatSpreadsheetValue(1234567, "#,##0")).toBe("1,234,567");
    expect(formatSpreadsheetValue(1234567, '#,##0,"K"')).toBe("1,235K");
  });

  it("rounds decimals the way Excel does and trims optional digits", () => {
    expect(formatSpreadsheetValue(1.005, "0.00")).toBe("1.01");
    expect(formatSpreadsheetValue(2.5, "0.00")).toBe("2.50");
    expect(formatSpreadsheetValue(3.1, "#,##0.##")).toBe("3.1");
  });

  it("formats percentages", () => {
    expect(formatSpreadsheetValue(0.125, "0%")).toBe("13%");
    expect(formatSpreadsheetValue(0.1234, "0.0%")).toBe("12.3%");
  });

  it("formats dates and times from Date values and serial numbers", () => {
    expect(formatSpreadsheetValue(OCT_1_2026, "yyyy-mm-dd")).toBe("2026-10-01");
    expect(formatSpreadsheetValue(46296, "m/d/yy")).toBe("10/1/26");
    expect(formatSpreadsheetValue(OCT_1_2026, "d-mmm-yy")).toBe("1-Oct-26");
    expect(formatSpreadsheetValue(OCT_1_2026, "d.m.yyyy")).toBe("1.10.2026");
    expect(formatSpreadsheetValue(OCT_1_2026, "dddd, mmmm d")).toBe("Thursday, October 1");
    expect(formatSpreadsheetValue(new Date(Date.UTC(2026, 9, 1, 14, 5, 9)), "h:mm:ss AM/PM")).toBe(
      "2:05:09 PM",
    );
    expect(formatSpreadsheetValue(new Date(Date.UTC(2026, 9, 1, 14, 5)), "m/d/yy h:mm")).toBe(
      "10/1/26 14:05",
    );
    // ExcelJS reports built-in format 14 (the locale short date) as "mm-dd-yy".
    expect(formatSpreadsheetValue(OCT_1_2026, "mm-dd-yy")).toBe("10/1/2026");
    expect(formatSpreadsheetValue(45201, "yyyy-mm-dd", { date1904: true })).toBe("2027-10-03");
  });

  it("returns null for General, text values and unsupported codes", () => {
    expect(formatSpreadsheetValue(0.1 + 0.2, "General")).toBeNull();
    expect(formatSpreadsheetValue(5, undefined)).toBeNull();
    expect(formatSpreadsheetValue("abc", EURO)).toBeNull();
    expect(formatSpreadsheetValue(true, "0.00")).toBeNull();
    expect(formatSpreadsheetValue(5, "[>100]0;0.00")).toBeNull();
    expect(formatSpreadsheetValue(12345, "0.00E+00")).toBeNull();
    expect(formatSpreadsheetValue(0.5, "# ?/?")).toBeNull();
    expect(formatSpreadsheetValue(1.5, "[h]:mm")).toBeNull();
  });

  it("applies the text section to text values", () => {
    expect(formatSpreadsheetValue("abc", '0.00;-0.00;0;"Item: "@')).toBe("Item: abc");
  });
});
