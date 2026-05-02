/**
 * Shared sanitization for control plane params.
 * Used by both handlers (Electron main) and control-plane-methods (daemon).
 */

import os from "os";
import path from "path";
import * as fs from "fs/promises";
import type {
  ImageAttachment,
  IntegrationMentionSelection,
  PermissionMode,
  QuotedAssistantMessage,
} from "../../shared/types";
import { ErrorCodes } from "./protocol";
import { getUserDataDir } from "../utils/user-data-dir";
import { z } from "zod";
import { ImageAttachmentSchema } from "../utils/validation";

const MAX_IMAGES_PER_MESSAGE = 5;

const ALLOWED_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

/**
 * Sanitize and validate task message params (taskId, message, images).
 * Validates ImageAttachment structure via TaskMessageSchema.
 */
export function sanitizeTaskMessageParams(params: unknown): {
  taskId: string;
  message: string;
  images?: ImageAttachment[];
  quotedAssistantMessage?: QuotedAssistantMessage;
  permissionMode?: PermissionMode;
  shellAccess?: boolean;
  integrationMentions?: IntegrationMentionSelection[];
} {
  const p = (params ?? {}) as Record<string, unknown>;
  const taskId = typeof p.taskId === "string" ? p.taskId.trim() : "";
  const message = typeof p.message === "string" ? p.message.trim() : "";
  if (!taskId) throw { code: ErrorCodes.INVALID_PARAMS, message: "taskId is required" };
  if (!message) throw { code: ErrorCodes.INVALID_PARAMS, message: "message is required" };

  let images: ImageAttachment[] | undefined;
  if (Array.isArray(p.images) && p.images.length > 0) {
    const ImagesSchema = z.array(ImageAttachmentSchema).max(MAX_IMAGES_PER_MESSAGE).optional();
    const parsed = ImagesSchema.safeParse(p.images);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((issue: { message: string }) => issue.message).join("; ");
      throw { code: ErrorCodes.INVALID_PARAMS, message: `Invalid images: ${msg}` };
    }
    images = parsed.data as ImageAttachment[];
  }

  let quotedAssistantMessage: QuotedAssistantMessage | undefined;
  if (p.quotedAssistantMessage && typeof p.quotedAssistantMessage === "object") {
    const QuoteSchema = z
      .object({
        eventId: z.string().min(1).max(200).optional(),
        taskId: z.string().uuid().optional(),
        message: z.string().min(1).max(500000),
        truncated: z.boolean().optional(),
      })
      .strict();
    const parsed = QuoteSchema.safeParse(p.quotedAssistantMessage);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((issue: { message: string }) => issue.message).join("; ");
      throw { code: ErrorCodes.INVALID_PARAMS, message: `Invalid quoted assistant message: ${msg}` };
    }
    quotedAssistantMessage = parsed.data as QuotedAssistantMessage;
  }

  let permissionMode: PermissionMode | undefined;
  if (typeof p.permissionMode === "string") {
    const PermissionModeSchema = z.enum([
      "default",
      "plan",
      "dangerous_only",
      "accept_edits",
      "dont_ask",
      "bypass_permissions",
    ]);
    const parsed = PermissionModeSchema.safeParse(p.permissionMode);
    if (!parsed.success) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: "Invalid permissionMode" };
    }
    permissionMode = parsed.data;
  }

  const shellAccess = typeof p.shellAccess === "boolean" ? p.shellAccess : undefined;

  let integrationMentions: IntegrationMentionSelection[] | undefined;
  if (Array.isArray(p.integrationMentions)) {
    const IntegrationMentionSchema = z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            label: z.string().min(1).max(120),
            source: z.enum(["builtin", "gateway", "mcp"]),
            providerKey: z.string().min(1).max(120),
            iconKey: z.string().min(1).max(80),
            tools: z.array(z.string().min(1).max(200)).max(50),
            promptHint: z.string().min(1).max(1000),
          })
          .strict(),
      )
      .max(12);
    const parsed = IntegrationMentionSchema.safeParse(p.integrationMentions);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((issue: { message: string }) => issue.message).join("; ");
      throw { code: ErrorCodes.INVALID_PARAMS, message: `Invalid integration mentions: ${msg}` };
    }
    integrationMentions = parsed.data;
  }

  return {
    taskId,
    message,
    images,
    quotedAssistantMessage,
    permissionMode,
    shellAccess,
    integrationMentions,
  };
}

/**
 * Check if a file path is under an allowed root (prevents path traversal).
 * Allowed: userDataDir, tmpdir, homedir.
 */
function isPathUnderAllowedRoot(resolvedPath: string): boolean {
  const roots = [
    path.resolve(getUserDataDir()),
    path.resolve(os.tmpdir()),
    path.resolve(os.homedir()),
  ];
  const normalized = path.resolve(resolvedPath);
  return roots.some((root) => {
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    return normalized === root || normalized.startsWith(rootWithSep);
  });
}

/**
 * Convert image filePaths to base64 for remote forwarding.
 * Validates paths are under allowed roots and have image extensions.
 * Failed or rejected images are filtered out (never forwarded with local filePath).
 */
export async function normalizeImagesForRemote(params: unknown): Promise<unknown> {
  if (!params || typeof params !== "object") return params;
  const p = params as Record<string, unknown>;
  const images = Array.isArray(p.images) ? p.images : undefined;
  if (!images || images.length === 0) return params;

  const results = await Promise.all(
    images.map(async (img: unknown): Promise<Record<string, unknown> | null> => {
      if (!img || typeof img !== "object") return null;
      const obj = img as Record<string, unknown>;
      const filePath = typeof obj.filePath === "string" ? obj.filePath.trim() : "";
      if (!filePath || obj.data) return obj;

      const ext = path.extname(filePath).toLowerCase();
      if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
        console.warn("[ControlPlane] Rejected image path (invalid extension):", filePath);
        return null;
      }

      try {
        const resolved = await fs.realpath(filePath);
        if (!isPathUnderAllowedRoot(resolved)) {
          console.warn("[ControlPlane] Rejected image path (outside allowed roots):", filePath);
          return null;
        }
        const buf = await fs.readFile(filePath);
        const data = buf.toString("base64");
        const { filePath: _fp, ...rest } = obj;
        return {
          ...rest,
          data,
          sizeBytes: (rest.sizeBytes as number) ?? buf.length,
        };
      } catch (err) {
        console.warn("[ControlPlane] Failed to read image for remote:", filePath, err);
        return null;
      }
    }),
  );
  const normalized = results.filter((r): r is Record<string, unknown> => r !== null);
  return { ...p, images: normalized };
}
