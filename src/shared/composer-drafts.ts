import type { IntegrationMentionSelection, QuotedAssistantMessage } from "./types";

export const COMPOSER_DRAFT_SCHEMA_VERSION = 1 as const;
export const COMPOSER_DRAFT_DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const COMPOSER_DRAFT_MAX_TEXT_LENGTH = 100_000;
export const COMPOSER_DRAFT_MAX_QUOTED_MESSAGE_LENGTH = 50_000;
export const COMPOSER_DRAFT_MAX_MENTIONS = 64;
export const COMPOSER_DRAFT_MAX_ATTACHMENTS = 32;
export const COMPOSER_DRAFT_MAX_ATTACHMENT_NAME_LENGTH = 512;
export const COMPOSER_DRAFT_MAX_ATTACHMENT_MIME_LENGTH = 255;
export const COMPOSER_DRAFT_MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;
export const COMPOSER_DRAFT_MAX_ATTACHMENT_TOTAL_BYTES = 100 * 1024 * 1024;
export const COMPOSER_DRAFT_MAX_PAYLOAD_BYTES = 512 * 1024;
export const COMPOSER_DRAFT_MAX_KEY_PART_LENGTH = 256;

export type ComposerDraftSurface = "main" | "side-chat";
export type ComposerDraftScope = "local" | "remote";

/** A renderer-safe mention span. The composer may add transient cursor state around it. */
export interface ComposerDraftMentionSpan {
  spanId: string;
  start: number;
  end: number;
  mention: IntegrationMentionSelection;
}

/**
 * Opaque metadata for a draft-owned attachment. File bytes never belong in a
 * draft row or localStorage; the attachment store owns them separately.
 */
export interface DraftAttachmentRef {
  refId: string;
  name: string;
  mimeType?: string;
  size: number;
  sha256: string;
  status?: "available" | "unavailable";
}

export interface ComposerDraftKeyInput {
  scope: ComposerDraftScope;
  workspaceId: string;
  taskId?: string | null;
  surface?: ComposerDraftSurface;
  remoteDeviceId?: string;
}

export interface ComposerDraft {
  schemaVersion: typeof COMPOSER_DRAFT_SCHEMA_VERSION;
  draftKey: string;
  workspaceId: string;
  taskId: string | null;
  surface: ComposerDraftSurface;
  remoteDeviceId?: string;
  text: string;
  mentions: ComposerDraftMentionSpan[];
  quotedAssistantMessage?: QuotedAssistantMessage;
  attachments: DraftAttachmentRef[];
  revision: number;
  updatedAt: number;
  expiresAt?: number;
}

export interface ComposerDraftGetRequest {
  draftKey: string;
  scope: ComposerDraftScope;
  workspaceId: string;
  surface: ComposerDraftSurface;
  taskId?: string | null;
  remoteDeviceId?: string;
}

export interface ComposerDraftClearRequest extends ComposerDraftGetRequest {
  revision?: number;
}

export interface ComposerDraftRekeyRequest {
  draftKey: string;
  nextDraftKey: string;
  scope: ComposerDraftScope;
  workspaceId: string;
  surface: ComposerDraftSurface;
  taskId?: string | null;
  remoteDeviceId?: string;
  nextTaskId?: string | null;
  nextRemoteDeviceId?: string;
}

export interface ComposerDraftAttachmentPutRequest {
  draftKey: string;
  scope: ComposerDraftScope;
  workspaceId: string;
  surface: ComposerDraftSurface;
  taskId?: string | null;
  remoteDeviceId?: string;
  name: string;
  size?: number;
  mimeType?: string;
  dataBase64?: string;
  sourcePath?: string;
}

export interface ComposerDraftAttachmentReleaseRequest {
  draftKey: string;
  scope: ComposerDraftScope;
  workspaceId: string;
  surface: ComposerDraftSurface;
  taskId?: string | null;
  remoteDeviceId?: string;
  refId: string;
}

export interface ComposerDraftAttachmentResolveRequest {
  draftKey: string;
  scope: ComposerDraftScope;
  workspaceId: string;
  surface: ComposerDraftSurface;
  taskId?: string | null;
  remoteDeviceId?: string;
  refId: string;
}

export function normalizeComposerDraftKeyPart(value: unknown, fallback: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
}

/**
 * Build a collision-resistant, human-inspectable key for local draft state.
 * Remote drafts include the current device identity and are intentionally not
 * syncable merely because the task id happens to match.
 */
