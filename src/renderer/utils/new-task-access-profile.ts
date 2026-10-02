import { BUILTIN_ACCESS_PROFILE_IDS, type AccessProfileId } from "../../shared/access-profiles";

const REMEMBERED_ACCESS_PROFILE_KEY = "cowork:new-task-access-profile";

/** The access profile the user last picked, used for new tasks until they pick another. */
export function readRememberedAccessProfileId(): AccessProfileId | null {
  try {
    const value = window.localStorage.getItem(REMEMBERED_ACCESS_PROFILE_KEY)?.trim();
    return value ? (value as AccessProfileId) : null;
  } catch {
    return null;
  }
}

export function rememberAccessProfileId(profileId: AccessProfileId): void {
  try {
    window.localStorage.setItem(REMEMBERED_ACCESS_PROFILE_KEY, profileId);
  } catch {
    // Storage can be unavailable (private contexts); the pick still applies this session.
  }
}

export function forgetRememberedAccessProfileId(): void {
  try {
    window.localStorage.removeItem(REMEMBERED_ACCESS_PROFILE_KEY);
  } catch {
    // Nothing to clear.
  }
}

/**
 * The profile a new task starts with: the user's last pick while it still exists, otherwise
 * the default from Settings.
 */
export function resolveNewTaskAccessProfileId(args: {
  remembered: AccessProfileId | null;
  defaultProfileId: AccessProfileId;
  availableProfileIds: readonly AccessProfileId[];
}): AccessProfileId {
  return args.remembered && args.availableProfileIds.includes(args.remembered)
    ? args.remembered
    : args.defaultProfileId;
}

/**
 * Tasks saved before access profiles carry only a permission mode. They run on the built-in
 * profile the main process resolves for that mode (security/access-profile-resolver.ts):
 * bypass_permissions runs as Full access, every other mode on Ask for approval.
 */
export function getAccessProfileIdForPermissionMode(
  permissionMode: string | undefined,
): AccessProfileId {
  return permissionMode === "bypass_permissions"
    ? BUILTIN_ACCESS_PROFILE_IDS.fullAccess
    : BUILTIN_ACCESS_PROFILE_IDS.askForApproval;
}
