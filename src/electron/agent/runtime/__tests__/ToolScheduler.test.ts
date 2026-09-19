import { describe, expect, it, vi } from "vitest";

import { ToolScheduler } from "../ToolScheduler";

describe("ToolScheduler", () => {
  it("batches consecutive read_parallel calls and preserves result order", async () => {
    const scheduler = new ToolScheduler();
    const finalizeOrder: string[] = [];

    const outcome = await scheduler.executeBatch({
      calls: [
        {
          index: 0,
          toolUse: { type: "tool_use", id: "1", name: "read_file", input: {} },
        },
        {
          index: 1,
          toolUse: { type: "tool_use", id: "2", name: "glob", input: {} },
        },
      ],
      maxParallel: 2,
      prepareCall: async (call) => ({
        status: "scheduled",
        call: {
          ...call,
          toolName: call.toolUse.name,
          input: call.toolUse.input,
          spec: {
            concurrencyClass: "read_parallel",
            readOnly: true,
            idempotent: true,
          },
          run: async () => {
            if (call.toolUse.id === "1") {
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            return {
              result: { ok: call.toolUse.id },
              resultJson: JSON.stringify({ ok: call.toolUse.id }),
            };
          },
          finalize: async (rawOutcome) => {
            finalizeOrder.push(call.toolUse.id);
            return {
              toolResult: {
                type: "tool_result",
                tool_use_id: call.toolUse.id,
                content: rawOutcome.resultJson || "",
              },
            };
          },
        },
      }),
    });

    expect(outcome.batches).toHaveLength(1);
    expect(outcome.batches[0]?.mode).toBe("parallel");
    expect(finalizeOrder).toEqual(["1", "2"]);
    expect(outcome.toolResults.map((entry) => entry.tool_use_id)).toEqual(["1", "2"]);
  });

  it("splits read and write calls into separate batches", async () => {
    const scheduler = new ToolScheduler();

    const outcome = await scheduler.executeBatch({
      calls: [
        {
          index: 0,
          toolUse: { type: "tool_use", id: "1", name: "read_file", input: {} },
        },
        {
          index: 1,
          toolUse: { type: "tool_use", id: "2", name: "write_file", input: {} },
        },
      ],
      prepareCall: async (call) => ({
        status: "scheduled",
        call: {
          ...call,
          toolName: call.toolUse.name,
          input: call.toolUse.input,
          spec:
            call.toolUse.name === "read_file"
              ? {
                  concurrencyClass: "read_parallel",
                  readOnly: true,
                  idempotent: true,
                }
              : {
                  concurrencyClass: "exclusive",
                  readOnly: false,
                  idempotent: false,
                },
          run: async () => ({
            resultJson: JSON.stringify({ ok: call.toolUse.id }),
          }),
          finalize: async (rawOutcome) => ({
            toolResult: {
              type: "tool_result",
              tool_use_id: call.toolUse.id,
              content: rawOutcome.resultJson || "",
            },
          }),
        },
      }),
    });

    expect(outcome.batches).toHaveLength(2);
    expect(outcome.batches.map((batch) => batch.mode)).toEqual(["parallel", "serial"]);
  });

  it("runs post execution effects in model order after parallel completion", async () => {
    const scheduler = new ToolScheduler();
    const effectOrder: string[] = [];
    const effectSpy = vi.fn((toolName: string) => effectOrder.push(toolName));

    await scheduler.executeBatch({
      calls: [
        {
          index: 0,
          toolUse: { type: "tool_use", id: "1", name: "read_file", input: {} },
        },
        {
          index: 1,
          toolUse: { type: "tool_use", id: "2", name: "read_file", input: {} },
        },
      ],
      maxParallel: 2,
      prepareCall: async (call) => ({
        status: "scheduled",
        call: {
          ...call,
          toolName: call.toolUse.name,
          input: call.toolUse.input,
          spec: {
            concurrencyClass: "read_parallel",
            readOnly: true,
            idempotent: true,
            postExecutionEffect: async ({ toolName }) => {
              effectSpy(toolName);
            },
          },
          run: async () => {
            if (call.toolUse.id === "1") {
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            return { resultJson: call.toolUse.id };
          },
          finalize: async (rawOutcome) => ({
            toolResult: {
              type: "tool_result",
              tool_use_id: call.toolUse.id,
              content: String(rawOutcome.resultJson || ""),
            },
          }),
        },
      }),
    });

    expect(effectSpy).toHaveBeenCalledTimes(2);
    expect(effectOrder).toEqual(["read_file", "read_file"]);
  });

  it("marks queued calls cancelled instead of launching them after cancellation", async () => {
    const scheduler = new ToolScheduler();
    let keepRunning = true;
    const runSpy = vi.fn(async (id: string) => {
      if (id === "1") {
        keepRunning = false;
      }
      return { resultJson: id };
    });
    const finalized: Array<{ id: string; cancelled: boolean }> = [];

    const outcome = await scheduler.executeBatch({
      calls: [
        {
          index: 0,
          toolUse: { type: "tool_use", id: "1", name: "generate_image", input: {} },
        },
        {
          index: 1,
          toolUse: { type: "tool_use", id: "2", name: "generate_image", input: {} },
        },
      ],
      maxParallel: 1,
      shouldContinue: () => keepRunning,
      prepareCall: async (call) => ({
        status: "scheduled",
        call: {
          ...call,
          toolName: call.toolUse.name,
          input: call.toolUse.input,
          spec: {
            concurrencyClass: "side_effect_parallel",
            readOnly: false,
            idempotent: true,
          },
          run: async () => runSpy(call.toolUse.id),
          finalize: async (rawOutcome) => {
            finalized.push({
              id: call.toolUse.id,
              cancelled: rawOutcome.metadata?.cancelled === true,
            });
            return {
              toolResult: {
                type: "tool_result",
                tool_use_id: call.toolUse.id,
                content: rawOutcome.metadata?.cancelled === true ? "cancelled" : "ok",
                is_error: rawOutcome.metadata?.cancelled === true,
              },
            };
          },
        },
      }),
    });

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy).toHaveBeenCalledWith("1");
    expect(finalized).toEqual([
      { id: "1", cancelled: false },
      { id: "2", cancelled: true },
    ]);
    expect(outcome.toolResults.map((entry) => entry.tool_use_id)).toEqual(["1", "2"]);
    expect(outcome.toolResults[1]?.is_error).toBe(true);
  });

  it("synthesizes stop-after results for the unprepared tail without invoking preparation", async () => {
    const scheduler = new ToolScheduler();
    const prepareCall = vi.fn(async (call: { index: number; toolUse: Any }) => {
      if (call.toolUse.id !== "1") {
        throw new Error("tail preparation should not run after stopAfter");
      }
      return {
        status: "immediate" as const,
        call,
        effectiveToolName: "read_file",
        stopAfter: true,
        outcome: {
          toolResult: {
            type: "tool_result" as const,
            tool_use_id: call.toolUse.id,
            content: JSON.stringify({ error: "Task was cancelled" }),
            is_error: true,
          },
        },
      };
    });

    const outcome = await scheduler.executeBatch({
      calls: [
        { index: 0, toolUse: { type: "tool_use", id: "1", name: "read_file", input: {} } },
        { index: 1, toolUse: { type: "tool_use", id: "2", name: "read_file", input: {} } },
        { index: 2, toolUse: { type: "tool_use", id: "3", name: "read_file", input: {} } },
      ],
      prepareCall,
    });

    expect(prepareCall).toHaveBeenCalledTimes(1);
    expect(outcome.toolResults.map((result) => result.tool_use_id)).toEqual(["1", "2", "3"]);
    expect(outcome.toolResults.slice(1).every((result) => result.is_error === true)).toBe(true);
    expect(outcome.toolResults.slice(1).map((result) => result.content)).toEqual([
      JSON.stringify({ error: "Task was cancelled" }),
      JSON.stringify({ error: "Task was cancelled" }),
    ]);
  });

  it.each([
    {
      label: "serial",
      concurrencyClass: "exclusive" as const,
      idempotent: false,
      maxParallel: 1,
    },
    {
      label: "parallel",
      concurrencyClass: "read_parallel" as const,
      idempotent: true,
      maxParallel: 2,
    },
  ])(
    "returns one result per call and stops after a rejected $label dispatch",
    async ({ concurrencyClass, idempotent, maxParallel }) => {
      const scheduler = new ToolScheduler();
      const dispatchError = new Error("Tool-call budget exhausted");
      const runSpy = vi.fn(async (id: string) => ({ resultJson: id }));
      const effects: string[] = [];
      const finalized: Array<{ id: string; dispatchFailed: boolean; dispatchSkipped: boolean }> =
        [];
      let dispatchCount = 0;

      const outcome = await scheduler.executeBatch({
        calls: [
          { index: 0, toolUse: { type: "tool_use", id: "1", name: "read_file", input: {} } },
          { index: 1, toolUse: { type: "tool_use", id: "2", name: "read_file", input: {} } },
          { index: 2, toolUse: { type: "tool_use", id: "3", name: "read_file", input: {} } },
        ],
        maxParallel,
        prepareCall: async (call) => ({
          status: "scheduled" as const,
          call: {
            ...call,
            toolName: call.toolUse.name,
            input: call.toolUse.input,
            spec: {
              concurrencyClass,
              readOnly: concurrencyClass === "read_parallel",
              idempotent,
              postExecutionEffect: async () => {
                effects.push(call.toolUse.id);
              },
            },
            onDispatched: () => {
              if (dispatchCount > 0) throw dispatchError;
              dispatchCount += 1;
            },
            run: async () => runSpy(call.toolUse.id),
            finalize: async (rawOutcome) => {
              finalized.push({
                id: call.toolUse.id,
                dispatchFailed: rawOutcome.metadata?.dispatchFailed === true,
                dispatchSkipped: rawOutcome.metadata?.dispatchSkipped === true,
              });
              return {
                toolResult: {
                  type: "tool_result" as const,
                  tool_use_id: call.toolUse.id,
                  content: rawOutcome.error ? String((rawOutcome.error as Error).message) : "ok",
                  is_error: Boolean(rawOutcome.error),
                },
              };
            },
          },
        }),
      });

      expect(runSpy).toHaveBeenCalledTimes(1);
      expect(runSpy).toHaveBeenCalledWith("1");
      expect(effects).toEqual(["1"]);
      expect(finalized).toEqual([
        { id: "1", dispatchFailed: false, dispatchSkipped: false },
        { id: "2", dispatchFailed: true, dispatchSkipped: false },
        { id: "3", dispatchFailed: false, dispatchSkipped: true },
      ]);
      expect(outcome.toolResults.map((result) => result.tool_use_id)).toEqual(["1", "2", "3"]);
      expect(outcome.toolResults).toHaveLength(3);
      expect(
        outcome.callReports.map(({ call, status, batchMode }) => ({
          id: call.toolUse.id,
          status,
          batchMode,
        })),
      ).toEqual([
        { id: "1", status: "executed", batchMode: maxParallel > 1 ? "parallel" : "serial" },
        { id: "2", status: "immediate", batchMode: undefined },
        { id: "3", status: "immediate", batchMode: undefined },
      ]);
      expect(outcome.fatalError).toBe(dispatchError);
    },
  );

  it("rejects malformed provider arguments before preparation and preserves valid siblings", async () => {
    const scheduler = new ToolScheduler();
    const prepareCall = vi.fn(async (call) => ({
      status: "scheduled" as const,
      call: {
        ...call,
        toolName: call.toolUse.name,
        input: call.toolUse.input,
        spec: {
          concurrencyClass: "read_parallel" as const,
          readOnly: true,
          idempotent: true,
        },
        run: async () => ({ resultJson: JSON.stringify({ ok: call.toolUse.id }) }),
        finalize: async (rawOutcome: { resultJson?: string }) => ({
          toolResult: {
            type: "tool_result" as const,
            tool_use_id: call.toolUse.id,
            content: rawOutcome.resultJson || "",
          },
        }),
      },
    }));

    const outcome = await scheduler.executeBatch({
      calls: [
        {
          index: 0,
          toolUse: {
            type: "tool_use",
            id: "call_bad",
            name: "write_file",
            input: {},
            inputError: {
              code: "malformed_json",
              message: "Tool call arguments must be valid JSON.",
            },
          },
        },
        {
          index: 1,
          toolUse: {
            type: "tool_use",
            id: "call_good",
            name: "read_file",
            input: { path: "a.ts" },
          },
        },
      ],
      prepareCall,
    });

    expect(prepareCall).toHaveBeenCalledTimes(1);
    expect(prepareCall).toHaveBeenCalledWith(
      expect.objectContaining({ toolUse: expect.objectContaining({ id: "call_good" }) }),
    );
    expect(outcome.toolResults.map((result) => result.tool_use_id)).toEqual([
      "call_bad",
      "call_good",
    ]);
    expect(outcome.toolResults[0]).toMatchObject({
      tool_use_id: "call_bad",
      is_error: true,
    });
    expect(JSON.parse(outcome.toolResults[0]!.content)).toMatchObject({
      rejected: true,
      reason: "invalid_tool_arguments",
      code: "malformed_json",
    });
    expect(outcome.callReports.map((report) => [report.call.toolUse.id, report.status])).toEqual([
      ["call_bad", "immediate"],
      ["call_good", "executed"],
    ]);
  });

  it("stops preparing the tail when cancellation arrives during preparation", async () => {
    const scheduler = new ToolScheduler();
    let keepRunning = true;
    let releaseFirstPreparation: () => void = () => undefined;
    const onDispatched = vi.fn();
    const runTool = vi.fn(async () => ({ resultJson: "ok" }));
    const firstPreparation = new Promise<void>((resolve) => {
      releaseFirstPreparation = resolve;
    });
    const prepareCall = vi.fn(async (call: { index: number; toolUse: Any }) => {
      if (call.toolUse.id === "1") await firstPreparation;
      return {
        status: "scheduled" as const,
        call: {
          ...call,
          toolName: call.toolUse.name,
          input: call.toolUse.input,
          spec: {
            concurrencyClass: "exclusive" as const,
            readOnly: false,
            idempotent: false,
          },
          onDispatched,
          run: runTool,
          finalize: async (rawOutcome: { metadata?: Record<string, unknown> }) => ({
            toolResult: {
              type: "tool_result" as const,
              tool_use_id: call.toolUse.id,
              content: rawOutcome.metadata?.cancelled === true ? "cancelled" : "ok",
              is_error: rawOutcome.metadata?.cancelled === true,
            },
          }),
        },
      };
    });

    const execution = scheduler.executeBatch({
      calls: [
        { index: 0, toolUse: { type: "tool_use", id: "1", name: "write_file", input: {} } },
        { index: 1, toolUse: { type: "tool_use", id: "2", name: "write_file", input: {} } },
        { index: 2, toolUse: { type: "tool_use", id: "3", name: "write_file", input: {} } },
      ],
      shouldContinue: () => keepRunning,
      prepareCall,
    });

    await vi.waitFor(() => expect(prepareCall).toHaveBeenCalledTimes(1));
    keepRunning = false;
    releaseFirstPreparation();

    const outcome = await execution;

    expect(prepareCall).toHaveBeenCalledTimes(1);
    expect(outcome.toolResults.map((result) => result.tool_use_id)).toEqual(["1", "2", "3"]);
    expect(outcome.toolResults.slice(1).every((result) => result.is_error === true)).toBe(true);
    expect(outcome.callReports).toHaveLength(3);
    expect(onDispatched).not.toHaveBeenCalled();
    expect(runTool).not.toHaveBeenCalled();
    expect(outcome.callReports.every((report) => report.status === "immediate")).toBe(true);
    expect(outcome.fatalError).toBeUndefined();
  });

  it("isolates post-execution effect failures while preserving fatal metadata", async () => {
    const scheduler = new ToolScheduler();
    const postExecutionError = new Error("post effect failed");
    const finalized: string[] = [];

    const outcome = await scheduler.executeBatch({
      calls: [
        { index: 0, toolUse: { type: "tool_use", id: "1", name: "write_file", input: {} } },
        { index: 1, toolUse: { type: "tool_use", id: "2", name: "write_file", input: {} } },
      ],
      prepareCall: async (call) => ({
        status: "scheduled" as const,
        call: {
          ...call,
          toolName: call.toolUse.name,
          input: call.toolUse.input,
          spec: {
            concurrencyClass: "exclusive" as const,
            readOnly: false,
            idempotent: false,
            ...(call.toolUse.id === "1"
              ? {
                  postExecutionEffect: () => {
                    throw postExecutionError;
                  },
                }
              : {}),
          },
          run: async () => ({ resultJson: call.toolUse.id }),
          finalize: async () => {
            finalized.push(call.toolUse.id);
            return {
              toolResult: {
                type: "tool_result" as const,
                tool_use_id: call.toolUse.id,
                content: "ok",
              },
            };
          },
        },
      }),
    });

    expect(outcome.toolResults.map((result) => result.tool_use_id)).toEqual(["1", "2"]);
    expect(finalized).toEqual(["1", "2"]);
    expect(outcome.fatalError).toBe(postExecutionError);
    expect(outcome.callReports[0]?.metadata).toMatchObject({
      schedulerHookFailure: "post_execution_effect",
      schedulerHookError: "post effect failed",
    });
  });

  it("returns an error result for a throwing finalizer and continues sibling calls", async () => {
    const scheduler = new ToolScheduler();
    const finalizeError = new Error("finalizer failed");

    const outcome = await scheduler.executeBatch({
      calls: [
        { index: 0, toolUse: { type: "tool_use", id: "1", name: "write_file", input: {} } },
        { index: 1, toolUse: { type: "tool_use", id: "2", name: "write_file", input: {} } },
      ],
      prepareCall: async (call) => ({
        status: "scheduled" as const,
        call: {
          ...call,
          toolName: call.toolUse.name,
          input: call.toolUse.input,
          spec: {
            concurrencyClass: "exclusive" as const,
            readOnly: false,
            idempotent: false,
          },
          run: async () => ({ resultJson: call.toolUse.id }),
          finalize: async () => {
            if (call.toolUse.id === "1") throw finalizeError;
            return {
              toolResult: {
                type: "tool_result" as const,
                tool_use_id: call.toolUse.id,
                content: "ok",
              },
            };
          },
        },
      }),
    });

    expect(outcome.toolResults).toHaveLength(2);
    expect(outcome.toolResults[0]).toMatchObject({
      tool_use_id: "1",
      is_error: true,
    });
    expect(outcome.toolResults[1]?.tool_use_id).toBe("2");
    expect(outcome.toolResults[1]?.is_error).not.toBe(true);
    expect(outcome.fatalError).toBe(finalizeError);
  });

  it("keeps all tool results when batch summarization throws", async () => {
    const scheduler = new ToolScheduler();
    const summaryError = new Error("summary failed");

    const outcome = await scheduler.executeBatch({
      calls: [
        { index: 0, toolUse: { type: "tool_use", id: "1", name: "read_file", input: {} } },
        { index: 1, toolUse: { type: "tool_use", id: "2", name: "read_file", input: {} } },
      ],
      summarizeBatch: async () => {
        throw summaryError;
      },
      prepareCall: async (call) => ({
        status: "scheduled" as const,
        call: {
          ...call,
          toolName: call.toolUse.name,
          input: call.toolUse.input,
          spec: {
            concurrencyClass: "read_parallel" as const,
            readOnly: true,
            idempotent: true,
          },
          run: async () => ({ resultJson: call.toolUse.id }),
          finalize: async () => ({
            toolResult: {
              type: "tool_result" as const,
              tool_use_id: call.toolUse.id,
              content: "ok",
            },
          }),
        },
      }),
    });

    expect(outcome.toolResults.map((result) => result.tool_use_id)).toEqual(["1", "2"]);
    expect(outcome.fatalError).toBe(summaryError);
    expect(outcome.batches[0]?.semanticSummary).toBeUndefined();
  });
  it.each(["prepare", "finalize"])(
    "stops unstarted calls and retains all results after a %s failure",
    async (failureStage) => {
      const failure = new Error("fixture hook failure");
      const run = vi.fn(async () => ({ resultJson: "ok" }));
      const prepareCall = vi.fn(async (call) => {
        if (failureStage === "prepare" && call.index === 1) throw failure;
        return {
          status: "scheduled" as const,
          call: {
            ...call,
            toolName: call.toolUse.name,
            input: call.toolUse.input,
            spec: { concurrencyClass: "exclusive" as const, readOnly: false, idempotent: false },
            run,
            finalize: async (raw: { error?: unknown }) => {
              if (failureStage === "finalize" && call.index === 0) throw failure;
              return {
                toolResult: {
                  type: "tool_result" as const,
                  tool_use_id: call.toolUse.id,
                  content: raw.error ? "skipped" : "ok",
                  ...(raw.error ? { is_error: true } : {}),
                },
              };
            },
          },
        };
      });
      const result = await new ToolScheduler().executeBatch({
        calls: [0, 1, 2].map((index) => ({
          index,
          toolUse: { type: "tool_use" as const, id: String(index), name: "write_file", input: {} },
        })),
        prepareCall,
      });
      expect(result.fatalError).toBe(failure);
      expect(result.toolResults.map((value) => value.tool_use_id)).toEqual(["0", "1", "2"]);
      expect(result.toolResults.every((value) => value.is_error)).toBe(true);
      expect(run).toHaveBeenCalledTimes(failureStage === "prepare" ? 0 : 1);
      expect(prepareCall).toHaveBeenCalledTimes(failureStage === "prepare" ? 2 : 3);
    },
  );
});
