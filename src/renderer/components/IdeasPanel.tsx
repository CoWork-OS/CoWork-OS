
/** Use case ideas — only capabilities we support (see docs/ideas-capabilities.md).
 *  Uses: channels, inbox fallbacks, /inbox /brief, /simplify /batch, browser, file I/O, optional integrations. */
const IDEAS_USE_CASES: Array<{
  title: string;
  prompt: string;
  tag?: string;
  integrations?: string[];
}> = [
  { title: "Full inbox autopilot", prompt: "Run inbox triage for the last 24h. Prefer gmail_action; if unavailable use email_imap_unread or Email channel history. Classify each message as urgent, today, this-week, or no-action. Output: (1) Priority table, (2) Draft replies for urgent/today items, (3) Cleanup candidates (newsletter/promotions) with unsubscribe/archive suggestions, (4) Follow-up reminders to create. STOP before sending, unsubscribing, archiving, deleting, or labeling anything. Ask me what to execute.", tag: "Inbox", integrations: ["gmail"] },
  { title: "Draft reply with channel history", prompt: "Use channel_list_chats for channel 'slack' (since '24h', limit 20). Ask me to pick the chat_id for the thread/channel I care about. Then pull channel_history (limit 80) and draft a crisp reply (2 variants). STOP before sending and ask me to confirm.", tag: "Messaging", integrations: ["slack"] },
  { title: "Transaction scan and fraud triage", prompt: "Use channel_list_chats for channel 'email' (since '14d', limit 20). Ask me to pick the chat_id for my card/bank notifications. Pull channel_history (limit 200) and extract transactions (date, merchant, amount, currency). Flag anything suspicious (new merchant, rapid repeats, unusually large amounts) and recommend next steps. Do not contact anyone unless I confirm.", tag: "Finance", integrations: ["gmail"] },
  { title: "Newsletter digest with follow-ups", prompt: "Use channel_list_chats for channel 'slack' (since '24h', limit 20). Ask me to pick the chat_id where newsletters arrive. Pull channel_history (limit 150) and produce a digest: title/link + 1–2 sentence summary each. Propose follow-ups but do not take external actions unless I confirm.", tag: "Reading", integrations: ["slack"] },
  { title: "Chief-of-staff morning brief", prompt: "Create my morning chief-of-staff brief. Include: (1) Executive summary (3–6 bullets), (2) Calendar risks/prep (if calendar available), (3) Inbox priorities, (4) Reminders/tasks due soon, (5) Recommended next actions in urgency order. If any signal source is unavailable, add a Missing Data section. Format for mobile reading.", tag: "Daily ops" },
  { title: "Restaurant booking with calendar cross-check", prompt: "Open the restaurant URL I provide and verify the venue name. Find openings for 2 people in the next 14 days between 6:30pm and 8:30pm. Cross-check my calendar for conflicts if available. Propose the 3 best conflict-free options. Persist the compiled options to reservation_options.json. STOP before final booking and ask me to confirm.", tag: "Booking", integrations: ["calendar"] },
  { title: "Batch migration across codebase", prompt: "Run /batch to update docs and code references: I will specify the old term to replace and the new term. Keep behavior unchanged. Group edits by domain. Produce a per-file checklist and diff summary. Use --parallel 4 and --external confirm for any external calls. STOP before applying and show me the plan.", tag: "Dev" },
  { title: "Simplify or batch content", prompt: "Run /simplify on this content for readability and concision while preserving intent. Or run /batch to migrate/transform in parallel. Group edits by domain and produce a checklist. Use --external confirm for any external calls.", tag: "Writing" },
  { title: "Family digest draft", prompt: "Create a daily digest for 'tomorrow' with: calendar events (times + titles) if available, reminders, and scheduled tasks. Draft it as a short message I can send to my family. STOP before sending and ask me to confirm the final message and where to send it.", tag: "Visibility" },
  { title: "Figure it out (multi-attempt orchestration)", prompt: "Objective: book a table for 2 next week between 7pm and 8:30pm, avoid calendar conflicts. Try the direct path first. If it fails, switch methods/tools and keep an attempt log: attempt number, method/tool used, observed result, failure/success reason. Use up to 3 fallback attempts. Never claim success without evidence. STOP before irreversible external actions and ask for confirmation.", tag: "General" },
  { title: "Household tasks to Notion + Reminders", prompt: "Turn my list into tasks in my Notion database (ask me for database_id if needed). For each task, create one Notion page (title = task). If a due date is implied, ask me to confirm. If Apple Reminders is available, also create reminders for any due tasks. Return the created Notion page IDs/URLs and reminder IDs.", tag: "Home", integrations: ["notion"] },
  { title: "Dev task queue from issues", prompt: "Build a dev task queue from open high-priority issues for a repo I specify. For each item include acceptance criteria, dependencies, risk, and suggested owner (agent or human). Run up to 8 tasks in parallel and provide progress checkpoints. For any code changes, summarize diffs and STOP before merge/deploy unless I approve.", tag: "Dev" },
  { title: "Smart home dry-run plan", prompt: "Act as a smart-home orchestrator for my request (e.g. 'Set evening mode at home'). First discover available smart-home integrations/tools. Then produce a dry-run action plan: device + action + expected effect + rollback. Respect quiet hours 22:00–07:00. STOP and ask me to confirm before any physical state change. If integrations are missing, give me a setup checklist and fallback manual steps.", tag: "Home" },
];

interface IdeasPanelProps {
  onCreateTaskFromPrompt: (prompt: string) => void;
}

export function IdeasPanel({ onCreateTaskFromPrompt }: IdeasPanelProps) {
  return (
    <div className="devices-panel">
      <div className="dp-header">
        <h1 className="dp-title">Ideas</h1>
      </div>

      <div className="dp-section">
        <div className="dp-section-header">
          <span className="dp-section-label">Use case prompts</span>
        </div>
        <div className="dp-ideas-grid">
          {IDEAS_USE_CASES.map((idea, idx) => (
            <button
              key={idx}
              type="button"
              className="dp-task-card dp-idea-card"
              onClick={() => onCreateTaskFromPrompt(idea.prompt)}
              title={idea.title}
            >
              <span className="dp-task-title dp-idea-title">{idea.title}</span>
              {(idea.tag || (idea.integrations && idea.integrations.length > 0)) && (
                <div className="dp-task-meta dp-idea-meta">
                  {idea.integrations && idea.integrations.length > 0 && (
                    <span className="dp-idea-icons" aria-hidden="true">
                      {idea.integrations.slice(0, 3).map((int) => (
                        <span key={int} className="dp-idea-icon" data-integration={int}>
                          {int === "slack" ? "S" : int === "gmail" ? "G" : int === "notion" ? "N" : int === "calendar" ? "C" : "•"}
                        </span>
                      ))}
                    </span>
                  )}
                  {idea.tag && (
                    <span className="dp-purpose-chip subtle">{idea.tag}</span>
                  )}
                </div>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
