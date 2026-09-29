import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import { LLMProviderFactory } from "../../electron/agent/llm";
import { RuntimeVisibilityService } from "../../electron/agent/RuntimeVisibilityService";
import { testJevProvider } from "../../electron/agent/jev";
import { buildSavedLLMSettings } from "../../electron/ipc/llm-settings-save";
import {
  JevTestProviderRequestSchema,
  LLMSettingsSchema,
  PersonalityConfigV2Schema,
} from "../../electron/utils/validation";
import { MCPSettingsManager } from "../../electron/mcp/settings";
import { PermissionSettingsManager } from "../../electron/security/permission-settings-manager";
import { PersonalityManager } from "../../electron/settings/personality-manager";
import { isBlockedInternalHost, normalizeHostname } from "../../electron/security/address-classes";
import { LLM_PROVIDER_TYPES, type LLMSettingsData } from "../../shared/types";
import type { BrowserDesktopDefinitions } from "./browser-desktop-rpc";
import { WebApplicationError } from "../web/WebApplication";

const LLMProviderTypeSchema = z.enum(LLM_PROVIDER_TYPES);
const NonEmptyString = z.string().trim().min(1).max(500);
const OptionalString = z.string().max(4000).optional();
const PersonalitySettingsSchema = z.object({
  activePersonality: z
    .enum(["professional", "friendly", "concise", "creative", "technical", "casual", "custom"])
    .optional(),
  customPrompt: z.string().max(200_000).optional(),
  customName: z.string().max(200).optional(),
  agentName: z.string().max(200).optional(),
  activePersona: z
    .enum([
      "none",
      "jarvis",
      "friday",
      "hal",
      "computer",
      "alfred",
      "intern",
      "sensei",
      "pirate",
      "noir",
      "companion",
    ])
    .optional(),
  responseStyle: z
    .object({
      emojiUsage: z.enum(["none", "minimal", "moderate", "expressive"]).optional(),
      responseLength: z.enum(["terse", "balanced", "detailed"]).optional(),
      codeCommentStyle: z.enum(["minimal", "moderate", "verbose"]).optional(),
      explanationDepth: z.enum(["expert", "balanced", "teaching"]).optional(),
    })
    .optional(),
  quirks: z
    .object({
      catchphrase: z.string().max(200).optional(),
      signOff: z.string().max(200).optional(),
      analogyDomain: z
        .enum([
          "none",
          "cooking",
          "sports",
          "space",
          "music",
          "nature",
          "gaming",
          "movies",
          "construction",
        ])
        .optional(),
    })
    .optional(),
  relationship: z
    .object({
      userName: z.string().max(200).optional(),
      tasksCompleted: z.number().int().min(0).optional(),
      firstInteraction: z.number().optional(),
      lastInteraction: z.number().optional(),
      lastMilestoneCelebrated: z.number().optional(),
      projectsWorkedOn: z.array(z.string().max(200)).max(100).optional(),
    })
    .optional(),
  workStyle: z.enum(["planner", "flexible"]).optional(),
});
const ModelSelectionSchema = z.union([
  NonEmptyString,
  z.object({
    providerType: LLMProviderTypeSchema.optional(),
    modelKey: z.string().trim().min(1).max(200),
    reasoningEffort: z.enum(["none", "low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
  }),
]);

const SECRET_KEY =
  /(?:api.?key|access.?key|secret|password|credential|authorization|bearer|subscription.?token|access.?token|refresh.?token|id.?token)/i;
const AUTH_QUERY_KEYS = new Set([
  "key",
  "apikey",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "subscriptiontoken",
  "bearertoken",
  "authorization",
  "password",
  "secret",
  "clientsecret",
  "credential",
]);
const HOST_ONLY_OAUTH_KEYS = new Set([
  "accessToken",
  "refreshToken",
  "tokenExpiresAt",
  "tokenEndpoint",
  "idToken",
  "accountId",
  "email",
  "chatgptPlanType",
]);
const URL_KEYS = [
  "ollama.baseUrl",
  "openrouter.baseUrl",
  "deepseek.baseUrl",
  "groq.baseUrl",
  "xai.baseUrl",
  "kimi.baseUrl",
  "openaiCompatible.baseUrl",
  "azure.endpoint",
  "azureAnthropic.endpoint",
  "imageGeneration.openrouter.baseUrl",
  "imageGeneration.azure.imageEndpoint",
  "videoGeneration.azure.videoEndpoint",
  "videoGeneration.kling.baseUrl",
] as const;

function invalid(message = "Invalid browser action arguments."): never {
  throw new WebApplicationError("INVALID_REQUEST", message, 400);
}

function isAuthQueryKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    AUTH_QUERY_KEYS.has(normalized) ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("token") ||
    normalized.endsWith("authorization") ||
    normalized.endsWith("password") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("credential")
  );
}

function redactUrlQueryCredentials(raw: string): string {
  try {
    const parsed = new URL(raw);
    let changed = false;
    for (const key of [...parsed.searchParams.keys()]) {
      if (!isAuthQueryKey(key)) continue;
      parsed.searchParams.delete(key);
      changed = true;
    }
    return changed ? parsed.toString() : raw;
  } catch {
    return raw;
  }
}

