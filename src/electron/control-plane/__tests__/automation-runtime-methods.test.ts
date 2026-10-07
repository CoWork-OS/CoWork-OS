import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationRuntime, setAutomationRuntime } from "../../automation/AutomationRuntime";
import { registerAutomationRuntimeMethods } from "../registerAutomationRuntimeMethods";
import type { ControlPlaneServer } from "../server";
import { Methods } from "../protocol";
afterEach(() => setAutomationRuntime(null));
describe("automation runtime status", () => {
  it("checks read scope before exposing status", async () => {
    const registerMethod = vi.fn();
    const requireScope = vi.fn(() => {
      throw new Error("denied");
    });
    registerAutomationRuntimeMethods({
      server: { registerMethod } as unknown as ControlPlaneServer,
      requireScope,
    });
    expect(registerMethod.mock.calls[0][0]).toBe(Methods.AUTOMATION_RUNTIME_STATUS);
    await expect(registerMethod.mock.calls[0][1]({})).rejects.toThrow("denied");
  });
  it("distinguishes unavailable from a running host with uninitialized services", async () => {
    const registerMethod = vi.fn();
    registerAutomationRuntimeMethods({
      server: { registerMethod } as unknown as ControlPlaneServer,
      requireScope: vi.fn(),
    });
    expect(await registerMethod.mock.calls[0][1]({})).toMatchObject({ runtime: "unavailable" });
    setAutomationRuntime(new AutomationRuntime("node"));
    expect(await registerMethod.mock.calls[0][1]({})).toMatchObject({
      runtime: "node",
      capabilities: { desktopInteraction: "waiting_for_desktop" },
    });
  });
});
