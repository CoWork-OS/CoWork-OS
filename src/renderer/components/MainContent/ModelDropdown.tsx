import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from "react";
import type {
  LLMModelInfo,
  LLMProviderInfo,
  LLMProviderType,
  LLMReasoningEffort,
} from "../../../shared/types";
import {
  getLlmModelDefaultReasoningEffort,
  getLlmModelReasoningEfforts,
  getLlmReasoningEffortOptions,
} from "../../../shared/llm-model-selection";
import { getModelAccessDescriptor } from "../../../shared/model-access";
import { ChevronRight, Sparkles } from "lucide-react";
import { getLLMProviderIcon } from "../llm-provider-icons";
import { ModelSourcePicker } from "./ModelSourcePicker";
import { useIsCalmTheme } from "../../hooks/useIsCalmTheme";
import type { SettingsTab } from "./main-content-types";

type ModelPickerView = "quick" | "advanced";
type ReasoningEffortOption = ReturnType<typeof getLlmReasoningEffortOptions>[number];

const REASONING_EFFORT_DESCRIPTIONS: Partial<Record<LLMReasoningEffort, string>> = {
  low: "Quick responses for straightforward tasks",
  medium: "A balanced default for most tasks",
  high: "More deliberate analysis for harder work",
  extra_high: "Maximum depth on supported models",
  xhigh: "Maximum depth on supported models",
  max: "Maximum depth on supported models",
  ultra: "Deepest reasoning, with longer responses",
};

interface QuickModelPickerProps {
  providerType: LLMProviderType;
  providerLabel: string;
  accessLabel: string;
  selectedModelLabel: string;
  selectedModelInfo?: LLMModelInfo;
  selectedReasoningEffort?: LLMReasoningEffort;
  reasoningEffortOptions: ReasoningEffortOption[];
  onReasoningEffortChange: (reasoningEffort: LLMReasoningEffort) => void;
  onOpenAdvanced: () => void;
}

