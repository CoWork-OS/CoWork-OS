import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerHandoffTools } from "../computer-handoff-tools";
import { ComputerViewService } from "../../../computer-use/computer-view-service";

describe("ComputerHandoffTools", () => {
  let view: ComputerViewService;
  beforeEach(() => {
    view = ComputerViewService.resetForTesting({
      encodeFrame: vi.fn(() => null),
      logEvent: vi.fn(),
      setBrowserPaused: vi.fn(),
    });
  });
  afterEach(() => {
    ComputerViewService.resetForTesting();
  });

  it("defines request_takeover with a required reason", () => {
    const [tool] = ComputerHandoffTools.getToolDefinitions();
    expect(tool.name).toBe("request_takeover");
    expect(tool.input_schema.required).toEqual(["reason"]);
  });

  it("asks through a real input request and waits until the person is done", async () => {
    let resolveAnswer!: (value: Any) => void;
    const requestUserInput = vi.fn(() => new Promise<Any>((resolve) => (resolveAnswer = resolve)));
    const pending = new ComputerHandoffTools("task-1", { requestUserInput }).requestTakeover({
      reason: "Enter the one-time code from your phone",
    });
    await vi.waitFor(() => expect(requestUserInput).toHaveBeenCalled());
    const [, args] = requestUserInput.mock.calls[0] as unknown as [string, Any];
    expect(args.questions[0].question).toContain(
      "Enter the one-time code from your phone. Take over",
    );
    expect(args.questions[0].options.map((option: Any) => option.label)).toEqual(["Done", "Skip"]);
    expect(view.getState("task-1").takeoverRequest?.reason).toBe(
      "Enter the one-time code from your phone",
    );

    // The person takes over in the app, does the step, then answers Done (here or on the phone).
    view.takeOver("task-1");
    resolveAnswer({
      requestId: "r1",
      status: "submitted",
      answers: { takeover: { optionLabel: "Done" } },
    });
    const result = await pending;
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/fresh screenshot/);
    expect(view.isHeldByPerson("task-1")).toBe(false);
    expect(view.getState("task-1").takeoverRequest).toBeUndefined();
  });

  it("tells the agent not to try the step itself when the person skips it", async () => {
    const result = await new ComputerHandoffTools("task-1", {
      requestUserInput: vi.fn(async () => ({
        requestId: "r1",
        status: "submitted" as const,
        answers: { takeover: { optionLabel: "Skip" } },
      })),
    }).requestTakeover({ reason: "Approve the payment" });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Don't try it yourself/);
  });

  it("still shows the request when another question is already waiting", async () => {
    const result = await new ComputerHandoffTools("task-1", {
      requestUserInput: vi.fn(async () => {
        throw new Error("Task task-1 already has a pending structured input request.");
      }),
    }).requestTakeover({ reason: "Solve the CAPTCHA" });
    expect(result.success).toBe(true);
    expect(view.getState("task-1").takeoverRequest?.reason).toBe("Solve the CAPTCHA");
  });

  it("withdraws the request when the task is stopped while waiting", async () => {
    const pending = new ComputerHandoffTools("task-1", {
      requestUserInput: vi.fn(async () => {
        throw new Error("Task stopped by user; current progress accepted.");
      }),
    }).requestTakeover({ reason: "Solve the CAPTCHA" });
    await expect(pending).rejects.toThrow(/stopped/);
    expect(view.getState("task-1").takeoverRequest).toBeUndefined();
  });

  it("never pauses a task that may not wait for the person", async () => {
    const requestUserInput = vi.fn();
    const result = await new ComputerHandoffTools("task-1", {
      requestUserInput,
      getTaskById: vi.fn(async () => ({ agentConfig: { humanInputPolicy: "none" as const } })),
    }).requestTakeover({ reason: "Approve the payment" });
    expect(result.success).toBe(false);
    expect(requestUserInput).not.toHaveBeenCalled();
    expect(view.getState("task-1").takeoverRequest).toBeUndefined();
  });
});
