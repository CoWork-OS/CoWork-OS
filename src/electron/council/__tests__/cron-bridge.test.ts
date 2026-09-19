import { describe, expect, it } from "vitest";
import { mergeCouncilCronAgentConfig } from "../cron-bridge";

describe("Council cron bridge", () => {
  it("keeps cron entrypoint policy while layering prepared Council settings", () => {
    expect(
      mergeCouncilCronAgentConfig(
        {
          accessProfileId: "ask_for_approval",
          modelKey: "requested-model",
          allowUserInput: true,
        },
        {
          accessProfileId: "prepared-profile-should-not-win",
          multiLlmMode: true,
          modelKey: "prepared-model",
          allowUserInput: false,
        },
        "job-council",
      ),
    ).toEqual({
      accessProfileId: "ask_for_approval",
      modelKey: "prepared-model",
      allowUserInput: false,
      multiLlmMode: true,
      scheduledJobId: "job-council",
    });
  });
});
