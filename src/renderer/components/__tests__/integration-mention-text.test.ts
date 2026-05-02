import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { IntegrationMentionSelection } from "../../../shared/types";
import {
  IntegrationMentionText,
  hasRenderableIntegrationMentions,
} from "../IntegrationMentionText";

const gmailMention: IntegrationMentionSelection = {
  id: "builtin:gmail",
  label: "Gmail",
  source: "builtin",
  providerKey: "google-workspace:gmail",
  iconKey: "gmail",
  tools: ["gmail_action"],
  promptHint: "Prefer gmail_action for Gmail work.",
};

describe("IntegrationMentionText", () => {
  it("renders selected integration mentions as inline chips", () => {
    const markup = renderToStaticMarkup(
      React.createElement(IntegrationMentionText, {
        text: "@Gmail whats the last email I got",
        mentions: [gmailMention],
      }),
    );

    expect(markup).toContain("integration-mention-message-chip");
    expect(markup).toContain("Gmail");
    expect(markup).toContain("whats the last email I got");
  });

  it("does not render partial label matches as chips", () => {
    expect(hasRenderableIntegrationMentions("@Gmailish", [gmailMention])).toBe(false);
  });
});
