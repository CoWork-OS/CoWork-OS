import { ipcMain, type IpcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/types";
import { getVoiceService, type VoiceService } from "../voice/VoiceService";
import { createLogger } from "../utils/logger";

const logger = createLogger("VoiceIPC");

type VoiceActionService = Pick<
  VoiceService,
  "getCapabilities" | "getState" | "speak" | "stopSpeaking" | "transcribe"
>;

export interface VoiceActionHandlerOptions {
  ipc?: Pick<IpcMain, "handle">;
  getService?: () => VoiceActionService;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function setupVoiceActionHandlers(options: VoiceActionHandlerOptions = {}): void {
  const ipc = options.ipc || ipcMain;
  const resolveService = options.getService || getVoiceService;

  ipc.handle(IPC_CHANNELS.VOICE_GET_CAPABILITIES, async () =>
    resolveService().getCapabilities(),
  );

  ipc.handle(IPC_CHANNELS.VOICE_GET_STATE, async () => resolveService().getState());

  ipc.handle(IPC_CHANNELS.VOICE_SPEAK, async (_event, text: string) => {
    try {
      const audioBuffer = await resolveService().speak(text);
      return {
        success: true,
        audioData: audioBuffer ? Array.from(audioBuffer) : null,
      };
    } catch (error) {
      logger.error("Failed to speak:", error);
      return { success: false, error: errorMessage(error), audioData: null };
    }
  });

  ipc.handle(IPC_CHANNELS.VOICE_STOP_SPEAKING, async () => {
    try {
      resolveService().stopSpeaking();
      return { success: true };
    } catch (error) {
      logger.error("Failed to stop speaking:", error);
      return { success: false, error: errorMessage(error) };
    }
  });

  ipc.handle(IPC_CHANNELS.VOICE_TRANSCRIBE, async (_event, audioData: number[]) => {
    try {
      const text = await resolveService().transcribe(Buffer.from(audioData));
      return { text };
    } catch (error) {
      logger.error("Failed to transcribe:", error);
      return { text: "", error: errorMessage(error) };
    }
  });
}
