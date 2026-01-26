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

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { LLMProviderFactory } from '../agent/llm';
import { SearchProviderFactory } from '../agent/search';

interface MigrationResult {
  migrated: boolean;
  migratedKeys: string[];
  error?: string;
}

/**
 * Parse a .env file into key-value pairs
 */
function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split('\n');

  for (const line of lines) {
    // Skip empty lines and comments
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Parse KEY=VALUE (handle quoted values)
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Remove surrounding quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
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
  const possiblePaths = [
    path.join(app.getAppPath(), '.env'),
    path.join(process.cwd(), '.env'),
    path.join(app.getPath('userData'), '.env'),
  ];

  let envPath: string | null = null;
  let envContent: string | null = null;

  for (const p of possiblePaths) {
    try {
      if (fs.existsSync(p)) {
        envContent = fs.readFileSync(p, 'utf-8');
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
  const migratedPath = envPath + '.migrated';
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
      migratedKeys.push('Anthropic API Key');
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
      migratedKeys.push('AWS Bedrock Credentials');
      llmChanged = true;
    }

    // Migrate Gemini API key
    if (env.GEMINI_API_KEY && !llmSettings.gemini?.apiKey) {
      llmSettings.gemini = { ...llmSettings.gemini, apiKey: env.GEMINI_API_KEY };
      migratedKeys.push('Gemini API Key');
      llmChanged = true;
    }

    // Migrate OpenRouter API key
    if (env.OPENROUTER_API_KEY && !llmSettings.openrouter?.apiKey) {
      llmSettings.openrouter = { ...llmSettings.openrouter, apiKey: env.OPENROUTER_API_KEY };
      migratedKeys.push('OpenRouter API Key');
      llmChanged = true;
    }

    // Migrate Ollama settings
    if (env.OLLAMA_BASE_URL && !llmSettings.ollama?.baseUrl) {
      llmSettings.ollama = {
        ...llmSettings.ollama,
        baseUrl: env.OLLAMA_BASE_URL,
        apiKey: env.OLLAMA_API_KEY,
      };
      migratedKeys.push('Ollama Configuration');
      llmChanged = true;
    }

    // Migrate Search API keys
    if (env.TAVILY_API_KEY && !searchSettings.tavily?.apiKey) {
      searchSettings.tavily = { apiKey: env.TAVILY_API_KEY };
      migratedKeys.push('Tavily API Key');
      searchChanged = true;
    }

    if (env.BRAVE_API_KEY && !searchSettings.brave?.apiKey) {
      searchSettings.brave = { apiKey: env.BRAVE_API_KEY };
      migratedKeys.push('Brave Search API Key');
      searchChanged = true;
    }

    if (env.SERPAPI_API_KEY && !searchSettings.serpapi?.apiKey) {
      searchSettings.serpapi = { apiKey: env.SERPAPI_API_KEY };
      migratedKeys.push('SerpAPI Key');
      searchChanged = true;
    }

    if (env.GOOGLE_API_KEY && !searchSettings.google?.apiKey) {
      searchSettings.google = {
        apiKey: env.GOOGLE_API_KEY,
        searchEngineId: env.GOOGLE_SEARCH_ENGINE_ID,
      };
      migratedKeys.push('Google Search API Key');
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
  } catch (error: any) {
    return {
      migrated: false,
      migratedKeys: [],
      error: error.message,
    };
  }
}
