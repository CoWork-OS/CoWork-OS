import type { PersonalityId, PersonaId, EmojiUsage, PersonalityQuirks } from "../../shared/types";

/**
 * Message keys used throughout the app
 */
export type MessageKey =
  | "welcome"
  | "welcomeSubtitle"
  | "placeholder"
  | "placeholderActive"
  | "taskStart"
  | "taskComplete"
  | "taskWorking"
  | "taskPaused"
  | "taskBlocked"
  | "planCreated"
  | "stepStarted"
  | "stepCompleted"
  | "error"
  | "approval"
  | "verifying"
  | "verifyPassed"
  | "verifyFailed"
  | "retrying"
  | "disclaimer";

/**
 * Context for generating personalized messages
 */
export interface AgentMessageContext {
  agentName: string;
  userName?: string;
  personality: PersonalityId;
  persona?: PersonaId;
  emojiUsage: EmojiUsage;
  quirks: PersonalityQuirks;
}

/**
 * UI copy keys for persona-aware interface text
 */
export type UiCopyKey =
  | "taskViewEmptyTitle"
  | "taskViewEmptyBody"
  | "taskPromptTitle"
  | "taskStatusPausedTitle"
  | "taskStatusBlockedTitle"
  | "taskStatusBlockedDetail"
  | "taskStatusResume"
  | "taskStatusResuming"
  | "timelineTitle"
  | "timelineEmpty"
  | "mcLoading"
  | "mcTitle"
  | "mcAgentsActiveLabel"
  | "mcTasksQueueLabel"
  | "mcAgentsTitle"
  | "mcAddAgent"
  | "mcMissionQueueTitle"
  | "mcLiveFeedTitle"
  | "mcAllAgentsLabel"
  | "mcFeedEmpty"
  | "mcColumnEmpty"
  | "mcFilterAll"
  | "mcFilterTasks"
  | "mcFilterComments"
  | "mcFilterStatus"
  | "mcStatusOnline"
  | "mcWorkspaceLabel"
  | "mcMentionsLabel"
  | "mcStandupButton"
  | "mcWakeAgent"
  | "mcNoActiveTask"
  | "mcTaskTab"
  | "mcClearTask"
  | "mcTaskUpdatedAt"
  | "mcTaskAssigneeLabel"
  | "mcTaskUnassigned"
  | "mcTaskStageLabel"
  | "mcTaskBriefTitle"
  | "mcTaskUpdatesTitle"
  | "mcTaskUpdatePlaceholder"
  | "mcTaskPosting"
  | "mcTaskPostUpdate"
  | "mcTaskMentionsTitle"
  | "mcTaskMentionPlaceholder"
  | "mcTaskEmpty"
  | "mcHeartbeatNext"
  | "mcHeartbeatFound"
  | "taskBoardEmptyTitle"
  | "taskBoardEmptyHint"
  | "rightProgressTitle"
  | "rightProgressEmptyHint"
  | "rightQueueTitle"
  | "rightQueueActiveLabel"
  | "rightQueueNextLabel"
  | "rightFilesTitle"
  | "rightFilesEmptyHint"
  | "rightContextTitle"
  | "rightContextEmptyHint"
  | "rightFooterText"
  | "workingStateLoading"
  | "workingStateTitle"
  | "workingStateEdit"
  | "workingStateAdd"
  | "workingStateEmptyHint"
  | "workingStateReferencedFiles"
  | "workingStateHistoryTitle"
  | "workingStateHistoryLoading"
  | "workingStateHistoryAllTypes"
  | "workingStateHistoryEntries"
  | "workingStateHistoryEmpty"
  | "workingStateHistoryCurrent"
  | "workingStateHistoryRestore"
  | "workingStateHistoryRestoring"
  | "workingStateHistoryDelete"
  | "workingStateHistoryDeleteConfirm"
  | "workingStateHistoryFilesLabel"
  | "standupTitle"
  | "standupGenerate"
  | "standupGenerating"
  | "standupHistoryTitle"
  | "standupEmpty"
  | "standupGeneratedAt"
  | "standupCompletedTitle"
  | "standupInProgressTitle"
  | "standupBlockedTitle"
  | "standupCompletedEmpty"
  | "standupInProgressEmpty"
  | "standupBlockedEmpty"
  | "mcpEmptyTitle"
  | "mcpEmptyHint"
  | "scheduledNoWorkspaces"
  | "standupLoading"
  | "taskBoardLoading"
  | "taskBoardTitle"
  | "taskBoardCount"
  | "taskBoardAllAgents"
  | "taskBoardAllLabels"
  | "taskBoardAllPriorities"
  | "taskBoardManageLabels"
  | "activityLoading"
  | "activityTitle"
  | "activityMarkAllRead"
  | "activityAllTypes"
  | "activityAllActors"
  | "activityActorAgent"
  | "activityActorUser"
  | "activityActorSystem"
  | "activityUnreadOnly"
  | "activityPinned"
  | "activityRecent"
  | "activityEmptyTitle"
  | "activityEmptyHint"
  | "mentionLoading"
  | "mentionAllStatuses"
  | "mentionStatusPending"
  | "mentionStatusAcknowledged"
  | "mentionStatusCompleted"
  | "mentionStatusDismissed"
  | "mentionAllTypes"
  | "mentionTypeRequest"
  | "mentionTypeHandoff"
  | "mentionTypeReview"
  | "mentionTypeFyi"
  | "mentionEmpty"
  | "mentionUser"
  | "mentionUnknownAgent"
  | "fileLoading"
  | "canvasLoading";

