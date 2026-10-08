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
