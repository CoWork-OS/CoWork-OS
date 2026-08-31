export const LEGAL_DEMAND_INTAKE_COMMAND = "litigation-legal-demand-intake";

const CLAUDE_FOR_LEGAL_COMMAND_PREFIXES = [
  "ai-governance-legal-",
  "cocounsel-legal-",
  "commercial-legal-",
  "corporate-legal-",
  "employment-legal-",
  "ip-legal-",
  "legal-builder-hub-",
  "legal-clinic-",
  "litigation-legal-",
  "privacy-legal-",
  "product-legal-",
  "regulatory-legal-",
];

const LEGAL_WORKFLOW_DENY_PATTERN =
  /\b(auto-updater|disable|uninstall|registry-browser|related-skills-surfacer|skill-manager|guardrails)\b/i;

const LEGAL_WORKFLOW_ALLOW_PATTERN =
  /\b(add|analysis|assessment|brief|chart|checklist|classification|clearance|close|cold-start|comments|compliance|consent|customize|deadlines|deep-research|diff|draft|escalation|extraction|flagger|generation|guide|handoff|history|hold|intake|interview|inventory|letter|log|memo|minutes|open|policy|portfolio|prep|qa|query|ramp|redraft|research|review|starter|status|summary|triage|update|workspace)\b/i;

export type LegalDemandIntakeFormValues = {
  title: string;
  demandType: string;
  tone: string;
  toneRationale: string;
  responseWindow: string;
  settlementMarking: string;
  sender: string;
  recipient: string;
  relationship: string;
  triggeringEvent: string;
  legalBasis: string;
  desiredOutcome: string;
  priorOutreach: string;
  delivery: string;
  signer: string;
  copies: string;
  seedDocs: string;
  strategicNotes: string;
};

export type GenericLegalWorkflowFormValues = {
  matterTitle: string;
  jurisdiction: string;
  roleOrSide: string;
  objective: string;
  keyFacts: string;
  documents: string;
  deadlines: string;
  stakeholders: string;
  constraints: string;
  outputPreferences: string;
};

export type LegalWorkflowIntakeKind = "demand-intake" | "general";

export type LegalWorkflowInvocation = {
  matched: boolean;
  commandName: string;
  args: string;
  kind: LegalWorkflowIntakeKind;
};

export function parseLegalDemandIntakeSlashPrompt(prompt: string): {
  matched: boolean;
  args: string;
} {
  const trimmed = String(prompt || "").trim();
  const pattern = new RegExp(`^/${LEGAL_DEMAND_INTAKE_COMMAND}(?:\\s+([\\s\\S]*))?$`, "i");
  const match = pattern.exec(trimmed);
  return {
    matched: Boolean(match),
    args: (match?.[1] || "").trim(),
  };
}

