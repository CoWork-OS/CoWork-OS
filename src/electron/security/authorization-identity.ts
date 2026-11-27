import { createHash } from "node:crypto";

/**
 * Fields the main process adds to an approval's details after evaluating it; they describe the
 * prompt, not the operation, so they are not part of its identity. `alwaysAllowApp` is the
 * "Always allow <app>" offer on a computer use card; the app's `bundleId` stays in the identity.
 */
const DERIVED_APPROVAL_DETAIL_KEYS = new Set([
  "permissionPrompt",
  "accessProfile",
  "authorization",
  "reason",
  "draftRevision",
  "alwaysAllowApp",
]);

export function authorizationToolInput(details: Record<string, unknown>): unknown {
  if (Object.prototype.hasOwnProperty.call(details, "permissionInput"))
    return details.permissionInput;
  if (Object.prototype.hasOwnProperty.call(details, "params")) return details.params;
  return Object.fromEntries(
    Object.entries(details).filter(([key]) => !DERIVED_APPROVAL_DETAIL_KEYS.has(key)),
  );
}

/** Hash policy and operation identity without putting arguments or secrets in trace events. */
export function authorizationFingerprint(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item)
          .filter(([, entry]) => entry !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, normalize(entry)]),
      );
    }
    return item;
  };
  return createHash("sha256")
    .update(JSON.stringify(normalize(value)) ?? "null")
    .digest("hex");
}
