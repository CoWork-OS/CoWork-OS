import { describe, expect, it, vi } from "vitest";
import type { TaskEvent } from "../../../shared/types";
import { ComposerDraftStore } from "../../state/composer-draft-store";
import { createComposerSubmissionAcceptance } from "../composer-submission-acceptance";

const receipt = (status = "accepted", taskId = "task", messageId = "message"): TaskEvent => ({
  id: "receipt",
  taskId,
  type: "user_message",
  timestamp: 1,
  schemaVersion: 2,
  payload: { messageId, deliveryMode: "follow_up", deliveryStatus: status },
});

describe("composer submission acceptance", () => {
  it.each(["queued", "started", "accepted"])(
    "clears the saved draft on a %s receipt while send IPC remains pending",
    async (status) => {
      const clear = vi.fn(async () => ({ cleared: true, releasedAttachments: 0 }));
      const store = new ComposerDraftStore({ transport: { clear } });
      const owner = { scope: "local" as const, workspaceId: "workspace", taskId: "task" };
      const draft = store.update(owner, { text: "Sent follow-up" });
      const acceptance = createComposerSubmissionAcceptance("task", "message");
      const sending = acceptance.waitFor(new Promise<boolean>(() => {})).then(async (sent) => {
        if (sent !== false) await store.clearAfterAcceptedDraft(draft, draft.revision);
      });

      acceptance.observe([receipt(status)]);
      await sending;

      expect(store.get(draft.draftKey)).toBeNull();
      expect(clear).toHaveBeenCalledOnce();
    },
  );

  it("preserves a newer draft when an older send receives its receipt", async () => {
    const store = new ComposerDraftStore();
    const owner = { scope: "local" as const, workspaceId: "workspace", taskId: "task" };
    const submitted = store.update(owner, { text: "Sent follow-up" });
    const acceptance = createComposerSubmissionAcceptance("task", "message");
    const sent = acceptance.waitFor(new Promise<boolean>(() => {}));
    const newer = store.update(owner, { text: "Still typing" });
    acceptance.observe([receipt()]);
    await sent;

    expect(await store.clearAfterAcceptedDraft(submitted, submitted.revision)).toBe(false);
    expect(store.get(newer.draftKey)?.text).toBe("Still typing");
  });

  it("ignores other messages, owners, event types, and failed receipts", () => {
    const acceptance = createComposerSubmissionAcceptance("task", "message");
    acceptance.observe([
      receipt("accepted", "other-task"),
      receipt("accepted", "task", "other-message"),
      { ...receipt(), type: "assistant_message" },
      receipt("failed"),
      { ...receipt(), payload: { ...receipt().payload, deliveryMode: "message" } },
    ]);
    expect(acceptance.hasReceipt()).toBe(false);
  });

  it("retains failure behavior when sending fails before any receipt", async () => {
    const acceptance = createComposerSubmissionAcceptance("task", "message");
    await expect(acceptance.waitFor(false)).resolves.toBe(false);
    await expect(acceptance.waitFor(Promise.reject(new Error("Offline")))).rejects.toThrow(
      "Offline",
    );
    expect(acceptance.hasReceipt()).toBe(false);
  });

  it("does not undo acceptance when IPC later fails", async () => {
    const acceptance = createComposerSubmissionAcceptance("task", "message");
    let reject!: (error: Error) => void;
    const sent = acceptance.waitFor(
      new Promise<boolean>((_, fail) => {
        reject = fail;
      }),
    );
    acceptance.observe([receipt()]);
    await expect(sent).resolves.toBe(true);
    reject(new Error("Reply lost after admission"));
    expect(acceptance.hasReceipt()).toBe(true);
  });

  it("still accepts a successful IPC response without timeline events", async () => {
    const acceptance = createComposerSubmissionAcceptance("task", "message");
    await expect(acceptance.waitFor(true)).resolves.toBe(true);
  });
});
