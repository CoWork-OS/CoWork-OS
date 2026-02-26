import { useState } from "react";
import { AgentWorkingStateData, WorkingStateType } from "../../electron/preload";

interface WorkingStateEditorProps {
  state: AgentWorkingStateData;
  onSave: (state: AgentWorkingStateData) => void;
  onCancel: () => void;
}

const STATE_TYPE_LABELS: Record<
  WorkingStateType,
  { label: string; icon: string; placeholder: string }
> = {
  context: {
    label: "Context",
    icon: "📋",
    placeholder: "Describe the current context, background information, and key understanding...",
  },
  progress: {
    label: "Progress",
    icon: "📊",
    placeholder: "Document current progress, completed items, and work status...",
  },
  notes: {
    label: "Notes",
    icon: "📝",
    placeholder: "Record important observations, reminders, and things to remember...",
  },
  plan: {
    label: "Plan",
    icon: "🎯",
    placeholder: "Outline the action plan, next steps, and goals...",
  },
};

export function WorkingStateEditor({ state, onSave, onCancel }: WorkingStateEditorProps) {
  const [content, setContent] = useState(state.content);
  const [fileReferences, setFileReferences] = useState<string>(
    state.fileReferences?.join("\n") || "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const config = STATE_TYPE_LABELS[state.stateType];
  const isNew = !state.id;

  const handleSave = async () => {
    if (!content.trim()) {
      setError("Content cannot be empty");
      return;
    }

    try {
      setSaving(true);
      setError(null);

      const refs = fileReferences
        .split("\n")
        .map((r) => r.trim())
        .filter(Boolean);

      const updatedState = await window.electronAPI.updateWorkingState({
        agentRoleId: state.agentRoleId,
        workspaceId: state.workspaceId,
        taskId: state.taskId,
        stateType: state.stateType,
        content: content.trim(),
        fileReferences: refs.length > 0 ? refs : undefined,
      });

      onSave(updatedState);
    } catch (err: Any) {
      console.error("Failed to save working state:", err);
      setError(err.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="working-state-editor-overlay" onClick={onCancel}>
      <div className="working-state-editor" onClick={(e) => e.stopPropagation()}>
        <div className="editor-header">
          <div className="editor-title">
            <span className="title-icon">{config.icon}</span>
            <span className="title-text">
              {isNew ? "Add" : "Edit"} {config.label}
            </span>
          </div>
          <button className="close-btn" onClick={onCancel}>
            ✕
          </button>
        </div>

        {error && <div className="editor-error">{error}</div>}

        <div className="editor-form">
          <div className="form-group">
            <label>Content</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={config.placeholder}
              rows={12}
              autoFocus
            />
          </div>

          <div className="form-group">
            <label>
              Referenced Files <span className="label-hint">(one per line, optional)</span>
            </label>
            <textarea
              value={fileReferences}
              onChange={(e) => setFileReferences(e.target.value)}
              placeholder="src/main.ts&#10;src/utils/helper.ts"
              rows={4}
              className="file-refs-input"
            />
          </div>
        </div>

        <div className="editor-footer">
          <button className="cancel-btn" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button className="save-btn" onClick={handleSave} disabled={saving || !content.trim()}>
            {saving ? "Saving..." : "Save"}
          </button>
        </div>

        <style>{`
          .working-state-editor-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000;
          }

          .working-state-editor {
            background: var(--color-bg-primary);
            border-radius: 12px;
            width: 600px;
            max-height: 80vh;
            display: flex;
            flex-direction: column;
          }

          .editor-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 16px 20px;
            border-bottom: 1px solid var(--color-border);
          }

          .editor-title {
            display: flex;
            align-items: center;
            gap: 10px;
          }

          .title-icon {
            font-size: 20px;
          }

          .title-text {
            font-size: 16px;
            font-weight: 600;
            color: var(--color-text-primary);
          }

          .close-btn {
            background: none;
            border: none;
            color: var(--color-text-secondary);
            cursor: pointer;
            font-size: 18px;
            padding: 4px 8px;
          }

          .close-btn:hover {
            color: var(--color-text-primary);
          }

          .editor-error {
            margin: 12px 20px 0;
            padding: 10px 14px;
            background: #ef444420;
            color: #ef4444;
            border-radius: 6px;
            font-size: 13px;
          }

          .editor-form {
            flex: 1;
            overflow-y: auto;
            padding: 20px;
          }

          .form-group {
            margin-bottom: 16px;
          }

          .form-group:last-child {
            margin-bottom: 0;
          }

          .form-group label {
            display: block;
            font-size: 13px;
            font-weight: 500;
            color: var(--color-text-secondary);
            margin-bottom: 8px;
          }

          .label-hint {
            font-weight: 400;
            color: var(--color-text-muted);
          }

          .form-group textarea {
            width: 100%;
            padding: 12px;
            border: 1px solid var(--color-border);
            border-radius: 8px;
            background: var(--color-bg-secondary);
            color: var(--color-text-primary);
            font-size: 13px;
            font-family: inherit;
            line-height: 1.6;
            resize: vertical;
          }

          .form-group textarea:focus {
            outline: none;
            border-color: var(--color-accent);
          }

          .form-group textarea::placeholder {
            color: var(--color-text-muted);
          }

          .file-refs-input {
            font-family: var(--font-mono);
            font-size: 12px !important;
          }

          .editor-footer {
            display: flex;
            justify-content: flex-end;
            gap: 10px;
            padding: 16px 20px;
            border-top: 1px solid var(--color-border);
          }

          .cancel-btn,
          .save-btn {
            padding: 10px 20px;
            border: none;
            border-radius: 6px;
            font-size: 13px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.15s ease;
          }

          .cancel-btn {
            background: var(--color-bg-secondary);
            color: var(--color-text-secondary);
          }

          .cancel-btn:hover:not(:disabled) {
            background: var(--color-bg-tertiary);
          }

          .save-btn {
            background: var(--color-accent);
            color: white;
          }

          .save-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }

          .save-btn:hover:not(:disabled) {
            opacity: 0.9;
          }
        `}</style>
      </div>
    </div>
  );
}