const UI_COPY: Record<UiCopyKey, string> = {
  taskViewEmptyTitle: "No session selected",
  taskViewEmptyBody: "Pick a session from the sidebar or start a new one to work together",
  taskPromptTitle: "What We're Working On",
  taskStatusPausedTitle: "Paused - waiting on your input",
  taskStatusBlockedTitle: "Blocked - needs approval",
  taskStatusBlockedDetail: "Approve the pending request to continue.",
  taskStatusResume: "Resume",
  taskStatusResuming: "Resuming...",
  timelineTitle: "What We've Done",
  timelineEmpty: "Nothing happening yet",
  mcLoading: "Loading Mission Control...",
  mcTitle: "MISSION CONTROL",
  mcAgentsActiveLabel: "AGENTS ACTIVE",
  mcTasksQueueLabel: "TASKS IN QUEUE",
  mcAgentsTitle: "AGENTS",
  mcAddAgent: "Add Agent",
  mcMissionQueueTitle: "MISSION QUEUE",
  mcLiveFeedTitle: "LIVE FEED",
  mcAllAgentsLabel: "All Agents",
  mcFeedEmpty: "No recent activity",
  mcColumnEmpty: "No tasks",
  mcFilterAll: "All",
  mcFilterTasks: "Tasks",
  mcFilterComments: "Comments",
  mcFilterStatus: "Status",
  mcStatusOnline: "ONLINE",
  mcWorkspaceLabel: "Workspace",
  mcMentionsLabel: "MENTIONS",
  mcStandupButton: "Standup",
  mcWakeAgent: "Wake",
  mcNoActiveTask: "No active task",
  mcTaskTab: "TASK",
  mcClearTask: "Clear",
  mcTaskUpdatedAt: "Updated {time}",
  mcTaskAssigneeLabel: "Assignee",
  mcTaskUnassigned: "Unassigned",
  mcTaskStageLabel: "Stage",
  mcTaskBriefTitle: "Brief",
  mcTaskUpdatesTitle: "Updates",
  mcTaskUpdatePlaceholder: "Post an update...",
  mcTaskPosting: "Posting...",
  mcTaskPostUpdate: "Post Update",
  mcTaskMentionsTitle: "Mentions",
  mcTaskMentionPlaceholder: "Type @ to mention an agent...",
  mcTaskEmpty: "Select a task to view details",
  mcHeartbeatNext: "next {time}",
  mcHeartbeatFound: "found {mentions} mentions, {tasks} tasks",
  taskBoardEmptyTitle: "No tasks",
  taskBoardEmptyHint: "Drag tasks here",
  rightProgressTitle: "OUR PROGRESS",
  rightProgressEmptyHint: "# standing by...",
  rightQueueTitle: "LINEUP",
  rightQueueActiveLabel: "# active:",
  rightQueueNextLabel: "# next up:",
  rightFilesTitle: "FILES",
  rightFilesEmptyHint: "# no file changes yet",
  rightContextTitle: "CONTEXT",
  rightContextEmptyHint: "# no context loaded",
  rightFooterText: "local execution only",
  workingStateLoading: "Loading working state...",
  workingStateTitle: "Working State",
  workingStateEdit: "Edit",
  workingStateAdd: "Add",
  workingStateEmptyHint: "No {label} recorded yet.",
  workingStateReferencedFiles: "Referenced files:",
  workingStateHistoryTitle: "Working State History",
  workingStateHistoryLoading: "Loading history...",
  workingStateHistoryAllTypes: "All Types",
  workingStateHistoryEntries: "{count} entries",
  workingStateHistoryEmpty: "No history entries found.",
  workingStateHistoryCurrent: "Current",
  workingStateHistoryRestore: "Restore",
  workingStateHistoryRestoring: "Restoring...",
  workingStateHistoryDelete: "Delete",
  workingStateHistoryDeleteConfirm: "Delete this history entry?",
  workingStateHistoryFilesLabel: "Files:",
  standupTitle: "Daily Standup Reports",
  standupGenerate: "Generate Report",
  standupGenerating: "Generating...",
  standupHistoryTitle: "Report History",
  standupEmpty: "No reports yet. Generate your first report to get started.",
  standupGeneratedAt: "Generated at {time}",
  standupCompletedTitle: "Completed",
  standupInProgressTitle: "In Progress",
  standupBlockedTitle: "Blocked",
  standupCompletedEmpty: "No tasks completed",
  standupInProgressEmpty: "No tasks in progress",
  standupBlockedEmpty: "No blocked tasks",
  mcpEmptyTitle: "No MCP servers configured.",
  mcpEmptyHint: 'Click "Add Server" to connect to an MCP server and extend CoWork\'s capabilities.',
  scheduledNoWorkspaces: "No workspaces available",
  standupLoading: "Loading standup reports...",
  taskBoardLoading: "Loading task board...",
  taskBoardTitle: "Task Board",
  taskBoardCount: "{count} tasks",
  taskBoardAllAgents: "All Agents",
  taskBoardAllLabels: "All Labels",
  taskBoardAllPriorities: "All Priorities",
  taskBoardManageLabels: "Manage Labels",
  activityLoading: "Loading activities...",
  activityTitle: "Activity",
  activityMarkAllRead: "Mark all read",
  activityAllTypes: "All Types",
  activityAllActors: "All Actors",
  activityActorAgent: "Agent",
  activityActorUser: "User",
  activityActorSystem: "System",
  activityUnreadOnly: "Unread only",
  activityPinned: "Pinned",
  activityRecent: "Recent",
  activityEmptyTitle: "No activities yet",
  activityEmptyHint: "Activities will appear here as you work on tasks",
  mentionLoading: "Loading mentions...",
  mentionAllStatuses: "All Statuses",
  mentionStatusPending: "Pending",
  mentionStatusAcknowledged: "Acknowledged",
  mentionStatusCompleted: "Completed",
  mentionStatusDismissed: "Dismissed",
  mentionAllTypes: "All Types",
  mentionTypeRequest: "Request",
  mentionTypeHandoff: "Handoff",
  mentionTypeReview: "Review",
  mentionTypeFyi: "FYI",
  mentionEmpty: "No mentions yet",
  mentionUser: "User",
  mentionUnknownAgent: "Unknown Agent",
  fileLoading: "Loading file...",
  canvasLoading: "Loading canvas...",
};

