import { useEffect, useState } from "react";
import type { LLMModelInfo, LLMProviderType } from "../../shared/types";

export interface BotModelValue {
  /** "" with an empty `modelKey`: the bot follows the default model. */
  providerType: string;
  modelKey: string;
}

interface ProviderOption {
  type: LLMProviderType;
  name: string;
}

/**
 * The bot's own model: "Default model" (follow the app's model) or a connected provider and
 * one of its models. A conversation can still pick its own model in the chat.
 */
export function BotModelField({
  value,
  onChange,
  disabled,
}: {
  value: BotModelValue;
  onChange: (value: BotModelValue) => void;
  disabled?: boolean;
}) {
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [defaultLabel, setDefaultLabel] = useState("Default model");
  const [models, setModels] = useState<{ provider: string; list: LLMModelInfo[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI
      ?.getLLMConfigStatus?.()
      .then((status) => {
        if (cancelled || !status) return;
        setProviders(
          status.providers
            .filter((provider) => provider.configured)
            .map((provider) => ({ type: provider.type, name: provider.name })),
        );
        if (status.currentModel) setDefaultLabel(`Default model (${status.currentModel})`);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const provider = value.providerType;
  useEffect(() => {
    if (!provider || models?.provider === provider) return;
    let cancelled = false;
    window.electronAPI
      ?.getProviderModels?.(provider)
      .then((list) => {
        if (!cancelled) setModels({ provider, list: (list || []) as LLMModelInfo[] });
      })
      .catch(() => {
        if (!cancelled) setModels({ provider, list: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [provider, models?.provider]);

  const list = models?.provider === provider ? models.list : [];
  // A saved model the list does not offer (renamed, custom) stays selectable.
  const options =
    value.modelKey && !list.some((model) => model.key === value.modelKey)
      ? [{ key: value.modelKey, displayName: value.modelKey }, ...list]
      : list;
  const knownProvider = providers.some((option) => option.type === provider);

  return (
    <div className="bot-form-field">
      <span>
        Model <small>optional</small>
      </span>
      <div className="bot-form-model">
        <select
          aria-label="Model source"
          value={provider}
          disabled={disabled}
          onChange={(event) => onChange({ providerType: event.target.value, modelKey: "" })}
        >
          <option value="">{defaultLabel}</option>
          {providers.map((option) => (
            <option key={option.type} value={option.type}>
              {option.name}
            </option>
          ))}
          {provider && !knownProvider && (
            <option value={provider}>{provider} (not connected)</option>
          )}
        </select>
        {provider && (
          <select
            aria-label="Model"
            value={value.modelKey}
            disabled={disabled}
            onChange={(event) => onChange({ providerType: provider, modelKey: event.target.value })}
          >
            <option value="" disabled>
              {models?.provider === provider ? "Choose a model" : "Loading models…"}
            </option>
            {options.map((model) => (
              <option key={model.key} value={model.key}>
                {model.displayName || model.key}
              </option>
            ))}
          </select>
        )}
      </div>
      <small className="bot-form-hint">
        Used in all of this bot's conversations. A conversation can still pick its own model.
      </small>
    </div>
  );
}
