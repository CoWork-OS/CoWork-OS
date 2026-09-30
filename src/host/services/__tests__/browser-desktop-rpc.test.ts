import { describe, expect, it, vi } from "vitest";
import type { HostIdentity } from "../../../shared/host-api/contracts";
import { WebApplicationError, type WebRequestContext } from "../../web/WebApplication";
import { BrowserDesktopRpcService } from "../browser-desktop-rpc";

const identity: HostIdentity = {
  installationId: "installation-one",
  profileId: "profile-one",
  generation: "generation-one",
  runtime: "node",
  platform: "linux",
  appVersion: "1.0.0",
};

function context(overrides: Partial<WebRequestContext> = {}): WebRequestContext {
  return {
    audience: "browser",
    identity,
    sessionId: "session-one",
    operationKey: "operation-12345678",
    ...overrides,
  };
}

async function invoke(
  service: BrowserDesktopRpcService,
  name: string,
  args: unknown[],
  requestContext = context(),
): Promise<unknown> {
  const method = service.methods()[`desktop.${name}`];
  if (!method) throw new Error(`Missing desktop method ${name}`);
  const params = method.validateParams!({ args });
  return method.handler(requestContext, params);
}

async function invokeEnvelope(
  service: BrowserDesktopRpcService,
  name: string,
  envelope: unknown,
  requestContext = context(),
): Promise<unknown> {
  const method = service.methods()[`desktop.${name}`];
  if (!method) throw new Error(`Missing desktop method ${name}`);
  const params = method.validateParams!(envelope);
  return method.handler(requestContext, params);
}

