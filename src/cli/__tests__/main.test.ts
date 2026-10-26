import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { ControlPlaneClient } from "../control-plane-client";
import {
  buildDirectTaskArgs,
  main,
  parseArgs,
  parseInteractiveCommand,
  waitForDaemonReady,
} from "../main";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CLI argument parsing", () => {
  it("separates command, positional args, and value flags", () => {
    const parsed = parseArgs([
      "run",
      "write a brief",
      "--cwd",
      "/tmp/project",
      "--workspace-id",
      "ws-1",
      "--no-follow",
    ]);

    expect(parsed.command).toBe("run");
    expect(parsed.rest).toEqual(["write a brief"]);
    expect(parsed.flags.get("--cwd")).toBe("/tmp/project");
    expect(parsed.flags.get("--workspace-id")).toBe("ws-1");
    expect(parsed.flags.get("--no-follow")).toBe(true);
  });

  it("keeps subcommands as positional args", () => {
    const parsed = parseArgs(["providers", "configure", "openai", "--model", "gpt-4.1-mini"]);

    expect(parsed.command).toBe("providers");
    expect(parsed.rest).toEqual(["configure", "openai"]);
    expect(parsed.flags.get("--model")).toBe("gpt-4.1-mini");
  });

  it("parses task lifecycle flags", () => {
    const parsed = parseArgs(["tasks", "list", "--active", "--cli", "--limit", "20"]);

    expect(parsed.command).toBe("tasks");
    expect(parsed.rest).toEqual(["list"]);
    expect(parsed.flags.get("--active")).toBe(true);
    expect(parsed.flags.get("--cli")).toBe(true);
    expect(parsed.flags.get("--limit")).toBe("20");
  });

  it("parses detached forced run flags", () => {
    const parsed = parseArgs(["run", "doctor", "--force", "--detach"]);

    expect(parsed.command).toBe("run");
    expect(parsed.rest).toEqual(["doctor"]);
    expect(parsed.flags.get("--force")).toBe(true);
    expect(parsed.flags.get("--detach")).toBe(true);
  });

  it("parses the access profile selector for task runs", () => {
    const parsed = parseArgs([
      "run",
      "inspect the repo",
      "--access-profile",
      "full_access",
      "--permission-mode",
      "default",
    ]);

    expect(parsed.command).toBe("run");
    expect(parsed.rest).toEqual(["inspect the repo"]);
    expect(parsed.flags.get("--access-profile")).toBe("full_access");
    expect(parsed.flags.get("--permission-mode")).toBe("default");
  });
});

describe("local cowork run arguments", () => {
  it("passes --exit-on-input and --timeout-ms to the direct runner", () => {
    const args = buildDirectTaskArgs(
      parseArgs([
        "run",
        "Reply with READY",
        "--cwd",
        "/tmp/project",
        "--access-profile",
        "desk-test",
        "--exit-on-input",
        "--timeout-ms",
        "120000",
      ]),
      "Reply with READY",
    );

    expect(args).toEqual([
      "--prompt",
      "Reply with READY",
      "--cwd",
      path.resolve("/tmp/project"),
      "--access-profile",
      "desk-test",
      "--exit-on-input",
      "--timeout-ms",
      "120000",
    ]);
  });

  it("passes --timeout-ms without a value so the runner rejects it", () => {
    const args = buildDirectTaskArgs(parseArgs(["run", "hi", "--timeout-ms"]), "hi");

    expect(args.slice(-2)).toEqual(["--timeout-ms", ""]);
  });

  it("sets no limit when --timeout-ms is absent", () => {
    expect(buildDirectTaskArgs(parseArgs(["run", "hi"]), "hi")).not.toContain("--timeout-ms");
  });
});

