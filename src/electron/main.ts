import path from 'path';
import { app, BrowserWindow, ipcMain, dialog, session, shell, Notification } from 'electron';
import { DatabaseManager } from './database/schema';
import { setupIpcHandlers, getNotificationService } from './ipc/handlers';
import { AgentDaemon } from './agent/daemon';
import { LLMProviderFactory } from './agent/llm';
import { SearchProviderFactory } from './agent/search';
import { ChannelGateway } from './gateway';
import { updateManager } from './updater';
import { migrateEnvToSettings } from './utils/env-migration';
import { GuardrailManager } from './guardrails/guardrail-manager';
import { AppearanceManager } from './settings/appearance-manager';
import { MCPClientManager } from './mcp/client/MCPClientManager';
import { trayManager } from './tray';
import { CronService, setCronService, getCronStorePath } from './cron';
import { setupControlPlaneHandlers, shutdownControlPlane } from './control-plane';
// Live Canvas feature
import { registerCanvasScheme, registerCanvasProtocol, CanvasManager } from './canvas';
import { setupCanvasHandlers, cleanupCanvasHandlers } from './ipc/canvas-handlers';

let mainWindow: BrowserWindow | null = null;
let dbManager: DatabaseManager;
let agentDaemon: AgentDaemon;
let channelGateway: ChannelGateway;
let cronService: CronService | null = null;

