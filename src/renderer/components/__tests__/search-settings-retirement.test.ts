import { describe, expect, it } from "vitest";
import type { SearchProviderInfo } from "../../../shared/types";
import { formatEndDate, isProviderOffered } from "../SearchSettings";

const google: SearchProviderInfo = {
  type: "google",
  name: "Google Custom Search",
  description: "Google's Custom Search JSON API (closed to new customers)",
  configured: false,
  supportedTypes: ["web", "images"],
  retirement: { endsOn: "2027-01-01", notice: "Ends 1 January 2027." },
};

describe("Search settings for a closing provider (#914)", () => {
  it("hides a closing provider from new setups", () => {
    expect(isProviderOffered(google)).toBe(false);
  });

  it("keeps a closing provider for people who already set it up", () => {
    expect(isProviderOffered({ ...google, configured: true })).toBe(true);
  });

  it("keeps offering providers that are not closing", () => {
    expect(isProviderOffered({ ...google, type: "brave", retirement: undefined })).toBe(true);
  });

  it("formats the end date in plain English", () => {
    expect(formatEndDate("2027-01-01")).toBe("1 January 2027");
    expect(formatEndDate("not-a-date")).toBe("not-a-date");
  });
});
