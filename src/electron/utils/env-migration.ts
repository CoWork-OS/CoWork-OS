/**
 * Migration utility for users upgrading from .env-based configuration
 * to GUI Settings with secure storage.
 *
 * This runs once on app startup and:
 * 1. Detects if a .env file exists in the app directory
 * 2. Reads any configured credentials
 * 3. Migrates them to the new Settings system (with safeStorage encryption)
 * 4. Renames the .env file to .env.migrated to prevent re-migration
 * 5. Returns a summary for the user notification
 */

import * as fs from "fs";
import * as path from "path";
import { LLMProviderFactory, type LLMProviderType } from "../agent/llm";
import { SearchProviderFactory } from "../agent/search";
import { getUserDataDir } from "./user-data-dir";

export interface MigrationResult {
  migrated: boolean;
  migratedKeys: string[];
  error?: string;
}

export type EnvSettingsImportMode = "merge" | "overwrite";

export interface ImportProcessEnvOptions {
  mode?: EnvSettingsImportMode;
}

function getElectronAppPath(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
// oxlint-disable-next-line typescript-eslint(no-require-imports)
    const electron = require("electron") as Any;
    const app = electron?.app;
    if (app && typeof app.getAppPath === "function") {
      return app.getAppPath();
    }
  } catch {
    // Not running under Electron.
  }
  return null;
}

function normalizeEnvValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function shouldWriteValue(
  existing: unknown,
  next: string | undefined,
  mode: EnvSettingsImportMode,
): boolean {
  if (!next) return false;
  if (mode === "overwrite") return true;
  const existingNorm = normalizeEnvValue(existing);
  return !existingNorm;
}

function isProviderConfigured(providerType: LLMProviderType, settings: Any): boolean {
  switch (providerType) {
    case "anthropic":
      return !!normalizeEnvValue(settings?.anthropic?.apiKey);
    case "openai":
      return !!(
        normalizeEnvValue(settings?.openai?.apiKey) ||
        normalizeEnvValue(settings?.openai?.accessToken)
      );
    case "gemini":
      return !!normalizeEnvValue(settings?.gemini?.apiKey);
    case "openrouter":
      return !!normalizeEnvValue(settings?.openrouter?.apiKey);
    case "azure": {
      const hasKey = !!normalizeEnvValue(settings?.azure?.apiKey);
      const hasEndpoint = !!normalizeEnvValue(settings?.azure?.endpoint);
      const hasDeployment =
        !!normalizeEnvValue(settings?.azure?.deployment) ||
        (Array.isArray(settings?.azure?.deployments) && settings.azure.deployments.length > 0);
      return hasKey && hasEndpoint && hasDeployment;
    }
    case "groq":
      return !!normalizeEnvValue(settings?.groq?.apiKey);
    case "xai":
      return !!normalizeEnvValue(settings?.xai?.apiKey);
    case "kimi":
      return !!normalizeEnvValue(settings?.kimi?.apiKey);
    case "bedrock":
      return !!(
        normalizeEnvValue(settings?.bedrock?.accessKeyId) ||
        normalizeEnvValue(settings?.bedrock?.profile)
      );
    case "ollama":
      return !!(
        normalizeEnvValue(settings?.ollama?.baseUrl) || normalizeEnvValue(settings?.ollama?.model)
      );
    case "pi":
      return !!(
        normalizeEnvValue(settings?.pi?.apiKey) && normalizeEnvValue(settings?.pi?.provider)
      );
    default:
      return false;
  }
}