// Register canvas:// protocol scheme (must be called before app.ready)
registerCanvasScheme();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1200,
    minHeight: 800,
    center: true,
    titleBarStyle: 'hiddenInset',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Load the app
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open external links in the system browser instead of inside the app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Open all new window requests in external browser
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Allow navigation to the app itself (dev server or file://), block external URLs
    const appUrl = process.env.NODE_ENV === 'development'
      ? 'http://localhost:5173'
      : `file://${path.join(__dirname, '../../renderer')}`;

    if (!url.startsWith(appUrl)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
}

app.whenReady().then(async () => {
  // Set up Content Security Policy for production builds
  if (process.env.NODE_ENV !== 'development') {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; " +
            "script-src 'self'; " +
            "style-src 'self' 'unsafe-inline'; " +  // Allow inline styles for React
            "img-src 'self' data: https:; " +       // Allow images from self, data URIs, and HTTPS
            "font-src 'self' data:; " +             // Allow fonts from self and data URIs
            "connect-src 'self' https:; " +         // Allow API calls to HTTPS endpoints
            "frame-ancestors 'none'; " +            // Prevent embedding in iframes
            "form-action 'self';"                   // Restrict form submissions
          ],
        },
      });
    });
  }

  // Initialize provider factories (loads settings from disk)
  LLMProviderFactory.initialize();
  SearchProviderFactory.initialize();
  GuardrailManager.initialize();
  AppearanceManager.initialize();

  // Migrate .env configuration to Settings (one-time upgrade path)
  const migrationResult = await migrateEnvToSettings();

  // Initialize database
  dbManager = new DatabaseManager();

  // Initialize agent daemon
  agentDaemon = new AgentDaemon(dbManager);
  await agentDaemon.initialize();

  // Initialize MCP Client Manager - auto-connects enabled servers on startup
  try {
    const mcpClientManager = MCPClientManager.getInstance();
    await mcpClientManager.initialize();
    console.log('[Main] MCP Client Manager initialized');
  } catch (error) {
    console.error('[Main] Failed to initialize MCP Client Manager:', error);
    // Don't fail app startup if MCP init fails
  }

  // Initialize Cron Service for scheduled task execution
  try {
    cronService = new CronService({
      cronEnabled: true,
      storePath: getCronStorePath(),
      maxConcurrentRuns: 3, // Allow up to 3 concurrent jobs
      // Webhook configuration (disabled by default, can be enabled in settings)
      webhook: {
        enabled: false, // Set to true to enable webhook triggers
        port: 9876,
        host: '127.0.0.1',
        // secret: 'your-secret-here', // Uncomment and set for secure webhooks
      },
      createTask: async (params) => {
        const task = await agentDaemon.createTask({
          title: params.title,
          prompt: params.prompt,
          workspaceId: params.workspaceId,
        });
        return { id: task.id };
      },
      // Channel delivery handler - sends job results to messaging platforms
      deliverToChannel: async (params) => {
        if (!channelGateway) {
          console.warn('[Cron] Cannot deliver to channel - gateway not initialized');
          return;
        }

        // Build the message
        const statusEmoji = params.status === 'ok' ? '✅' : params.status === 'error' ? '❌' : '⏱️';
        let message = `${statusEmoji} **Scheduled Task: ${params.jobName}**\n\n`;

        if (params.status === 'ok') {
          message += `Task completed successfully.\n`;
        } else if (params.status === 'error') {
          message += `Task failed.\n`;
        } else {
          message += `Task timed out.\n`;
        }

        if (params.error) {
          message += `\n**Error:** ${params.error}\n`;
        }

        if (params.taskId && !params.summaryOnly) {
          message += `\n_Task ID: ${params.taskId}_`;
        }

        // Find the channel to verify it exists
        const channels = channelGateway.getChannels();
        const channel = channels.find(
          (ch) => ch.type === params.channelType && ch.id === params.channelId
        );

        if (!channel) {
          console.warn(`[Cron] Channel not found: ${params.channelType}:${params.channelId}`);
          return;
        }

        try {
          // Send the message via the gateway
          await channelGateway.sendMessage(
            params.channelType as any,
            params.channelId,
            message,
            { parseMode: 'markdown' }
          );
          console.log(`[Cron] Delivered to ${params.channelType}:${params.channelId}`);
        } catch (err) {
          console.error(`[Cron] Failed to deliver to ${params.channelType}:${params.channelId}:`, err);
        }
      },
      onEvent: async (evt) => {
        // Forward cron events to renderer
        if (mainWindow?.webContents) {
          mainWindow.webContents.send('cron:event', evt);
        }
        console.log('[Cron] Event:', evt.action, evt.jobId);

        // Show desktop notification when scheduled task finishes
        if (evt.action === 'finished') {
          const statusEmoji = evt.status === 'ok' ? '✅' : evt.status === 'error' ? '❌' : '⏱️';
          const statusText = evt.status === 'ok' ? 'completed' : evt.status === 'error' ? 'failed' : 'timed out';

          // Add in-app notification
          const notificationService = getNotificationService();
          if (notificationService) {
            try {
              // Get job name for the notification
              const job = cronService ? await cronService.get(evt.jobId) : null;
              const jobName = job?.name || 'Scheduled Task';
              await notificationService.add({
                type: evt.status === 'ok' ? 'task_completed' : 'task_failed',
                title: `${statusEmoji} ${jobName} ${statusText}`,
                message: evt.error || (evt.status === 'ok' ? 'Task completed successfully.' : 'Task did not complete.'),
                taskId: evt.taskId,
                cronJobId: evt.jobId,
                workspaceId: job?.workspaceId,
              });
            } catch (err) {
              console.error('[Cron] Failed to add in-app notification:', err);
            }
          }

          // Show macOS notification
          if (Notification.isSupported()) {
            const notification = new Notification({
              title: `${statusEmoji} Scheduled Task ${statusText}`,
              body: evt.error ? `Error: ${evt.error}` : 'Click to view results in the app.',
              silent: false,
            });

            notification.on('click', () => {
              // Bring the main window to focus
              if (mainWindow) {
                if (mainWindow.isMinimized()) mainWindow.restore();
                mainWindow.focus();
              }
            });

            notification.show();
          }
        }
      },
      log: {
        debug: (msg, data) => console.log(`[Cron] ${msg}`, data ?? ''),
        info: (msg, data) => console.log(`[Cron] ${msg}`, data ?? ''),
        warn: (msg, data) => console.warn(`[Cron] ${msg}`, data ?? ''),
        error: (msg, data) => console.error(`[Cron] ${msg}`, data ?? ''),
      },
    });
    setCronService(cronService);
    await cronService.start();
    console.log('[Main] Cron Service initialized');
  } catch (error) {
    console.error('[Main] Failed to initialize Cron Service:', error);
    // Don't fail app startup if cron init fails
  }

  // Initialize channel gateway with agent daemon for task processing
  channelGateway = new ChannelGateway(dbManager.getDatabase(), {
    autoConnect: true, // Auto-connect enabled channels on startup
    agentDaemon,
  });

  // Setup IPC handlers
  await setupIpcHandlers(dbManager, agentDaemon, channelGateway);

  // Register canvas:// protocol handler (must be after app.ready)
  registerCanvasProtocol();

  // Create window
  createWindow();

  // Initialize gateway with main window reference
  if (mainWindow) {
    await channelGateway.initialize(mainWindow);
    // Initialize update manager with main window reference
    updateManager.setMainWindow(mainWindow);

    // Initialize Live Canvas handlers and set main window reference
    setupCanvasHandlers(mainWindow, agentDaemon);
    CanvasManager.getInstance().setMainWindow(mainWindow);

    // Initialize control plane (WebSocket gateway)
    setupControlPlaneHandlers(mainWindow);

    // Initialize menu bar tray (macOS native companion)
    if (process.platform === 'darwin') {
      await trayManager.initialize(mainWindow, channelGateway, dbManager, agentDaemon);
    }

    // Show migration notification after window is ready
    if (migrationResult.migrated && migrationResult.migratedKeys.length > 0) {
      mainWindow.webContents.once('did-finish-load', () => {
        dialog.showMessageBox(mainWindow!, {
          type: 'info',
          title: 'Configuration Migrated',
          message: 'Your API credentials have been migrated',
          detail: `The following credentials were migrated from your .env file to secure Settings storage:\n\n` +
            `${migrationResult.migratedKeys.map(k => `• ${k}`).join('\n')}\n\n` +
            `Your .env file has been renamed to .env.migrated. ` +
            `You can safely delete it after verifying your settings work correctly.\n\n` +
            `Open Settings (gear icon) to review your configuration.`,
          buttons: ['OK'],
        });
      });
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  // Destroy tray
  trayManager.destroy();

  // Stop cron service (async to properly shutdown webhook server)
  if (cronService) {
    await cronService.stop();
    setCronService(null);
  }

  // Cleanup canvas manager (close all windows and watchers)
  await cleanupCanvasHandlers();

  // Shutdown control plane (WebSocket gateway and Tailscale)
  await shutdownControlPlane();

  if (channelGateway) {
    await channelGateway.shutdown();
  }
  // Disconnect all MCP servers
  try {
    const mcpClientManager = MCPClientManager.getInstance();
    await mcpClientManager.shutdown();
  } catch (error) {
    console.error('[Main] Failed to shutdown MCP servers:', error);
  }
  if (dbManager) {
    dbManager.close();
  }
  if (agentDaemon) {
    agentDaemon.shutdown();
  }
});

// Handle folder selection
ipcMain.handle('dialog:selectFolder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Select Workspace Folder',
  });

  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});
