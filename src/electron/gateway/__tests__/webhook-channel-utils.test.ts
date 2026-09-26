import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeE164 } from "../channels/webhook-channel-utils";
import { ThrottledWarning, WebhookChannelState } from "../channels/webhook-channel-state";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webhook-state-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("WebhookChannelState", () => {
  it("deduplicates inbound events for 24 hours", () => {
    const state = new WebhookChannelState();
    expect(state.enqueueInbound("a", {}, 0)).toBe(true);
    state.completeInbound("a");
    expect(state.enqueueInbound("a", {}, 1000)).toBe(false);
    expect(state.enqueueInbound("a", {}, 25 * 3600 * 1000)).toBe(true);
  });

  it("persists the spool, dedup ids and held replies across instances", () => {
    const dir = tempDir();
    const first = new WebhookChannelState(dir);
    first.enqueueInbound("msg-1", { body: "hi" });
    first.holdReply("+1555", { text: "later", heldAt: 1 });
    first.flush();

    const second = new WebhookChannelState(dir);
    expect(second.dueInbound().map((entry) => entry.id)).toEqual(["msg-1"]);
    expect(second.enqueueInbound("msg-1", {})).toBe(false);
    expect(second.takeHeldReplies("+1555").map((reply) => reply.text)).toEqual(["later"]);
    expect(fs.statSync(path.join(dir, "state.json")).mode & 0o077).toBe(0);
  });

  it("backs off failed inbound events and gives up after the attempt limit", () => {
    const state = new WebhookChannelState();
    state.enqueueInbound("x", {}, 0);
    expect(state.failInbound("x", "boom", 3, 0)).toBe(60_000);
    expect(state.dueInbound(30_000)).toHaveLength(0);
    expect(state.dueInbound(60_000)).toHaveLength(1);
    expect(state.failInbound("x", "boom", 3, 60_000)).toBe(120_000);
    expect(state.failInbound("x", "boom", 3, 200_000)).toBeNull();
    expect(state.dueInbound(Number.MAX_SAFE_INTEGER - 1)).toHaveLength(0);
    expect(state.snapshot().failedInbound).toEqual([{ id: "x", attempts: 3, lastError: "boom" }]);
  });

  it("summarises deliveries and failures", () => {
    const state = new WebhookChannelState();
    const now = Date.now();
    state.recordDelivery({
      messageId: "1",
      chatId: "c",
      state: "delivered",
      timestamp: new Date(now),
    });
    state.recordDelivery({
      messageId: "2",
      chatId: "c",
      state: "undelivered",
      timestamp: new Date(now),
      errorCode: "30003",
    });
    const snapshot = state.snapshot(now);
    expect(snapshot.deliveryCounts).toEqual({ delivered: 1, undelivered: 1 });
    expect(snapshot.recentDeliveryFailures[0]).toMatchObject({
      messageId: "2",
      errorCode: "30003",
    });
  });
});

describe("ThrottledWarning", () => {
  it("emits at most once per interval and reports suppressed repeats", () => {
    const warning = new ThrottledWarning(1000);
    expect(warning.next("bad", 0)).toBe("bad");
    expect(warning.next("bad", 500)).toBeNull();
    expect(warning.next("bad", 1500)).toBe("bad (1 similar rejections suppressed)");
  });
});

describe("normalizeE164", () => {
  it("accepts international formats and rejects national numbers", () => {
    expect(normalizeE164("+1 (555) 000-1111")).toBe("+15550001111");
    expect(normalizeE164("0044 20 7946 0000")).toBe("+442079460000");
    expect(normalizeE164("5550001111")).toBeNull();
    expect(normalizeE164("+0123456789")).toBeNull();
    expect(normalizeE164("+1234")).toBeNull();
  });
});
