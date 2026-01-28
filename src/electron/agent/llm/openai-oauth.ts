import { shell } from 'electron';
import {
  loginOpenAICodex,
  refreshOpenAICodexToken,
  getOAuthApiKey,
  OAuthCredentials,
} from '@mariozechner/pi-ai';

/**
 * OpenAI OAuth tokens compatible with pi-ai SDK
 */
export interface OpenAIOAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  email?: string;
}

/**
 * Convert pi-ai OAuthCredentials to our token format
 */
function credentialsToTokens(credentials: OAuthCredentials): OpenAIOAuthTokens {
  return {
    access_token: credentials.access,
    refresh_token: credentials.refresh,
    expires_at: credentials.expires,
    email: credentials.email,
  };
}

/**
 * Convert our token format to pi-ai OAuthCredentials
 */
export function tokensToCredentials(tokens: OpenAIOAuthTokens): OAuthCredentials {
  return {
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: tokens.expires_at,
    email: tokens.email,
  };
}

/**
 * OpenAI OAuth handler using pi-ai SDK
 * Uses the ChatGPT OAuth flow for users with ChatGPT subscriptions
 */
export class OpenAIOAuth {
  /**
   * Start the OAuth flow using pi-ai SDK
   * Opens browser for authentication and waits for callback
   */
  async authenticate(): Promise<OpenAIOAuthTokens> {
    console.log('[OpenAI OAuth] Starting authentication flow with pi-ai SDK...');

    const credentials = await loginOpenAICodex({
      onAuth: (info) => {
        console.log('[OpenAI OAuth] Opening browser for authentication...');
        shell.openExternal(info.url);
        if (info.instructions) {
          console.log('[OpenAI OAuth] Instructions:', info.instructions);
        }
      },
      onPrompt: async (prompt) => {
        // This is called if manual input is needed (shouldn't happen with browser flow)
        console.log('[OpenAI OAuth] Prompt:', prompt.message);
        // Return empty string - browser flow should handle this
        return '';
      },
      onProgress: (message) => {
        console.log('[OpenAI OAuth] Progress:', message);
      },
      originator: 'cowork-oss',
    });

    console.log('[OpenAI OAuth] Authentication successful!');
    if (credentials.email) {
      console.log('[OpenAI OAuth] Logged in as:', credentials.email);
    }

    return credentialsToTokens(credentials);
  }

  /**
   * Refresh an expired access token using pi-ai SDK
   */
  static async refreshTokens(tokens: OpenAIOAuthTokens): Promise<OpenAIOAuthTokens> {
    console.log('[OpenAI OAuth] Refreshing tokens...');

    // refreshOpenAICodexToken expects the refresh token string, not the full credentials
    const newCredentials = await refreshOpenAICodexToken(tokens.refresh_token);

    console.log('[OpenAI OAuth] Tokens refreshed successfully!');
    return credentialsToTokens(newCredentials);
  }

  /**
   * Get an API key from OAuth credentials (with auto-refresh)
   * This is used for making API calls with the ChatGPT backend
   */
  static async getApiKeyFromTokens(
    tokens: OpenAIOAuthTokens
  ): Promise<{ apiKey: string; newTokens?: OpenAIOAuthTokens }> {
    const credentials = tokensToCredentials(tokens);

    const result = await getOAuthApiKey('openai-codex', { 'openai-codex': credentials });

    if (!result) {
      throw new Error('Failed to get API key from OAuth credentials');
    }

    return {
      apiKey: result.apiKey,
      newTokens: credentialsToTokens(result.newCredentials),
    };
  }

  /**
   * Check if tokens are expired or about to expire
   */
  static isTokenExpired(tokens: OpenAIOAuthTokens): boolean {
    if (!tokens.expires_at) {
      return false; // If no expiration, assume valid
    }
    // Consider expired if less than 5 minutes remaining
    return Date.now() > tokens.expires_at - 5 * 60 * 1000;
  }
}
