import { describe, expect, it } from "vitest";
import { botHomeStatus, templateMascot } from "../BotsHome";
import { formatNextRun } from "../../utils/next-run";

const counts = (needs_you: number, working: number, scheduled = 0) => ({
  needs_you,
  working,
  scheduled,
  results: 0,
});

describe("Bots home", () => {
  it("shows the one status a person would act on first", () => {
    expect(botHomeStatus(undefined)).toBeNull();
    expect(
      botHomeStatus({ counts: counts(2, 1), futurePaused: true, responsibilities: 1 }),
    ).toMatchObject({ label: "Needs you · 2", tone: "attention", expression: "attention" });
    expect(
      botHomeStatus({ counts: counts(0, 1), futurePaused: true, responsibilities: 1 }),
    ).toMatchObject({ label: "Working", tone: "active", expression: "working" });
    expect(
      botHomeStatus({ counts: counts(0, 0, 3), futurePaused: true, responsibilities: 1 }),
    ).toMatchObject({ label: "Paused", tone: "paused", expression: "sleeping" });
    expect(
      botHomeStatus({ counts: null, futurePaused: false, responsibilities: null }),
    ).toMatchObject({ label: "Ready", tone: "quiet", expression: "idle" });
  });

  it("names the next run by day", () => {
    const now = new Date(2026, 9, 7, 8, 0).getTime();
    expect(formatNextRun(new Date(2026, 9, 7, 9, 0).getTime(), now)).toMatch(/^today /);
    expect(formatNextRun(new Date(2026, 9, 8, 9, 0).getTime(), now)).toMatch(/^tomorrow /);
    expect(formatNextRun(new Date(2026, 9, 10, 9, 0).getTime(), now)).not.toMatch(
      /^(today|tomorrow) /,
    );
  });

  it("starts template bots as a fitting character", () => {
    expect(templateMascot({ id: "bug-triage", category: "engineering" })).toBe("code");
    expect(templateMascot({ id: "earnings-reviewer", category: "finance" })).toBe("analyze");
    expect(templateMascot({ id: "custom", category: "research" })).toBe("research");
  });
});
