import { describe, expect, it, vi } from "vitest";
import { isUntrustedExternalSource } from "../export-permission-context";
import { recordUntrustedContentRead, untrustedContentSource } from "../untrusted-content-source";

describe("untrusted content sources (memory repo taint, design §7.3)", () => {
  it("builds refs that the taint check classifies as untrusted", () => {
    for (const channel of ["web", "browser", "mailbox", "channel"] as const) {
      expect(isUntrustedExternalSource(untrustedContentSource(channel, "x://y", "tool"))).toBe(
        true,
      );
    }
  });

  it("keeps only the origin and path of a URL", () => {
    expect(
      untrustedContentSource(
        "web",
        "https://user:pw@example.com/a/b?token=secret#frag",
        "web_fetch",
      ),
    ).toMatchObject({
      path: "https://example.com/a/b",
      sourceKind: "unknown",
      trustLevel: "untrusted",
      sourceLabel: "web",
      metadata: { tool: "web_fetch" },
    });
    expect(untrustedContentSource("mailbox", "mailbox://threads/t-1", "mailbox_action").path).toBe(
      "mailbox://threads/t-1",
    );
  });

  it("records through the daemon and never throws without a runtime", () => {
    const daemon = { recordSensitiveSourceRead: vi.fn() };
    recordUntrustedContentRead(
      daemon,
      "task-1",
      "channel",
      "channel://slack/C1",
      "channel_history",
    );
    expect(daemon.recordSensitiveSourceRead).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ path: "channel://slack/C1", trustLevel: "untrusted" }),
    );
    expect(() => recordUntrustedContentRead({}, "task-1", "web", "https://a.b", "t")).not.toThrow();
    const throwing = {
      recordSensitiveSourceRead: () => {
        throw new Error("no runtime");
      },
    };
    expect(() =>
      recordUntrustedContentRead(throwing, "task-1", "web", "https://a.b", "t"),
    ).not.toThrow();
  });
});