const PERSONA_UI_OVERRIDES: Partial<Record<PersonaId, Partial<Record<UiCopyKey, string>>>> = {
  companion: {
    taskViewEmptyTitle: "No session selected yet",
    taskViewEmptyBody: "Pick a session from the sidebar or start a new one, and we'll begin.",
    taskPromptTitle: "What we're working on",
    taskStatusPausedTitle: "Paused - I'm waiting on your cue.",
    taskStatusBlockedTitle: "Blocked - I need your approval.",
    taskStatusBlockedDetail: "Approve the pending request so I can continue.",
    taskStatusResume: "Continue",
    taskStatusResuming: "Continuing...",
    timelineTitle: "What we've done so far",
    timelineEmpty: "Nothing to show yet",
    mcLoading: "Getting Mission Control ready...",
    mcAgentsActiveLabel: "AGENTS ONLINE",
    mcTasksQueueLabel: "TASKS WAITING",
    mcAddAgent: "Add agent",
    mcAllAgentsLabel: "All agents",
    mcFeedEmpty: "Quiet right now",
    mcColumnEmpty: "Nothing here yet",
    mcWorkspaceLabel: "Workspace",
    mcMentionsLabel: "MENTIONS",
    mcStandupButton: "Check-in",
    mcWakeAgent: "Nudge",
    mcNoActiveTask: "Nothing active yet",
    mcTaskTab: "TASK",
    mcClearTask: "Clear",
    mcTaskUpdatedAt: "Updated {time}",
    mcTaskAssigneeLabel: "Assignee",
    mcTaskUnassigned: "Unassigned",
    mcTaskStageLabel: "Stage",
    mcTaskBriefTitle: "Brief",
    mcTaskUpdatesTitle: "Updates",
    mcTaskUpdatePlaceholder: "Share an update...",
    mcTaskPosting: "Sending...",
    mcTaskPostUpdate: "Send update",
    mcTaskMentionsTitle: "Mentions",
    mcTaskMentionPlaceholder: "Type @ to loop in an agent...",
    mcTaskEmpty: "Select a task to see details",
    mcHeartbeatNext: "next {time}",
    mcHeartbeatFound: "I found {mentions} mentions, {tasks} tasks",
    taskBoardEmptyTitle: "No tasks yet",
    taskBoardEmptyHint: "Drag tasks here when you are ready",
    rightProgressEmptyHint: "# here when you are ready",
    rightFilesEmptyHint: "# nothing changed yet",
    rightContextEmptyHint: "# waiting for context",
    rightFooterText: "local work only",
    workingStateLoading: "Getting working state...",
    workingStateTitle: "Working State",
    workingStateEdit: "Edit",
    workingStateAdd: "Add",
    workingStateEmptyHint: "No {label} yet.",
    workingStateReferencedFiles: "Referenced files:",
    workingStateHistoryTitle: "Working State History",
    workingStateHistoryLoading: "Loading history...",
    workingStateHistoryAllTypes: "All Types",
    workingStateHistoryEntries: "{count} moments",
    workingStateHistoryEmpty: "No history entries yet.",
    workingStateHistoryCurrent: "Current",
    workingStateHistoryRestore: "Restore",
    workingStateHistoryRestoring: "Restoring...",
    workingStateHistoryDelete: "Delete",
    workingStateHistoryDeleteConfirm: "Delete this history entry?",
    workingStateHistoryFilesLabel: "Files:",
    standupTitle: "Daily Standup Reports",
    standupGenerate: "Generate Report",
    standupGenerating: "Generating...",
    standupHistoryTitle: "Report History",
    standupEmpty: "No reports yet. Generate your first report to get started.",
    standupGeneratedAt: "Generated at {time}",
    standupCompletedTitle: "Completed",
    standupInProgressTitle: "In Progress",
    standupBlockedTitle: "Blocked",
    standupCompletedEmpty: "No tasks completed",
    standupInProgressEmpty: "No tasks in progress",
    standupBlockedEmpty: "No blocked tasks",
    mcpEmptyTitle: "No MCP servers configured.",
    mcpEmptyHint:
      'Click "Add Server" to connect to an MCP server and extend CoWork\'s capabilities.',
    scheduledNoWorkspaces: "No workspaces available",
    standupLoading: "Loading standup reports...",
    taskBoardLoading: "Getting the board ready...",
    taskBoardTitle: "Task board",
    taskBoardCount: "{count} tasks",
    taskBoardAllAgents: "All agents",
    taskBoardAllLabels: "All labels",
    taskBoardAllPriorities: "All priorities",
    taskBoardManageLabels: "Manage labels",
    activityLoading: "Gathering activity...",
    activityTitle: "Activity",
    activityMarkAllRead: "Mark all read",
    activityAllTypes: "All types",
    activityAllActors: "All actors",
    activityActorAgent: "Agent",
    activityActorUser: "You",
    activityActorSystem: "System",
    activityUnreadOnly: "Unread only",
    activityPinned: "Pinned",
    activityRecent: "Recent",
    activityEmptyTitle: "No activity yet",
    activityEmptyHint: "Activity will appear here as we work",
    mentionLoading: "Gathering mentions...",
    mentionAllStatuses: "All statuses",
    mentionStatusPending: "Pending",
    mentionStatusAcknowledged: "Acknowledged",
    mentionStatusCompleted: "Completed",
    mentionStatusDismissed: "Dismissed",
    mentionAllTypes: "All types",
    mentionTypeRequest: "Request",
    mentionTypeHandoff: "Handoff",
    mentionTypeReview: "Review",
    mentionTypeFyi: "FYI",
    mentionEmpty: "No mentions yet",
    mentionUser: "User",
    mentionUnknownAgent: "Unknown agent",
    fileLoading: "Opening file...",
    canvasLoading: "Preparing canvas...",
  },
};

