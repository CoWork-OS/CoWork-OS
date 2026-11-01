import { Laptop, Server } from "lucide-react";
import type { TeamDevice } from "../../utils/team-view";

export function TeamDeviceCard({
  device,
  onOpen,
}: {
  device: TeamDevice;
  onOpen: (deviceId: string) => void;
}) {
  const content = (
    <>
      <span className="team-view-device-head">
        {device.local ? (
          <Laptop size={18} aria-hidden="true" />
        ) : (
          <Server size={18} aria-hidden="true" />
        )}
        <span className="team-view-device-name">{device.name}</span>
        <span className="team-view-device-status">
          <span className="team-view-dot" aria-hidden="true" />
          {device.statusLabel}
        </span>
      </span>
      <span className="team-view-device-line">
        {device.running === 0 && device.waiting === 0
          ? "Nothing running"
          : [
              device.running > 0 ? `${device.running} running` : "",
              device.waiting > 0 ? `${device.waiting} waiting on you` : "",
            ]
              .filter(Boolean)
              .join(" · ")}
      </span>
    </>
  );
  const className = `team-view-device${device.online ? "" : " offline"}`;
  return device.local ? (
    <div className={className}>{content}</div>
  ) : (
    <button type="button" className={className} onClick={() => onOpen(device.id)}>
      {content}
    </button>
  );
}
