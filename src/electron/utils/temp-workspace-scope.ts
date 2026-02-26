import path from "path";
import {
  TEMP_WORKSPACE_ID_PREFIX,
  isTempWorkspaceId,
} from "../../shared/types";

export type TempWorkspaceScope = "ui" | "gateway" | "hooks" | "tray";

const SCOPE_SET = new Set<TempWorkspaceScope>(["ui", "gateway", "hooks", "tray"]);
const MAX_KEY_LENGTH = 96;

export function sanitizeTempWorkspaceKey(raw: string): string {
  const safe = String(raw || "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (safe.length > 0) return safe.slice(0, MAX_KEY_LENGTH);
  return `session-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export function createScopedTempWorkspaceIdentity(
  scope: TempWorkspaceScope,
  key: string,
): { scope: TempWorkspaceScope; key: string; slug: string; workspaceId: string } {
  const safeKey = sanitizeTempWorkspaceKey(key);
  const slug = `${scope}-${safeKey}`;
  return {
    scope,
    key: safeKey,
    slug,
    workspaceId: `${TEMP_WORKSPACE_ID_PREFIX}${slug}`,
  };
}

export function getScopedTempWorkspacePath(
  tempWorkspaceRoot: string,
  scope: TempWorkspaceScope,
  key: string,
): string {
  return path.join(path.resolve(tempWorkspaceRoot), createScopedTempWorkspaceIdentity(scope, key).slug);
}

export function parseTempWorkspaceScope(
  workspaceId: string | null | undefined,
): TempWorkspaceScope | "legacy" | null {
  if (!isTempWorkspaceId(workspaceId)) return null;
  const id = workspaceId || "";
  if (!id.startsWith(TEMP_WORKSPACE_ID_PREFIX)) return "legacy";
  const suffix = id.slice(TEMP_WORKSPACE_ID_PREFIX.length);
  const dashIndex = suffix.indexOf("-");
  if (dashIndex <= 0) return "legacy";
  const maybeScope = suffix.slice(0, dashIndex) as TempWorkspaceScope;
  if (!SCOPE_SET.has(maybeScope)) return "legacy";
  return maybeScope;
}

export function isTempWorkspaceInScope(
  workspaceId: string | null | undefined,
  scope: TempWorkspaceScope,
): boolean {
  return parseTempWorkspaceScope(workspaceId) === scope;
}
