import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  buildDirectRuntimeLaunch,
  forwardSignalsToChild,
  onFirstStopSignal,
  resolveChildProcessExitCode,
  shouldRunDirectRunEntrypoint,
} from "../direct-runtime";

describe("buildDirectRuntimeLaunch", () => {
  it("starts Electron-backed direct runs through the app entry with desktop state", () => {
    const launch = buildDirectRuntimeLaunch(
      {
        executable: "/app/Electron",
        scriptPath: "/app/dist/cli/direct-run.js",
        appPath: "/app/package",
        usesElectron: true,
      },
      ["--prompt", "check settings"],
      {
        ELECTRON_RUN_AS_NODE: "1",
        COWORK_USER_DATA_DIR: "/custom/profile",
        COWORK_PROFILE: "work",
      },
      "darwin",
    );

    expect(launch.args).toEqual([
      "/app/package",
      "--cowork-cli-direct-run",
      "--prompt",
      "check settings",
    ]);
    expect(launch.env).toMatchObject({
      COWORK_HEADLESS: "1",
      COWORK_USER_DATA_DIR: "/custom/profile",
      COWORK_PROFILE: "work",
      NODE_OPTIONS: "--use-system-ca",
    });
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it("keeps the Node-only direct-run fallback for runtimes without Electron", () => {
    const launch = buildDirectRuntimeLaunch(
      {
        executable: "/usr/bin/node",
        scriptPath: "/app/dist/cli/direct-run.js",
        appPath: "/app/package",
        usesElectron: false,
      },
      ["--providers-list"],
      {},
      "linux",
    );

    expect(launch.args).toEqual(["/app/dist/cli/direct-run.js", "--providers-list"]);
    expect(launch.env).toEqual({ COWORK_HEADLESS: "1" });
  });

  it("starts from the caller directory so --cwd can create a new workspace", () => {
    const launch = buildDirectRuntimeLaunch(
      {
        executable: "/app/Electron",
        scriptPath: "/app/dist/cli/direct-run.js",
        appPath: "/app/package",
        usesElectron: true,
      },
      ["--prompt", "check the workspace", "--cwd", "/tmp/new-workspace"],
      {},
      "darwin",
      "/caller/workspace",
    );

    expect(launch.cwd).toBe("/caller/workspace");
    expect(launch.args).toContain("/tmp/new-workspace");
  });

  it("keeps Node mode for Electron-backed runs outside macOS", () => {
    const launch = buildDirectRuntimeLaunch(
      {
        executable: "/app/electron",
        scriptPath: "/app/dist/cli/direct-run.js",
        appPath: "/app/package",
        usesElectron: true,
      },
      ["--providers-list"],
      {},
      "linux",
    );

    expect(launch.args).toEqual(["/app/dist/cli/direct-run.js", "--providers-list"]);
    expect(launch.env).toEqual({ COWORK_HEADLESS: "1", ELECTRON_RUN_AS_NODE: "1" });
  });

  it("keeps an existing ~/.cowork CLI data root unless a user-data dir is set", () => {
    const runtime = {
      executable: "/app/Electron",
      scriptPath: "/app/dist/cli/direct-run.js",
      appPath: "/app/package",
      usesElectron: true,
    };

    expect(
      buildDirectRuntimeLaunch(runtime, [], {}, "darwin", "/caller", "/home/u/.cowork").env
        .COWORK_USER_DATA_DIR,
    ).toBe("/home/u/.cowork");
    expect(
      buildDirectRuntimeLaunch(
        runtime,
        [],
        { COWORK_USER_DATA_DIR: "/custom" },
        "darwin",
        "/caller",
        "/home/u/.cowork",
      ).env.COWORK_USER_DATA_DIR,
    ).toBe("/custom");
    expect(
      buildDirectRuntimeLaunch(runtime, [], {}, "darwin", "/caller", null).env.COWORK_USER_DATA_DIR,
    ).toBeUndefined();
  });

  it("preserves an explicit TLS CA option or development opt-out", () => {
    const runtime = {
      executable: "/app/Electron",
      scriptPath: "/app/dist/cli/direct-run.js",
      appPath: "/app/package",
      usesElectron: true,
    };

    expect(
      buildDirectRuntimeLaunch(runtime, [], { NODE_OPTIONS: "--use-bundled-ca" }, "darwin").env
        .NODE_OPTIONS,
    ).toBe("--use-bundled-ca");
    expect(
      buildDirectRuntimeLaunch(runtime, [], { COWORK_DEV_USE_SYSTEM_CA: "0" }, "darwin").env
        .NODE_OPTIONS,
    ).toBeUndefined();
  });
});

describe("resolveChildProcessExitCode", () => {
  it("maps expected interrupt signals to their conventional exit codes", () => {
    expect(resolveChildProcessExitCode(null, "SIGINT")).toBe(130);
    expect(resolveChildProcessExitCode(null, "SIGTERM")).toBe(143);
  });

  it("does not hide other signal exits or a missing exit code as success", () => {
    expect(resolveChildProcessExitCode(null, "SIGKILL")).toBe(1);
    expect(resolveChildProcessExitCode(null, null)).toBe(1);
  });

  it("preserves a normal child exit code", () => {
    expect(resolveChildProcessExitCode(7, null)).toBe(7);
  });
});

describe("shouldRunDirectRunEntrypoint", () => {
  it("runs when invoked as the main Node module", () => {
    expect(
      shouldRunDirectRunEntrypoint({
        isMainModule: true,
        isElectron: false,
        argv: ["node", "direct-run.js"],
      }),
    ).toBe(true);
  });

  it("runs a standalone Electron direct-run script", () => {
    expect(
      shouldRunDirectRunEntrypoint({
        isMainModule: false,
        isElectron: true,
        argv: ["Electron", "direct-run.js", "--prompt", "say hi"],
      }),
    ).toBe(true);
  });

  it("does not launch a second runner when Electron app mode loads this module", () => {
    expect(
      shouldRunDirectRunEntrypoint({
        isMainModule: false,
        isElectron: true,
        argv: ["Electron", "direct-run.js", "--cowork-cli-direct-run", "--prompt", "say hi"],
      }),
    ).toBe(false);
  });

  it("does not run an imported module in an unrelated Electron app", () => {
    expect(
      shouldRunDirectRunEntrypoint({
        isMainModule: false,
        isElectron: true,
        argv: ["Electron", "/path/to/app"],
      }),
    ).toBe(false);
  });
});

describe("forwardSignalsToChild", () => {
  it("passes SIGTERM and SIGHUP sent to the CLI on to the runner", () => {
    const cli = new EventEmitter();
    const runner = { kill: vi.fn(() => true) };

    const forwarding = forwardSignalsToChild(runner, cli);
    expect(forwarding.received()).toBeNull();
    cli.emit("SIGTERM", "SIGTERM");
    cli.emit("SIGHUP", "SIGHUP");

    expect(runner.kill.mock.calls).toEqual([["SIGTERM"], ["SIGHUP"]]);
    // The CLI was asked to stop, so it ends with the runner instead of carrying on.
    expect(forwarding.received()).toBe("SIGHUP");
  });

  it("leaves SIGINT alone, since Ctrl+C already reaches the runner's process group", () => {
    const cli = new EventEmitter();
    const runner = { kill: vi.fn(() => true) };

    const forwarding = forwardSignalsToChild(runner, cli);

    expect(cli.listenerCount("SIGINT")).toBe(0);
    cli.emit("SIGINT", "SIGINT");
    expect(runner.kill).not.toHaveBeenCalled();
    expect(forwarding.received()).toBeNull();
  });

  it("stops forwarding once the runner has closed", () => {
    const cli = new EventEmitter();
    const runner = { kill: vi.fn(() => true) };

    forwardSignalsToChild(runner, cli).stop();
    cli.emit("SIGTERM", "SIGTERM");

    expect(runner.kill).not.toHaveBeenCalled();
    expect(cli.listenerCount("SIGTERM")).toBe(0);
    expect(cli.listenerCount("SIGHUP")).toBe(0);
  });
});

describe("onFirstStopSignal", () => {
  it("stops once when a process-group kill and the CLI both deliver SIGTERM", () => {
    const runner = new EventEmitter();
    const onStop = vi.fn();

    onFirstStopSignal(onStop, runner);
    runner.emit("SIGTERM", "SIGTERM");
    runner.emit("SIGTERM", "SIGTERM");

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledWith("SIGTERM");
    // Still listening: a repeat with no listener would take the default action and kill the
    // runner before its task is cancelled.
    expect(runner.listenerCount("SIGTERM")).toBe(1);
  });

  it("treats SIGINT, SIGTERM and SIGHUP as one stop", () => {
    const runner = new EventEmitter();
    const onStop = vi.fn();

    onFirstStopSignal(onStop, runner);
    runner.emit("SIGHUP", "SIGHUP");
    runner.emit("SIGINT", "SIGINT");
    runner.emit("SIGTERM", "SIGTERM");

    expect(onStop.mock.calls).toEqual([["SIGHUP"]]);
  });

  it("removes its listeners when the run ends", () => {
    const runner = new EventEmitter();

    const remove = onFirstStopSignal(vi.fn(), runner);
    remove();

    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      expect(runner.listenerCount(signal)).toBe(0);
    }
  });
});
