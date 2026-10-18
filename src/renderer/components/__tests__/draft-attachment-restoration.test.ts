import { describe, expect, it } from "vitest";
import {
  createEmptyComposerDraft,
  type ComposerDraft,
  type DraftAttachmentRef,
} from "../../../shared/composer-drafts";
import {
  reconcileResolvedDraftAttachments,
  type PendingAttachment,
} from "../MainContent/attachments";

const ref = (refId: string): DraftAttachmentRef => ({
  refId,
  name: `${refId}.pdf`,
  size: 100,
  sha256: `sha-${refId}`,
  mimeType: "application/pdf",
  status: "available",
});

const pending = (attachment: DraftAttachmentRef): PendingAttachment => ({
  id: attachment.refId,
  draftRefId: attachment.refId,
  draftSha256: attachment.sha256,
  name: attachment.name,
  size: attachment.size,
  status: "unavailable",
});

const draft = (taskId: string, attachments: DraftAttachmentRef[]): ComposerDraft => ({
  ...createEmptyComposerDraft({ scope: "local", workspaceId: "workspace", taskId }),
  attachments,
  revision: 4,
});

const resolved = (attachment: DraftAttachmentRef) => ({
  attachment: pending(attachment),
  resolved: { ref: attachment, path: `/attachments/${attachment.name}` },
});

describe("restoring draft attachments", () => {
  it("does not apply a late lookup to another owner with the same revision", async () => {
    const original = ref("original");
    const next = ref("next");
    const originalDraft = draft("task-a", [original]);
    let currentDraft = originalDraft;
    let currentPending = [pending(original)];
    const savedPatches: DraftAttachmentRef[][] = [];
    const lookup = Promise.resolve().then(() => {
      const result = reconcileResolvedDraftAttachments({
        draftKeyAtRestore: originalDraft.draftKey,
        currentDraftKey: currentDraft.draftKey,
        currentDraft,
        pendingAttachments: currentPending,
        resolvedAttachments: [resolved(original)],
      });
      if (result) {
        currentPending = result.pendingAttachments;
        savedPatches.push(result.draftAttachments);
      }
    });

    currentDraft = draft("task-b", [next]);
    const nextPending = { ...pending(next), path: "/next.pdf", status: "available" as const };
    currentPending = [nextPending];
    await lookup;

    expect(currentDraft.revision).toBe(originalDraft.revision);
    expect(currentPending).toEqual([nextPending]);
    expect(savedPatches).toEqual([]);
  });

  it("restores accessibility after typing advances the same draft revision", async () => {
    const attachment = { ...ref("lunch"), status: "unavailable" as const };
    const originalDraft = draft("task-a", [attachment]);
    let currentDraft = originalDraft;
    const lookup = Promise.resolve().then(() =>
      reconcileResolvedDraftAttachments({
        draftKeyAtRestore: originalDraft.draftKey,
        currentDraftKey: currentDraft.draftKey,
        currentDraft,
        pendingAttachments: [pending(attachment)],
        resolvedAttachments: [resolved(attachment)],
      }),
    );
    currentDraft = { ...currentDraft, text: "Please summarize the lunch notes.", revision: 5 };
    const result = await lookup;

    expect(result?.pendingAttachments[0]).toMatchObject({
      status: "available",
      path: "/attachments/lunch.pdf",
    });
    expect(result?.draftAttachments[0].status).toBe("available");
    expect(currentDraft.text).toBe("Please summarize the lunch notes.");
    expect(currentDraft.revision).toBe(5);
  });

  it("preserves removals and additions made while a lookup is pending", () => {
    const removed = ref("removed");
    const retained = ref("retained");
    const added = ref("added");
    const currentDraft = draft("task-a", [retained, added]);
    const addedPending = { ...pending(added), path: "/added.pdf", status: "available" as const };
    const result = reconcileResolvedDraftAttachments({
      draftKeyAtRestore: currentDraft.draftKey,
      currentDraftKey: currentDraft.draftKey,
      currentDraft,
      pendingAttachments: [pending(retained), addedPending],
      resolvedAttachments: [resolved(removed), resolved(retained)],
    });

    expect(result?.pendingAttachments.map((item) => item.id)).toEqual(["retained", "added"]);
    expect(result?.pendingAttachments[0].status).toBe("available");
    expect(result?.pendingAttachments[1]).toBe(addedPending);
    expect(result?.draftAttachments).toEqual([retained, added]);
  });

  it("does not reinsert an attachment removed before the draft sync finishes", () => {
    const removed = ref("removed");
    const currentDraft = draft("task-a", [removed]);
    const result = reconcileResolvedDraftAttachments({
      draftKeyAtRestore: currentDraft.draftKey,
      currentDraftKey: currentDraft.draftKey,
      currentDraft,
      pendingAttachments: [],
      resolvedAttachments: [resolved(removed)],
    });

    expect(result?.pendingAttachments).toEqual([]);
    expect(result?.draftAttachments).toBe(currentDraft.attachments);
  });

  it("leaves a newer replacement untouched even if a local id is reused", () => {
    const original = ref("report");
    const replacement = { ...original, sha256: "replacement-sha", size: 200 };
    const currentDraft = draft("task-a", [replacement]);
    const replacementPending = {
      ...pending(replacement),
      path: "/new-report.pdf",
      status: "available" as const,
    };
    const result = reconcileResolvedDraftAttachments({
      draftKeyAtRestore: currentDraft.draftKey,
      currentDraftKey: currentDraft.draftKey,
      currentDraft,
      pendingAttachments: [replacementPending],
      resolvedAttachments: [resolved(original)],
    });

    expect(result?.pendingAttachments).toEqual([replacementPending]);
    expect(result?.draftAttachments).toBe(currentDraft.attachments);
  });

  it("marks only an unresolved restored file unavailable and keeps later attachments", () => {
    const missing = ref("missing");
    const added = ref("added");
    const currentDraft = draft("task-a", [missing, added]);
    const addedPending = { ...pending(added), path: "/added.pdf", status: "available" as const };
    const result = reconcileResolvedDraftAttachments({
      draftKeyAtRestore: currentDraft.draftKey,
      currentDraftKey: currentDraft.draftKey,
      currentDraft,
      pendingAttachments: [pending(missing), addedPending],
      resolvedAttachments: [{ attachment: pending(missing), resolved: null }],
    });

    expect(result?.pendingAttachments[0].status).toBe("unavailable");
    expect(result?.pendingAttachments[1]).toBe(addedPending);
    expect(result?.draftAttachments).toEqual([{ ...missing, status: "unavailable" }, added]);
  });

  it("checks the live key again before applying a queued state update", () => {
    const attachment = ref("original");
    const originalDraft = draft("task-a", [attachment]);
    const resolveArgs = {
      draftKeyAtRestore: originalDraft.draftKey,
      currentDraft: originalDraft,
      pendingAttachments: [pending(attachment)],
      resolvedAttachments: [resolved(attachment)],
    };

    expect(
      reconcileResolvedDraftAttachments({
        ...resolveArgs,
        currentDraftKey: originalDraft.draftKey,
      }),
    ).not.toBeNull();
    expect(
      reconcileResolvedDraftAttachments({ ...resolveArgs, currentDraftKey: "new-owner" }),
    ).toBeNull();
  });
});