export function buildComposerDraftKey(input: ComposerDraftKeyInput): string {
  const scope = input.scope;
  const workspaceId = normalizeComposerDraftKeyPart(input.workspaceId, "workspace");
  const surface = input.surface ?? "main";
  const taskId = normalizeComposerDraftKeyPart(input.taskId, "new");

  if (scope === "remote") {
    const remoteDeviceId = normalizeComposerDraftKeyPart(input.remoteDeviceId, "device");
    return [
      scope,
      encodeComposerDraftKeyPart(workspaceId),
      encodeComposerDraftKeyPart(remoteDeviceId),
      encodeComposerDraftKeyPart(taskId),
      surface,
    ].join(":");
  }

  return [
    scope,
    encodeComposerDraftKeyPart(workspaceId),
    encodeComposerDraftKeyPart(taskId),
    surface,
  ].join(":");
}

function encodeComposerDraftKeyPart(value: string): string {
  // Keep ordinary UUID/path-like identifiers human-readable while preventing
  // delimiter collisions when a remote/device identifier contains ':' or '%'.
  return value.replaceAll("%", "%25").replaceAll(":", "%3A");
}

export function createEmptyComposerDraft(
  input: ComposerDraftKeyInput,
  now = Date.now(),
): ComposerDraft {
  return {
    schemaVersion: COMPOSER_DRAFT_SCHEMA_VERSION,
    draftKey: buildComposerDraftKey(input),
    workspaceId: normalizeComposerDraftKeyPart(input.workspaceId, "workspace"),
    taskId: typeof input.taskId === "string" && input.taskId.trim() ? input.taskId.trim() : null,
    surface: input.surface ?? "main",
    ...(input.scope === "remote" && input.remoteDeviceId
      ? { remoteDeviceId: input.remoteDeviceId.trim() }
      : {}),
    text: "",
    mentions: [],
    attachments: [],
    revision: 0,
    updatedAt: now,
    expiresAt: now + COMPOSER_DRAFT_DEFAULT_TTL_MS,
  };
}

export function normalizeComposerDraft(value: unknown): ComposerDraft | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<ComposerDraft>;
  if (input.schemaVersion !== COMPOSER_DRAFT_SCHEMA_VERSION) return null;
  if (typeof input.draftKey !== "string" || !input.draftKey.trim()) return null;
  if (typeof input.workspaceId !== "string" || !input.workspaceId.trim()) return null;
  if (
    input.draftKey.length > 1024 ||
    input.workspaceId.length > COMPOSER_DRAFT_MAX_KEY_PART_LENGTH ||
    (typeof input.taskId === "string" &&
      input.taskId.length > COMPOSER_DRAFT_MAX_KEY_PART_LENGTH) ||
    (typeof input.remoteDeviceId === "string" &&
      input.remoteDeviceId.length > COMPOSER_DRAFT_MAX_KEY_PART_LENGTH)
  ) {
    return null;
  }
  if (input.surface !== "main" && input.surface !== "side-chat") return null;

  if (typeof input.text === "string" && input.text.length > COMPOSER_DRAFT_MAX_TEXT_LENGTH) {
    return null;
  }
  if (Array.isArray(input.mentions) && input.mentions.length > COMPOSER_DRAFT_MAX_MENTIONS) {
    return null;
  }
  if (
    Array.isArray(input.attachments) &&
    input.attachments.length > COMPOSER_DRAFT_MAX_ATTACHMENTS
  ) {
    return null;
  }

  const mentions = Array.isArray(input.mentions)
    ? input.mentions.filter((mention): mention is ComposerDraftMentionSpan => {
        if (!mention || typeof mention !== "object") return false;
        const candidate = mention as Partial<ComposerDraftMentionSpan>;
        const start = candidate.start;
        const end = candidate.end;
        return (
          typeof candidate.spanId === "string" &&
          candidate.spanId.length <= COMPOSER_DRAFT_MAX_KEY_PART_LENGTH &&
          typeof start === "number" &&
          typeof end === "number" &&
          Number.isInteger(start) &&
          Number.isInteger(end) &&
          start >= 0 &&
          end >= start &&
          end <= (typeof input.text === "string" ? input.text.length : 0) &&
          Boolean(candidate.mention && typeof candidate.mention === "object") &&
          isBoundedMention(candidate.mention)
        );
      })
    : [];
  const attachments = Array.isArray(input.attachments)
    ? input.attachments.filter((attachment): attachment is DraftAttachmentRef => {
        if (!attachment || typeof attachment !== "object") return false;
        const candidate = attachment as Partial<DraftAttachmentRef>;
        return (
          typeof candidate.refId === "string" &&
          /^[0-9a-f-]{20,64}$/i.test(candidate.refId) &&
          typeof candidate.name === "string" &&
          candidate.name.length <= COMPOSER_DRAFT_MAX_ATTACHMENT_NAME_LENGTH &&
          typeof candidate.size === "number" &&
          Number.isFinite(candidate.size) &&
          Number.isInteger(candidate.size) &&
          candidate.size >= 0 &&
          candidate.size <= COMPOSER_DRAFT_MAX_ATTACHMENT_SIZE &&
          (!candidate.mimeType ||
            (typeof candidate.mimeType === "string" &&
              candidate.mimeType.length <= COMPOSER_DRAFT_MAX_ATTACHMENT_MIME_LENGTH)) &&
          typeof candidate.sha256 === "string" &&
          /^[0-9a-f]{64}$/i.test(candidate.sha256) &&
          (candidate.status === undefined ||
            candidate.status === "available" ||
            candidate.status === "unavailable")
        );
      })
    : [];
  if (
    new Set(attachments.map((attachment) => attachment.refId)).size !== attachments.length ||
    attachments.reduce((total, attachment) => total + attachment.size, 0) >
      COMPOSER_DRAFT_MAX_ATTACHMENT_TOTAL_BYTES
  ) {
    return null;
  }

  const draft: ComposerDraft = {
    schemaVersion: COMPOSER_DRAFT_SCHEMA_VERSION,
    draftKey: input.draftKey.trim(),
    workspaceId: input.workspaceId.trim(),
    taskId: typeof input.taskId === "string" && input.taskId.trim() ? input.taskId.trim() : null,
    surface: input.surface,
    ...(typeof input.remoteDeviceId === "string" && input.remoteDeviceId.trim()
      ? { remoteDeviceId: input.remoteDeviceId.trim() }
      : {}),
    text: typeof input.text === "string" ? input.text : "",
    mentions,
    ...(normalizeQuotedAssistantMessage(input.quotedAssistantMessage)
      ? { quotedAssistantMessage: normalizeQuotedAssistantMessage(input.quotedAssistantMessage)! }
      : {}),
    attachments,
    revision:
      typeof input.revision === "number" && Number.isInteger(input.revision) && input.revision >= 0
        ? input.revision
        : 0,
    updatedAt:
      typeof input.updatedAt === "number" && Number.isFinite(input.updatedAt)
        ? input.updatedAt
        : Date.now(),
    ...(typeof input.expiresAt === "number" && Number.isFinite(input.expiresAt)
      ? { expiresAt: input.expiresAt }
      : {}),
  };

  if (utf8ByteLength(JSON.stringify(draft)) > COMPOSER_DRAFT_MAX_PAYLOAD_BYTES) return null;
  return draft;
}

