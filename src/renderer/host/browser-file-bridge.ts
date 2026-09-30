import {
  COMPOSER_DRAFT_MAX_ATTACHMENT_SIZE,
  COMPOSER_DRAFT_MAX_ATTACHMENT_TOTAL_BYTES,
  COMPOSER_DRAFT_MAX_ATTACHMENTS,
  type ComposerDraftAttachmentPutRequest,
  type ComposerDraftAttachmentReleaseRequest,
  type ComposerDraftAttachmentResolveRequest,
  type DraftAttachmentRef,
} from "../../shared/composer-drafts";
import type { WebSessionBootstrap } from "../../shared/host-api/contracts";
import type { Workspace } from "../../shared/types";
import { webEndpoint } from "../../renderer-web/transport";
import { triggerBrowserBlobDownload } from "./browser-download";

const MAX_FILE_BYTES = COMPOSER_DRAFT_MAX_ATTACHMENT_SIZE;
const MAX_FILES = COMPOSER_DRAFT_MAX_ATTACHMENTS;
const MAX_TOTAL_BYTES = COMPOSER_DRAFT_MAX_ATTACHMENT_TOTAL_BYTES;
const BROWSER_FILE_PREFIX = "browser-file:";

type DraftOwner = Pick<
  ComposerDraftAttachmentPutRequest,
  "draftKey" | "scope" | "workspaceId" | "surface" | "taskId" | "remoteDeviceId"
>;

/** Owner tuple used by the browser composer-draft bridge's lifecycle hooks. */
export type BrowserComposerDraftOwner = DraftOwner;
export type BrowserComposerDraftAttachmentReference = string | Pick<DraftAttachmentRef, "refId">;

type StagedAttachment = {
  ref: DraftAttachmentRef;
  path: string;
  ownerKey: string;
};

type ImportedWorkspaceFile = {
  relativePath: string;
  fileName: string;
  size: number;
  mimeType?: string;
};

type PickedFileEntry = {
  file: File | null;
  inFlight: number;
  released: boolean;
  uploads: Map<string, ImportedWorkspaceFile>;
};

type BrowserFileBridgeOptions = {
  session: WebSessionBootstrap;
  listWorkspaces: () => Promise<Workspace[]>;
  isActive: () => boolean;
};

type BrowserFileBridge = {
  methods: Record<string, unknown>;
  rekeyAttachments: (
    fromOwner: BrowserComposerDraftOwner,
    toOwner: BrowserComposerDraftOwner,
  ) => { rekeyedAttachmentCount: number; rollback: () => void };
  releaseAttachments: (
    owner: BrowserComposerDraftOwner,
    refs?: readonly BrowserComposerDraftAttachmentReference[],
  ) => { releasedAttachmentCount: number };
  dispose: () => void;
};

