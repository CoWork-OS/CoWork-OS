import { useCallback, useEffect, useState } from "react";

export interface BotDesktopFileEntry {
  path: string;
  size: number;
  modifiedAt: number;
}

/** "1.2 MB", "840 KB", "12 bytes". */
export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
}

/** The newest files in a bot's work folder on its own desktop, refreshed as it works. */
export function useBotDesktopFiles(taskId: string, enabled: boolean, refreshKey?: unknown) {
  const [files, setFiles] = useState<BotDesktopFileEntry[]>([]);

  useEffect(() => {
    const api = window.electronAPI;
    if (!enabled || !api?.listBotDesktopFiles) {
      setFiles([]);
      return;
    }
    let cancelled = false;
    api
      .listBotDesktopFiles(taskId)
      .then((list) => {
        if (!cancelled) setFiles(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, enabled, refreshKey]);

  const reveal = useCallback(
    (filePath: string) => {
      void window.electronAPI?.revealBotDesktopFile?.(taskId, filePath).catch(() => undefined);
    },
    [taskId],
  );

  return { files, reveal };
}
