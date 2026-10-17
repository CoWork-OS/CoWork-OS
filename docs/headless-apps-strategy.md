# CoWork OS: one interface for work across applications

Revised strategy · 13 October 2026 · Proposed direction and implementation sequence; not a claim that the backend extensions are implemented.

**CoWork is the everything app because it can carry a user's request through the applications needed to achieve the result.** CAD, SAP, legal systems, Word, Excel, Salesforce, creative software, and other applications are all targets of the same architecture. The backend must accommodate their different resources, operations, and outcomes.

The core experience is:

> Request → understand and plan → prepare where useful → ask for feedback when needed → execute → verify → return the result.

The user normally sees the result and any meaningful decision along the way. They do not need to watch application windows, clicks, tools, or intermediate steps. Inspection, live viewing, and takeover remain available when useful.

This replaces the earlier creative-workflow-first proposal. The development order is **research and architecture → shared backend and harness → a small set of contrasting application pilots → refine the contracts and expand**. The technical proposal and source comparison are in [Application Execution Architecture](application-execution-architecture.md).

**The product direction**

CoWork owns the interaction, understanding of the request, continuity, decisions, execution coordination, and proof of completion. Applications supply capabilities and retain their native documents, records, and business rules. A user can ask for work spanning multiple systems without managing the handoffs themselves.

| Request | Possible preparation or decision | Result the user receives |
| --- | --- | --- |
| Adjust a CAD model and produce the required output | Check constraints; show a quick preview before an expensive render if useful | Updated native model, checked dimensions, and requested output |
| Analyze a workbook and correct a calculation | Inspect formulas and dependencies; ask about consequential ambiguity | Updated workbook and verified calculation summary |
| Update a Salesforce workflow | Resolve exact records and account; prepare a change summary when warranted | Record links and verified changes, including incomplete steps |
| Reconcile an ERP discrepancy | Compare source records and propose adjustments | Reconciliation report or confirmed changes within the requested authority |
| Research a legal question and prepare a document | Resolve material scope ambiguity and gather attributable sources | Sourced analysis and, when requested, an editable document |

These are design scenarios, not current integration claims. Domain correctness remains application-specific: a generic harness cannot replace CAD constraint checks, spreadsheet calculation, ERP business validation, or legal source verification.

**Applications in the background**

The defining property is that users can delegate work without operating each application's interface. The execution route may use MCP, a vendor API, application scripting, a CLI, browser automation, or computer use. CoWork may use more than one route during a task.

Keep five dimensions separate: the capability being used, the communication protocol, the control mechanism, the execution environment, and what the user sees. MCP can expose a desktop controller. A browser can run without a visible window. A native application can support background operations while requiring a desktop for others. Route selection must reflect actual capability and constraints, not a fixed ranking of protocol names.

**Feedback should help a decision**

Planning and preparation happen as part of execution. Showing a plan or requesting approval is not mandatory for every task.

Proceed directly when intent is clear and the work fits existing authorization, preferences, and budget. Ask when an unresolved choice materially affects the outcome, an expensive or lengthy commitment deserves review, the user requested a draft first, or a material change exceeds an earlier decision. Reuse relevant decisions instead of asking repeatedly.

Feedback and permission serve different purposes. Accepting a CAD preview chooses a direction; it does not automatically authorize transferring source files to a new service. Conversely, application access does not settle an ambiguous business choice. Preserve permission enforcement independently.

Present a concrete draft, diff, preview, or estimate when supported. If an application cannot preview an action faithfully, use a proposed change summary and state its limits. Do not present an unexecuted plan as a simulated result.

**Lessons from other harnesses**

Codex exposes a reusable agent loop through app-server, SDK, and noninteractive execution. Its host application can own product context and controls. That supports evaluating Codex as an execution option below CoWork's product layer. [OpenAI's architecture discussion](https://developers.openai.com/blog/codex-as-a-platform)

Claude's Agent SDK exposes the loop and context management used by Claude Code, with tools, sessions, permissions, hooks, and subagents. It is another runtime candidate, subject to integration, policy, and access qualification. [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)

Both show how to separate the agent loop from the product interface. CoWork still needs to know which business resource changed, whether a remote action completed, and how to recover a partially completed cross-application task. Those are common backend responsibilities.

**Architecture recommendation**

Extend CoWork's existing WorkSession, outcome contracts, tool coordinator, permissions, scheduler, waits, and evidence machinery. Keep a provider-neutral layer for application work, with interchangeable agent runtimes and operation implementations underneath.

The backend needs consistent representations of the requested outcome, application resources and versions, qualified capabilities, revisable plans, optional decisions, durable operation attempts, and verified results.

A result may be a file, changed record, calculation, rendered output, sourced analysis, or confirmed application state. Preserve these distinctions.

Adopt the ownership boundaries now. Keep final SDK selection, GUI hosting, storage details, and route scoring provisional until an implementation comparison and conformance suite provide evidence. Preserve the free/open-source core, user-selected models, and local/private execution options.

**Development sequence**

| Stage | Work | Required evidence |
| --- | --- | --- |
| 1. Architecture and contracts | Compare existing solutions and map reusable CoWork components | No app-category assumptions in core; explicit retry, permission, and completion ownership |
| 2. Backend foundation | Extend native execution with durable attempts, decisions, reconciliation, verification, and result projection | Controlled file, remote-record, long-job, and UI fixtures survive interruption and partial success |
| 3. Runtime and environment qualification | Compare native execution with Codex and Claude drivers; qualify browser/desktop isolation | Access, enforcement, continuity, latency, and cost measured; unavailable candidates remain unverified |
| 4. Two application pilots | Select contrasting applications after the foundation works; candidates are CAD and Salesforce in a dedicated sandbox | Real outcomes and recovery verified without requiring the user to watch execution |
| 5. Refine and expand | Fix shared gaps; add office, ERP, legal, and other workloads | New apps reuse the lifecycle instead of introducing another orchestration system |

Keep the foundation small enough to test early. Do not build a universal application object model, reproduce every app UI, or complete a large connector catalog before the pilots. Test browser and desktop mechanisms in controlled fixtures even if the first apps expose good APIs.

**How we judge progress**

Measure verified outcomes, human effort, unnecessary interruptions, recovery correctness, completion latency, cost, and repeat use. Track partial and unknown outcomes explicitly. Tool success, job acceptance, and hidden windows are insufficient proof that work is complete.

The strongest architecture test is whether the second contrasting application mostly requires an adapter and domain verifiers. Repeated changes to the central lifecycle indicate a missing abstraction.

For every future capability, ask: **Can CoWork understand the request, perform the work through an eligible interface, involve the user only at meaningful decisions, verify the outcome, and return the result without requiring the user to operate the application?**
