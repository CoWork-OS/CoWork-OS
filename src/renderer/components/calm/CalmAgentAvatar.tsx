import { useEffect, useState } from "react";

export const CALM_AGENT_AVATARS = [
  { id: "lavender", fill: "#c4b5fd", ink: "#4c1d95" },
  { id: "sky", fill: "#a5d8ff", ink: "#0b4a6f" },
  { id: "mint", fill: "#a7f3d0", ink: "#065f46" },
  { id: "peach", fill: "#fdc9a8", ink: "#7c2d12" },
  { id: "lemon", fill: "#fde68a", ink: "#713f12" },
  { id: "rose", fill: "#fbb6ce", ink: "#831843" },
] as const;

export type CalmAgentAvatarId = (typeof CALM_AGENT_AVATARS)[number]["id"];

const STORAGE_KEY = "cowork:calmAgentAvatar";
const CHANGE_EVENT = "cowork:calm-agent-avatar-changed";

function readAvatarId(): CalmAgentAvatarId {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (CALM_AGENT_AVATARS.some((avatar) => avatar.id === stored)) {
      return stored as CalmAgentAvatarId;
    }
  } catch {
    // Storage unavailable; fall back to the default avatar.
  }
  return "lavender";
}

export function saveCalmAgentAvatar(id: CalmAgentAvatarId): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Non-fatal: the choice just won't persist.
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/** The user's chosen agent avatar, kept in sync across the window. */
export function useCalmAgentAvatar(): CalmAgentAvatarId {
  const [avatarId, setAvatarId] = useState<CalmAgentAvatarId>(readAvatarId);
  useEffect(() => {
    const update = () => setAvatarId(readAvatarId());
    window.addEventListener(CHANGE_EVENT, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(CHANGE_EVENT, update);
      window.removeEventListener("storage", update);
    };
  }, []);
  return avatarId;
}

interface CalmAgentAvatarProps {
  size?: number;
  avatarId?: CalmAgentAvatarId;
  /** Gentle bobbing while the agent is working. */
  animated?: boolean;
  className?: string;
}

/** Friendly blob mascot that represents the user's agent in the calm theme. */
export function CalmAgentAvatar({
  size = 28,
  avatarId,
  animated = false,
  className = "",
}: CalmAgentAvatarProps) {
  const storedId = useCalmAgentAvatar();
  const avatar =
    CALM_AGENT_AVATARS.find((candidate) => candidate.id === (avatarId ?? storedId)) ??
    CALM_AGENT_AVATARS[0];

  return (
    <svg
      className={`calm-agent-avatar${animated ? " animated" : ""} ${className}`}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
    >
      <path
        d="M14 22c0-8.8 6.4-14 16.5-14C42.4 8 50 13.2 52.5 22c2.6 9-0.4 13.4 2.3 20.3C57.4 49 51 56 40.4 56H24.6C14.6 56 9 50.5 9.6 42.4 10 36.4 14 32.6 14 22z"
        fill={avatar.fill}
      />
      <ellipse cx="25" cy="31" rx="5.4" ry="6.4" fill="#fff" />
      <ellipse cx="41" cy="31" rx="5.4" ry="6.4" fill="#fff" />
      <ellipse
        className="calm-agent-avatar-pupil"
        cx="26.4"
        cy="32"
        rx="2.5"
        ry="3.2"
        fill="#1b1b19"
      />
      <ellipse
        className="calm-agent-avatar-pupil"
        cx="42.4"
        cy="32"
        rx="2.5"
        ry="3.2"
        fill="#1b1b19"
      />
      <path
        d="M28 43.5c2.4 2 5.6 2 8 0"
        fill="none"
        stroke={avatar.ink}
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
