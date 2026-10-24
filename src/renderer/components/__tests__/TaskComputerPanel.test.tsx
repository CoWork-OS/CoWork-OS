import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Task } from "../../../shared/types";
import { TaskComputerPanel } from "../TaskComputerPanel";

vi.mock("../../hooks/useComputerView", () => ({
  useComputerView: () => ({ state: null, busy: false, error: null }),
}));

describe("TaskComputerPanel", () => {
  it("shows the selected Cua identity and lifetime before a binding is allocated", () => {
    const task: Task = {
      id: "task-computer-preview",
      title: "Synthetic computer preview",
      prompt: "Inspect the computer label",
      status: "paused",
      workspaceId: "synthetic-workspace",
      createdAt: 1,
      updatedAt: 1,
      agentConfig: {
        executionEnvironment: {
          backend: "cua",
          lifetime: "persistent",
          inputPaths: [],
          outputPaths: [],
        },
      },
    };
    const html = renderToStaticMarkup(<TaskComputerPanel task={task} />);
    expect(html).toContain("Cua Space");
    expect(html).toContain("Kept for this bot");
    expect(html).toContain("Not started");
    expect(html).not.toContain("Dedicated Linux computer");
  });
});
