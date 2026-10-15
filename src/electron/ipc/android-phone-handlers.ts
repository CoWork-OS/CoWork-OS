import { ipcMain, BrowserWindow } from "electron";
import { AndroidPhoneService } from "../phone/AndroidPhoneService";

/** Phone selection and installation are desktop-owner controls, never gateway/MCP actions. */
export function registerAndroidPhoneHandlers(mainWindow: () => BrowserWindow | null): void {
  const service = AndroidPhoneService.getInstance();
  const handle = (channel: string, callback: (input?: unknown) => unknown) =>
    ipcMain.handle(channel, (event, input) => {
      const owner = mainWindow();
      if (!owner || BrowserWindow.fromWebContents(event.sender) !== owner)
        throw new Error("Android phone settings require the main app window");
      return callback(input);
    });
  handle("androidPhone:status", () => service.status());
  handle("androidPhone:settings", (input) => service.saveSettings(input));
  handle("androidPhone:install", () => service.install());
  handle("androidPhone:stop", async () => {
    await service.saveSettings({
      ...(await service.settings()),
      enabled: false,
    });
  });
}
