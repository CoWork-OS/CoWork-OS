import { describe, expect, it } from "vitest";

import { buildMailboxComposeDraftInputFromPrompt } from "../../../shared/mailbox";
import { extractAssistantMailDraft, formatRecipients, parseRecipients } from "../MailComposeFrame";

describe("MailComposeFrame recipient helpers", () => {
  it("parses plain, named, semicolon, and newline-separated recipients", () => {
    expect(
      parseRecipients(
        'alice@example.com; Bob Example <bob@example.com>\n"Carol" <carol@example.com>',
      ),
    ).toEqual([
      { email: "alice@example.com" },
      { name: "Bob Example", email: "bob@example.com" },
      { name: "Carol", email: "carol@example.com" },
    ]);
  });

  it("formats recipients for editable compose fields", () => {
    expect(
      formatRecipients([
        { email: "alice@example.com" },
        { name: "Bob Example", email: "bob@example.com" },
      ]),
    ).toBe("alice@example.com, Bob Example <bob@example.com>");
  });

  it("extracts a sendable draft from an assistant email draft response", () => {
    expect(
      extractAssistantMailDraft(
        [
          "Almarion, here's a cleaner draft:",
          "",
          "Subject: Dishwasher Leaking Again and Cabinet Damage",
          "",
          "Dear Carl,",
          "",
          "The dishwasher is leaking again and damaged the cabinet nearby.",
          "",
          "Thank you,",
          "Almarion",
        ].join("\n"),
        "draft an email to my landlord carl hughes",
      ),
    ).toEqual({
      mode: "new",
      subject: "Dishwasher Leaking Again and Cabinet Damage",
      bodyText:
        "Dear Carl,\n\nThe dishwasher is leaking again and damaged the cabinet nearby.\n\nThank you,\nAlmarion",
      to: [],
    });
  });

  it("extracts a sendable draft from a task completion summary", () => {
    expect(
      extractAssistantMailDraft(
        [
          "Subject: Dishwasher Leaking Again and Cabinet Damage",
          "",
          "Hi Carl,",
          "",
          "I’m writing to let you know that the dishwasher is leaking again. This time, the leak has also caused damage to the cabinet.",
          "",
          "Could you please arrange a repair appointment for sometime this week so it can be inspected and fixed?",
          "",
          "Thanks,  ",
          "Almarion",
        ].join("\n"),
        "draft an email to my landlord carl hughes that the dishwasher is leaking again",
      ),
    ).toEqual({
      mode: "new",
      subject: "Dishwasher Leaking Again and Cabinet Damage",
      bodyText:
        "Hi Carl,\n\nI’m writing to let you know that the dishwasher is leaking again. This time, the leak has also caused damage to the cabinet.\n\nCould you please arrange a repair appointment for sometime this week so it can be inspected and fixed?\n\nThanks,  \nAlmarion",
      to: [],
    });
  });

  it("creates an initial compose draft directly from a user email prompt", () => {
    expect(
      buildMailboxComposeDraftInputFromPrompt(
        "draft an email to my landlord carl hughes that the dishwasher is leaking again, include that it damaged the cabinet, and ask for a repair appointment this week",
      ),
    ).toEqual({
      mode: "new",
      subject: "Dishwasher Leaking Again and Cabinet Damage",
      bodyText: [
        "Hi Carl,",
        "",
        "I'm writing to let you know that the dishwasher is leaking again.",
        "It damaged the cabinet.",
        "",
        "Could you please arrange a repair appointment this week?",
        "",
        "Thank you,",
      ].join("\n"),
      to: [],
    });
  });
});
