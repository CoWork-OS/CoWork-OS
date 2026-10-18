import type { CustomSkill } from "../../shared/types";

export function buildSlashSkillPrompt(skillId: string, values?: SkillParameterFormValues): string {
  const entries = Object.entries(values || {});
  if (entries.length === 0) {
    return `/${skillId}`;
  }
  return `/${skillId} ${JSON.stringify(Object.fromEntries(entries))}`;
}

export type SkillParameterFormValue = string | number | boolean;

export type SkillParameterFormValues = Record<string, SkillParameterFormValue>;

const ARTIFACT_DIR_FALLBACK = "artifacts";

export function normalizeTemplateDefault(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value.replace(/\{artifactDir\}/g, ARTIFACT_DIR_FALLBACK);
}

export function collectSkillParameterValues(
  skill: CustomSkill,
  values: SkillParameterFormValues,
  touched: Record<string, boolean> = {},
): SkillParameterFormValues {
  const collected: SkillParameterFormValues = {};
  for (const param of skill.parameters || []) {
    const value = values[param.name];
    const hasDefault = param.default !== undefined;
    const wasTouched = touched[param.name] === true;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        collected[param.name] = trimmed;
      } else if (hasDefault) {
        collected[param.name] = normalizeTemplateDefault(param.default) as SkillParameterFormValue;
      }
      continue;
    }
    if (value !== undefined && (wasTouched || hasDefault)) {
      collected[param.name] = hasDefault
        ? (normalizeTemplateDefault(value) as SkillParameterFormValue)
        : value;
    }
  }
  return collected;
}

export function expandSkillPrompt(skill: CustomSkill, values: SkillParameterFormValues): string {
  let prompt = skill.prompt;
  skill.parameters?.forEach((param) => {
    const value = values[param.name] ?? normalizeTemplateDefault(param.default) ?? "";
    const placeholder = new RegExp(`\\{\\{${param.name}\\}\\}`, "g");
    const normalizedValue =
      typeof value === "string" ? value.replace(/\{artifactDir\}/g, ARTIFACT_DIR_FALLBACK) : value;
    prompt = prompt.replace(placeholder, String(normalizedValue));
  });
  prompt = prompt.replace(/\{\{[^}]+\}\}/g, "");
  prompt = prompt.replace(/\{artifactDir\}/g, ARTIFACT_DIR_FALLBACK);
  return prompt.trim();
}
