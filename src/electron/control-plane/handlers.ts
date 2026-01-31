/**
 * Control Plane IPC Handlers
 *
 * IPC handlers for managing the WebSocket control plane from the renderer.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../shared/types';
import type {
  ControlPlaneSettingsData,
  ControlPlaneStatus,
  TailscaleAvailability,
  TailscaleMode,
  RemoteGatewayConfig,
  RemoteGatewayStatus,
} from '../../shared/types';
import { ControlPlaneServer, ControlPlaneSettingsManager } from './index';
import { checkTailscaleAvailability, getExposureStatus } from '../tailscale';
import { TailscaleSettingsManager } from '../tailscale/settings';
import {
  RemoteGatewayClient,
  initRemoteGatewayClient,
  getRemoteGatewayClient,
  shutdownRemoteGatewayClient,
} from './remote-client';

// Server instance
let controlPlaneServer: ControlPlaneServer | null = null;

// Reference to main window for sending events
let mainWindowRef: BrowserWindow | null = null;

/**
 * Get the current control plane server instance
 */
export function getControlPlaneServer(): ControlPlaneServer | null {
  return controlPlaneServer;
}

/**
 * Initialize control plane IPC handlers
 */
export function setupControlPlaneHandlers(mainWindow: BrowserWindow): void {
  mainWindowRef = mainWindow;

  // Initialize settings managers
  ControlPlaneSettingsManager.initialize();
  TailscaleSettingsManager.initialize();

  // Get settings (with masked token)
  ipcMain.handle(IPC_CHANNELS.CONTROL_PLANE_GET_SETTINGS, async (): Promise<ControlPlaneSettingsData> => {
    return ControlPlaneSettingsManager.getSettingsForDisplay();
  });

  // Save settings
  ipcMain.handle(
    IPC_CHANNELS.CONTROL_PLANE_SAVE_SETTINGS,
    async (_, settings: Partial<ControlPlaneSettingsData>): Promise<{ ok: boolean; error?: string }> => {
      try {
        ControlPlaneSettingsManager.updateSettings(settings);
        return { ok: true };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    }
  );

  // Enable control plane
  ipcMain.handle(IPC_CHANNELS.CONTROL_PLANE_ENABLE, async (): Promise<{
    ok: boolean;
    token?: string;
    error?: string;
  }> => {
    try {
      const settings = ControlPlaneSettingsManager.enable();
      return { ok: true, token: settings.token };
    } catch (error: any) {
      return { ok: false, error: error.message || String(error) };
    }
  });

  // Disable control plane
  ipcMain.handle(IPC_CHANNELS.CONTROL_PLANE_DISABLE, async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      // Stop server if running
      if (controlPlaneServer) {
        await controlPlaneServer.stop();
        controlPlaneServer = null;
      }
      ControlPlaneSettingsManager.disable();
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: error.message || String(error) };
    }
  });

  // Start control plane server
  ipcMain.handle(IPC_CHANNELS.CONTROL_PLANE_START, async (): Promise<{
    ok: boolean;
    address?: { host: string; port: number; wsUrl: string };
    tailscale?: { httpsUrl?: string; wssUrl?: string };
    error?: string;
  }> => {
    try {
      if (controlPlaneServer?.isRunning) {
        const addr = controlPlaneServer.getAddress();
        const tailscale = getExposureStatus();
        return {
          ok: true,
          address: addr || undefined,
          tailscale: tailscale.active ? {
            httpsUrl: tailscale.httpsUrl,
            wssUrl: tailscale.wssUrl,
          } : undefined,
        };
      }

      const settings = ControlPlaneSettingsManager.loadSettings();

      if (!settings.token) {
        return { ok: false, error: 'No authentication token configured' };
      }

      // Create server instance
      controlPlaneServer = new ControlPlaneServer({
        port: settings.port,
        host: settings.host,
        token: settings.token,
        handshakeTimeoutMs: settings.handshakeTimeoutMs,
        heartbeatIntervalMs: settings.heartbeatIntervalMs,
        maxPayloadBytes: settings.maxPayloadBytes,
        onEvent: (event) => {
          // Forward events to renderer
          if (mainWindowRef && !mainWindowRef.isDestroyed()) {
            mainWindowRef.webContents.send(IPC_CHANNELS.CONTROL_PLANE_EVENT, event);
          }
        },
      });

      // Start with Tailscale if configured
      const tailscaleResult = await controlPlaneServer.startWithTailscale();

      const address = controlPlaneServer.getAddress();

      return {
        ok: true,
        address: address || undefined,
        tailscale: tailscaleResult?.success ? {
          httpsUrl: tailscaleResult.httpsUrl,
          wssUrl: tailscaleResult.wssUrl,
        } : undefined,
      };
    } catch (error: any) {
      console.error('[ControlPlane Handlers] Start error:', error);
      return { ok: false, error: error.message || String(error) };
    }
  });

  // Stop control plane server
  ipcMain.handle(IPC_CHANNELS.CONTROL_PLANE_STOP, async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      if (controlPlaneServer) {
        await controlPlaneServer.stop();
        controlPlaneServer = null;
      }
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: error.message || String(error) };
    }
  });

  // Get control plane status
  ipcMain.handle(IPC_CHANNELS.CONTROL_PLANE_GET_STATUS, async (): Promise<ControlPlaneStatus> => {
    const settings = ControlPlaneSettingsManager.loadSettings();
    const tailscale = getExposureStatus();

    if (!controlPlaneServer || !controlPlaneServer.isRunning) {
      return {
        enabled: settings.enabled,
        running: false,
        clients: {
          total: 0,
          authenticated: 0,
          pending: 0,
          list: [],
        },
        tailscale: {
          active: tailscale.active,
          mode: tailscale.mode,
          hostname: tailscale.hostname,
          httpsUrl: tailscale.httpsUrl,
          wssUrl: tailscale.wssUrl,
        },
      };
    }

    const serverStatus = controlPlaneServer.getStatus();

    return {
      enabled: settings.enabled,
      running: serverStatus.running,
      address: serverStatus.address || undefined,
      clients: {
        total: serverStatus.clients.total,
        authenticated: serverStatus.clients.authenticated,
        pending: serverStatus.clients.pending,
        list: serverStatus.clients.clients,
      },
      tailscale: {
        active: serverStatus.tailscale.active,
        mode: serverStatus.tailscale.mode,
        hostname: serverStatus.tailscale.hostname,
        httpsUrl: serverStatus.tailscale.httpsUrl,
        wssUrl: serverStatus.tailscale.wssUrl,
      },
    };
  });

  // Regenerate token
  ipcMain.handle(IPC_CHANNELS.CONTROL_PLANE_REGENERATE_TOKEN, async (): Promise<{
    ok: boolean;
    token?: string;
    error?: string;
  }> => {
    try {
      const newToken = ControlPlaneSettingsManager.regenerateToken();

      // If server is running, we need to restart it with new token
      if (controlPlaneServer?.isRunning) {
        await controlPlaneServer.stop();
        const settings = ControlPlaneSettingsManager.loadSettings();

        controlPlaneServer = new ControlPlaneServer({
          port: settings.port,
          host: settings.host,
          token: settings.token,
          handshakeTimeoutMs: settings.handshakeTimeoutMs,
          heartbeatIntervalMs: settings.heartbeatIntervalMs,
          maxPayloadBytes: settings.maxPayloadBytes,
          onEvent: (event) => {
            if (mainWindowRef && !mainWindowRef.isDestroyed()) {
              mainWindowRef.webContents.send(IPC_CHANNELS.CONTROL_PLANE_EVENT, event);
            }
          },
        });

        await controlPlaneServer.startWithTailscale();
      }

      return { ok: true, token: newToken };
    } catch (error: any) {
      return { ok: false, error: error.message || String(error) };
    }
  });

  // ===== Tailscale Handlers =====

  // Check Tailscale availability
  ipcMain.handle(IPC_CHANNELS.TAILSCALE_CHECK_AVAILABILITY, async (): Promise<TailscaleAvailability> => {
    return await checkTailscaleAvailability();
  });

  // Get Tailscale status
  ipcMain.handle(IPC_CHANNELS.TAILSCALE_GET_STATUS, async () => {
    const settings = TailscaleSettingsManager.loadSettings();
    const exposure = getExposureStatus();

    return {
      settings,
      exposure,
    };
  });

  // Set Tailscale mode
  ipcMain.handle(
    IPC_CHANNELS.TAILSCALE_SET_MODE,
    async (_, mode: TailscaleMode): Promise<{ ok: boolean; error?: string }> => {
      try {
        // Update settings
        ControlPlaneSettingsManager.updateSettings({
          tailscale: { mode, resetOnExit: true },
        });

        // If server is running, restart to apply new mode
        if (controlPlaneServer?.isRunning) {
          await controlPlaneServer.stop();
          const settings = ControlPlaneSettingsManager.loadSettings();

          controlPlaneServer = new ControlPlaneServer({
            port: settings.port,
            host: settings.host,
            token: settings.token,
            handshakeTimeoutMs: settings.handshakeTimeoutMs,
            heartbeatIntervalMs: settings.heartbeatIntervalMs,
            maxPayloadBytes: settings.maxPayloadBytes,
            onEvent: (event) => {
              if (mainWindowRef && !mainWindowRef.isDestroyed()) {
                mainWindowRef.webContents.send(IPC_CHANNELS.CONTROL_PLANE_EVENT, event);
              }
            },
          });

          await controlPlaneServer.startWithTailscale();
        }

        return { ok: true };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    }
  );

  // ===== Remote Gateway Handlers =====

  // Connect to remote gateway
  ipcMain.handle(
    IPC_CHANNELS.REMOTE_GATEWAY_CONNECT,
    async (_, config?: RemoteGatewayConfig): Promise<{ ok: boolean; error?: string }> => {
      try {
        // Get config from settings if not provided
        const settings = ControlPlaneSettingsManager.loadSettings();
        const remoteConfig = config || settings.remote;

        if (!remoteConfig?.url || !remoteConfig?.token) {
          return { ok: false, error: 'Remote gateway URL and token are required' };
        }

        // Stop local server if running
        if (controlPlaneServer?.isRunning) {
          await controlPlaneServer.stop();
          controlPlaneServer = null;
        }

        // Initialize and connect remote client
        const client = initRemoteGatewayClient({
          ...remoteConfig,
          onStateChange: (state, error) => {
            if (mainWindowRef && !mainWindowRef.isDestroyed()) {
              mainWindowRef.webContents.send(IPC_CHANNELS.REMOTE_GATEWAY_EVENT, {
                type: 'stateChange',
                state,
                error,
              });
            }
          },
          onEvent: (event, payload) => {
            if (mainWindowRef && !mainWindowRef.isDestroyed()) {
              mainWindowRef.webContents.send(IPC_CHANNELS.REMOTE_GATEWAY_EVENT, {
                type: 'event',
                event,
                payload,
              });
            }
          },
        });

        await client.connect();

        // Update settings with connection mode
        ControlPlaneSettingsManager.updateSettings({
          connectionMode: 'remote',
          remote: remoteConfig,
        });

        return { ok: true };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    }
  );

  // Disconnect from remote gateway
  ipcMain.handle(
    IPC_CHANNELS.REMOTE_GATEWAY_DISCONNECT,
    async (): Promise<{ ok: boolean; error?: string }> => {
      try {
        shutdownRemoteGatewayClient();
        ControlPlaneSettingsManager.updateSettings({
          connectionMode: 'local',
        });
        return { ok: true };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    }
  );

  // Get remote gateway status
  ipcMain.handle(
    IPC_CHANNELS.REMOTE_GATEWAY_GET_STATUS,
    async (): Promise<RemoteGatewayStatus> => {
      const client = getRemoteGatewayClient();
      if (!client) {
        return { state: 'disconnected' };
      }
      return client.getStatus();
    }
  );

  // Save remote gateway config
  ipcMain.handle(
    IPC_CHANNELS.REMOTE_GATEWAY_SAVE_CONFIG,
    async (_, config: RemoteGatewayConfig): Promise<{ ok: boolean; error?: string }> => {
      try {
        ControlPlaneSettingsManager.updateSettings({
          remote: config,
        });
        return { ok: true };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    }
  );

  // Test remote gateway connection
  ipcMain.handle(
    IPC_CHANNELS.REMOTE_GATEWAY_TEST_CONNECTION,
    async (_, config: RemoteGatewayConfig): Promise<{
      ok: boolean;
      latencyMs?: number;
      error?: string;
    }> => {
      try {
        const client = new RemoteGatewayClient(config);
        const result = await client.testConnection();
        return {
          ok: result.success,
          latencyMs: result.latencyMs,
          error: result.error,
        };
      } catch (error: any) {
        return { ok: false, error: error.message || String(error) };
      }
    }
  );

  console.log('[ControlPlane] IPC handlers initialized');
}

/**
 * Shutdown the control plane server and remote client
 * Call this during app quit
 */
export async function shutdownControlPlane(): Promise<void> {
  // Shutdown remote client
  shutdownRemoteGatewayClient();

  // Shutdown local server
  if (controlPlaneServer) {
    console.log('[ControlPlane] Shutting down server...');
    await controlPlaneServer.stop();
    controlPlaneServer = null;
  }
}