describe("daemon readiness handshake", () => {
  it.each(["exit", "error"])("fails promptly when the launcher emits %s", async (event) => {
    const child = new EventEmitter();
    const pending = waitForDaemonReady(child as never, "missing-readiness-file", 1000);
    child.emit(event, event === "error" ? new Error("startup failed") : 1);
    await expect(pending).resolves.toBe(false);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
  });

  it("times out without leaving launcher listeners attached", async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter();
      const pending = waitForDaemonReady(child as never, "missing-readiness-file", 1000);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(pending).resolves.toBe(false);
      expect(child.listenerCount("exit")).toBe(0);
      expect(child.listenerCount("error")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a readiness marker from another process and accepts the matching child", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cowork-ready-")), "ready.json");
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      exitCode: null;
      signalCode: null;
    };
    child.pid = 4242;
    child.exitCode = null;
    child.signalCode = null;
    fs.writeFileSync(file, JSON.stringify({ pid: 7001, launcherPid: 7, ready: true }));
    let settled = false;
    const pending = waitForDaemonReady(child as never, file).then((ready) => {
      settled = true;
      return ready;
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(settled).toBe(false);
    fs.writeFileSync(file, JSON.stringify({ pid: 7001, launcherPid: 4242, ready: true }));
    await expect(pending).resolves.toBe(true);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });
});

describe("interactive command parsing", () => {
  it("treats free text as a task prompt", () => {
    expect(parseInteractiveCommand("summarize this repo")).toEqual(["run", "summarize this repo"]);
  });

  it("maps slash commands to CLI argv", () => {
    expect(parseInteractiveCommand("/workspace list")).toEqual(["workspace", "list"]);
    expect(parseInteractiveCommand("/tasks list --active")).toEqual(["tasks", "list", "--active"]);
    expect(parseInteractiveCommand('/providers configure openai --model "gpt-4.1-mini"')).toEqual([
      "providers",
      "configure",
      "openai",
      "--model",
      "gpt-4.1-mini",
    ]);
  });

  it("supports exit aliases", () => {
    expect(parseInteractiveCommand("/exit")).toEqual(["exit"]);
    expect(parseInteractiveCommand("/quit")).toEqual(["exit"]);
  });
});

describe("run command guard", () => {
  it("rejects exact CLI command names as task prompts without --force", async () => {
    let stderr = "";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    });

    const code = await main(["run", "doctor"]);

    expect(code).toBe(1);
    expect(stderr).toContain("Did you mean `cowork doctor`?");
    expect(stderr).toContain("cowork run --force doctor");
  });
});

describe("remote run session naming", () => {
  it.each([undefined, "My session name"])(
    "generates a name unless --title is supplied: %s",
    async (title) => {
      vi.spyOn(ControlPlaneClient.prototype, "connect").mockResolvedValue();
      const request = vi.spyOn(ControlPlaneClient.prototype, "request").mockResolvedValue({
        taskId: "task-1",
        task: { id: "task-1", title: "Placeholder" },
      });
      vi.spyOn(ControlPlaneClient.prototype, "close").mockImplementation(() => {});
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      expect(
        await main([
          "run",
          "what is 2+2?",
          "--remote",
          "--workspace-id",
          "ws-1",
          "--token",
          "test-token",
          "--json",
          ...(title ? ["--title", title] : []),
        ]),
      ).toBe(0);
      expect(request).toHaveBeenCalledWith(
        "task.create",
        expect.objectContaining({
          title: title || "what is 2+2?",
          generateTitle: !title,
        }),
        30000,
      );
    },
  );
});

