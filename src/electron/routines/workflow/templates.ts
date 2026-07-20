import type {
  RoutineWorkflowDefinition,
  RoutineWorkflowEdge,
  RoutineWorkflowNode,
  RoutineWorkflowTemplate,
} from "../../../shared/routine-workflow";
import { ROUTINE_WORKFLOW_VERSION } from "../../../shared/routine-workflow";

function node(
  id: string,
  kind: RoutineWorkflowNode["kind"],
  operation: string,
  name: string,
  config: RoutineWorkflowNode["config"] = {},
  column = 0,
): RoutineWorkflowNode {
  return {
    id,
    kind,
    operation,
    name,
    config,
    position: { x: column * 312, y: 80 },
  };
}

function edge(
  sourceNodeId: string,
  targetNodeId: string,
  sourcePort = "success",
): RoutineWorkflowEdge {
  return {
    id: `${sourceNodeId}:${sourcePort}:${targetNodeId}`,
    sourceNodeId,
    targetNodeId,
    sourcePort,
  };
}

function workflow(
  nodes: RoutineWorkflowNode[],
  edges: RoutineWorkflowEdge[],
): RoutineWorkflowDefinition {
  return {
    version: ROUTINE_WORKFLOW_VERSION,
    starterNodeId: nodes[0].id,
    nodes,
    edges,
    settings: {
      maxRunDurationMs: 30 * 60 * 1_000,
      maxStepCount: 100,
      maxForEachItems: 100,
      maxParallelSteps: 4,
      retainStepDataDays: 30,
    },
  };
}

