import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentRoleData } from "../../../electron/preload";
import { agentRoleUpdate } from "../AgentRoleEditorDialog";

const source = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("Agent settings dialog", () => {
  it("saves seniority and the other settings, but never the access limit", () => {
    const role = {
      id: "role-1",
      name: "ops",
      displayName: "Ops bot",
      description: "Keeps releases tidy",
      icon: "assist",
      color: "#2f7d6d",
      capabilities: ["code"],
      autonomyLevel: "lead",
      accessProfileId: "read-only",
      isSystem: false,
      isActive: true,
      sortOrder: 3,
      createdAt: 1,
      updatedAt: 2,
    } as unknown as AgentRoleData;
    const update = agentRoleUpdate(role);
    expect(update).toMatchObject({ id: "role-1", autonomyLevel: "lead", displayName: "Ops bot" });
    expect(update).not.toHaveProperty("accessProfileId");
  });

  it("can be opened from Team and from the Bots page", () => {
    expect(source("../team/TeamView.tsx")).toContain("Edit agent");
    expect(source("../team/TeamView.tsx")).toContain("<AgentRoleEditorDialog");
    expect(source("../BotProfileDialog.tsx")).toContain("<AgentRoleEditorDialog");
    expect(source("../BotFormDialog.tsx")).toContain("More settings");
  });

  it("calls the setting Seniority and doesn't describe it as a permission", () => {
    const editor = source("../AgentRoleEditor.tsx");
    expect(editor).toContain("<label>Seniority</label>");
    expect(editor).not.toContain("Autonomy Level");
    expect(editor).not.toContain("Requires approval for most actions");
    expect(editor).toContain("Seniority isn't a permission.");
  });
});