export function getUiCopy(
  key: UiCopyKey,
  ctx: AgentMessageContext,
  replacements: Record<string, string | number> = {},
): string {
  const base = UI_COPY[key] || key;
  const override = ctx.persona ? PERSONA_UI_OVERRIDES[ctx.persona]?.[key] : undefined;
  const template = override || base;

  if (!template) return key;

  const userName = ctx.userName || "";
  let result = template.replace("{agentName}", ctx.agentName).replace("{userName}", userName);

  Object.entries(replacements).forEach(([token, value]) => {
    result = result.replace(new RegExp(`\\{${token}\\}`, "g"), String(value));
  });

  return result;
}

const PERSONA_MESSAGE_OVERRIDES: Partial<Record<PersonaId, Partial<Record<MessageKey, string>>>> = {
  companion: {
    welcome: "{agentName} here{userGreeting}. I'm with you.",
    welcomeSubtitle: "Tell me what you want to make or solve.",
    placeholder: "What's on your mind?",
    placeholderActive: "What should we do next?",
    taskStart: "Okay. I'm starting.",
    taskComplete: "All set.",
    taskWorking: "Working on it...",
    taskPaused: "Paused - I'm here when you're ready.",
    taskBlocked: "I need your ok to continue.",
    planCreated: "I sketched a path forward.",
    stepStarted: "Taking care of: {detail}",
    stepCompleted: "Step complete: {detail}",
    error: "I ran into a snag.",
    approval: "Can you confirm this for me?",
    verifying: "Double-checking...",
    verifyPassed: "Looks good.",
    verifyFailed: "Not quite right yet.",
    retrying: "Trying again (attempt {n}).",
    disclaimer: "{agentName} can make mistakes. Please check anything important.",
  },
};

