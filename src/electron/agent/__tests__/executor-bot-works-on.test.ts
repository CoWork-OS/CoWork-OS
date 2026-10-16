import { describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor";

describe("TaskExecutor bot Works on setting", () => {
  const executorFor = (task: Any, role?: Any) => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = task;
    executor.daemon = { getAgentRoleById: vi.fn(() => role) };
    return executor;
  };

  it("reads the setting from the assigned bot, not from task config", () => {
    const executor = executorFor(
      { id: "t1", assignedAgentRoleId: "bot-1", agentConfig: {} },
      { id: "bot-1", worksOn: "browser" },
    );
    expect(executor.resolveBotWorksOn()).toBe("browser");
  });

  it("narrows to a limit inherited from a delegating bot", () => {
    const executor = executorFor(
      {
        id: "t2",
        assignedAgentRoleId: "bot-2",
        agentConfig: { inheritedBotWorksOn: "off" },
      },
      { id: "bot-2", worksOn: "this_computer" },
    );
    expect(executor.resolveBotWorksOn()).toBe("off");
  });

  it("leaves non-bot work unrestricted", () => {
    const executor = executorFor({ id: "t3", agentConfig: {} });
    expect(executor.resolveBotWorksOn()).toBeUndefined();
  });
});
