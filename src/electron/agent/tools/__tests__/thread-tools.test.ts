import { beforeEach, describe, expect, it, vi } from "vitest";

const repository = vi.hoisted(() => ({
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}));

vi.mock("../../../database/repository-facades", () => ({
  ThreadSubscriptionRepository: vi.fn().mockImplementation(function () {
    return repository;
  }),
}));

import { ThreadTools } from "../thread-tools";

function makeTools() {
  const daemon = { getDatabase: vi.fn().mockReturnValue({}) };
  return { tools: new ThreadTools(daemon as never, "task-1"), daemon };
}

describe("ThreadTools", () => {
  beforeEach(() => {
    repository.subscribe.mockReset().mockResolvedValue(true);
    repository.unsubscribe.mockReset().mockResolvedValue(1);
  });

  it("defines thread_subscribe and thread_unsubscribe with when-to-use descriptions", () => {
    const definitions = ThreadTools.getToolDefinitions();
    expect(definitions.map((tool) => tool.name)).toEqual([
      "thread_subscribe",
      "thread_unsubscribe",
    ]);
    for (const tool of definitions) {
      expect(tool.description).toMatch(/Use when/);
      expect(tool.input_schema.required).toEqual(["thread_key"]);
    }
  });

  it("subscribes the running task to a thread", async () => {
    const { tools, daemon } = makeTools();
    expect(daemon.getDatabase).not.toHaveBeenCalled();

    const result = await tools.subscribe({ thread_key: "github:acme/app:pr:7" });

    expect(repository.subscribe).toHaveBeenCalledWith(
      "github:acme/app:pr:7",
      "task-1",
      expect.any(Number),
    );
    expect(result).toMatchObject({ success: true, subscribed: true });

    repository.subscribe.mockResolvedValueOnce(false);
    expect((await tools.subscribe({ thread_key: "github:acme/app:pr:7" })).message).toMatch(
      /already subscribed/,
    );
  });

  it("unsubscribes and says when there was nothing to remove", async () => {
    const { tools } = makeTools();
    expect(await tools.unsubscribe({ thread_key: "mail:abc" })).toMatchObject({
      success: true,
      subscribed: false,
    });
    expect(repository.unsubscribe).toHaveBeenCalledWith("mail:abc", "task-1");
    repository.unsubscribe.mockResolvedValueOnce(0);
    expect((await tools.unsubscribe({ thread_key: "mail:abc" })).message).toMatch(/not subscribed/);
  });

  it("rejects malformed thread keys", async () => {
    const { tools } = makeTools();
    for (const thread_key of ["", "github:acme:pr:1", "slack:C1", 42, "mail:" + "x".repeat(500)]) {
      await expect(tools.subscribe({ thread_key })).rejects.toThrow(/thread_key/);
    }
    expect(repository.subscribe).not.toHaveBeenCalled();
  });
});
