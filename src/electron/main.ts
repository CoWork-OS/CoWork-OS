import path from 'path';
import { app, BrowserWindow, ipcMain, dialog, session, shell } from 'electron';
import { DatabaseManager } from './database/schema';
import { setupIpcHandlers } from './ipc/handlers';
import { AgentDaemon } from './agent/daemon';
import { LLMProviderFactory } from './agent/llm';
import { SearchProviderFactory } from './agent/search';
import { ChannelGateway } from './gateway';
import { updateManager } from './updater';
import { migrateEnvToSettings } from './utils/env-migration';
import { GuardrailManager } from './guardrails/guardrail-manager';
import { MCPClientManager } from './mcp/client/MCPClientManager';

let mainWindow: BrowserWindow | null = null;
let dbManager: DatabaseManager;
let agentDaemon: AgentDaemon;
let channelGateway: ChannelGateway;

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

  // Initialize channel gateway with agent daemon for task processing
  channelGateway = new ChannelGateway(dbManager.getDatabase(), {
    autoConnect: true, // Auto-connect enabled channels on startup
    agentDaemon,
  });

  // Setup IPC handlers
  setupIpcHandlers(dbManager, agentDaemon, channelGateway);

  // Create window
  createWindow();

  // Initialize gateway with main window reference
  if (mainWindow) {
    await channelGateway.initialize(mainWindow);
    // Initialize update manager with main window reference
    updateManager.setMainWindow(mainWindow);

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
