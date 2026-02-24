import React, { useState, useEffect } from "react";
import { FileText, Globe, Search, Monitor, Wrench, Terminal, Image, ChevronDown } from "lucide-react";

interface ToolCategoryConfig {
  enabled: boolean;
  priority: "high" | "normal" | "low";
  description?: string;
}

interface BuiltinToolsSettingsData {
  categories: {
    browser: ToolCategoryConfig;
    search: ToolCategoryConfig;
    system: ToolCategoryConfig;
    file: ToolCategoryConfig;
    skill: ToolCategoryConfig;
    shell: ToolCategoryConfig;
    image: ToolCategoryConfig;
  };
  toolOverrides: Record<string, { enabled: boolean; priority?: "high" | "normal" | "low" }>;
  toolTimeouts: Record<string, number>;
  toolAutoApprove: Record<string, boolean>;
  runCommandApprovalMode: "per_command" | "single_bundle";
  version: string;
}

type CategoryKey = keyof BuiltinToolsSettingsData["categories"];

const IC = { size: 18, strokeWidth: 1.5 } as const;
const CATEGORY_INFO: Record<
  CategoryKey,
  { name: string; icon: React.ReactNode; description: string }
> = {
  file: { name: "File Operations", icon: <FileText {...IC} />, description: "Read, write, copy, delete files and directories" },
  browser: { name: "Browser Automation", icon: <Globe {...IC} />, description: "Navigate websites, click, fill forms, take screenshots" },
  search: { name: "Web Search", icon: <Search {...IC} />, description: "Search the web using configured providers (Brave, Tavily, etc.)" },
  system: { name: "System Tools", icon: <Monitor {...IC} />, description: "Clipboard, screenshots, open apps and URLs" },
  skill: { name: "Document Skills", icon: <Wrench {...IC} />, description: "Create spreadsheets, documents, presentations" },
  shell: { name: "Shell Commands", icon: <Terminal {...IC} />, description: "Execute terminal commands (requires approval)" },
  image: { name: "Image Generation", icon: <Image {...IC} />, description: "Generate images using AI (requires Gemini API)" },
};

const PRIORITY_OPTIONS: Array<{
  value: "high" | "normal" | "low";
  label: string;
  description: string;
}> = [
  { value: "high", label: "High", description: "Prefer these tools over others" },
  { value: "normal", label: "Normal", description: "Default priority" },
  { value: "low", label: "Low", description: "Use only when specifically needed" },
];

