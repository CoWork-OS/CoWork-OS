import { isTempWorkspaceId, type Workspace } from "../../shared/types";

/**
 * The sidebar's New action starts a fresh task, but should not silently move a
 * user out of the real folder they selected. Scratch sessions still receive a
 * fresh temp workspace so their files remain isolated from older scratch work.
 */
export function shouldUseFreshTempWorkspaceForNewSession(
  workspace: Pick<Workspace, "id" | "isTemp"> | null | undefined,
): boolean {
  if (!workspace) return true;
  return workspace.isTemp === true || isTempWorkspaceId(workspace.id);
}
