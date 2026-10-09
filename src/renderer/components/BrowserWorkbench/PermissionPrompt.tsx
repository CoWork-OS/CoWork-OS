import { Camera, Globe2, MapPin, Mic, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type BrowserPermissionPromptRequest = {
  requestId: string;
  tabId: string;
  origin: string;
  permissions: string[];
  externalUrl?: string;
};

export type BrowserPermissionChoice = "allow-once" | "allow-always" | "block" | "dismiss";

const PERMISSION_LABELS: Record<string, string> = {
  camera: "use your camera",
  microphone: "use your microphone",
  geolocation: "know your location",
  notifications: "show notifications",
  "clipboard-read": "see text and images copied to the clipboard",
  midi: "use your MIDI devices",
  midiSysex: "control and reprogram your MIDI devices",
  hid: "connect to HID devices",
  serial: "connect to serial ports",
  usb: "connect to USB devices",
  pointerLock: "lock and use your mouse pointer",
  keyboardLock: "capture your keyboard",
  openExternal: "open an external application",
  fileSystem: "edit files on your device",
};

const PERMISSION_ICONS: Record<string, LucideIcon> = {
  camera: Camera,
  microphone: Mic,
  geolocation: MapPin,
};

function describePermissionRequest(permissions: string[]): string {
  const labels = permissions.map((permission) => PERMISSION_LABELS[permission] || permission);
  if (labels.length <= 1) return labels[0] || "use a device permission";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

function originLabel(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

/** Site permission prompt docked at the top of the tab that asked. */
export function PermissionPrompt({
  request,
  onRespond,
}: {
  request: BrowserPermissionPromptRequest;
  onRespond: (requestId: string, choice: BrowserPermissionChoice) => void;
}) {
  const Icon = PERMISSION_ICONS[request.permissions[0]] || Globe2;
  return (
    <div
      className="browser-workbench-permission"
      role="dialog"
      aria-label="Site permission request"
    >
      <Icon className="browser-workbench-permission-icon" size={16} aria-hidden="true" />
      <div className="browser-workbench-permission-text">
        <strong>{originLabel(request.origin)}</strong> wants to{" "}
        {describePermissionRequest(request.permissions)}
        {request.externalUrl ? (
          <span className="browser-workbench-permission-detail" title={request.externalUrl}>
            {request.externalUrl}
          </span>
        ) : null}
      </div>
      <div className="browser-workbench-permission-actions">
        <button type="button" onClick={() => onRespond(request.requestId, "block")}>
          Never allow
        </button>
        <button type="button" onClick={() => onRespond(request.requestId, "allow-once")}>
          Allow this time
        </button>
        <button
          type="button"
          className="is-primary"
          onClick={() => onRespond(request.requestId, "allow-always")}
        >
          Always allow
        </button>
      </div>
      <button
        type="button"
        className="browser-workbench-permission-close"
        aria-label="Dismiss permission request"
        onClick={() => onRespond(request.requestId, "dismiss")}
      >
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  );
}
