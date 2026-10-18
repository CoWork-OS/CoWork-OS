/** Visual analysis exports file pixels to the selected model provider. */
export function isVisualAnalysisConsentRequest(
  toolName: string | undefined,
  approvalType: string | null | undefined,
): boolean {
  return (
    approvalType === "data_export" &&
    (toolName === "analyze_image" || toolName === "read_pdf_visual")
  );
}

/**
 * Requests that send local content to the selected model provider and keep explicit consent
 * even in Full access: visual analysis (file pixels) and read_terminal (what the user's own
 * terminal tab printed, which can hold secrets redaction misses). A desktop task asks the
 * user; a headless task without an approval channel stays blocked.
 */
export function isExplicitExportConsentRequest(
  toolName: string | undefined,
  approvalType: string | null | undefined,
): boolean {
  return (
    isVisualAnalysisConsentRequest(toolName, approvalType) ||
    (approvalType === "data_export" && toolName === "read_terminal")
  );
}
