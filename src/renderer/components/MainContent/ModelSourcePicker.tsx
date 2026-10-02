import { useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, Search, Settings2 } from "lucide-react";
import type {
  LLMModelInfo,
  LLMProviderInfo,
  LLMProviderType,
  LLMReasoningEffort,
} from "../../../shared/types";
import { getModelAccessDescriptor } from "../../../shared/model-access";
import { getLLMProviderIcon } from "../llm-provider-icons";
import { getModelDetail } from "../../utils/model-detail";
import "./model-source-picker.css";

interface ReasoningOption {
  value: LLMReasoningEffort;
  label: string;
}

interface ModelSourcePickerProps {
  /** Configured model sources, current one first. */
  providers: LLMProviderInfo[];
  selectedProvider: LLMProviderType;
  selectedModel: string;
  selectedReasoningEffort?: LLMReasoningEffort;
  /** Reasoning levels the current model supports. */
  reasoningOptions: ReasoningOption[];
  modelsByProvider: Record<string, LLMModelInfo[]>;
  loadingProvider: string | null;
  onLoadProvider: (providerType: LLMProviderType) => void;
  onSelectModel: (providerType: LLMProviderType, modelKey: string, model?: LLMModelInfo) => void;
  onReasoningEffortChange: (reasoningEffort: LLMReasoningEffort) => void;
  onBack: () => void;
  onClose: () => void;
  onManageSources: () => void;
}

/**
 * Full model picker: switch between configured sources, search the source's models, and set
 * reasoning depth for the current model.
 */
export function ModelSourcePicker({
  providers,
  selectedProvider,
  selectedModel,
  selectedReasoningEffort,
  reasoningOptions,
  modelsByProvider,
  loadingProvider,
  onLoadProvider,
  onSelectModel,
  onReasoningEffortChange,
  onBack,
  onClose,
  onManageSources,
}: ModelSourcePickerProps) {
  const [browsingProvider, setBrowsingProvider] = useState<LLMProviderType>(selectedProvider);
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, [browsingProvider]);

  // The source in use comes first.
  const orderedProviders = [
    ...providers.filter((provider) => provider.type === selectedProvider),
    ...providers.filter((provider) => provider.type !== selectedProvider),
  ];
  const browsing = providers.find((provider) => provider.type === browsingProvider);
  const browsingLabel = browsing?.name || browsingProvider;
  const models = modelsByProvider[browsingProvider] || [];
  const isLoading = loadingProvider === browsingProvider && models.length === 0;
  const query = search.trim().toLowerCase();
  const filteredModels = query
    ? models.filter(
        (model) =>
          model.displayName.toLowerCase().includes(query) ||
          model.key.toLowerCase().includes(query) ||
          model.description.toLowerCase().includes(query),
      )
    : models;
  const isBrowsingCurrent = browsingProvider === selectedProvider;

  const browse = (providerType: LLMProviderType) => {
    setBrowsingProvider(providerType);
    setSearch("");
    onLoadProvider(providerType);
  };

  return (
    <div className="model-dropdown-panel msp" role="dialog" aria-label="Choose a model">
      <div className="msp-header">
        <button
          type="button"
          className="msp-icon-btn"
          onClick={onBack}
          aria-label="Back to quick controls"
          title="Back"
        >
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        <span className="msp-title">Choose a model</span>
        <button
          type="button"
          className="msp-icon-btn msp-manage"
          onClick={onManageSources}
          aria-label="Connect or manage model sources"
          title="Connect or manage model sources"
        >
          <Settings2 size={15} aria-hidden="true" />
        </button>
      </div>

      {providers.length > 1 && (
        <div className="msp-sources" role="tablist" aria-label="Model sources">
          {orderedProviders.map((provider) => {
            const active = provider.type === browsingProvider;
            return (
              <button
                key={provider.type}
                type="button"
                role="tab"
                aria-selected={active}
                className={`msp-source${active ? " active" : ""}`}
                onClick={() => browse(provider.type)}
                title={`${provider.name} · ${getModelAccessDescriptor(provider.type).label}`}
              >
                <span className="msp-source-icon" aria-hidden="true">
                  {getLLMProviderIcon(provider.type)}
                </span>
                <span>{provider.name}</span>
                {provider.type === selectedProvider && (
                  <span className="msp-source-dot" aria-label="in use" />
                )}
              </button>
            );
          })}
        </div>
      )}

      <label className="msp-search">
        <Search size={15} aria-hidden="true" />
        <input
          ref={searchRef}
          type="text"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && filteredModels[0]) {
              event.preventDefault();
              onSelectModel(browsingProvider, filteredModels[0].key, filteredModels[0]);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
          placeholder={`Search ${browsingLabel} models`}
          aria-label={`Search ${browsingLabel} models`}
        />
        <span className="msp-search-count">{filteredModels.length}</span>
      </label>

      <div className="msp-list" role="listbox" aria-label={`${browsingLabel} models`}>
        {isLoading ? (
          <div className="msp-empty">Loading models…</div>
        ) : filteredModels.length === 0 ? (
          <div className="msp-empty">
            {query ? `No models match “${search.trim()}”` : "No models available"}
          </div>
        ) : (
          filteredModels.map((model) => {
            const selected = isBrowsingCurrent && model.key === selectedModel;
            const detail = getModelDetail(model);
            return (
              <button
                key={model.key}
                type="button"
                role="option"
                aria-selected={selected}
                className={`msp-model${selected ? " selected" : ""}`}
                onClick={() => onSelectModel(browsingProvider, model.key, model)}
                title={model.key}
              >
                <span className="msp-model-copy">
                  <span className="msp-model-name">{model.displayName}</span>
                  {detail && <span className="msp-model-detail">{detail}</span>}
                </span>
                {selected && <Check size={15} className="msp-model-check" aria-hidden="true" />}
              </button>
            );
          })
        )}
      </div>

      {isBrowsingCurrent && reasoningOptions.length > 1 && (
        <div className="msp-footer">
          <span className="msp-reasoning-label" id="msp-reasoning-label">
            Reasoning depth
          </span>
          <div
            className="msp-reasoning-options"
            role="radiogroup"
            aria-labelledby="msp-reasoning-label"
          >
            {reasoningOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={option.value === selectedReasoningEffort}
                className={`msp-reasoning-option${option.value === selectedReasoningEffort ? " active" : ""}`}
                onClick={() => onReasoningEffortChange(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
