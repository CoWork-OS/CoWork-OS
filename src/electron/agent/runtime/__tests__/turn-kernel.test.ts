import { describe, expect, it, vi } from "vitest";

import { TurnKernel } from "../turn-kernel";
import type { LoopBudgetStopReason } from "../LoopBudgetPolicy";

describe("TurnKernel", () => {
  it("retries the same iteration when response preparation recovers messages", async () => {
    const beforeIteration = vi.fn();
    const requestResponse = vi
      .fn()
      .mockResolvedValueOnce({
        recovered: true,
        messages: [{ role: "user", content: "recovered" }],
      })
      .mockResolvedValueOnce({
        response: { stopReason: "end_turn", content: [{ type: "text", text: "done" }] },
        availableTools: [],
      });

    const kernel = new TurnKernel(
      {
        mode: "follow_up",
        messages: [{ role: "user", content: "start" }],
        maxIterations: 4,
        maxEmptyResponses: 2,
      },
      {
        beforeIteration,
        requestResponse,
        handleResponse: async () => ({ continueLoop: false }),
      },
    );

    const result = await kernel.run();

    expect(beforeIteration).toHaveBeenCalledTimes(2);
    expect(requestResponse).toHaveBeenCalledTimes(2);
    expect(result.iterations).toBe(1);
    expect(result.messages).toEqual([{ role: "user", content: "recovered" }]);
  });

  it("stops when max empty response count is reached", async () => {
    const kernel = new TurnKernel(
      {
        mode: "step",
        messages: [{ role: "user", content: "start" }],
        maxIterations: 5,
        maxEmptyResponses: 1,
      },
      {
        requestResponse: async () => ({
          response: { stopReason: "end_turn", content: [] },
          availableTools: [],
        }),
        handleResponse: async () => ({ emptyResponseCount: 1, continueLoop: true }),
      },
    );

    const result = await kernel.run();

    expect(result.stopReason).toBe("max_empty_responses");
    expect(result.iterations).toBe(1);
  });

  it("allows the final configured recovered response to issue its retry request", async () => {
    const requestResponse = vi
      .fn()
      .mockResolvedValueOnce({
        recovered: true,
        messages: [{ role: "user", content: "recovered once" }],
      })
      .mockResolvedValueOnce({
        recovered: true,
        messages: [{ role: "user", content: "recovered twice" }],
      })
      .mockResolvedValueOnce({
        response: { stopReason: "end_turn", content: [{ type: "text", text: "done" }] },
        availableTools: [],
      });

    const kernel = new TurnKernel(
      {
        mode: "step",
        messages: [{ role: "user", content: "start" }],
        maxIterations: 5,
        maxEmptyResponses: 2,
        maxRecoveredResponses: 2,
      },
      {
        requestResponse,
        handleResponse: async () => ({ continueLoop: false }),
      },
    );

    const result = await kernel.run();

    expect(requestResponse).toHaveBeenCalledTimes(3);
    expect(result.stopReason).toBeUndefined();
    expect(result.iterations).toBe(1);
    expect(result.messages).toEqual([{ role: "user", content: "recovered twice" }]);
  });

  it("stops recovered responses before exceeding the configured retry request cap", async () => {
    const requestResponse = vi.fn().mockResolvedValue({
      recovered: true,
      messages: [{ role: "user", content: "still recovering" }],
    });

    const kernel = new TurnKernel(
      {
        mode: "step",
        messages: [{ role: "user", content: "start" }],
        maxIterations: 5,
        maxEmptyResponses: 2,
        maxRecoveredResponses: 2,
      },
      {
        requestResponse,
        handleResponse: async () => ({ continueLoop: false }),
      },
    );

    const result = await kernel.run();

    expect(requestResponse).toHaveBeenCalledTimes(3);
    expect(result.stopReason).toBe("max_recovered_responses");
    expect(result.loopBudgetStopReason).toBe("max_recovered_responses");
    expect(result.iterations).toBe(0);
    expect(result.messages).toEqual([{ role: "user", content: "still recovering" }]);
  });

  it("allows the final configured repeated iteration to issue its retry request", async () => {
    const requestResponse = vi
      .fn()
      .mockResolvedValueOnce({
        response: { stopReason: "max_tokens", content: [{ type: "text", text: "repeat once" }] },
        availableTools: [],
      })
      .mockResolvedValueOnce({
        response: { stopReason: "max_tokens", content: [{ type: "text", text: "repeat twice" }] },
        availableTools: [],
      })
      .mockResolvedValueOnce({
        response: { stopReason: "end_turn", content: [{ type: "text", text: "done" }] },
        availableTools: [],
      });
    const handleResponse = vi
      .fn()
      .mockResolvedValueOnce({ continueLoop: true, repeatIteration: true })
      .mockResolvedValueOnce({ continueLoop: true, repeatIteration: true })
      .mockResolvedValueOnce({ continueLoop: false });

    const kernel = new TurnKernel(
      {
        mode: "step",
        messages: [{ role: "user", content: "start" }],
        maxIterations: 5,
        maxLlmCalls: 10,
        maxEmptyResponses: 2,
        maxRepeatedIterations: 2,
      },
      {
        requestResponse,
        handleResponse,
      },
    );

    const result = await kernel.run();

    expect(requestResponse).toHaveBeenCalledTimes(3);
    expect(result.stopReason).toBeUndefined();
    expect(result.iterations).toBe(1);
  });

  it("stops repeated iterations before exceeding the configured retry request cap", async () => {
    const requestResponse = vi.fn().mockResolvedValue({
      response: { stopReason: "tool_use", content: [{ type: "text", text: "repeat" }] },
      availableTools: [],
    });

    const kernel = new TurnKernel(
      {
        mode: "step",
        messages: [{ role: "user", content: "start" }],
        maxIterations: 5,
        maxLlmCalls: 10,
        maxEmptyResponses: 2,
        maxRepeatedIterations: 2,
      },
      {
        requestResponse,
        handleResponse: async () => ({ continueLoop: true, repeatIteration: true }),
      },
    );

    const result = await kernel.run();

    expect(requestResponse).toHaveBeenCalledTimes(3);
    expect(result.stopReason).toBe("max_repeated_iterations");
    expect(result.loopBudgetStopReason).toBe("max_repeated_iterations");
    expect(result.iterations).toBe(0);
  });

  it("enforces one total LLM-call budget across recovered and repeated turns", async () => {
    const requestResponse = vi
      .fn()
      .mockResolvedValueOnce({
        response: { stopReason: "tool_use", content: [{ type: "text", text: "repeat" }] },
        availableTools: [],
      })
      .mockResolvedValueOnce({
        recovered: true,
        messages: [{ role: "user", content: "recovered once" }],
      })
      .mockResolvedValueOnce({
        response: { stopReason: "tool_use", content: [{ type: "text", text: "repeat again" }] },
        availableTools: [],
      })
      .mockResolvedValueOnce({
        recovered: true,
        messages: [{ role: "user", content: "recovered twice" }],
      })
      .mockResolvedValue({
        response: { stopReason: "tool_use", content: [{ type: "text", text: "budget edge" }] },
        availableTools: [],
      });

    const kernel = new TurnKernel(
      {
        mode: "step",
        messages: [{ role: "user", content: "start" }],
        maxIterations: 32,
        maxLlmCalls: 5,
        maxEmptyResponses: 2,
        maxRecoveredResponses: 10,
        maxRepeatedIterations: 10,
      },
      {
        requestResponse,
        handleResponse: async () => ({ continueLoop: true, repeatIteration: true }),
      },
    );

    const result = await kernel.run();
    const loopBudgetStopReason: LoopBudgetStopReason | undefined = result.loopBudgetStopReason;

    expect(requestResponse).toHaveBeenCalledTimes(5);
    expect(result.stopReason).toBe("max_llm_calls");
    expect(loopBudgetStopReason).toBe("max_llm_calls");
  });

  it("stops immediately when response preparation requests a terminal stop", async () => {
    const handleResponse = vi.fn();
    const kernel = new TurnKernel(
      {
        mode: "step",
        messages: [{ role: "user", content: "start" }],
        maxIterations: 5,
        maxEmptyResponses: 2,
      },
      {
        requestResponse: async () => ({
          stopped: true,
          messages: [{ role: "user", content: "halted" }],
          stopReason: "context_capacity_exhausted",
        }),
        handleResponse,
      },
    );

    const result = await kernel.run();

    expect(handleResponse).not.toHaveBeenCalled();
    expect(result.stopReason).toBe("context_capacity_exhausted");
    expect(result.messages).toEqual([{ role: "user", content: "halted" }]);
    expect(result.iterations).toBe(1);
  });
});
