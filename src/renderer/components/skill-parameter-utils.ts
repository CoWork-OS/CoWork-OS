import type { SkillParameterFormValues } from "./SkillParameterModal";

export function buildSlashSkillPrompt(skillId: string, values?: SkillParameterFormValues): string {
  const entries = Object.entries(values || {});
  if (entries.length === 0) {
    return `/${skillId}`;
  }
  return `/${skillId} ${JSON.stringify(Object.fromEntries(entries))}`;
}
