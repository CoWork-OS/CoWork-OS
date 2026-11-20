import React, { Profiler, useState } from "react";
import { createRoot } from "react-dom/client";
import { ScheduledTasksSettings } from "../../../src/renderer/components/ScheduledTasksSettings";
import { InboxAgentPanel } from "../../../src/renderer/components/InboxAgentPanel";
import { ImageLightbox } from "../../../src/renderer/components/ImageLightbox";
import { FullAccessConfirmationDialog } from "../../../src/renderer/components/FullAccessConfirmationDialog";
import { ModalDialog } from "../../../src/renderer/components/ModalDialog";
import { MCPLaunchPlanReview } from "../../../src/renderer/components/MCPLaunchPlanReview";
import { CalmAccessMenu } from "../../../src/renderer/components/calm/CalmTopBar";
import { SidebarRail } from "../../../src/renderer/components/sidebar/SidebarRail";
import { DocumentArtifactCard } from "../../../src/renderer/components/DocumentArtifactCard";
import { SpreadsheetArtifactCard } from "../../../src/renderer/components/SpreadsheetArtifactCard";
import { WebArtifactCard } from "../../../src/renderer/components/WebArtifactCard";
import { PresentationArtifactCard } from "../../../src/renderer/components/PresentationArtifactCard";
import { NotificationPanel } from "../../../src/renderer/components/NotificationPanel";
import { ChatGPTImportWizard } from "../../../src/renderer/components/ChatGPTImportWizard";
import { MCPRegistryBrowser } from "../../../src/renderer/components/MCPRegistryBrowser";
import { FileHub } from "../../../src/renderer/components/FileHub";
import AutomationStudioPanel from "../../../src/renderer/components/AutomationStudioPanel";
import { SidebarArchivedSessions } from "../../../src/renderer/components/sidebar/SidebarArchivedSessions";
import { WorkView } from "../../../src/renderer/components/work/WorkView";
import { RightPanel } from "../../../src/renderer/components/RightPanel";
import { SearchSettings } from "../../../src/renderer/components/SearchSettings";
import { WorkspaceDropdownMenu } from "../../../src/renderer/components/MainContent/WorkspaceDropdownMenu";
import "../../../src/renderer/styles/index.css";
import "../../../src/renderer/styles/calm-theme.css";
import "../../../src/renderer/components/MainContent/main-content.css";