/** Browser-owned file bytes use scoped HTTP routes, never host path arguments. */
export function createBrowserFileBridge(options: BrowserFileBridgeOptions): BrowserFileBridge {
  const picked = new Map<string, PickedFileEntry>();
  const staged = new Map<string, StagedAttachment>();
  const ownerAliases = new Map<string, string>();
  const pendingPickers = new Set<{
    cleanup: () => void;
    reject: (error: Error) => void;
  }>();
  let disposed = false;

  const ensureActive = () => {
    if (disposed || !options.isActive()) {
      throw new Error("This browser session has ended.");
    }
  };

  const pickedEntryFor = (path: unknown): PickedFileEntry => {
    ensureActive();
    if (typeof path !== "string" || !path.startsWith(BROWSER_FILE_PREFIX)) {
      throw new Error("Choose this file again before attaching it.");
    }
    const entry = picked.get(path);
    if (!entry) throw new Error("Choose this file again before attaching it.");
    return entry;
  };

  const fileFor = (path: unknown): File => {
    const entry = pickedEntryFor(path);
    if (!entry.file) throw new Error("Choose this file again before attaching it.");
    return entry.file;
  };

  const pickedByteCount = () =>
    [...picked.values()].reduce((total, entry) => total + (entry.file?.size ?? 0), 0);

  const pickedFileCount = () => [...picked.values()].filter((entry) => entry.file !== null).length;

  const canonicalOwnerKey = (ownerKey: string): string => {
    let current = ownerKey;
    const visited = new Set<string>();
    while (ownerAliases.has(current) && !visited.has(current)) {
      visited.add(current);
      current = ownerAliases.get(current) as string;
    }
    return current;
  };

  const rekeyAttachments: BrowserFileBridge["rekeyAttachments"] = (fromValue, toValue) => {
    ensureActive();
    const fromOwner = parseDraftOwner(fromValue);
    const toOwner = parseDraftOwner(toValue);
    if (
      fromOwner.scope !== toOwner.scope ||
      fromOwner.workspaceId !== toOwner.workspaceId ||
      fromOwner.surface !== toOwner.surface ||
      fromOwner.remoteDeviceId !== toOwner.remoteDeviceId
    ) {
      throw new Error("Draft attachments cannot move between workspaces or surfaces.");
    }
    const sourceOwnerKey = canonicalOwnerKey(keyForDraftOwner(fromOwner));
    const targetOwnerKey = canonicalOwnerKey(keyForDraftOwner(toOwner));
    if (sourceOwnerKey === targetOwnerKey) {
      return { rekeyedAttachmentCount: 0, rollback: () => undefined };
    }

    const movedAttachmentOwners = new Map<string, string>();
    for (const attachment of staged.values()) {
      if (attachment.ownerKey !== sourceOwnerKey) continue;
      movedAttachmentOwners.set(attachment.ref.refId, attachment.ownerKey);
      attachment.ownerKey = targetOwnerKey;
    }
    // A put may still be hashing when a first task is created. Alias the old
    // owner so that a late completion is attached to the newly keyed draft.
    const hadPreviousAlias = ownerAliases.has(sourceOwnerKey);
    const previousAlias = ownerAliases.get(sourceOwnerKey);
    ownerAliases.set(sourceOwnerKey, targetOwnerKey);
    let rolledBack = false;
    return {
      rekeyedAttachmentCount: movedAttachmentOwners.size,
      rollback: () => {
        if (rolledBack) return;
        rolledBack = true;
        for (const [refId, previousOwnerKey] of movedAttachmentOwners) {
          const attachment = staged.get(refId);
          if (attachment?.ownerKey === targetOwnerKey) {
            attachment.ownerKey = previousOwnerKey;
          }
        }
        if (hadPreviousAlias) {
          ownerAliases.set(sourceOwnerKey, previousAlias as string);
        } else {
          ownerAliases.delete(sourceOwnerKey);
        }
      },
    };
  };

  const releaseAttachments: BrowserFileBridge["releaseAttachments"] = (ownerValue, refs) => {
    ensureActive();
    const ownerKey = keyForDraftOwner(parseDraftOwner(ownerValue));
    if (refs !== undefined && (!Array.isArray(refs) || refs.length > MAX_FILES)) {
      throw new Error("This draft attachment list is unavailable.");
    }
    const selectedRefs =
      refs === undefined
        ? null
        : new Set(
            refs.map((reference) => (typeof reference === "string" ? reference : reference?.refId)),
          );
    if (
      selectedRefs &&
      [...selectedRefs].some((refId) => typeof refId !== "string" || !refId || refId.length > 128)
    ) {
      throw new Error("This draft attachment list is unavailable.");
    }
    let releasedAttachmentCount = 0;
    for (const [refId, attachment] of staged) {
      if (attachment.ownerKey !== ownerKey || (selectedRefs && !selectedRefs.has(refId))) continue;
      staged.delete(refId);
      const pickedEntry = picked.get(attachment.path);
      if (pickedEntry) {
        pickedEntry.released = true;
        removeReleasedEntryIfUnused(attachment.path, pickedEntry);
      }
      releasedAttachmentCount += 1;
    }
    return { releasedAttachmentCount };
  };

  const removeReleasedEntryIfUnused = (path: string, entry: PickedFileEntry) => {
    if (
      entry.released &&
      entry.file === null &&
      entry.inFlight === 0 &&
      ![...staged.values()].some((attachment) => attachment.path === path)
    ) {
      picked.delete(path);
    }
  };

  const pruneReleasedFiles = () => {
    for (const [path, entry] of picked) {
      if (
        entry.released &&
        entry.inFlight === 0 &&
        ![...staged.values()].some((attachment) => attachment.path === path)
      ) {
        picked.delete(path);
      }
    }
  };

  const workspaceFor = async (
    workspaceId: unknown,
    access: "read" | "write",
  ): Promise<Workspace> => {
    ensureActive();
    if (typeof workspaceId !== "string" || !workspaceId || workspaceId.length > 128) {
      throw new Error("Choose an available workspace first.");
    }
    const workspaces = await options.listWorkspaces();
    ensureActive();
    const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace || workspace.permissions?.[access] !== true) {
      throw new Error(
        access === "write"
          ? "Choose a workspace where you can add files."
          : "Select this file's project first.",
      );
    }
    return workspace;
  };

  const download = async (workspaceId: string, relativePath: string): Promise<Response> => {
    ensureActive();
    const response = await fetch(webEndpoint("workspace-files/download"), {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "X-CoWork-CSRF": options.session.csrfToken,
      },
      body: JSON.stringify({ workspaceId, relativePath }),
    });
    ensureActive();
    return response;
  };

  const upload = async (
    workspace: Workspace,
    file: File,
  ): Promise<{ relativePath: string; fileName: string; size: number; mimeType?: string }> => {
    ensureActive();
    if (file.size > MAX_FILE_BYTES) {
      throw new Error("Attachments must be 25 MiB or smaller.");
    }

    const digest = await hashBytes(await file.arrayBuffer());
    ensureActive();
    const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-120) || "attachment";
    const relativePath = `attachment-${digest.slice(0, 20)}-${safeName}`;

    let response: Response | null = null;
    try {
      response = await fetch(webEndpoint("workspace-files/upload"), {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-CoWork-CSRF": options.session.csrfToken,
          "X-CoWork-Workspace-Id": workspace.id,
          "X-CoWork-Relative-Path": encodeURIComponent(relativePath),
          "If-None-Match": "*",
        },
        body: file,
      });
    } catch {
      // A connection can be lost after the host has committed the file.
    }
    ensureActive();

    if (!response?.ok) {
      if (response && response.status !== 409) {
        throw new Error(
          "The host could not save this attachment. Your selected file has been kept.",
        );
      }

      // A lost reply or an existing deterministic target is successful only
      // when the host returns the exact bytes selected in this browser.
      const prior = await download(workspace.id, relativePath);
      if (!prior.ok) {
        throw new Error(
          "The host did not confirm this attachment. Your selected file has been kept.",
        );
      }
      const priorBytes = await readLimitedResponse(prior, MAX_FILE_BYTES, ensureActive);
      if ((await hashBytes(priorBytes)) !== digest) {
        throw new Error(
          "The host did not confirm this attachment. Your selected file has been kept.",
        );
      }
      ensureActive();
    }

    return {
      relativePath,
      fileName: file.name,
      size: file.size,
      ...(file.type ? { mimeType: file.type } : {}),
    };
  };

  const decodeBase64File = (item: { name: unknown; data: unknown; mimeType?: unknown }): File => {
    const name = requireFileName(item.name);
    const mimeType = normalizeMimeType(item.mimeType);
    if (typeof item.data !== "string") throw new Error("This attachment has no file data.");
    const bytes = decodeBase64(item.data);
    if (bytes.byteLength > MAX_FILE_BYTES) {
      throw new Error("Attachments must be 25 MiB or smaller.");
    }
    return new File([bytes.buffer as ArrayBuffer], name, { type: mimeType });
  };

  const methods: Record<string, unknown> = {
    selectFiles: async (_defaultPath?: string) => {
      ensureActive();
      pruneReleasedFiles();
      return new Promise<Array<{ path: string; name: string; size: number; mimeType?: string }>>(
        (resolve, reject) => {
          const input = document.createElement("input");
          input.type = "file";
          input.multiple = true;
          input.hidden = true;
          document.body.appendChild(input);

          let settled = false;
          const cleanup = () => {
            pendingPickers.delete(pendingPicker);
            input.remove();
          };
          const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
          };
          const pendingPicker = { cleanup, reject: fail };
          pendingPickers.add(pendingPicker);

          input.addEventListener(
            "cancel",
            () => {
              if (settled) return;
              try {
                ensureActive();
                settled = true;
                cleanup();
                resolve([]);
              } catch (error) {
                fail(asError(error));
              }
            },
            { once: true },
          );
          input.addEventListener(
            "change",
            () => {
              if (settled) return;
              try {
                ensureActive();
                const files = [...(input.files ?? [])];
                const totalBytes = files.reduce((total, file) => total + file.size, 0);
                const retainedBytes = pickedByteCount();
                if (
                  pickedFileCount() + files.length > MAX_FILES ||
                  files.some((file) => file.size > MAX_FILE_BYTES) ||
                  retainedBytes + totalBytes > MAX_TOTAL_BYTES
                ) {
                  throw new Error("Choose up to 32 files, 100 MiB total, and 25 MiB per file.");
                }
                const result = files.map((file) => {
                  const path = `${BROWSER_FILE_PREFIX}${crypto.randomUUID()}`;
                  picked.set(path, {
                    file,
                    inFlight: 0,
                    released: false,
                    uploads: new Map(),
                  });
                  return {
                    path,
                    name: file.name,
                    size: file.size,
                    ...(file.type ? { mimeType: file.type } : {}),
                  };
                });
                settled = true;
                cleanup();
                resolve(result);
              } catch (error) {
                fail(asError(error));
              }
            },
            { once: true },
          );

          try {
            input.click();
          } catch (error) {
            fail(asError(error));
          }
        },
      );
    },

    importFilesToWorkspace: async (request: { workspaceId: string; files: string[] }) => {
      ensureActive();
      if (!request || !Array.isArray(request.files)) {
        throw new Error("Choose files to attach.");
      }
      if (
        request.files.length > MAX_FILES ||
        new Set(request.files).size !== request.files.length
      ) {
        throw new Error("Choose up to 32 distinct files.");
      }
      const paths = request.files;
      const entries = paths.map((path) => pickedEntryFor(path));
      const totalBytes = entries.reduce((total, entry) => {
        const size = entry.file?.size ?? [...entry.uploads.values()][0]?.size ?? 0;
        if (!entry.file && entry.uploads.size === 0) {
          throw new Error("Choose this file again before attaching it.");
        }
        return total + size;
      }, 0);
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new Error("Attachments exceed the 100 MiB total limit.");
      }
      entries.forEach((entry) => (entry.inFlight += 1));
      try {
        const workspace = await workspaceFor(request.workspaceId, "write");
        const results: ImportedWorkspaceFile[] = [];
        for (let index = 0; index < entries.length; index += 1) {
          ensureActive();
          const entry = entries[index];
          const cached = entry.uploads.get(workspace.id);
          if (cached) {
            results.push(cached);
            continue;
          }
          if (!entry.file) throw new Error("Choose the file again before attaching it.");
          const result = await upload(workspace, entry.file);
          entry.uploads.set(workspace.id, result);
          entry.file = null;
          results.push(result);
        }
        ensureActive();
        return results;
      } finally {
        for (let index = 0; index < entries.length; index += 1) {
          const entry = entries[index];
          entry.inFlight = Math.max(0, entry.inFlight - 1);
          removeReleasedEntryIfUnused(paths[index], entry);
        }
      }
    },

    importDataToWorkspace: async (request: {
      workspaceId: string;
      files: Array<{ name: string; data: string; mimeType?: string }>;
    }) => {
      ensureActive();
      if (!request || !Array.isArray(request.files)) {
        throw new Error("Choose files to attach.");
      }
      if (request.files.length > MAX_FILES) {
        throw new Error("You can attach up to 32 files.");
      }
      const estimatedTotalBytes = request.files.reduce((total, item) => {
        if (!item || typeof item.data !== "string") {
          throw new Error("This attachment has no file data.");
        }
        return total + estimateBase64Bytes(item.data);
      }, 0);
      if (estimatedTotalBytes > MAX_TOTAL_BYTES) {
        throw new Error("Attachments exceed the 100 MiB total limit.");
      }
      const workspace = await workspaceFor(request.workspaceId, "write");
      const results: ImportedWorkspaceFile[] = [];
      for (const item of request.files) {
        ensureActive();
        const file = decodeBase64File(item);
        results.push(await upload(workspace, file));
      }
      ensureActive();
      return results;
    },

    putComposerDraftAttachment: async (request: ComposerDraftAttachmentPutRequest) => {
      ensureActive();
      const owner = parseDraftOwner(request);
      const ownerKey = canonicalOwnerKey(keyForDraftOwner(owner));
      const ownerAttachments = [...staged.values()].filter((entry) => entry.ownerKey === ownerKey);
      if (ownerAttachments.length >= MAX_FILES) {
        throw new Error("You can attach up to 32 files.");
      }

      let file: File;
      let path: string;
      let isNewFile = false;
      if (request.sourcePath !== undefined) {
        if (request.dataBase64 !== undefined) {
          throw new Error("Choose either a selected file or file data, not both.");
        }
        file = fileFor(request.sourcePath);
        if (request.name !== file.name) {
          throw new Error("The selected file name changed. Choose the file again.");
        }
        path = request.sourcePath;
      } else {
        const name = requireFileName(request.name);
        const mimeType = normalizeMimeType(request.mimeType);
        const data = typeof request.dataBase64 === "string" ? request.dataBase64 : "";
        const bytes = decodeBase64(data);
        if (bytes.byteLength > MAX_FILE_BYTES) {
          throw new Error("Attachments must be 25 MiB or smaller.");
        }
        file = new File([bytes.buffer as ArrayBuffer], name, { type: mimeType });
        path = `${BROWSER_FILE_PREFIX}${crypto.randomUUID()}`;
        isNewFile = true;
      }

      if (file.size > MAX_FILE_BYTES) {
        throw new Error("Attachments must be 25 MiB or smaller.");
      }
      if (request.size !== undefined && request.size !== file.size) {
        throw new Error("The selected file size changed. Choose the file again.");
      }
      const ownerBytes = ownerAttachments.reduce((total, entry) => total + entry.ref.size, 0);
      if (ownerBytes + file.size > MAX_TOTAL_BYTES) {
        throw new Error("Draft attachments exceed the 100 MiB total limit.");
      }
      if (isNewFile) {
        const retainedBytes = pickedByteCount();
        if (pickedFileCount() >= MAX_FILES || retainedBytes + file.size > MAX_TOTAL_BYTES) {
          throw new Error("Attachments exceed the 100 MiB total limit.");
        }
        picked.set(path, { file, inFlight: 0, released: false, uploads: new Map() });
      }

      try {
        const sha256 = await hashBytes(await file.arrayBuffer());
        ensureActive();
        const ref: DraftAttachmentRef = {
          refId: crypto.randomUUID(),
          name: file.name,
          size: file.size,
          sha256,
          status: "available",
          ...(file.type ? { mimeType: file.type } : {}),
        };
        staged.set(ref.refId, {
          ref,
          path,
          ownerKey: canonicalOwnerKey(keyForDraftOwner(owner)),
        });
        return { ...ref };
      } catch (error) {
        if (isNewFile) picked.delete(path);
        throw error;
      }
    },

    resolveComposerDraftAttachment: async (request: ComposerDraftAttachmentResolveRequest) => {
      ensureActive();
      const ownerKey = keyForDraftOwner(parseDraftOwner(request));
      const entry = typeof request.refId === "string" ? staged.get(request.refId) : undefined;
      if (!entry || entry.ownerKey !== ownerKey || !picked.has(entry.path)) return null;
      return { ref: { ...entry.ref }, path: entry.path };
    },

    releaseComposerDraftAttachment: async (request: ComposerDraftAttachmentReleaseRequest) => {
      ensureActive();
      const ownerKey = keyForDraftOwner(parseDraftOwner(request));
      const entry = typeof request.refId === "string" ? staged.get(request.refId) : undefined;
      if (!entry || entry.ownerKey !== ownerKey) return { released: false };
      // A release can race MainContent's send preparation. Retain the picked
      // File until it is imported or the bridge is disposed so its opaque path
      // remains usable if send preparation has not started the import yet.
      staged.delete(request.refId);
      const pickedEntry = picked.get(entry.path);
      if (pickedEntry) {
        pickedEntry.released = true;
        removeReleasedEntryIfUnused(entry.path, pickedEntry);
      }
      return { released: true };
    },

    readFileForViewer: async (
      filePath: string,
      workspacePath?: string,
      viewerOptions?: { includeImageContent?: boolean },
    ) => {
      ensureActive();
      try {
        const workspaces = await options.listWorkspaces();
        ensureActive();
        const workspace = workspaces.find(
          (candidate) => candidate.path === workspacePath && candidate.permissions?.read === true,
        );
        if (!workspace) return { success: false, error: "Select this file's project first." };
        const relativePath = relativePathForWorkspace(filePath, workspace.path);
        if (!relativePath) {
          return { success: false, error: "This file path is unavailable in the browser." };
        }
        const response = await download(workspace.id, relativePath);
        if (!response.ok) return { success: false, error: "This file is unavailable." };

        const bytes = await readLimitedResponse(response, MAX_FILE_BYTES, ensureActive).catch(
          (error) => {
            if (error instanceof ResponseTooLargeError) return null;
            throw error;
          },
        );
        ensureActive();
        if (!bytes) {
          return { success: false, error: "This file exceeds the browser preview limit." };
        }

        const fileName = relativePath.split("/").pop() || relativePath;
        const extension = fileExtension(fileName);
        const contentType = (response.headers.get("content-type") || "")
          .split(";", 1)[0]
          .trim()
          .toLowerCase();
        const imageMime = SAFE_IMAGE_MIME_BY_EXTENSION[extension];
        if (imageMime && contentType === imageMime) {
          return {
            success: true,
            data: {
              path: relativePath,
              fileName,
              fileType: "image",
              content:
                viewerOptions?.includeImageContent === false
                  ? null
                  : `data:${imageMime};base64,${arrayBufferToBase64(bytes)}`,
              mimeType: imageMime,
              size: bytes.byteLength,
            },
          };
        }

        const textFileType = SAFE_TEXT_FILE_TYPES[extension];
        if (!textFileType) {
          return {
            success: true,
            data: {
              path: relativePath,
              fileName,
              fileType: "unsupported",
              content: null,
              mimeType: contentType || undefined,
              size: bytes.byteLength,
            },
          };
        }

        return {
          success: true,
          data: {
            path: relativePath,
            fileName,
            fileType: textFileType,
            content: new TextDecoder().decode(bytes),
            mimeType: contentType || undefined,
            size: bytes.byteLength,
          },
        };
      } catch (error) {
        if (disposed || !options.isActive()) throw new Error("This browser session has ended.");
        return {
          success: false,
          error: error instanceof Error ? error.message : "File preview failed.",
        };
      }
    },

    openFile: async (filePath: string, workspacePath?: string) => {
      ensureActive();
      try {
        const workspaces = await options.listWorkspaces();
        ensureActive();
        const workspace = workspaces.find(
          (candidate) => candidate.path === workspacePath && candidate.permissions?.read === true,
        );
        if (!workspace) return "Select this file's project first.";
        const relativePath = relativePathForWorkspace(filePath, workspace.path);
        if (!relativePath) return "This file path is unavailable in the browser.";
        const response = await download(workspace.id, relativePath);
        if (!response.ok) return "This file is unavailable.";
        const bytes = await readLimitedResponse(response, MAX_FILE_BYTES, ensureActive);
        ensureActive();
        const blob = new Blob([bytes], { type: "application/octet-stream" });
        triggerBrowserBlobDownload(blob, relativePath.split("/").pop() || "download");
        return "";
      } catch (error) {
        if (disposed || !options.isActive()) throw new Error("This browser session has ended.");
        return error instanceof Error ? error.message : "This file could not be downloaded.";
      }
    },
  };

  return {
    methods,
    rekeyAttachments,
    releaseAttachments,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const picker of [...pendingPickers]) {
        picker.cleanup();
        picker.reject(new Error("This browser session has ended."));
      }
      picked.clear();
      staged.clear();
      ownerAliases.clear();
    },
  };
}

