import { describe, expect, it, vi } from "vitest";
import {
  DIRECT_RUN_INJECTED_SYSTEM_CA_ENV,
  keepDirectRunAliveWithoutWindows,
  stripInjectedSystemCaOption,
} from "../direct-run-lifecycle";

describe("keepDirectRunAliveWithoutWindows", () => {
  it("registers a window-close listener so a hidden bootstrap window cannot quit a task run", () => {
    const app = { on: vi.fn() };

    keepDirectRunAliveWithoutWindows(app as never);

    expect(app.on).toHaveBeenCalledOnce();
    expect(app.on.mock.calls[0]?.[0]).toBe("window-all-closed");
    expect(app.on.mock.calls[0]?.[1]).toBeTypeOf("function");
  });
});

describe("stripInjectedSystemCaOption", () => {
  it("removes only the injected flag so child processes don't inherit it", () => {
    const env: NodeJS.ProcessEnv = {
      NODE_OPTIONS: "--max-old-space-size=4096 --use-system-ca",
      [DIRECT_RUN_INJECTED_SYSTEM_CA_ENV]: "1",
    };

    stripInjectedSystemCaOption(env);

    expect(env.NODE_OPTIONS).toBe("--max-old-space-size=4096");
    expect(env[DIRECT_RUN_INJECTED_SYSTEM_CA_ENV]).toBeUndefined();
  });

  it("leaves a user-provided flag alone", () => {
    const env: NodeJS.ProcessEnv = { NODE_OPTIONS: "--use-system-ca" };

    stripInjectedSystemCaOption(env);

    expect(env.NODE_OPTIONS).toBe("--use-system-ca");
  });
});