const qa = (window.qa = {
  commits: [],
  calls: [],
  holdThreads: new Set(),
  pending: new Map(),
  mailboxEvents: new Set(),
  holdList: false,
  pendingLists: [],
  holdGoogle: false,
  resolveGoogle: null,
  failHubListing: false,
  resolveHubSearch: null,
  resolveHubRecent: null,
  resolveCompletedRunSteps: null,
  approvalRunCancelled: false,
  connectorChanges: [],
  searchPrimary: "google",
  resolveThread(id) {
    for (const done of this.pending.get(id) || []) done(detail(id));
    this.pending.delete(id);
    this.holdThreads.delete(id);
  },
  resolveList(index, ids) {
    this.pendingLists[index](ids.map(thread));
  },
});
const account = {
  id: "account-1",
  provider: "imap",
  address: "owner@example.com",
  displayName: "Mailbox",
  connected: true,
  capabilities: ["send", "forward", "mark_read"],
};
function thread(id) {
  return {
    id,
    accountId: account.id,
    provider: "imap",
    providerThreadId: id,
    subject: `Subject ${id}`,
    snippet: `Preview ${id}`,
    participants: [{ email: `${id}@example.com`, name: `Sender ${id}` }],
    labels: [],
    category: "updates",
    todayBucket: "good_to_know",
    domainCategory: "ops",
    priorityBand: "low",
    priorityScore: 0,
    urgencyScore: 0,
    needsReply: false,
    staleFollowup: false,
    cleanupCandidate: false,
    handled: false,
    unreadCount: 0,
    messageCount: 1,
    lastMessageAt: Date.now(),
  };
}
function detail(id) {
  return {
    ...thread(id),
    messages: [
      {
        id: `message-${id}`,
        direction: "incoming",
        from: { email: `${id}@example.com` },
        to: [{ email: account.address }],
        cc: [],
        subject: `Subject ${id}`,
        body: `Message body ${id}`,
        receivedAt: Date.now(),
        attachments: [],
        labels: [],
      },
    ],
    drafts: [],
    proposals: [],
    commitments: [],
  };
}
const status = {
  connected: true,
  accounts: [account],
  syncInFlight: false,
  lastSyncedAt: Date.now(),
  threadCount: 2,
  unreadCount: 0,
  needsReplyCount: 0,
  proposalCount: 0,
  commitmentCount: 0,
  classificationPendingCount: 0,
  statusLabel: "Up to date",
};
const server = {
  id: "docs",
  name: "Docs",
  description: "Read documents",
  version: "1",
  author: "Example",
  installMethod: "npm",
  transport: "stdio",
  tools: [],
  tags: ["documents"],
  verified: true,
};
function hubFile(name, source) {
  return {
    id: name,
    name,
    source,
    path: `/fixture/${name}`,
    mimeType: "text/plain",
    size: 10,
    modifiedAt: 1,
  };
}
const previewFiles = {
  "overview.md":
    "# Overview\n\n[Jump within](#local-section)\n\n[Open target](detail.md#deep-section)\n\n" +
    "A section of text.\n\n".repeat(50) +
    "## Local section",
  "detail.md": "# Details\n\n" + "A section of text.\n\n".repeat(50) + "## Deep section",
};
const archivedRows = Array.from({ length: 202 }, (_, index) => ({
  id: `archive-${index}`,
  title: index === 201 ? "Older archive fixture" : `Archived session ${index}`,
  sessionArchived: true,
  sessionArchivedAt: 202 - index,
  updatedAt: 1,
  createdAt: 1,
}));
const workTasks = Array.from({ length: 10 }, (_, index) => ({
  id: `work-${index + 1}`,
  title: `Work session ${index + 1}`,
  prompt: "",
  workspaceId: "fixture",
  status: "completed" as const,
  createdAt: 1000 - index,
  updatedAt: 1000 - index,
}));
const connectorTask = {
  id: "scope-fixture",
  title: "Connector scope fixture",
  status: "completed" as const,
  prompt: "",
  workspaceId: "fixture",
  createdAt: 1,
  updatedAt: 1,
};
const pickerFolders = ["Alpha folder", "Beta folder"].map((name) => ({
  id: name,
  name,
  path: `/fixture/${name}`,
  createdAt: 1,
  permissions: { read: true, write: true, delete: false, network: false, shell: false },
}));
const reviewNotice = {
  id: "memory-review",
  type: "info",
  title: "Review saved memories",
  message: "Review the new memory suggestions.",
  read: false,
  createdAt: Date.now(),
  openTarget: "memory_review",
};
const notificationEvents = new Set();
let notifications = [reviewNotice];
window.electronAPI = new Proxy(
  {
    getSessionMembers: async () => ({ members: [], invites: [], actor: { role: "owner" } }),
    getSessionProgress: async () => undefined,
    getActiveContext: async () => ({
      connectors: ["Alpha", "Beta"].map((name) => ({
        id: name.toLowerCase(),
        name,
        icon: "",
        status: "connected",
        tools: [],
      })),
      skills: [],
    }),
    setTaskConnectorOff: (change) =>
      new Promise((resolve, reject) => {
        qa.connectorChanges.push({ change, resolve, reject });
      }),
    getSearchConfigStatus: async () => ({
      primaryProvider: qa.searchPrimary,
      fallbackProvider: null,
      providers: [
        { type: "google", name: "Google Custom Search", configured: true, supportedTypes: ["web"] },
        { type: "duckduckgo", name: "DuckDuckGo", configured: true, supportedTypes: ["web"] },
      ],
      isConfigured: true,
      searxng: { allowPrivate: false },
    }),
    saveSearchSettings: async (options) => {
      qa.calls.push({ method: "saveSearchSettings", options });
      qa.searchPrimary = options.primaryProvider;
    },
    getMailboxSyncStatus: async () => status,
    getMailboxClientState: async () => ({
      accounts: [account],
      queuedActions: [],
      composeDrafts: [],
      syncHealth: [],
      folders: [],
    }),
    getMailboxThread: (id) =>
      qa.holdThreads.has(id)
        ? new Promise((resolve) => qa.pending.set(id, [...(qa.pending.get(id) || []), resolve]))
        : Promise.resolve(detail(id)),
    listMailboxThreads: (options) => {
      qa.calls.push({ method: "listMailboxThreads", options });
      return qa.holdList
        ? new Promise((resolve) => qa.pendingLists.push(resolve))
        : Promise.resolve([thread("A"), thread("B")]);
    },
    getGoogleWorkspaceSettings: () =>
      qa.holdGoogle
        ? new Promise((resolve) => {
            qa.resolveGoogle = resolve;
          })
        : Promise.resolve({ enabled: false }),
    getVoiceSettings: async () => ({ enabled: false }),
    getMailboxDigest: async () => null,
    getMailboxSenderCleanupDigest: async () => null,
    getMailboxQuickReplySuggestions: async () => ({ suggestions: [] }),
    onMailboxEvent: (cb) => {
      qa.mailboxEvents.add(cb);
      return () => qa.mailboxEvents.delete(cb);
    },
    fetchMCPRegistry: async () => ({ servers: [server] }),
    searchMCPRegistry: async (query, tags) => {
      qa.calls.push({ method: "searchMCPRegistry", query, tags });
      return [server];
    },
    listNotifications: async () => notifications,
    getUnreadNotificationCount: async () => notifications.length,
    onNotificationEvent: (callback) => {
      notificationEvents.add(callback);
      return () => notificationEvents.delete(callback);
    },
    markNotificationRead: async (id) => {
      qa.calls.push({ method: "markNotificationRead", id });
    },
    deleteNotification: async (id) => {
      qa.calls.push({ method: "deleteNotification", id });
      const notification = notifications.find((item) => item.id === id);
      if (notification) {
        notifications = notifications.filter((item) => item.id !== id);
        notificationEvents.forEach((callback) => callback({ type: "removed", notification }));
      }
    },
    selectFiles: async () => {
      qa.calls.push({ method: "selectFiles" });
      return [];
    },
    getLLMSettings: async () => ({}),
    getHubSources: async () => ["local", "artifacts"],
    getRecentHubFiles: () =>
      new Promise((resolve) => {
        qa.resolveHubRecent = () =>
          resolve([hubFile("previous.txt", "local"), hubFile("overview.md", "local")]);
      }),
    openFile: async () => "File not found",
    listHubFiles: async ({ source }) => {
      if (qa.failHubListing) throw new Error("Fixture list failed");
      return (source === "artifacts" ? ["report.txt"] : ["local-notes.txt", "overview.md"]).map(
        (name) => hubFile(name, source),
      );
    },
    searchHubFiles: () =>
      new Promise((resolve) => {
        qa.resolveHubSearch = () => resolve([{ file: hubFile("old-search-hit.txt", "local") }]);
      }),
    getRoutineWorkflowCapabilities: async () => ({ operations: [], templates: [] }),
    listRoutines: async () => [
      {
        id: "routine-1",
        name: "Review approval",
        enabled: true,
        workspaceId: "fixture",
        triggers: [],
        updatedAt: 1,
      },
      {
        id: "completed-routine",
        name: "Completed workflow",
        enabled: true,
        workspaceId: "fixture",
        triggers: [],
        updatedAt: 1,
      },
    ],
    listRoutineWorkflowRuns: async () => [
      {
        id: "approval-run",
        routineId: "routine-1",
        status: qa.approvalRunCancelled ? "cancelled" : "waiting_for_approval",
        createdAt: 2,
      },
      { id: "completed-run", routineId: "completed-routine", status: "completed", createdAt: 1 },
    ],
    listRoutineWorkflowRunSteps: async (runId) =>
      runId === "approval-run"
        ? [
            {
              id: "review-step",
              runId,
              operation: "Review action",
              status: qa.approvalRunCancelled ? "cancelled" : "waiting_for_approval",
              attemptCount: 1,
              reviewDigest: "review-digest",
            },
          ]
        : new Promise((resolve) => {
            qa.resolveCompletedRunSteps = () =>
              resolve([
                {
                  id: "completed-step",
                  runId,
                  operation: "Completed action",
                  status: "completed",
                  attemptCount: 1,
                },
              ]);
          }),
    cancelRoutineWorkflowRun: async (runId) => {
      if (runId !== "approval-run") throw new Error("Cannot cancel another fixture run");
      qa.approvalRunCancelled = true;
    },
    getRoutine: async () => ({ instructions: "Review the pending approval." }),
    readFileForViewer: async (path) => {
      const fileName = path.split("/").pop();
      return {
        success: true,
        data: { fileName, path, fileType: "markdown", content: previewFiles[fileName], size: 10 },
      };
    },
    listSidebarTasks: async ({ limit, offset, archivedSessionsOnly }) =>
      archivedSessionsOnly ? archivedRows.slice(offset, offset + limit) : [],
    getCronStatus: async () => ({ enabled: true, scheduler: { state: "running" }, jobCount: 1 }),
    listCronJobs: async () => [
      {
        id: "job-1",
        name: "Daily document review",
        enabled: true,
        schedule: { kind: "every", everyMs: 86400000 },
        state: { totalRuns: 0, runHistory: [] },
        payload: { kind: "agentTurn", message: "Review documents" },
        sessionTarget: "isolated",
        wakeMode: "now",
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    ],
    getCronRunHistory: async () => ({ jobId: "job-1", entries: [], totalRuns: 0 }),
    applyMailboxAction: async (options) => {
      qa.calls.push({ method: "applyMailboxAction", options });
    },
  },
  {
    get(target, name) {
      if (name in target) return target[name];
      if (String(name).startsWith("on")) return () => () => {};
      return async (...args) => {
        qa.calls.push({ method: name, args });
        return [];
      };
    },
  },
);

function Fixture() {
  const [mode, setMode] = useState("dialogs");
  const [focusRoutine, setFocusRoutine] = useState<{ id: string } | null>(null);
  const [parent, setParent] = useState(false);
  const [child, setChild] = useState(false);
  const [accessWarning, setAccessWarning] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  const [mcp, setMcp] = useState(false);
  const [folderPicker, setFolderPicker] = useState(false);
  return (
    <>
      <nav style={{ padding: 16, display: "flex", gap: 12 }}>
        {[
          "dialogs",
          "inbox",
          "menus",
          "import",
          "registry",
          "scheduled",
          "files",
          "automation",
          "archive",
          "work",
          "workspace",
          "search",
          "folder-picker",
        ].map((id) => (
          <button key={id} onClick={() => setMode(id)}>
            Show {id}
          </button>
        ))}
      </nav>
      {mode === "dialogs" && (
        <>
          <button id="parent-opener" onClick={() => setParent(true)}>
            Open parent
          </button>
          <button onClick={() => setMcp(true)}>Review launch</button>
          {parent && (
            <div className="modal-overlay">
              <ModalDialog
                className="modal"
                aria-label="Parent dialog"
                onClose={() => setParent(false)}
              >
                <button id="child-opener" onClick={() => setChild(true)}>
                  Open child
                </button>
                <input aria-label="Parent field" />
                <button id="warning-opener" onClick={() => setAccessWarning(true)}>
                  Open access warning
                </button>
                {accessWarning && (
                  <FullAccessConfirmationDialog
                    onConfirm={() => {}}
                    onCancel={() => setAccessWarning(false)}
                  />
                )}
                <button id="image-opener" onClick={() => setLightbox(true)}>
                  Open image
                </button>
                {lightbox && (
                  <ImageLightbox
                    src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='80'%3E%3Crect width='120' height='80' fill='%239ab'/%3E%3C/svg%3E"
                    fileName="Preview image"
                    onClose={() => setLightbox(false)}
                  />
                )}
                <CalmAccessMenu
                  access={{
                    label: "Parent safe access",
                    selectedId: "safe",
                    isFullAccess: false,
                    options: [{ id: "safe", label: "Safe access" }],
                    onSelect: () => {},
                    onConfigure: () => {},
                  }}
                />
                <button onClick={() => setParent(false)}>Close parent</button>
                {child && (
                  <div className="modal-overlay">
                    <ModalDialog
                      className="modal"
                      aria-label="Child dialog"
                      onClose={() => setChild(false)}
                    >
                      <input aria-label="Child field" />
                      <button onClick={() => setChild(false)}>Close child</button>
                    </ModalDialog>
                  </div>
                )}
              </ModalDialog>
            </div>
          )}
          {mcp && (
            <MCPLaunchPlanReview
              plan={{ entryId: "docs", name: "Docs", transport: "stdio", args: [], envKeys: [] }}
              expiresAt={Date.now() + 60000}
              action="install"
              onCancel={() => setMcp(false)}
              onApprove={() => {}}
            />
          )}
        </>
      )}
      {mode === "inbox" && (
        <Profiler
          id="Inbox"
          onRender={(_, phase, duration) => qa.commits.push({ phase, duration })}
        >
          <InboxAgentPanel />
        </Profiler>
      )}
      {mode === "menus" && (
        <div style={{ padding: 16 }}>
          <CalmAccessMenu
            access={{
              label: "Retired profile",
              selectedId: "retired",
              isFullAccess: false,
              options: [{ id: "safe", label: "Safe access" }],
              onSelect: () => {},
              onConfigure: () => {},
            }}
          />
          <NotificationPanel placement="sidebar" />
          <SidebarRail
            activeId="home"
            initialPinnedIds={[]}
            onNavigate={() => {}}
            onOpenSettings={() => {}}
          />
          <div style={{ position: "fixed", bottom: 12, right: 12, display: "flex", gap: 8 }}>
            <DocumentArtifactCard filePath="/fixture/report.docx" />
            <SpreadsheetArtifactCard filePath="/fixture/report.xlsx" />
            <PresentationArtifactCard filePath="/fixture/report.pptx" />
            <WebArtifactCard filePath="/fixture/report.html" />
          </div>
        </div>
      )}
      {mode === "import" && (
        <ChatGPTImportWizard workspaceId="fixture" onClose={() => setMode("dialogs")} />
      )}
      {mode === "scheduled" && <ScheduledTasksSettings />}
      {mode === "registry" && <MCPRegistryBrowser />}
      {mode === "files" && <FileHub workspaceId="fixture" />}
      {mode === "automation" && (
        <>
          <button onClick={() => setFocusRoutine({ id: "routine-1" })}>Open routine alert</button>
          <AutomationStudioPanel workspaceId="fixture" focusRoutine={focusRoutine} />
        </>
      )}
      {mode === "archive" && (
        <SidebarArchivedSessions
          normalizedSearch="older archive fixture"
          workspaces={[]}
          titleFor={(task) => task.title}
          onClose={() => {}}
          onUnarchived={() => {}}
          onOpenRestored={() => {}}
        />
      )}
      {mode === "work" && (
        <WorkView tasks={workTasks} onOpenTask={() => {}} onTasksChanged={() => {}} />
      )}
      {mode === "workspace" && <RightPanel task={connectorTask} workspace={null} events={[]} />}
      {mode === "folder-picker" && (
        <div style={{ margin: 30 }}>
          <button type="button" onClick={() => setFolderPicker((open) => !open)}>
            Choose folder
          </button>
          {folderPicker && (
            <WorkspaceDropdownMenu
              workspaces={pickerFolders}
              currentWorkspaceId="Alpha folder"
              onSelect={() => setFolderPicker(false)}
              onSelectNewFolder={() => setFolderPicker(false)}
              onRemove={async (folder) => {
                qa.calls.push({ method: "removeFolder", id: folder.id });
              }}
              onClose={() => setFolderPicker(false)}
            />
          )}
        </div>
      )}
      {mode === "search" && <SearchSettings />}
    </>
  );
}
createRoot(document.getElementById("root")).render(<Fixture />);