function pickProviderFromSettings(settings: Any): LLMProviderType | null {
  if (
    normalizeEnvValue(settings?.openai?.apiKey) ||
    normalizeEnvValue(settings?.openai?.accessToken)
  )
    return "openai";
  if (normalizeEnvValue(settings?.anthropic?.apiKey)) return "anthropic";
  if (normalizeEnvValue(settings?.gemini?.apiKey)) return "gemini";
  if (normalizeEnvValue(settings?.openrouter?.apiKey)) return "openrouter";
  if (
    normalizeEnvValue(settings?.azure?.apiKey) &&
    normalizeEnvValue(settings?.azure?.endpoint) &&
    (normalizeEnvValue(settings?.azure?.deployment) ||
      (Array.isArray(settings?.azure?.deployments) && settings.azure.deployments.length > 0))
  )
    return "azure";
  if (normalizeEnvValue(settings?.groq?.apiKey)) return "groq";
  if (normalizeEnvValue(settings?.xai?.apiKey)) return "xai";
  if (normalizeEnvValue(settings?.kimi?.apiKey)) return "kimi";
  if (
    normalizeEnvValue(settings?.bedrock?.accessKeyId) ||
    normalizeEnvValue(settings?.bedrock?.profile)
  )
    return "bedrock";
  if (normalizeEnvValue(settings?.ollama?.baseUrl) || normalizeEnvValue(settings?.ollama?.model))
    return "ollama";
  if (normalizeEnvValue(settings?.pi?.apiKey) && normalizeEnvValue(settings?.pi?.provider))
    return "pi";
  return null;
}

function validateProviderType(raw: string | undefined): LLMProviderType | null {
  const provider = normalizeEnvValue(raw)?.toLowerCase();
  if (!provider) return null;

  const allowed: ReadonlySet<string> = new Set([
    "anthropic",
    "bedrock",
    "ollama",
    "gemini",
    "openrouter",
    "openai",
    "azure",
    "groq",
    "xai",
    "kimi",
    "pi",
  ]);

  return allowed.has(provider) ? (provider as LLMProviderType) : null;
}

/**
 * Parse a .env file into key-value pairs
 */