export function BuiltinToolsSettings() {
  const [settings, setSettings] = useState<BuiltinToolsSettingsData | null>(null);
  const [categories, setCategories] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      setLoading(true);
      const [loadedSettings, loadedCategories] = await Promise.all([
        window.electronAPI.getBuiltinToolsSettings(),
        window.electronAPI.getBuiltinToolsCategories(),
      ]);
      setSettings(loadedSettings);
      setCategories(loadedCategories);
    } catch (error) {
      console.error("Failed to load built-in tools settings:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleCategoryToggle = async (category: CategoryKey, enabled: boolean) => {
    if (!settings) return;

    const newSettings = {
      ...settings,
      categories: {
        ...settings.categories,
        [category]: {
          ...settings.categories[category],
          enabled,
        },
      },
    };

    setSettings(newSettings);

    try {
      setSaving(true);
      await window.electronAPI.saveBuiltinToolsSettings(newSettings);
    } catch (error) {
      console.error("Failed to save settings:", error);
    } finally {
      setSaving(false);
    }
  };

  const handleCategoryPriority = async (
    category: CategoryKey,
    priority: "high" | "normal" | "low",
  ) => {
    if (!settings) return;

    const newSettings = {
      ...settings,
      categories: {
        ...settings.categories,
        [category]: {
          ...settings.categories[category],
          priority,
        },
      },
    };

    setSettings(newSettings);

    try {
      setSaving(true);
      await window.electronAPI.saveBuiltinToolsSettings(newSettings);
    } catch (error) {
      console.error("Failed to save settings:", error);
    } finally {
      setSaving(false);
    }
  };

  const handleRunCommandAutoApprove = async (enabled: boolean) => {
    if (!settings) return;

    const nextAutoApprove = { ...(settings.toolAutoApprove || {}) };
    if (enabled) {
      nextAutoApprove.run_command = true;
    } else {
      delete nextAutoApprove.run_command;
    }

    const newSettings = {
      ...settings,
      toolAutoApprove: nextAutoApprove,
    };

    setSettings(newSettings);

    try {
      setSaving(true);
      await window.electronAPI.saveBuiltinToolsSettings(newSettings);
    } catch (error) {
      console.error("Failed to save settings:", error);
    } finally {
      setSaving(false);
    }
  };

  const handleRunCommandApprovalMode = async (mode: "per_command" | "single_bundle") => {
    if (!settings) return;

    const newSettings = {
      ...settings,
      runCommandApprovalMode: mode,
    };

    setSettings(newSettings);

    try {
      setSaving(true);
      await window.electronAPI.saveBuiltinToolsSettings(newSettings);
    } catch (error) {
      console.error("Failed to save settings:", error);
    } finally {
      setSaving(false);
    }
  };

  const handleRunCommandTimeout = async (value: string) => {
    if (!settings) return;

    const parsed = Number(value);
    const nextTimeouts = { ...(settings.toolTimeouts || {}) };

    if (!value || !Number.isFinite(parsed) || parsed <= 0) {
      delete nextTimeouts.run_command;
    } else {
      nextTimeouts.run_command = Math.round(parsed);
    }

    const newSettings = {
      ...settings,
      toolTimeouts: nextTimeouts,
    };

    setSettings(newSettings);

    try {
      setSaving(true);
      await window.electronAPI.saveBuiltinToolsSettings(newSettings);
    } catch (error) {
      console.error("Failed to save settings:", error);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="settings-loading">Loading settings...</div>;
  }

  if (!settings) {
    return <div className="settings-error">Failed to load settings</div>;
  }

  return (
    <div className="builtin-tools-settings">
      <div className="settings-section">
        <h3>Built-in Tools</h3>
        <p className="settings-description">
          Control which built-in tools are available to the agent. Disabling a category will prevent
          the agent from using those tools. Setting a lower priority makes the agent less likely to
          choose those tools when alternatives exist.
        </p>
      </div>

      <div className="builtin-tools-categories">
        {(Object.keys(CATEGORY_INFO) as CategoryKey[]).map((category) => {
          const info = CATEGORY_INFO[category];
          const config = settings.categories[category];
          const tools = categories[category] || [];
          const runCommandAutoApprove =
            category === "shell" ? Boolean(settings.toolAutoApprove?.run_command) : false;
          const runCommandApprovalMode =
            category === "shell" ? settings.runCommandApprovalMode : "per_command";
          const runCommandTimeout =
            category === "shell" ? (settings.toolTimeouts?.run_command ?? "") : "";

          return (
            <div
              key={category}
              className={`builtin-tool-category ${!config.enabled ? "disabled" : ""}`}
            >
              <div className="builtin-tool-category-header">
                <div className="builtin-tool-category-info">
                  <div className="builtin-tool-category-icon">{info.icon}</div>
                  <div className="builtin-tool-category-text">
                    <div className="builtin-tool-category-name">{info.name}</div>
                    <div className="builtin-tool-category-desc">{info.description}</div>
                  </div>
                </div>

                <div className="builtin-tool-category-controls">
                  <select
                    className="builtin-tool-priority-select"
                    value={config.priority}
                    onChange={(e) =>
                      handleCategoryPriority(category, e.target.value as "high" | "normal" | "low")
                    }
                    disabled={!config.enabled}
                    title="Tool priority"
                  >
                    {PRIORITY_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>

                  <label className="builtin-tool-toggle">
                    <input
                      type="checkbox"
                      checked={config.enabled}
                      onChange={(e) => handleCategoryToggle(category, e.target.checked)}
                    />
                    <span className="builtin-tool-toggle-slider"></span>
                  </label>

                  <button
                    className="builtin-tool-expand-btn"
                    onClick={() =>
                      setExpandedCategory(expandedCategory === category ? null : category)
                    }
                    title="Show tools in this category"
                  >
                    <ChevronDown
                      size={16}
                      strokeWidth={2}
                      style={{
                        transform: expandedCategory === category ? "rotate(180deg)" : "none",
                        transition: "transform 0.2s",
                      }}
                    />
                  </button>
                </div>
              </div>

              {category === "shell" && expandedCategory === category && (
                <div className="builtin-tool-advanced">
                  <div className="builtin-tool-advanced-row">
                    <div className="builtin-tool-advanced-text">
                      <div className="builtin-tool-advanced-label">Approval mode</div>
                      <div className="builtin-tool-advanced-hint">
                        Per command asks each time. Single bundle asks once and reuses approval for
                        safe commands in this task.
                      </div>
                    </div>
                    <select
                      className="builtin-tool-mode-select"
                      value={runCommandApprovalMode}
                      onChange={(e) =>
                        handleRunCommandApprovalMode(
                          e.target.value as "per_command" | "single_bundle",
                        )
                      }
                      disabled={!config.enabled}
                    >
                      <option value="per_command">Per command</option>
                      <option value="single_bundle">Single approval bundle</option>
                    </select>
                  </div>

                  <div className="builtin-tool-advanced-row">
                    <div className="builtin-tool-advanced-text">
                      <div className="builtin-tool-advanced-label">Auto-approve safe commands</div>
                      <div className="builtin-tool-advanced-hint">
                        Skips approval prompts for non-destructive commands.
                      </div>
                    </div>
                    <label className="builtin-tool-toggle">
                      <input
                        type="checkbox"
                        checked={runCommandAutoApprove}
                        onChange={(e) => handleRunCommandAutoApprove(e.target.checked)}
                        disabled={!config.enabled}
                      />
                      <span className="builtin-tool-toggle-slider"></span>
                    </label>
                  </div>

                  <div className="builtin-tool-advanced-row">
                    <div className="builtin-tool-advanced-text">
                      <div className="builtin-tool-advanced-label">run_command timeout (ms)</div>
                      <div className="builtin-tool-advanced-hint">
                        Used when the command doesn't set its own timeout.
                      </div>
                    </div>
                    <input
                      className="builtin-tool-timeout-input"
                      type="number"
                      min={1000}
                      step={1000}
                      value={runCommandTimeout}
                      onChange={(e) => handleRunCommandTimeout(e.target.value)}
                      disabled={!config.enabled}
                      placeholder="30000"
                    />
                  </div>
                </div>
              )}

              {expandedCategory === category && tools.length > 0 && (
                <div className="builtin-tool-list">
                  {tools.map((tool) => (
                    <div key={tool} className="builtin-tool-item">
                      <code>{tool}</code>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="settings-section">
        <h3>About Tool Priority</h3>
        <p className="settings-description">
          Tool priority affects which tools the agent chooses when multiple options could work:
        </p>
        <ul className="settings-list">
          <li>
            <strong>High:</strong> The agent will prefer these tools over alternatives
          </li>
          <li>
            <strong>Normal:</strong> Default behavior - tools are considered equally
          </li>
          <li>
            <strong>Low:</strong> The agent will only use these if specifically needed or no
            alternatives exist
          </li>
        </ul>
        <p className="settings-hint">
          For example, if you have MCP servers that provide similar functionality to built-in tools,
          you can set the built-in tools to "Low" priority so the agent prefers the MCP versions.
        </p>
      </div>

      {saving && <div className="builtin-tools-saving">Saving...</div>}
    </div>
  );
}
