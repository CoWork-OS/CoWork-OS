import { describe, expect, it, vi } from "vitest";
import { probeFirstTaskModel } from "../model-preflight";

describe("first task model probe", () => {
  it("requires a real tool call from the selected model", async () => {
    const createMessage = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "done" }] });
    expect(await probeFirstTaskModel({ createMessage }, "chosen-model")).toMatchObject({
      endpoint: "pass",
      model: "pass",
      toolCalls: "fail",
      reason: "tool_support",
    });
    expect(createMessage.mock.calls[0][0].model).toBe("chosen-model");
    createMessage.mockResolvedValue({
      content: [{ type: "tool_use", id: "1", name: "sample_probe", input: { code: "OK" } }],
    });
    expect(await probeFirstTaskModel({ createMessage }, "chosen-model")).toMatchObject({
      endpoint: "pass",
      model: "pass",
      toolCalls: "pass",
    });
  });

  it("keeps authentication, model, and endpoint failures distinct", async () => {
    const createMessage = vi.fn();
    createMessage.mockRejectedValueOnce(Object.assign(new Error("denied"), { status: 401 }));
    expect((await probeFirstTaskModel({ createMessage }, "m")).reason).toBe("authentication");
    createMessage.mockRejectedValueOnce(
      Object.assign(new Error("model not found"), { status: 404 }),
    );
    expect((await probeFirstTaskModel({ createMessage }, "m")).reason).toBe("model");
    createMessage.mockRejectedValueOnce(Object.assign(new Error("missing"), { status: 404 }));
    expect((await probeFirstTaskModel({ createMessage }, "m")).endpoint).toBe("unknown");
    createMessage.mockRejectedValueOnce(new Error("connection refused"));
    expect((await probeFirstTaskModel({ createMessage }, "m")).reason).toBe("endpoint");
  });

  it("bounds a provider call even when it ignores abort", async () => {
    const createMessage = vi.fn().mockReturnValue(new Promise(() => undefined));
    expect((await probeFirstTaskModel({ createMessage }, "m", 5)).reason).toBe("timeout");
  });
});
