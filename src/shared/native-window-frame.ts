export interface NativeWindowFrameRuntime {
  platform: string;
  wslDistroName?: string;
  osRelease?: string;
}

/**
 * WSL relies on the host-provided native frame instead of Electron's custom
 * title bar. Keep this check pure so the main process and preload agree.
 */
export function shouldUseNativeWindowFrame(runtime: NativeWindowFrameRuntime): boolean {
  if (runtime.platform !== "linux") {
    return false;
  }

  return (
    Boolean(runtime.wslDistroName?.trim()) ||
    (runtime.osRelease ?? "").toLowerCase().includes("microsoft")
  );
}
