import { createHash } from "node:crypto";

export function authorizationToolInput(details: Record<string, unknown>): unknown {
  if (Object.prototype.hasOwnProperty.call(details, "permissionInput"))
    return details.permissionInput;
  if (Object.prototype.hasOwnProperty.call(details, "params")) return details.params;
  return Object.fromEntries(
    Object.entries(details).filter(
      ([key]) => !["permissionPrompt", "accessProfile", "authorization", "reason"].includes(key),
    ),
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
