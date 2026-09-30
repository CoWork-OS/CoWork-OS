export interface BrowserProviderSignIn {
  flowId: string;
  state: "pending" | "completed" | "failed" | "cancelled";
  authorizationUrl?: string;
  expiresAt: number;
  recommendedModel?: string;
  error?: string;
}

/** Browser-only account flow; credentials and PKCE verifier stay on the host. */
export interface BrowserProviderAuthApi {
  beginOpenAIBrowserSignIn(): Promise<BrowserProviderSignIn>;
  getOpenAIBrowserSignIn(flowId: string): Promise<BrowserProviderSignIn>;
  submitOpenAIBrowserSignIn(flowId: string, callbackUrl: string): Promise<{ success: boolean }>;
  cancelOpenAIBrowserSignIn(flowId: string): Promise<{ success: boolean }>;
}
