import { describe, expect, it } from "vitest";
import type { SearchProviderInfo } from "../../../shared/types";
import { findClosingSearchProvider } from "../useClosingSearchProvider";

const brave: SearchProviderInfo = {
  type: "brave",
  name: "Brave Search",
  description: "Privacy-focused web, news, and image search",
  configured: true,
  supportedTypes: ["web"],
};
const google: SearchProviderInfo = {
  type: "google",
  name: "Google Custom Search",
  description: "Google's Custom Search JSON API (closed to new customers)",
  configured: true,
  supportedTypes: ["web", "images"],
  retirement: { endsOn: "2027-01-01", notice: "Ends 1 January 2027." },
};
const providers = [brave, google];

describe("findClosingSearchProvider (#914)", () => {
  it("finds Google when it is the primary provider", () => {
    expect(
      findClosingSearchProvider({ primaryProvider: "google", fallbackProvider: null, providers }),
    ).toBe(google);
  });

  it("finds Google when it is only the fallback", () => {
    expect(
      findClosingSearchProvider({
        primaryProvider: "brave",
        fallbackProvider: "google",
        providers,
      }),
    ).toBe(google);
  });

  it("ignores a saved Google key that search no longer uses", () => {
    expect(
      findClosingSearchProvider({ primaryProvider: "brave", fallbackProvider: null, providers }),
    ).toBeNull();
  });

  it("ignores a Google choice without a complete key", () => {
    expect(
      findClosingSearchProvider({
        primaryProvider: "google",
        fallbackProvider: null,
        providers: [brave, { ...google, configured: false }],
      }),
    ).toBeNull();
  });

  it("returns null without a status", () => {
    expect(findClosingSearchProvider(null)).toBeNull();
  });
});
