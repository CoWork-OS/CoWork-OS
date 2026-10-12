export { MainContent } from "./MainContent";
export { TaskSessionLineageFooter } from "./MainContent";
export { ModelDropdown } from "./ModelDropdown";
export { TaskAutomationModal } from "./TaskAutomationModal";
export { getWorkspaceStatusFolderLabel } from "./welcome-suggestions";
export {
  getVisibleGeneratedImageCards,
  getInlinePreviewKindForGeneratedFile,
  getInlinePreviewKindForTaskEvent,
  collectGeneratedImageStacks,
} from "./artifact-logic";
export type { GeneratedImageCard, GeneratedImageStack } from "./artifact-logic";
export {
  shouldSuppressInitialPromptUserEvent,
  getBotTranscriptSpeaker,
  deriveTaskHeaderPresentation,
  shouldCreateFreshTaskForSend,
  isChatExecutionTask,
} from "./task-event-presentation";
export { composeMessageWithAttachments } from "./attachments";
export type { ImportedAttachment } from "./attachments";
export {
  resolveSafeCollapsedBubbleHeight,
  normalizeQuotedAssistantMarkdownPreview,
  createQuotedAssistantMessage,
} from "./message-ui";
export {
  isXComLink,
  normalizeSourcesSection,
  normalizeMarkdownForDisplay,
  normalizeTimelineTitleMarkdownForDisplay,
  cleanAssistantMessageForDisplay,
} from "./markdown-normalization";
export {
  getDefaultTranscriptMode,
  shouldShowBootstrapProgressRow,
  getBootstrapProgressTitle,
  deriveAgentReasoningPanelState,
  selectVisibleTaskFeedRows,
  isCompletionSummaryCoveredByAssistantEvent,
  hasInactiveStringSetEntries,
  pruneStringSetToActiveIds,
  collectInlineRunCommandSessionIds,
  estimateTaskFeedRowHeight,
  getAutoScrollTargetTop,
  shouldScheduleAutoScrollWrite,
} from "./task-feed-logic";
export type { TranscriptMode, AgentReasoningPanelState } from "./task-feed-logic";
export {
  formatTimelineErrorTitleForDisplay,
  formatStepFailedTitleForDisplay,
} from "./timeline-event-rendering";
