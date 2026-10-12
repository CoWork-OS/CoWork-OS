const { app, BrowserWindow } = require("electron");
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
  const manager = new DatabaseManager();
  try {
    new SecureSettingsRepository(manager.getDatabase()).save("appearance", {
      themeMode: "light",
      visualTheme: "calm",
      accentColor: "cyan",
      uiDensity: "focused",
      disclaimerAccepted: true,
      onboardingCompleted: true,
      devRunLoggingEnabled: true,
    });
  } finally {
    manager.close();
  }
};