function hasUrlQueryCredentials(raw: string): boolean {
  try {
    return [...new URL(raw).searchParams.keys()].some(isAuthQueryKey);
  } catch {
    return false;
  }
}

function urlTargetWithoutQueryCredentials(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    for (const key of [...parsed.searchParams.keys()]) {
      if (isAuthQueryKey(key)) parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function restoreSameTargetUrlQueryCredentials(incoming: string, current?: string): string {
  if (!current || hasUrlQueryCredentials(incoming)) return incoming;
  const incomingTarget = urlTargetWithoutQueryCredentials(incoming);
  if (!incomingTarget || incomingTarget !== urlTargetWithoutQueryCredentials(current)) {
    return incoming;
  }
  try {
    const restored = new URL(incoming);
    for (const [key, value] of new URL(current).searchParams) {
      if (isAuthQueryKey(key)) restored.searchParams.append(key, value);
    }
    return restored.toString();
  } catch {
    return incoming;
  }
}

function isUrlSettingKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized === "url" || normalized.endsWith("baseurl") || normalized.endsWith("endpoint");
}

function redactSettingsUrlQueries<T>(value: T, field = ""): T {
  if (typeof value === "string" && isUrlSettingKey(field)) {
    return redactUrlQueryCredentials(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSettingsUrlQueries(entry)) as T;
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, redactSettingsUrlQueries(entry, key)]),
  ) as T;
}

function restoreSettingsUrlQueryCredentials<T>(incoming: T, existing: unknown, field = ""): T {
  if (typeof incoming === "string" && typeof existing === "string" && isUrlSettingKey(field)) {
    return restoreSameTargetUrlQueryCredentials(incoming, existing) as T;
  }
  if (Array.isArray(incoming)) {
    const oldItems = Array.isArray(existing) ? existing : [];
    return incoming.map((entry, index) =>
      restoreSettingsUrlQueryCredentials(entry, oldItems[index]),
    ) as T;
  }
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return incoming;
  const oldRecord =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    Object.entries(incoming).map(([key, entry]) => [
      key,
      restoreSettingsUrlQueryCredentials(entry, oldRecord[key], key),
    ]),
  ) as T;
}

function parseArgs<T extends z.ZodTypeAny>(
  schema: T,
  args: unknown[],
  optional = false,
): z.infer<T>[] {
  if (optional && args.length === 0) return [];
  if (args.length !== 1) return invalid();
  const parsed = schema.safeParse(args[0]);
  if (!parsed.success) return invalid();
  return [parsed.data];
}

function parsePositional<T extends z.ZodTypeAny>(
  schemas: T[],
  args: unknown[],
  optionalCount = 0,
): unknown[] {
  if (args.length < schemas.length - optionalCount || args.length > schemas.length)
    return invalid();
  return args.map((arg, index) => {
    if (arg === undefined && index >= args.length - optionalCount) return undefined;
    const parsed = schemas[index].safeParse(arg);
    if (!parsed.success) return invalid();
    return parsed.data;
  });
}

function define(
  handler: (args: unknown[]) => unknown | Promise<unknown>,
  options: {
    capability?: "providers.read" | "providers.configure" | "agents.manage";
    mutation?: boolean;
    minArgs?: number;
    maxArgs?: number;
    validate?: (args: unknown[]) => unknown[];
  } = {},
) {
  return { ...options, handler };
}

function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry)) as T;
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) {
      output[`${key}Configured`] = typeof entry === "string" ? entry.length > 0 : Boolean(entry);
      continue;
    }
    output[key] = redactSecrets(entry);
  }
  return output as T;
}

function secretAwareMerge(incoming: unknown, existing: unknown): unknown {
  if (Array.isArray(incoming)) {
    const oldItems = Array.isArray(existing) ? existing : [];
    return incoming.map((entry, index) => secretAwareMerge(entry, oldItems[index]));
  }
  if (!incoming || typeof incoming !== "object") return incoming;
  const oldRecord =
    existing && typeof existing === "object" ? (existing as Record<string, unknown>) : {};
  const result: Record<string, unknown> = { ...oldRecord };
  for (const [key, value] of Object.entries(incoming)) {
    if (HOST_ONLY_OAUTH_KEYS.has(key)) {
      // Browser requests cannot set or clear host-managed OAuth state.
      if (oldRecord[key] !== undefined) result[key] = oldRecord[key];
      else delete result[key];
      continue;
    }
    if (key === "clearApiKey" && value === true) {
      result[key] = true;
      continue;
    }
    if (SECRET_KEY.test(key)) {
      if (typeof value === "string" && value.trim()) result[key] = value.trim();
      else if (oldRecord[key] !== undefined) result[key] = oldRecord[key];
      else delete result[key];
      continue;
    }
    result[key] = secretAwareMerge(value, oldRecord[key]);
  }
  return result;
}

function gatherKnownSecrets(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) gatherKnownSecrets(item, found);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY.test(key) && typeof item === "string" && item.length > 0) found.add(item);
      else gatherKnownSecrets(item, found);
    }
  }
  return found;
}

