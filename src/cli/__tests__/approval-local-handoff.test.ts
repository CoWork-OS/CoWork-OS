import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../main";
import { parseCliApprovalResponse } from "../../electron/agent/approval-cli";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(spawn).mockReset();
});

describe("local CLI displayed approval handoff", () => {
  it.each(["approve", "reject"])(
    "carries the reviewed revision through %s process arguments",
    async (command) => {
      let stdout = "";
      vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
        stdout += String(chunk);
        return true;
      });
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      vi.mocked(spawn).mockImplementation(() => {
        const child = new EventEmitter();
        queueMicrotask(() => child.emit("close", 0));
        return child as never;
      });
      const hash = "a".repeat(64);
      expect(await main([command, "approval-1", "--revision-hash", hash])).toBe(0);
      expect(vi.mocked(spawn).mock.calls).toHaveLength(1);
      const argv = vi.mocked(spawn).mock.calls[0][1] as string[];
      expect(parseCliApprovalResponse(argv)).toEqual({
        approvalId: "approval-1",
        approved: command === "approve",
        expectedRevisionHash: hash,
      });
      expect(stdout).toContain("Sent");
      expect(stdout).not.toContain("Approved approval");
    },
  );
});
