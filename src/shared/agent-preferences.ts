import type { PersonalityId } from "./types";

/**
 * Shared preference resolution helpers used by both UI-driven orchestration and
 * tool-driven sub-agent spawning.
 */

export function resolveModelPreferenceToModelKey(
  preference: string | undefined | null,
): string | undefined {
  const pref = (typeof preference === "string" ? preference.trim().toLowerCase() : "") || "";
  switch (pref) {
    case "":
    case "same":
      return undefined;
    case "cheaper":
    case "haiku":
      return "haiku-4-5";
    case "smarter":
    case "opus":
      return "opus-4-5";
    case "sonnet":
      return "sonnet-4-6";
    default:
      // If the preference is unknown, don't override model selection.
      return undefined;
  }
}

export function resolvePersonalityPreference(
  preference: string | undefined | null,
): PersonalityId | undefined {
  const pref = (typeof preference === "string" ? preference.trim().toLowerCase() : "") || "";
  if (!pref || pref === "same") return undefined;

  const valid: PersonalityId[] = [
    "professional",
    "friendly",
    "concise",
    "creative",
    "technical",
    "casual",
  ];
  if (valid.includes(pref as PersonalityId)) return pref as PersonalityId;
  return undefined;
}
