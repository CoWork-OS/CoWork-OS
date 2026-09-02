export { MainContent } from "./MainContent";
export { TaskSessionLineageFooter } from "./MainContent";
export { ModelDropdown } from "./ModelDropdown";
export { TaskAutomationModal } from "./TaskAutomationModal";
export { getWorkspaceStatusFolderLabel } from "./welcome-suggestions";
export {
  getVisibleEndOfTaskArtifactCards,
  getInlinePreviewKindForGeneratedFile,
  extractGeneratedArtifactPathsFromText,
  getInlinePreviewKindForTaskEvent,
  shouldRenderOpenArtifactCardAtEvent,
  collectLatestEndOfTaskArtifactCards,
  collectEndOfTaskArtifactCardStacks,
} from "./artifact-logic";
export type { EndOfTaskArtifactCard, EndOfTaskArtifactStack } from "./artifact-logic";
export {
  shouldSuppressInitialPromptUserEvent,
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
