import { useState, type ComponentType } from "react";
import {
  ChevronDown,
  ChevronRight,
  Ellipsis,
  Inbox,
  Library,
  Lightbulb,
  Monitor,
  Plus,
  Puzzle,
  Search,
  Settings,
  Sparkles,
  Users,
  Workflow,
} from "lucide-react";
import { CalmAgentAvatar } from "./CalmAgentAvatar";
import { openCalmAgentSetup } from "./CalmAgentSetup";

export type CalmSidebarSegment = "home" | "build" | "agents";

interface NavItem {
  id: string;
  label: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  active?: boolean;
  badge?: number;
  onClick?: () => void;
}

export interface CalmSidebarNavProps {
  segment: CalmSidebarSegment;
  onSegmentChange: (segment: CalmSidebarSegment) => void;
  onNew: () => void;
  onSearch: () => void;
  isSearchActive?: boolean;
  onOpenLibrary?: () => void;
  isLibraryActive?: boolean;
  onOpenPlugins?: () => void;
  onOpenAutomations?: () => void;
  isAutomationsActive?: boolean;
  more: {
    inboxLabel: string;
    inboxUnread?: number;
    onOpenInbox?: () => void;
    isInboxActive?: boolean;
    onOpenEveryday?: () => void;
    isEverydayActive?: boolean;
    onOpenDevices?: () => void;
    isDevicesActive?: boolean;
    onOpenMissionControl?: () => void;
    isMissionControlActive?: boolean;
    onOpenIdeas?: () => void;
    isIdeasActive?: boolean;
  };
}

const SEGMENTS: Array<{ id: CalmSidebarSegment; label: string }> = [
  { id: "home", label: "Home" },
  { id: "build", label: "Build" },
  { id: "agents", label: "Agents" },
];

function NavButton({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      className={`calm-nav-item ${item.active ? "active" : ""}`}
      onClick={item.onClick}
      aria-pressed={item.active}
    >
      <Icon size={16} strokeWidth={1.8} />
      <span className="calm-nav-item-label">{item.label}</span>
      {typeof item.badge === "number" && item.badge > 0 && (
        <span className="calm-nav-item-badge">{item.badge > 99 ? "99+" : item.badge}</span>
      )}
    </button>
  );
}

/** Calm-theme sidebar header: product switch plus a short, fixed nav list. */
export function CalmSidebarNav(props: CalmSidebarNavProps) {
  const { more } = props;
  const moreActive = Boolean(
    more.isInboxActive ||
    more.isEverydayActive ||
    more.isDevicesActive ||
    more.isMissionControlActive ||
    more.isIdeasActive,
  );
  const [moreOpen, setMoreOpen] = useState(moreActive);
  const showMore = moreOpen || moreActive;

  const primary: NavItem[] = [
    {
      id: "search",
      label: "Search",
      icon: Search,
      active: props.isSearchActive,
      onClick: props.onSearch,
    },
    {
      id: "library",
      label: "Library",
      icon: Library,
      active: props.isLibraryActive,
      onClick: props.onOpenLibrary,
    },
    { id: "plugins", label: "Plugins", icon: Puzzle, onClick: props.onOpenPlugins },
    {
      id: "automations",
      label: "Automations",
      icon: Workflow,
      active: props.isAutomationsActive,
      onClick: props.onOpenAutomations,
    },
  ];

  const secondary: NavItem[] = [
    {
      id: "inbox",
      label: more.inboxLabel,
      icon: Inbox,
      active: more.isInboxActive,
      badge: more.inboxUnread,
      onClick: more.onOpenInbox,
    },
    {
      id: "everyday",
      label: "Everyday",
      icon: Sparkles,
      active: more.isEverydayActive,
      onClick: more.onOpenEveryday,
    },
    {
      id: "devices",
      label: "Devices",
      icon: Monitor,
      active: more.isDevicesActive,
      onClick: more.onOpenDevices,
    },
    {
      id: "mission",
      label: "Mission Control",
      icon: Users,
      active: more.isMissionControlActive,
      onClick: more.onOpenMissionControl,
    },
    {
      id: "ideas",
      label: "Ideas",
      icon: Lightbulb,
      active: more.isIdeasActive,
      onClick: more.onOpenIdeas,
    },
  ].filter((item) => Boolean(item.onClick));

  return (
    <div className="calm-sidebar-header">
      <div className="calm-sidebar-brand">CoWork</div>
      <div className="calm-segmented calm-sidebar-segments" role="tablist" aria-label="Workspace">
        {SEGMENTS.map((segment) => (
          <button
            key={segment.id}
            type="button"
            role="tab"
            aria-selected={props.segment === segment.id}
            className={props.segment === segment.id ? "active" : ""}
            onClick={() => props.onSegmentChange(segment.id)}
          >
            {segment.label}
          </button>
        ))}
      </div>

      <nav className="calm-nav" aria-label="Main">
        <button type="button" className="calm-nav-item calm-nav-new" onClick={props.onNew}>
          <span className="calm-nav-new-icon" aria-hidden="true">
            <Plus size={14} strokeWidth={2.4} />
          </span>
          <span className="calm-nav-item-label">New</span>
        </button>
        {primary.map((item) => (
          <NavButton key={item.id} item={item} />
        ))}
        {secondary.length > 0 && (
          <button
            type="button"
            className={`calm-nav-item ${moreActive && !showMore ? "active" : ""}`}
            onClick={() => setMoreOpen((value) => !value)}
            aria-expanded={showMore}
          >
            <Ellipsis size={16} strokeWidth={1.8} />
            <span className="calm-nav-item-label">More</span>
            {showMore ? (
              <ChevronDown size={14} className="calm-nav-item-chevron" />
            ) : (
              <ChevronRight size={14} className="calm-nav-item-chevron" />
            )}
          </button>
        )}
        {showMore && (
          <div className="calm-nav-more">
            {secondary.map((item) => (
              <NavButton key={item.id} item={item} />
            ))}
          </div>
        )}
      </nav>
    </div>
  );
}

interface CalmSidebarProfileProps {
  agentName?: string;
  onOpenSettings: () => void;
}

/** Calm-theme sidebar footer: who is signed in, who they work with, settings. */
export function CalmSidebarProfile({ agentName, onOpenSettings }: CalmSidebarProfileProps) {
  // The footer shows the assistant name saved in Settings → Personality;
  // "CoWork OS" only when none is set.
  const name = agentName?.trim() || "CoWork OS";
  return (
    <div className="calm-profile">
      <button
        type="button"
        className="calm-profile-identity"
        onClick={openCalmAgentSetup}
        title="Change your agent's name and look"
      >
        <span className="calm-profile-avatar calm-profile-avatar-agent" aria-hidden="true">
          <CalmAgentAvatar size={20} />
        </span>
        <span className="calm-profile-name">{name}</span>
      </button>
      <button
        type="button"
        className="calm-icon-button"
        onClick={onOpenSettings}
        title="Settings"
        aria-label="Settings"
      >
        <Settings size={16} strokeWidth={1.8} />
      </button>
    </div>
  );
}
