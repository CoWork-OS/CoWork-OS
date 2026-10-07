/**
 * Producers that write the memory folder instead of `memory_items`
 * (docs/memory-repo-phase3-design.md §4): the user's preferred name, the observation
 * "promote to memory" of the Memory Hub, and a writable-folder check. Each returns null
 * when the folder is off or unavailable, so the caller keeps its `memory_items` fallback.
 */
import type { CuratedMemoryEntry } from "../../../shared/types";
import { memoryKindForCuratedKind } from "../memory-items-lanes";
import { MemoryRepoService, type MemoryRepoWriteResult } from "./MemoryRepoService";

/** The running folder service when it can be written; null otherwise. */
export function writableMemoryRepo(
  getService: () => MemoryRepoService | null = () => MemoryRepoService.get(),
): MemoryRepoService | null {
  const service = getService();
  return service?.isWritable() ? service : null;
}

export const PREFERRED_NAME_SUBJECT = "preferred_name";

export function preferredNameEntryText(name: string): string {
  return `Preferred name: ${name.trim()}`;
}

/** Why a folder write was skipped, in words for the user. */
export function memoryRepoSkipMessage(
  result: Extract<MemoryRepoWriteResult, { status: "skipped" }>,
): string {
  switch (result.reason) {
    case "busy":
      return "The memory folder is busy; try again in a moment.";
    case "outranked":
      return `Not saved: it would replace what you stated. ${result.detail ?? ""}`.trim();
    case "too_large":
      return `Not saved: ${result.detail ?? "the memory file is full"}.`;
    case "memory_disabled":
      return "Memory is off for this workspace.";
    case "no_memory":
      return "The text asks not to be remembered.";
    case "secret_only":
      return "That text is only a secret; secrets are not saved to memory.";
    case "low_salience":
    case "empty":
      return "That text is too short to be a useful memory.";
    case "dirty":
      return `The memory folder has changes CoWork cannot commit${result.detail ? `: ${result.detail}` : ""}.`;
    default:
      return result.detail ? `Not saved: ${result.detail}` : `Not saved (${result.reason}).`;
  }
}

/**
 * Mirror the user's preferred name into `me.md` as `[subject: preferred_name]` (the line
 * replaces an earlier name). PersonalityManager stays the source of truth.
 */
export async function rememberPreferredNameInFolder(
  name: string,
  options: { taskId?: string | null; origin?: "agent_tool" | "memory_hub" | "onboarding" } = {},
  getService?: () => MemoryRepoService | null,
): Promise<MemoryRepoWriteResult | null> {
  const service = writableMemoryRepo(getService);
  if (!service || !name.trim()) return null;
  return service.remember({
    text: preferredNameEntryText(name),
    kind: "identity",
    scope: "global",
    by: "user",
    subject: PREFERRED_NAME_SUBJECT,
    taskId: options.taskId ?? null,
    origin: options.origin ?? "agent_tool",
    skipWorkspacePolicy: true,
    ...(options.origin === "onboarding" ? { metadata: { origin: "onboarding" } } : {}),
  });
}

export interface PromoteToFolderResult {
  success: boolean;
  ref?: string;
  file?: string;
  error?: string;
}

/**
 * "Promote to memory" of an observation in the Memory Hub Inspector: an explicit user act,
 * written as the user's line to the workspace file (target `workspace`) or `me.md` (target
 * `user`). Commitments stay in `memory_items` (null: the caller falls back).
 */
export async function promoteObservationToMemoryFolder(
  params: {
    workspaceId: string;
    workspaceName?: string | null;
    taskId?: string | null;
    target: "user" | "workspace";
    kind: CuratedMemoryEntry["kind"];
    content: string;
  },
  getService?: () => MemoryRepoService | null,
): Promise<PromoteToFolderResult | null> {
  const service = writableMemoryRepo(getService);
  const kind = memoryKindForCuratedKind(params.kind);
  if (!service || kind === "commitment") return null;
  const result = await service.remember({
    text: params.content,
    kind,
    scope: params.target === "user" ? "global" : "workspace",
    workspaceId: params.workspaceId,
    workspaceName: params.workspaceName ?? null,
    by: "user",
    taskId: params.taskId ?? null,
    origin: "memory_hub",
    skipWorkspacePolicy: true,
  });
  if (result.status === "skipped") {
    if (result.reason === "unavailable") return null;
    return { success: false, error: memoryRepoSkipMessage(result) };
  }
  return { success: true, ref: result.ref, file: result.path };
}