const PERSONA_PLACEHOLDERS: Partial<Record<PersonaId, string[]>> = {
  companion: [
    "What's on your mind?",
    "Tell me what you want to make.",
    "How can we move this forward?",
  ],
};

/**
 * Message templates organized by personality type
 */
const MESSAGES: Record<PersonalityId, Record<MessageKey, string>> = {
  professional: {
    welcome: "{agentName} ready{userGreeting}.",
    welcomeSubtitle: "How can I assist you today?",
    placeholder: "What can I help with?",
    placeholderActive: "Next task?",
    taskStart: "Beginning task.",
    taskComplete: "Complete.",
    taskWorking: "Processing...",
    taskPaused: "Paused.",
    taskBlocked: "Needs approval.",
    planCreated: "Strategy prepared.",
    stepStarted: "Working on: {detail}",
    stepCompleted: "Step complete.",
    error: "Issue encountered.",
    approval: "Decision required.",
    verifying: "Verifying...",
    verifyPassed: "Verification passed.",
    verifyFailed: "Verification failed.",
    retrying: "Retrying (attempt {n}).",
    disclaimer: "Cowork OS can make mistakes. Please verify important information.",
  },
  friendly: {
    welcome: "Hey{userGreeting}! {agentName} here.",
    welcomeSubtitle: "What should we work on?",
    placeholder: "What's up?",
    placeholderActive: "What's next?",
    taskStart: "Let's do this!",
    taskComplete: "Done! Nice work.",
    taskWorking: "On it...",
    taskPaused: "Paused for now.",
    taskBlocked: "Need your approval.",
    planCreated: "Here's the plan!",
    stepStarted: "Tackling: {detail}",
    stepCompleted: "Got it!",
    error: "Oops, hit a snag.",
    approval: "Need your input!",
    verifying: "Checking our work...",
    verifyPassed: "Looks good!",
    verifyFailed: "Not quite right.",
    retrying: "Trying again (#{n}).",
    disclaimer: "{agentName} can make mistakes. Double-check anything important!",
  },
  concise: {
    welcome: "{agentName} ready{userGreeting}.",
    welcomeSubtitle: "Ready.",
    placeholder: "Task?",
    placeholderActive: "Next?",
    taskStart: "Starting.",
    taskComplete: "Done.",
    taskWorking: "Working...",
    taskPaused: "Paused.",
    taskBlocked: "Blocked.",
    planCreated: "Plan ready.",
    stepStarted: "{detail}",
    stepCompleted: "Done.",
    error: "Error.",
    approval: "Input needed.",
    verifying: "Checking...",
    verifyPassed: "Passed.",
    verifyFailed: "Failed.",
    retrying: "Retry #{n}.",
    disclaimer: "{agentName} may err. Verify.",
  },
  creative: {
    welcome: "{agentName} awakens{userGreeting}.",
    welcomeSubtitle: "Let's create something amazing.",
    placeholder: "What shall we dream up?",
    placeholderActive: "What adventure awaits?",
    taskStart: "The journey begins!",
    taskComplete: "Masterpiece complete.",
    taskWorking: "Crafting magic...",
    taskPaused: "Time stands still.",
    taskBlocked: "A gate awaits your key.",
    planCreated: "The blueprint emerges.",
    stepStarted: "Weaving: {detail}",
    stepCompleted: "Another piece falls into place.",
    error: "A twist in the tale.",
    approval: "Your vision is needed.",
    verifying: "Admiring our work...",
    verifyPassed: "It shines!",
    verifyFailed: "Needs refinement.",
    retrying: "A fresh canvas (take {n}).",
    disclaimer: "{agentName} is creative, not infallible. Verify the important bits.",
  },
  technical: {
    welcome: "{agentName} online{userGreeting}.",
    welcomeSubtitle: "Awaiting input.",
    placeholder: "Enter command.",
    placeholderActive: "Next command.",
    taskStart: "Initiating.",
    taskComplete: "Execution complete.",
    taskWorking: "Processing...",
    taskPaused: "Paused.",
    taskBlocked: "Blocked: approval required.",
    planCreated: "Execution plan generated.",
    stepStarted: "Executing: {detail}",
    stepCompleted: "Step executed.",
    error: "Error encountered.",
    approval: "Awaiting user input.",
    verifying: "Running verification...",
    verifyPassed: "Verification: PASS.",
    verifyFailed: "Verification: FAIL.",
    retrying: "Retry attempt {n}.",
    disclaimer: "{agentName} output may contain errors. Validate critical data.",
  },
  casual: {
    welcome: "Yo{userGreeting}! {agentName} here.",
    welcomeSubtitle: "What's the plan?",
    placeholder: "So, what are we doing?",
    placeholderActive: "And then?",
    taskStart: "Alright, here we go.",
    taskComplete: "Nailed it.",
    taskWorking: "Doing the thing...",
    taskPaused: "Paused for now.",
    taskBlocked: "Need your ok.",
    planCreated: "Got a game plan.",
    stepStarted: "On it: {detail}",
    stepCompleted: "Check.",
    error: "Uh oh.",
    approval: "Your call.",
    verifying: "Just checking...",
    verifyPassed: "We good.",
    verifyFailed: "Hmm, not quite.",
    retrying: "Round {n}, fight!",
    disclaimer: "{agentName} isn't perfect. Double-check the important stuff.",
  },
  custom: {
    welcome: "{agentName} ready{userGreeting}.",
    welcomeSubtitle: "What should we work on?",
    placeholder: "What should we work on?",
    placeholderActive: "What's next?",
    taskStart: "Starting.",
    taskComplete: "Done.",
    taskWorking: "Working...",
    taskPaused: "Paused.",
    taskBlocked: "Needs approval.",
    planCreated: "Plan ready.",
    stepStarted: "Working on: {detail}",
    stepCompleted: "Step complete.",
    error: "Issue encountered.",
    approval: "Input needed.",
    verifying: "Verifying...",
    verifyPassed: "Passed.",
    verifyFailed: "Failed.",
    retrying: "Retrying ({n}).",
    disclaimer: "Cowork OS can make mistakes. Please verify important information.",
  },
};

