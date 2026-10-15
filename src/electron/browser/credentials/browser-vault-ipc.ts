import {
  BROWSER_VAULT_IPC,
  type BrowserVaultAnswer,
  type BrowserVaultCommand,
} from "../../../shared/browser-vault";
import type { BrowserCredentialService } from "./browser-credential-service";

export function registerBrowserVaultIpc(
  ipcMain: { handle(channel: string, handler: (event: unknown, data?: unknown) => unknown): void },
  service: BrowserCredentialService,
  isOwner: (event: unknown) => boolean,
) {
  ipcMain.handle(BROWSER_VAULT_IPC.prompts, (event) => (isOwner(event) ? service.prompts() : []));
  ipcMain.handle(BROWSER_VAULT_IPC.respond, (event, payload) => {
    const data = payload as { id?: string; answer?: BrowserVaultAnswer | null } | null;
    if (!isOwner(event) || typeof data?.id !== "string") return { success: false };
    return { success: service.respond(data.id, data.answer || null) };
  });
  ipcMain.handle(BROWSER_VAULT_IPC.dismiss, (event, id) => ({
    success: isOwner(event) && typeof id === "string" && service.dismissPrompt(id),
  }));
  ipcMain.handle(BROWSER_VAULT_IPC.command, (event, payload) => {
    const data = payload as { taskId?: string; command?: BrowserVaultCommand } | null;
    if (
      !isOwner(event) ||
      typeof data?.taskId !== "string" ||
      !data.command ||
      typeof data.command !== "object"
    )
      return { success: false, error: "denied" };
    return service.executeFromUser(data.taskId, data.command);
  });
}