const SAFE_IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const SAFE_TEXT_FILE_TYPES: Record<string, "code" | "csv" | "json" | "markdown" | "text"> = {
  ".c": "code",
  ".cc": "code",
  ".cpp": "code",
  ".css": "code",
  ".csv": "csv",
  ".go": "code",
  ".h": "code",
  ".hpp": "code",
  ".ini": "text",
  ".java": "code",
  ".js": "code",
  ".json": "json",
  ".jsx": "code",
  ".log": "text",
  ".md": "markdown",
  ".mdx": "markdown",
  ".mjs": "code",
  ".py": "code",
  ".rb": "code",
  ".rs": "code",
  ".sh": "code",
  ".sql": "code",
  ".swift": "code",
  ".ts": "code",
  ".tsx": "code",
  ".txt": "text",
  ".tsv": "csv",
  ".xml": "text",
  ".yaml": "text",
  ".yml": "text",
};

function parseDraftOwner(value: unknown): DraftOwner {
  const request = asRecord(value);
  const draftKey = request?.draftKey;
  const scope = request?.scope;
  const workspaceId = request?.workspaceId;
  const surface = request?.surface;
  const taskId = request?.taskId;
  const remoteDeviceId = request?.remoteDeviceId;
  if (
    typeof draftKey !== "string" ||
    !draftKey.trim() ||
    draftKey.length > 2048 ||
    (scope !== "local" && scope !== "remote") ||
    typeof workspaceId !== "string" ||
    !workspaceId.trim() ||
    workspaceId.length > 128 ||
    (surface !== "main" && surface !== "side-chat") ||
    (taskId !== undefined &&
      taskId !== null &&
      (typeof taskId !== "string" || taskId.length > 256)) ||
    (remoteDeviceId !== undefined &&
      (typeof remoteDeviceId !== "string" || remoteDeviceId.length > 256)) ||
    (scope === "remote" && (typeof remoteDeviceId !== "string" || !remoteDeviceId))
  ) {
    throw new Error("This draft attachment is unavailable.");
  }
  return {
    draftKey,
    scope,
    workspaceId,
    surface,
    taskId: taskId === undefined ? null : taskId,
    ...(typeof remoteDeviceId === "string" ? { remoteDeviceId } : {}),
  };
}