describe("BrowserDesktopRpcService", () => {
  it("exposes only its closed method table and validates the fixed args envelope", async () => {
    const service = new BrowserDesktopRpcService({
      renameTask: {
        minArgs: 2,
        maxArgs: 2,
        handler: vi.fn(async () => "renamed"),
      },
    });
    const methods = service.methods();

    expect(service.methodNames).toEqual(["renameTask"]);
    expect(Object.keys(methods)).toEqual(["desktop.renameTask"]);
    expect(methods["desktop.invoke"] ?? methods["desktop.ipc:delete"]).toBeUndefined();
    expect(() =>
      methods["desktop.renameTask"].validateParams!({ args: [], channel: "delete" }),
    ).toThrow(WebApplicationError);
    await expect(invoke(service, "renameTask", ["only-one-argument"])).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });

  it("normalizes undefined desktop results to null", async () => {
    const handler = vi.fn(async () => undefined);
    const service = new BrowserDesktopRpcService({
      readStatus: { handler },
    });

    await expect(invoke(service, "readStatus", [])).resolves.toBeNull();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("restores an omitted middle argument while preserving an explicit null argument", async () => {
    const handler = vi.fn(async (args: unknown[]) => args);
    const service = new BrowserDesktopRpcService({
      listRoutineWorkflowRuns: {
        minArgs: 3,
        maxArgs: 3,
        handler,
      },
    });
    const method = service.methods()["desktop.listRoutineWorkflowRuns"];

    const omitted = method.validateParams!({
      args: ["task-one", null, 60],
      omittedArgs: [1],
    });
    expect(omitted).toEqual(["task-one", undefined, 60]);
    await expect(method.handler(context(), omitted)).resolves.toEqual(["task-one", undefined, 60]);

    await expect(
      invokeEnvelope(service, "listRoutineWorkflowRuns", { args: ["task-one", null, 60] }),
    ).resolves.toEqual(["task-one", null, 60]);
    expect(handler).toHaveBeenNthCalledWith(1, ["task-one", undefined, 60], expect.any(Object));
    expect(handler).toHaveBeenNthCalledWith(2, ["task-one", null, 60], expect.any(Object));
  });

  it("rejects out-of-range, duplicate, and non-null omitted argument markers", () => {
    const service = new BrowserDesktopRpcService({
      listRoutineWorkflowRuns: {
        minArgs: 3,
        maxArgs: 3,
        handler: vi.fn(),
      },
    });
    const validate = service.methods()["desktop.listRoutineWorkflowRuns"].validateParams!;

    for (const omittedArgs of [[-1], [3], [1, 1], ["1"]]) {
      expect(() => validate({ args: ["task-one", null, 60], omittedArgs })).toThrowError(
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
    }
    expect(() => validate({ args: ["task-one", "present", 60], omittedArgs: [1] })).toThrowError(
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("coalesces concurrent same-key mutations and reuses a confirmed receipt", async () => {
    let release!: (value: string) => void;
    const completion = new Promise<string>((resolve) => {
      release = resolve;
    });
    const handler = vi.fn(async () => completion);
    const service = new BrowserDesktopRpcService({
      savePreference: { mutation: true, handler },
    });

    const first = invoke(service, "savePreference", ["theme", "dark"]);
    const concurrent = invoke(service, "savePreference", ["theme", "dark"]);
    await Promise.resolve();
    expect(handler).toHaveBeenCalledTimes(1);
    release("saved");

    await expect(Promise.all([first, concurrent])).resolves.toEqual(["saved", "saved"]);
    await expect(invoke(service, "savePreference", ["theme", "dark"])).resolves.toBe("saved");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rejects changed content that reuses an operation key", async () => {
    const handler = vi.fn(async ([value]: unknown[]) => value);
    const service = new BrowserDesktopRpcService({
      writeValue: { mutation: true, handler },
    });
    const first = context({ operationKey: "same-operation-key" });
    await expect(invoke(service, "writeValue", ["first"], first)).resolves.toBe("first");

    await expect(invoke(service, "writeValue", ["changed"], first)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("fingerprints an omitted argument differently from an explicit null", async () => {
    const handler = vi.fn(async () => "called");
    const service = new BrowserDesktopRpcService({
      listRoutineWorkflowRuns: {
        mutation: true,
        minArgs: 3,
        maxArgs: 3,
        handler,
      },
    });
    const requestContext = context({ operationKey: "routine-list-operation" });

    await expect(
      invokeEnvelope(
        service,
        "listRoutineWorkflowRuns",
        { args: ["task-one", null, 60], omittedArgs: [1] },
        requestContext,
      ),
    ).resolves.toBe("called");
    await expect(
      invokeEnvelope(
        service,
        "listRoutineWorkflowRuns",
        { args: ["task-one", null, 60] },
        requestContext,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("caches an uncertain rejection and never dispatches that operation key again", async () => {
    const handler = vi.fn(async () => {
      throw new Error("reply lost after the write");
    });
    const service = new BrowserDesktopRpcService({
      submitDecision: { mutation: true, handler },
    });
    const requestContext = context({ operationKey: "uncertain-operation" });

    await expect(
      invoke(service, "submitDecision", ["approve"], requestContext),
    ).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
    });
    await expect(
      invoke(service, "submitDecision", ["approve"], requestContext),
    ).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      message: expect.stringContaining("did not confirm"),
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("isolates receipts by session and releases only the revoked session", async () => {
    const handler = vi.fn(async ([value]: unknown[]) => value);
    const service = new BrowserDesktopRpcService({
      updateSetting: { mutation: true, handler },
    });
    const sessionOne = context({ sessionId: "session-one", operationKey: "shared-key" });
    const sessionTwo = context({ sessionId: "session-two", operationKey: "shared-key" });

    await expect(invoke(service, "updateSetting", ["dark"], sessionOne)).resolves.toBe("dark");
    await expect(invoke(service, "updateSetting", ["dark"], sessionTwo)).resolves.toBe("dark");
    expect(handler).toHaveBeenCalledTimes(2);

    service.revokeSession("session-one");
    await expect(invoke(service, "updateSetting", ["dark"], sessionTwo)).resolves.toBe("dark");
    await expect(invoke(service, "updateSetting", ["dark"], sessionOne)).resolves.toBe("dark");
    expect(handler).toHaveBeenCalledTimes(3);
  });
});
