import { CircleCheckBig } from "lucide-react";
import type {
  PersonalityConfigV2,
  PersonaDefinition,
  EmojiUsage,
  ResponseLength,
  CodeCommentStyle,
  ExplanationDepth,
} from "../../../shared/types";
import { ANALOGY_DOMAINS } from "../../../shared/types";

interface PersonalityStyleTabProps {
  config: PersonalityConfigV2;
  personas: PersonaDefinition[];
  onUpdate: (updates: Partial<PersonalityConfigV2>) => void;
  onSave: () => Promise<void>;
  saving: boolean;
}

export function PersonalityStyleTab({
  config,
  personas,
  onUpdate,
  onSave,
  saving: _saving,
}: PersonalityStyleTabProps) {
  const style = config.style;
  const quirks = config.quirks ?? {};

  const setStyle = <K extends keyof typeof style>(key: K, value: (typeof style)[K]) => {
    onUpdate({ style: { ...style, [key]: value } });
    onSave();
  };

  const setQuirk = <K extends keyof typeof quirks>(key: K, value: (typeof quirks)[K]) => {
    onUpdate({ quirks: { ...quirks, [key]: value } });
    onSave();
  };

  const setPersona = (id: string) => {
    onUpdate({ activePersona: id as PersonalityConfigV2["activePersona"] });
    onSave();
  };

  return (
    <div className="personality-style-tab settings-section">
      <h3>Style</h3>
      <p className="settings-description">
        Communication style and persona overlay.
      </p>

      <div className="style-controls">
        <div className="style-control">
          <label>Emoji Usage</label>
          <div className="style-options">
            {(["none", "minimal", "moderate", "expressive"] as EmojiUsage[]).map((opt) => (
              <button
                key={opt}
                type="button"
                className={`style-option ${style.emojiUsage === opt ? "selected" : ""}`}
                onClick={() => setStyle("emojiUsage", opt)}
              >
                {opt.charAt(0).toUpperCase() + opt.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="style-control">
          <label>Response Length</label>
          <div className="style-options">
            {(["terse", "balanced", "detailed"] as ResponseLength[]).map((opt) => (
              <button
                key={opt}
                type="button"
                className={`style-option ${style.responseLength === opt ? "selected" : ""}`}
                onClick={() => setStyle("responseLength", opt)}
              >
                {opt.charAt(0).toUpperCase() + opt.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="style-control">
          <label>Code Comments</label>
          <div className="style-options">
            {(["minimal", "moderate", "verbose"] as CodeCommentStyle[]).map((opt) => (
              <button
                key={opt}
                type="button"
                className={`style-option ${style.codeCommentStyle === opt ? "selected" : ""}`}
                onClick={() => setStyle("codeCommentStyle", opt)}
              >
                {opt.charAt(0).toUpperCase() + opt.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="style-control">
          <label>Explanation Depth</label>
          <div className="style-options">
            {(["expert", "balanced", "teaching"] as ExplanationDepth[]).map((opt) => (
              <button
                key={opt}
                type="button"
                className={`style-option ${style.explanationDepth === opt ? "selected" : ""}`}
                onClick={() => setStyle("explanationDepth", opt)}
              >
                {opt.charAt(0).toUpperCase() + opt.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="style-control">
          <label>Formality</label>
          <div className="style-options">
            {(["casual", "balanced", "formal"] as const).map((opt) => (
              <button
                key={opt}
                type="button"
                className={`style-option ${style.formality === opt ? "selected" : ""}`}
                onClick={() => setStyle("formality", opt)}
              >
                {opt.charAt(0).toUpperCase() + opt.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="style-control">
          <label>Structure</label>
          <div className="style-options">
            {(["freeform", "bullets", "structured", "headers"] as const).map((opt) => (
              <button
                key={opt}
                type="button"
                className={`style-option ${style.structurePreference === opt ? "selected" : ""}`}
                onClick={() => setStyle("structurePreference", opt)}
              >
                {opt.charAt(0).toUpperCase() + opt.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="style-control">
          <label>Proactivity</label>
          <div className="style-options">
            {(["reactive", "balanced", "proactive"] as const).map((opt) => (
              <button
                key={opt}
                type="button"
                className={`style-option ${style.proactivity === opt ? "selected" : ""}`}
                onClick={() => setStyle("proactivity", opt)}
              >
                {opt.charAt(0).toUpperCase() + opt.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="style-control">
          <label>Error Handling</label>
          <div className="style-options">
            {(["gentle", "direct", "detailed"] as const).map((opt) => (
              <button
                key={opt}
                type="button"
                className={`style-option ${style.errorHandling === opt ? "selected" : ""}`}
                onClick={() => setStyle("errorHandling", opt)}
              >
                {opt.charAt(0).toUpperCase() + opt.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <details className="quirks-collapse">
        <summary>Quirks</summary>
        <div className="quirks-controls">
          <div className="form-group">
            <label htmlFor="catchphrase">Catchphrase</label>
            <input
              id="catchphrase"
              type="text"
              className="settings-input"
              placeholder='e.g. "Consider it done!"'
              value={quirks.catchphrase ?? ""}
              onChange={(e) => setQuirk("catchphrase", e.target.value)}
              maxLength={100}
            />
          </div>
          <div className="form-group">
            <label htmlFor="signoff">Signature Sign-off</label>
            <input
              id="signoff"
              type="text"
              className="settings-input"
              placeholder='e.g. "Happy coding!"'
              value={quirks.signOff ?? ""}
              onChange={(e) => setQuirk("signOff", e.target.value)}
              maxLength={100}
            />
          </div>
          <div className="form-group">
            <label>Analogy Domain</label>
            <div className="analogy-grid">
              {(Object.keys(ANALOGY_DOMAINS) as (keyof typeof ANALOGY_DOMAINS)[]).map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`analogy-option ${quirks.analogyDomain === d ? "selected" : ""}`}
                  onClick={() => setQuirk("analogyDomain", d)}
                >
                  {ANALOGY_DOMAINS[d].name}
                </button>
              ))}
            </div>
          </div>
        </div>
      </details>

      <details className="persona-collapse">
        <summary>Persona Overlay</summary>
        <div className="persona-grid">
          {personas.map((p) => (
            <div
              key={p.id}
              role="button"
              tabIndex={0}
              className={`persona-card ${config.activePersona === p.id ? "selected" : ""}`}
              onClick={() => setPersona(p.id)}
              onKeyDown={(e) => e.key === "Enter" && setPersona(p.id)}
            >
              <div className="persona-card-icon">{p.icon}</div>
              <div className="persona-card-content">
                <div className="persona-card-name">{p.name}</div>
                <div className="persona-card-description">{p.description}</div>
              </div>
              {config.activePersona === p.id && (
                <div className="persona-card-check">
                  <CircleCheckBig size={20} strokeWidth={1.5} />
                </div>
              )}
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
