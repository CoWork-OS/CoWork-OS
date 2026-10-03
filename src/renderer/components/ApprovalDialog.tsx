import { ApprovalRequest } from "../../shared/types";

interface ApprovalDialogProps {
  approval: ApprovalRequest;
  onApprove: () => void;
  onDeny: () => void;
}

export function ApprovalDialog({ approval, onApprove, onDeny }: ApprovalDialogProps) {
  const getCommandExplanation = (details: ApprovalRequest["details"]) => {
    const command = details?.command;
    if (!command || typeof command !== "string") return null;

    const explanation: string[] = [];

    if (command.includes(";")) {
      explanation.push("Runs multiple commands in sequence.");
    }

    if (/\bls\s+-la\s+\/Applications\b/.test(command)) {
      explanation.push("Lists the contents of /Applications.");
    }

    if (/\bls\s+-la\s+~\/Applications\b/.test(command)) {
      explanation.push("Lists the contents of ~/Applications if it exists.");
    }

    const grepMatches = [...command.matchAll(/\bgrep\s+-i\s+([^\s;]+)/g)];
    if (grepMatches.length > 0) {
      const terms = grepMatches.map((match) => match[1].replace(/["']/g, "")).join(", ");
      explanation.push(`Filters the output for "${terms}" (case-insensitive).`);
    }

    if (command.includes("2>/dev/null")) {
      explanation.push("Suppresses non-critical errors (like missing folders).");
    }

    return explanation.length > 0 ? explanation.join(" ") : null;
  };

  const getApprovalIcon = (type: ApprovalRequest["type"]) => {
    switch (type) {
      case "delete_file":
      case "delete_multiple":
      case "memory_delete":
        return "🗑️";
      case "bulk_rename":
        return "📝";
      case "network_access":
        return "🌐";
      case "external_service":
        return "🔗";
      case "location_access":
        return "📍";
      default:
        return "⚠️";
    }
  };

  const getApprovalColor = (type: ApprovalRequest["type"]) => {
    switch (type) {
      case "delete_file":
      case "delete_multiple":
      case "memory_delete":
        return "approval-danger";
      case "network_access":
      case "external_service":
      case "location_access":
        return "approval-warning";
      default:
        return "approval-info";
    }
  };

  return (
    <div className="approval-dialog-overlay">
      <div className={`approval-dialog ${getApprovalColor(approval.type)}`}>
        <div className="approval-icon">{getApprovalIcon(approval.type)}</div>

        <div className="approval-content">
          <h3>Need Your Input</h3>
          <p className="approval-description">{approval.description}</p>
          {getCommandExplanation(approval.details) && (
            <p className="approval-explanation">{getCommandExplanation(approval.details)}</p>
          )}

          {approval.details && (
            <div className="approval-details">
              <pre>{JSON.stringify(approval.details, null, 2)}</pre>
            </div>
          )}
        </div>

        <div className="approval-actions">
          <button className="button-secondary" onClick={onDeny}>
            Deny
          </button>
          <button className="button-primary" onClick={onApprove}>
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}
