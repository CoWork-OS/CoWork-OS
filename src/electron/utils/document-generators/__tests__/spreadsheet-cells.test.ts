import { describe, expect, it } from "vitest";
import { isDateNumberFormat, parseSpreadsheetDateText } from "../spreadsheet-cells";

describe("isDateNumberFormat", () => {
  it("recognises date codes and ignores literal text and number formats", () => {
    for (const code of ["DD/MM/YYYY", "yyyy-mm-dd", "mm-dd-yy", "d mmmm yyyy", "[$-409]d-mmm-yy"]) {
      expect(isDateNumberFormat(code)).toBe(true);
    }
    for (const code of ["General", "@", "0%", "€#,##0.00", '#,##0 "days"', "0.00\\d", "", null]) {
      expect(isDateNumberFormat(code)).toBe(false);
    }
  });
});

describe("parseSpreadsheetDateText", () => {
  it("reads ISO dates and date-times at UTC", () => {
    expect(parseSpreadsheetDateText("2026-10-05")).toEqual({
      date: new Date(Date.UTC(2026, 9, 5)),
      precision: "date",
    });
    expect(parseSpreadsheetDateText("2026-10-05T09:30:15.250Z")).toEqual({
      date: new Date(Date.UTC(2026, 9, 5, 9, 30, 15, 250)),
      precision: "seconds",
    });
    expect(parseSpreadsheetDateText(" 2026-10-05 09:30 ")?.precision).toBe("minutes");
  });

  it("leaves ids, impossible dates and ambiguous text alone", () => {
    for (const text of [
      "00041",
      "CR-0041",
      "2026-02-30",
      "2026-13-01",
      "1899-12-31",
      "2026-10-05T25:00",
      "2026-10-05+02:00",
      "2026-10-05Z",
      "20261005",
      "Oct 5 2026",
      "05/10/2026",
    ]) {
      expect(parseSpreadsheetDateText(text)).toBeNull();
    }
  });

  it("reads day/month text only in the order of a date format", () => {
    expect(parseSpreadsheetDateText("05/10/2026", "DD/MM/YYYY")?.date).toEqual(
      new Date(Date.UTC(2026, 9, 5)),
    );
    expect(parseSpreadsheetDateText("10/05/2026", "mm/dd/yyyy")?.date).toEqual(
      new Date(Date.UTC(2026, 9, 5)),
    );
    expect(parseSpreadsheetDateText("5.10.2026", "d.m.yyyy")?.date).toEqual(
      new Date(Date.UTC(2026, 9, 5)),
    );
    expect(parseSpreadsheetDateText("2026/10/05", "dd/mm/yyyy")?.date).toEqual(
      new Date(Date.UTC(2026, 9, 5)),
    );
    expect(parseSpreadsheetDateText("13/13/2026", "dd/mm/yyyy")).toBeNull();
    expect(parseSpreadsheetDateText("05/10/2026", "€#,##0.00")).toBeNull();
    expect(parseSpreadsheetDateText("05/10-2026", "dd/mm/yyyy")).toBeNull();
  });
});