function QuickModelPicker({
  providerType,
  providerLabel,
  accessLabel,
  selectedModelLabel,
  selectedModelInfo,
  selectedReasoningEffort,
  reasoningEffortOptions,
  onReasoningEffortChange,
  onOpenAdvanced,
}: QuickModelPickerProps) {
  const isCalm = useIsCalmTheme();
  const fallbackIndex = Math.max(
    0,
    reasoningEffortOptions.findIndex((option) => option.value === "medium"),
  );
  const selectedIndex = reasoningEffortOptions.findIndex(
    (option) => option.value === selectedReasoningEffort,
  );
  const sliderIndex = selectedIndex >= 0 ? selectedIndex : fallbackIndex;
  const selectedOption = reasoningEffortOptions[sliderIndex];
  const lastIndex = Math.max(reasoningEffortOptions.length - 1, 0);
  const progress = lastIndex > 0 ? (sliderIndex / lastIndex) * 100 : 100;
  const isEffortLocked = reasoningEffortOptions.length < 2;
  const modelDescription =
    selectedModelInfo?.description?.trim() ||
    REASONING_EFFORT_DESCRIPTIONS[selectedOption?.value || "medium"] ||
    "Choose how much reasoning to use for the next response.";
  const modelDetail =
    (modelDescription.toLowerCase().startsWith(selectedModelLabel.toLowerCase())
      ? modelDescription.slice(selectedModelLabel.length).trim()
      : modelDescription) || "Choose how much reasoning to use for the next response.";

  return (
    <div
      className="model-dropdown-panel model-quick-panel"
      role="dialog"
      aria-label={`${providerLabel} model and reasoning controls (${accessLabel})`}
    >
      <p className="model-quick-model-copy">
        <span className="model-quick-model-icon" aria-hidden="true">
          {getLLMProviderIcon(providerType)}
        </span>
        <strong>{selectedModelLabel}</strong>
        <span className="model-quick-model-detail">{modelDetail}</span>
      </p>

      {reasoningEffortOptions.length > 0 ? (
        <div className="model-quick-effort-control" aria-label="Reasoning effort">
          <div
            className={`model-quick-effort-shell ${isEffortLocked ? "disabled" : ""}`}
            style={
              {
                "--model-quick-progress": `${progress}%`,
                "--model-quick-ratio": lastIndex > 0 ? sliderIndex / lastIndex : 1,
              } as React.CSSProperties
            }
          >
            {/* Markers render before the input so the thumb paints over them. */}
            <div className="model-quick-effort-markers" aria-hidden="true">
              {reasoningEffortOptions.map((option, index) => (
                <span
                  key={option.value}
                  className={`${index === sliderIndex ? "active" : ""} ${index < sliderIndex ? "filled" : ""}`}
                  style={
                    {
                      "--model-quick-marker": `${lastIndex > 0 ? (index / lastIndex) * 100 : 100}%`,
                    } as React.CSSProperties
                  }
                />
              ))}
            </div>
            <input
              className="model-quick-effort-range"
              type="range"
              min={0}
              max={lastIndex}
              step={1}
              value={sliderIndex}
              disabled={isEffortLocked}
              aria-label="Reasoning effort"
              aria-valuetext={selectedOption?.label || "Default"}
              autoFocus
              onChange={(event) => {
                const nextOption = reasoningEffortOptions[Number(event.currentTarget.value)];
                if (nextOption) onReasoningEffortChange(nextOption.value);
              }}
            />
          </div>
          {isCalm && selectedOption && (
            <p className="model-quick-effort-caption" aria-hidden="true">
              <strong>{selectedOption.label}</strong>
              <span>
                {REASONING_EFFORT_DESCRIPTIONS[selectedOption.value] ||
                  "Reasoning depth for the next response"}
              </span>
            </p>
          )}
        </div>
      ) : (
        <div className="model-quick-empty-state">
          This model does not expose a reasoning-effort control.
        </div>
      )}

      <button
        type="button"
        className="model-quick-custom"
        onClick={onOpenAdvanced}
        aria-label="Open custom model picker"
      >
        <strong>Custom</strong>
        <ChevronRight size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

// Searchable Model Dropdown Component
export interface ModelDropdownProps {
  models: LLMModelInfo[];
  selectedModel: string;
  selectedProvider: LLMProviderType;
  selectedReasoningEffort?: LLMReasoningEffort;
  providers?: LLMProviderInfo[];
  variant?: "button" | "label";
  align?: "left" | "right";
  onModelChange: (selection: {
    providerType?: LLMProviderType;
    modelKey: string;
    reasoningEffort?: LLMReasoningEffort;
  }) => void;
  onOpenSettings?: (tab?: SettingsTab) => void;
}

export function ModelDropdown({
  models,
  selectedModel,
  selectedProvider,
  selectedReasoningEffort,
  providers = [],
  variant = "button",
  align = "left",
  onModelChange,
  onOpenSettings,
}: ModelDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [pickerView, setPickerView] = useState<ModelPickerView>("quick");
  const [search, setSearch] = useState("");
  const [providerModelCache, setProviderModelCache] = useState<Record<string, LLMModelInfo[]>>({});
  const [loadingProviderModels, setLoadingProviderModels] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const closeDropdown = useCallback(() => {
    setIsOpen(false);
    setSearch("");
    setPickerView("quick");
  }, []);

  useEffect(() => {
    setProviderModelCache((prev) => ({
      ...prev,
      [selectedProvider]: models,
    }));
  }, [models, selectedProvider]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        closeDropdown();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [closeDropdown]);

  // The panel opens upward from the trigger, so cap its height to the room above the
  // trigger; otherwise a short window pushes the top of the panel off-screen.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!isOpen || !container) return;
    const update = () => {
      // Top of the visible area: the app header, or the nearest clipping ancestor if lower.
      let limit =
        parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--header-height")) ||
        0;
      for (let el = container.parentElement; el; el = el.parentElement) {
        const { overflowY } = getComputedStyle(el);
        if (overflowY !== "visible") limit = Math.max(limit, el.getBoundingClientRect().top);
      }
      const room = Math.floor(container.getBoundingClientRect().top - limit - 8 - 12);
      container.style.setProperty("--model-dropdown-room", `${Math.max(room, 160)}px`);
    };
    update();
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      container.style.removeProperty("--model-dropdown-room");
    };
  }, [isOpen]);

  // Escape closes the picker wherever focus is; the trigger's own key handler
  // only sees it while the trigger is focused.
  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      closeDropdown();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [closeDropdown, isOpen]);

  const configuredProviders = useMemo(() => {
    const seen = new Set<string>();
    const list = providers.filter((provider) => provider.configured);
    const currentProvider = providers.find((provider) => provider.type === selectedProvider);
    if (currentProvider && !list.some((provider) => provider.type === currentProvider.type)) {
      list.unshift(currentProvider);
    }
    return list.filter((provider) => {
      if (seen.has(provider.type)) return false;
      seen.add(provider.type);
      return true;
    });
  }, [providers, selectedProvider]);

  const currentProviderModels = providerModelCache[selectedProvider] || models;
  const selectedModelInfo =
    currentProviderModels.find((model) => model.key === selectedModel) ||
    models.find((model) => model.key === selectedModel);
  const selectedModelLabel = selectedModelInfo?.displayName || selectedModel || "Select Model";
  const currentProviderLabel =
    configuredProviders.find((provider) => provider.type === selectedProvider)?.name ||
    selectedProvider;
  const currentAccess = getModelAccessDescriptor(selectedProvider);

  const selectedReasoningEfforts =
    selectedModelInfo?.reasoningEfforts ||
    getLlmModelReasoningEfforts(
      selectedProvider,
      selectedModel,
      selectedModelInfo?.openaiAuthMethod,
    );
  const reasoningEffortOptions = getLlmReasoningEffortOptions(
    selectedProvider,
    selectedModelInfo?.openaiAuthMethod,
    selectedReasoningEfforts,
  );
  // With no saved effort the provider sends none, which is the model's API default
  // (off for budget-thinking models), so show that rather than a generic "medium".
  const selectedModelDefaultEffort = getLlmModelDefaultReasoningEffort(
    selectedProvider,
    selectedModel,
  );
  const effectiveReasoningEffort =
    selectedReasoningEffort && selectedReasoningEfforts.includes(selectedReasoningEffort)
      ? selectedReasoningEffort
      : selectedModelDefaultEffort && selectedReasoningEfforts.includes(selectedModelDefaultEffort)
        ? selectedModelDefaultEffort
        : undefined;

  const normalizedSearch = search.trim().toLowerCase();
  const filteredModels = currentProviderModels.filter((model) => {
    if (!normalizedSearch) return true;
    return (
      model.displayName.toLowerCase().includes(normalizedSearch) ||
      model.key.toLowerCase().includes(normalizedSearch) ||
      model.description.toLowerCase().includes(normalizedSearch)
    );
  });

  const loadProviderModels = useCallback(
    async (providerType: LLMProviderType) => {
      if (providerModelCache[providerType]) return;
      try {
        setLoadingProviderModels(providerType);
        const providerModels = await window.electronAPI.getProviderModels(providerType);
        setProviderModelCache((prev) => ({
          ...prev,
          [providerType]: providerModels || [],
        }));
      } catch (error) {
        console.error("Failed to load provider models:", error);
        setProviderModelCache((prev) => ({
          ...prev,
          [providerType]: [],
        }));
      } finally {
        setLoadingProviderModels((current) => (current === providerType ? null : current));
      }
    },
    [providerModelCache],
  );

  const selectModel = (
    providerType: LLMProviderType,
    modelKey: string,
    modelInfo?: LLMModelInfo,
  ) => {
    const reasoningEfforts =
      modelInfo?.reasoningEfforts ||
      getLlmModelReasoningEfforts(providerType, modelKey, modelInfo?.openaiAuthMethod);
    const modelDefaultEffort = getLlmModelDefaultReasoningEffort(providerType, modelKey);
    const reasoningEffort =
      selectedReasoningEffort && reasoningEfforts.includes(selectedReasoningEffort)
        ? selectedReasoningEffort
        : modelDefaultEffort && reasoningEfforts.includes(modelDefaultEffort)
          ? modelDefaultEffort
          : reasoningEfforts.includes("medium")
            ? "medium"
            : reasoningEfforts[0];

    onModelChange({
      providerType,
      modelKey,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    });
    closeDropdown();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        setPickerView("quick");
        setIsOpen(true);
      }
      return;
    }

    switch (e.key) {
      case "Enter":
        e.preventDefault();
        if (filteredModels[0]) {
          selectModel(selectedProvider, filteredModels[0].key, filteredModels[0]);
        }
        break;
      case "Escape":
        e.preventDefault();
        closeDropdown();
        break;
    }
  };

  const handleOpenProviders = () => {
    closeDropdown();
    onOpenSettings?.("llm");
  };
  const handleOpenAdvanced = () => {
    setPickerView("advanced");
    setSearch("");
  };
  const handleReturnToQuick = () => {
    setPickerView("quick");
    setSearch("");
  };

  return (
    <div
      className={`model-dropdown-container ${align === "right" ? "align-right" : ""} ${variant === "label" ? "model-dropdown-container-label" : ""}`}
      ref={containerRef}
    >
      <button
        type="button"
        className={`${variant === "label" ? "model-label-subtle" : "model-selector"} ${isOpen ? "open" : ""}`}
        title={`${currentProviderLabel}: ${selectedModelLabel} (${currentAccess.label})`}
        aria-label={`Change model source, currently ${currentProviderLabel}, ${selectedModelLabel}`}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        onClick={() => {
          if (isOpen) {
            closeDropdown();
            return;
          }
          setPickerView("quick");
          setIsOpen(true);
        }}
        onKeyDown={handleKeyDown}
      >
        {variant === "label" ? (
          <Sparkles className="model-label-icon" size={14} aria-hidden="true" />
        ) : (
          <svg
            className="model-selector-icon"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z" />
            <path d="M18 14l1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3z" />
          </svg>
        )}
        <span className="model-label-text">{selectedModelLabel}</span>
        {effectiveReasoningEffort && (
          <span className="model-selector-effort">
            {
              reasoningEffortOptions.find((option) => option.value === effectiveReasoningEffort)
                ?.label
            }
          </span>
        )}
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={`model-dropdown-chevron ${isOpen ? "chevron-up" : ""}`}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {isOpen && (
        <div
          className={`model-dropdown ${pickerView === "quick" ? "model-dropdown-quick" : "model-dropdown-advanced"} ${align === "right" ? "align-right" : ""}`}
        >
          {pickerView === "quick" ? (
            <QuickModelPicker
              providerType={selectedProvider}
              providerLabel={currentProviderLabel}
              accessLabel={currentAccess.label}
              selectedModelLabel={selectedModelLabel}
              selectedModelInfo={selectedModelInfo}
              selectedReasoningEffort={effectiveReasoningEffort}
              reasoningEffortOptions={reasoningEffortOptions}
              onReasoningEffortChange={(reasoningEffort) =>
                onModelChange({
                  providerType: selectedProvider,
                  modelKey: selectedModel,
                  reasoningEffort,
                })
              }
              onOpenAdvanced={handleOpenAdvanced}
            />
          ) : (
            <ModelSourcePicker
              providers={configuredProviders}
              selectedProvider={selectedProvider}
              selectedModel={selectedModel}
              selectedReasoningEffort={effectiveReasoningEffort}
              reasoningOptions={reasoningEffortOptions.filter((option) =>
                selectedReasoningEfforts.includes(option.value),
              )}
              modelsByProvider={providerModelCache}
              loadingProvider={loadingProviderModels}
              onLoadProvider={(providerType) => void loadProviderModels(providerType)}
              onSelectModel={selectModel}
              onReasoningEffortChange={(reasoningEffort) =>
                onModelChange({
                  providerType: selectedProvider,
                  modelKey: selectedModel,
                  reasoningEffort,
                })
              }
              onBack={handleReturnToQuick}
              onClose={closeDropdown}
              onManageSources={handleOpenProviders}
            />
          )}
        </div>
      )}
    </div>
  );
}