/**
 * Add emoji based on emojiUsage setting
 */
function addEmoji(message: string, key: MessageKey, emojiUsage: EmojiUsage): string {
  if (emojiUsage === "none") return message;

  const emojiMap: Partial<Record<MessageKey, string>> = {
    taskComplete: "✓",
    error: "⚠",
    approval: "❓",
    verifyPassed: "✓",
    verifyFailed: "✗",
  };

  const emoji = emojiMap[key];
  if (!emoji) return message;

  // For minimal, only add checkmarks
  if (
    emojiUsage === "minimal" &&
    !["taskComplete", "verifyPassed", "stepCompleted"].includes(key)
  ) {
    return message;
  }

  return `${emoji} ${message}`;
}

/**
 * Get a personalized message
 */
export function getMessage(key: MessageKey, ctx: AgentMessageContext, detail?: string): string {
  const { agentName, userName, personality, emojiUsage, quirks, persona } = ctx;

  // Get base message for personality
  const messages = MESSAGES[personality] || MESSAGES.professional;
  let message = messages[key] || MESSAGES.professional[key] || key;

  // Apply persona override if available
  if (persona) {
    const personaOverrides = PERSONA_MESSAGE_OVERRIDES[persona];
    if (personaOverrides?.[key]) {
      message = personaOverrides[key] as string;
    }
  }

  // Replace placeholders
  const userGreeting = userName ? `, ${userName}` : "";
  message = message
    .replace("{agentName}", agentName)
    .replace("{userGreeting}", userGreeting)
    .replace("{detail}", detail || "")
    .replace("{n}", detail || "1");

  // Add emoji if appropriate
  message = addEmoji(message, key, emojiUsage);

  // Add catchphrase to welcome
  if (key === "welcomeSubtitle" && quirks.catchphrase) {
    message = `${message} ${quirks.catchphrase}`;
  }

  return message;
}