export function parseLegalWorkflowSlashPrompt(prompt: string): LegalWorkflowInvocation {
  const trimmed = String(prompt || "").trim();
  const match = /^\/([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  const commandName = (match?.[1] || "").toLowerCase();
  const args = (match?.[2] || "").trim();
  if (!commandName) {
    return { matched: false, commandName: "", args: "", kind: "general" };
  }

  if (commandName === LEGAL_DEMAND_INTAKE_COMMAND) {
    return { matched: true, commandName, args, kind: "demand-intake" };
  }

  const isClaudeForLegalCommand = CLAUDE_FOR_LEGAL_COMMAND_PREFIXES.some((prefix) =>
    commandName.startsWith(prefix),
  );
  const makesSenseAsWorkflowIntake =
    isClaudeForLegalCommand &&
    LEGAL_WORKFLOW_ALLOW_PATTERN.test(commandName) &&
    !LEGAL_WORKFLOW_DENY_PATTERN.test(commandName);

  return {
    matched: makesSenseAsWorkflowIntake,
    commandName: makesSenseAsWorkflowIntake ? commandName : "",
    args: makesSenseAsWorkflowIntake ? args : "",
    kind: "general",
  };
}

function toTitleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => {
      if (/^[A-Z0-9&.-]+$/.test(part)) return part;
      return part.slice(0, 1).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join(" ");
}

function inferDemandType(args: string): string {
  const lower = args.toLowerCase();
  if (/\b(invoice|invoices|debt|payment|owed|unpaid|receivable)\b/.test(lower)) return "payment";
  if (/\b(breach|default|cure|contract)\b/.test(lower)) return "breach-cure";
  if (/\b(cease|desist|infring|tortious|harass)\b/.test(lower)) return "cease-desist";
  if (/\b(employee|employment|separation|severance|restrictive covenant)\b/.test(lower)) {
    return "employment-separation";
  }
  if (/\b(preserve|preservation|hold|evidence)\b/.test(lower)) return "preservation";
  return "payment";
}

function inferMatterTitleAndRecipient(args: string): { title: string; recipient: string } {
  const cleaned = args.replace(/\s+/g, " ").trim();
  if (!cleaned) return { title: "", recipient: "" };

  const connectorMatch = /^(.+?)\s+(?:against|with|to|from)\s+(.+)$/i.exec(cleaned);
  if (connectorMatch?.[1] && connectorMatch[2]) {
    const subject = toTitleCase(connectorMatch[1]);
    const recipient = toTitleCase(connectorMatch[2]);
    return { title: `${subject} - ${recipient}`, recipient };
  }

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length >= 4 && inferDemandType(cleaned) === "payment") {
    const recipient = toTitleCase(words.slice(-2).join(" "));
    const subject = toTitleCase(words.slice(0, -2).join(" "));
    return { title: subject ? `${subject} - ${recipient}` : recipient, recipient };
  }

  return { title: toTitleCase(cleaned), recipient: "" };
}

export function buildLegalDemandIntakeInitialValues(prompt: string): LegalDemandIntakeFormValues {
  const parsed = parseLegalDemandIntakeSlashPrompt(prompt);
  const { title, recipient } = inferMatterTitleAndRecipient(parsed.args);
  return {
    title,
    demandType: inferDemandType(parsed.args),
    tone: "measured",
    toneRationale: "",
    responseWindow: "14 days",
    settlementMarking: "Not sure - flag for review",
    sender: "",
    recipient,
    relationship: "",
    triggeringEvent: "",
    legalBasis: "",
    desiredOutcome: "",
    priorOutreach: "",
    delivery: "",
    signer: "",
    copies: "",
    seedDocs: "",
    strategicNotes: "",
  };
}

export function buildLegalDemandIntakeFollowUp(values: LegalDemandIntakeFormValues): string {
  const line = (label: string, value: string) => `- ${label}: ${value.trim() || "[not provided]"}`;
  return [
    "Demand intake details for /litigation-legal-demand-intake.",
    "Use these answers to continue the intake. Treat blanks as intentionally skipped for now and flag them in the intake.",
    "",
    "## Posture",
    line("Short title", values.title),
    line("Demand type", values.demandType),
    line("Tone", values.tone),
    line("Tone rationale", values.toneRationale),
    line("Response window", values.responseWindow),
    line("Settlement communication marking", values.settlementMarking),
    line("Signer", values.signer),
    "",
    "## Parties",
    line("Sender", values.sender),
    line("Recipient", values.recipient),
    line("Relationship", values.relationship),
    "",
    "## Triggering Event",
    values.triggeringEvent.trim() || "[not provided]",
    "",
    "## Legal / Contractual Basis",
    values.legalBasis.trim() || "[not provided]",
    "",
    "## Desired Outcome",
    values.desiredOutcome.trim() || "[not provided]",
    "",
    "## Prior Outreach",
    values.priorOutreach.trim() || "[not provided]",
    "",
    "## Distribution",
    line("Delivery method", values.delivery),
    line("Copies", values.copies),
    "",
    "## Seed Documents",
    values.seedDocs.trim() || "[not provided]",
    "",
    "## Strategic Notes",
    values.strategicNotes.trim() || "[not provided]",
  ].join("\n");
}

export function buildGenericLegalWorkflowInitialValues(
  invocation: LegalWorkflowInvocation,
): GenericLegalWorkflowFormValues {
  const args = invocation.args.replace(/\s+/g, " ").trim();
  return {
    matterTitle: args ? toTitleCase(args) : "",
    jurisdiction: "",
    roleOrSide: "",
    objective: args,
    keyFacts: "",
    documents: "",
    deadlines: "",
    stakeholders: "",
    constraints: "",
    outputPreferences: "",
  };
}

export function buildGenericLegalWorkflowFollowUp(
  invocation: LegalWorkflowInvocation,
  values: GenericLegalWorkflowFormValues,
): string {
  const command = invocation.commandName
    ? `/${invocation.commandName}`
    : "the selected legal workflow";
  const line = (label: string, value: string) => `- ${label}: ${value.trim() || "[not provided]"}`;
  return [
    `Legal workflow context for ${command}.`,
    "Use these answers to continue the selected Claude-for-Legal task. Treat blanks as intentionally skipped for now and flag missing inputs before relying on them.",
    "",
    "## Matter",
    line("Matter / project title", values.matterTitle),
    line("Jurisdiction / governing law", values.jurisdiction),
    line("Role / side / perspective", values.roleOrSide),
    "",
    "## Objective",
    values.objective.trim() || "[not provided]",
    "",
    "## Key Facts / Timeline",
    values.keyFacts.trim() || "[not provided]",
    "",
    "## Documents / Sources",
    values.documents.trim() || "[not provided]",
    "",
    "## Deadlines / Risk Triggers",
    values.deadlines.trim() || "[not provided]",
    "",
    "## Stakeholders / Audience",
    values.stakeholders.trim() || "[not provided]",
    "",
    "## Constraints / Assumptions",
    values.constraints.trim() || "[not provided]",
    "",
    "## Output Preferences / Review Notes",
    values.outputPreferences.trim() || "[not provided]",
  ].join("\n");
}
