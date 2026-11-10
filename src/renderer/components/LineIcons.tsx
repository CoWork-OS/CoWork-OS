import React from "react";

export type IconProps = React.SVGProps<SVGSVGElement> & {
  size?: number;
  strokeWidth?: number;
};

type BaseIconProps = IconProps & { children: React.ReactNode };

function BaseIcon({ size = 20, strokeWidth = 1.8, children, ...props }: BaseIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export function FolderIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </BaseIcon>
  );
}

export function EditIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </BaseIcon>
  );
}

export function ChartIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M3 3v18h18" />
      <rect x="7" y="12" width="3" height="6" rx="1" />
      <rect x="12" y="9" width="3" height="9" rx="1" />
      <rect x="17" y="6" width="3" height="12" rx="1" />
    </BaseIcon>
  );
}

export function BookIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M3 5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v16" />
      <path d="M3 5v14a2 2 0 0 0 2 2h13" />
      <path d="M7 3v18" />
    </BaseIcon>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.35-4.35" />
    </BaseIcon>
  );
}

export function ClipboardIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <rect x="6" y="4" width="12" height="18" rx="2" />
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M10 10h4" />
      <path d="M10 14h4" />
    </BaseIcon>
  );
}

export function BotIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M12 4v2" />
      <rect x="4" y="8" width="16" height="10" rx="2" />
      <circle cx="9" cy="13" r="1" />
      <circle cx="15" cy="13" r="1" />
    </BaseIcon>
  );
}

export function CalendarIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4" />
      <path d="M8 2v4" />
      <path d="M3 10h18" />
    </BaseIcon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <polyline points="20 6 9 17 4 12" />
    </BaseIcon>
  );
}

export function XIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </BaseIcon>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <polygon points="6 4 20 12 6 20 6 4" />
    </BaseIcon>
  );
}

export function PauseIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <line x1="8" y1="5" x2="8" y2="19" />
      <line x1="16" y1="5" x2="16" y2="19" />
    </BaseIcon>
  );
}

export function SlidersIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <line x1="4" y1="6" x2="21" y2="6" />
      <line x1="4" y1="12" x2="21" y2="12" />
      <line x1="4" y1="18" x2="21" y2="18" />
      <circle cx="9" cy="6" r="2" />
      <circle cx="15" cy="12" r="2" />
      <circle cx="7" cy="18" r="2" />
    </BaseIcon>
  );
}

export function FileIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </BaseIcon>
  );
}

export function FileTextIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <path d="M8 12h8" />
      <path d="M8 16h6" />
    </BaseIcon>
  );
}

export function CodeIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </BaseIcon>
  );
}

export function ImageIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="9" cy="10" r="2" />
      <path d="M21 16l-5-5-4 4-2-2-5 5" />
    </BaseIcon>
  );
}

export function PresentationIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <rect x="4" y="3" width="16" height="11" rx="2" />
      <path d="M8 21l4-4 4 4" />
      <path d="M12 14v3" />
    </BaseIcon>
  );
}

export function GlobeIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a15 15 0 0 1 0 18" />
      <path d="M12 3a15 15 0 0 0 0 18" />
    </BaseIcon>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </BaseIcon>
  );
}

export function AlertTriangleIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </BaseIcon>
  );
}

export function ZapIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M13 2 3 14h7l-1 8 10-12h-7z" />
    </BaseIcon>
  );
}

export function ShieldIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M12 2l7 4v6c0 5-3.5 9-7 10-3.5-1-7-5-7-10V6l7-4z" />
    </BaseIcon>
  );
}

export function InfoIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 10v6" />
      <path d="M12 7h.01" />
    </BaseIcon>
  );
}

export function MessageIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </BaseIcon>
  );
}

export function UsersIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </BaseIcon>
  );
}

export function AtIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M12 8a4 4 0 1 0 4 4" />
      <path d="M16 12v1a3 3 0 0 1-6 0v-1a6 6 0 1 1 6 6" />
    </BaseIcon>
  );
}
