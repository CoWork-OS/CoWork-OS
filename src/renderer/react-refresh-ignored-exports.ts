const MAIN_CONTENT_REFRESH_IGNORED_EXPORTS = [
  "getWorkspaceStatusFolderLabel",
  "getVisibleGeneratedImageCards",
  "getInlinePreviewKindForGeneratedFile",
  "getInlinePreviewKindForTaskEvent",
  "collectGeneratedImageStacks",
  "shouldSuppressInitialPromptUserEvent",
  "deriveTaskHeaderPresentation",
  "shouldCreateFreshTaskForSend",
  "isChatExecutionTask",
  "composeMessageWithAttachments",
  "resolveSafeCollapsedBubbleHeight",
  "createQuotedAssistantMessage",
  "isXComLink",
  "normalizeSourcesSection",
  "normalizeMarkdownForDisplay",
  "normalizeTimelineTitleMarkdownForDisplay",
  "cleanAssistantMessageForDisplay",
  "getDefaultTranscriptMode",
  "shouldShowBootstrapProgressRow",
  "getBootstrapProgressTitle",
  "deriveAgentReasoningPanelState",
  "selectVisibleTaskFeedRows",
  "hasInactiveStringSetEntries",
  "pruneStringSetToActiveIds",
  "collectInlineRunCommandSessionIds",
  "estimateTaskFeedRowHeight",
  "getAutoScrollTargetTop",
  "shouldScheduleAutoScrollWrite",
];

declare global {
  interface Window {
    __getReactRefreshIgnoredExports?: (context: { id: string }) => string[];
  }
}

const previousGetIgnoredExports = window.__getReactRefreshIgnoredExports;

window.__getReactRefreshIgnoredExports = (context) => {
  const previous = previousGetIgnoredExports?.(context) ?? [];
  const normalizedId = context.id.split("?")[0] ?? context.id;
  if (!normalizedId.endsWith("/components/MainContent.tsx")) {
    return previous;
  }
  return Array.from(new Set([...previous, ...MAIN_CONTENT_REFRESH_IGNORED_EXPORTS]));
};

export {};
