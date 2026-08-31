import { describe, expect, it } from "vitest";
import { normalizeWhatsAppNaturalCommand } from "../whatsapp-command-utils";

describe("WhatsApp natural command mapping for slash workflows", () => {
  it("maps simplify phrases", () => {
    expect(normalizeWhatsAppNaturalCommand("simplify this")).toBe("/simplify");
    expect(normalizeWhatsAppNaturalCommand("run simplify tighten this memo")).toBe(
      "/simplify tighten this memo",
    );
  });

  it("maps batch phrases", () => {
    expect(normalizeWhatsAppNaturalCommand("batch migrate docs to v2")).toBe(
      "/batch migrate docs to v2",
    );
    expect(normalizeWhatsAppNaturalCommand("run batch convert all reports")).toBe(
      "/batch convert all reports",
    );
  });

  it("maps llm-wiki phrases", () => {
    expect(normalizeWhatsAppNaturalCommand("llm wiki agent memory systems")).toBe(
      "/llm-wiki agent memory systems",
    );
    expect(normalizeWhatsAppNaturalCommand("build a research vault on ai agents")).toBe(
      "/llm-wiki on ai agents",
    );
  });

  it("maps task-flow shortcut phrases", () => {
    expect(normalizeWhatsAppNaturalCommand("new temp")).toBe("/newtask temp");
    expect(normalizeWhatsAppNaturalCommand("queue check this after")).toBe(
      "/queue check this after",
    );
    expect(normalizeWhatsAppNaturalCommand("steer focus on tests")).toBe("/steer focus on tests");
    expect(normalizeWhatsAppNaturalCommand("btw summarize the logs")).toBe(
      "/background summarize the logs",
    );
  });

  it("does not misclassify URLs", () => {
    expect(
      normalizeWhatsAppNaturalCommand("check https://example.com/batch before we decide"),
    ).toBeUndefined();
  });
});
