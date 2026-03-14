import { useState, useEffect } from "react";
import {
  GuardrailSettings as GuardrailSettingsType,
  DEFAULT_BLOCKED_COMMAND_PATTERNS,
  DEFAULT_TRUSTED_COMMAND_PATTERNS,
} from "../../shared/types";

export function GuardrailSettings() {
  const [settings, setSettings] = useState<GuardrailSettingsType | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newPattern, setNewPattern] = useState("");
  const [newTrustedPattern, setNewTrustedPattern] = useState("");
  const [newDomain, setNewDomain] = useState("");
  const [newWebSearchAllowedDomain, setNewWebSearchAllowedDomain] = useState("");
  const [newWebSearchBlockedDomain, setNewWebSearchBlockedDomain] = useState("");

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      setLoading(true);
      const loaded = await window.electronAPI.getGuardrailSettings();
      setSettings(loaded);
    } catch (error) {
      console.error("Failed to load guardrail settings:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!settings) return;
    try {
      setSaving(true);
      await window.electronAPI.saveGuardrailSettings(settings);
    } catch (error) {
      console.error("Failed to save guardrail settings:", error);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    try {
      const defaults = await window.electronAPI.getGuardrailDefaults();
      setSettings(defaults);
    } catch (error) {
      console.error("Failed to reset guardrail settings:", error);
    }
  };

  const addCustomPattern = () => {
    if (!settings || !newPattern.trim()) return;
    if (settings.customBlockedPatterns.includes(newPattern.trim())) return;
    setSettings({
      ...settings,
      customBlockedPatterns: [...settings.customBlockedPatterns, newPattern.trim()],
    });
    setNewPattern("");
  };

  const removeCustomPattern = (pattern: string) => {
    if (!settings) return;
    setSettings({
      ...settings,
      customBlockedPatterns: settings.customBlockedPatterns.filter((p) => p !== pattern),
    });
  };

  const addTrustedPattern = () => {
    if (!settings || !newTrustedPattern.trim()) return;
    if (settings.trustedCommandPatterns.includes(newTrustedPattern.trim())) return;
    setSettings({
      ...settings,
      trustedCommandPatterns: [...settings.trustedCommandPatterns, newTrustedPattern.trim()],
    });
    setNewTrustedPattern("");
  };

  const removeTrustedPattern = (pattern: string) => {
    if (!settings) return;
    setSettings({
      ...settings,
      trustedCommandPatterns: settings.trustedCommandPatterns.filter((p) => p !== pattern),
    });
  };

  const addDomain = () => {
    if (!settings || !newDomain.trim()) return;
    if (settings.allowedDomains.includes(newDomain.trim())) return;
    setSettings({
      ...settings,
      allowedDomains: [...settings.allowedDomains, newDomain.trim()],
    });
    setNewDomain("");
  };

  const removeDomain = (domain: string) => {
    if (!settings) return;
    setSettings({
      ...settings,
      allowedDomains: settings.allowedDomains.filter((d) => d !== domain),
    });
  };

  const addWebSearchAllowedDomain = () => {
    if (!settings || !newWebSearchAllowedDomain.trim()) return;
    if (settings.webSearchAllowedDomains.includes(newWebSearchAllowedDomain.trim())) return;
    setSettings({
      ...settings,
      webSearchAllowedDomains: [...settings.webSearchAllowedDomains, newWebSearchAllowedDomain.trim()],
    });
    setNewWebSearchAllowedDomain("");
  };

  const removeWebSearchAllowedDomain = (domain: string) => {
    if (!settings) return;
    setSettings({
      ...settings,
      webSearchAllowedDomains: settings.webSearchAllowedDomains.filter((d) => d !== domain),
    });
  };

  const addWebSearchBlockedDomain = () => {
    if (!settings || !newWebSearchBlockedDomain.trim()) return;
    if (settings.webSearchBlockedDomains.includes(newWebSearchBlockedDomain.trim())) return;
    setSettings({
      ...settings,
      webSearchBlockedDomains: [...settings.webSearchBlockedDomains, newWebSearchBlockedDomain.trim()],
    });
    setNewWebSearchBlockedDomain("");
  };

  const removeWebSearchBlockedDomain = (domain: string) => {
    if (!settings) return;
    setSettings({
      ...settings,
      webSearchBlockedDomains: settings.webSearchBlockedDomains.filter((d) => d !== domain),
    });
  };

  if (loading || !settings) {
    return <div className="settings-loading">Loading guardrail settings...</div>;
  }

  return (
    <>
      {/* Token Budget Section */}
      <div className="settings-section">
        <div className="settings-section-header">
          <h3>Token Budget</h3>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={settings.tokenBudgetEnabled}
              onChange={(e) => setSettings({ ...settings, tokenBudgetEnabled: e.target.checked })}
            />
            <span className="toggle-slider"></span>
          </label>
        </div>
        <p className="settings-description">
          Limit the total tokens (input + output) used per task to prevent runaway costs.
        </p>
        <div className="settings-inline-input">
          <label>Max tokens per task:</label>
          <input
            type="number"
            className="settings-input settings-input-number"
            value={settings.maxTokensPerTask}
            onChange={(e) =>
              setSettings({ ...settings, maxTokensPerTask: parseInt(e.target.value) || 100000 })
            }
            min={1000}
            max={10000000}
            step={1000}
            disabled={!settings.tokenBudgetEnabled}
          />
        </div>
        <p className="settings-hint">
          Typical tasks use 5,000-50,000 tokens. Default: 100,000 (about $0.30-$7.50 depending on
          model)
        </p>
      </div>

      {/* Cost Budget Section */}
      <div className="settings-section">
        <div className="settings-section-header">
          <h3>Cost Budget</h3>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={settings.costBudgetEnabled}
              onChange={(e) => setSettings({ ...settings, costBudgetEnabled: e.target.checked })}
            />
            <span className="toggle-slider"></span>
          </label>
        </div>
        <p className="settings-description">
          Limit the estimated cost (USD) per task based on model pricing.
        </p>
        <div className="settings-inline-input">
          <label>Max cost per task: $</label>
          <input
            type="number"
            className="settings-input settings-input-number"
            value={settings.maxCostPerTask}
            onChange={(e) =>
              setSettings({ ...settings, maxCostPerTask: parseFloat(e.target.value) || 1.0 })
            }
            min={0.01}
            max={100}
            step={0.1}
            disabled={!settings.costBudgetEnabled}
          />
        </div>
        <p className="settings-hint">
          Cost is estimated based on model pricing tables. Default: $1.00
        </p>
      </div>

      {/* Iteration Limit Section */}
      <div className="settings-section">
        <div className="settings-section-header">
          <h3>Iteration Limit</h3>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={settings.iterationLimitEnabled}
              onChange={(e) =>
                setSettings({ ...settings, iterationLimitEnabled: e.target.checked })
              }
            />
            <span className="toggle-slider"></span>
          </label>
        </div>
        <p className="settings-description">
          Limit the number of LLM calls per task to prevent infinite loops.
        </p>
        <div className="settings-inline-input">
          <label>Max iterations per task:</label>
          <input
            type="number"
            className="settings-input settings-input-number"
            value={settings.maxIterationsPerTask}
            onChange={(e) =>
              setSettings({ ...settings, maxIterationsPerTask: parseInt(e.target.value) || 50 })
            }
            min={5}
            max={500}
            step={5}
            disabled={!settings.iterationLimitEnabled}
          />
        </div>
        <p className="settings-hint">
          Each tool call and follow-up message counts as an iteration. Default: 50
        </p>
      </div>

      {/* Execution Continuation Section */}
      <div className="settings-section">
        <div className="settings-section-header">
          <h3>Execution Continuation</h3>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={settings.autoContinuationEnabled}
              onChange={(e) =>
                setSettings({ ...settings, autoContinuationEnabled: e.target.checked })
              }
            />
            <span className="toggle-slider"></span>
          </label>
        </div>
        <p className="settings-description">
          Automatically continue a task after turn-window exhaustion when recent progress is strong
          and loop risk is low.
        </p>
        <div className="settings-inline-input">
          <label>Max auto continuations:</label>
          <input
            type="number"
            className="settings-input settings-input-number"
            value={settings.defaultMaxAutoContinuations}
            onChange={(e) =>
              setSettings({
                ...settings,
                defaultMaxAutoContinuations: parseInt(e.target.value) || 0,
              })
            }
            min={0}
            max={20}
            step={1}
            disabled={!settings.autoContinuationEnabled}
          />
        </div>
        <div className="settings-inline-input">
          <label>Min progress score:</label>
          <input
            type="number"
            className="settings-input settings-input-number"
            value={settings.defaultMinProgressScore}
            onChange={(e) =>
              setSettings({
                ...settings,
                defaultMinProgressScore: parseFloat(e.target.value) || 0,
              })
            }
            min={-1}
            max={1}
            step={0.05}
            disabled={!settings.autoContinuationEnabled}
          />
        </div>
        <div className="settings-section-header">
          <h4>Continuation Compaction</h4>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={settings.compactOnContinuation}
              onChange={(e) =>
                setSettings({ ...settings, compactOnContinuation: e.target.checked })
              }
              disabled={!settings.autoContinuationEnabled}
            />
            <span className="toggle-slider"></span>
          </label>
        </div>
        <div className="settings-inline-input">
          <label>Compaction threshold ratio:</label>
          <input
            type="number"
            className="settings-input settings-input-number"
            value={settings.compactionThresholdRatio}
            onChange={(e) =>
              setSettings({
                ...settings,
                compactionThresholdRatio: parseFloat(e.target.value) || 0.75,
              })
            }
            min={0.5}
            max={0.95}
            step={0.01}
            disabled={!settings.autoContinuationEnabled || !settings.compactOnContinuation}
          />
        </div>
        <div className="settings-inline-input">
          <label>Loop warning threshold:</label>
          <input
            type="number"
            className="settings-input settings-input-number"
            value={settings.loopWarningThreshold}
            onChange={(e) =>
              setSettings({
                ...settings,
                loopWarningThreshold: parseInt(e.target.value, 10) || 8,
              })
            }
            min={1}
            max={200}
            step={1}
            disabled={!settings.autoContinuationEnabled}
          />
        </div>
        <div className="settings-inline-input">
          <label>Loop critical threshold:</label>
          <input
            type="number"
            className="settings-input settings-input-number"
            value={settings.loopCriticalThreshold}
            onChange={(e) =>
              setSettings({
                ...settings,
                loopCriticalThreshold: parseInt(e.target.value, 10) || 14,
              })
            }
            min={1}
            max={400}
            step={1}
            disabled={!settings.autoContinuationEnabled}
          />
        </div>
        <div className="settings-inline-input">
          <label>No-progress breaker:</label>
          <input
            type="number"
            className="settings-input settings-input-number"
            value={settings.globalNoProgressCircuitBreaker}
            onChange={(e) =>
              setSettings({
                ...settings,
                globalNoProgressCircuitBreaker: parseInt(e.target.value, 10) || 20,
              })
            }
            min={1}
            max={1000}
            step={1}
            disabled={!settings.autoContinuationEnabled}
          />
        </div>
        <div className="settings-inline-input">
          <label>Side-channel during execution:</label>
          <select
            className="settings-input"
            value={settings.sideChannelDuringExecution}
            onChange={(e) =>
              setSettings({
                ...settings,
                sideChannelDuringExecution: e.target.value as "paused" | "limited" | "enabled",
              })
            }
          >
            <option value="paused">Paused</option>
            <option value="limited">Limited</option>
            <option value="enabled">Enabled</option>
          </select>
        </div>
        <div className="settings-inline-input">
          <label>Side-channel max calls/window:</label>
          <input
            type="number"
            className="settings-input settings-input-number"
            value={settings.sideChannelMaxCallsPerWindow}
            onChange={(e) =>
              setSettings({
                ...settings,
                sideChannelMaxCallsPerWindow: parseInt(e.target.value, 10) || 2,
              })
            }
            min={0}
            max={100}
            step={1}
            disabled={settings.sideChannelDuringExecution !== "limited"}
          />
        </div>
        <div className="settings-section-header">
          <h4>Lifetime Turn Cap</h4>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={settings.lifetimeTurnCapEnabled}
              onChange={(e) =>
                setSettings({ ...settings, lifetimeTurnCapEnabled: e.target.checked })
              }
            />
            <span className="toggle-slider"></span>
          </label>
        </div>
        <div className="settings-inline-input">
          <label>Default lifetime turn cap:</label>
          <input
            type="number"
            className="settings-input settings-input-number"
            value={settings.defaultLifetimeTurnCap}
            onChange={(e) =>
              setSettings({
                ...settings,
                defaultLifetimeTurnCap: parseInt(e.target.value) || 320,
              })
            }
            min={20}
            max={5000}
            step={10}
            disabled={!settings.lifetimeTurnCapEnabled}
          />
        </div>
        <p className="settings-hint">
          Defaults: auto continuation on, max 3 windows, min score 0.25, lifetime cap 320 turns.
        </p>
      </div>

      {/* Dangerous Commands Section */}
      <div className="settings-section">
        <div className="settings-section-header">
          <h3>Dangerous Command Blocking</h3>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={settings.blockDangerousCommands}
              onChange={(e) =>
                setSettings({ ...settings, blockDangerousCommands: e.target.checked })
              }
            />
            <span className="toggle-slider"></span>
          </label>
        </div>
        <p className="settings-description">
          Block shell commands that match dangerous patterns (e.g., rm -rf /, sudo, fork bombs).
        </p>

        <div className="settings-subsection">
          <h4>Built-in Blocked Patterns</h4>
          <div className="pattern-list">
            {DEFAULT_BLOCKED_COMMAND_PATTERNS.map((pattern, index) => (
              <span key={index} className="pattern-tag builtin" title={pattern}>
                {pattern.length > 30 ? pattern.slice(0, 27) + "..." : pattern}
              </span>
            ))}
          </div>
        </div>

        <div className="settings-subsection">
          <h4>Custom Blocked Patterns</h4>
          <p className="settings-description">
            Add your own regex patterns to block specific commands.
          </p>
          <div className="settings-input-group">
            <input
              type="text"
              className="settings-input"
              placeholder="e.g., npm publish|yarn publish"
              value={newPattern}
              onChange={(e) => setNewPattern(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addCustomPattern()}
              disabled={!settings.blockDangerousCommands}
            />
            <button
              className="button-small button-secondary"
              onClick={addCustomPattern}
              disabled={!settings.blockDangerousCommands || !newPattern.trim()}
            >
              Add
            </button>
          </div>
          {settings.customBlockedPatterns.length > 0 ? (
            <div className="pattern-list">
              {settings.customBlockedPatterns.map((pattern, index) => (
                <span key={index} className="pattern-tag custom">
                  {pattern}
                  <button
                    className="pattern-remove"
                    onClick={() => removeCustomPattern(pattern)}
                    title="Remove pattern"
                  >
                    x
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="settings-hint">No custom patterns added.</p>
          )}
        </div>
      </div>

      {/* Auto-Approve Trusted Commands Section */}
      <div className="settings-section">
        <div className="settings-section-header">
          <h3>Auto-Approve Trusted Commands</h3>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={settings.autoApproveTrustedCommands}
              onChange={(e) =>
                setSettings({ ...settings, autoApproveTrustedCommands: e.target.checked })
              }
            />
            <span className="toggle-slider"></span>
          </label>
        </div>
        <p className="settings-description">
          Automatically approve shell commands that match trusted patterns without asking for
          confirmation. This enables more autonomous operation while keeping dangerous commands
          blocked.
        </p>

        {settings.autoApproveTrustedCommands && (
          <>
            <div className="settings-subsection">
              <h4>Built-in Trusted Patterns</h4>
              <p className="settings-description">
                Common safe commands that are auto-approved by default.
              </p>
              <div className="pattern-list">
                {DEFAULT_TRUSTED_COMMAND_PATTERNS.slice(0, 15).map((pattern, index) => (
                  <span key={index} className="pattern-tag builtin trusted" title={pattern}>
                    {pattern}
                  </span>
                ))}
                {DEFAULT_TRUSTED_COMMAND_PATTERNS.length > 15 && (
                  <span className="pattern-tag builtin trusted">
                    +{DEFAULT_TRUSTED_COMMAND_PATTERNS.length - 15} more
                  </span>
                )}
              </div>
            </div>

            <div className="settings-subsection">
              <h4>Custom Trusted Patterns</h4>
              <p className="settings-description">
                Add your own glob patterns for commands to auto-approve. Use * as wildcard.
              </p>
              <div className="settings-input-group">
                <input
                  type="text"
                  className="settings-input"
                  placeholder="e.g., cargo build* or make *"
                  value={newTrustedPattern}
                  onChange={(e) => setNewTrustedPattern(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addTrustedPattern()}
                />
                <button
                  className="button-small button-secondary"
                  onClick={addTrustedPattern}
                  disabled={!newTrustedPattern.trim()}
                >
                  Add
                </button>
              </div>
              {settings.trustedCommandPatterns.length > 0 ? (
                <div className="pattern-list">
                  {settings.trustedCommandPatterns.map((pattern, index) => (
                    <span key={index} className="pattern-tag custom trusted">
                      {pattern}
                      <button
                        className="pattern-remove"
                        onClick={() => removeTrustedPattern(pattern)}
                        title="Remove pattern"
                      >
                        x
                      </button>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="settings-hint">No custom trusted patterns added.</p>
              )}
            </div>
          </>
        )}

        <p className="settings-hint warning">
          Blocked patterns always take priority over trusted patterns for safety.
        </p>
      </div>

      {/* File Size Limit Section */}
      <div className="settings-section">
        <div className="settings-section-header">
          <h3>File Size Limit</h3>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={settings.fileSizeLimitEnabled}
              onChange={(e) => setSettings({ ...settings, fileSizeLimitEnabled: e.target.checked })}
            />
            <span className="toggle-slider"></span>
          </label>
        </div>
        <p className="settings-description">
          Limit the size of files the agent can write to prevent disk space abuse.
        </p>
        <div className="settings-inline-input">
          <label>Max file size (MB):</label>
          <input
            type="number"
            className="settings-input settings-input-number"
            value={settings.maxFileSizeMB}
            onChange={(e) =>
              setSettings({ ...settings, maxFileSizeMB: parseInt(e.target.value) || 50 })
            }
            min={1}
            max={500}
            step={10}
            disabled={!settings.fileSizeLimitEnabled}
          />
        </div>
        <p className="settings-hint">
          Default: 50MB. Increase for projects that generate large assets.
        </p>
      </div>

      {/* Web Search Policy Section */}
      <div className="settings-section">
        <div className="settings-section-header">
          <h3>Web Search Policy</h3>
        </div>
        <p className="settings-description">
          Control web_search mode, usage caps, and domain filtering for search results.
        </p>
        <div className="settings-inline-input">
          <label>Mode:</label>
          <select
            className="settings-input"
            value={settings.webSearchMode}
            onChange={(e) =>
              setSettings({
                ...settings,
                webSearchMode: e.target.value as "disabled" | "cached" | "live",
              })
            }
          >
            <option value="disabled">Disabled</option>
            <option value="cached">Cached</option>
            <option value="live">Live</option>
          </select>
        </div>
        <div className="settings-inline-input">
          <label>Max uses per task:</label>
          <input
            type="number"
            className="settings-input settings-input-number"
            value={settings.webSearchMaxUsesPerTask}
            onChange={(e) =>
              setSettings({
                ...settings,
                webSearchMaxUsesPerTask: parseInt(e.target.value, 10) || 1,
              })
            }
            min={1}
            max={500}
            step={1}
          />
        </div>
        <div className="settings-inline-input">
          <label>Max uses per step:</label>
          <input
            type="number"
            className="settings-input settings-input-number"
            value={settings.webSearchMaxUsesPerStep}
            onChange={(e) =>
              setSettings({
                ...settings,
                webSearchMaxUsesPerStep: parseInt(e.target.value, 10) || 1,
              })
            }
            min={1}
            max={100}
            step={1}
          />
        </div>
        <div className="settings-subsection">
          <h4>Allowed Domains (optional)</h4>
          <p className="settings-description">
            If set, only search results from these domains are returned after blocked-domain filtering.
          </p>
          <div className="settings-input-group">
            <input
              type="text"
              className="settings-input"
              placeholder="e.g., reuters.com or *.openai.com"
              value={newWebSearchAllowedDomain}
              onChange={(e) => setNewWebSearchAllowedDomain(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addWebSearchAllowedDomain()}
            />
            <button
              className="button-small button-secondary"
              onClick={addWebSearchAllowedDomain}
              disabled={!newWebSearchAllowedDomain.trim()}
            >
              Add
            </button>
          </div>
          {settings.webSearchAllowedDomains.length > 0 ? (
            <div className="pattern-list">
              {settings.webSearchAllowedDomains.map((domain, index) => (
                <span key={index} className="pattern-tag domain">
                  {domain}
                  <button
                    className="pattern-remove"
                    onClick={() => removeWebSearchAllowedDomain(domain)}
                    title="Remove domain"
                  >
                    x
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="settings-hint">No allowlist configured. All domains are eligible unless blocked.</p>
          )}
        </div>
        <div className="settings-subsection">
          <h4>Blocked Domains</h4>
          <p className="settings-description">
            Results from blocked domains are always removed first.
          </p>
          <div className="settings-input-group">
            <input
              type="text"
              className="settings-input"
              placeholder="e.g., example.com or *.spam.com"
              value={newWebSearchBlockedDomain}
              onChange={(e) => setNewWebSearchBlockedDomain(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addWebSearchBlockedDomain()}
            />
            <button
              className="button-small button-secondary"
              onClick={addWebSearchBlockedDomain}
              disabled={!newWebSearchBlockedDomain.trim()}
            >
              Add
            </button>
          </div>
          {settings.webSearchBlockedDomains.length > 0 ? (
            <div className="pattern-list">
              {settings.webSearchBlockedDomains.map((domain, index) => (
                <span key={index} className="pattern-tag custom">
                  {domain}
                  <button
                    className="pattern-remove"
                    onClick={() => removeWebSearchBlockedDomain(domain)}
                    title="Remove domain"
                  >
                    x
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="settings-hint">No blocked domains configured.</p>
          )}
        </div>
        <p className="settings-hint">
          Domain precedence: blocked domains are applied first, then allowed-domain allowlist.
        </p>
      </div>

      {/* Network Domain Allowlist Section */}
      <div className="settings-section">
        <div className="settings-section-header">
          <h3>Network Domain Allowlist</h3>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={settings.enforceAllowedDomains}
              onChange={(e) =>
                setSettings({ ...settings, enforceAllowedDomains: e.target.checked })
              }
            />
            <span className="toggle-slider"></span>
          </label>
        </div>
        <p className="settings-description">
          When enabled, browser automation will only navigate to allowed domains.
        </p>

        {settings.enforceAllowedDomains && (
          <div className="settings-subsection">
            <div className="settings-input-group">
              <input
                type="text"
                className="settings-input"
                placeholder="e.g., github.com or *.google.com"
                value={newDomain}
                onChange={(e) => setNewDomain(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addDomain()}
              />
              <button
                className="button-small button-secondary"
                onClick={addDomain}
                disabled={!newDomain.trim()}
              >
                Add
              </button>
            </div>
            {settings.allowedDomains.length > 0 ? (
              <div className="pattern-list">
                {settings.allowedDomains.map((domain, index) => (
                  <span key={index} className="pattern-tag domain">
                    {domain}
                    <button
                      className="pattern-remove"
                      onClick={() => removeDomain(domain)}
                      title="Remove domain"
                    >
                      x
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="settings-hint warning">
                No domains configured. All browser navigation will be blocked!
              </p>
            )}
            <p className="settings-hint">
              Use *.example.com to allow all subdomains. Without any domains, all navigation is
              blocked.
            </p>
          </div>
        )}
      </div>

      {/* Behavior Adaptation */}
      <div className="settings-section">
        <div className="settings-section-header">
          <h3>Behavior Adaptation</h3>
        </div>
        <p className="settings-description">
          Control whether the assistant adapts style over time and adjusts delivery per channel.
        </p>

        <div className="settings-form-group">
          <div className="settings-section-header">
            <label>Adaptive Style</label>
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={settings.adaptiveStyleEnabled}
                onChange={(e) => setSettings({ ...settings, adaptiveStyleEnabled: e.target.checked })}
              />
              <span className="toggle-slider" />
            </label>
          </div>
          <p className="settings-hint">
            Lets the assistant gradually learn communication preferences from messages and feedback.
          </p>

          <div className="settings-inline-input">
            <label>Max style drift per week:</label>
            <input
              type="number"
              className="settings-input settings-input-number"
              value={settings.adaptiveStyleMaxDriftPerWeek}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  adaptiveStyleMaxDriftPerWeek: Math.max(0, parseInt(e.target.value) || 1),
                })
              }
              min={0}
              max={10}
              step={1}
              disabled={!settings.adaptiveStyleEnabled}
            />
          </div>

          <div style={{ marginTop: "8px" }}>
            <button
              className="button-small button-secondary"
              onClick={async () => {
                try {
                  await window.electronAPI.resetAdaptiveStyle();
                } catch (error) {
                  console.error("Failed to reset adaptive style:", error);
                }
              }}
              disabled={!settings.adaptiveStyleEnabled}
            >
              Reset learned style
            </button>
          </div>
        </div>

        <div className="settings-form-group">
          <div className="settings-section-header">
            <label>Channel Persona</label>
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={settings.channelPersonaEnabled}
                onChange={(e) =>
                  setSettings({ ...settings, channelPersonaEnabled: e.target.checked })
                }
              />
              <span className="toggle-slider" />
            </label>
          </div>
          <p className="settings-hint">
            Keeps the same core persona while adapting response delivery to Slack, Telegram,
            WhatsApp, desktop, and other channels.
          </p>
        </div>
      </div>

      {/* Actions */}
      <div className="settings-actions">
        <button className="button-secondary" onClick={handleReset} disabled={saving}>
          Reset to Defaults
        </button>
        <button className="button-primary" onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save Settings"}
        </button>
      </div>
    </>
  );
}