function scrubResult(value: unknown, extraSensitiveContext?: unknown): unknown {
  const secrets = gatherKnownSecrets(LLMProviderFactory.loadSettings());
  gatherKnownSecrets(extraSensitiveContext, secrets);
  const scrub = (entry: unknown): unknown => {
    if (typeof entry === "string") {
      let result = entry;
      for (const secret of secrets) result = result.split(secret).join("[redacted]");
      return result;
    }
    if (Array.isArray(entry)) return entry.map(scrub);
    if (!entry || typeof entry !== "object") return entry;
    return Object.fromEntries(Object.entries(entry).map(([key, nested]) => [key, scrub(nested)]));
  };
  return scrub(value);
}

function getNested(record: Record<string, unknown>, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (value, key) =>
        value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined,
      record,
    );
}

async function validateBaseUrl(
  value: unknown,
  label: string,
  allowLoopback = false,
  rejectAuthQueryParams = true,
): Promise<string | undefined> {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 500) return invalid(`${label} URL is invalid.`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalid(`${label} URL is invalid.`);
  }
  if (rejectAuthQueryParams && [...parsed.searchParams.keys()].some(isAuthQueryKey)) {
    return invalid(`${label} URL cannot include credentials in query parameters.`);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password
  ) {
    return invalid(`${label} URL must use HTTP or HTTPS without embedded credentials.`);
  }
  const hostname = normalizeHostname(parsed.hostname);
  if (!hostname || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    return invalid(`${label} URL cannot target a blocked host.`);
  }
  if (isBlockedInternalHost(hostname, allowLoopback)) {
    return invalid(`${label} URL cannot target private or metadata addresses.`);
  }
  if (!isIP(hostname)) {
    try {
      const resolved = await dnsLookup(hostname, { all: true, verbatim: true });
      if (resolved.some((entry) => isBlockedInternalHost(entry.address, allowLoopback))) {
        return invalid(`${label} URL resolves to a private or metadata address.`);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "ENOTFOUND" && code !== "EAI_AGAIN" && code !== "ENODATA") {
        return invalid(`${label} URL could not be validated safely.`);
      }
    }
  }
  return value;
}

async function validateSettingsUrls(
  settings: Record<string, unknown>,
  rejectAuthQueryParams = true,
): Promise<void> {
  for (const path of URL_KEYS) {
    const value = getNested(settings, path);
    const label = path.split(".")[0];
    await validateBaseUrl(
      value,
      label,
      path === "ollama.baseUrl" || path === "openaiCompatible.baseUrl",
      rejectAuthQueryParams,
    );
  }
  for (const path of ["customProviders"] as const) {
    const configs = settings[path];
    if (!configs || typeof configs !== "object") continue;
    for (const [provider, config] of Object.entries(configs)) {
      if (config && typeof config === "object") {
        await validateBaseUrl(
          (config as Record<string, unknown>).baseUrl,
          `Custom provider ${provider}`,
          true,
          rejectAuthQueryParams,
        );
      }
    }
  }
  const jev = settings.jev as
    | { typesafe?: { baseUrl?: string }; openrouter?: { baseUrl?: string } }
    | undefined;
  for (const [label, value, expectedHost] of [
    ["TypeSafe", jev?.typesafe?.baseUrl, "api.typesafe.ai"],
    ["OpenRouter Jev", jev?.openrouter?.baseUrl, "openrouter.ai"],
  ] as const) {
    const checked = await validateBaseUrl(value, label, false, rejectAuthQueryParams);
    if (!checked) continue;
    const parsed = new URL(checked);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== expectedHost ||
      (parsed.port !== "" && parsed.port !== "443")
    ) {
      return invalid(`${label} must use the official HTTPS endpoint.`);
    }
  }
}

function cacheModels(
  provider:
    | "anthropic"
    | "bedrock"
    | "ollama"
    | "gemini"
    | "openrouter"
    | "openai"
    | "groq"
    | "xai"
    | "deepseek"
    | "kimi"
    | "pi"
    | "openai-compatible",
  models: unknown[],
  map: (model: Record<string, unknown>) => {
    key: string;
    displayName: string;
    description: string;
    contextLength?: number;
    size?: number;
  },
  extraSensitiveContext?: unknown,
): void {
  const safeModels = scrubResult(models, extraSensitiveContext) as unknown[];
  const cached = safeModels.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const mapped = map(item as Record<string, unknown>);
    return mapped.key ? [mapped] : [];
  });
  LLMProviderFactory.saveCachedModels(provider, cached);
}

function stringField(record: Record<string, unknown>, key: string, fallback = ""): string {
  return typeof record[key] === "string" ? (record[key] as string) : fallback;
}

function modelArgs(keySchema = OptionalString, urlSchema = OptionalString) {
  return (args: unknown[]) => parsePositional([keySchema, urlSchema], args, 2);
}

