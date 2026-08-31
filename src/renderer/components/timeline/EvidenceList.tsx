import type { TimelineEvidence } from "../../../shared/timeline-events";

interface EvidenceListProps {
  evidence: TimelineEvidence[];
}

function FileEvidenceRow({ item }: { item: Extract<TimelineEvidence, { type: "file" }> }) {
  const opLabel: Record<string, string> = {
    read: "read",
    write: "created",
    edit: "edited",
    delete: "deleted",
  };
  const label = item.operation ? (opLabel[item.operation] ?? item.operation) : "accessed";
  return (
    <div className="evidence-row evidence-file">
      <span className="evidence-op-badge" data-op={item.operation ?? "read"}>
        {label}
      </span>
      <span className="evidence-path" title={item.path}>
        {item.path}
      </span>
      {item.lines && <span className="evidence-lines">{item.lines}</span>}
    </div>
  );
}

function CommandEvidenceRow({ item }: { item: Extract<TimelineEvidence, { type: "command" }> }) {
  return (
    <div className="evidence-row evidence-command">
      <span className="evidence-label">{item.label}</span>
      <code className="evidence-code">{item.command}</code>
      {item.output && <pre className="evidence-output">{item.output.slice(0, 300)}</pre>}
    </div>
  );
}

function QueryEvidenceRow({ item }: { item: Extract<TimelineEvidence, { type: "query" }> }) {
  return (
    <div className="evidence-row evidence-query">
      <span className="evidence-label">{item.label}</span>
      <code className="evidence-code">{item.query}</code>
    </div>
  );
}

function ArtifactEvidenceRow({ item }: { item: Extract<TimelineEvidence, { type: "artifact" }> }) {
  return (
    <div className="evidence-row evidence-artifact">
      <span className="evidence-label">{item.label}</span>
      <span className="evidence-path" title={item.path}>
        {item.path}
      </span>
    </div>
  );
}

function ApprovalEvidenceRow({ item }: { item: Extract<TimelineEvidence, { type: "approval" }> }) {
  return (
    <div className="evidence-row evidence-approval">
      <span className={`evidence-risk-badge risk-${item.risk ?? "low"}`}>
        {item.risk ?? "low"} risk
      </span>
      <span className="evidence-label">{item.label}</span>
    </div>
  );
}

function UrlEvidenceRow({ item }: { item: Extract<TimelineEvidence, { type: "url" }> }) {
  return (
    <div className="evidence-row evidence-url">
      <span className="evidence-label">{item.label}</span>
      <span className="evidence-url-value" title={item.url}>
        {item.url}
      </span>
    </div>
  );
}

function RuntimeLogEvidenceRow({
  item,
}: {
  item: Extract<TimelineEvidence, { type: "runtime_log" }>;
}) {
  return (
    <div className="evidence-row evidence-command">
      <span className="evidence-label">{item.label}</span>
      {item.source ? <span className="evidence-lines">{item.source}</span> : null}
      <pre className="evidence-output">{item.message.slice(0, 1200)}</pre>
    </div>
  );
}

export function EvidenceList({ evidence }: EvidenceListProps) {
  if (evidence.length === 0) return null;
  return (
    <div className="evidence-list">
      {evidence.map((item, i) => {
        // biome-ignore lint/suspicious/noArrayIndexKey: evidence items have no stable id
        const key = i;
        switch (item.type) {
          case "file":
            return <FileEvidenceRow key={key} item={item} />;
          case "command":
            return <CommandEvidenceRow key={key} item={item} />;
          case "query":
            return <QueryEvidenceRow key={key} item={item} />;
          case "artifact":
            return <ArtifactEvidenceRow key={key} item={item} />;
          case "approval":
            return <ApprovalEvidenceRow key={key} item={item} />;
          case "url":
            return <UrlEvidenceRow key={key} item={item} />;
          case "runtime_log":
            return <RuntimeLogEvidenceRow key={key} item={item} />;
          default:
            return null;
        }
      })}
    </div>
  );
}