describe("run model pin", () => {
  it("forwards --provider and --model to the local direct runner", () => {
    const args = buildDirectTaskArgs(
      parseArgs([
        "run",
        "make the deck",
        "--cwd",
        "/tmp/project",
        "--provider",
        "openrouter",
        "--model",
        "moonshotai/kimi-k3",
      ]),
      "make the deck",
    );

    expect(args).toEqual([
      "--prompt",
      "make the deck",
      "--cwd",
      "/tmp/project",
      "--provider",
      "openrouter",
      "--model",
      "moonshotai/kimi-k3",
    ]);
  });

  it("leaves the model out when no flag is passed", () => {
    const args = buildDirectTaskArgs(parseArgs(["run", "hi", "--cwd", "/tmp/project"]), "hi");

    expect(args).not.toContain("--provider");
    expect(args).not.toContain("--model");
  });

  it("sends the pin in agentConfig for --remote runs", async () => {
    vi.spyOn(ControlPlaneClient.prototype, "connect").mockResolvedValue();
    const request = vi.spyOn(ControlPlaneClient.prototype, "request").mockResolvedValue({
      taskId: "task-1",
      task: { id: "task-1", title: "Placeholder" },
    });
    vi.spyOn(ControlPlaneClient.prototype, "close").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    expect(
      await main([
        "run",
        "make the deck",
        "--remote",
        "--workspace-id",
        "ws-1",
        "--token",
        "test-token",
        "--json",
        "--access-profile",
        "full_access",
        "--provider",
        "openai_compatible",
        "--model",
        "local-27b",
      ]),
    ).toBe(0);
    expect(request).toHaveBeenCalledWith(
      "task.create",
      expect.objectContaining({
        accessProfileId: "full_access",
        agentConfig: {
          providerType: "openai-compatible",
          modelKey: "local-27b",
          modelPinned: true,
        },
      }),
      30000,
    );
  });

  it("refuses --remote --provider without --model before connecting", async () => {
    const connect = vi.spyOn(ControlPlaneClient.prototype, "connect").mockResolvedValue();
    let stderr = "";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    });

    const code = await main([
      "run",
      "make the deck",
      "--remote",
      "--workspace-id",
      "ws-1",
      "--token",
      "test-token",
      "--provider",
      "openrouter",
    ]);

    expect(code).toBe(1);
    expect(stderr).toContain("With --remote, pass --model too");
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("CLI displayed approval revisions", () => {
  it.each([undefined, "latest", "A".repeat(64)])(
    "refuses an unreviewed revision %s before sending",
    async (hash) => {
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const connect = vi.spyOn(ControlPlaneClient.prototype, "connect").mockResolvedValue();
      const request = vi
        .spyOn(ControlPlaneClient.prototype, "request")
        .mockResolvedValue({ status: "handled" });
      expect(
        await main([
          "approve",
          "approval-1",
          "--remote",
          "--token",
          "fixture",
          ...(hash ? ["--revision-hash", hash] : []),
        ]),
      ).toBe(1);
      expect(connect).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each(["handled", "duplicate", "not_found", "in_progress", "unknown"])(
    "reports %s without claiming an unconfirmed decision",
    async (status) => {
      let stdout = "";
      let stderr = "";
      vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
        stdout += String(chunk);
        return true;
      });
      vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
        stderr += String(chunk);
        return true;
      });
      vi.spyOn(ControlPlaneClient.prototype, "connect").mockResolvedValue();
      const request = vi
        .spyOn(ControlPlaneClient.prototype, "request")
        .mockResolvedValue({ status });
      const close = vi.spyOn(ControlPlaneClient.prototype, "close").mockImplementation(() => {});
      const hash = "a".repeat(64);
      const code = await main([
        "approve",
        "approval-1",
        "--remote",
        "--token",
        "fixture",
        "--revision-hash",
        hash,
      ]);
      const confirmed = status === "handled" || status === "duplicate";
      expect(code).toBe(confirmed ? 0 : 1);
      expect(request).toHaveBeenCalledWith("approval.respond", {
        approvalId: "approval-1",
        approved: true,
        expectedRevisionHash: hash,
      });
      expect(close).toHaveBeenCalledOnce();
      expect(stdout.includes("Approved approval")).toBe(confirmed);
      expect(Boolean(stderr)).toBe(!confirmed);
    },
  );

  it("binds a rejection to the displayed hash too", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(ControlPlaneClient.prototype, "connect").mockResolvedValue();
    const request = vi
      .spyOn(ControlPlaneClient.prototype, "request")
      .mockResolvedValue({ status: "handled" });
    vi.spyOn(ControlPlaneClient.prototype, "close").mockImplementation(() => {});
    const hash = "b".repeat(64);
    expect(
      await main([
        "reject",
        "approval-1",
        "--remote",
        "--token",
        "fixture",
        "--revision-hash",
        hash,
      ]),
    ).toBe(0);
    expect(request).toHaveBeenCalledWith("approval.respond", {
      approvalId: "approval-1",
      approved: false,
      expectedRevisionHash: hash,
    });
  });
});
