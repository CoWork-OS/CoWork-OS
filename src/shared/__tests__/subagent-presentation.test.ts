import { describe, expect, it } from "vitest";

import {
  buildSpawnInstructionsPreview,
  formatAgentNameList,
  formatAgentRosterLine,
  formatSpawnRecapLine,
  formatSpawnedAgentLabel,
  stripAgentRoleSuffix,
} from "../subagent-presentation";

describe("buildSpawnInstructionsPreview", () => {
  it("collapses whitespace so the recap stays on one line", () => {
    expect(buildSpawnInstructionsPreview("Objective:\n  map the\tinsertion points")).toBe(
      "Objective: map the insertion points",
    );
  });

  it("truncates past the limit with an ellipsis", () => {
    expect(buildSpawnInstructionsPreview("abcdefghij", 4)).toBe("abcd…");
  });

  it("returns an empty string for non-string prompts", () => {
    expect(buildSpawnInstructionsPreview(undefined)).toBe("");
  });
});

describe("formatSpawnedAgentLabel", () => {
  it("appends the worker-role call-sign", () => {
    expect(formatSpawnedAgentLabel({ title: "Map model routing", workerRole: "researcher" })).toBe(
      "Map model routing (explorer)",
    );
  });

  it("leaves titles that already carry a call-sign alone", () => {
    expect(formatSpawnedAgentLabel({ title: "Anansi (explorer)", workerRole: "researcher" })).toBe(
      "Anansi (explorer)",
    );
  });

  it("falls back to a generic label when there is no title", () => {
    expect(formatSpawnedAgentLabel({})).toBe("an agent");
  });
});

describe("formatSpawnRecapLine", () => {
  it("reads as a sentence naming the agent and its brief", () => {
    expect(
      formatSpawnRecapLine({ label: "Anansi (explorer)", instructions: "Objective: map X" }),
    ).toBe("Created Anansi (explorer) with the instructions: Objective: map X");
  });

  it("uses the present tense while the spawn is still pending", () => {
    expect(formatSpawnRecapLine({ label: "Anansi (explorer)", pending: true })).toBe(
      "Creating Anansi (explorer)",
    );
  });
});

describe("formatAgentNameList", () => {
  it("names one agent plainly", () => {
    expect(formatAgentNameList(["Anansi"])).toBe("Anansi");
  });

  it("joins two agents with and", () => {
    expect(formatAgentNameList(["Anansi", "Ares"])).toBe("Anansi and Ares");
  });

  it("counts the overflow past the first two", () => {
    expect(formatAgentNameList(["Anansi", "Ares", "Athena", "Atlas"])).toBe(
      "Anansi, Ares and 2 more",
    );
  });
});

describe("formatAgentRosterLine", () => {
  it("reports a running burst", () => {
    expect(
      formatAgentRosterLine({ names: ["Anansi", "Ares", "Athena", "Atlas"], state: "working" }),
    ).toBe("Anansi, Ares and 2 more started working");
  });

  it("reports a finished burst", () => {
    expect(formatAgentRosterLine({ names: ["Anansi"], state: "finished" })).toBe("Anansi finished");
  });

  it("stays readable with no names", () => {
    expect(formatAgentRosterLine({ names: [], state: "working" })).toBe("Agents started working");
  });
});

describe("stripAgentRoleSuffix", () => {
  it("drops the call-sign for roster lines", () => {
    expect(stripAgentRoleSuffix("Anansi (explorer)")).toBe("Anansi");
  });

  it("keeps names that have no call-sign", () => {
    expect(stripAgentRoleSuffix("Anansi")).toBe("Anansi");
  });
});

describe("call-sign suffix detection", () => {
  it("leaves a title whose trailing brackets are not a call-sign", () => {
    expect(stripAgentRoleSuffix("Audit deps (npm, yarn)")).toBe("Audit deps (npm, yarn)");
    expect(
      formatSpawnedAgentLabel({ title: "Audit deps (npm, yarn)", workerRole: "verifier" }),
    ).toBe("Audit deps (npm, yarn) (inspector)");
  });

  it("recognises every capability call-sign, not just the worker-role ones", () => {
    expect(stripAgentRoleSuffix("Ada (designer)")).toBe("Ada");
    expect(stripAgentRoleSuffix("Ada (writer)")).toBe("Ada");
    expect(stripAgentRoleSuffix("Ada (planner)")).toBe("Ada");
  });

  it("matches call-signs case-insensitively", () => {
    expect(stripAgentRoleSuffix("Ada (Explorer)")).toBe("Ada");
  });
});

describe("post-creation labels", () => {
  it('reads as "the agent" when a completion event carries no title', () => {
    expect(formatSpawnedAgentLabel({ fallback: "the agent" })).toBe("the agent");
  });
});
