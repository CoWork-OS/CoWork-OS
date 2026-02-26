import { LLMProviderFactory } from "../agent/llm";
import { ErrorCodes, type ErrorCode } from "./protocol";
import type { LLMProviderType } from "../../shared/types";
import { LLM_PROVIDER_TYPES } from "../../shared/types";

const VALID_LLM_PROVIDER_TYPES = new Set<string>(LLM_PROVIDER_TYPES as readonly string[]);
const BASE_URL_PROVIDER_KEYS = new Set<string>(["openrouter", "groq", "xai", "kimi", "ollama"]);

type LlmValidationError = Error & { code: ErrorCode };

type SanitizedLlmConfigureParams = {
  providerType: LLMProviderType;
  apiKey?: string;
  model?: string;
  settings?: Record<string, unknown>;
};

const createInvalidParamsError = (message: string): LlmValidationError =>
  Object.assign(new Error(message), { code: ErrorCodes.INVALID_PARAMS });

function sanitizeOptionalStringField(
  value: unknown,
  fieldName: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw createInvalidParamsError(`${fieldName} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maxLength) {
    throw createInvalidParamsError(`${fieldName} exceeds max length (${maxLength})`);
  }
  return trimmed;
}

function sanitizeLlmConfigureParams(params: unknown): SanitizedLlmConfigureParams {
  const p = (params ?? {}) as Any;
  const providerTypeRaw = typeof p.providerType === "string" ? p.providerType.trim() : "";
  if (!providerTypeRaw) {
    throw createInvalidParamsError("providerType is required");
  }
  if (!VALID_LLM_PROVIDER_TYPES.has(providerTypeRaw)) {
    throw createInvalidParamsError(`Unsupported providerType: ${providerTypeRaw}`);
  }

  const settings = (() => {
    if (p.settings === undefined || p.settings === null) return undefined;
    if (!p.settings || typeof p.settings !== "object" || Array.isArray(p.settings)) {
      throw createInvalidParamsError("settings must be an object");
    }
    return p.settings as Record<string, unknown>;
  })();

  return {
    providerType: providerTypeRaw as LLMProviderType,
    apiKey: sanitizeOptionalStringField(p.apiKey, "apiKey", 5000),
    model: sanitizeOptionalStringField(p.model, "model", 500),
    ...(settings ? { settings } : {}),
  };
}

function readOptionalSettingString(
  settings: Record<string, unknown> | undefined,
  key: string,
  maxLength: number,
): string | undefined {
  if (!settings || !(key in settings)) return undefined;
  return sanitizeOptionalStringField(settings[key], `settings.${key}`, maxLength);
}

function readOptionalSettingBoolean(
  settings: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  if (!settings || !(key in settings)) return undefined;
  const value = settings[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw createInvalidParamsError(`settings.${key} must be a boolean`);
  }
  return value;
}

function applyProviderApiKeyAndBaseUrl(
  updatedSettings: Any,
  providerKey: string,
  apiKey: string | undefined,
  baseUrl: string | undefined,
): Any {
  if (!apiKey && !baseUrl) return updatedSettings;
  return {
    ...updatedSettings,
    [providerKey]: {
      ...updatedSettings[providerKey],
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    },
  };
}

export function getControlPlaneLlmStatus() {
  const llmStatus = LLMProviderFactory.getConfigStatus();
  return {
    currentProvider: llmStatus.currentProvider,
    currentModel: llmStatus.currentModel,
    providers: llmStatus.providers,
  };
}

export function configureLlmFromControlPlaneParams(params: unknown): {
  llm: ReturnType<typeof getControlPlaneLlmStatus>;
} {
  const validated = sanitizeLlmConfigureParams(params);
  const settingsPatch = validated.settings;
  const baseUrl = readOptionalSettingString(settingsPatch, "baseUrl", 2000);
  const endpoint = readOptionalSettingString(settingsPatch, "endpoint", 2000);
  const deployment = readOptionalSettingString(settingsPatch, "deployment", 500);
  const apiVersion = readOptionalSettingString(settingsPatch, "apiVersion", 200);
  const region = readOptionalSettingString(settingsPatch, "region", 100);
  const accessKeyId = readOptionalSettingString(settingsPatch, "accessKeyId", 500);
  const secretAccessKey = readOptionalSettingString(settingsPatch, "secretAccessKey", 5000);
  const sessionToken = readOptionalSettingString(settingsPatch, "sessionToken", 5000);
  const profile = readOptionalSettingString(settingsPatch, "profile", 200);
  const useDefaultCredentials = readOptionalSettingBoolean(settingsPatch, "useDefaultCredentials");
  const piProvider = readOptionalSettingString(settingsPatch, "provider", 100);

  let updatedSettings: Any = {
    ...LLMProviderFactory.loadSettings(),
    providerType: validated.providerType,
  };

  switch (validated.providerType) {
    case "anthropic":
      if (validated.apiKey) {
        updatedSettings.anthropic = { ...updatedSettings.anthropic, apiKey: validated.apiKey };
      }
      break;
    case "openai":
      if (validated.apiKey) {
        updatedSettings.openai = {
          ...updatedSettings.openai,
          apiKey: validated.apiKey,
          authMethod: "api_key",
          accessToken: undefined,
          refreshToken: undefined,
          tokenExpiresAt: undefined,
        };
      }
      break;
    case "gemini":
      if (validated.apiKey) {
        updatedSettings.gemini = { ...updatedSettings.gemini, apiKey: validated.apiKey };
      }
      break;
    case "azure": {
      const existingDeployments = (updatedSettings.azure?.deployments || [])
        .map((entry: string) => entry.trim())
        .filter(Boolean);
      const nextDeployments =
        deployment && !existingDeployments.includes(deployment)
          ? [deployment, ...existingDeployments]
          : existingDeployments;

      if (validated.apiKey || endpoint || deployment || apiVersion) {
        updatedSettings.azure = {
          ...updatedSettings.azure,
          ...(validated.apiKey ? { apiKey: validated.apiKey } : {}),
          ...(endpoint ? { endpoint } : {}),
          ...(deployment ? { deployment } : {}),
          ...(apiVersion ? { apiVersion } : {}),
          ...(nextDeployments.length > 0
            ? { deployments: Array.from(new Set(nextDeployments)) }
            : {}),
        };
      }
      break;
    }
    case "bedrock":
      if (validated.apiKey) {
        throw createInvalidParamsError(
          "For providerType=bedrock, pass accessKeyId/secretAccessKey/profile under settings JSON (apiKey is not used).",
        );
      }
      if (
        region !== undefined ||
        accessKeyId !== undefined ||
        secretAccessKey !== undefined ||
        sessionToken !== undefined ||
        profile !== undefined ||
        useDefaultCredentials !== undefined
      ) {
        updatedSettings.bedrock = {
          ...updatedSettings.bedrock,
          ...(region ? { region } : {}),
          ...(accessKeyId ? { accessKeyId } : {}),
          ...(secretAccessKey ? { secretAccessKey } : {}),
          ...(sessionToken ? { sessionToken } : {}),
          ...(profile ? { profile } : {}),
          ...(useDefaultCredentials !== undefined ? { useDefaultCredentials } : {}),
        };
      }
      break;
    case "pi":
      if (validated.apiKey || piProvider) {
        updatedSettings.pi = {
          ...updatedSettings.pi,
          ...(validated.apiKey ? { apiKey: validated.apiKey } : {}),
          ...(piProvider ? { provider: piProvider } : {}),
        };
      }
      break;
    default:
      if (BASE_URL_PROVIDER_KEYS.has(validated.providerType)) {
        updatedSettings = applyProviderApiKeyAndBaseUrl(
          updatedSettings,
          validated.providerType,
          validated.apiKey,
          baseUrl,
        );
      } else if (validated.apiKey || baseUrl) {
        const currentCustom = updatedSettings.customProviders?.[validated.providerType] || {};
        updatedSettings.customProviders = {
          ...updatedSettings.customProviders,
          [validated.providerType]: {
            ...currentCustom,
            ...(validated.apiKey ? { apiKey: validated.apiKey } : {}),
            ...(baseUrl ? { baseUrl } : {}),
          },
        };
      }
      break;
  }

  if (validated.model) {
    updatedSettings = LLMProviderFactory.applyModelSelection(updatedSettings, validated.model);
  }

  LLMProviderFactory.saveSettings(updatedSettings);
  LLMProviderFactory.clearCache();
  return { llm: getControlPlaneLlmStatus() };
}
