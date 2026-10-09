import {
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
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

type BrowserCapability = {
  label: string;
  hint: string;
  prompt: string;
  icon: LucideIcon;
  accent: string;
};

const BROWSER_CAPABILITIES: BrowserCapability[] = [
  {
    label: "Research a topic",
    hint: "Search, read across sources, summarize",
    prompt:
      "Use the in-app browser to research the latest news on a topic of my choosing. Open the top 5 results, read each page, and summarize the key takeaways with citations. Ask me what topic to research first.",
    icon: Search,
    accent: "#4f46e5",
  },
  {
    label: "Extract data into a sheet",
    hint: "Scrape tables and lists from any page",
    prompt:
      "Open a URL I'll give you in the in-app browser, then extract the main table or list of items into a spreadsheet in this workspace. Ask me for the URL and what fields to capture.",
    icon: FileSpreadsheet,
    accent: "#059669",
  },
  {
    label: "Fill out a form",
    hint: "Navigate, type, click, submit",
    prompt:
      "Open a form URL I'll provide in the in-app browser and help me fill it in step by step. Ask me which form and what values to enter, then walk through each field.",
    icon: FormInput,
    accent: "#0ea5e9",
  },
  {
    label: "Compare across sites",
    hint: "Visit several pages, build a comparison",
    prompt:
      "Browse a few sites I'll name and compare them on dimensions I care about (price, features, reviews). Use the in-app browser to visit each, then report back with a structured comparison.",
    icon: ClipboardList,
    accent: "#d97706",
  },
  {
    label: "Capture annotated screenshots",
    hint: "Visit a page, mark the highlights",
    prompt:
      "Open a URL I'll give you in the in-app browser, take a screenshot of the most important section, and save it to this workspace. Ask me what to highlight.",
    icon: PencilLine,
    accent: "#db2777",
  },
  {
    label: "Click through a workflow",
    hint: "Drive multi-step UIs end to end",
    prompt:
      "Walk through a multi-step web workflow I'll describe — clicking buttons, filling fields, and waiting for transitions — using the in-app browser. Confirm each step before moving on.",
    icon: MousePointerClick,
    accent: "#7c3aed",
  },
  {
    label: "Test responsive layouts",
    hint: "Check desktop, tablet, and mobile breakpoints",
    prompt:
      "Use the in-app browser to test my app at desktop, tablet, and mobile viewport sizes. Click through the main flow at each breakpoint, capture screenshots of any layout issues, and summarize what changed.",
    icon: Monitor,
    accent: "#2563eb",
  },
  {
    label: "Watch a page for changes",
    hint: "Re-check on a schedule",
    prompt:
      "Open a page in the in-app browser, capture its current state, and recheck it on a cadence I choose. Tell me when something material changes. Ask me for the URL and what to watch for.",
    icon: Repeat,
    accent: "#0891b2",
  },
  {
    label: "Pull data behind a login",
    hint: "Use the signed-in browser session",
    prompt:
      "Use the in-app browser (which keeps me logged in) to open a dashboard or service I'll name and pull out the metrics I care about. Ask me for the URL and which numbers to grab.",
    icon: ScanLine,
    accent: "#ea580c",
  },
];

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

/** New-tab page: example tasks for CoWork OS, open tabs and recently closed pages. */
export function NewTabPage({
  onSendMessage,
  onNotice,
  openTabs,
  recentlyClosed,
  recentHistory = [],
  onSwitchTab,
  onOpenUrl,
}: NewTabPageProps) {
  return (
    <div className="browser-workbench-newtab">
      <div className="browser-workbench-newtab-inner">
        <div className="browser-workbench-newtab-hero">
          <span className="browser-workbench-newtab-eyebrow">In-app browser</span>
          <h2 className="browser-workbench-newtab-title">Let CoWork OS drive this browser</h2>
          <p className="browser-workbench-newtab-subtitle">
            CoWork OS can see this tab and use it on your behalf — searching, clicking, filling
            forms, and pulling data — while you watch. Pick an example to send to CoWork OS, or type
            a URL above to browse manually.
          </p>
        </div>
        <div className="browser-workbench-newtab-grid">
          {BROWSER_CAPABILITIES.map((capability) => {
            const Icon = capability.icon;
            const disabled = !onSendMessage;
            return (
              <button
                key={capability.label}
                type="button"
                className="browser-workbench-newtab-tile"
                onClick={() => {
                  if (!onSendMessage) return;
                  void onSendMessage(capability.prompt);
                  onNotice(`Sent: ${capability.label}`);
                }}
                disabled={disabled}
                title={
                  disabled
                    ? "Open the workbench in fullscreen to send tasks to CoWork OS"
                    : capability.prompt
                }
              >
                <span
                  className="browser-workbench-newtab-tile-icon"
                  style={{
                    color: capability.accent,
                    background: `${capability.accent}1f`,
                  }}
                >
                  <Icon size={18} strokeWidth={2.2} aria-hidden="true" />
                </span>
                <span className="browser-workbench-newtab-tile-text">
                  <span className="browser-workbench-newtab-tile-label">{capability.label}</span>
                  <span className="browser-workbench-newtab-tile-hint">{capability.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
        {openTabs.length > 0 && (
          <section className="browser-workbench-newtab-section" aria-label="Open tabs">
            <h3>Open tabs</h3>
            <div className="browser-workbench-newtab-links">
              {openTabs.slice(0, 8).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => onSwitchTab(tab.id)}
                  title={tab.url}
                >
                  {tab.favicon ? (
                    <img src={tab.favicon} alt="" />
                  ) : (
                    <Globe2 size={13} aria-hidden="true" />
                  )}
                  <span>{tab.title || tab.url}</span>
                </button>
              ))}
            </div>
          </section>
        )}
        {recentHistory.length > 0 && (
          <section className="browser-workbench-newtab-section" aria-label="Recent">
            <h3>Recent</h3>
            <div className="browser-workbench-newtab-links">
              {recentHistory.slice(0, 8).map((page) => (
                <button
                  key={page.url}
                  type="button"
                  onClick={() => onOpenUrl(page.url)}
                  title={page.url}
                >
                  <Globe2 size={13} aria-hidden="true" />
                  <span>{page.title || page.url}</span>
                </button>
              ))}
            </div>
          </section>
        )}
        {recentlyClosed.length > 0 && (
          <section className="browser-workbench-newtab-section" aria-label="Recently closed">
            <h3>Recently closed</h3>
            <div className="browser-workbench-newtab-links">
              {recentlyClosed.slice(0, 8).map((page, index) => (
                <button
                  key={`${page.url}-${index}`}
                  type="button"
                  onClick={() => onOpenUrl(page.url)}
                  title={page.url}
                >
                  <History size={13} aria-hidden="true" />
                  <span>{page.title || page.url}</span>
                </button>
              ))}
            </div>
          </section>
        )}
        <p className="browser-workbench-newtab-footnote">
          Tip: ask in your own words too — "log into &lt;site&gt; and grab today's report" or "open
          this URL and click the third row" both work.
        </p>
      </div>
    </div>
  );
}
