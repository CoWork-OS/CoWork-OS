import { describe, expect, it } from "vitest";

import { deriveSlashCommandTaskTitle } from "../slash-command-title";

describe("deriveSlashCommandTaskTitle", () => {
  it("uses legal slash command names and trailing args for readable titles", () => {
    expect(
      deriveSlashCommandTaskTitle(
        "/litigation-legal-demand-intake unpaid invoices acme logistics",
      ),
    ).toBe("Litigation Demand Intake: unpaid invoices acme logistics");
  });

  it("humanizes acronyms in command names", () => {
    expect(deriveSlashCommandTaskTitle("/privacy-legal-dpa-review acme processor terms")).toBe(
      "Privacy DPA Review: acme processor terms",
    );
    expect(
      deriveSlashCommandTaskTitle("/commercial-legal-saas-msa-review enterprise renewal"),
    ).toBe("Commercial SaaS MSA Review: enterprise renewal");
  });

  it("strips the Run prefix used by older slash task titles", () => {
    expect(deriveSlashCommandTaskTitle("Run /litigation-legal-demand-intake")).toBe(
      "Litigation Demand Intake",
    );
  });

  it("uses concise names for app slash commands", () => {
    expect(deriveSlashCommandTaskTitle("/plan fix title generation")).toBe(
      "Plan: fix title generation",
    );
    expect(deriveSlashCommandTaskTitle("/cost rebuild renderer")).toBe(
      "Cost estimate: rebuild renderer",
    );
  });

  it("returns an empty title for non-slash prompts", () => {
    expect(deriveSlashCommandTaskTitle("Draft a demand letter")).toBe("");
  });
});
