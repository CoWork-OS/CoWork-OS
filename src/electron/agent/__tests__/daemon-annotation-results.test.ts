import { describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../daemon";

function daemonWith(fields: Record<string, unknown>) {
  const daemon = Object.create(AgentDaemon.prototype) as Any;
  Object.assign(daemon, fields);
  return daemon;
}

describe("daemon: point at the result", () => {
  it("settles annotations when a turn or task completes, and only then", () => {
    const settle = vi.fn(async () => 0);
    const daemon = daemonWith({ getAnnotationResults: () => ({ settle }) });
    for (const type of ["follow_up_completed", "task_completed", "tool_call"]) {
      try {
        daemon.logEvent("task-1", type, {});
      } catch {
        // The rest of event logging needs a full daemon; settling is decided first.
      }
    }
    expect(settle.mock.calls).toEqual([["task-1"], ["task-1"]]);
  });

  it("gives the agent the anchor, intent and values of each pending annotation", async () => {
    const daemon = daemonWith({
      annotationRepo: {
        listOpenByTask: async () => [
          {
            id: "ann-1",
            surfaceType: "artifact",
            status: "open",
            body: "Use net figures",
            targetRef: {
              surfaceType: "artifact",
              filePath: "/ws/report.xlsx",
              sheetName: "Q3",
              cellRange: "B2:B3",
            },
            intent: "change",
            before: { B2: "1000", B3: "1100" },
          },
        ],
      },
    });
    const { message } = await daemon.buildAnnotationFollowUpContext("task-1", "Go ahead");
    expect(message).toContain("Target: file=/ws/report.xlsx; sheet=Q3; cells=B2:B3");
    expect(message).toContain("Intent: change");
    expect(message).toContain('Values now: {"B2":"1000","B3":"1100"}');
    expect(message).toContain("## User Follow-up\nGo ahead");
  });

  it("records a pointed edit as an annotation being addressed, pinned to the source", async () => {
    const created = { id: "ann-9", surfaceType: "artifact", body: "Fix the date", targetRef: {} };
    const annotationRepo = {
      create: vi.fn(async () => created),
      markAddressing: vi.fn(async () => 1),
    };
    const pinTarget = vi.fn(async () => ({ ...created, artifactRevisionId: "rev-1" }));
    const logEvent = vi.fn();
    const daemon = daemonWith({
      annotationRepo,
      logEvent,
      getAnnotationResults: () => ({ pinTarget }),
    });

    const result = await daemon.recordPointedEdit({
      taskId: "task-2",
      surfaceType: "artifact",
      body: "Fix the date",
      targetRef: { surfaceType: "artifact", filePath: "/ws/brief.pdf", page: 1 },
      intent: "change",
      outputPath: "/ws/brief-v2.pdf",
    });

    expect(annotationRepo.markAddressing).toHaveBeenCalledWith("task-2", ["ann-9"]);
    expect(pinTarget).toHaveBeenCalledWith("ann-9");
    expect(logEvent).toHaveBeenCalledWith("task-2", "annotation_created", expect.any(Object));
    expect(result).toMatchObject({ artifactRevisionId: "rev-1" });
  });
});