export const ROUTINE_WORKFLOW_TEMPLATES: RoutineWorkflowTemplate[] = [
  {
    id: "daily-unread-email-recap",
    name: "Daily unread email recap",
    description: "Summarize unread Gmail messages and send the recap to Chat.",
    category: "Email boosters",
    promptHints: [
      "daily email summary",
      "unread email recap",
      "summarize inbox",
      "catch up on email",
    ],
    workflow: workflow(
      [
        node("starter", "starter", "starter.schedule", "Every weekday", {
          scheduleKind: "cron",
          expression: "0 9 * * 1-5",
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        }),
        node(
          "recap",
          "ai",
          "ai.recap_unread_emails",
          "Recap unread emails",
          { input: "is:unread" },
          1,
        ),
        node(
          "notify",
          "action",
          "chat.notify",
          "Send recap to Chat",
          {
            spaceName: "",
            text: { $ref: "recap.text" },
          },
          2,
        ),
      ],
      [edge("starter", "recap"), edge("recap", "notify")],
    ),
  },
  {
    id: "save-email-attachments",
    name: "Save email attachments to Drive",
    description: "Store attachments from matching Gmail messages in a Drive folder.",
    category: "Email boosters",
    promptHints: ["save attachments", "email attachments to drive", "archive invoice attachments"],
    workflow: workflow(
      [
        node("starter", "starter", "starter.gmail_message", "Email with attachment", {
          query: "has:attachment",
          includeFlowGenerated: false,
        }),
        node(
          "save",
          "action",
          "drive.save_attachments",
          "Save attachments",
          {
            messageId: { $ref: "trigger.messageId" },
            folderId: "",
          },
          1,
        ),
      ],
      [edge("starter", "save")],
    ),
  },
  {
    id: "meeting-prebrief",
    name: "Meeting pre-brief",
    description: "Prepare a concise brief before a calendar meeting.",
    category: "Better meetings",
    promptHints: ["meeting prebrief", "prepare before meetings", "calendar briefing"],
    workflow: workflow(
      [
        node("starter", "starter", "starter.meeting_relative", "Fifteen minutes before", {
          direction: "before",
          offsetMinutes: "15",
          calendarId: "primary",
        }),
        node(
          "brief",
          "ai",
          "ai.ask_gemini",
          "Prepare the brief",
          {
            prompt: {
              $template:
                "Prepare a concise meeting brief for {{trigger.summary}} using {{trigger.description}} and the attendee list {{trigger.attendees}}.",
            },
            outputType: "text",
          },
          1,
        ),
        node(
          "notify",
          "action",
          "gmail.notify",
          "Email the brief",
          {
            to: { $ref: "trigger.organizer.email" },
            subject: { $template: "Brief: {{trigger.summary}}" },
            body: { $ref: "brief.text" },
          },
          2,
        ),
      ],
      [edge("starter", "brief"), edge("brief", "notify")],
    ),
  },
  {
    id: "meeting-follow-up",
    name: "Meeting follow-up and action items",
    description: "Summarize meeting outputs, create a document, and create a task.",
    category: "Better meetings",
    promptHints: ["meeting follow up", "meeting action items", "transcript summary"],
    workflow: workflow(
      [
        node("starter", "starter", "starter.meeting_outputs_ready", "Meeting notes ready", {
          outputType: "either",
        }),
        node(
          "summary",
          "ai",
          "ai.extract",
          "Extract summary and actions",
          {
            input: { $ref: "trigger.content" },
            schema: "summary:string, actionItems:list",
          },
          1,
        ),
        node(
          "doc",
          "action",
          "docs.create",
          "Create follow-up document",
          {
            title: { $template: "Follow-up: {{trigger.meetingTitle}}" },
            content: { $ref: "summary.text" },
          },
          2,
        ),
        node(
          "task",
          "action",
          "tasks.create",
          "Create follow-up task",
          {
            tasklist: "@default",
            title: { $template: "Review actions from {{trigger.meetingTitle}}" },
            notes: { $ref: "summary.text" },
          },
          3,
        ),
      ],
      [edge("starter", "summary"), edge("summary", "doc"), edge("doc", "task")],
    ),
  },
  {
    id: "email-to-task",
    name: "Create tasks from email",
    description: "Decide whether an email contains an action and create a task when it does.",
    category: "Tasks and action items",
    promptHints: ["email to task", "create tasks from emails", "action item emails"],
    workflow: workflow(
      [
        node("starter", "starter", "starter.gmail_message", "New email", { query: "-from:me" }),
        node(
          "decision",
          "condition",
          "control.condition",
          "Contains an action",
          {
            left: { $ref: "trigger.body" },
            operator: "is_not_empty",
            right: "",
          },
          1,
        ),
        node(
          "task",
          "action",
          "tasks.create",
          "Create task",
          {
            tasklist: "@default",
            title: { $ref: "trigger.subject" },
            notes: { $ref: "trigger.body" },
          },
          2,
        ),
      ],
      [edge("starter", "decision"), edge("decision", "task", "true")],
    ),
  },
  {
    id: "sheet-change-chat-alert",
    name: "Notify Chat when a sheet changes",
    description: "Send a structured Chat notification for changes in a selected range.",
    category: "Tasks and action items",
    promptHints: ["sheet change notification", "spreadsheet alert", "notify chat from sheets"],
    workflow: workflow(
      [
        node("starter", "starter", "starter.sheet_changed", "Sheet changed", {
          spreadsheetId: "",
          range: "Sheet1!A:Z",
        }),
        node(
          "notify",
          "action",
          "chat.notify",
          "Notify Chat",
          {
            spaceName: "",
            text: {
              $template:
                "{{trigger.actor}} changed {{trigger.range}} in {{trigger.spreadsheetName}}.",
            },
          },
          1,
        ),
      ],
      [edge("starter", "notify")],
    ),
  },
  {
    id: "drive-file-added-notification",
    name: "Notify when a file is added",
    description: "Notify Chat when a new item appears in a Drive folder.",
    category: "Customer connections",
    promptHints: ["file added notification", "drive folder alert", "new drive file"],
    workflow: workflow(
      [
        node("starter", "starter", "starter.drive_item_added", "Item added to folder", {
          folderId: "",
        }),
        node(
          "notify",
          "action",
          "chat.notify",
          "Notify Chat",
          {
            spaceName: "",
            text: { $template: "New Drive item: {{trigger.name}} — {{trigger.webViewLink}}" },
          },
          1,
        ),
      ],
      [edge("starter", "notify")],
    ),
  },
  {
    id: "draft-reply-from-document",
    name: "Draft replies using a reference document",
    description: "Use a Drive document as context and create a Gmail draft reply.",
    category: "Customer connections",
    promptHints: [
      "draft reply from document",
      "reply using drive doc",
      "reference document email reply",
    ],
    workflow: workflow(
      [
        node("starter", "starter", "starter.gmail_message", "Matching email", {
          query: "-from:me",
        }),
        node(
          "draft",
          "ai",
          "ai.ask_gemini",
          "Draft a grounded reply",
          {
            prompt: {
              $template:
                "Draft a reply to this email: {{trigger.body}}. Use the configured Drive document as the source of truth.",
            },
            outputType: "text",
            sourceFileId: "",
          },
          1,
        ),
        node(
          "reply",
          "action",
          "gmail.draft_reply",
          "Create Gmail draft reply",
          {
            messageId: { $ref: "trigger.messageId" },
            body: { $ref: "draft.text" },
          },
          2,
        ),
      ],
      [edge("starter", "draft"), edge("draft", "reply")],
    ),
  },
];

export function cloneWorkflowTemplate(templateId: string): RoutineWorkflowDefinition | null {
  const template = ROUTINE_WORKFLOW_TEMPLATES.find((candidate) => candidate.id === templateId);
  return template ? structuredClone(template.workflow) : null;
}
