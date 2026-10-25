import { describe, expect, it } from "vitest";
import {
  browserAppUrl,
  buildBrowserAppSignInUrl,
  readBrowserAppSignInCode,
} from "../browser-app-link";

const CODE = "Ab3_-xYz0123456789abcdefGHIJ";

describe("browser app sign-in links", () => {
  it("puts the code in the fragment of the app address", () => {
    const url = new URL(buildBrowserAppSignInUrl("https://mac.example.ts.net", CODE));
    expect(url.origin).toBe("https://mac.example.ts.net");
    expect(url.pathname).toBe("/app/");
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#pair=${CODE}`);
    expect(browserAppUrl("http://127.0.0.1:3847")).toBe("http://127.0.0.1:3847/app/");
  });

  it("reads the code back and ignores anything that is not one", () => {
    expect(readBrowserAppSignInCode(`#pair=${CODE}`)).toBe(CODE);
    expect(readBrowserAppSignInCode(`pair=${CODE}&view=tasks`)).toBe(CODE);
    expect(readBrowserAppSignInCode("")).toBeNull();
    expect(readBrowserAppSignInCode("#view=tasks")).toBeNull();
    expect(readBrowserAppSignInCode("#pair=short")).toBeNull();
    expect(readBrowserAppSignInCode("#pair=has spaces in it but long enough")).toBeNull();
    expect(readBrowserAppSignInCode(`#pair=${CODE}"><script>`)).toBeNull();
  });

  it("refuses to build a link around a malformed code", () => {
    expect(() => buildBrowserAppSignInUrl("http://127.0.0.1:3847", "bad code")).toThrow();
  });
});
