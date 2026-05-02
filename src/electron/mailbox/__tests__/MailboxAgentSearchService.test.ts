import { describe, expect, it } from "vitest";
import { planMailboxSearchQuery } from "../MailboxAgentSearchService";

describe("MailboxAgentSearchService query planner", () => {
  it("expands financial due-date questions across statement/payment wording", () => {
    const plan = planMailboxSearchQuery("when do I need to make a payment to QNB bank for my credit card");

    expect(plan.entities).toContain("QNB");
    expect(plan.wantsFinancialEvidence).toBe(true);
    expect(plan.wantsDueDate).toBe(true);
    expect(plan.expandedTokens).toEqual(
      expect.arrayContaining(["qnb", "payment", "credit", "card", "odeme", "ekstre", "hesap", "kredi", "karti"]),
    );
    expect(plan.providerQueries.join("\n")).toContain("kredi karti odeme tarihi");
  });

  it("keeps follow-up search prompts broad without adding destructive action intent", () => {
    const plan = planMailboxSearchQuery("find people who haven't replied after 24 hours and draft follow-ups");

    expect(plan.tokens).toEqual(expect.arrayContaining(["people", "replied", "24", "hours", "draft", "follow"]));
    expect(plan.wantsFinancialEvidence).toBe(false);
    expect(plan.providerQueries[0]).toContain("find people");
  });
});
