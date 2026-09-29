interface TaskStatusBadgeProps {
  status: string;
  label?: string;
  className?: string;
  statusClassPrefix?: string;
}

/** Passive status presentation shared by task surfaces in desktop and browser renderers. */
export function TaskStatusBadge({
  status,
  label = status,
  className,
  statusClassPrefix = "status-",
}: TaskStatusBadgeProps) {
  const token = status
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .slice(0, 32);
  const classes = [className, `${statusClassPrefix}${token}`].filter(Boolean).join(" ");

  return (
    <span className={classes} data-task-status={status}>
      {label}
    </span>
  );
}
