import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerHandoffTools } from "../computer-handoff-tools";
import { ComputerViewService } from "../../../computer-use/computer-view-service";

describe("ComputerHandoffTools", () => {
  afterEach(() => {
    ComputerViewService.resetForTesting();
  });

  it("defines request_takeover with a required reason", () => {
    const [tool] = ComputerHandoffTools.getToolDefinitions();
    expect(tool.name).toBe("request_takeover");
    expect(tool.input_schema.required).toEqual(["reason"]);
  });

  it("asks the person to take over and tells the agent to stop", () => {
    const view = ComputerViewService.resetForTesting({
      encodeFrame: vi.fn(() => null),
      logEvent: vi.fn(),
    });
    const result = new ComputerHandoffTools("task-1").requestTakeover({
      reason: "Enter the one-time code from your phone",
    });
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/Stop using computer and browser tools/);
    expect(view.getState("task-1").takeoverRequest?.reason).toBe(
      "Enter the one-time code from your phone",
    );
  });
});