export function createBrowserSettingsDefinitions(): BrowserDesktopDefinitions {
  const definitions: BrowserDesktopDefinitions = {
    getLLMConfigStatus: define(() => redactSecrets(LLMProviderFactory.getConfigStatus()), {
      capability: "providers.read",
      minArgs: 0,
      maxArgs: 0,
    }),
    getLLMSettings: define(
      () => redactSecrets(redactSettingsUrlQueries(LLMProviderFactory.loadSettings())),
      {
        capability: "providers.read",
        minArgs: 0,
        maxArgs: 0,
      },
    ),
    getProviderModels: define(
      (args) => {
        const providerType = args[0] as (typeof LLM_PROVIDER_TYPES)[number];
        const settings = LLMProviderFactory.loadSettings();
        return scrubResult(
          LLMProviderFactory.getProviderModelStatus({ ...settings, providerType }).models,
          settings,
        );
      },
      {
        capability: "providers.read",
        minArgs: 1,
        maxArgs: 1,
        validate: (args) => parseArgs(LLMProviderTypeSchema, args),
      },
    ),
    saveLLMSettings: define(
      async (args) => {
        const incoming = LLMSettingsSchema.parse(args[0]) as LLMSettingsData;
        await validateSettingsUrls(incoming as unknown as Record<string, unknown>);
        const existing = LLMProviderFactory.loadSettings();
        const restoredUrls = restoreSettingsUrlQueryCredentials(incoming, existing);
        const mergedInput = secretAwareMerge(restoredUrls, existing) as LLMSettingsData;
        const merged = buildSavedLLMSettings(mergedInput, existing as unknown as LLMSettingsData);
        LLMProviderFactory.saveSettings(merged as never);
        return { success: true };
      },
      {
        capability: "providers.configure",
        mutation: true,
        minArgs: 1,
        maxArgs: 1,
        validate: (args) => parseArgs(LLMSettingsSchema, args),
      },
    ),
    resetLLMProviderCredentials: define(
      (args) => {
        const providerType = args[0] as (typeof LLM_PROVIDER_TYPES)[number];
        const settings = LLMProviderFactory.loadSettings();
        const next = { ...settings };
        switch (providerType) {
          case "anthropic":
            next.anthropic = undefined;
            next.cachedAnthropicModels = undefined;
            break;
          case "bedrock":
            next.bedrock = undefined;
            next.cachedBedrockModels = undefined;
            break;
          case "ollama":
            next.ollama = undefined;
            next.cachedOllamaModels = undefined;
            break;
          case "gemini":
            next.gemini = undefined;
            next.cachedGeminiModels = undefined;
            break;
          case "openrouter":
            next.openrouter = undefined;
            next.cachedOpenRouterModels = undefined;
            break;
          case "openai":
            next.openai = undefined;
            next.cachedOpenAIModels = undefined;
            break;
          case "azure":
            next.azure = undefined;
            break;
          case "azure-anthropic":
            next.azureAnthropic = undefined;
            break;
          case "groq":
            next.groq = undefined;
            next.cachedGroqModels = undefined;
            break;
          case "xai":
            next.xai = undefined;
            next.cachedXaiModels = undefined;
            break;
          case "xai-oauth":
            next.xai = {
              ...next.xai,
              accessToken: undefined,
              refreshToken: undefined,
              tokenExpiresAt: undefined,
              tokenEndpoint: undefined,
              idToken: undefined,
              authMethod: undefined,
            };
            next.cachedXaiModels = undefined;
            break;
          case "deepseek":
            next.deepseek = undefined;
            next.cachedDeepSeekModels = undefined;
            break;
          case "kimi":
            next.kimi = undefined;
            next.cachedKimiModels = undefined;
            break;
          case "pi":
            next.pi = undefined;
            next.cachedPiModels = undefined;
            break;
          case "openai-compatible":
            next.openaiCompatible = undefined;
            next.cachedOpenAICompatibleModels = undefined;
            break;
          case "moa":
            next.moa = undefined;
            break;
          case "atomic-chat":
            {
              const customProviders = { ...next.customProviders };
              delete customProviders["atomic-chat"];
              next.customProviders =
                Object.keys(customProviders).length > 0 ? customProviders : undefined;
            }
            break;
          default: {
            const customProviders = { ...next.customProviders };
            delete customProviders[providerType];
            if (providerType === "kimi-code") delete customProviders["kimi-coding"];
            next.customProviders =
              Object.keys(customProviders).length > 0 ? customProviders : undefined;
          }
        }
        LLMProviderFactory.saveSettings(next);
        LLMProviderFactory.clearCache();
        return { success: true };
      },
      {
        capability: "providers.configure",
        mutation: true,
        minArgs: 1,
        maxArgs: 1,
        validate: (args) => parseArgs(LLMProviderTypeSchema, args),
      },
    ),
    setLLMModel: define(
      (args) => {
        const selection = args[0] as
          | string
          | {
              providerType?: (typeof LLM_PROVIDER_TYPES)[number];
              modelKey: string;
              reasoningEffort?: string;
            };
        const settings = LLMProviderFactory.loadSettings();
        const modelKey =
          typeof selection === "string" ? selection.trim() : selection.modelKey.trim();
        const providerType =
          typeof selection === "string"
            ? settings.providerType
            : selection.providerType || settings.providerType;
        let updated = LLMProviderFactory.applyModelSelection(settings, modelKey, providerType);
        if (typeof selection !== "string" && selection.reasoningEffort) {
          updated = LLMProviderFactory.applyReasoningEffortSelection(
            updated,
            providerType,
            selection.reasoningEffort as never,
          );
        }
        LLMProviderFactory.saveSettings(updated);
        return { success: true };
      },
      {
        capability: "providers.configure",
        mutation: true,
        minArgs: 1,
        maxArgs: 1,
        validate: (args) => parseArgs(ModelSelectionSchema, args),
      },
    ),
    getAnthropicModels: define(
      async (args) => {
        const models = await LLMProviderFactory.getAnthropicModels(args[0] as never);
        cacheModels(
          "anthropic",
          models,
          (model) => ({
            key: stringField(model, "id"),
            displayName: stringField(model, "displayName"),
            description: stringField(model, "description"),
          }),
          args[0],
        );
        return scrubResult(models, args[0]);
      },
      {
        capability: "providers.read",
        mutation: true,
        minArgs: 0,
        maxArgs: 1,
        validate: (args) =>
          args.length === 0
            ? []
            : parseArgs(
                z.object({
                  apiKey: OptionalString,
                  subscriptionToken: OptionalString,
                  authMethod: z.enum(["api_key", "subscription"]).optional(),
                }),
                args,
              ),
      },
    ),
    getBedrockModels: define(
      async (args) => {
        const config = args[0] as Record<string, unknown> | undefined;
        const models = await LLMProviderFactory.getBedrockModels(config as never);
        cacheModels(
          "bedrock",
          models,
          (model) => ({
            key: stringField(model, "id"),
            displayName: stringField(model, "name"),
            description: stringField(model, "description"),
          }),
          config,
        );
        return scrubResult(models, config);
      },
      {
        capability: "providers.read",
        mutation: true,
        minArgs: 0,
        maxArgs: 1,
        validate: (args) =>
          args.length === 0
            ? []
            : parseArgs(
                z.object({
                  region: z.string().max(100).optional(),
                  accessKeyId: OptionalString,
                  secretAccessKey: OptionalString,
                  profile: z.string().max(200).optional(),
                }),
                args,
              ),
      },
    ),
    getOllamaModels: define(
      async (args) => {
        const baseUrl = await validateBaseUrl(args[0], "Ollama", true);
        const models = await LLMProviderFactory.getOllamaModels(baseUrl);
        cacheModels("ollama", models, (model) => ({
          key: stringField(model, "name"),
          displayName: stringField(model, "name"),
          description: `${Math.round(Number(model.size || 0) / 1e9)}B parameter model`,
          size: Number(model.size || 0),
        }));
        return scrubResult(models);
      },
      {
        capability: "providers.read",
        mutation: true,
        minArgs: 0,
        maxArgs: 1,
        validate: (args) => parseArgs(OptionalString, args, true),
      },
    ),
    getGeminiModels: define(
      async (args) => {
        const models = await LLMProviderFactory.getGeminiModels(args[0] as string | undefined);
        cacheModels(
          "gemini",
          models,
          (model) => ({
            key: stringField(model, "name"),
            displayName: stringField(model, "displayName"),
            description: stringField(model, "description"),
          }),
          { apiKey: args[0] },
        );
        return scrubResult(models, { apiKey: args[0] });
      },
      {
        capability: "providers.read",
        mutation: true,
        minArgs: 0,
        maxArgs: 1,
        validate: (args) => parseArgs(OptionalString, args, true),
      },
    ),
    getOpenRouterModels: define(
      async (args) => {
        const baseUrl = await validateBaseUrl(args[1], "OpenRouter");
        const models = await LLMProviderFactory.getOpenRouterModels(
          args[0] as string | undefined,
          baseUrl,
        );
        cacheModels(
          "openrouter",
          models,
          (model) => ({
            key: stringField(model, "id"),
            displayName: stringField(model, "name"),
            description: `Context: ${Math.round(Number(model.context_length || 0) / 1000)}k tokens`,
            contextLength: Number(model.context_length || 0),
          }),
          { apiKey: args[0] },
        );
        return scrubResult(models, { apiKey: args[0] });
      },
      {
        capability: "providers.read",
        mutation: true,
        minArgs: 0,
        maxArgs: 2,
        validate: modelArgs(),
      },
    ),
    getOpenRouterImageModels: define(
      async (args) =>
        scrubResult(
          await LLMProviderFactory.getOpenRouterImageModels(
            args[0] as string | undefined,
            await validateBaseUrl(args[1], "OpenRouter"),
          ),
          { apiKey: args[0] },
        ),
      {
        capability: "providers.read",
        mutation: true,
        minArgs: 0,
        maxArgs: 2,
        validate: modelArgs(),
      },
    ),
    getOpenAIModels: define(
      async (args) => {
        const models = await LLMProviderFactory.getOpenAIModels(args[0] as string | undefined);
        cacheModels(
          "openai",
          models,
          (model) => ({
            key: stringField(model, "id"),
            displayName: stringField(model, "name"),
            description: stringField(model, "description"),
          }),
          { apiKey: args[0] },
        );
        return scrubResult(models, { apiKey: args[0] });
      },
      {
        capability: "providers.read",
        mutation: true,
        minArgs: 0,
        maxArgs: 1,
        validate: (args) => parseArgs(OptionalString, args, true),
      },
    ),
    getGroqModels: define(
      async (args) => {
        const models = await LLMProviderFactory.getGroqModels(
          args[0] as string | undefined,
          await validateBaseUrl(args[1], "Groq"),
        );
        cacheModels(
          "groq",
          models,
          (model) => ({
            key: stringField(model, "id"),
            displayName: stringField(model, "name"),
            description: "Groq model",
          }),
          { apiKey: args[0] },
        );
        return scrubResult(models, { apiKey: args[0] });
      },
      {
        capability: "providers.read",
        mutation: true,
        minArgs: 0,
        maxArgs: 2,
        validate: modelArgs(),
      },
    ),
    getXAIModels: define(
      async (args) => {
        const models = await LLMProviderFactory.getXAIModels(
          args[0] as string | undefined,
          await validateBaseUrl(args[1], "xAI"),
        );
        cacheModels(
          "xai",
          models,
          (model) => ({
            key: stringField(model, "id"),
            displayName: stringField(model, "name"),
            description: "xAI model",
          }),
          { apiKey: args[0] },
        );
        return scrubResult(models, { apiKey: args[0] });
      },
      {
        capability: "providers.read",
        mutation: true,
        minArgs: 0,
        maxArgs: 2,
        validate: modelArgs(),
      },
    ),
    getDeepSeekModels: define(
      async (args) => {
        const models = await LLMProviderFactory.getDeepSeekModels(
          args[0] as string | undefined,
          await validateBaseUrl(args[1], "DeepSeek"),
        );
        cacheModels(
          "deepseek",
          models,
          (model) => ({
            key: stringField(model, "id"),
            displayName: stringField(model, "name"),
            description: "DeepSeek model",
          }),
          { apiKey: args[0] },
        );
        return scrubResult(models, { apiKey: args[0] });
      },
      {
        capability: "providers.read",
        mutation: true,
        minArgs: 0,
        maxArgs: 2,
        validate: modelArgs(),
      },
    ),
    getKimiModels: define(
      async (args) => {
        const models = await LLMProviderFactory.getKimiModels(
          args[0] as string | undefined,
          await validateBaseUrl(args[1], "Kimi"),
        );
        cacheModels(
          "kimi",
          models,
          (model) => ({
            key: stringField(model, "id"),
            displayName: stringField(model, "name"),
            description: "Kimi model",
          }),
          { apiKey: args[0] },
        );
        return scrubResult(models, { apiKey: args[0] });
      },
      {
        capability: "providers.read",
        mutation: true,
        minArgs: 0,
        maxArgs: 2,
        validate: modelArgs(),
      },
    ),
    getPiModels: define(
      async (args) => {
        const models = await LLMProviderFactory.getPiModels(args[0] as string | undefined);
        cacheModels("pi", models, (model) => ({
          key: stringField(model, "id"),
          displayName: stringField(model, "name"),
          description: stringField(model, "description"),
        }));
        return scrubResult(models);
      },
      {
        capability: "providers.read",
        mutation: true,
        minArgs: 0,
        maxArgs: 1,
        validate: (args) => parseArgs(z.string().max(200).optional(), args, true),
      },
    ),
    getPiProviders: define(() => LLMProviderFactory.getPiProviders(), {
      capability: "providers.read",
      minArgs: 0,
      maxArgs: 0,
    }),
    getOpenAICompatibleModels: define(
      async (args) => {
        const baseUrl = await validateBaseUrl(args[0], "OpenAI-compatible provider", true);
        if (!baseUrl) return invalid("A provider base URL is required.");
        const models = await LLMProviderFactory.getOpenAICompatibleModels(
          baseUrl,
          args[1] as string | undefined,
        );
        cacheModels(
          "openai-compatible",
          models,
          (model) => ({
            key: stringField(model, "key"),
            displayName: stringField(model, "displayName"),
            description: stringField(model, "description"),
          }),
          { apiKey: args[1] },
        );
        return scrubResult(models, { apiKey: args[1] });
      },
      {
        capability: "providers.read",
        mutation: true,
        minArgs: 1,
        maxArgs: 2,
        validate: (args) => parsePositional([NonEmptyString, OptionalString], args, 1),
      },
    ),
    refreshCustomProviderModels: define(
      async (args) => {
        const providerType = args[0] as string;
        const overrides = args[1] as { apiKey?: string; baseUrl?: string } | undefined;
        const knownProvider = LLMProviderFactory.getConfigStatus().providers.some(
          (entry) => entry.type === providerType,
        );
        if (!knownProvider) return invalid("Unknown provider type.");
        const validated = overrides
          ? {
              ...overrides,
              baseUrl: await validateBaseUrl(
                overrides.baseUrl,
                `Custom provider ${providerType}`,
                true,
              ),
            }
          : undefined;
        return scrubResult(
          await LLMProviderFactory.getCustomProviderModels(providerType as never, validated),
          validated,
        );
      },
      {
        capability: "providers.read",
        mutation: true,
        minArgs: 1,
        maxArgs: 2,
        validate: (args) =>
          parsePositional(
            [
              NonEmptyString,
              z
                .object({ apiKey: OptionalString, baseUrl: z.string().max(500).optional() })
                .optional(),
            ],
            args,
            1,
          ),
      },
    ),
    discoverAtomicChatModels: define(
      async (args) => {
        const overrides = args[0] as { apiKey?: string; baseUrl?: string } | undefined;
        const validated = overrides
          ? { ...overrides, baseUrl: await validateBaseUrl(overrides.baseUrl, "Atomic Chat", true) }
          : undefined;
        return scrubResult(
          await LLMProviderFactory.getAtomicChatModelsDetailed(validated),
          validated,
        );
      },
      {
        capability: "providers.read",
        mutation: true,
        minArgs: 0,
        maxArgs: 1,
        validate: (args) =>
          args.length === 0
            ? []
            : parseArgs(
                z.object({ apiKey: OptionalString, baseUrl: z.string().max(500).optional() }),
                args,
              ),
      },
    ),
    testLLMProvider: define(
      async (args) => {
        const incoming = LLMSettingsSchema.parse(args[0]) as LLMSettingsData;
        await validateSettingsUrls(incoming as unknown as Record<string, unknown>);
        const saved = LLMProviderFactory.loadSettings();
        const effective = secretAwareMerge(
          restoreSettingsUrlQueryCredentials(incoming, saved),
          saved,
        ) as LLMSettingsData;
        // Provider tests use the same host-side credentials and model resolution as a local save,
        // while they never persist this draft.
        await validateSettingsUrls(effective as unknown as Record<string, unknown>, false);
        const providerType = effective.providerType;
        const resolvedModel = LLMProviderFactory.getModelId(
          effective.modelKey as never,
          providerType,
          effective.ollama?.model,
          effective.gemini?.model,
          effective.openrouter?.model,
          effective.deepseek?.model,
          effective.openai?.model,
          effective.azure?.deployment || effective.azure?.deployments?.[0],
          effective.azureAnthropic?.deployment || effective.azureAnthropic?.deployments?.[0],
          effective.groq?.model,
          effective.xai?.model,
          effective.kimi?.model,
          effective.customProviders,
          effective.bedrock?.model,
        );
        const providerConfig = {
          type: providerType,
          model: resolvedModel,
          anthropicApiKey:
            effective.anthropic?.authMethod === "subscription"
              ? effective.anthropic.subscriptionToken || effective.anthropic.apiKey
              : effective.anthropic?.apiKey || effective.anthropic?.subscriptionToken,
          awsRegion: effective.bedrock?.region,
          awsAccessKeyId: effective.bedrock?.accessKeyId,
          awsSecretAccessKey: effective.bedrock?.secretAccessKey,
          awsSessionToken: effective.bedrock?.sessionToken,
          awsProfile: effective.bedrock?.profile,
          ollamaBaseUrl: effective.ollama?.baseUrl,
          ollamaApiKey: effective.ollama?.apiKey,
          geminiApiKey: effective.gemini?.apiKey,
          openrouterApiKey: effective.openrouter?.apiKey,
          openrouterBaseUrl: effective.openrouter?.baseUrl,
          openaiApiKey: effective.openai?.apiKey,
          azureApiKey: effective.azure?.apiKey,
          azureEndpoint: effective.azure?.endpoint,
          azureDeployment: effective.azure?.deployment || effective.azure?.deployments?.[0],
          azureApiVersion: effective.azure?.apiVersion,
          azureReasoningEffort: effective.azure?.reasoningEffort,
          azureAnthropicApiKey: effective.azureAnthropic?.apiKey,
          azureAnthropicEndpoint: effective.azureAnthropic?.endpoint,
          azureAnthropicDeployment:
            effective.azureAnthropic?.deployment || effective.azureAnthropic?.deployments?.[0],
          azureAnthropicApiVersion: effective.azureAnthropic?.apiVersion,
          groqApiKey: effective.groq?.apiKey,
          groqBaseUrl: effective.groq?.baseUrl,
          xaiApiKey: effective.xai?.apiKey,
          xaiBaseUrl: effective.xai?.baseUrl,
          kimiApiKey: effective.kimi?.apiKey,
          kimiBaseUrl: effective.kimi?.baseUrl,
          deepseekApiKey: effective.deepseek?.apiKey,
          deepseekBaseUrl: effective.deepseek?.baseUrl,
          openaiCompatibleApiKey: effective.openaiCompatible?.apiKey,
          openaiCompatibleBaseUrl: effective.openaiCompatible?.baseUrl,
          moaDefaultPreset: effective.moa?.defaultPreset,
          moaPresets: effective.moa?.presets,
          providerApiKey: effective.customProviders?.[providerType]?.apiKey,
          providerBaseUrl: effective.customProviders?.[providerType]?.baseUrl,
        };
        return scrubResult(
          await LLMProviderFactory.testProvider(providerConfig as never),
          effective,
        );
      },
      {
        capability: "providers.read",
        mutation: true,
        minArgs: 1,
        maxArgs: 1,
        validate: (args) => parseArgs(LLMSettingsSchema, args),
      },
    ),
    testJevProvider: define(
      async (args) => {
        const request = JevTestProviderRequestSchema.parse(args[0]);
        const saved = LLMProviderFactory.loadSettings();
        const savedJev = saved.jev;
        for (const [label, url] of [
          ["TypeSafe", request.settings.typesafe?.baseUrl],
          ["OpenRouter", request.settings.openrouter?.baseUrl],
        ] as const) {
          await validateBaseUrl(url, label);
        }
        const tested = restoreSettingsUrlQueryCredentials(request.settings, savedJev);
        const settings = {
          ...savedJev,
          ...tested,
          typesafe: {
            ...savedJev?.typesafe,
            ...tested.typesafe,
            apiKey: tested.typesafe?.apiKey?.trim() || savedJev?.typesafe?.apiKey,
          },
          openrouter: {
            ...savedJev?.openrouter,
            ...tested.openrouter,
            apiKey:
              tested.openrouter?.apiKey?.trim() ||
              (tested.openrouter?.reuseOpenRouterKey ? undefined : savedJev?.openrouter?.apiKey),
          },
        };
        for (const [label, url] of [
          ["TypeSafe", settings.typesafe?.baseUrl],
          ["OpenRouter", settings.openrouter?.baseUrl],
        ] as const) {
          if (!url) continue;
          const validated = await validateBaseUrl(url, label, false, false);
          const parsed = new URL(validated!);
          const expectedHost = label === "TypeSafe" ? "api.typesafe.ai" : "openrouter.ai";
          if (
            parsed.protocol !== "https:" ||
            parsed.hostname !== expectedHost ||
            (parsed.port && parsed.port !== "443")
          )
            return invalid(`${label} Jev URL must use the official HTTPS endpoint.`);
        }
        return scrubResult(
          await testJevProvider(settings, request.mainOpenRouterApiKey || saved.openrouter?.apiKey),
          { saved, request },
        );
      },
      {
        capability: "providers.read",
        mutation: true,
        minArgs: 1,
        maxArgs: 1,
        validate: (args) => parseArgs(JevTestProviderRequestSchema, args),
      },
    ),
    getPermissionSettings: define(
      () => {
        const settings = PermissionSettingsManager.loadSettings();
        return {
          defaultAccessProfileId: settings.defaultAccessProfileId,
          accessProfiles: (settings.accessProfiles || []).map((profile) => ({
            id: profile.id,
            label: profile.label,
            description: profile.description,
            sandbox: profile.sandbox,
            approval: profile.approval,
            reviewer: profile.reviewer,
            network: profile.network,
            extends: profile.extends,
          })),
        };
      },
      { capability: "agents.manage", minArgs: 0, maxArgs: 0 },
    ),
    getMCPSettings: define(
      () => {
        const settings = MCPSettingsManager.getSettingsForDisplay();
        return {
          storageStatus: settings.storageStatus,
          servers: settings.servers.map((server) => ({
            id: server.id,
            name: server.name,
            description: server.description,
            enabled: server.enabled,
            transport: server.transport,
            registryId: server.registryId,
          })),
        };
      },
      { capability: "agents.manage", minArgs: 0, maxArgs: 0 },
    ),
    getPersonalitySettings: define(() => redactSecrets(PersonalityManager.loadSettings()), {
      capability: "agents.manage",
      minArgs: 0,
      maxArgs: 0,
    }),
    savePersonalitySettings: define(
      (args) => {
        const settings = PersonalitySettingsSchema.safeParse(args[0]);
        if (!settings.success) return invalid();
        PersonalityManager.saveSettings(settings.data as never);
        return { success: true };
      },
      {
        capability: "agents.manage",
        mutation: true,
        minArgs: 1,
        maxArgs: 1,
        validate: (args) => parseArgs(PersonalitySettingsSchema, args),
      },
    ),
    getLLMRoutingStatus: define(
      () => RuntimeVisibilityService.buildRoutingState(LLMProviderFactory.loadSettings()),
      {
        capability: "agents.manage",
        maxArgs: 0,
      },
    ),
    getRelationshipStats: define(() => PersonalityManager.getRelationshipStats(), {
      capability: "agents.manage",
      maxArgs: 0,
    }),
    getPersonalityConfigV2: define(() => redactSecrets(PersonalityManager.loadConfigV2()), {
      capability: "agents.manage",
      minArgs: 0,
      maxArgs: 0,
    }),
    savePersonalityConfigV2: define(
      (args) => {
        const config = PersonalityConfigV2Schema.parse(args[0]);
        PersonalityManager.saveConfigV2({ ...config, version: 2 } as never);
        return { success: true };
      },
      {
        capability: "agents.manage",
        mutation: true,
        minArgs: 1,
        maxArgs: 1,
        validate: (args) => parseArgs(PersonalityConfigV2Schema, args),
      },
    ),
    getPersonalityDefinitions: define(() => PersonalityManager.getDefinitions(), {
      capability: "agents.manage",
      minArgs: 0,
      maxArgs: 0,
    }),
    getPersonaDefinitions: define(() => PersonalityManager.getPersonaDefinitions(), {
      capability: "agents.manage",
      minArgs: 0,
      maxArgs: 0,
    }),
    getPersonalityTraitPresets: define(() => PersonalityManager.getTraitPresets(), {
      capability: "agents.manage",
      minArgs: 0,
      maxArgs: 0,
    }),
    setActivePersonality: define(
      (args) => {
        PersonalityManager.setActivePersonality(args[0] as never);
        return { success: true };
      },
      {
        capability: "agents.manage",
        mutation: true,
        minArgs: 1,
        maxArgs: 1,
        validate: (args) =>
          parseArgs(
            z.enum([
              "professional",
              "friendly",
              "concise",
              "creative",
              "technical",
              "casual",
              "custom",
            ]),
            args,
          ),
      },
    ),
    setActivePersona: define(
      (args) => {
        PersonalityManager.setActivePersona(args[0] as never);
        return { success: true };
      },
      {
        capability: "agents.manage",
        mutation: true,
        minArgs: 1,
        maxArgs: 1,
        validate: (args) =>
          parseArgs(
            z.enum([
              "none",
              "jarvis",
              "friday",
              "hal",
              "computer",
              "alfred",
              "intern",
              "sensei",
              "pirate",
              "noir",
              "companion",
            ]),
            args,
          ),
      },
    ),
  };

  return definitions;
}
