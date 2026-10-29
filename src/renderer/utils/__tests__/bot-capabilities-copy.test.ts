import { describe, expect, it } from "vitest";
import type { BotCapabilitySummary } from "../../../shared/bot-capabilities";
import { botCapabilityRows } from "../bot-capabilities-copy";
import { capabilitySummary } from "./bot-capability-fixtures";

function row(summary: BotCapabilitySummary, id: string, options = {}) {
  return botCapabilityRows(summary, options).find((entry) => entry.id === id)!;
}

describe("botCapabilityRows", () => {
  it("words where the bot works for each Works on setting", () => {
    const base = capabilitySummary();
    expect(row(base, "where").summary).toBe("This Mac or the in-app browser, as the task needs");
    expect(
      row(
        capabilitySummary({
          where: {
            worksOn: "own_desktop",
            reach: { host: false, browser: false, desktop: true, handoff: true },
            desktop: { network: "off", group: "research" },
            computer: { backend: "bot-desktop", lifetime: "persistent" },
          },
        }),
        "where",
      ),
    ).toMatchObject({
      summary: "Its own desktop on this Mac · no network · all work in its computer",
      details: expect.arrayContaining([
        "Can use its own desktop.",
        'Shares its desktop with bots set to "research".',
        "Commands, files and browsing run in its Docker or Podman computer, kept across its tasks.",
      ]),
    });
    const off = row(
      capabilitySummary({
        where: {
          worksOn: "off",
          reach: { host: false, browser: false, desktop: false, handoff: false },
        },
      }),
      "where",
    );
    expect(off.summary).toBe("No computer or browser");
    expect(off.details).toEqual([
      "Can't use a computer or browser. Files, commands and services still work.",
    ]);
  });

  it("names usable services first and counts chats-only ones", () => {
    const services = row(capabilitySummary(), "services");
    expect(services.summary).toBe("Gmail, Calendar, Files +1 · 1 only in chats you start");
    expect(services.details).toEqual([
      "Gmail: can use",
      "Calendar: can use",
      "Files: only in chats you start",
      "Linear: can use, some actions turned off",
      "Box (set up, not connected): turned off for this bot",
      "Messages from Team Slack go to this bot.",
    ]);
  });

  it("says when no service is connected", () => {
    expect(
      row(capabilitySummary({ services: { items: [], channels: [] } }), "services").summary,
    ).toBe("No services connected");
  });

  it("summarizes schedules and warns when the scheduler is off", () => {
    const now = Date.parse("2026-10-29T08:00:00");
    const schedules = row(
      capabilitySummary({
        schedules: {
          runtime: "disabled",
          scheduled: 0,
          responsibilities: { active: 1, paused: 0 },
          checkIns: { enabled: true, everyMinutes: 30 },
        },
      }),
      "schedules",
      { now },
    );
    expect(schedules.summary).toBe("1 responsibility · checks in every 30 min");
    expect(schedules.details).toEqual(["Scheduling is turned off, so nothing runs on its own."]);
    expect(
      row(
        capabilitySummary({
          schedules: {
            runtime: "running",
            scheduled: 0,
            responsibilities: { active: 0, paused: 0 },
            checkIns: { enabled: false },
          },
        }),
        "schedules",
      ).summary,
    ).toBe("Runs only when you ask");
  });

  it("follows the Memory section's live count", () => {
    expect(row(capabilitySummary(), "memory").summary).toBe(
      "12 saved facts · recalls its past chats",
    );
    expect(row(capabilitySummary(), "memory", { memorySaved: 1 }).summary).toBe(
      "1 saved fact · recalls its past chats",
    );
  });

  it("states what needs your OK and the bot's limit", () => {
    const ok = row(capabilitySummary(), "ok");
    expect(ok.summary).toBe(
      "Asks before deleting files or memories, sending files or data out +6 · May do alone: No limit",
    );
    expect(ok.details[0]).toEqual({
      lead: "In chats you start, it asks you first before:",
      items: [
        "deleting files or memories",
        "sending files or data out",
        "actions in connected apps and services",
        "using saved credentials",
        "risky commands like rm or killall",
        "reading your location",
        "phone calls",
        "steps flagged as risky",
      ],
    });
    expect(ok.details).toContain(
      "When it runs on its own (schedules, check-ins, channels), anything that needs your OK is refused. Slack and Teams owners can approve from a decision card.",
    );
    const never = row(
      capabilitySummary({
        safeguards: {
          ...capabilitySummary().safeguards,
          inChats: "refuses",
          deniedTools: ["gmail_action"],
        },
      }),
      "ok",
    );
    expect(never.summary.startsWith("Never asks: steps that need your OK are refused")).toBe(true);
    expect(never.details).toContain("Turned off for this bot: gmail_action.");
  });

  it("marks rows whose reads failed", () => {
    const rows = botCapabilityRows(capabilitySummary({ partial: ["services", "memory"] }));
    expect(rows.filter((entry) => entry.unavailable).map((entry) => entry.id)).toEqual([
      "services",
      "memory",
    ]);
  });

  it("never mentions VMs", () => {
    const text = JSON.stringify(botCapabilityRows(capabilitySummary()));
    expect(text).not.toMatch(/\bVMs?\b|virtual machine/i);
  });
});
