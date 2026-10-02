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

/**
 * `railOrder` is the user's order for the fixed rail items; items it doesn't
 * name (new destinations, say) keep their default order after the ones it does.
 */
export function getSidebarRailLayout(
  context: SidebarDestinationContext,
  pinnedIds: readonly SidebarDestinationId[],
  railOrder: readonly SidebarDestinationId[] = [],
): SidebarRailLayout {
  const visible = SIDEBAR_DESTINATIONS.filter(
    (destination) => destination.isVisible?.(context) ?? true,
  );
  const more = visible.filter((destination) => destination.placement === "more");
  const pinned = pinnedIds
    .map((id) => more.find((destination) => destination.id === id))
    .filter((destination): destination is SidebarDestination => Boolean(destination));
  const rank = (id: SidebarDestinationId) => {
    const index = railOrder.indexOf(id);
    return index === -1 ? railOrder.length : index;
  };
  const rail = visible
    .filter((destination) => destination.placement === "rail")
    .map((destination, index) => ({ destination, index }))
    .sort((a, b) => rank(a.destination.id) - rank(b.destination.id) || a.index - b.index)
    .map(({ destination }) => destination);
  return { rail, pinned, more };
}

/**
 * Whether `railOrder` puts the fixed items in anything but the theme's default
 * order. Moving items back where they started doesn't count.
 */
export function isCustomSidebarRailOrder(
  context: SidebarDestinationContext,
  railOrder: readonly SidebarDestinationId[],
): boolean {
  const ordered = getSidebarRailLayout(context, [], railOrder).rail;
  const defaults = getSidebarRailLayout(context, []).rail;
  return ordered.some((destination, index) => destination.id !== defaults[index]?.id);
}

/** Destinations ⌘1–⌘9 open: the rail top to bottom, pinned items included. */
export const SIDEBAR_RAIL_SHORTCUT_LIMIT = 9;

export function getSidebarRailShortcutTargets(layout: SidebarRailLayout): SidebarDestination[] {
  return [...layout.rail, ...layout.pinned].slice(0, SIDEBAR_RAIL_SHORTCUT_LIMIT);
}

/** Moves `id` next to `targetId`; returns the list unchanged when either is missing. */
export function moveSidebarDestination(
  ids: readonly SidebarDestinationId[],
  id: SidebarDestinationId,
  targetId: SidebarDestinationId,
  position: "before" | "after",
): SidebarDestinationId[] {
  if (id === targetId || !ids.includes(id) || !ids.includes(targetId)) return [...ids];
  const rest = ids.filter((candidate) => candidate !== id);
  const targetIndex = rest.indexOf(targetId);
  rest.splice(position === "before" ? targetIndex : targetIndex + 1, 0, id);
  return rest;
}

/** Moves `id` one place up (-1) or down (1), stopping at either end. */
export function shiftSidebarDestination(
  ids: readonly SidebarDestinationId[],
  id: SidebarDestinationId,
  delta: -1 | 1,
): SidebarDestinationId[] {
  const index = ids.indexOf(id);
  const target = ids[index + delta];
  if (index === -1 || !target) return [...ids];
  return moveSidebarDestination(ids, id, target, delta < 0 ? "before" : "after");
}

export const SIDEBAR_RAIL_STORAGE_KEY = "cowork.sidebar.rail.v1";
export const DEFAULT_PINNED_SIDEBAR_DESTINATIONS: readonly SidebarDestinationId[] = ["devices"];

function isPlacedDestinationId(
  value: unknown,
  placement: SidebarDestination["placement"],
): value is SidebarDestinationId {
  return (
    typeof value === "string" &&
    DESTINATIONS_BY_ID.get(value as SidebarDestinationId)?.placement === placement
  );
}

/** The stored rail preferences: pins, and the user's order for the fixed items. */
interface StoredRailPreferences {
  pinned?: unknown;
  order?: unknown;
}

function readRailPreferences(
  storage: Pick<Storage, "getItem"> | undefined,
): StoredRailPreferences | null {
  try {
    const raw = storage?.getItem(SIDEBAR_RAIL_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as StoredRailPreferences) : null;
  } catch {
    return null;
  }
}

/** Updates one field and keeps the others, so pinning doesn't reset the order. */
function writeRailPreference(
  field: keyof StoredRailPreferences,
  value: readonly SidebarDestinationId[] | undefined,
  storage: Pick<Storage, "getItem" | "setItem"> | undefined,
): void {
  try {
    const next = { ...readRailPreferences(storage) };
    if (value === undefined) delete next[field];
    else next[field] = value;
    storage?.setItem(SIDEBAR_RAIL_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Rail layout is a convenience preference; keep the in-memory state if storage fails.
  }
}

/** Pinned More items in pin order. Falls back to the defaults until the user pins or unpins. */
export function readPinnedSidebarDestinations(
  storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage,
): SidebarDestinationId[] {
  const pinned = readRailPreferences(storage)?.pinned;
  if (!Array.isArray(pinned)) return [...DEFAULT_PINNED_SIDEBAR_DESTINATIONS];
  return [...new Set(pinned.filter((id) => isPlacedDestinationId(id, "more")))];
}

export function writePinnedSidebarDestinations(
  pinnedIds: readonly SidebarDestinationId[],
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = globalThis.localStorage,
): void {
  writeRailPreference("pinned", pinnedIds, storage);
}

/** The user's order for the fixed rail items; empty until they reorder. */
export function readSidebarRailOrder(
  storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage,
): SidebarDestinationId[] {
  const order = readRailPreferences(storage)?.order;
  if (!Array.isArray(order)) return [];
  return [...new Set(order.filter((id) => isPlacedDestinationId(id, "rail")))];
}

/** Pass an empty list to go back to the default order. */
export function writeSidebarRailOrder(
  order: readonly SidebarDestinationId[],
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = globalThis.localStorage,
): void {
  writeRailPreference("order", order.length > 0 ? order : undefined, storage);
}

export function togglePinnedSidebarDestination(
  pinnedIds: readonly SidebarDestinationId[],
  id: SidebarDestinationId,
): SidebarDestinationId[] {
  return pinnedIds.includes(id)
    ? pinnedIds.filter((pinnedId) => pinnedId !== id)
    : [...pinnedIds, id];
}
