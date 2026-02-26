/**
 * Tailscale Exposure Manager
 *
 * High-level API for exposing local services via Tailscale Serve or Funnel.
 * Handles lifecycle management, cleanup, and status tracking.
 */

import {
  isTailscaleInstalled,
  getTailnetHostname,
  enableTailscaleServe,
  disableTailscaleServe,
  enableTailscaleFunnel,
  disableTailscaleFunnel,
  checkTailscaleFunnelAvailable,
} from "./tailscale";
import { TailscaleSettingsManager, type TailscaleMode } from "./settings";

/**
 * Configuration for starting Tailscale exposure
 */
export interface TailscaleExposureConfig {
  /** Mode: 'serve' (Tailnet only) or 'funnel' (public internet) */
  mode: TailscaleMode;
  /** Local port to expose */
  port: number;
  /** URL path prefix (default: '/') */
  pathPrefix?: string;
  /** Reset Tailscale config on cleanup */
  resetOnExit?: boolean;
  /** Logger functions */
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

/**
 * Result from starting Tailscale exposure
 */
export interface TailscaleExposureResult {
  /** Whether exposure was successfully enabled */
  success: boolean;
  /** The public/Tailnet hostname */
  hostname?: string;
  /** Full HTTPS URL to access the service */
  httpsUrl?: string;
  /** Full WebSocket URL */
  wssUrl?: string;
  /** Error message if failed */
  error?: string;
  /** Cleanup function to disable exposure */
  cleanup?: () => Promise<void>;
}

/**
 * Active exposure state tracking
 */
interface ActiveExposure {
  mode: TailscaleMode;
  port: number;
  hostname: string;
  startedAt: number;
}

let activeExposure: ActiveExposure | null = null;

/**
 * Get current exposure status
 */
export function getExposureStatus(): {
  active: boolean;
  mode?: TailscaleMode;
  hostname?: string;
  httpsUrl?: string;
  wssUrl?: string;
  startedAt?: number;
} {
  if (!activeExposure) {
    return { active: false };
  }

  return {
    active: true,
    mode: activeExposure.mode,
    hostname: activeExposure.hostname,
    httpsUrl: `https://${activeExposure.hostname}`,
    wssUrl: `wss://${activeExposure.hostname}`,
    startedAt: activeExposure.startedAt,
  };
}

/**
 * Start Tailscale exposure for a local service
 *
 * @param config - Exposure configuration
 * @returns Result with URLs and cleanup function
 */
export async function startTailscaleExposure(
  config: TailscaleExposureConfig,
): Promise<TailscaleExposureResult> {
  const log = config.log || console.log;
  const warn = config.warn || console.warn;

  // Return early if mode is 'off'
  if (config.mode === "off") {
    return { success: true };
  }

  // Check if Tailscale is installed
  const installed = await isTailscaleInstalled();
  if (!installed) {
    const error = "Tailscale is not installed. Please install Tailscale first.";
    warn(`[Tailscale Exposure] ${error}`);
    return { success: false, error };
  }

  // If mode is funnel, check availability
  if (config.mode === "funnel") {
    const funnelAvailable = await checkTailscaleFunnelAvailable();
    if (!funnelAvailable) {
      warn("[Tailscale Exposure] Funnel not available, falling back to Serve mode");
      config.mode = "serve";
    }
  }

  // Enable the appropriate mode
  let enabled = false;
  try {
    if (config.mode === "funnel") {
      enabled = await enableTailscaleFunnel(config.port, config.pathPrefix || "/");
    } else if (config.mode === "serve") {
      enabled = await enableTailscaleServe(config.port, config.pathPrefix || "/");
    }
  } catch (error: Any) {
    const message = error.message || String(error);
    warn(`[Tailscale Exposure] Failed to enable ${config.mode}: ${message}`);
    return { success: false, error: message };
  }

  if (!enabled) {
    const error = `Failed to enable Tailscale ${config.mode}`;
    return { success: false, error };
  }

  // Get the hostname
  const hostname = await getTailnetHostname();
  if (!hostname) {
    warn("[Tailscale Exposure] Could not determine Tailnet hostname");
    // Try to clean up
    if (config.mode === "funnel") {
      await disableTailscaleFunnel();
    } else {
      await disableTailscaleServe();
    }
    return { success: false, error: "Could not determine Tailnet hostname" };
  }

  // Build URLs
  const pathPrefix = config.pathPrefix || "";
  const httpsUrl = `https://${hostname}${pathPrefix}`;
  const wssUrl = `wss://${hostname}${pathPrefix}`;

  // Update settings
  TailscaleSettingsManager.updateSettings({
    mode: config.mode,
    lastHostname: hostname,
    lastStatusCheck: Date.now(),
    resetOnExit: config.resetOnExit ?? true,
    pathPrefix: config.pathPrefix,
  });

  // Track active exposure
  activeExposure = {
    mode: config.mode,
    port: config.port,
    hostname,
    startedAt: Date.now(),
  };

  log(`[Tailscale Exposure] ${config.mode === "funnel" ? "Funnel" : "Serve"} enabled`);
  log(`[Tailscale Exposure] HTTPS: ${httpsUrl}`);
  log(`[Tailscale Exposure] WSS: ${wssUrl}`);

  // Create cleanup function
  const cleanup = async () => {
    try {
      if (config.resetOnExit !== false) {
        if (config.mode === "funnel") {
          await disableTailscaleFunnel();
        } else if (config.mode === "serve") {
          await disableTailscaleServe();
        }
        log(`[Tailscale Exposure] ${config.mode} disabled`);
      }
    } catch (error: Any) {
      warn(`[Tailscale Exposure] Cleanup error: ${error.message || error}`);
    } finally {
      activeExposure = null;
      TailscaleSettingsManager.updateSettings({ mode: "off" });
    }
  };

  return {
    success: true,
    hostname,
    httpsUrl,
    wssUrl,
    cleanup,
  };
}

/**
 * Stop any active Tailscale exposure
 */
export async function stopTailscaleExposure(): Promise<void> {
  if (!activeExposure) {
    return;
  }

  try {
    if (activeExposure.mode === "funnel") {
      await disableTailscaleFunnel();
    } else if (activeExposure.mode === "serve") {
      await disableTailscaleServe();
    }
    console.log(`[Tailscale Exposure] ${activeExposure.mode} disabled`);
  } catch (error: Any) {
    console.error("[Tailscale Exposure] Stop error:", error.message || error);
  } finally {
    activeExposure = null;
    TailscaleSettingsManager.updateSettings({ mode: "off" });
  }
}

/**
 * Check Tailscale availability and status
 */
export async function checkTailscaleAvailability(): Promise<{
  installed: boolean;
  funnelAvailable: boolean;
  hostname: string | null;
}> {
  const installed = await isTailscaleInstalled();

  if (!installed) {
    return {
      installed: false,
      funnelAvailable: false,
      hostname: null,
    };
  }

  const [funnelAvailable, hostname] = await Promise.all([
    checkTailscaleFunnelAvailable(),
    getTailnetHostname(),
  ]);

  return {
    installed: true,
    funnelAvailable,
    hostname,
  };
}
