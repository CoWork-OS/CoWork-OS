import { useState, useEffect, useCallback } from "react";
import { FileText, X } from "lucide-react";
import {
  buildGenericLegalWorkflowFollowUp,
  buildGenericLegalWorkflowInitialValues,
  buildLegalDemandIntakeFollowUp,
  buildLegalDemandIntakeInitialValues,
  type GenericLegalWorkflowFormValues,
  type LegalDemandIntakeFormValues,
  type LegalWorkflowInvocation,
} from "../../utils/legal-demand-intake";

const LEGAL_DEMAND_TYPE_OPTIONS = [
  { value: "payment", title: "Payment demand", description: "Overdue invoice / liquidated debt" },
  {
    value: "breach-cure",
    title: "Breach / notice to cure",
    description: "Contract default with cure window",
  },
  {
    value: "cease-desist",
    title: "Cease and desist",
    description: "Stop infringing or tortious activity",
  },
  {
    value: "employment-separation",
    title: "Employment / separation",
    description: "Restrictive covenant, severance",
  },
  { value: "preservation", title: "Preservation", description: "Hold-evidence notice" },
  { value: "other", title: "Other", description: "Tell me more in the facts" },
];

const LEGAL_DEMAND_TONE_OPTIONS = ["measured", "assertive", "aggressive"];
const LEGAL_DEMAND_RESPONSE_WINDOWS = [
  "7 days",
  "14 days",
  "21 days",
  "30 days",
  "Per contract / other",
];
const LEGAL_DEMAND_MARKINGS = [
  "None",
  "Without prejudice",
  "Without prejudice save as to costs",
  "Not sure - flag for review",
];

