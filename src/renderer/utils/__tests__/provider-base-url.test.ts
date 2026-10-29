import { describe, expect, it } from "vitest";
import { providerBaseUrlProblem } from "../provider-base-url";

describe("providerBaseUrlProblem", () => {
  it.each(["", "  ", "http://localhost:1234/v1", "https://api.example.com/v1"])(
    "accepts %j",
    (value) => {
      expect(providerBaseUrlProblem("Gateway", value)).toBeNull();
    },
  );

  it.each(["not a url", "localhost:1234/v1", "ftp://example.com"])("rejects %j", (value) => {
    expect(providerBaseUrlProblem("Gateway", value)).toMatch(/^Gateway base URL must be/);
  });
});
