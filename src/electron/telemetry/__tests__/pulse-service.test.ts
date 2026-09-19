import { describe, expect, it } from "vitest";
import { categorizePulseTool } from "../pulse-service";

describe("CoWork Pulse privacy categorization", () => {
  it("reduces tool names to bounded categories", () => {
    expect(categorizePulseTool("exec_command")).toBe("shell");
    expect(categorizePulseTool("read_file")).toBe("filesystem");
    expect(categorizePulseTool("browser_navigate")).toBe("browser");
    expect(categorizePulseTool("mcp__linear__create_issue")).toBe("connector");
    expect(categorizePulseTool("unknown-private-tool-name")).toBe("other");
  });
});
