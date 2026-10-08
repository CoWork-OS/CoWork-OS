import { createBrowserProviderSignIn } from "./browser-provider-sign-in";
import { createBrowserAwarenessDefinitions } from "./browser-awareness-methods";
import { getAwarenessService } from "../../electron/awareness/AwarenessService";
import type Database from "better-sqlite3";
import {
  ApprovalRepository,
  ArtifactRepository,
  BrowserGitMutationReceiptRepository,
  BrowserTaskCancelReceiptRepository,
  InputRequestRepository,
  TaskEventReplayRepository,
  TaskRepository,
  WorkspaceRepository,
} from "../../electron/database/repository-facades";
import { LLMProviderFactory } from "../../electron/agent/llm";
import type { AgentDaemon } from "../../electron/agent/daemon";
import { AppearanceManager } from "../../electron/settings/appearance-manager";
import {
  HOST_CAPABILITIES,
  type HostCapabilities,
  type HostIdentity,
  type WebSessionBootstrap,
} from "../../shared/host-api/contracts";
import { isTempWorkspaceId } from "../../shared/types";
import {
  MEMORY_USED_EVENT_TYPES,
  MEMORY_USED_MAX_EVENTS,
  toMemoryUsedTimelineEvent,
} from "../../shared/memory-used";
import {
  WebApplication,
  WebApplicationError,
  type WebDeploymentPolicy,
} from "../web/WebApplication";
import { createBrowserReadMethods, createDatabaseBrowserReadSources } from "./browser-read-methods";
import { createBrowserDesktopReadMethods } from "./browser-desktop-read-methods";
import { BrowserWorkspaceFiles, createBrowserWorkspaceFileMethods } from "./browser-files";
import { createBrowserTaskMethods, type BrowserTaskCommands } from "./browser-task-methods";
import { createBrowserFollowUpMethods } from "./browser-follow-up-methods";
import { resolveBrowserTaskMedia } from "./browser-task-media";
import { createBrowserTaskEventMethods } from "./browser-task-event-methods";
import {
  createBrowserApprovalMethods,
  type BrowserApprovalCommands,
} from "./browser-approval-methods";
import { readAuthorizedInlineApprovalDraftReview } from "../../electron/ipc/approval-draft-preview";
import { TaskAdmissionService } from "../../electron/control-plane/task-admission-service";
import {
  applyAccessProfileToWorkspace,
  resolveEffectiveAccessProfile,
} from "../../electron/security/access-profile-resolver";
import { PermissionSettingsManager } from "../../electron/security/permission-settings-manager";
import { loadPolicies } from "../../electron/admin/policies";
import { verifyWebArtifact } from "./web-artifact";
import { BrowserArtifacts, createBrowserArtifactMethods } from "./browser-artifacts";
import { createBrowserGitMethods } from "./browser-git-methods";
import { createBrowserTaskCancellationMethods } from "./browser-task-cancellation";
import { BrowserTerminalAttachmentService } from "./browser-terminal-methods";
import { TerminalPtyManager } from "../../electron/terminal/TerminalPtyManager";
import { assertTerminalShellAllowed } from "../../electron/terminal/terminal-shell-policy";
import { WorkSessionContractRepository } from "../../electron/database/WorkSessionContractRepository";
import { AgentRoleRepository } from "../../electron/agents/agent-repository-facades";
import type { ChannelGateway } from "../../electron/gateway";
import type { RoutineService } from "../../electron/routines/service";
import type { EventTriggerService } from "../../electron/triggers/EventTriggerService";
import type { HeartbeatService } from "../../electron/agents/HeartbeatService";
import type { NotificationService } from "../../electron/notifications/service";
import { BrowserDesktopRpcService } from "./browser-desktop-rpc";
import { createBrowserCoreDefinitions } from "./browser-core-methods";
import { createBrowserSettingsDefinitions } from "./browser-settings-methods";
import { createBrowserMCPDefinitions } from "./browser-mcp-methods";
import { createBrowserIntegrationDefinitions } from "./browser-integration-methods";
import { createBrowserMailboxDefinitions } from "./browser-mailbox-methods";
import { createBrowserNavigationDefinitions } from "./browser-navigation-methods";
import { createBrowserPlanningDefinitions } from "./browser-planning-methods";
import { createBrowserQueueDefinitions } from "./browser-queue-methods";
import { createBrowserDeviceDefinitions } from "./browser-device-methods";
import { getFirstRunReadiness } from "../../shared/first-run-readiness";
import { createBrowserNotificationDefinitions } from "./browser-notification-methods";
import { createBrowserReportDefinitions } from "./browser-report-methods";
import { createBrowserMemoryDefinitions } from "./browser-memory-methods";
import { createBrowserPactDefinitions } from "./browser-pact-methods";
import { createBrowserAnswerSurfaceDefinitions } from "./browser-answer-surface-methods";
import { AnswerImageService } from "../../electron/answer-surfaces/AnswerImageService";
import { AnswerSurfaceStateStore } from "../../electron/answer-surfaces/AnswerSurfaceStateStore";
import { answerImageNetworkContext } from "../../electron/answer-surfaces/network-context";
import { configuredImageSearch } from "../../electron/answer-surfaces/web-image-search";
import { getUserDataDir } from "../../electron/utils/user-data-dir";
import path from "node:path";

