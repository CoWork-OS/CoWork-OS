import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "../control-plane-client";
import { main, parseArgs, parseInteractiveCommand } from "../main";

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
