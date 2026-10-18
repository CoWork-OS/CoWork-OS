import { buildExportRiskChain } from "../../shared/export-risk-chain";
import type { ApprovalRequest, PermissionSecurityContext } from "../../shared/types";
import "./export-risk-review.css";

/** Display only the main-process permission context, without retaining it between requests. */
export function ExportRiskReview({ approval }: { approval: ApprovalRequest }) {
  // A URL alone is also present on read-only network and site-access approvals.
  if (approval.type !== "data_export" && approval.details?.kind !== "browser_upload") return null;
  const context = approval.details?.permissionPrompt?.securityContext as
    | PermissionSecurityContext
    | undefined;
  const chain = buildExportRiskChain(context);
  if (!chain) return null;
  return (
    <section className="export-risk-review" aria-label="Export risk explanation">
      <h4>Source and destination</h4>
      <dl>
        <dt>Source context</dt>
        <dd>{chain.source}</dd>
        <dt>Data</dt>
        <dd>{chain.data}</dd>
        <dt>Action</dt>
        <dd>{chain.sideEffect}</dd>
        <dt>Destination</dt>
        <dd>{chain.destination}</dd>
      </dl>
      {chain.includesUntrustedSource ? (
        <p>
          External content is associated with this action. Review the outgoing data and destination.
        </p>
      ) : null}
    </section>
  );
}
