import type { AgentDaemon } from "./daemon";

export interface CliApprovalResponse {
  approvalId: string;
  approved: boolean;
  expectedRevisionHash: string;
}

/** The CLI supplies the hash the operator reviewed, never a freshly fetched revision. */
export function parseCliApprovalResponse(argv: string[]): CliApprovalResponse | null {
  if (!argv.includes("--cowork-cli-approval-response")) return null;
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    const next = index < 0 ? undefined : argv[index + 1];
    return next && !next.startsWith("--") ? next : undefined;
  };
  const approvalId = value("--approval-id");
  const expectedRevisionHash = value("--revision-hash");
  const approved = argv.includes("--approved");
  if (
    !approvalId ||
    !approvalId.trim() ||
    approvalId.length > 128 ||
    !expectedRevisionHash ||
    !/^[0-9a-f]{64}$/.test(expectedRevisionHash) ||
    approved === argv.includes("--rejected")
  )
    return null;
  return { approvalId, approved, expectedRevisionHash };
}

export function respondToCliApprovalResponse(
  daemon: Pick<AgentDaemon, "respondToApproval">,
  response: CliApprovalResponse,
) {
  return daemon.respondToApproval(
    response.approvalId,
    response.approved,
    undefined,
    undefined,
    response.expectedRevisionHash,
  );
}
