import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from "react";
import type {
  LLMModelInfo,
  LLMProviderInfo,
  LLMProviderType,
  LLMReasoningEffort,
} from "../../../shared/types";
import {
  getLlmModelReasoningEfforts,
  LLM_REASONING_EFFORT_OPTIONS,
} from "../../../shared/llm-model-selection";
import { getModelAccessDescriptor } from "../../../shared/model-access";
import { Sparkles } from "lucide-react";
import type { SettingsTab } from "./main-content-types";

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
  const [search, setSearch] = useState("");
  const [activeProviderMenu, setActiveProviderMenu] =
    useState<LLMProviderType | null>(null);
  const [providerModelCache, setProviderModelCache] = useState<
    Record<string, LLMModelInfo[]>
  >({});
  const [loadingProviderModels, setLoadingProviderModels] = useState<
    string | null
  >(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setProviderModelCache((prev) => ({
      ...prev,
      [selectedProvider]: models,
    }));
  }, [models, selectedProvider]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setSearch("");
        setActiveProviderMenu(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

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
    getLlmModelReasoningEfforts(selectedProvider, selectedModel);
  const effectiveReasoningEffort =
    selectedReasoningEffort &&
    selectedReasoningEfforts.includes(selectedReasoningEffort)
      ? selectedReasoningEffort
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

  const otherProviders = configuredProviders.filter(
    (provider) => provider.type !== selectedProvider,
  );

  const loadProviderModels = useCallback(async (providerType: LLMProviderType) => {
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
      setLoadingProviderModels((current) =>
        current === providerType ? null : current,
      );
    }
  }, [providerModelCache]);

  const selectModel = (
    providerType: LLMProviderType,
    modelKey: string,
    modelInfo?: LLMModelInfo,
  ) => {
    const reasoningEfforts =
      modelInfo?.reasoningEfforts ||
      getLlmModelReasoningEfforts(providerType, modelKey);
    const reasoningEffort =
      selectedReasoningEffort && reasoningEfforts.includes(selectedReasoningEffort)
        ? selectedReasoningEffort
        : reasoningEfforts.includes("medium")
          ? "medium"
          : reasoningEfforts[0];

    onModelChange({
      providerType,
      modelKey,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    });
    setIsOpen(false);
    setSearch("");
    setActiveProviderMenu(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
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
        setIsOpen(false);
        setSearch("");
        setActiveProviderMenu(null);
        break;
    }
  };

  const handleOpenProviders = () => {
    setIsOpen(false);
    setSearch("");
    setActiveProviderMenu(null);
    onOpenSettings?.("llm");
  };
  const activeProvider = otherProviders.find((provider) => provider.type === activeProviderMenu);
  const activeProviderModels = activeProvider ? providerModelCache[activeProvider.type] || [] : [];

  return (
    <div
      className={`model-dropdown-container ${align === "right" ? "align-right" : ""} ${variant === "label" ? "model-dropdown-container-label" : ""}`}
      ref={containerRef}
    >
      <button
        className={`${variant === "label" ? "model-label-subtle" : "model-selector"} ${isOpen ? "open" : ""}`}
        title={`${currentProviderLabel}: ${selectedModelLabel} (${currentAccess.label})`}
        aria-label={`Change model source, currently ${currentProviderLabel}, ${selectedModelLabel}`}
        aria-expanded={isOpen}
        onClick={() => {
          setIsOpen(!isOpen);
          if (!isOpen) {
            setTimeout(() => inputRef.current?.focus(), 0);
          } else {
            setActiveProviderMenu(null);
          }
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
        <span className="model-label-provider">{currentProviderLabel}</span>
        <span className="model-label-separator" aria-hidden="true">·</span>
        <span className="model-label-text">{selectedModelLabel}</span>
        {effectiveReasoningEffort && (
          <span className="model-selector-effort">
            {
              LLM_REASONING_EFFORT_OPTIONS.find(
                (option) => option.value === effectiveReasoningEffort,
              )?.label
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
          className={`model-dropdown ${align === "right" ? "align-right" : ""}`}
          onMouseLeave={() => setActiveProviderMenu(null)}
        >
          <div className="model-dropdown-panel">
            {selectedReasoningEfforts.length > 0 && (
              <div
                className="model-dropdown-section"
                onMouseEnter={() => setActiveProviderMenu(null)}
              >
                <div className="model-dropdown-section-label">Intelligence</div>
                {LLM_REASONING_EFFORT_OPTIONS.filter((option) =>
                  selectedReasoningEfforts.includes(option.value),
                ).map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`model-dropdown-item compact ${option.value === effectiveReasoningEffort ? "selected" : ""}`}
                    onClick={() =>
                      onModelChange({
                        providerType: selectedProvider,
                        modelKey: selectedModel,
                        reasoningEffort: option.value,
                      })
                    }
                  >
                    <span className="model-dropdown-item-name">{option.label}</span>
                    {option.value === effectiveReasoningEffort && (
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path d="M20 6L9 17l-5-5" />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            )}
            <div className="model-dropdown-search" onMouseEnter={() => setActiveProviderMenu(null)}>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="11" cy="11" r="8" />
                <path d="M21 21l-4.35-4.35" />
              </svg>
              <input
                ref={inputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={`Search ${currentProviderLabel} models...`}
                autoFocus
              />
            </div>
            <div className="model-dropdown-section-label model-dropdown-provider-label">
              {currentProviderLabel}
            </div>
            <div className="model-dropdown-list" onMouseEnter={() => setActiveProviderMenu(null)}>
              {filteredModels.length === 0 ? (
                <div className="model-dropdown-no-results">No models found</div>
              ) : (
                filteredModels.map((model) => (
                  <button
                    key={model.key}
                    className={`model-dropdown-item ${model.key === selectedModel ? "selected" : ""}`}
                    onClick={() => selectModel(selectedProvider, model.key, model)}
                  >
                    <div className="model-dropdown-item-content">
                      <span className="model-dropdown-item-name">{model.displayName}</span>
                      <span className="model-dropdown-item-desc">{model.description}</span>
                    </div>
                    {model.key === selectedModel && (
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path d="M20 6L9 17l-5-5" />
                      </svg>
                    )}
                  </button>
                ))
              )}
            </div>
            {otherProviders.length > 0 && (
              <div className="model-dropdown-section model-dropdown-other-providers">
                <div className="model-dropdown-section-label">Switch provider</div>
                <div className="model-dropdown-provider-list">
                  {otherProviders.map((provider) => {
                    const isActive = activeProviderMenu === provider.type;
                    return (
                      <div
                        key={provider.type}
                        className="model-dropdown-provider-row"
                        onMouseEnter={() => {
                          setActiveProviderMenu(provider.type);
                          void loadProviderModels(provider.type);
                        }}
                      >
                        <button
                          type="button"
                          className={`model-dropdown-item compact ${isActive ? "highlighted" : ""}`}
                          onClick={() => {
                            setActiveProviderMenu(isActive ? null : provider.type);
                            void loadProviderModels(provider.type);
                          }}
                        >
                          <span className="model-dropdown-provider-copy">
                            <span className="model-dropdown-item-name">{provider.name}</span>
                            <span className="model-dropdown-access-badge">
                              {getModelAccessDescriptor(provider.type).label}
                            </span>
                          </span>
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <path d="M9 18l6-6-6-6" />
                          </svg>
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="model-dropdown-footer" onMouseEnter={() => setActiveProviderMenu(null)}>
              <button
                type="button"
                className="model-dropdown-provider-btn"
                onClick={handleOpenProviders}
              >
                Connect or manage model sources
              </button>
            </div>
          </div>
          {activeProvider && (
            <div className="model-dropdown-submenu">
              {loadingProviderModels === activeProvider.type ? (
                <div className="model-dropdown-no-results">Loading models...</div>
              ) : activeProviderModels.length === 0 ? (
                <div className="model-dropdown-no-results">No models found</div>
              ) : (
                activeProviderModels.map((model) => (
                  <button
                    key={model.key}
                    type="button"
                    className="model-dropdown-item"
                    onClick={() => selectModel(activeProvider.type, model.key, model)}
                  >
                    <div className="model-dropdown-item-content">
                      <span className="model-dropdown-item-name">{model.displayName}</span>
                      <span className="model-dropdown-item-desc">{model.description}</span>
                    </div>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
