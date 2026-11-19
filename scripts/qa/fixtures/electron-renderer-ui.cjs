const { app, BrowserWindow } = require("electron");
const { mkdirSync } = require("node:fs");
const { join } = require("node:path");
app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  window.loadURL(process.env.COWORK_UI_AUDIT_URL);
});
app.on("window-all-closed", () => app.quit());

// Runs in Electron's main process so native SQLite uses the Electron ABI.
globalThis.seedUiAuditProfile = (root, profile) => {
  process.env.COWORK_USER_DATA_DIR = profile;
  const { DatabaseManager } = require(root + "/dist/electron/electron/database/schema.js");
  const { SecureSettingsRepository } = require(
    root + "/dist/electron/electron/database/SecureSettingsRepository.js",
  );
  const { TaskStore, WorkspaceStore } = require(
    root + "/dist/electron/electron/database/repositories.js",
  );
  const manager = new DatabaseManager();
  try {
    const db = manager.getDatabase();
    new SecureSettingsRepository(db).save("appearance", {
      themeMode: "light",
      visualTheme: "calm",
      accentColor: "cyan",
      uiDensity: "focused",
      disclaimerAccepted: true,
      onboardingCompleted: true,
      devRunLoggingEnabled: true,
    });
    const workspacePath = join(profile, "fixture-workspace");
    mkdirSync(workspacePath, { recursive: true });
    const workspace = new WorkspaceStore(db).create("Browser fixture", workspacePath, {
      read: true,
      write: true,
      delete: false,
      network: false,
      shell: false,
    });
    new TaskStore(db).create({
      title: "Browser reload fixture",
      prompt: "Open the browser panel for desktop QA.",
      status: "failed",
      workspaceId: workspace.id,
    });
  } finally {
    manager.close();
  }
};
