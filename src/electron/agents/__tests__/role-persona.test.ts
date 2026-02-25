import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import { buildRolePersonaPrompt } from "../role-persona";

function writeFile(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf-8");
}

describe("role-persona", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-role-persona-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("prefers role profile files over db soul", () => {
    writeFile(
      path.join(tmpDir, ".cowork", "agents", "qa-analyst", "SOUL.md"),
      "# Role Soul\n\nTone: direct and concise",
    );

    const prompt = buildRolePersonaPrompt(
      {
        id: "agent-role-id",
        name: "qa-analyst",
        displayName: "QA Analyst",
        soul: JSON.stringify({ communicationStyle: "friendly" }),
      },
      tmpDir,
    );

    expect(prompt).toContain("ROLE PROFILE");
    expect(prompt).toContain(".cowork/agents/qa-analyst/SOUL.md");
    expect(prompt).toContain("Tone: direct and concise");
    expect(prompt).not.toContain("ROLE NOTES");
  });

  it("falls back to db soul when no role file exists", () => {
    const prompt = buildRolePersonaPrompt(
      {
        name: "qa-analyst",
        soul: JSON.stringify({ communicationStyle: "concise", focusAreas: ["tests", "risk"] }),
      },
      tmpDir,
    );

    expect(prompt).toContain("ROLE NOTES");
    expect(prompt).toContain("Communication style: concise");
    expect(prompt).toContain("Focus areas: tests, risk");
  });

  it("supports default fallback profile folder when name is unavailable", () => {
    writeFile(
      path.join(tmpDir, ".cowork", "agents", "default", "IDENTITY.md"),
      "# Identity\n\n- Role: Test role",
    );

    const prompt = buildRolePersonaPrompt(
      {
        displayName: "QA Analyst",
      },
      tmpDir,
    );

    expect(prompt).toContain("ROLE PROFILE");
    expect(prompt).toContain(".cowork/agents/default/IDENTITY.md");
  });

  it("merges role profile sections across fallback folders", () => {
    writeFile(
      path.join(tmpDir, ".cowork", "agents", "qa-analyst", "SOUL.md"),
      "# Role Persona\n\nTone: direct",
    );
    writeFile(
      path.join(tmpDir, ".cowork", "agents", "default", "RULES.md"),
      "# Rules\n\n- Must be concise",
    );

    const prompt = buildRolePersonaPrompt(
      {
        name: "QA Analyst",
      },
      tmpDir,
    );

    expect(prompt).toContain("ROLE PROFILE");
    expect(prompt).toContain(".cowork/agents/qa-analyst/SOUL.md");
    expect(prompt).toContain(".cowork/agents/default/RULES.md");
    expect(prompt).toContain("Tone: direct");
    expect(prompt).toContain("Must be concise");
  });

  it("supports preserve-style folder names for role lookup", () => {
    writeFile(
      path.join(tmpDir, ".cowork", "agents", "qa_analyst", "IDENTITY.md"),
      "# Identity\n\n- Role: QA analyst",
    );

    const prompt = buildRolePersonaPrompt(
      {
        name: "QA_Analyst",
      },
      tmpDir,
    );

    expect(prompt).toContain(".cowork/agents/qa_analyst/IDENTITY.md");
  });

  it("normalizes unicode role names for folder matching", () => {
    writeFile(
      path.join(tmpDir, ".cowork", "agents", "cafe-analyst", "IDENTITY.md"),
      "# Identity\n\n- Name: Café Analyst",
    );

    const prompt = buildRolePersonaPrompt(
      {
        displayName: "Café Analyst",
      },
      tmpDir,
    );

    expect(prompt).toContain(".cowork/agents/cafe-analyst/IDENTITY.md");
  });

  it("returns empty string when both inputs are missing", () => {
    const prompt = buildRolePersonaPrompt({}, tmpDir);
    expect(prompt).toBe("");
  });

  it("includes VIBES.md as a role profile file", () => {
    writeFile(
      path.join(tmpDir, ".cowork", "agents", "qa-analyst", "VIBES.md"),
      "# Vibes\n\n- Mode: crunch\n- Energy: high\n- Notes: Deadline approaching",
    );

    const prompt = buildRolePersonaPrompt(
      {
        name: "qa-analyst",
      },
      tmpDir,
    );

    expect(prompt).toContain("ROLE PROFILE");
    expect(prompt).toContain("Role Vibes");
    expect(prompt).toContain(".cowork/agents/qa-analyst/VIBES.md");
    expect(prompt).toContain("Mode: crunch");
  });

  it("loads VIBES.md before SOUL.md in role profile output", () => {
    writeFile(
      path.join(tmpDir, ".cowork", "agents", "qa-analyst", "VIBES.md"),
      "# Vibes\n\n- Mode: deep-focus",
    );
    writeFile(
      path.join(tmpDir, ".cowork", "agents", "qa-analyst", "SOUL.md"),
      "# Soul\n\nBe thorough and precise",
    );

    const prompt = buildRolePersonaPrompt(
      {
        name: "qa-analyst",
      },
      tmpDir,
    );

    const vibesIdx = prompt.indexOf("Role Vibes");
    const soulIdx = prompt.indexOf("Role Persona");
    expect(vibesIdx).toBeGreaterThan(-1);
    expect(soulIdx).toBeGreaterThan(-1);
    expect(vibesIdx).toBeLessThan(soulIdx);
  });
});
