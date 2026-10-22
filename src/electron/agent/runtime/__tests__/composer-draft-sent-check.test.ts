import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  composerDraftSentNeedle,
  composerDraftStartedAt,
  createSentFileDigest,
  listAttachedFilePaths,
  wasComposerDraftSent,
  type SentFileDigest,
} from "../composer-draft-sent-check";
import {
  COMPOSER_DRAFT_DEFAULT_TTL_MS,
  createEmptyComposerDraft,
  type ComposerDraft,
  type DraftAttachmentRef,
} from "../../../../shared/composer-drafts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const IMAGE_SHA = "ab".repeat(32);

function image(overrides: Partial<DraftAttachmentRef> = {}): DraftAttachmentRef {
  return {
    refId: "8baebc1c-a89c-41b6-bfe1-4eedb4c3f17a",
    name: "image.png",
    mimeType: "image/png",
    size: 74_842,
    sha256: IMAGE_SHA,
    status: "available",
    ...overrides,
  };
}

function draft(overrides: Partial<ComposerDraft> = {}): ComposerDraft {
  return {
    ...createEmptyComposerDraft({ scope: "local", workspaceId: "__temp_workspace__:scratch" }),
    ...overrides,
  };
}

function message(text: string, files: string[] = [], workspaceId = "workspace-repo") {
  return {
    workspaceId,
    text: files.length
      ? `${text}\n\nAttached files (relative to workspace):\n${files.join("\n\n")}`
      : text,
  };
}

/** Digest for files in a fake upload table keyed by "workspace|path". */
function fakeDigest(files: Record<string, { size: number; sha256: string }>): SentFileDigest {
  return async (workspaceId, relativePath, size) => {
    const file = files[`${workspaceId}|${relativePath}`];
    return file && file.size === size ? file.sha256 : null;
  };
}

describe("listAttachedFilePaths", () => {
  it("reads each listed path and skips extracted file text", () => {
    expect(
      listAttachedFilePaths(
        message("Build a DCF model", [
          "- image.png (.cowork/uploads/1792507534577/image.png)",
          [
            "- notes (draft).txt (.cowork/uploads/1792507534577/notes (draft).txt)",
            "  Extracted content:",
            "  [[ATTACHMENT_EXTRACTED_CONTENT_START]]",
            "    - fake.png (.cowork/uploads/1/fake.png)",
            "  [[ATTACHMENT_EXTRACTED_CONTENT_END]]",
          ].join("\n"),
        ]).text,
      ),
    ).toEqual([
      ".cowork/uploads/1792507534577/image.png",
      ".cowork/uploads/1792507534577/notes (draft).txt",
    ]);
  });

  it("finds nothing without the summary header", () => {
    expect(listAttachedFilePaths("- image.png (.cowork/uploads/1/image.png)")).toEqual([]);
  });
});