function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split("\n");

  for (const line of lines) {
    // Skip empty lines and comments
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Parse KEY=VALUE (handle quoted values)
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Remove surrounding quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && value) {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Check for and migrate .env configuration to Settings
 */
export async function migrateEnvToSettings(): Promise<MigrationResult> {
  const migratedKeys: string[] = [];

  // Check multiple possible locations for .env
  const appPath = getElectronAppPath();
  const possiblePaths = [
    ...(appPath ? [path.join(appPath, ".env")] : []),
    path.join(process.cwd(), ".env"),
    path.join(getUserDataDir(), ".env"),
  ];

  let envPath: string | null = null;
  let envContent: string | null = null;

  for (const p of possiblePaths) {
    try {
      if (fs.existsSync(p)) {
        envContent = fs.readFileSync(p, "utf-8");
        envPath = p;
        break;
      }
    } catch {
      // Ignore read errors, try next path
    }
  }

  if (!envPath || !envContent) {
    return { migrated: false, migratedKeys: [] };
  }

  // Check if already migrated
  const migratedPath = envPath + ".migrated";
  if (fs.existsSync(migratedPath)) {
    return { migrated: false, migratedKeys: [] };
  }

  try {
    const env = parseEnvFile(envContent);

    // Load current settings
    const llmSettings = LLMProviderFactory.loadSettings();
    const searchSettings = SearchProviderFactory.loadSettings();
    let llmChanged = false;
    let searchChanged = false;

    // Migrate Anthropic API key
    if (env.ANTHROPIC_API_KEY && !llmSettings.anthropic?.apiKey) {
      llmSettings.anthropic = { ...llmSettings.anthropic, apiKey: env.ANTHROPIC_API_KEY };
      migratedKeys.push("Anthropic API Key");
      llmChanged = true;
    }

    // Migrate AWS Bedrock credentials
    if (env.AWS_ACCESS_KEY_ID && !llmSettings.bedrock?.accessKeyId) {
      llmSettings.bedrock = {
        ...llmSettings.bedrock,
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        sessionToken: env.AWS_SESSION_TOKEN,
        region: env.AWS_REGION || env.AWS_DEFAULT_REGION,
        profile: env.AWS_PROFILE,
      };
      migratedKeys.push("AWS Bedrock Credentials");
      llmChanged = true;
    }

    // Migrate Gemini API key
    if (env.GEMINI_API_KEY && !llmSettings.gemini?.apiKey) {
      llmSettings.gemini = { ...llmSettings.gemini, apiKey: env.GEMINI_API_KEY };
      migratedKeys.push("Gemini API Key");
      llmChanged = true;
    }

    // Migrate OpenRouter API key
    if (env.OPENROUTER_API_KEY && !llmSettings.openrouter?.apiKey) {
      llmSettings.openrouter = { ...llmSettings.openrouter, apiKey: env.OPENROUTER_API_KEY };
      migratedKeys.push("OpenRouter API Key");
      llmChanged = true;
    }

    // Migrate Groq API key
    if (env.GROQ_API_KEY && !llmSettings.groq?.apiKey) {
      llmSettings.groq = { ...llmSettings.groq, apiKey: env.GROQ_API_KEY };
      migratedKeys.push("Groq API Key");
      llmChanged = true;
    }

    // Migrate xAI API key
    if (env.XAI_API_KEY && !llmSettings.xai?.apiKey) {
      llmSettings.xai = { ...llmSettings.xai, apiKey: env.XAI_API_KEY };
      migratedKeys.push("xAI API Key");
      llmChanged = true;
    }

    // Migrate Kimi API key (Moonshot)
    const kimiApiKey = env.KIMI_API_KEY || env.MOONSHOT_API_KEY;
    if (kimiApiKey && !llmSettings.kimi?.apiKey) {
      llmSettings.kimi = { ...llmSettings.kimi, apiKey: kimiApiKey };
      migratedKeys.push("Kimi API Key");
      llmChanged = true;
    }

    // Migrate Ollama settings
    if (env.OLLAMA_BASE_URL && !llmSettings.ollama?.baseUrl) {
      llmSettings.ollama = {
        ...llmSettings.ollama,
        baseUrl: env.OLLAMA_BASE_URL,
        apiKey: env.OLLAMA_API_KEY,
      };
      migratedKeys.push("Ollama Configuration");
      llmChanged = true;
    }

    // Migrate Search API keys
    if (env.TAVILY_API_KEY && !searchSettings.tavily?.apiKey) {
      searchSettings.tavily = { apiKey: env.TAVILY_API_KEY };
      migratedKeys.push("Tavily API Key");
      searchChanged = true;
    }

    if (env.BRAVE_API_KEY && !searchSettings.brave?.apiKey) {
      searchSettings.brave = { apiKey: env.BRAVE_API_KEY };
      migratedKeys.push("Brave Search API Key");
      searchChanged = true;
    }

    if (env.SERPAPI_API_KEY && !searchSettings.serpapi?.apiKey) {
      searchSettings.serpapi = { apiKey: env.SERPAPI_API_KEY };
      migratedKeys.push("SerpAPI Key");
      searchChanged = true;
    }

    if (env.GOOGLE_API_KEY && !searchSettings.google?.apiKey) {
      searchSettings.google = {
        apiKey: env.GOOGLE_API_KEY,
        searchEngineId: env.GOOGLE_SEARCH_ENGINE_ID,
      };
      migratedKeys.push("Google Search API Key");
      searchChanged = true;
    }

    // Save migrated settings
    if (llmChanged) {
      LLMProviderFactory.saveSettings(llmSettings);
    }
    if (searchChanged) {
      SearchProviderFactory.saveSettings(searchSettings);
    }

    // Rename .env to .env.migrated to prevent re-migration
    if (migratedKeys.length > 0) {
      fs.renameSync(envPath, migratedPath);
    }

    return {
      migrated: migratedKeys.length > 0,
      migratedKeys,
    };
  } catch (error: Any) {
    return {
      migrated: false,
      migratedKeys: [],
      error: error.message,
    };
  }
}

/**
 * Import provider credentials from process.env into secure Settings.
 *
 * This is intentionally opt-in (use COWORK_IMPORT_ENV_SETTINGS / --import-env-settings),
 * since environment variables are a weaker secret boundary than Secure Settings.
 *
 * Merge mode (default): only fills missing settings fields.
 * Overwrite mode: replaces settings fields when corresponding env vars are set.
 *
 * Also supports selecting the active LLM provider with:
 * - COWORK_LLM_PROVIDER=openai|anthropic|...
 */
export async function importProcessEnvToSettings(
  options: ImportProcessEnvOptions = {},
): Promise<MigrationResult> {
  const migratedKeys: string[] = [];
  const mode: EnvSettingsImportMode = options.mode || "merge";

  try {
    // Load current settings
    const llmSettings = LLMProviderFactory.loadSettings() as Any;
    const searchSettings = SearchProviderFactory.loadSettings() as Any;
    const originalProviderType: LLMProviderType | undefined = llmSettings?.providerType;
    let llmChanged = false;
    let searchChanged = false;

    // LLM provider keys
    const openaiApiKey = normalizeEnvValue(process.env.OPENAI_API_KEY);
    if (shouldWriteValue(llmSettings?.openai?.apiKey, openaiApiKey, mode)) {
      llmSettings.openai = {
        ...llmSettings.openai,
        apiKey: openaiApiKey,
        authMethod: "api_key",
      };
      migratedKeys.push("OpenAI API Key");
      llmChanged = true;
    }

    const anthropicApiKey = normalizeEnvValue(process.env.ANTHROPIC_API_KEY);
    if (shouldWriteValue(llmSettings?.anthropic?.apiKey, anthropicApiKey, mode)) {
      llmSettings.anthropic = { ...llmSettings.anthropic, apiKey: anthropicApiKey };
      migratedKeys.push("Anthropic API Key");
      llmChanged = true;
    }

    // AWS Bedrock credentials
    const awsAccessKeyId = normalizeEnvValue(process.env.AWS_ACCESS_KEY_ID);
    const awsSecretAccessKey = normalizeEnvValue(process.env.AWS_SECRET_ACCESS_KEY);
    const awsSessionToken = normalizeEnvValue(process.env.AWS_SESSION_TOKEN);
    const awsRegion =
      normalizeEnvValue(process.env.AWS_REGION) ||
      normalizeEnvValue(process.env.AWS_DEFAULT_REGION);
    const awsProfile = normalizeEnvValue(process.env.AWS_PROFILE);
    const shouldWriteBedrock =
      shouldWriteValue(llmSettings?.bedrock?.accessKeyId, awsAccessKeyId, mode) ||
      shouldWriteValue(llmSettings?.bedrock?.secretAccessKey, awsSecretAccessKey, mode) ||
      shouldWriteValue(llmSettings?.bedrock?.sessionToken, awsSessionToken, mode) ||
      shouldWriteValue(llmSettings?.bedrock?.region, awsRegion, mode) ||
      shouldWriteValue(llmSettings?.bedrock?.profile, awsProfile, mode);
    if (
      shouldWriteBedrock &&
      (awsAccessKeyId || awsSecretAccessKey || awsSessionToken || awsRegion || awsProfile)
    ) {
      llmSettings.bedrock = {
        ...llmSettings.bedrock,
        ...(awsAccessKeyId ? { accessKeyId: awsAccessKeyId } : {}),
        ...(awsSecretAccessKey ? { secretAccessKey: awsSecretAccessKey } : {}),
        ...(awsSessionToken ? { sessionToken: awsSessionToken } : {}),
        ...(awsRegion ? { region: awsRegion } : {}),
        ...(awsProfile ? { profile: awsProfile } : {}),
      };
      migratedKeys.push("AWS Bedrock Credentials");
      llmChanged = true;
    }

    const geminiApiKey =
      normalizeEnvValue(process.env.GEMINI_API_KEY) ||
      normalizeEnvValue(process.env.GOOGLE_GENERATIVE_AI_API_KEY);
    if (shouldWriteValue(llmSettings?.gemini?.apiKey, geminiApiKey, mode)) {
      llmSettings.gemini = { ...llmSettings.gemini, apiKey: geminiApiKey };
      migratedKeys.push("Gemini API Key");
      llmChanged = true;
    }

    const openrouterApiKey = normalizeEnvValue(process.env.OPENROUTER_API_KEY);
    if (shouldWriteValue(llmSettings?.openrouter?.apiKey, openrouterApiKey, mode)) {
      llmSettings.openrouter = { ...llmSettings.openrouter, apiKey: openrouterApiKey };
      migratedKeys.push("OpenRouter API Key");
      llmChanged = true;
    }

    const groqApiKey = normalizeEnvValue(process.env.GROQ_API_KEY);
    if (shouldWriteValue(llmSettings?.groq?.apiKey, groqApiKey, mode)) {
      llmSettings.groq = { ...llmSettings.groq, apiKey: groqApiKey };
      migratedKeys.push("Groq API Key");
      llmChanged = true;
    }

    const xaiApiKey = normalizeEnvValue(process.env.XAI_API_KEY);
    if (shouldWriteValue(llmSettings?.xai?.apiKey, xaiApiKey, mode)) {
      llmSettings.xai = { ...llmSettings.xai, apiKey: xaiApiKey };
      migratedKeys.push("xAI API Key");
      llmChanged = true;
    }

    const kimiApiKey =
      normalizeEnvValue(process.env.KIMI_API_KEY) ||
      normalizeEnvValue(process.env.MOONSHOT_API_KEY);
    if (shouldWriteValue(llmSettings?.kimi?.apiKey, kimiApiKey, mode)) {
      llmSettings.kimi = { ...llmSettings.kimi, apiKey: kimiApiKey };
      migratedKeys.push("Kimi API Key");
      llmChanged = true;
    }

    const ollamaBaseUrl = normalizeEnvValue(process.env.OLLAMA_BASE_URL);
    const ollamaApiKey = normalizeEnvValue(process.env.OLLAMA_API_KEY);
    const ollamaModel = normalizeEnvValue(process.env.OLLAMA_MODEL);
    const shouldWriteOllama =
      shouldWriteValue(llmSettings?.ollama?.baseUrl, ollamaBaseUrl, mode) ||
      shouldWriteValue(llmSettings?.ollama?.apiKey, ollamaApiKey, mode) ||
      shouldWriteValue(llmSettings?.ollama?.model, ollamaModel, mode);
    if (shouldWriteOllama && (ollamaBaseUrl || ollamaApiKey || ollamaModel)) {
      llmSettings.ollama = {
        ...llmSettings.ollama,
        ...(ollamaBaseUrl ? { baseUrl: ollamaBaseUrl } : {}),
        ...(ollamaApiKey ? { apiKey: ollamaApiKey } : {}),
        ...(ollamaModel ? { model: ollamaModel } : {}),
      };
      migratedKeys.push("Ollama Configuration");
      llmChanged = true;
    }

    // Azure OpenAI (optional)
    const azureApiKey = normalizeEnvValue(process.env.AZURE_OPENAI_API_KEY);
    const azureEndpoint = normalizeEnvValue(process.env.AZURE_OPENAI_ENDPOINT);
    const azureDeployment = normalizeEnvValue(process.env.AZURE_OPENAI_DEPLOYMENT);
    const azureApiVersion = normalizeEnvValue(process.env.AZURE_OPENAI_API_VERSION);
    const shouldWriteAzure =
      shouldWriteValue(llmSettings?.azure?.apiKey, azureApiKey, mode) ||
      shouldWriteValue(llmSettings?.azure?.endpoint, azureEndpoint, mode) ||
      shouldWriteValue(llmSettings?.azure?.deployment, azureDeployment, mode) ||
      shouldWriteValue(llmSettings?.azure?.apiVersion, azureApiVersion, mode);
    if (shouldWriteAzure && (azureApiKey || azureEndpoint || azureDeployment || azureApiVersion)) {
      llmSettings.azure = {
        ...llmSettings.azure,
        ...(azureApiKey ? { apiKey: azureApiKey } : {}),
        ...(azureEndpoint ? { endpoint: azureEndpoint } : {}),
        ...(azureDeployment ? { deployment: azureDeployment } : {}),
        ...(azureApiVersion ? { apiVersion: azureApiVersion } : {}),
      };
      migratedKeys.push("Azure OpenAI Configuration");
      llmChanged = true;
    }

    // Search API keys
    const tavilyApiKey = normalizeEnvValue(process.env.TAVILY_API_KEY);
    if (shouldWriteValue(searchSettings?.tavily?.apiKey, tavilyApiKey, mode)) {
      searchSettings.tavily = { ...searchSettings.tavily, apiKey: tavilyApiKey };
      migratedKeys.push("Tavily API Key");
      searchChanged = true;
    }

    const braveApiKey = normalizeEnvValue(process.env.BRAVE_API_KEY);
    if (shouldWriteValue(searchSettings?.brave?.apiKey, braveApiKey, mode)) {
      searchSettings.brave = { ...searchSettings.brave, apiKey: braveApiKey };
      migratedKeys.push("Brave Search API Key");
      searchChanged = true;
    }

    const serpApiKey = normalizeEnvValue(process.env.SERPAPI_API_KEY);
    if (shouldWriteValue(searchSettings?.serpapi?.apiKey, serpApiKey, mode)) {
      searchSettings.serpapi = { ...searchSettings.serpapi, apiKey: serpApiKey };
      migratedKeys.push("SerpAPI Key");
      searchChanged = true;
    }

    const googleApiKey = normalizeEnvValue(process.env.GOOGLE_API_KEY);
    const googleSearchEngineId = normalizeEnvValue(process.env.GOOGLE_SEARCH_ENGINE_ID);
    const shouldWriteGoogle =
      shouldWriteValue(searchSettings?.google?.apiKey, googleApiKey, mode) ||
      shouldWriteValue(searchSettings?.google?.searchEngineId, googleSearchEngineId, mode);
    if (shouldWriteGoogle && (googleApiKey || googleSearchEngineId)) {
      searchSettings.google = {
        ...searchSettings.google,
        ...(googleApiKey ? { apiKey: googleApiKey } : {}),
        ...(googleSearchEngineId ? { searchEngineId: googleSearchEngineId } : {}),
      };
      migratedKeys.push("Google Search API Key");
      searchChanged = true;
    }

    // Provider selection (optional)
    const providerOverride = validateProviderType(process.env.COWORK_LLM_PROVIDER);
    if (providerOverride) {
      if (llmSettings.providerType !== providerOverride) {
        llmSettings.providerType = providerOverride;
        migratedKeys.push(`LLM Provider Selection (${providerOverride})`);
        llmChanged = true;
      }
    } else if (llmChanged) {
      const current = (llmSettings.providerType ||
        originalProviderType ||
        "anthropic") as LLMProviderType;
      // Only auto-switch if the current provider isn't configured (avoid surprising flips).
      if (!isProviderConfigured(current, llmSettings)) {
        const picked = pickProviderFromSettings(llmSettings);
        if (picked && llmSettings.providerType !== picked) {
          llmSettings.providerType = picked;
          migratedKeys.push(`LLM Provider Selection (${picked})`);
          llmChanged = true;
        }
      }
    }

    // Save imported settings
    if (llmChanged) {
      LLMProviderFactory.saveSettings(llmSettings);
    }
    if (searchChanged) {
      SearchProviderFactory.saveSettings(searchSettings);
    }

    return {
      migrated: migratedKeys.length > 0,
      migratedKeys,
    };
  } catch (error: Any) {
    return {
      migrated: false,
      migratedKeys: [],
      error: error?.message || String(error),
    };
  }
}
