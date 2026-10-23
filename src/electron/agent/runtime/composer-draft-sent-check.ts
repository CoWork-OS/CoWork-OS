import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

import {
  ATTACHED_FILES_SUMMARY_HEADER,
  textBeforeAttachedFiles,
} from "../../../shared/attachment-summary";
import { COMPOSER_DRAFT_DEFAULT_TTL_MS, type ComposerDraft } from "../../../shared/composer-drafts";
import type { SentComposerMessage } from "../../database/composer-draft-sent-sql";

/**
 * A saved draft whose words and files already went out in a task is not a
 * draft any more. Older builds could leave one behind (choosing a folder before
 * sending, or a send racing the clear), and the app reopens that folder or
 * scratch session on launch, so the sent file kept coming back. These helpers
 * decide whether a loaded draft is one of those, so it can be retired.
 */

/** SHA-256 of a sent file when it has the expected size, otherwise null. */
export type SentFileDigest = (
  workspaceId: string,
  relativePath: string,
  size: number,
) => Promise<string | null>;

// Sending copies every staged draft file into the workspace under this folder.
const UPLOADS_PREFIX = ".cowork/uploads/";

/** When the draft was started: its expiry is set once, at creation. */
export function composerDraftStartedAt(draft: Pick<ComposerDraft, "expiresAt">): number | null {
  return typeof draft.expiresAt === "number" && Number.isFinite(draft.expiresAt)
    ? draft.expiresAt - COMPOSER_DRAFT_DEFAULT_TTL_MS
    : null;
}

/** Text a message must contain to carry the draft, or null for an empty draft. */
export function composerDraftSentNeedle(
  draft: Pick<ComposerDraft, "text" | "attachments">,
): string | null {
  const text = draft.text.trim();
  if (text) return text;
  return draft.attachments.length > 0 ? ATTACHED_FILES_SUMMARY_HEADER : null;
}

/** Workspace-relative paths listed in a message's attached-files summary. */
export function listAttachedFilePaths(message: string): string[] {
  const start = message.indexOf(ATTACHED_FILES_SUMMARY_HEADER);
  if (start < 0) return [];
  const paths: string[] = [];
  const lines = message.slice(start + ATTACHED_FILES_SUMMARY_HEADER.length).split("\n");
  for (const rawLine of lines) {
    // "- <file name> (<relative path>)". Extracted file text is indented, so it
    // never starts a line with "- ".
    const line = rawLine.replace(/\r$/, "");
    if (!line.startsWith("- ") || !line.endsWith(")")) continue;
    const entry = line.slice(2, -1);
    // Names may hold " (", so take the split whose path ends in that name.
    for (let split = entry.indexOf(" ("); split >= 0; split = entry.indexOf(" (", split + 1)) {
      const relativePath = entry.slice(split + 2);
      if (relativePath.split(/[\\/]/).pop() === entry.slice(0, split)) {
        paths.push(relativePath);
        break;
      }
    }
  }
  return paths;
}

/**
 * True when one sent message carries everything the draft holds: the same typed
 * text, when the draft has any, and every staged file. Files are matched by
 * size and SHA-256, because sending may rename a file to avoid a collision.
 */
export async function wasComposerDraftSent(
  draft: Pick<ComposerDraft, "text" | "attachments">,
  messages: SentComposerMessage[],
  digest: SentFileDigest,
): Promise<boolean> {
  const text = draft.text.trim();
  if (!text && draft.attachments.length === 0) return false;
  for (const message of messages) {
    if (text && textBeforeAttachedFiles(message.text).trim() !== text) continue;
    if (await carriesDraftFiles(draft, message, digest)) return true;
  }
  return false;
}

async function carriesDraftFiles(
  draft: Pick<ComposerDraft, "attachments">,
  message: SentComposerMessage,
  digest: SentFileDigest,
): Promise<boolean> {
  const unmatched = listAttachedFilePaths(message.text).filter((relativePath) =>
    relativePath.replaceAll("\\", "/").startsWith(UPLOADS_PREFIX),
  );
  for (const attachment of draft.attachments) {
    let matched = -1;
    for (let index = 0; index < unmatched.length && matched < 0; index += 1) {
      const sha256 = await digest(message.workspaceId, unmatched[index], attachment.size);
      if (sha256 && sha256 === attachment.sha256.toLowerCase()) matched = index;
    }
    if (matched < 0) return false;
    unmatched.splice(matched, 1);
  }
  return true;
}

/**
 * Hash a sent file inside its workspace. Paths come from stored messages, so
 * anything that resolves outside the workspace folder is ignored.
 */
export function createSentFileDigest(
  resolveWorkspacePath: (workspaceId: string) => Promise<string | null | undefined>,
): SentFileDigest {
  return async (workspaceId, relativePath, size) => {
    const workspacePath = await resolveWorkspacePath(workspaceId);
    if (!workspacePath || path.isAbsolute(relativePath)) return null;
    try {
      const root = await fs.realpath(workspacePath);
      const filePath = await fs.realpath(path.resolve(root, relativePath));
      if (!filePath.startsWith(root + path.sep)) return null;
      const stats = await fs.stat(filePath);
      if (!stats.isFile() || stats.size !== size) return null;
      return createHash("sha256")
        .update(await fs.readFile(filePath))
        .digest("hex");
    } catch {
      return null;
    }
  };
}
