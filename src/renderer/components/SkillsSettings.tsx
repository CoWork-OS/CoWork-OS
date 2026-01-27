import { useState, useEffect } from 'react';
import { CustomSkill, SkillParameter } from '../../shared/types';

interface SkillsSettingsProps {
  onSkillSelect?: (skill: CustomSkill) => void;
}

export function SkillsSettings({ onSkillSelect }: SkillsSettingsProps) {
  const [skills, setSkills] = useState<CustomSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingSkill, setEditingSkill] = useState<CustomSkill | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load skills on mount
  useEffect(() => {
    loadSkills();
  }, []);

  const loadSkills = async () => {
    try {
      setLoading(true);
      const loadedSkills = await window.electronAPI.listCustomSkills();
      setSkills(loadedSkills);
      setError(null);
    } catch (err) {
      setError('Failed to load skills');
      console.error('Failed to load skills:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleReload = async () => {
    try {
      const reloadedSkills = await window.electronAPI.reloadCustomSkills();
      setSkills(reloadedSkills);
      setError(null);
    } catch (err) {
      setError('Failed to reload skills');
    }
  };

  const handleOpenFolder = async () => {
    await window.electronAPI.openCustomSkillsFolder();
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this skill?')) return;

    try {
      await window.electronAPI.deleteCustomSkill(id);
      setSkills(prev => prev.filter(s => s.id !== id));
    } catch (err) {
      setError('Failed to delete skill');
    }
  };

  const handleEdit = (skill: CustomSkill) => {
    setEditingSkill({ ...skill });
    setIsCreating(false);
  };

  const handleCreate = () => {
    setEditingSkill({
      id: '',
      name: '',
      description: '',
      icon: '⚡',
      prompt: '',
      category: '',
      enabled: true,
      parameters: [],
    });
    setIsCreating(true);
  };

  const handleSave = async () => {
    if (!editingSkill) return;

    try {
      if (isCreating) {
        const created = await window.electronAPI.createCustomSkill(editingSkill);
        setSkills(prev => [...prev, created]);
      } else {
        const updated = await window.electronAPI.updateCustomSkill(editingSkill.id, editingSkill);
        setSkills(prev => prev.map(s => s.id === updated.id ? updated : s));
      }
      setEditingSkill(null);
      setIsCreating(false);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to save skill');
    }
  };

  const handleCancel = () => {
    setEditingSkill(null);
    setIsCreating(false);
  };

  // Group skills by category
  const groupedSkills = skills.reduce((acc, skill) => {
    const category = skill.category || 'Uncategorized';
    if (!acc[category]) acc[category] = [];
    acc[category].push(skill);
    return acc;
  }, {} as Record<string, CustomSkill[]>);

  if (loading) {
    return <div className="settings-loading">Loading skills...</div>;
  }

  // Edit/Create form
  if (editingSkill) {
    return (
      <SkillEditor
        skill={editingSkill}
        isCreating={isCreating}
        onChange={setEditingSkill}
        onSave={handleSave}
        onCancel={handleCancel}
        error={error}
      />
    );
  }

  return (
    <div className="skills-settings">
      <div className="settings-section">
        <div className="settings-section-header">
          <h3>Custom Skills</h3>
          <div className="settings-section-actions">
            <button className="btn-secondary btn-sm" onClick={handleOpenFolder}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
              </svg>
              Open Folder
            </button>
            <button className="btn-secondary btn-sm" onClick={handleReload}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M23 4v6h-6M1 20v-6h6" />
                <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
              </svg>
              Reload
            </button>
            <button className="btn-primary btn-sm" onClick={handleCreate}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              New Skill
            </button>
          </div>
        </div>
        <p className="settings-description">
          Create custom prompt templates to automate common tasks. Skills are stored as JSON files
          and can be shared or version controlled.
        </p>
      </div>

      {error && (
        <div className="settings-error">{error}</div>
      )}

      {skills.length === 0 ? (
        <div className="skills-empty">
          <p>No custom skills found.</p>
          <p>Click "New Skill" to create your first skill, or "Open Folder" to add skill JSON files manually.</p>
        </div>
      ) : (
        <div className="skills-list">
          {Object.entries(groupedSkills).map(([category, categorySkills]) => (
            <div key={category} className="skills-category">
              <h4 className="skills-category-title">{category}</h4>
              <div className="skills-grid">
                {categorySkills.map(skill => (
                  <div key={skill.id} className="skill-card">
                    <div className="skill-card-header">
                      <span className="skill-icon">{skill.icon}</span>
                      <div className="skill-info">
                        <span className="skill-name">{skill.name}</span>
                        <span className="skill-description">{skill.description}</span>
                      </div>
                    </div>
                    <div className="skill-card-actions">
                      {onSkillSelect && (
                        <button
                          className="btn-primary btn-xs"
                          onClick={() => onSkillSelect(skill)}
                        >
                          Use
                        </button>
                      )}
                      <button
                        className="btn-secondary btn-xs"
                        onClick={() => handleEdit(skill)}
                      >
                        Edit
                      </button>
                      <button
                        className="btn-danger btn-xs"
                        onClick={() => handleDelete(skill.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Skill Editor Component
interface SkillEditorProps {
  skill: CustomSkill;
  isCreating: boolean;
  onChange: (skill: CustomSkill) => void;
  onSave: () => void;
  onCancel: () => void;
  error: string | null;
}

function SkillEditor({ skill, isCreating, onChange, onSave, onCancel, error }: SkillEditorProps) {
  const updateField = <K extends keyof CustomSkill>(field: K, value: CustomSkill[K]) => {
    onChange({ ...skill, [field]: value });
  };

  const addParameter = () => {
    const newParam: SkillParameter = {
      name: '',
      type: 'string',
      description: '',
      required: false,
    };
    onChange({ ...skill, parameters: [...(skill.parameters || []), newParam] });
  };

  const updateParameter = (index: number, updates: Partial<SkillParameter>) => {
    const params = [...(skill.parameters || [])];
    params[index] = { ...params[index], ...updates };
    onChange({ ...skill, parameters: params });
  };

  const removeParameter = (index: number) => {
    const params = [...(skill.parameters || [])];
    params.splice(index, 1);
    onChange({ ...skill, parameters: params });
  };

  return (
    <div className="skill-editor">
      <div className="settings-section">
        <h3>{isCreating ? 'Create New Skill' : 'Edit Skill'}</h3>
      </div>

      {error && <div className="settings-error">{error}</div>}

      <div className="skill-editor-form">
        <div className="form-row">
          <div className="form-group form-group-icon">
            <label>Icon</label>
            <input
              type="text"
              value={skill.icon}
              onChange={e => updateField('icon', e.target.value)}
              placeholder="⚡"
              maxLength={2}
            />
          </div>
          <div className="form-group form-group-flex">
            <label>Name *</label>
            <input
              type="text"
              value={skill.name}
              onChange={e => updateField('name', e.target.value)}
              placeholder="My Custom Skill"
            />
          </div>
        </div>

        <div className="form-row">
          <div className="form-group form-group-flex">
            <label>Category</label>
            <input
              type="text"
              value={skill.category || ''}
              onChange={e => updateField('category', e.target.value)}
              placeholder="Development, Documentation, etc."
            />
          </div>
        </div>

        <div className="form-group">
          <label>Description *</label>
          <input
            type="text"
            value={skill.description}
            onChange={e => updateField('description', e.target.value)}
            placeholder="What does this skill do?"
          />
        </div>

        <div className="form-group">
          <label>Prompt Template *</label>
          <textarea
            value={skill.prompt}
            onChange={e => updateField('prompt', e.target.value)}
            placeholder="Enter the prompt template. Use {{parameterName}} for placeholders."
            rows={8}
          />
          <p className="form-hint">
            Use {'{{parameterName}}'} syntax to insert parameter values into the prompt.
          </p>
        </div>

        <div className="form-section">
          <div className="form-section-header">
            <h4>Parameters</h4>
            <button className="btn-secondary btn-xs" onClick={addParameter}>
              + Add Parameter
            </button>
          </div>

          {(skill.parameters || []).length === 0 ? (
            <p className="form-hint">No parameters defined. Add parameters to make your skill configurable.</p>
          ) : (
            <div className="parameters-list">
              {(skill.parameters || []).map((param, index) => (
                <div key={index} className="parameter-item">
                  <div className="parameter-row">
                    <div className="form-group form-group-sm">
                      <label>Name</label>
                      <input
                        type="text"
                        value={param.name}
                        onChange={e => updateParameter(index, { name: e.target.value })}
                        placeholder="paramName"
                      />
                    </div>
                    <div className="form-group form-group-sm">
                      <label>Type</label>
                      <select
                        value={param.type}
                        onChange={e => updateParameter(index, { type: e.target.value as SkillParameter['type'] })}
                      >
                        <option value="string">String</option>
                        <option value="number">Number</option>
                        <option value="boolean">Boolean</option>
                        <option value="select">Select</option>
                      </select>
                    </div>
                    <div className="form-group form-group-sm">
                      <label>Required</label>
                      <input
                        type="checkbox"
                        checked={param.required || false}
                        onChange={e => updateParameter(index, { required: e.target.checked })}
                      />
                    </div>
                    <button
                      className="btn-danger btn-xs"
                      onClick={() => removeParameter(index)}
                    >
                      Remove
                    </button>
                  </div>
                  <div className="parameter-row">
                    <div className="form-group form-group-flex">
                      <label>Description</label>
                      <input
                        type="text"
                        value={param.description}
                        onChange={e => updateParameter(index, { description: e.target.value })}
                        placeholder="What is this parameter for?"
                      />
                    </div>
                    <div className="form-group form-group-sm">
                      <label>Default</label>
                      <input
                        type="text"
                        value={String(param.default || '')}
                        onChange={e => updateParameter(index, { default: e.target.value })}
                        placeholder="Default value"
                      />
                    </div>
                  </div>
                  {param.type === 'select' && (
                    <div className="parameter-row">
                      <div className="form-group form-group-flex">
                        <label>Options (comma-separated)</label>
                        <input
                          type="text"
                          value={(param.options || []).join(', ')}
                          onChange={e => updateParameter(index, {
                            options: e.target.value.split(',').map(s => s.trim()).filter(Boolean)
                          })}
                          placeholder="option1, option2, option3"
                        />
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="skill-editor-actions">
        <button className="btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="btn-primary"
          onClick={onSave}
          disabled={!skill.name || !skill.description || !skill.prompt}
        >
          {isCreating ? 'Create Skill' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
}
