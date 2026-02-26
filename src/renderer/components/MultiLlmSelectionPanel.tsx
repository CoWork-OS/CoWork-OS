import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { MultiLlmConfig, MultiLlmParticipant, CachedModelInfo } from "../../shared/types";
import { MULTI_LLM_PROVIDER_DISPLAY } from "../../shared/types";

interface LLMProviderInfo {
  type: string;
  name: string;
  configured: boolean;
}

interface MultiLlmSelectionPanelProps {
  availableProviders: LLMProviderInfo[];
  onConfigChange: (config: MultiLlmConfig | null) => void;
}

export function MultiLlmSelectionPanel({
  availableProviders,
  onConfigChange,
}: MultiLlmSelectionPanelProps) {
  const configuredProviders = useMemo(
    () => availableProviders.filter((p) => p.configured),
    [availableProviders],
  );
  const [selectedProviders, setSelectedProviders] = useState<Set<string>>(new Set());
  const [providerModels, setProviderModels] = useState<Map<string, CachedModelInfo[]>>(new Map());
  const [selectedModels, setSelectedModels] = useState<Map<string, string>>(new Map());
  const [judgeKey, setJudgeKey] = useState<string>("");

  // Stable ref for onConfigChange to avoid re-triggering the effect
  const onConfigChangeRef = useRef(onConfigChange);
  onConfigChangeRef.current = onConfigChange;

  // Fetch models when a provider is toggled on
  const handleProviderToggle = useCallback(
    async (providerType: string, checked: boolean) => {
      const next = new Set(selectedProviders);
      if (checked) {
        next.add(providerType);
        if (!providerModels.has(providerType)) {
          try {
            const models = await window.electronAPI.getProviderModels(providerType);
            setProviderModels((prev) => {
              const m = new Map(prev);
              m.set(providerType, models);
              return m;
            });
            if (models.length > 0) {
              setSelectedModels((prev) => {
                const m = new Map(prev);
                if (!m.has(providerType)) m.set(providerType, models[0].key);
                return m;
              });
            }
          } catch {
            // Failed to fetch models, use empty list
          }
        }
      } else {
        next.delete(providerType);
        setSelectedModels((prev) => {
          const m = new Map(prev);
          m.delete(providerType);
          return m;
        });
      }
      setSelectedProviders(next);
    },
    [selectedProviders, providerModels],
  );

  const handleModelChange = useCallback((providerType: string, modelKey: string) => {
    setSelectedModels((prev) => {
      const m = new Map(prev);
      m.set(providerType, modelKey);
      return m;
    });
  }, []);

  // Build and emit config whenever selection changes
  useEffect(() => {
    const participants: MultiLlmParticipant[] = [];
    for (const providerType of selectedProviders) {
      const modelKey = selectedModels.get(providerType);
      if (!modelKey) continue;
      const providerInfo = MULTI_LLM_PROVIDER_DISPLAY[providerType];
      const providerName =
        configuredProviders.find((p) => p.type === providerType)?.name || providerType;
      participants.push({
        providerType: providerType as Any,
        modelKey,
        displayName: providerInfo
          ? `${providerInfo.name} (${modelKey})`
          : `${providerName} (${modelKey})`,
        isJudge: false,
      });
    }

    if (participants.length < 2) {
      onConfigChangeRef.current(null);
      return;
    }

    // Resolve judge
    let judgeProvider = "";
    let judgeModel = "";
    if (judgeKey) {
      const [jp, jm] = judgeKey.split(":", 2);
      if (jp && jm && selectedProviders.has(jp)) {
        judgeProvider = jp;
        judgeModel = jm;
      }
    }
    // Default: first participant is judge
    if (!judgeProvider && participants.length > 0) {
      judgeProvider = participants[0].providerType;
      judgeModel = participants[0].modelKey;
    }

    // Mark judge
    for (const p of participants) {
      p.isJudge = p.providerType === judgeProvider && p.modelKey === judgeModel;
    }

    onConfigChangeRef.current({
      participants,
      judgeProviderType: judgeProvider as Any,
      judgeModelKey: judgeModel,
    });
  }, [selectedProviders, selectedModels, judgeKey, configuredProviders]);

  if (configuredProviders.length < 2) {
    return (
      <div className="multi-llm-selection-panel">
        <div className="multi-llm-header">Multi-LLM Mode</div>
        <div className="multi-llm-hint">
          Configure at least 2 LLM providers in Settings to use this mode.
        </div>
      </div>
    );
  }

  // Build judge options from selected participants
  const judgeOptions: Array<{ key: string; label: string }> = [];
  for (const providerType of selectedProviders) {
    const modelKey = selectedModels.get(providerType);
    if (!modelKey) continue;
    const providerInfo = MULTI_LLM_PROVIDER_DISPLAY[providerType];
    const name = providerInfo?.name || providerType;
    judgeOptions.push({
      key: `${providerType}:${modelKey}`,
      label: `${providerInfo?.icon || ""} ${name} (${modelKey})`,
    });
  }

  return (
    <div className="multi-llm-selection-panel">
      <div className="multi-llm-header">Select LLMs to compare</div>
      <div className="multi-llm-providers">
        {configuredProviders.map((provider) => {
          const isSelected = selectedProviders.has(provider.type);
          const models = providerModels.get(provider.type) || [];
          const providerDisplay = MULTI_LLM_PROVIDER_DISPLAY[provider.type];
          return (
            <div key={provider.type} className="multi-llm-provider-row">
              <label className="multi-llm-provider-label">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={(e) => handleProviderToggle(provider.type, e.target.checked)}
                />
                <span>
                  {providerDisplay?.icon || ""} {provider.name}
                </span>
              </label>
              {isSelected && models.length > 0 && (
                <select
                  className="multi-llm-model-select"
                  value={selectedModels.get(provider.type) || ""}
                  onChange={(e) => handleModelChange(provider.type, e.target.value)}
                >
                  {models.map((m) => (
                    <option key={m.key} value={m.key}>
                      {m.displayName}
                    </option>
                  ))}
                </select>
              )}
            </div>
          );
        })}
      </div>
      {judgeOptions.length >= 2 && (
        <div className="multi-llm-judge">
          <label>Judge / Leader:</label>
          <select
            className="multi-llm-judge-select"
            value={judgeKey || judgeOptions[0]?.key || ""}
            onChange={(e) => setJudgeKey(e.target.value)}
          >
            {judgeOptions.map((opt) => (
              <option key={opt.key} value={opt.key}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      )}
      {selectedProviders.size > 0 && selectedProviders.size < 2 && (
        <div className="multi-llm-hint">Select at least 2 providers to start</div>
      )}
    </div>
  );
}
