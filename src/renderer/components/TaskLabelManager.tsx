import { useState, useEffect } from "react";
import { TaskLabelData, CreateTaskLabelRequest } from "../../electron/preload";

interface TaskLabelManagerProps {
  workspaceId: string;
  onClose: () => void;
}

const DEFAULT_COLORS = [
  "#ef4444", // Red
  "#f97316", // Orange
  "#f59e0b", // Amber
  "#eab308", // Yellow
  "#84cc16", // Lime
  "#22c55e", // Green
  "#14b8a6", // Teal
  "#06b6d4", // Cyan
  "#3b82f6", // Blue
  "#6366f1", // Indigo
  "#8b5cf6", // Violet
  "#a855f7", // Purple
  "#d946ef", // Fuchsia
  "#ec4899", // Pink
  "#f43f5e", // Rose
  "#64748b", // Slate
];

export function TaskLabelManager({ workspaceId, onClose }: TaskLabelManagerProps) {
  const [labels, setLabels] = useState<TaskLabelData[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingLabel, setEditingLabel] = useState<TaskLabelData | null>(null);
  const [newLabelName, setNewLabelName] = useState("");
  const [newLabelColor, setNewLabelColor] = useState(DEFAULT_COLORS[0]);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadLabels();
  }, [workspaceId]);

  const loadLabels = async () => {
    try {
      setLoading(true);
      const result = await window.electronAPI.listTaskLabels({ workspaceId });
      setLabels(result);
    } catch (err) {
      console.error("Failed to load labels:", err);
      setError("Failed to load labels");
    } finally {
      setLoading(false);
    }
  };

  const handleCreateLabel = async () => {
    if (!newLabelName.trim()) return;

    try {
      setError(null);
      const request: CreateTaskLabelRequest = {
        workspaceId,
        name: newLabelName.trim(),
        color: newLabelColor,
      };
      const created = await window.electronAPI.createTaskLabel(request);
      setLabels((prev) => [...prev, created]);
      setNewLabelName("");
      setNewLabelColor(DEFAULT_COLORS[Math.floor(Math.random() * DEFAULT_COLORS.length)]);
    } catch (err: Any) {
      console.error("Failed to create label:", err);
      setError(err.message || "Failed to create label");
    }
  };

  const handleUpdateLabel = async () => {
    if (!editingLabel || !editingLabel.name.trim()) return;

    try {
      setError(null);
      const updated = await window.electronAPI.updateTaskLabel(editingLabel.id, {
        name: editingLabel.name.trim(),
        color: editingLabel.color,
      });
      setLabels((prev) => prev.map((l) => (l.id === updated.id ? updated : l)));
      setEditingLabel(null);
    } catch (err: Any) {
      console.error("Failed to update label:", err);
      setError(err.message || "Failed to update label");
    }
  };

  const handleDeleteLabel = async (id: string) => {
    if (!confirm("Delete this label? It will be removed from all tasks.")) return;

    try {
      setError(null);
      await window.electronAPI.deleteTaskLabel(id);
      setLabels((prev) => prev.filter((l) => l.id !== id));
    } catch (err: Any) {
      console.error("Failed to delete label:", err);
      setError(err.message || "Failed to delete label");
    }
  };

  if (loading) {
    return (
      <div className="label-manager-overlay">
        <div className="label-manager">
          <div className="label-manager-loading">Loading labels...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="label-manager-overlay" onClick={onClose}>
      <div className="label-manager" onClick={(e) => e.stopPropagation()}>
        <div className="label-manager-header">
          <h3>Manage Labels</h3>
          <button className="close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        {error && <div className="label-error">{error}</div>}

        <div className="label-create-form">
          <div className="label-input-row">
            <button
              className="color-picker-btn"
              style={{ backgroundColor: newLabelColor }}
              onClick={() => setShowColorPicker(!showColorPicker)}
            />
            <input
              type="text"
              value={newLabelName}
              onChange={(e) => setNewLabelName(e.target.value)}
              placeholder="New label name..."
              onKeyDown={(e) => e.key === "Enter" && handleCreateLabel()}
            />
            <button
              className="create-btn"
              onClick={handleCreateLabel}
              disabled={!newLabelName.trim()}
            >
              Add
            </button>
          </div>
          {showColorPicker && (
            <div className="color-palette">
              {DEFAULT_COLORS.map((color) => (
                <button
                  key={color}
                  className={`color-option ${color === newLabelColor ? "selected" : ""}`}
                  style={{ backgroundColor: color }}
                  onClick={() => {
                    setNewLabelColor(color);
                    setShowColorPicker(false);
                  }}
                />
              ))}
            </div>
          )}
        </div>

        <div className="label-list">
          {labels.length === 0 ? (
            <div className="label-empty">No labels yet. Create one above!</div>
          ) : (
            labels.map((label) => (
              <div key={label.id} className="label-item">
                {editingLabel?.id === label.id ? (
                  <div className="label-edit-row">
                    <button
                      className="color-picker-btn"
                      style={{ backgroundColor: editingLabel.color }}
                      onClick={() => {
                        const currentIndex = DEFAULT_COLORS.indexOf(editingLabel.color);
                        const nextIndex = (currentIndex + 1) % DEFAULT_COLORS.length;
                        setEditingLabel({ ...editingLabel, color: DEFAULT_COLORS[nextIndex] });
                      }}
                    />
                    <input
                      type="text"
                      value={editingLabel.name}
                      onChange={(e) => setEditingLabel({ ...editingLabel, name: e.target.value })}
                      onKeyDown={(e) => e.key === "Enter" && handleUpdateLabel()}
                      autoFocus
                    />
                    <button className="save-btn" onClick={handleUpdateLabel}>
                      Save
                    </button>
                    <button className="cancel-btn" onClick={() => setEditingLabel(null)}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <>
                    <span className="label-preview" style={{ backgroundColor: label.color }}>
                      {label.name}
                    </span>
                    <div className="label-actions">
                      <button className="edit-btn" onClick={() => setEditingLabel(label)}>
                        Edit
                      </button>
                      <button className="delete-btn" onClick={() => handleDeleteLabel(label.id)}>
                        Delete
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))
          )}
        </div>

        <style>{`
          .label-manager-overlay {
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

          .label-manager {
            background: var(--color-bg-primary);
            border-radius: 12px;
            padding: 20px;
            width: 400px;
            max-height: 80vh;
            display: flex;
            flex-direction: column;
          }

          .label-manager-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 16px;
          }

          .label-manager-header h3 {
            margin: 0;
            font-size: 16px;
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

          .label-error {
            background: #ef444420;
            color: #ef4444;
            padding: 8px 12px;
            border-radius: 6px;
            margin-bottom: 12px;
            font-size: 13px;
          }

          .label-create-form {
            margin-bottom: 16px;
          }

          .label-input-row {
            display: flex;
            gap: 8px;
            align-items: center;
          }

          .color-picker-btn {
            width: 32px;
            height: 32px;
            border: 2px solid var(--color-border);
            border-radius: 6px;
            cursor: pointer;
            flex-shrink: 0;
          }

          .color-picker-btn:hover {
            border-color: var(--color-accent);
          }

          .label-create-form input {
            flex: 1;
            padding: 8px 12px;
            border: 1px solid var(--color-border);
            border-radius: 6px;
            background: var(--color-bg-secondary);
            color: var(--color-text-primary);
            font-size: 13px;
          }

          .label-create-form input:focus {
            outline: none;
            border-color: var(--color-accent);
          }

          .create-btn {
            padding: 8px 16px;
            background: var(--color-accent);
            color: white;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
          }

          .create-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }

          .create-btn:not(:disabled):hover {
            opacity: 0.9;
          }

          .color-palette {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-top: 8px;
            padding: 8px;
            background: var(--color-bg-secondary);
            border-radius: 6px;
          }

          .color-option {
            width: 24px;
            height: 24px;
            border: 2px solid transparent;
            border-radius: 4px;
            cursor: pointer;
          }

          .color-option:hover,
          .color-option.selected {
            border-color: white;
            box-shadow: 0 0 0 1px var(--color-border);
          }

          .label-list {
            flex: 1;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 8px;
          }

          .label-empty {
            text-align: center;
            color: var(--color-text-secondary);
            padding: 20px;
          }

          .label-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px;
            background: var(--color-bg-secondary);
            border-radius: 6px;
          }

          .label-preview {
            font-size: 12px;
            font-weight: 500;
            color: white;
            padding: 4px 10px;
            border-radius: 4px;
          }

          .label-actions {
            display: flex;
            gap: 4px;
          }

          .edit-btn,
          .delete-btn,
          .save-btn,
          .cancel-btn {
            padding: 4px 10px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
          }

          .edit-btn {
            background: var(--color-bg-tertiary);
            color: var(--color-text-secondary);
          }

          .edit-btn:hover {
            background: var(--color-accent);
            color: white;
          }

          .delete-btn {
            background: var(--color-bg-tertiary);
            color: var(--color-text-secondary);
          }

          .delete-btn:hover {
            background: #ef4444;
            color: white;
          }

          .save-btn {
            background: var(--color-accent);
            color: white;
          }

          .cancel-btn {
            background: var(--color-bg-tertiary);
            color: var(--color-text-secondary);
          }

          .label-edit-row {
            display: flex;
            gap: 8px;
            align-items: center;
            width: 100%;
          }

          .label-edit-row input {
            flex: 1;
            padding: 6px 10px;
            border: 1px solid var(--color-border);
            border-radius: 4px;
            background: var(--color-bg-primary);
            color: var(--color-text-primary);
            font-size: 12px;
          }

          .label-manager-loading {
            text-align: center;
            color: var(--color-text-secondary);
            padding: 40px;
          }
        `}</style>
      </div>
    </div>
  );
}