export function LegalDemandIntakePromptCard({
  prompt,
  onSubmit,
  onDismiss,
}: {
  prompt: string;
  onSubmit: (message: string) => void;
  onDismiss: () => void;
}) {
  const [values, setValues] = useState<LegalDemandIntakeFormValues>(() =>
    buildLegalDemandIntakeInitialValues(prompt),
  );

  useEffect(() => {
    setValues(buildLegalDemandIntakeInitialValues(prompt));
  }, [prompt]);

  const updateValue = useCallback((field: keyof LegalDemandIntakeFormValues, value: string) => {
    setValues((prev) => ({ ...prev, [field]: value }));
  }, []);

  const renderChip = (field: keyof LegalDemandIntakeFormValues, value: string, label = value) => (
    <button
      key={`${field}-${value}`}
      type="button"
      className={`legal-intake-chip ${values[field] === value ? "selected" : ""}`}
      onClick={() => updateValue(field, value)}
    >
      {label}
    </button>
  );

  const renderTextarea = (
    field: keyof LegalDemandIntakeFormValues,
    placeholder: string,
    rows = 3,
  ) => (
    <textarea
      className="legal-intake-textarea"
      rows={rows}
      value={String(values[field] || "")}
      placeholder={placeholder}
      onChange={(event) => updateValue(field, event.target.value)}
    />
  );

  const canSubmit = values.title.trim().length > 0;

  return (
    <section className="legal-intake-card" aria-label="Demand letter details">
      <header className="legal-intake-card-header">
        <div className="legal-intake-card-title">
          <FileText size={18} aria-hidden="true" />
          <span>Demand letter details</span>
        </div>
        <button
          type="button"
          className="legal-intake-dismiss"
          onClick={onDismiss}
          aria-label="Dismiss demand intake form"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </header>

      <div className="legal-intake-card-body">
        <label className="legal-intake-field legal-intake-field-full">
          <span>Short title for this matter</span>
          {renderTextarea("title", "e.g. Unpaid invoices - Acme Logistics", 2)}
        </label>

        <div className="legal-intake-field legal-intake-field-full">
          <span>What kind of demand is this?</span>
          <div className="legal-intake-type-grid">
            {LEGAL_DEMAND_TYPE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`legal-intake-type-option ${values.demandType === option.value ? "selected" : ""}`}
                onClick={() => updateValue("demandType", option.value)}
              >
                <span className="legal-intake-type-title">{option.title}</span>
                <span className="legal-intake-type-description">{option.description}</span>
              </button>
            ))}
          </div>
        </div>

        <label className="legal-intake-field">
          <span>Sender</span>
          <input
            className="legal-intake-input"
            value={values.sender}
            placeholder="Our company / client"
            onChange={(event) => updateValue("sender", event.target.value)}
          />
        </label>

        <label className="legal-intake-field">
          <span>Recipient</span>
          <input
            className="legal-intake-input"
            value={values.recipient}
            placeholder="Counterparty, entity, address"
            onChange={(event) => updateValue("recipient", event.target.value)}
          />
        </label>

        <label className="legal-intake-field legal-intake-field-full">
          <span>Relationship / audience</span>
          <input
            className="legal-intake-input"
            value={values.relationship}
            placeholder="Customer, vendor, ex-employee, competitor; GC, CEO, counsel, individual"
            onChange={(event) => updateValue("relationship", event.target.value)}
          />
        </label>

        <div className="legal-intake-field legal-intake-field-full">
          <span>What tone should the letter strike?</span>
          <div className="legal-intake-chip-row">
            {LEGAL_DEMAND_TONE_OPTIONS.map((tone) =>
              renderChip("tone", tone, tone[0].toUpperCase() + tone.slice(1)),
            )}
          </div>
          {renderTextarea(
            "toneRationale",
            "One-line rationale - relationship, amount, litigation likelihood",
            2,
          )}
        </div>

        <div className="legal-intake-field legal-intake-field-full">
          <span>How long do they get to respond or comply?</span>
          <div className="legal-intake-chip-row">
            {LEGAL_DEMAND_RESPONSE_WINDOWS.map((window) => renderChip("responseWindow", window))}
          </div>
        </div>

        <div className="legal-intake-field legal-intake-field-full">
          <span>Settlement-communication marking</span>
          <div className="legal-intake-chip-row">
            {LEGAL_DEMAND_MARKINGS.map((marking) => renderChip("settlementMarking", marking))}
          </div>
        </div>

        <label className="legal-intake-field legal-intake-field-full">
          <span>Triggering event and evidence</span>
          {renderTextarea("triggeringEvent", "What happened, when, and what evidence exists?", 4)}
        </label>

        <label className="legal-intake-field legal-intake-field-full">
          <span>Legal / contractual basis</span>
          {renderTextarea(
            "legalBasis",
            "Contract sections, governing law, statutes, rules, placeholders to verify",
            3,
          )}
        </label>

        <label className="legal-intake-field legal-intake-field-full">
          <span>Desired outcome</span>
          {renderTextarea(
            "desiredOutcome",
            "Payment of $X by date Y; cure within N days; stop activity Z",
            3,
          )}
        </label>

        <label className="legal-intake-field legal-intake-field-full">
          <span>Prior outreach</span>
          {renderTextarea(
            "priorOutreach",
            "Informal asks, responses so far, why demand-letter escalation now",
            3,
          )}
        </label>

        <label className="legal-intake-field">
          <span>Delivery method</span>
          <input
            className="legal-intake-input"
            value={values.delivery}
            placeholder="Email, courier, certified mail, counsel"
            onChange={(event) => updateValue("delivery", event.target.value)}
          />
        </label>

        <label className="legal-intake-field">
          <span>Signer</span>
          <input
            className="legal-intake-input"
            value={values.signer}
            placeholder="You, client, GC, instructed counsel"
            onChange={(event) => updateValue("signer", event.target.value)}
          />
        </label>

        <label className="legal-intake-field legal-intake-field-full">
          <span>Copies / seed documents / strategic notes</span>
          {renderTextarea("copies", "Internal stakeholders, insurance carrier, counsel", 2)}
          {renderTextarea(
            "seedDocs",
            "Paths or notes for contracts, correspondence, invoices, evidence",
            2,
          )}
          {renderTextarea(
            "strategicNotes",
            "Leverage, BATNA, downside tolerance, privilege filters, admissions risk",
            3,
          )}
        </label>
      </div>

      <footer className="legal-intake-card-footer">
        <span className="legal-intake-footer-note">
          Blank fields will be flagged in the intake.
        </span>
        <button
          type="button"
          className="legal-intake-submit"
          disabled={!canSubmit}
          onClick={() => onSubmit(buildLegalDemandIntakeFollowUp(values))}
        >
          Continue task
        </button>
      </footer>
    </section>
  );
}