describe("wasComposerDraftSent", () => {
  it("retires a scratch draft whose only file was sent from another folder", async () => {
    // The reported case: the image was staged in the scratch session, a folder
    // was chosen, and the task was sent there with new words.
    const sent = await wasComposerDraftSent(
      draft({ attachments: [image()] }),
      [
        message("add a button next to the three-dots button", [
          "- image.png (.cowork/uploads/1792507534577/image.png)",
        ]),
      ],
      fakeDigest({
        "workspace-repo|.cowork/uploads/1792507534577/image.png": {
          size: 74_842,
          sha256: IMAGE_SHA,
        },
      }),
    );
    expect(sent).toBe(true);
  });

  it("matches a file renamed on import by its bytes", async () => {
    const sent = await wasComposerDraftSent(
      draft({ text: "Review this", attachments: [image()] }),
      [message("Review this", ["- image-1.png (.cowork/uploads/9/image-1.png)"])],
      fakeDigest({
        "workspace-repo|.cowork/uploads/9/image-1.png": { size: 74_842, sha256: IMAGE_SHA },
      }),
    );
    expect(sent).toBe(true);
  });

  it("keeps a draft whose file differs from the sent one", async () => {
    const sent = await wasComposerDraftSent(
      draft({ attachments: [image()] }),
      [message("Look", ["- image.png (.cowork/uploads/9/image.png)"])],
      fakeDigest({
        "workspace-repo|.cowork/uploads/9/image.png": { size: 74_842, sha256: "cd".repeat(32) },
      }),
    );
    expect(sent).toBe(false);
  });

  it("keeps a draft whose words differ from what was sent", async () => {
    const digest = fakeDigest({
      "workspace-repo|.cowork/uploads/9/image.png": { size: 74_842, sha256: IMAGE_SHA },
    });
    expect(
      await wasComposerDraftSent(
        draft({ text: "add an option for dark mode", attachments: [image()] }),
        [message("something else", ["- image.png (.cowork/uploads/9/image.png)"])],
        digest,
      ),
    ).toBe(false);
    expect(
      await wasComposerDraftSent(
        draft({ text: "add an option for dark mode\n", attachments: [image()] }),
        [message("add an option for dark mode", ["- image.png (.cowork/uploads/9/image.png)"])],
        digest,
      ),
    ).toBe(true);
  });

  it("needs every staged file to be in the same message", async () => {
    const second = image({
      refId: "5f1a1151-2a4e-4862-be4a-f562ef4e084c",
      sha256: "ef".repeat(32),
    });
    const sent = await wasComposerDraftSent(
      draft({ attachments: [image(), second] }),
      [message("Look", ["- image.png (.cowork/uploads/9/image.png)"])],
      fakeDigest({
        "workspace-repo|.cowork/uploads/9/image.png": { size: 74_842, sha256: IMAGE_SHA },
      }),
    );
    expect(sent).toBe(false);
  });

  it("only counts files the send copied into the uploads folder", async () => {
    const sent = await wasComposerDraftSent(
      draft({ attachments: [image()] }),
      [message("Look", ["- image.png (docs/image.png)"])],
      fakeDigest({ "workspace-repo|docs/image.png": { size: 74_842, sha256: IMAGE_SHA } }),
    );
    expect(sent).toBe(false);
  });

  it("retires a text-only draft that went out as a follow-up", async () => {
    const digest = fakeDigest({});
    expect(
      await wasComposerDraftSent(
        draft({ text: "Diagnose the bundle-format error." }),
        [message("Diagnose the bundle-format error.")],
        digest,
      ),
    ).toBe(true);
    expect(await wasComposerDraftSent(draft({ text: "   " }), [message("")], digest)).toBe(false);
  });
});

describe("composer draft start and needle", () => {
  it("derives the start from the creation-time expiry", () => {
    expect(composerDraftStartedAt({ expiresAt: 5_000 + COMPOSER_DRAFT_DEFAULT_TTL_MS })).toBe(
      5_000,
    );
    expect(composerDraftStartedAt({})).toBeNull();
  });

  it("searches by typed text, else by the attached-files header", () => {
    expect(composerDraftSentNeedle(draft({ text: "  hello " }))).toBe("hello");
    expect(composerDraftSentNeedle(draft({ attachments: [image()] }))).toBe(
      "Attached files (relative to workspace):",
    );
    expect(composerDraftSentNeedle(draft())).toBeNull();
  });
});

describe("createSentFileDigest", () => {
  it("hashes a file inside the workspace and refuses paths that leave it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cowork-sent-draft-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, "workspace");
    await mkdir(path.join(workspace, ".cowork", "uploads", "1"), { recursive: true });
    const bytes = Buffer.from("png bytes");
    await writeFile(path.join(workspace, ".cowork", "uploads", "1", "image.png"), bytes);
    await writeFile(path.join(root, "outside.png"), bytes);
    await symlink(
      path.join(root, "outside.png"),
      path.join(workspace, ".cowork", "uploads", "1", "link.png"),
    );
    const digest = createSentFileDigest(async (workspaceId) =>
      workspaceId === "workspace" ? workspace : null,
    );
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    expect(await digest("workspace", ".cowork/uploads/1/image.png", bytes.length)).toBe(sha256);
    expect(await digest("workspace", ".cowork/uploads/1/image.png", bytes.length + 1)).toBeNull();
    expect(await digest("workspace", "../outside.png", bytes.length)).toBeNull();
    expect(await digest("workspace", ".cowork/uploads/1/link.png", bytes.length)).toBeNull();
    expect(await digest("missing", ".cowork/uploads/1/image.png", bytes.length)).toBeNull();
  });
});
