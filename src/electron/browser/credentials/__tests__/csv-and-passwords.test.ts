import { describe, expect, it } from "vitest";
import { CsvError, decodeCsvBytes, MAX_FIELD_CHARS, parseCsv } from "../csv";
import { loginOriginFor } from "../login-origin";
import { parsePasswordCsv } from "../password-csv";

describe("parseCsv", () => {
  it("handles quotes, embedded commas, newlines and doubled quotes", () => {
    expect(parseCsv('a,b\n"x,1","he said ""hi"""\n"l1\nl2",z\n')).toEqual([
      ["a", "b"],
      ["x,1", 'he said "hi"'],
      ["l1\nl2", "z"],
    ]);
  });
  it("rejects binary, invalid UTF-8 and oversize fields", () => {
    expect(() => decodeCsvBytes(Buffer.from([0x61, 0x00]))).toThrow(CsvError);
    expect(() => decodeCsvBytes(Buffer.from([0xff, 0xfe, 0x41]))).toThrow(CsvError);
    expect(() => parseCsv(`a\n${"x".repeat(MAX_FIELD_CHARS + 1)}`)).toThrow(CsvError);
  });
  it("rejects an unterminated quote", () => {
    expect(() => parseCsv('a\n"oops')).toThrow(CsvError);
  });
});

describe("loginOriginFor", () => {
  it("accepts https and loopback http only", () => {
    expect(loginOriginFor("https://Example.com/login?x=1")).toBe("https://example.com");
    expect(loginOriginFor("http://localhost:3000/x")).toBe("http://localhost:3000");
    expect(loginOriginFor("http://example.com")).toBeNull();
    expect(loginOriginFor("https://user:pw@example.com")).toBeNull();
    expect(loginOriginFor("chrome://settings")).toBeNull();
    expect(loginOriginFor("javascript:alert(1)")).toBeNull();
  });
});

describe("parsePasswordCsv", () => {
  it("reads Chrome, Bitwarden and Firefox column names and counts skips", () => {
    const chrome = parsePasswordCsv(
      "name,url,username,password\nA,https://a.example/login,me,pw1\nB,http://b.example,me,pw2\nC,https://c.example,me,\n",
    );
    expect(chrome.logins).toEqual([
      { origin: "https://a.example", username: "me", password: "pw1" },
    ]);
    expect(chrome.skipped).toMatchObject({ not_a_web_login: 1, no_password: 1 });

    const bitwarden = parsePasswordCsv(
      "folder,login_uri,login_username,login_password\n,https://d.example,u,p\n",
    );
    expect(bitwarden.logins[0]).toMatchObject({ origin: "https://d.example", password: "p" });

    const firefox = parsePasswordCsv('"url","username","password"\n"https://e.example","u","p"\n');
    expect(firefox.logins).toHaveLength(1);
  });
  it("keeps the later row for a duplicate site and user", () => {
    const parsed = parsePasswordCsv(
      "url,username,password\nhttps://a.example,me,old\nhttps://a.example,me,new\n",
    );
    expect(parsed.logins).toEqual([
      { origin: "https://a.example", username: "me", password: "new" },
    ]);
    expect(parsed.skipped.duplicate).toBe(1);
  });
  it("refuses a file without the needed columns", () => {
    expect(() => parsePasswordCsv("a,b\n1,2\n")).toThrow();
  });
});
