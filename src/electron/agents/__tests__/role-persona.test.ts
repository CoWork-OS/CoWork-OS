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

  it.each(["leaf", "ancestor"])("omits a role profile through a %s symlink", (kind) => {
    const outside = path.join(tmpDir, "outside");
    fs.mkdirSync(outside);
    writeFile(path.join(outside, "SOUL.md"), "PRIVATE_SENTINEL");
    const roleDir = path.join(tmpDir, ".cowork/agents/reviewer");
    fs.mkdirSync(path.dirname(roleDir), { recursive: true });
    if (kind === "ancestor") fs.symlinkSync(outside, roleDir);
    else {
      fs.mkdirSync(roleDir);
      fs.symlinkSync(path.join(outside, "SOUL.md"), path.join(roleDir, "SOUL.md"));
    }
    expect(buildRolePersonaPrompt({ name: "reviewer" }, tmpDir)).not.toContain("PRIVATE_SENTINEL");
  });

  it("applies the task read guard before injecting an ordinary role file", () => {
    writeFile(path.join(tmpDir, ".cowork/agents/reviewer/SOUL.md"), "PROFILE_SENTINEL");
    expect(buildRolePersonaPrompt({ name: "reviewer" }, tmpDir, { readGuard: () => false })).toBe(
      "",
    );
    expect(
      buildRolePersonaPrompt({ name: "reviewer" }, tmpDir, { readGuard: () => true }),
    ).toContain("PROFILE_SENTINEL");
    expect(buildRolePersonaPrompt({ name: ".." }, tmpDir)).toBe("");
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
    expect(prompt).toContain("Current Operating Mode");
    expect(prompt).toContain(".cowork/agents/qa-analyst/VIBES.md");
    expect(prompt).toContain("Mode: crunch");
  });

  it("includes role-specific MEMORY.md between SOUL.md and VIBES.md", () => {
    writeFile(
      path.join(tmpDir, ".cowork", "agents", "qa-analyst", "SOUL.md"),
      "# Soul\n\nBe thorough and precise",
    );
    writeFile(
      path.join(tmpDir, ".cowork", "agents", "qa-analyst", "MEMORY.md"),
      "# Memory\n\n- Regression test style: use focused fixtures",
    );
    writeFile(
      path.join(tmpDir, ".cowork", "agents", "qa-analyst", "VIBES.md"),
      "# Vibes\n\n- Mode: deep-focus",
    );

    const prompt = buildRolePersonaPrompt(
      {
        name: "qa-analyst",
      },
      tmpDir,
    );

    const soulIdx = prompt.indexOf("Workspace Persona");
    const memoryIdx = prompt.indexOf("Long-Term Memory");
    const vibesIdx = prompt.indexOf("Current Operating Mode");
    expect(memoryIdx).toBeGreaterThan(soulIdx);
    expect(memoryIdx).toBeLessThan(vibesIdx);
    expect(prompt).toContain("Regression test style");
  });

  it("loads SOUL.md before VIBES.md in role profile output", () => {
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

    const soulIdx = prompt.indexOf("Workspace Persona");
    const vibesIdx = prompt.indexOf("Current Operating Mode");
    expect(soulIdx).toBeGreaterThan(-1);
    expect(vibesIdx).toBeGreaterThan(-1);
    expect(soulIdx).toBeLessThan(vibesIdx);
  });
});
