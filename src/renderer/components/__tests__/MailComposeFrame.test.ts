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
        "Hi Carl,\n\nI’m writing to let you know that the dishwasher is leaking again. This time, the leak has also caused damage to the cabinet.\n\nCould you please arrange a repair appointment for sometime this week so it can be inspected and fixed?\n\nThanks,\nAlmarion",
      to: [],
    });
  });

  it("keeps a separately requested action table and commentary out of the email body", () => {
    const answer = [
      "## Follow-up email draft",
      "",
      "**Subject:** Northstar onboarding sync — follow-up",
      "",
      "Hi team,",
      "",
      "Thanks for the sync today. The pilot starts **19 October** with **12 customer-success staff**.",
      "",
      "Our next meeting is **Thursday at 10:00 Lisbon time**.",
      "",
      "Best,  ",
      "[Your name]",
      "",
      "## Action table",
      "",
      "| Action / decision | Owner | Due date |",
      "|---|---|---|",
      "| Send revised welcome copy | Marta | Tuesday |",
    ].join("\n");
    const draft = extractAssistantMailDraft(
      answer,
      "Write a concise follow-up email draft and a separate action table",
    );
    expect(draft?.subject).toBe("Northstar onboarding sync — follow-up");
    expect(draft?.bodyText).toBe(
      [
        "Hi team,",
        "",
        "Thanks for the sync today. The pilot starts 19 October with 12 customer-success staff.",
        "",
        "Our next meeting is Thursday at 10:00 Lisbon time.",
        "",
        "Best,",
        "[Your name]",
      ].join("\n"),
    );
    expect(draft?.bodyText).not.toMatch(/\*\*|##|\|/);
  });

  it("stops at a table or commentary that follows the signature without a heading", () => {
    const draft = extractAssistantMailDraft(
      [
        "Subject: Pilot follow-up",
        "",
        "Hi Marta,",
        "",
        "Could you send the revised welcome copy by Tuesday?",
        "",
        "Thank you,",
        "Sam",
        "",
        "| Action | Owner |",
        "|---|---|",
        "| Welcome copy | Marta |",
        "",
        "Let me know if you want a shorter version.",
      ].join("\n"),
      "draft an email to Marta",
    );
    expect(draft?.bodyText).toBe(
      "Hi Marta,\n\nCould you send the revised welcome copy by Tuesday?\n\nThank you,\nSam",
    );

    const withCommentary = extractAssistantMailDraft(
      [
        "Subject: Pilot follow-up",
        "",
        "Hi Marta,",
        "",
        "Thank you!",
        "",
        "Could you send the revised welcome copy by Tuesday?",
        "",
        "Best regards,",
        "",
        "Sam Rivera",
        "Customer Success",
        "",
        "P.S. The recording link is in the shared folder.",
        "",
        "---",
        "",
        "I kept the tone friendly; tell me if you want it more formal.",
      ].join("\n"),
      "draft an email to Marta",
    );
    expect(withCommentary?.bodyText).toBe(
      [
        "Hi Marta,",
        "",
        "Thank you!",
        "",
        "Could you send the revised welcome copy by Tuesday?",
        "",
        "Best regards,",
        "",
        "Sam Rivera",
        "Customer Success",
        "",
        "P.S. The recording link is in the shared folder.",
      ].join("\n"),
    );
  });

  it("preserves in-email bullet lists and the signature while dropping Markdown markers", () => {
    const draft = extractAssistantMailDraft(
      [
        "Subject: *Next steps* for the pilot",
        "",
        "Hi team,",
        "",
        "Here is what we agreed:",
        "",
        "* **Marta** sends the revised welcome copy by _Tuesday_",
        "- James checks captions on the `training` recordings",
        "1. Review the [pilot plan](https://example.com/plan) before Thursday",
        "",
        "Kind regards,",
        "Sam Rivera",
        "Customer Success Lead",
      ].join("\n"),
      "draft a follow-up email",
    );
    expect(draft).toEqual({
      mode: "new",
      subject: "Next steps for the pilot",
      bodyText: [
        "Hi team,",
        "",
        "Here is what we agreed:",
        "",
        "- Marta sends the revised welcome copy by Tuesday",
        "- James checks captions on the training recordings",
        "1. Review the pilot plan (https://example.com/plan) before Thursday",
        "",
        "Kind regards,",
        "Sam Rivera",
        "Customer Success Lead",
      ].join("\n"),
      to: [],
    });
  });

  it("keeps literal characters such as snake_case names, arithmetic, and escaped markers", () => {
    const draft = extractAssistantMailDraft(
      [
        "Subject: Config update",
        "",
        "Hi Ana,",
        "",
        "Please set max_retry_count to 3 * 2 and keep the \\*draft\\* label.",
        "",
        "Thanks,",
        "Sam",
      ].join("\n"),
      "draft an email to Ana",
    );
    expect(draft?.bodyText).toBe(
      "Hi Ana,\n\nPlease set max_retry_count to 3 * 2 and keep the *draft* label.\n\nThanks,\nSam",
    );
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
