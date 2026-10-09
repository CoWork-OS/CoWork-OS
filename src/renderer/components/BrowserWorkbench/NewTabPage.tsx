import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  ArrowRight,
  ArrowUp,
  ClipboardList,
  FileSpreadsheet,
  FormInput,
  Globe2,
  History,
  Monitor,
  MousePointerClick,
  PencilLine,
  Repeat,
  ScanLine,
  Search,
  Sparkles,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

type BrowserCapability = {
  label: string;
  prompt: string;
  icon: LucideIcon;
};

type CapabilityGroup = { title: string; tone: string; items: BrowserCapability[] };

const CAPABILITY_GROUPS: CapabilityGroup[] = [
  {
    title: "Research",
    tone: "research",
    items: [
      {
        label: "Research a topic",
        prompt:
          "Use the in-app browser to research the latest news on a topic of my choosing. Open the top 5 results, read each page, and summarize the key takeaways with citations. Ask me what topic to research first.",
        icon: Search,
      },
      {
        label: "Compare sites",
        prompt:
          "Browse a few sites I'll name and compare them on dimensions I care about (price, features, reviews). Use the in-app browser to visit each, then report back with a structured comparison.",
        icon: ClipboardList,
      },
      {
        label: "Watch for changes",
        prompt:
          "Open a page in the in-app browser, capture its current state, and recheck it on a cadence I choose. Tell me when something material changes. Ask me for the URL and what to watch for.",
        icon: Repeat,
      },
    ],
  },
  {
    title: "Automate",
    tone: "automate",
    items: [
      {
        label: "Fill out a form",
        prompt:
          "Open a form URL I'll provide in the in-app browser and help me fill it in step by step. Ask me which form and what values to enter, then walk through each field.",
        icon: FormInput,
      },
      {
        label: "Run a workflow",
        prompt:
          "Walk through a multi-step web workflow I'll describe — clicking buttons, filling fields, and waiting for transitions — using the in-app browser. Confirm each step before moving on.",
        icon: MousePointerClick,
      },
      {
        label: "Data behind a login",
        prompt:
          "Use the in-app browser (which keeps me logged in) to open a dashboard or service I'll name and pull out the metrics I care about. Ask me for the URL and which numbers to grab.",
        icon: ScanLine,
      },
    ],
  },
  {
    title: "Capture",
    tone: "capture",
    items: [
      {
        label: "Extract to a sheet",
        prompt:
          "Open a URL I'll give you in the in-app browser, then extract the main table or list of items into a spreadsheet in this workspace. Ask me for the URL and what fields to capture.",
        icon: FileSpreadsheet,
      },
      {
        label: "Annotate a page",
        prompt:
          "Open a URL I'll give you in the in-app browser, take a screenshot of the most important section, and save it to this workspace. Ask me what to highlight.",
        icon: PencilLine,
      },
      {
        label: "Test layouts",
        prompt:
          "Use the in-app browser to test my app at desktop, tablet, and mobile viewport sizes. Click through the main flow at each breakpoint, capture screenshots of any layout issues, and summarize what changed.",
        icon: Monitor,
      },
    ],
  },
];

type SiteLink = { key: string; url: string; title: string; favicon?: string; onOpen: () => void };

