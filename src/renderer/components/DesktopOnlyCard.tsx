import type { ReactNode } from "react";

/**
 * Stands in for a settings card whose feature runs on the desktop itself (screen capture,
 * computer control) when the app is opened from a browser session.
 */
export function DesktopOnlyCard({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="computer-use-settings">
      <div className="settings-section computer-use-settings-heading">
        <h3>
          <span className="computer-use-settings-heading-icon" aria-hidden="true">
            {icon}
          </span>
          {title}
        </h3>
        <p className="settings-description">{description}</p>
      </div>
    </div>
  );
}
