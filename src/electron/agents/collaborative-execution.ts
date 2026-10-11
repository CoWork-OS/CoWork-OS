import type { Task } from "../../shared/types";

/** Do-mode teams execute scoped work; Ask/Think teams retain independent analysis. */
export function isCollaborativeExecutionTask(task: Task): boolean {
  return ["execute", "verified", "debug"].includes(task.agentConfig?.executionMode || "");
}

/** Ordered work shared by desktop and programmatic collaborative launch paths. */
export function collaborativeExecutionLanes(leaderId: string, reviewerId: string) {
  return [
    {
      title: "Build the requested deliverable",
      ownerAgentRoleId: leaderId,
      description:
        "Implement the original request within its authorized scope. Create the actual requested files, verify them with available tools, and provide their paths and verification evidence. An independent reviewer runs afterward; do not substitute analysis for implementation.",
    },
    {
      title: "Review the completed deliverable",
      ownerAgentRoleId: reviewerId,
      description:
        "Independently inspect the builder's actual files and evidence for completeness, persistence, date handling, accessibility, and the original requirements. Stay read-only. If files are absent, report the blocker rather than assuming earlier work exists. Start with VERDICT: PASS, FAIL, or PARTIAL.",
    },
    {
      title: "Integrate review findings",
      ownerAgentRoleId: leaderId,
      description:
        "Read the independent review and actual files. You are authorized to edit the deliverable files: the reviewer's read-only status applied only to the review. Repair actionable findings within the original scope, validate the result, and give a final handoff with every requested deliverable and any remaining limitation. Do not claim fixes from plans or summaries alone.",
    },
  ];
}