type NewTabPageProps = {
  onSendMessage?: (message: string) => Promise<void>;
  onNotice: (message: string) => void;
  openTabs: Array<{ id: string; url: string; title: string; favicon?: string }>;
  recentlyClosed: Array<{ url: string; title: string }>;
  /** Recently visited pages from history. */
  recentHistory?: Array<{ url: string; title: string }>;
  onSwitchTab: (tabId: string) => void;
  onOpenUrl: (url: string) => void;
};

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** A stable tint per site for the letter avatar. */
function siteHue(host: string): number {
  let hash = 0;
  for (const char of host) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

function SiteTile({ link }: { link: SiteLink }) {
  const host = hostOf(link.url);
  return (
    <button type="button" className="browser-newtab-site" onClick={link.onOpen} title={link.url}>
      <span
        className="browser-newtab-site-icon"
        style={{ "--site-hue": siteHue(host) } as CSSProperties}
        aria-hidden="true"
      >
        {link.favicon ? (
          <img src={link.favicon} alt="" />
        ) : (
          (host.match(/[a-z0-9]/i)?.[0] || "·").toUpperCase()
        )}
      </span>
      <span className="browser-newtab-site-text">
        <span className="browser-newtab-site-title">{link.title || host}</span>
        <span className="browser-newtab-site-host">{host}</span>
      </span>
    </button>
  );
}

/**
 * New-tab page: ask CoWork to do something on the web, task ideas grouped by
 * kind, and the pages to jump back to (open tabs, recent history, recently closed).
 */
export function NewTabPage({
  onSendMessage,
  onNotice,
  openTabs,
  recentlyClosed,
  recentHistory = [],
  onSwitchTab,
  onOpenUrl,
}: NewTabPageProps) {
  const [draft, setDraft] = useState("");
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  // Grow with the text, up to a few lines.
  useEffect(() => {
    const field = draftRef.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, 160)}px`;
  }, [draft]);
  const canSend = Boolean(onSendMessage);

  const send = (message: string, label?: string) => {
    const text = message.trim();
    if (!onSendMessage || !text) return;
    void onSendMessage(text);
    onNotice(label ? `Sent: ${label}` : "Sent to CoWork");
    setDraft("");
  };

  const seen = new Set<string>();
  const jumpBack: SiteLink[] = [];
  for (const tab of openTabs) {
    if (!tab.url || seen.has(tab.url)) continue;
    seen.add(tab.url);
    jumpBack.push({ key: `tab:${tab.id}`, ...tab, onOpen: () => onSwitchTab(tab.id) });
  }
  for (const page of recentHistory) {
    if (seen.has(page.url)) continue;
    seen.add(page.url);
    jumpBack.push({ key: `recent:${page.url}`, ...page, onOpen: () => onOpenUrl(page.url) });
  }
  const closed = recentlyClosed.filter((page) => page.url && !seen.has(page.url)).slice(0, 5);

  return (
    <div className="browser-newtab">
      <div className="browser-newtab-inner">
        <header className="browser-newtab-header">
          <span className="browser-newtab-mark" aria-hidden="true">
            <Sparkles size={16} strokeWidth={2} />
          </span>
          <div>
            <h2 className="browser-newtab-title">Ask CoWork to use this browser</h2>
            <p className="browser-newtab-subtitle">
              It sees this tab and can search, click, type and read pages while you watch.
            </p>
          </div>
        </header>
        <form
          className={`browser-newtab-composer ${canSend ? "" : "is-disabled"}`}
          onSubmit={(event) => {
            event.preventDefault();
            send(draft);
          }}
        >
          <textarea
            ref={draftRef}
            value={draft}
            rows={2}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                send(draft);
              }
            }}
            placeholder={
              canSend
                ? "e.g. Log into my analytics dashboard and summarize this week's traffic"
                : "Open the browser in full view to ask CoWork"
            }
            disabled={!canSend}
            aria-label="Ask CoWork"
          />
          <div className="browser-newtab-composer-footer">
            <span className="browser-newtab-composer-hint">
              <Globe2 size={13} strokeWidth={2} aria-hidden="true" />
              Uses this browser and its signed-in sites
            </span>
            <button
              type="submit"
              className="browser-newtab-send"
              disabled={!canSend || !draft.trim()}
              aria-label="Send to CoWork"
              title="Send (Enter)"
            >
              <ArrowUp size={15} strokeWidth={2.4} aria-hidden="true" />
            </button>
          </div>
        </form>
        <div className="browser-newtab-groups">
          {CAPABILITY_GROUPS.map((group) => (
            <section
              key={group.title}
              className={`browser-newtab-group is-${group.tone}`}
              aria-label={group.title}
            >
              <h3>{group.title}</h3>
              {group.items.map((capability) => {
                const Icon = capability.icon;
                return (
                  <button
                    key={capability.label}
                    type="button"
                    className="browser-newtab-idea"
                    onClick={() => send(capability.prompt, capability.label)}
                    disabled={!canSend}
                    title={
                      canSend ? capability.prompt : "Open the browser in full view to send tasks"
                    }
                  >
                    <span className="browser-newtab-idea-icon" aria-hidden="true">
                      <Icon size={14} strokeWidth={2} />
                    </span>
                    <span className="browser-newtab-idea-label">{capability.label}</span>
                    <ArrowRight
                      className="browser-newtab-idea-go"
                      size={13}
                      strokeWidth={2}
                      aria-hidden="true"
                    />
                  </button>
                );
              })}
            </section>
          ))}
        </div>
        {jumpBack.length > 0 && (
          <section className="browser-newtab-section" aria-label="Jump back in">
            <h3>Jump back in</h3>
            <div className="browser-newtab-sites">
              {jumpBack.slice(0, 8).map((link) => (
                <SiteTile key={link.key} link={link} />
              ))}
            </div>
          </section>
        )}
        {closed.length > 0 && (
          <section className="browser-newtab-section" aria-label="Recently closed">
            <h3>Recently closed</h3>
            <div className="browser-newtab-closed">
              {closed.map((page, index) => (
                <button
                  key={`${page.url}-${index}`}
                  type="button"
                  onClick={() => onOpenUrl(page.url)}
                  title={page.url}
                >
                  <History size={13} aria-hidden="true" />
                  <span>{page.title || hostOf(page.url)}</span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
