import { Briefcase, Smile, Zap, Palette, Wrench, Coffee } from "lucide-react";
import type { PersonalityConfigV2, PersonalityTrait } from "../../../shared/types";
import { TRAIT_DEFINITIONS } from "../../../shared/types";

const PRESET_ICONS: Record<string, typeof Briefcase> = {
  professional: Briefcase,
  friendly: Smile,
  concise: Zap,
  creative: Palette,
  technical: Wrench,
  casual: Coffee,
};

interface PersonalityTraitsTabProps {
  config: PersonalityConfigV2;
  presets: Record<string, { name: string; description: string; icon: string; traits: Record<string, number> }>;
  onUpdate: (updates: Partial<PersonalityConfigV2>) => void;
  onSave: () => Promise<void>;
  saving: boolean;
  onToast?: (msg: string) => void;
}

export function PersonalityTraitsTab({
  config,
  presets,
  onUpdate,
  onSave,
  saving,
  onToast,
}: PersonalityTraitsTabProps) {
  const applyPreset = (presetId: string) => {
    const preset = presets[presetId];
    if (!preset) return;
    const traits: PersonalityTrait[] = TRAIT_DEFINITIONS.map((def) => ({
      id: def.id,
      label: def.label,
      intensity: preset.traits[def.id] ?? def.defaultIntensity,
      description: def.description,
    }));
    onUpdate({ traits });
    onSave();
    onToast?.(`Applied ${preset.name} template`);
  };

  const setTraitIntensity = (id: string, intensity: number) => {
    const traits = config.traits.map((t) =>
      t.id === id ? { ...t, intensity } : t,
    );
    onUpdate({ traits });
  };

  return (
    <div className="personality-traits-tab settings-section">
      <h3>Personality</h3>
      <p className="settings-description">
        Quick-start presets and composable trait sliders.
      </p>

      <div className="preset-quick-start">
        <h4>Quick Start</h4>
        <div className="preset-grid">
          {Object.entries(presets).map(([id, p]) => {
            const Icon = PRESET_ICONS[id];
            return (
              <button
                key={id}
                type="button"
                className="preset-btn"
                onClick={() => applyPreset(id)}
                title={p.description}
              >
                {Icon ? <Icon size={18} /> : null}
                <span>{p.name}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="trait-sliders">
        <h4>Trait Mixer</h4>
        {config.traits.map((trait) => {
          const def = TRAIT_DEFINITIONS.find((d) => d.id === trait.id);
          if (!def) return null;
          const label =
            trait.intensity >= 70
              ? def.highLabel
              : trait.intensity <= 30
                ? def.lowLabel
                : "Balanced";
          return (
            <div key={trait.id} className="trait-row">
              <label>
                {def.label}: {trait.intensity} — {label}
              </label>
              <input
                type="range"
                min={0}
                max={100}
                value={trait.intensity}
                onChange={(e) =>
                  setTraitIntensity(trait.id, parseInt(e.target.value, 10))
                }
                onMouseUp={onSave}
                onTouchEnd={onSave}
              />
            </div>
          );
        })}
      </div>

      <details className="persona-overlay-collapse">
        <summary>Persona overlay (optional)</summary>
        <p className="style-hint">
          Add a character overlay. Personas are available in the Style tab.
        </p>
      </details>
    </div>
  );
}