function utf8ByteLength(value: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(value).byteLength;
  return value.length;
}

function isBoundedMention(value: unknown): value is IntegrationMentionSelection {
  if (!value || typeof value !== "object") return false;
  const mention = value as Partial<IntegrationMentionSelection>;
  return (
    typeof mention.id === "string" &&
    mention.id.length <= COMPOSER_DRAFT_MAX_KEY_PART_LENGTH &&
    typeof mention.label === "string" &&
    mention.label.length <= 512 &&
    (mention.source === "builtin" || mention.source === "gateway" || mention.source === "mcp") &&
    typeof mention.providerKey === "string" &&
    mention.providerKey.length <= 256 &&
    typeof mention.iconKey === "string" &&
    mention.iconKey.length <= 256 &&
    Array.isArray(mention.tools) &&
    mention.tools.length <= 128 &&
    mention.tools.every((tool) => typeof tool === "string" && tool.length <= 256) &&
    typeof mention.promptHint === "string" &&
    mention.promptHint.length <= 4_096
  );
}

function normalizeQuotedAssistantMessage(value: unknown): QuotedAssistantMessage | null {
  if (!value || typeof value !== "object") return null;
  const quote = value as Partial<QuotedAssistantMessage>;
  if (
    typeof quote.message !== "string" ||
    quote.message.length === 0 ||
    quote.message.length > COMPOSER_DRAFT_MAX_QUOTED_MESSAGE_LENGTH
  ) {
    return null;
  }
  return {
    ...(typeof quote.eventId === "string" && quote.eventId.length <= 256
      ? { eventId: quote.eventId }
      : {}),
    ...(typeof quote.taskId === "string" && quote.taskId.length <= 256
      ? { taskId: quote.taskId }
      : {}),
    message: quote.message,
    ...(typeof quote.truncated === "boolean" ? { truncated: quote.truncated } : {}),
  };
}

export function composerDraftMatchesOwner(
  draft: Pick<ComposerDraft, "draftKey" | "workspaceId" | "taskId" | "surface" | "remoteDeviceId">,
  owner: ComposerDraftGetRequest,
): boolean {
  return (
    draft.draftKey === owner.draftKey &&
    draft.workspaceId === owner.workspaceId.trim() &&
    draft.surface === owner.surface &&
    (draft.taskId ?? null) === (owner.taskId?.trim() || null) &&
    (draft.remoteDeviceId ?? "") === (owner.remoteDeviceId?.trim() || "")
  );
}
