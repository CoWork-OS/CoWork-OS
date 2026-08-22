import { describe, expect, it } from "vitest";

import { routeBotTurn } from "../BotTurnRouter";

describe("routeBotTurn", () => {
  it("keeps ordinary and explicitly tool-free messages conversational", () => {
    expect(routeBotTurn({ body: "Hello, how are you?" }).mode).toBe("conversation");
    expect(routeBotTurn({ body: "Reply exactly BOT-SMOKE and do not use tools." }).mode).toBe(
      "conversation",
    );
    expect(routeBotTurn({ body: "Do not use tools or modify files." }).mode).toBe("conversation");
    expect(routeBotTurn({ body: "Write this as a concise paragraph." }).mode).toBe("conversation");
  });

  it("routes action work without automatically creating a team", () => {
    expect(routeBotTurn({ body: "Create a report.md with the findings." }).mode).toBe("task");
  });

  it("uses a configured team only for work or explicit delegation", () => {
    const team = { executionMode: "team" } as const;
    expect(routeBotTurn({ body: "What do you think about this idea?" }, team).mode).toBe(
      "conversation",
    );
    expect(routeBotTurn({ body: "Ask two specialists in parallel and combine the answer." }, team).mode).toBe(
      "team_task",
    );
  });

  it("honors an explicit trusted-renderer override", () => {
    expect(routeBotTurn({ body: "hello", turnMode: "task" }).mode).toBe("task");
  });
});
