import { createHash } from "node:crypto";
import type { BackgroundDispatchSource } from "../agents/BackgroundDispatchBudget";

/** Length-bounded, unambiguous identity derived from persisted producer state. */
export function dispatchOccurrenceKey(
  source: BackgroundDispatchSource,
  identity: readonly (string | number)[],
): string {
  return `${source}:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}
