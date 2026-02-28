import { describe, expect, it } from "vitest";
import {
  extractPreferredNameFromMessage,
  sanitizeInferredPreferredName,
  sanitizeStoredPreferredName,
  sanitizePreferredNameMemoryLine,
} from "../preferred-name";

describe("preferred-name utils", () => {
  it("extracts explicit preferred name intros", () => {
    expect(extractPreferredNameFromMessage("My name is Mesut.")).toBe("Mesut");
    expect(extractPreferredNameFromMessage("Call me mesut felat")).toBe("mesut felat");
    expect(extractPreferredNameFromMessage("I'm Alice")).toBe("Alice");
    expect(extractPreferredNameFromMessage("My name is Çağrı")).toBe("Çağrı");
  });

  it("rejects task fragments as preferred names", () => {
    expect(extractPreferredNameFromMessage("I'm building a cowork assistant for Nokia")).toBeNull();
    expect(extractPreferredNameFromMessage("I'm from Turkey")).toBeNull();
    expect(
      extractPreferredNameFromMessage("I am now authenticated but I cannot open the view"),
    ).toBeNull();
  });

  it("sanitizes stale preferred-name memory lines", () => {
    expect(sanitizePreferredNameMemoryLine("Preferred name: building a cowork assistant for Nokia")).toBe(
      null,
    );
    expect(sanitizePreferredNameMemoryLine("Preferred name: Mesut")).toBe("Preferred name: Mesut");
  });

  it("sanitizes inferred names safely", () => {
    expect(sanitizeInferredPreferredName("building a cowork assistant")).toBeUndefined();
    expect(sanitizeInferredPreferredName("Mesut")).toBe("Mesut");
  });

  it("keeps explicit multi-part stored names but clears sentence-like values", () => {
    expect(sanitizeStoredPreferredName("Mary Jane Watson Parker")).toBe("Mary Jane Watson Parker");
    expect(sanitizeStoredPreferredName("building a cowork assistant for Nokia")).toBeUndefined();
  });
});
