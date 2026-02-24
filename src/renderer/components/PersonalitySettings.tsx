import { useState, useEffect, type ComponentType } from "react";
import {
  Briefcase,
  Smile,
  Zap,
  Palette,
  Wrench,
  Coffee,
  Sparkles,
  CircleCheckBig,
  type LucideProps,
} from "lucide-react";
import {
  PersonalitySettings as PersonalitySettingsType,
  PersonalityDefinition,
  PersonaDefinition,
  ResponseStylePreferences,
  PersonalityQuirks,
  EmojiUsage,
  ResponseLength,
  CodeCommentStyle,
  ExplanationDepth,
  AnalogyDomain,
  DEFAULT_RESPONSE_STYLE,
  DEFAULT_QUIRKS,
  DEFAULT_RELATIONSHIP,
  ANALOGY_DOMAINS,
} from "../../shared/types";

const PERSONALITY_ICONS: Record<string, ComponentType<LucideProps>> = {
  briefcase: Briefcase,
  smile: Smile,
  zap: Zap,
  palette: Palette,
  wrench: Wrench,
  coffee: Coffee,
  sparkles: Sparkles,
};

interface PersonalitySettingsProps {
  onSettingsChanged?: () => void;
}

export function PersonalitySettings({ onSettingsChanged }: PersonalitySettingsProps) {
  const [settings, setSettings] = useState<PersonalitySettingsType>({
    activePersonality: "professional",
    customPrompt: "",
    customName: "Custom Assistant",
    agentName: "CoWork",
    activePersona: "companion",
    responseStyle: DEFAULT_RESPONSE_STYLE,
    quirks: DEFAULT_QUIRKS,
    relationship: DEFAULT_RELATIONSHIP,
  });
  const [definitions, setDefinitions] = useState<PersonalityDefinition[]>([]);
  const [personas, setPersonas] = useState<PersonaDefinition[]>([]);
  const [relationshipStats, setRelationshipStats] = useState<{
    tasksCompleted: number;
    projectsCount: number;
    daysTogether: number;
    nextMilestone: number | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showCustomEditor, setShowCustomEditor] = useState(false);
  const [activeSection, setActiveSection] = useState<
    "personality" | "persona" | "style" | "quirks" | "relationship"
  >("personality");

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const [loadedSettings, loadedDefinitions] = await Promise.all([
        window.electronAPI.getPersonalitySettings(),
        window.electronAPI.getPersonalityDefinitions(),
      ]);

      // Load personas if API is available
      let loadedPersonas: PersonaDefinition[] = [];
      if (window.electronAPI.getPersonaDefinitions) {
        loadedPersonas = await window.electronAPI.getPersonaDefinitions();
      }

      // Load relationship stats if API is available
      let stats = null;
      if (window.electronAPI.getRelationshipStats) {
        stats = await window.electronAPI.getRelationshipStats();
      }

      setSettings({
        ...loadedSettings,
        responseStyle: loadedSettings.responseStyle || DEFAULT_RESPONSE_STYLE,
        quirks: loadedSettings.quirks || DEFAULT_QUIRKS,
        relationship: loadedSettings.relationship || DEFAULT_RELATIONSHIP,
      });
      setDefinitions(loadedDefinitions);
      setPersonas(loadedPersonas);
      setRelationshipStats(stats);
      setShowCustomEditor(loadedSettings.activePersonality === "custom");
    } catch (error) {
      console.error("Failed to load personality settings:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveSettings = async (newSettings: Partial<PersonalitySettingsType>) => {
    try {
      setSaving(true);
      const updated = { ...settings, ...newSettings };
      setSettings(updated);
      await window.electronAPI.savePersonalitySettings(updated);
      onSettingsChanged?.();
    } catch (error) {
      console.error("Failed to save settings:", error);
    } finally {
      setSaving(false);
    }
  };

  const handlePersonalitySelect = async (personalityId: string) => {
    setShowCustomEditor(personalityId === "custom");
    await handleSaveSettings({
      activePersonality: personalityId as PersonalitySettingsType["activePersonality"],
    });
  };

  const handlePersonaSelect = async (personaId: string) => {
    await handleSaveSettings({
      activePersona: personaId as PersonalitySettingsType["activePersona"],
    });
  };

  const handleResponseStyleChange = async (key: keyof ResponseStylePreferences, value: string) => {
    const newStyle = {
      ...settings.responseStyle,
      [key]: value,
    } as ResponseStylePreferences;
    await handleSaveSettings({ responseStyle: newStyle });
  };

  const handleQuirksChange = async (key: keyof PersonalityQuirks, value: string) => {
    const newQuirks = {
      ...settings.quirks,
      [key]: value,
    } as PersonalityQuirks;
    await handleSaveSettings({ quirks: newQuirks });
  };

  if (loading) {
    return <div className="settings-loading">Loading personality settings...</div>;
  }

  const activeDefinition = definitions.find((d) => d.id === settings.activePersonality);
  const activePersona = personas.find((p) => p.id === settings.activePersona);

  return (
    <div className="personality-settings">
      {/* Section Navigation */}
      <div className="personality-nav">
        <button
          className={`personality-nav-btn ${activeSection === "personality" ? "active" : ""}`}
          onClick={() => setActiveSection("personality")}
        >
          Personality
        </button>
        {personas.length > 0 && (
          <button
            className={`personality-nav-btn ${activeSection === "persona" ? "active" : ""}`}
            onClick={() => setActiveSection("persona")}
          >
            Personas
          </button>
        )}
        <button
          className={`personality-nav-btn ${activeSection === "style" ? "active" : ""}`}
          onClick={() => setActiveSection("style")}
        >
          Style
        </button>
        <button
          className={`personality-nav-btn ${activeSection === "quirks" ? "active" : ""}`}
          onClick={() => setActiveSection("quirks")}
        >
          Quirks
        </button>
        <button
          className={`personality-nav-btn ${activeSection === "relationship" ? "active" : ""}`}
          onClick={() => setActiveSection("relationship")}
        >
          Relationship
        </button>
      </div>

      {/* Agent Identity - Always visible */}
      <div className="settings-section">
        <h3>Agent Identity</h3>
        <p className="settings-description">
          Give your assistant a name. This is how it will identify itself when asked.
        </p>

        <div className="form-group">
          <label htmlFor="agent-name">Assistant Name</label>
          <div className="agent-name-input-row">
            <input
              id="agent-name"
              type="text"
              className="settings-input"
              placeholder="CoWork"
              value={settings.agentName || "CoWork"}
              onChange={(e) => setSettings({ ...settings, agentName: e.target.value })}
              maxLength={50}
            />
            <button
              className="button-primary"
              onClick={() => handleSaveSettings({ agentName: settings.agentName })}
              disabled={saving || !settings.agentName?.trim()}
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </div>

      {/* Personality Section */}
      {activeSection === "personality" && (
        <div className="settings-section">
          <h3>Base Personality</h3>
          <p className="settings-description">
            Choose how the assistant communicates. This sets the foundation for tone and style.
          </p>

          <div className="personality-grid">
            {definitions.map((personality) => (
              <div
                key={personality.id}
                className={`personality-card ${settings.activePersonality === personality.id ? "selected" : ""}`}
                onClick={() => handlePersonalitySelect(personality.id)}
              >
                <div className="personality-card-icon">
                  {(() => {
                    const Icon = PERSONALITY_ICONS[personality.icon];
                    return Icon ? <Icon size={22} strokeWidth={1.5} /> : personality.icon;
                  })()}
                </div>
                <div className="personality-card-content">
                  <div className="personality-card-name">{personality.name}</div>
                  <div className="personality-card-description">{personality.description}</div>
                  {personality.traits.length > 0 && (
                    <div className="personality-card-traits">
                      {personality.traits.map((trait) => (
                        <span key={trait} className="personality-trait">
                          {trait}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                {settings.activePersonality === personality.id && (
                  <div className="personality-card-check">
                    <CircleCheckBig size={20} strokeWidth={1.5} />
                  </div>
                )}
              </div>
            ))}
          </div>

          {showCustomEditor && (
            <div className="custom-personality-editor">
              <h4>Custom Personality Prompt</h4>
              <p className="settings-description">
                Define exactly how the assistant should behave and communicate.
              </p>
              <div className="form-group">
                <label htmlFor="custom-name">Personality Name</label>
                <input
                  id="custom-name"
                  type="text"
                  className="settings-input"
                  placeholder="My Custom Assistant"
                  value={settings.customName || ""}
                  onChange={(e) => setSettings({ ...settings, customName: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label htmlFor="custom-prompt">Personality Instructions</label>
                <textarea
                  id="custom-prompt"
                  className="settings-textarea"
                  placeholder="Describe how the assistant should communicate..."
                  value={settings.customPrompt || ""}
                  onChange={(e) => setSettings({ ...settings, customPrompt: e.target.value })}
                  rows={8}
                />
              </div>
              <button
                className="button-primary"
                onClick={() =>
                  handleSaveSettings({
                    customName: settings.customName,
                    customPrompt: settings.customPrompt,
                  })
                }
                disabled={saving}
              >
                {saving ? "Saving..." : "Save Custom Personality"}
              </button>
            </div>
          )}

          {activeDefinition && activeDefinition.id !== "custom" && (
            <div className="personality-preview">
              <h4>Active: {activeDefinition.name}</h4>
              <pre>{activeDefinition.promptTemplate}</pre>
            </div>
          )}
        </div>
      )}

      {/* Persona Section */}
      {activeSection === "persona" && personas.length > 0 && (
        <div className="settings-section">
          <h3>Character Persona</h3>
          <p className="settings-description">
            Add a character overlay to your assistant. This layers on top of the base personality.
          </p>

          <div className="persona-grid">
            {personas.map((persona) => (
              <div
                key={persona.id}
                className={`persona-card ${settings.activePersona === persona.id ? "selected" : ""}`}
                onClick={() => handlePersonaSelect(persona.id)}
              >
                <div className="persona-card-icon">{persona.icon}</div>
                <div className="persona-card-content">
                  <div className="persona-card-name">{persona.name}</div>
                  <div className="persona-card-description">{persona.description}</div>
                  {persona.sampleCatchphrase && (
                    <div className="persona-card-sample">"{persona.sampleCatchphrase}"</div>
                  )}
                </div>
                {settings.activePersona === persona.id && (
                  <div className="persona-card-check">
                    <CircleCheckBig size={20} strokeWidth={1.5} />
                  </div>
                )}
              </div>
            ))}
          </div>

          {activePersona && activePersona.id !== "none" && (
            <div className="persona-preview">
              <h4>Active Persona: {activePersona.name}</h4>
              <p>{activePersona.description}</p>
              {activePersona.suggestedName && (
                <p className="persona-suggestion">
                  <strong>Suggested name:</strong> {activePersona.suggestedName}
                  {settings.agentName !== activePersona.suggestedName && (
                    <button
                      className="button-small"
                      onClick={() => handleSaveSettings({ agentName: activePersona.suggestedName })}
                    >
                      Use this name
                    </button>
                  )}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Response Style Section */}
      {activeSection === "style" && (
        <div className="settings-section">
          <h3>Response Style</h3>
          <p className="settings-description">Fine-tune how the assistant responds to you.</p>

          <div className="style-controls">
            <div className="style-control">
              <label>Emoji Usage</label>
              <p className="style-hint">How much emoji to include in responses</p>
              <div className="style-options">
                {(["none", "minimal", "moderate", "expressive"] as EmojiUsage[]).map((option) => (
                  <button
                    key={option}
                    className={`style-option ${settings.responseStyle?.emojiUsage === option ? "selected" : ""}`}
                    onClick={() => handleResponseStyleChange("emojiUsage", option)}
                  >
                    {option === "none" && "None"}
                    {option === "minimal" && "Minimal"}
                    {option === "moderate" && "Moderate"}
                    {option === "expressive" && "Expressive"}
                  </button>
                ))}
              </div>
            </div>

            <div className="style-control">
              <label>Response Length</label>
              <p className="style-hint">How detailed responses should be</p>
              <div className="style-options">
                {(["terse", "balanced", "detailed"] as ResponseLength[]).map((option) => (
                  <button
                    key={option}
                    className={`style-option ${settings.responseStyle?.responseLength === option ? "selected" : ""}`}
                    onClick={() => handleResponseStyleChange("responseLength", option)}
                  >
                    {option === "terse" && "Terse"}
                    {option === "balanced" && "Balanced"}
                    {option === "detailed" && "Detailed"}
                  </button>
                ))}
              </div>
            </div>

            <div className="style-control">
              <label>Code Comments</label>
              <p className="style-hint">How verbose code comments should be</p>
              <div className="style-options">
                {(["minimal", "moderate", "verbose"] as CodeCommentStyle[]).map((option) => (
                  <button
                    key={option}
                    className={`style-option ${settings.responseStyle?.codeCommentStyle === option ? "selected" : ""}`}
                    onClick={() => handleResponseStyleChange("codeCommentStyle", option)}
                  >
                    {option === "minimal" && "Minimal"}
                    {option === "moderate" && "Moderate"}
                    {option === "verbose" && "Verbose"}
                  </button>
                ))}
              </div>
            </div>

            <div className="style-control">
              <label>Explanation Depth</label>
              <p className="style-hint">How much to explain concepts</p>
              <div className="style-options">
                {(["expert", "balanced", "teaching"] as ExplanationDepth[]).map((option) => (
                  <button
                    key={option}
                    className={`style-option ${settings.responseStyle?.explanationDepth === option ? "selected" : ""}`}
                    onClick={() => handleResponseStyleChange("explanationDepth", option)}
                  >
                    {option === "expert" && "Expert"}
                    {option === "balanced" && "Balanced"}
                    {option === "teaching" && "Teaching"}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Quirks Section */}
      {activeSection === "quirks" && (
        <div className="settings-section">
          <h3>Personality Quirks</h3>
          <p className="settings-description">
            Add unique touches that make your assistant feel more personal.
          </p>

          <div className="quirks-controls">
            <div className="form-group">
              <label htmlFor="catchphrase">Catchphrase</label>
              <p className="style-hint">A phrase the assistant occasionally uses</p>
              <input
                id="catchphrase"
                type="text"
                className="settings-input"
                placeholder='e.g., "Consider it done!" or "Let&apos;s dive in!"'
                value={settings.quirks?.catchphrase || ""}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    quirks: {
                      ...settings.quirks,
                      catchphrase: e.target.value,
                    } as PersonalityQuirks,
                  })
                }
                maxLength={100}
              />
            </div>

            <div className="form-group">
              <label htmlFor="signoff">Signature Sign-off</label>
              <p className="style-hint">How the assistant ends longer responses</p>
              <input
                id="signoff"
                type="text"
                className="settings-input"
                placeholder='e.g., "Happy coding!" or "Until next time..."'
                value={settings.quirks?.signOff || ""}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    quirks: { ...settings.quirks, signOff: e.target.value } as PersonalityQuirks,
                  })
                }
                maxLength={100}
              />
            </div>

            <div className="form-group">
              <label>Analogy Domain</label>
              <p className="style-hint">Preferred domain for analogies and examples</p>
              <div className="analogy-grid">
                {(Object.keys(ANALOGY_DOMAINS) as AnalogyDomain[]).map((domain) => (
                  <button
                    key={domain}
                    className={`analogy-option ${settings.quirks?.analogyDomain === domain ? "selected" : ""}`}
                    onClick={() => handleQuirksChange("analogyDomain", domain)}
                  >
                    <span className="analogy-name">{ANALOGY_DOMAINS[domain].name}</span>
                    {ANALOGY_DOMAINS[domain].examples && (
                      <span className="analogy-example">{ANALOGY_DOMAINS[domain].examples}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            <button
              className="button-primary"
              onClick={() => handleSaveSettings({ quirks: settings.quirks })}
              disabled={saving}
            >
              {saving ? "Saving..." : "Save Quirks"}
            </button>
          </div>
        </div>
      )}

      {/* Relationship Section */}
      {activeSection === "relationship" && (
        <div className="settings-section">
          <h3>Relationship</h3>
          <p className="settings-description">
            Build a relationship with your assistant over time.
          </p>

          <div className="form-group">
            <label htmlFor="user-name">Your Name</label>
            <p className="style-hint">The assistant will use this to personalize interactions</p>
            <div className="agent-name-input-row">
              <input
                id="user-name"
                type="text"
                className="settings-input"
                placeholder="What should I call you?"
                value={settings.relationship?.userName || ""}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    relationship: {
                      ...DEFAULT_RELATIONSHIP,
                      ...settings.relationship,
                      userName: e.target.value,
                    },
                  })
                }
                maxLength={50}
              />
              <button
                className="button-primary"
                onClick={() => handleSaveSettings({ relationship: settings.relationship })}
                disabled={saving}
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>

          {relationshipStats && (
            <div className="relationship-stats">
              <h4>Our Journey Together</h4>
              <div className="stats-grid">
                <div className="stat-card">
                  <div className="stat-value">{relationshipStats.tasksCompleted}</div>
                  <div className="stat-label">Tasks Completed</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{relationshipStats.projectsCount}</div>
                  <div className="stat-label">Projects</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{relationshipStats.daysTogether}</div>
                  <div className="stat-label">Days Together</div>
                </div>
              </div>
              {relationshipStats.nextMilestone && (
                <div className="milestone-progress">
                  <div className="progress-bar">
                    <div
                      className="progress-fill"
                      style={{
                        width: `${Math.min((relationshipStats.tasksCompleted / relationshipStats.nextMilestone) * 100, 100)}%`,
                      }}
                    />
                  </div>
                  <span className="progress-text">
                    {relationshipStats.tasksCompleted} / {relationshipStats.nextMilestone} to next
                    milestone
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Tips */}
      <div className="settings-tip">
        <h4>Chat Commands</h4>
        <ul className="command-examples">
          <li>
            <code>be more friendly</code> - Switch personality
          </li>
          <li>
            <code>call yourself Jarvis</code> - Change name
          </li>
          <li>
            <code>my name is Alex</code> - Set your name
          </li>
          <li>
            <code>be like a pirate</code> - Apply persona
          </li>
        </ul>
      </div>
    </div>
  );
}
