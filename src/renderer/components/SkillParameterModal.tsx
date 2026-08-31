import { useState, useEffect, useRef } from "react";
import { CustomSkill, SkillParameter } from "../../shared/types";

export type SkillParameterFormValue = string | number | boolean;
export type SkillParameterFormValues = Record<string, SkillParameterFormValue>;

interface SkillParameterModalProps {
  skill: CustomSkill;
  onSubmit: (values: SkillParameterFormValues) => void;
  onAskInChat?: (values: SkillParameterFormValues) => void;
  onCancel: () => void;
}

const ARTIFACT_DIR_FALLBACK = "artifacts";

function normalizeTemplateDefault(value: unknown): unknown {
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

export function SkillParameterModal({
  skill,
  onSubmit,
  onAskInChat,
  onCancel,
}: SkillParameterModalProps) {
  const [values, setValues] = useState<SkillParameterFormValues>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const firstInputRef = useRef<HTMLInputElement | HTMLSelectElement>(null);

  // Initialize with default values
  useEffect(() => {
    const initialValues: SkillParameterFormValues = {};
    skill.parameters?.forEach((param) => {
      if (param.default !== undefined) {
        initialValues[param.name] = normalizeTemplateDefault(param.default) as
          | string
          | number
          | boolean;
      } else if (param.type === "boolean") {
        initialValues[param.name] = false;
      } else if (param.type === "number") {
        initialValues[param.name] = 0;
      } else {
        initialValues[param.name] = "";
      }
    });
    setValues(initialValues);
    setTouched({});
  }, [skill]);

  // Focus first input on mount
  useEffect(() => {
    setTimeout(() => {
      firstInputRef.current?.focus();
    }, 100);
  }, []);

  // Handle escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel();
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [onCancel]);

  const handleChange = (name: string, value: string | number | boolean) => {
    setTouched((prev) => ({ ...prev, [name]: true }));
    setValues((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(collectSkillParameterValues(skill, values, touched));
  };

  const handleAskInChat = () => {
    if (!onAskInChat) return;
    onAskInChat(collectSkillParameterValues(skill, values, touched));
  };

  const isValid = () => {
    return (
      skill.parameters?.every((param) => {
        if (param.required && param.default === undefined) {
          const value = values[param.name];
          if (value === undefined) return false;
          if (typeof value === "string" && value.trim() === "") return false;
          if (
            (param.type === "number" || param.type === "boolean") &&
            touched[param.name] !== true
          ) {
            return false;
          }
        }
        return true;
      }) ?? true
    );
  };

  const renderInput = (param: SkillParameter, index: number) => {
    const commonProps = {
      id: `param-${param.name}`,
      ref: index === 0 ? firstInputRef : undefined,
    };

    switch (param.type) {
      case "select":
        return (
          <select
            {...commonProps}
            ref={index === 0 ? (firstInputRef as React.RefObject<HTMLSelectElement>) : undefined}
            className="skill-param-select"
            value={String(values[param.name] ?? param.default ?? "")}
            onChange={(e) => handleChange(param.name, e.target.value)}
          >
            {param.options?.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        );

      case "boolean":
        return (
          <label className="skill-param-checkbox">
            <input
              type="checkbox"
              checked={Boolean(values[param.name])}
              onChange={(e) => handleChange(param.name, e.target.checked)}
            />
            <span>{param.description}</span>
          </label>
        );

      case "number":
        return (
          <input
            {...commonProps}
            ref={index === 0 ? (firstInputRef as React.RefObject<HTMLInputElement>) : undefined}
            type="number"
            className="skill-param-input"
            value={Number(values[param.name] ?? param.default ?? 0)}
            onChange={(e) => handleChange(param.name, parseFloat(e.target.value) || 0)}
            placeholder={param.description}
          />
        );

      case "string":
      default:
        return (
          <input
            {...commonProps}
            ref={index === 0 ? (firstInputRef as React.RefObject<HTMLInputElement>) : undefined}
            type="text"
            className="skill-param-input"
            value={String(values[param.name] ?? "")}
            onChange={(e) => handleChange(param.name, e.target.value)}
            placeholder={param.description}
          />
        );
    }
  };

  return (
    <div className="skill-param-modal-overlay" onClick={onCancel}>
      <div className="skill-param-modal" onClick={(e) => e.stopPropagation()}>
        <div className="skill-param-modal-header">
          <span className="skill-param-modal-icon">{skill.icon}</span>
          <div className="skill-param-modal-title">
            <h3>{skill.name}</h3>
            <p>{skill.description}</p>
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="skill-param-modal-body">
            {skill.parameters?.map((param, index) => (
              <div key={param.name} className="skill-param-field">
                {param.type !== "boolean" && (
                  <label htmlFor={`param-${param.name}`}>
                    {param.name}
                    {param.required && <span className="required">*</span>}
                  </label>
                )}
                {renderInput(param, index)}
                {param.type !== "boolean" && param.description && (
                  <span className="skill-param-hint">{param.description}</span>
                )}
              </div>
            ))}
          </div>

          <div className="skill-param-modal-footer">
            <button type="button" className="button-secondary" onClick={onCancel}>
              Cancel
            </button>
            {onAskInChat && (
              <button type="button" className="button-secondary" onClick={handleAskInChat}>
                Ask In Chat
              </button>
            )}
            <button type="submit" className="button-primary" disabled={!isValid()}>
              Run Skill
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
