import { describe, expect, it, vi } from "vitest";
import { createPendingAttachmentOwnerFence } from "../MainContent/attachments";

const owner = (workspaceId: string, taskId: string | null = null, deviceId: string | null = null) =>
  JSON.stringify([workspaceId, taskId, deviceId]);

describe("pending attachment ownership", () => {
  it("drops a late file-picker reply after changing the empty composer's workspace", async () => {
    const fence = createPendingAttachmentOwnerFence();
    fence.setOwner(owner("workspace-a"));
    const isCurrentOwner = fence.capture();
    const attach = vi.fn();
    let finishPicker!: (files: string[]) => void;
    const picker = new Promise<string[]>((resolve) => {
      finishPicker = resolve;
    });
    const completion = picker.then((files) => {
      if (isCurrentOwner()) attach(files);
    });

    fence.setOwner(owner("workspace-b"));
    finishPicker(["report.csv"]);
    await completion;

    expect(attach).not.toHaveBeenCalled();
  });

  it("does not revive a pending read when the user returns to the original workspace", () => {
    const fence = createPendingAttachmentOwnerFence();
    fence.setOwner(owner("workspace-a"));
    const isCurrentOwner = fence.capture();

    fence.setOwner(owner("workspace-b"));
    fence.setOwner(owner("workspace-a"));

    expect(isCurrentOwner()).toBe(false);
  });

  it("accepts a file read while the user keeps typing in the same composer", () => {
    const fence = createPendingAttachmentOwnerFence();
    fence.setOwner(owner("workspace-a", "task-a"));
    const isCurrentOwner = fence.capture();

    // Draft revisions and text change on every keystroke; the owner stays the same.
    fence.setOwner(owner("workspace-a", "task-a"));
    fence.setOwner(owner("workspace-a", "task-a"));

    expect(isCurrentOwner()).toBe(true);
  });

  it.each([owner("workspace-a", "task-b"), owner("workspace-a", "task-a", "remote-device")])(
    "invalidates a queued append when its session or device changes: %s",
    (nextOwner) => {
      const fence = createPendingAttachmentOwnerFence();
      fence.setOwner(owner("workspace-a", "task-a"));
      const isCurrentOwner = fence.capture();
      expect(isCurrentOwner()).toBe(true);

      fence.setOwner(nextOwner);

      expect(isCurrentOwner()).toBe(false);
    },
  );

  it("invalidates outstanding reads on unmount without blocking later operations", () => {
    const fence = createPendingAttachmentOwnerFence();
    fence.setOwner(owner("workspace-a"));
    const oldRead = fence.capture();

    fence.invalidate();

    expect(oldRead()).toBe(false);
    expect(fence.capture()()).toBe(true);
  });
});
