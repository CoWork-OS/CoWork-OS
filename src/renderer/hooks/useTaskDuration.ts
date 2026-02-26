import { useState, useEffect } from "react";

/**
 * Format a duration in milliseconds to a human-readable string.
 * Examples: "3s", "2m 15s", "1h 30m", "2h 5m"
 */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  return `${seconds}s`;
}

/**
 * Hook that returns a live-updating duration string for a task.
 * For finished tasks (completedAt set), returns a static string.
 * For active tasks, ticks every second.
 */
export function useTaskDuration(
  createdAt: number,
  completedAt?: number,
  isActive: boolean = false,
): string {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!isActive || completedAt) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [isActive, completedAt]);

  const endTime = completedAt || (isActive ? now : Date.now());
  return formatDuration(endTime - createdAt);
}