/**
 * Get a random placeholder from personality-appropriate options
 */
export function getRandomPlaceholder(ctx: AgentMessageContext): string {
  const { personality, userName, agentName, persona } = ctx;

  const placeholders: Record<PersonalityId, string[]> = {
    professional: ["What can I help with?", "How may I assist?", `${agentName} standing by.`],
    friendly: [
      "What's on your mind?",
      "What's up?",
      "Ready when you are!",
      userName ? `What's next, ${userName}?` : "What's next?",
    ],
    concise: ["Task?", "Input?", "Next?"],
    creative: ["What shall we create?", "What adventure awaits?", "Let's make something."],
    technical: ["Enter command.", "Awaiting input.", `${agentName} ready.`],
    casual: [
      "So what's the plan?",
      "What are we doing?",
      userName ? `What's up, ${userName}?` : "What's up?",
    ],
    custom: ["What should we work on?", "What's next?", `${agentName} ready.`],
  };

  const personaOptions = (persona && PERSONA_PLACEHOLDERS[persona]) || [];
  const options =
    personaOptions.length > 0
      ? [...personaOptions]
      : placeholders[personality] || placeholders.professional;

  if (persona === "companion" && userName) {
    options.push(`What's next, ${userName}?`);
  }
  return options[Math.floor(Math.random() * options.length)];
}

export default getMessage;
