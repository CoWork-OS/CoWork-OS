import { useState } from "react";

interface DeviceIconProps {
  className?: string;
  size?: number | string;
}

const sizeStyle = (s: number | string) => (typeof s === "number" ? `${s}px` : s);

export function MacMiniIcon({ className = "", size = 48 }: DeviceIconProps) {
  const [imgError, setImgError] = useState(false);

  if (imgError) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 64 64"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
      >
        <rect x="8" y="24" width="48" height="16" rx="4" fill="currentColor" fillOpacity="0.9" />
        <path
          d="M12 40 C12 44, 52 44, 52 40"
          stroke="currentColor"
          strokeWidth="2"
          strokeOpacity="0.5"
          strokeLinecap="round"
        />
        <circle cx="48" cy="32" r="2" fill="currentColor" fillOpacity="0.5" />
        <circle cx="42" cy="32" r="1.5" fill="currentColor" fillOpacity="0.3" />
      </svg>
    );
  }

  return (
    <img
      src="/mac-mini-m4.png"
      alt="Mac Mini"
      className={className}
      style={{
        width: sizeStyle(size),
        height: sizeStyle(size),
        objectFit: "contain",
      }}
      onError={() => setImgError(true)}
    />
  );
}

export function Win11Icon({ className = "", size = 48 }: DeviceIconProps) {
  // A minimalist Windows 11 logo
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <rect x="14" y="14" width="16" height="16" rx="1" fill="#0078D4" />
      <rect x="34" y="14" width="16" height="16" rx="1" fill="#0078D4" />
      <rect x="14" y="34" width="16" height="16" rx="1" fill="#0078D4" />
      <rect x="34" y="34" width="16" height="16" rx="1" fill="#0078D4" />
    </svg>
  );
}

export function CloudServerIcon({ className = "", size = 48 }: DeviceIconProps) {
  // A sleek cloud/server icon
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <rect x="16" y="12" width="32" height="10" rx="2" stroke="currentColor" strokeWidth="2" />
      <circle cx="42" cy="17" r="2" fill="currentColor" />

      <rect x="16" y="27" width="32" height="10" rx="2" stroke="currentColor" strokeWidth="2" />
      <circle cx="42" cy="32" r="2" fill="currentColor" />

      <rect x="16" y="42" width="32" height="10" rx="2" stroke="currentColor" strokeWidth="2" />
      <circle cx="42" cy="47" r="2" fill="currentColor" />
    </svg>
  );
}

export function MobileIcon({ className = "", size = 48 }: DeviceIconProps) {
  // A sleek smartphone icon
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <rect x="20" y="8" width="24" height="48" rx="4" stroke="currentColor" strokeWidth="2" />
      <line
        x1="28"
        y1="14"
        x2="36"
        y2="14"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="32" cy="50" r="2" fill="currentColor" />
    </svg>
  );
}

export function getPlatformVisualIcon(
  platform: string,
  className?: string,
  size?: number,
  deviceName?: string,
) {
  const p = platform.toLowerCase();
  const n = (deviceName || "").toLowerCase();

  if (p.includes("mac") || p.includes("darwin") || n.includes("mac")) {
    return <MacMiniIcon className={className} size={size} />;
  }
  if (p.includes("win") || n.includes("windows") || n.includes("pc") || n.includes("desktop")) {
    return <Win11Icon className={className} size={size} />;
  }
  if (p.includes("ios") || p.includes("android") || n.includes("iphone") || n.includes("phone")) {
    return <MobileIcon className={className} size={size} />;
  }
  // Default to server/VPC for Linux or unknown
  return <CloudServerIcon className={className} size={size} />;
}
