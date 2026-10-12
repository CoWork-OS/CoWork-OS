import type {
  AssistantMessage,
  CacheRetention,
  Context,
  Model,
  OAuthAuthInfo,
  OAuthCredentials,
  OAuthPrompt,
} from "@earendil-works/pi-ai";

type PiAiCompleteOptions = {
  apiKey?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  sessionId?: string;
  cacheRetention?: CacheRetention;
  onPayload?: (
    payload: unknown,
    model: Model<Any>,
  ) => unknown | undefined | Promise<unknown | undefined>;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  textVerbosity?: "low" | "medium" | "high";
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
  loginOpenAICodex: (callbacks: {
    onAuth: (info: OAuthAuthInfo) => void;
    onPrompt: (prompt: OAuthPrompt) => Promise<string>;
    onProgress?: (message: string) => void;
    onManualCodeInput?: () => Promise<string>;
    originator?: string;
  }) => Promise<OAuthCredentials>;
  refreshOpenAICodexToken: (refreshToken: string) => Promise<OAuthCredentials>;
};

type PiAiAuthPrompt = {
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: readonly { id: string }[];
  signal?: AbortSignal;
};

type PiAiCodexOAuth = {
  login(
    interaction: {
      signal: AbortSignal;
      prompt(prompt: PiAiAuthPrompt): Promise<string>;
      notify(event: { type: string; [key: string]: unknown }): void;
    },
    options?: { agentName?: string },
  ): Promise<OAuthCredentials>;
  refresh(
    credential: OAuthCredentials & { type: "oauth" },
    signal: AbortSignal,
  ): Promise<OAuthCredentials>;
};

// pi-ai is ESM-only via package exports. Use native import() so the
// CommonJS Electron/daemon bundles can still load it at runtime.
const nativeDynamicImport = new Function("specifier", "return import(specifier);") as (
  specifier: string,
) => Promise<Any>;

let piAiModulePromise: Promise<PiAiModule> | null = null;
let piAiOAuthModulePromise: Promise<PiAiOAuthModule> | null = null;

export function loadPiAiModule(): Promise<PiAiModule> {
  if (!piAiModulePromise) {
    // pi-ai 1.x moved the global complete()/getModels()/getProviders() API to /compat.
    piAiModulePromise = nativeDynamicImport("@earendil-works/pi-ai/compat") as Promise<PiAiModule>;
  }
  return piAiModulePromise;
}

export function loadPiAiOAuthModule(): Promise<PiAiOAuthModule> {
  if (!piAiOAuthModulePromise) {
    // pi-ai 1.x exposes Codex OAuth only through the provider's auth object.
    piAiOAuthModulePromise = nativeDynamicImport(
      "@earendil-works/pi-ai/providers/openai-codex",
    ).then((mod: { openaiCodexProvider: () => { auth: { oauth?: PiAiCodexOAuth } } }) => {
      const oauth = mod.openaiCodexProvider().auth.oauth;
      if (!oauth) throw new Error("pi-ai OpenAI Codex provider has no OAuth support");
      return createCodexOAuthAdapter(oauth);
    });
  }
  return piAiOAuthModulePromise;
}

function createCodexOAuthAdapter(oauth: PiAiCodexOAuth): PiAiOAuthModule {
  return {
    loginOpenAICodex: (callbacks) =>
      oauth.login(
        {
          signal: new AbortController().signal,
          prompt: async (prompt) => {
            if (prompt.type === "select") return "browser";
            if (prompt.type === "manual_code") {
              if (callbacks.onManualCodeInput) return callbacks.onManualCodeInput();
              // No manual entry: wait for the localhost callback, which aborts this prompt.
              return new Promise<string>((_resolve, reject) => {
                prompt.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
                  once: true,
                });
              });
            }
            return callbacks.onPrompt({ message: prompt.message, placeholder: prompt.placeholder });
          },
          notify: (event) => {
            if (event.type === "auth_url") {
              callbacks.onAuth({
                url: String(event.url),
                instructions:
                  typeof event.instructions === "string" ? event.instructions : undefined,
              });
            } else if (typeof event.message === "string") {
              callbacks.onProgress?.(event.message);
            }
          },
        },
        { agentName: callbacks.originator },
      ),
    refreshOpenAICodexToken: (refreshToken) =>
      oauth.refresh(
        { type: "oauth", refresh: refreshToken, access: "", expires: 0 },
        new AbortController().signal,
      ),
  };
}
