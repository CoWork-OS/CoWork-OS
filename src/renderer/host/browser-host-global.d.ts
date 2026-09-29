export {};

declare global {
  interface CoworkBrowserHostInfo {
    /** Readiness summary from the authenticated browser session, never credentials. */
    providerReady: boolean;
    /** Workspace selected by the authenticated host session, if any. */
    activeWorkspaceId: string | null;
    /** Exact service-backed desktop operations advertised by the host. */
    desktopMethods?: Record<string, { mutation: boolean }>;
  }

  interface Window {
    /** True when the desktop renderer is running against a browser host adapter. */
    coworkBrowserHost?: true;
    /** Browser-only host readiness details for product surfaces that need them. */
    coworkBrowserHostInfo?: CoworkBrowserHostInfo;
  }
}
