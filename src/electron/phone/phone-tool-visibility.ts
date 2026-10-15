import { TOOL_GROUPS } from "../../shared/types";

/** A generated title containing "Search" cannot hide the user's Android workflow. */
export function readOnlyReviewSystemRestrictions(userPrompt: string): string[] {
  const phone = /\bandroid\b|\bemulator-\d+\b|phone-harness|phone\.android\.|android_phone_/i.test(
    userPrompt,
  );
  const workflow =
    /\b(?:tap|type|type_text|observe|screenshot|open)\b|phone\.android\.|android_phone_/i.test(
      userPrompt,
    );
  if (!phone || !workflow) return ["group:system"];
  // Expand only this title heuristic. Explicit user/agent group restrictions
  // remain separate in the registry and still deny Android tools.
  return TOOL_GROUPS["group:system"].filter((name) => !name.startsWith("android_phone_"));
}
