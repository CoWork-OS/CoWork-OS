import { describe, expect, it } from "vitest";

import { buildPauseBannerPreview } from "../pause-banner-summary";

describe("buildPauseBannerPreview", () => {
  it("keeps short pause messages inline", () => {
    expect(buildPauseBannerPreview("Waiting on your confirmation.")).toEqual({
      fullText: "Waiting on your confirmation.",
      summary: "Waiting on your confirmation.",
      showDetails: false,
    });
  });

  it("prefers a readable leading sentence when the pause message is long", () => {
    const preview = buildPauseBannerPreview(
      "I narrowed this down to three migration paths and need your call on which one to pursue next. " +
        "Option A keeps the existing workflow with less data reshaping, while Option B is cheaper but forces a full template rebuild. " +
        "Option C removes two integrations we currently depend on.",
      130,
    );

    expect(preview.summary).toBe(
      "I narrowed this down to three migration paths and need your call on which one to pursue next.",
    );
    expect(preview.showDetails).toBe(true);
  });

  it("falls back to truncation when the message is dense and sentence boundaries are not helpful", () => {
    const preview = buildPauseBannerPreview(
      "Replacement options shortlist export formats importer availability field mapping workflow rebuild integration parity permissions history cutover risk retraining cost and timeline all need confirmation before I can proceed",
      90,
    );

    expect(preview.summary).toBe(
      "Replacement options shortlist export formats importer availability field mapping workflow…",
    );
    expect(preview.showDetails).toBe(true);
  });

  it("offers details when the original message has multiline structure", () => {
    const preview = buildPauseBannerPreview(
      "Decision needed:\n- Keep current CRM\n- Move this quarter",
    );

    expect(preview.summary).toBe("Decision needed: - Keep current CRM - Move this quarter");
    expect(preview.showDetails).toBe(true);
  });
});