function keyForDraftOwner(owner: DraftOwner): string {
  return JSON.stringify([
    owner.draftKey,
    owner.scope,
    owner.workspaceId,
    owner.surface,
    owner.taskId ?? null,
    owner.remoteDeviceId ?? null,
  ]);
}

function requireFileName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512) {
    throw new Error("Choose a file with a valid name.");
  }
  return value;
}

function normalizeMimeType(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > 255 || /[\r\n\0]/.test(value)) {
    throw new Error("The file type is invalid.");
  }
  return value;
}

function decodeBase64(value: string): Uint8Array {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error("This attachment's file data is invalid.");
  }
  if (value.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) {
    throw new Error("Attachments must be 25 MiB or smaller.");
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function estimateBase64Bytes(value: string): number {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error("This attachment's file data is invalid.");
  }
  if (value.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) {
    throw new Error("Attachments must be 25 MiB or smaller.");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function isSafeWorkspaceRelativePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 4096 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /^[A-Za-z]:/.test(value) ||
    /[\0-\x1f\x7f]/.test(value)
  ) {
    return false;
  }
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** Resolve a renderer path only when its workspace path is an exact known root. */
export function relativePathForWorkspace(filePath: unknown, workspacePath: unknown): string | null {
  if (isSafeWorkspaceRelativePath(filePath)) return filePath;
  if (
    typeof filePath !== "string" ||
    typeof workspacePath !== "string" ||
    !filePath ||
    !workspacePath ||
    filePath.length > 4096 ||
    workspacePath.length > 4096 ||
    /[\0-\x1f\x7f]/.test(filePath) ||
    /[\0-\x1f\x7f]/.test(workspacePath)
  ) {
    return null;
  }

  const windowsRoot = /^[A-Za-z]:[\\/]/.test(workspacePath);
  if (windowsRoot) {
    const separator = workspacePath.includes("\\") ? "\\" : "/";
    if (
      (separator === "\\" && filePath.includes("/")) ||
      (separator === "/" && filePath.includes("\\"))
    ) {
      return null;
    }
    const rootSegments = splitAbsolutePath(workspacePath, separator);
    const fileSegments = splitAbsolutePath(filePath, separator);
    if (!rootSegments || !fileSegments || fileSegments.length <= rootSegments.length) return null;
    if (
      rootSegments.some(
        (segment, index) =>
          segment.toLocaleLowerCase() !== fileSegments[index]?.toLocaleLowerCase(),
      )
    ) {
      return null;
    }
    const relativePath = fileSegments.slice(rootSegments.length).join("/");
    return isSafeWorkspaceRelativePath(relativePath) ? relativePath : null;
  }

  if (
    !workspacePath.startsWith("/") ||
    workspacePath.startsWith("//") ||
    !filePath.startsWith("/") ||
    filePath.startsWith("//") ||
    workspacePath.includes("\\") ||
    filePath.includes("\\")
  ) {
    return null;
  }
  const rootSegments = splitAbsolutePath(workspacePath, "/");
  const fileSegments = splitAbsolutePath(filePath, "/");
  if (!rootSegments || !fileSegments || fileSegments.length <= rootSegments.length) return null;
  if (rootSegments.some((segment, index) => segment !== fileSegments[index])) return null;
  const relativePath = fileSegments.slice(rootSegments.length).join("/");
  return isSafeWorkspaceRelativePath(relativePath) ? relativePath : null;
}

function splitAbsolutePath(value: string, separator: "/" | "\\"): string[] | null {
  if (separator === "/" && /^[A-Za-z]:\//.test(value)) {
    const normalized = value.replace(/\/+$/, "");
    const segments = normalized.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
    return segments;
  }
  const normalized =
    value === separator
      ? value
      : separator === "\\" && /^[A-Za-z]:\\+$/.test(value)
        ? `${value.slice(0, 2)}\\`
        : value.replace(new RegExp(`${escapeRegExp(separator)}+$`), "");
  if (separator === "/" && !normalized.startsWith("/")) return null;
  if (separator === "\\" && !/^[A-Za-z]:\\/.test(normalized)) return null;
  const segments =
    separator === "/"
      ? normalized === "/"
        ? []
        : normalized.slice(1).split("/")
      : normalized.replace(/\\+$/, "").split("\\");
  if (segments.length === 1 && segments[0] === "") return [];
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return segments;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fileExtension(fileName: string): string {
  const lastDot = fileName.lastIndexOf(".");
  return lastDot >= 0 ? fileName.slice(lastDot).toLowerCase() : "";
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function readLimitedResponse(
  response: Response,
  maxBytes: number,
  ensureActive: () => void,
): Promise<ArrayBuffer> {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader && /^\d+$/.test(lengthHeader) && Number(lengthHeader) > maxBytes) {
    throw new ResponseTooLargeError();
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const blob = await response.blob();
    ensureActive();
    if (blob.size > maxBytes) throw new ResponseTooLargeError();
    return blob.arrayBuffer();
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      ensureActive();
      const { done, value } = await reader.read();
      ensureActive();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const buffer = new ArrayBuffer(totalBytes);
  const result = new Uint8Array(buffer);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

class ResponseTooLargeError extends Error {
  constructor() {
    super("Response exceeds the browser file limit.");
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("The browser file operation failed.");
}

async function hashBytes(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