export function GenericLegalWorkflowPromptCard({
  invocation,
  onSubmit,
  onDismiss,
}: {
  invocation: LegalWorkflowInvocation;
  onSubmit: (message: string) => void;
  onDismiss: () => void;
}) {
  const [values, setValues] = useState<GenericLegalWorkflowFormValues>(() =>
    buildGenericLegalWorkflowInitialValues(invocation),
  );

  useEffect(() => {
    setValues(buildGenericLegalWorkflowInitialValues(invocation));
  }, [invocation]);

  const updateValue = useCallback((field: keyof GenericLegalWorkflowFormValues, value: string) => {
    setValues((prev) => ({ ...prev, [field]: value }));
  }, []);

  const renderTextarea = (
    field: keyof GenericLegalWorkflowFormValues,
    placeholder: string,
    rows = 3,
  ) => (
    <textarea
      className="legal-intake-textarea"
      rows={rows}
      value={String(values[field] || "")}
      placeholder={placeholder}
      onChange={(event) => updateValue(field, event.target.value)}
    />
  );

  const hasAnyContext = Object.values(values).some((value) => value.trim().length > 0);
  const commandLabel = invocation.commandName ? `/${invocation.commandName}` : "Legal workflow";

  return (
    <section className="legal-intake-card" aria-label="Legal workflow details">
      <header className="legal-intake-card-header">
        <div className="legal-intake-card-title">
          <FileText size={18} aria-hidden="true" />
          <span>Legal workflow details</span>
          <span className="legal-intake-command-pill">{commandLabel}</span>
        </div>
        <button
          type="button"
          className="legal-intake-dismiss"
          onClick={onDismiss}
          aria-label="Dismiss legal workflow form"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </header>

      <div className="legal-intake-card-body">
        <label className="legal-intake-field legal-intake-field-full">
          <span>Matter or project title</span>
          <input
            className="legal-intake-input"
            value={values.matterTitle}
            placeholder="e.g. Vendor AI review - Acme Logistics"
            onChange={(event) => updateValue("matterTitle", event.target.value)}
          />
        </label>

        <label className="legal-intake-field">
          <span>Jurisdiction / governing law</span>
          <input
            className="legal-intake-input"
            value={values.jurisdiction}
            placeholder="State, country, regulator, contract law"
            onChange={(event) => updateValue("jurisdiction", event.target.value)}
          />
        </label>

        <label className="legal-intake-field">
          <span>Role / side / perspective</span>
          <input
            className="legal-intake-input"
            value={values.roleOrSide}
            placeholder="Buyer, vendor, employer, plaintiff, professor, in-house"
            onChange={(event) => updateValue("roleOrSide", event.target.value)}
          />
        </label>

        <label className="legal-intake-field legal-intake-field-full">
          <span>Objective</span>
          {renderTextarea("objective", "What should this workflow accomplish?", 3)}
        </label>

        <label className="legal-intake-field legal-intake-field-full">
          <span>Key facts / timeline</span>
          {renderTextarea(
            "keyFacts",
            "Events, dates, business context, disputed points, known unknowns",
            4,
          )}
        </label>

        <label className="legal-intake-field legal-intake-field-full">
          <span>Documents / sources</span>
          {renderTextarea(
            "documents",
            "File paths, uploads, contract names, policies, correspondence, data sources",
            3,
          )}
        </label>

        <label className="legal-intake-field">
          <span>Deadlines / risk triggers</span>
          {renderTextarea(
            "deadlines",
            "Notice periods, filing dates, launch dates, board dates, regulator windows",
            3,
          )}
        </label>

        <label className="legal-intake-field">
          <span>Stakeholders / audience</span>
          {renderTextarea(
            "stakeholders",
            "Decision-maker, reviewer, business owner, client, outside counsel",
            3,
          )}
        </label>

        <label className="legal-intake-field legal-intake-field-full">
          <span>Constraints / assumptions</span>
          {renderTextarea(
            "constraints",
            "Privilege filters, risk tolerance, deal posture, citation requirements, scope limits",
            3,
          )}
        </label>

        <label className="legal-intake-field legal-intake-field-full">
          <span>Output preferences / review notes</span>
          {renderTextarea(
            "outputPreferences",
            "Table, memo, checklist, email draft, redlines, escalation flags, questions to ask",
            3,
          )}
        </label>
      </div>

      <footer className="legal-intake-card-footer">
        <span className="legal-intake-footer-note">
          Blank fields will be flagged before the workflow relies on them.
        </span>
        <button
          type="button"
          className="legal-intake-submit"
          disabled={!hasAnyContext}
          onClick={() => onSubmit(buildGenericLegalWorkflowFollowUp(invocation, values))}
        >
          Continue task
        </button>
      </footer>
    </section>
  );
}
