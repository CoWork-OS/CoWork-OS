import { config } from 'dotenv';
import path from 'path';

// Load environment variables from .env file
config({ path: path.join(process.cwd(), '.env') });

import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { DatabaseManager } from './database/schema';
import { setupIpcHandlers } from './ipc/handlers';
import { AgentDaemon } from './agent/daemon';
import { LLMProviderFactory } from './agent/llm';
import { SearchProviderFactory } from './agent/search';
import { ChannelGateway } from './gateway';
import { updateManager } from './updater';

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
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  // Initialize provider factories (loads settings from disk)
  LLMProviderFactory.initialize();
  SearchProviderFactory.initialize();

  // Initialize database
  dbManager = new DatabaseManager();

  // Initialize agent daemon
  agentDaemon = new AgentDaemon(dbManager);

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