export interface BrowserHostApplicationOptions {
  db: Database.Database;
  webDirectory: string;
  deployment: WebDeploymentPolicy;
  identity: HostIdentity;
  agentDaemon?: AgentDaemon;
  channelGateway?: ChannelGateway;
  getRoutineService?: () => RoutineService | null;
  getEventTriggerService?: () => EventTriggerService | null;
  getHeartbeatService?: () => HeartbeatService | null;
  notificationService?: NotificationService;
  taskCommands?: Pick<BrowserTaskCommands, "createTaskIdempotent" | "startAdmittedTask"> &
    BrowserApprovalCommands &
    Pick<AgentDaemon, "sendMessage" | "getDurableTaskFollowUpReceipt" | "cancelTask">;
  getSessionBootstrap?: () =>
    | Omit<WebSessionBootstrap, "apiVersion" | "host" | "csrfToken">
    | Promise<Omit<WebSessionBootstrap, "apiVersion" | "host" | "csrfToken">>;
}

/** Keep the browser approval revision token intact through the desktop command adapter. */
export function createBrowserApprovalCommandAdapter(
  commands: Pick<BrowserApprovalCommands, "respondToApproval">,
): BrowserApprovalCommands["respondToApproval"] {
  return (approvalId, approved, action, attribution, expectedRevisionHash) =>
    commands.respondToApproval(approvalId, approved, action, attribution, expectedRevisionHash);
}

const READ_CAPABILITIES = new Set([
  "tasks.read",
  "tasks.events",
  "workspaces.read",
  "files.read",
  "artifacts.read",
  "git.read",
  "git.write",
  "terminal.attach",
]);

export function browserHostCapabilities(
  taskCreationAvailable = false,
  uploadsAvailable = false,
  desktopCapabilities = new Set<string>(),
): HostCapabilities {
  return Object.fromEntries(
    HOST_CAPABILITIES.map((name) => [
      name,
      READ_CAPABILITIES.has(name) ||
      desktopCapabilities.has(name) ||
      (uploadsAvailable && name === "files.upload") ||
      (taskCreationAvailable &&
        (name === "tasks.create" || name === "tasks.followUp" || name === "tasks.cancel")) ||
      (taskCreationAvailable && (name === "tasks.approvals" || name === "tasks.inputRequests"))
        ? { available: true }
        : { available: false, reason: "This workflow is not yet available in the browser." },
    ]),
  ) as HostCapabilities;
}

