import type { ComponentType } from "react";
import {
  GitBranch,
  Hammer,
  House,
  Inbox,
  Library,
  Lightbulb,
  Monitor,
  Puzzle,
  Sparkles,
  Users,
  UsersRound,
  Workflow,
} from "lucide-react";
import { hasHostCapability, hasHostMethods } from "../../host/browser-capabilities";

export type SidebarDestinationId =
  | "home"
  | "inbox"
  | "agents"
  | "automations"
  | "library"
  | "gitChanges"
  | "devices"
  | "everyday"
  | "missionControl"
  | "ideas"
  | "build"
  | "addTools";

/** The two lists the sidebar panel switches between (Devices swaps in its own panel by view). */
export type SidebarPanelTab = "sessions" | "bots";

export interface SidebarDestinationContext {
  isCalm: boolean;
  isBrowserHost: boolean;
}

export interface SidebarDestination {
  id: SidebarDestinationId;
  label: string;
  /** Shorter caption for the rail when `label` doesn't fit under the icon. */
  railLabel?: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  /** `rail` items are always on the rail; `more` items live in the More menu and can be pinned. */
  placement: "rail" | "more";
  /** App views that mark this destination as the current one. */
  views: readonly string[];
  /** Destinations whose content is a sidebar list open the panel when selected. */
  panel?: "bots" | "devices";
  /** Browser-host methods the destination needs. The desktop app always has them. */
  hostMethods?: readonly string[];
  isVisible?: (context: SidebarDestinationContext) => boolean;
}

const calmOnly = ({ isCalm }: SidebarDestinationContext) => isCalm;

export const SIDEBAR_DESTINATIONS: readonly SidebarDestination[] = [
  { id: "home", label: "Home", icon: House, placement: "rail", views: ["main", "home"] },
  {
    id: "inbox",
    label: "Inbox",
    icon: Inbox,
    placement: "rail",
    views: ["inboxAgent"],
    hostMethods: ["getMailboxSyncStatus", "listMailboxThreads"],
  },
  {
    id: "agents",
    label: "Agents",
    icon: UsersRound,
    placement: "rail",
    views: ["agents"],
    panel: "bots",
    hostMethods: ["listManagedAgents", "listManagedSessions"],
  },
  {
    id: "automations",
    label: "Automations",
    railLabel: "Automate",
    icon: Workflow,
    placement: "rail",
    views: ["automations"],
    hostMethods: ["listRoutines"],
  },
  {
    // The Library and Build views are only styled for the Calm theme.
    id: "library",
    label: "Library",
    icon: Library,
    placement: "rail",
    views: ["library"],
    hostMethods: ["listBrowserWorkspaceFiles", "listBrowserTaskArtifacts"],
    isVisible: calmOnly,
  },
  {
    id: "gitChanges",
    label: "Git Changes",
    railLabel: "Changes",
    icon: GitBranch,
    placement: "rail",
    views: ["git"],
    isVisible: ({ isBrowserHost }) => isBrowserHost && hasHostCapability("git.read"),
  },
  {
    id: "devices",
    label: "Devices",
    icon: Monitor,
    placement: "more",
    views: ["devices"],
    panel: "devices",
    hostMethods: ["listManagedDevices", "getDeviceSummary"],
  },
  {
    id: "everyday",
    label: "Everyday",
    icon: Sparkles,
    placement: "more",
    views: ["everydayAgent"],
    hostMethods: ["everydayAgentGetProfile"],
  },
  {
    id: "missionControl",
    label: "Mission Control",
    railLabel: "Missions",
    icon: Users,
    placement: "more",
    views: ["missionControl"],
    hostMethods: ["getAgentRoles", "listMissionControlItems"],
  },
  { id: "ideas", label: "Ideas", icon: Lightbulb, placement: "more", views: ["ideas"] },
  {
    id: "build",
    label: "Build",
    icon: Hammer,
    placement: "more",
    views: ["build"],
    isVisible: calmOnly,
  },
  {
    id: "addTools",
    label: "Add tools",
    icon: Puzzle,
    placement: "more",
    views: [],
    hostMethods: ["listPluginPacks"],
  },
];

