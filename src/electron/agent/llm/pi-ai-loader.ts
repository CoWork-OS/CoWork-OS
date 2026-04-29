import type {
  AssistantMessage,
  Context,
  Model,
  OAuthAuthInfo,
  OAuthCredentials,
  OAuthPrompt,
} from "@mariozechner/pi-ai";

type PiAiCompleteOptions = {
  apiKey?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  sessionId?: string;
};

export type PiAiModule = {
  complete: (
    model: Model<Any>,
    context: Context,
    options?: PiAiCompleteOptions,
  ) => Promise<AssistantMessage>;
  getModels: (provider: string) => Array<Model<Any>>;
  getProviders: () => string[];
};

export type PiAiOAuthModule = {
  getOAuthApiKey: (
    providerId: "openai-codex",
    credentials: Record<string, OAuthCredentials>,
  ) => Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null>;
  loginOpenAICodex: (callbacks: {
    onAuth: (info: OAuthAuthInfo) => void;
    onPrompt: (prompt: OAuthPrompt) => Promise<string>;
    onProgress?: (message: string) => void;
    onManualCodeInput?: () => Promise<string>;
    originator?: string;
  }) => Promise<OAuthCredentials>;
  refreshOpenAICodexToken: (refreshToken: string) => Promise<OAuthCredentials>;
};

// pi-ai 0.56.x is ESM-only via package exports. Use native import() so the
// CommonJS Electron/daemon bundles can still load it at runtime.
const nativeDynamicImport = new Function(
  "specifier",
  "return import(specifier);",
) as (specifier: string) => Promise<Any>;

let piAiModulePromise: Promise<PiAiModule> | null = null;
let piAiOAuthModulePromise: Promise<PiAiOAuthModule> | null = null;

export function loadPiAiModule(): Promise<PiAiModule> {
  if (!piAiModulePromise) {
    piAiModulePromise = nativeDynamicImport("@mariozechner/pi-ai") as Promise<PiAiModule>;
  }
  return piAiModulePromise;
}

export function loadPiAiOAuthModule(): Promise<PiAiOAuthModule> {
  if (!piAiOAuthModulePromise) {
    piAiOAuthModulePromise = nativeDynamicImport(
      "@mariozechner/pi-ai/oauth",
    ) as Promise<PiAiOAuthModule>;
  }
  return piAiOAuthModulePromise;
}