/** One opt-in browser authority shared by the desktop Web Access and Control Plane listeners. */
export function createBrowserHostApplication(
  options: BrowserHostApplicationOptions,
): WebApplication {
  verifyWebArtifact(options.webDirectory, options.identity.appVersion);
  const workspaceRepository = new WorkspaceRepository(options.db);
  const taskRepository = new TaskRepository(options.db);
  const artifactRepository = new ArtifactRepository(options.db);
  const artifactRevisionRepository = new WorkSessionContractRepository(options.db);
  const taskEventRepository = new TaskEventReplayRepository(options.db);
  const cancellationReceipts = options.taskCommands
    ? new BrowserTaskCancelReceiptRepository(options.db)
    : null;
  const gitMutationReceipts = new BrowserGitMutationReceiptRepository(options.db);
  const approvalRepository = options.taskCommands ? new ApprovalRepository(options.db) : null;
  const inputRequestRepository = options.taskCommands
    ? new InputRequestRepository(options.db)
    : null;
  const agentRoles = new AgentRoleRepository(options.db);
  const answerImages = new AnswerImageService({
    cacheDir: path.join(getUserDataDir(), "cache", "answer-images"),
    imageSearch: configuredImageSearch,
  });
  const resolveBrowserWorkspace = async (workspaceId: string) => {
    const workspace = await workspaceRepository.findById(workspaceId);
    if (!workspace) return null;
    const profile = resolveEffectiveAccessProfile({
      workspace,
      settings: PermissionSettingsManager.loadSettings(),
      adminPolicies: loadPolicies(),
    });
    return applyAccessProfileToWorkspace(workspace, profile);
  };
  const mailbox = createBrowserMailboxDefinitions(options.db, options.channelGateway);
  const notifications = options.notificationService
    ? createBrowserNotificationDefinitions({
        service: options.notificationService,
        resolveWorkspace: resolveBrowserWorkspace,
        getTask: async (taskId) => (await taskRepository.findById(taskId)) ?? null,
      })
    : {};
  const devices = createBrowserDeviceDefinitions({
    db: options.db,
    identity: options.identity,
    resolveWorkspace: resolveBrowserWorkspace,
    channelGateway: options.channelGateway,
  });
  const navigation = options.agentDaemon
    ? createBrowserNavigationDefinitions({
        db: options.db,
        agentDaemon: options.agentDaemon,
        channelGateway: options.channelGateway,
        getRoutineService: options.getRoutineService,
        getEventTriggerService: options.getEventTriggerService,
        getHeartbeatService: options.getHeartbeatService,
        resolveWorkspace: resolveBrowserWorkspace,
      })
    : null;
  const providerSignIn = createBrowserProviderSignIn();
  const desktop = new BrowserDesktopRpcService({
    ...providerSignIn.definitions,
    ...createBrowserCoreDefinitions({
      db: options.db,
      agentDaemon: options.agentDaemon ?? {},
      resolveWorkspace: resolveBrowserWorkspace,
    }),
    ...createBrowserAwarenessDefinitions({
      service: getAwarenessService(),
      resolveWorkspace: resolveBrowserWorkspace,
    }),
    ...(options.agentDaemon
      ? createBrowserPactDefinitions({ agentDaemon: options.agentDaemon })
      : {}),
    ...createBrowserMemoryDefinitions({
      db: options.db,
      resolveWorkspace: resolveBrowserWorkspace,
      getRecentTask: async (workspaceId) =>
        (await taskRepository.findByWorkspace(workspaceId, 1))[0] ?? null,
      getTask: async (taskId) => (await taskRepository.findById(taskId)) ?? null,
      loadMemoryUsedTimeline: async (workspaceId, taskId) => {
        const task = await taskRepository.findById(taskId);
        if (!task || task.workspaceId !== workspaceId) return null;
        const events = await taskEventRepository.findByTaskIdAndTypes(
          taskId,
          [...MEMORY_USED_EVENT_TYPES],
          MEMORY_USED_MAX_EVENTS,
        );
        return events.map(toMemoryUsedTimelineEvent);
      },
    }),
    ...createBrowserReportDefinitions({
      db: options.db,
      resolveWorkspace: resolveBrowserWorkspace,
    }),
    ...createBrowserAnswerSurfaceDefinitions({
      taskExists: async (taskId) => {
        const task = await taskRepository.findById(taskId);
        const workspace = task ? await resolveBrowserWorkspace(task.workspaceId) : null;
        return Boolean(workspace?.permissions.read);
      },
      resolveNetworkContext: async (taskId) => {
        const task = taskId ? await taskRepository.findById(taskId) : undefined;
        const workspace = task ? await workspaceRepository.findById(task.workspaceId) : undefined;
        return task && workspace ? answerImageNetworkContext(task, workspace) : {};
      },
      images: answerImages,
      store: AnswerSurfaceStateStore,
    }),
    ...createBrowserQueueDefinitions(options.agentDaemon),
    ...notifications,
    ...mailbox.definitions,
    ...devices.definitions,
    ...navigation?.definitions,
    ...createBrowserPlanningDefinitions({
      db: options.db,
      agentDaemon: options.agentDaemon,
      resolveWorkspace: resolveBrowserWorkspace,
    }),
    ...createBrowserSettingsDefinitions({
      refreshAccessProfiles: () => options.agentDaemon?.refreshActiveExecutorsForAccessProfiles(),
    }),
    ...createBrowserIntegrationDefinitions({
      channelGateway: options.channelGateway,
      authorizeWorkspaceRead: async (workspaceId) => {
        const workspace = await resolveBrowserWorkspace(workspaceId);
        if (!workspace?.permissions.read) {
          throw new WebApplicationError("FORBIDDEN", "Workspace is unavailable.", 403, false);
        }
      },
    }),
    ...createBrowserMCPDefinitions({
      profileId: options.identity.profileId,
      resolveWorkspace: resolveBrowserWorkspace,
    }),
  });
  const getCapabilities = () =>
    browserHostCapabilities(Boolean(options.taskCommands), true, desktop.capabilities);
  const workspaceFiles = new BrowserWorkspaceFiles({
    resolveWorkspace: resolveBrowserWorkspace,
    getCapabilities,
  });
  const browserArtifacts = new BrowserArtifacts({
    getCapabilities,
    resolveArtifact: async (selector) => {
      const revision =
        "artifactRevisionId" in selector
          ? artifactRevisionRepository.getArtifactRevisionById(selector.artifactRevisionId)
          : undefined;
      const artifactId = "artifactId" in selector ? selector.artifactId : revision?.artifactId;
      if (!artifactId) return null;
      const artifact = await artifactRepository.findById(artifactId);
      if (!artifact) return null;
      const task = await taskRepository.findById(artifact.taskId);
      if (!task?.workspaceId) return null;
      const workspace = await resolveBrowserWorkspace(task.workspaceId);
      return workspace ? { artifact, task, workspace, revision } : null;
    },
    listTaskArtifacts: async (request) => {
      const task = await taskRepository.findById(request.taskId);
      if (!task || task.workspaceId !== request.workspaceId) return null;
      const workspace = await resolveBrowserWorkspace(request.workspaceId);
      if (!workspace) return null;
      const rows = await artifactRepository.findByTaskIdPage(
        request.taskId,
        request.limit + 1,
        request.offset,
      );
      return {
        task,
        workspace,
        artifacts: rows.slice(0, request.limit),
        hasMore: rows.length > request.limit,
      };
    },
  });
  const taskAdmission = options.taskCommands ? new TaskAdmissionService(options.db) : null;
  const taskMethods =
    options.taskCommands && taskAdmission
      ? createBrowserTaskMethods({
          commands: {
            createTaskIdempotent: (params) => options.taskCommands!.createTaskIdempotent(params),
            startAdmittedTask: (operationKey, taskId) =>
              options.taskCommands!.startAdmittedTask(operationKey, taskId),
            getTaskAdmission: (operationKey) => taskAdmission.getByOperationKey(operationKey),
          },
          getWorkspace: resolveBrowserWorkspace,
          mediaReader: workspaceFiles,
          isActiveAgentRole: async (id) => (await agentRoles.findById(id))?.isActive === true,
        })
      : {};
  const followUpMethods = options.taskCommands
    ? createBrowserFollowUpMethods({
        getWorkspace: resolveBrowserWorkspace,
        getTask: async (taskId) => (await taskRepository.findById(taskId)) ?? null,
        getQuotedAssistantEvent: async (taskId, eventId) =>
          (await taskEventRepository.findEventDetailById(eventId, { taskId })).event,
        prepareFollowUpMedia: (context, workspaceId, descriptors) =>
          resolveBrowserTaskMedia(workspaceFiles, context, workspaceId, descriptors),
        commands: {
          sendFollowUp: (
            taskId,
            message,
            messageId,
            followUpOptions,
            capturedAttachments,
            requestFingerprint,
          ) => {
            const { quotedAssistantMessage, ...sendOptions } = followUpOptions;
            return options.taskCommands!.sendMessage(
              taskId,
              message,
              undefined,
              quotedAssistantMessage,
              {
                deliveryMode: "follow_up",
                returnOnAccepted: true,
                messageId,
                ...sendOptions,
                ...(capturedAttachments?.length ? { capturedAttachments } : {}),
                ...(requestFingerprint ? { requestFingerprint } : {}),
              },
            );
          },
          getFollowUpReceipt: async (taskId, messageId) =>
            options.taskCommands!.getDurableTaskFollowUpReceipt(taskId, messageId),
        },
      })
    : {};
  const approvalMethods =
    options.taskCommands && approvalRepository && inputRequestRepository
      ? createBrowserApprovalMethods({
          getWorkspace: resolveBrowserWorkspace,
          getTask: async (taskId) => (await taskRepository.findById(taskId)) ?? null,
          listPendingApprovals: () => approvalRepository.findAllPending(),
          getApproval: async (approvalId) =>
            (await approvalRepository.findById(approvalId)) ?? null,
          listPendingInputRequests: () => inputRequestRepository.findAllPending(),
          getInputRequest: async (requestId) =>
            (await inputRequestRepository.findById(requestId)) ?? null,
          getInputRequestDraftReview: options.agentDaemon
            ? async (inputRequestId, taskId) =>
                readAuthorizedInlineApprovalDraftReview(
                  { inputRequestId, taskId },
                  {
                    findInput: async (id) =>
                      (await inputRequestRepository.findById(id)) ?? undefined,
                    getApprovalBinding: async (id) =>
                      (await inputRequestRepository.getApprovalBinding(id)) ?? undefined,
                    findApproval: async (id) =>
                      (await approvalRepository.findById(id)) ?? undefined,
                    authorize: async (authorizedTaskId) => {
                      const task = await taskRepository.findById(authorizedTaskId);
                      const workspace = task
                        ? await resolveBrowserWorkspace(task.workspaceId)
                        : null;
                      if (
                        !task ||
                        task.id !== taskId ||
                        !workspace ||
                        workspace.permissions.read !== true ||
                        workspace.permissions.write !== true
                      )
                        throw new Error("Input request review is unavailable");
                    },
                    draftPreviews: (id, revision) => approvalRepository.draftPreviews(id, revision),
                    responsibilityActionAuthorityCurrent: (approval) =>
                      options.agentDaemon!.isResponsibilityActionReviewAuthorityCurrent(approval),
                  },
                )
            : undefined,
          commands: {
            respondToApproval: createBrowserApprovalCommandAdapter(options.taskCommands!),
            respondToInputRequest: (response) =>
              options.taskCommands!.respondToInputRequest(response),
          },
        })
      : {};
  const taskEventMethods = createBrowserTaskEventMethods({
    findScopedTimelineSnapshot: (request) =>
      taskEventRepository.findScopedTimelineSnapshot(request),
    findScopedTimelineHistoryPage: (request) =>
      taskEventRepository.findScopedTimelineHistoryPage(request),
    findScopedMutationPage: (request) => taskEventRepository.findScopedMutationPage(request),
  });
  const cancellationMethods =
    options.taskCommands && cancellationReceipts
      ? createBrowserTaskCancellationMethods({
          getTask: async (taskId) => (await taskRepository.findById(taskId)) ?? null,
          getWorkspace: resolveBrowserWorkspace,
          cancelTask: (taskId) => options.taskCommands!.cancelTask(taskId),
          receipts: cancellationReceipts,
        })
      : {};
  const terminal = new BrowserTerminalAttachmentService({
    getWorkspace: resolveBrowserWorkspace,
    getTask: async (taskId) => (await taskRepository.findById(taskId)) ?? null,
    assertShellAllowed: async (workspace, task) => {
      const rawWorkspace = await workspaceRepository.findById(workspace.id);
      if (!rawWorkspace) throw new Error("Workspace is unavailable.");
      assertTerminalShellAllowed(rawWorkspace, task);
    },
    terminal: TerminalPtyManager.getInstance(),
  });
  return new WebApplication({
    enabled: true,
    webDirectory: options.webDirectory,
    deployment: options.deployment,
    getHostIdentity: () => options.identity,
    getCapabilities,
    getSessionBootstrap: async () => ({
      ...(await (options.getSessionBootstrap?.() ??
        readBrowserSessionBootstrap(options.db, Boolean(options.taskCommands)))),
      capabilities: getCapabilities(),
      desktopMethods: desktop.manifest,
    }),
    methods: {
      ...createBrowserReadMethods(
        createDatabaseBrowserReadSources(options.db, resolveBrowserWorkspace),
      ),
      ...createBrowserDesktopReadMethods({
        listWorkspaces: () => workspaceRepository.findAll(),
        resolveWorkspace: resolveBrowserWorkspace,
        getTask: async (taskId) => (await taskRepository.findById(taskId)) ?? null,
      }),
      ...createBrowserWorkspaceFileMethods(workspaceFiles),
      ...createBrowserArtifactMethods(browserArtifacts),
      ...createBrowserGitMethods({
        resolveWorkspace: resolveBrowserWorkspace,
        getCapabilities,
        receipts: gitMutationReceipts,
      }),
      ...taskEventMethods,
      ...taskMethods,
      ...followUpMethods,
      ...approvalMethods,
      ...cancellationMethods,
      ...terminal.methods(),
      ...desktop.methods(),
    },
    handleWorkspaceFileDownload: (context, req, res) =>
      workspaceFiles.handleDownloadRequest(context, req, res),
    handleWorkspaceFileUpload: (context, req, res) =>
      workspaceFiles.handleUploadRequest(context, req, res),
    handleWorkspaceFileMedia: (context, req, res) =>
      workspaceFiles.handleMediaRequest(context, req, res),
    handleArtifactDownload: (context, req, res) =>
      browserArtifacts.handleDownloadRequest(context, req, res),
    onSessionRevoked: (sessionId) => {
      workspaceFiles.revokeSession(sessionId);
      browserArtifacts.revokeSession(sessionId);
      terminal.revokeSession(sessionId);
      desktop.revokeSession(sessionId);
      providerSignIn.revokeSession(sessionId);
    },
    onClose: () => {
      workspaceFiles.dispose();
      browserArtifacts.dispose();
      terminal.dispose();
      desktop.dispose();
      providerSignIn.dispose();
      mailbox.dispose();
      navigation?.dispose?.();
      devices.dispose();
    },
    appVersion: options.identity.appVersion,
  });
}

async function readBrowserSessionBootstrap(
  db: Database.Database,
  taskCreationAvailable: boolean,
): Promise<Omit<WebSessionBootstrap, "apiVersion" | "host" | "csrfToken">> {
  const workspaces = await new WorkspaceRepository(db).findAll();
  const activeWorkspace = workspaces.find(
    (workspace) => !workspace.isTemp && !isTempWorkspaceId(workspace.id),
  );
  const appearance = AppearanceManager.loadSettings();
  const llm = LLMProviderFactory.loadSettings();
  const providerReady = getFirstRunReadiness(llm).modelReady;
  return {
    providerReady,
    onboardingCompleted: appearance.onboardingCompleted === true,
    disclaimerAccepted: appearance.disclaimerAccepted === true,
    activeWorkspaceId: activeWorkspace?.id ?? null,
    capabilities: browserHostCapabilities(taskCreationAvailable, true),
  };
}