const DESTINATIONS_BY_ID = new Map(
  SIDEBAR_DESTINATIONS.map((destination) => [destination.id, destination]),
);

export function getSidebarDestination(id: SidebarDestinationId): SidebarDestination {
  const destination = DESTINATIONS_BY_ID.get(id);
  if (!destination) throw new Error(`Unknown sidebar destination: ${id}`);
  return destination;
}

export function isSidebarDestinationAvailable(destination: SidebarDestination): boolean {
  return !destination.hostMethods || hasHostMethods(...destination.hostMethods);
}

/**
 * The destination to highlight. A bot conversation keeps Agents highlighted
 * because its roster is what the panel is showing.
 */
export function getActiveSidebarDestination(
  view: string,
  panelTab: SidebarPanelTab,
): SidebarDestinationId | null {
  if (panelTab === "bots" && (view === "main" || view === "home" || view === "agents")) {
    return "agents";
  }
  return SIDEBAR_DESTINATIONS.find((destination) => destination.views.includes(view))?.id ?? null;
}

export interface SidebarRailLayout {
  rail: SidebarDestination[];
  pinned: SidebarDestination[];
  more: SidebarDestination[];
}

export function getSidebarRailLayout(
  context: SidebarDestinationContext,
  pinnedIds: readonly SidebarDestinationId[],
): SidebarRailLayout {
  const visible = SIDEBAR_DESTINATIONS.filter(
    (destination) => destination.isVisible?.(context) ?? true,
  );
  const more = visible.filter((destination) => destination.placement === "more");
  const pinned = pinnedIds
    .map((id) => more.find((destination) => destination.id === id))
    .filter((destination): destination is SidebarDestination => Boolean(destination));
  return {
    rail: visible.filter((destination) => destination.placement === "rail"),
    pinned,
    more,
  };
}

export const SIDEBAR_RAIL_STORAGE_KEY = "cowork.sidebar.rail.v1";
export const DEFAULT_PINNED_SIDEBAR_DESTINATIONS: readonly SidebarDestinationId[] = ["devices"];

function isPinnableDestinationId(value: unknown): value is SidebarDestinationId {
  return (
    typeof value === "string" &&
    DESTINATIONS_BY_ID.get(value as SidebarDestinationId)?.placement === "more"
  );
}

/** Pinned More items in pin order. Falls back to the defaults until the user pins or unpins. */
export function readPinnedSidebarDestinations(
  storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage,
): SidebarDestinationId[] {
  try {
    const raw = storage?.getItem(SIDEBAR_RAIL_STORAGE_KEY);
    if (!raw) return [...DEFAULT_PINNED_SIDEBAR_DESTINATIONS];
    const parsed = JSON.parse(raw) as { pinned?: unknown };
    if (!Array.isArray(parsed.pinned)) return [...DEFAULT_PINNED_SIDEBAR_DESTINATIONS];
    return [...new Set(parsed.pinned.filter(isPinnableDestinationId))];
  } catch {
    return [...DEFAULT_PINNED_SIDEBAR_DESTINATIONS];
  }
}

export function writePinnedSidebarDestinations(
  pinnedIds: readonly SidebarDestinationId[],
  storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(SIDEBAR_RAIL_STORAGE_KEY, JSON.stringify({ pinned: pinnedIds }));
  } catch {
    // Rail pins are a convenience preference; keep the in-memory state if storage fails.
  }
}

export function togglePinnedSidebarDestination(
  pinnedIds: readonly SidebarDestinationId[],
  id: SidebarDestinationId,
): SidebarDestinationId[] {
  return pinnedIds.includes(id)
    ? pinnedIds.filter((pinnedId) => pinnedId !== id)
    : [...pinnedIds, id];
}
