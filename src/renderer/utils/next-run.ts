/** "today 09:00", "tomorrow 09:00", "Tue 09:00", a date for later runs, or "overdue since …". */
export function formatNextRun(timestamp: number, now = Date.now()): string {
  const when = new Date(timestamp);
  const time = when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const startOfDay = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOfDay(when) - startOfDay(new Date(now))) / 86_400_000);
  // A missed run (scheduler off or asleep) is overdue, not "today".
  if (timestamp < now - 60_000) {
    if (days === 0) return `overdue since ${time}`;
    return `overdue since ${when.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  }
  if (days <= 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  if (days < 7) return `${when.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return when.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
