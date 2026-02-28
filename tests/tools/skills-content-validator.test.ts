import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "child_process";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const validatorScript = path.resolve(process.cwd(), "scripts/qa/validate-skills-content.mjs");

const tempDirs: string[] = [];

async function makeTempSkillsDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "skills-validator-"));
  tempDirs.push(dir);
  return dir;
}

async function writeSkill(skillsDir: string, name: string, skill: unknown): Promise<void> {
  await mkdir(skillsDir, { recursive: true });
  await writeFile(path.join(skillsDir, `${name}.json`), JSON.stringify(skill, null, 2), "utf8");
}

function baseSkill(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "sample-skill",
    name: "Sample Skill",
    description: "Sample skill for validator testing",
    icon: "⚡",
    prompt: "Run task with {{input}}",
    parameters: [
      {
        name: "input",
        type: "string",
        description: "Input text",
        required: true,
      },
    ],
    metadata: {
      authoring: { complexity: "low" },
      routing: {
        useWhen: "Use for sample in-scope requests.",
        dontUseWhen: "Do not use for unrelated requests.",
        outputs: "Returns a sample execution output.",
        successCriteria: "Produces a clear in-scope output.",
        examples: {
          positive: ["Use sample skill", "Handle sample task", "Run sample workflow"],
          negative: ["Unrelated question", "Casual chat", "Out-of-scope request"],
        },
      },
    },
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    }),
  );
});

describe("validate-skills-content", () => {
  it("fails on invalid select options", async () => {
    const skillsDir = await makeTempSkillsDir();
    await writeSkill(
      skillsDir,
      "bad-select",
      baseSkill({
        parameters: [
          {
            name: "mode",
            type: "select",
            description: "Mode",
            options: [{ value: "a", label: "A" }],
          },
        ],
      }),
    );

    const err = await execFileAsync("node", [validatorScript, "--skills-dir", skillsDir]).catch(
      (error) => error as Error & { stdout?: string; stderr?: string },
    );
    expect(err).toBeTruthy();
    const errorOutput = err as Error & { stdout?: string; stderr?: string };
    const message = `${errorOutput.stdout || ""}\n${errorOutput.stderr || ""}`.toLowerCase();
    expect(message).toContain("invalid select options");
  });

  it("warns on missing routing examples but exits successfully by default", async () => {
    const skillsDir = await makeTempSkillsDir();
    const skill = baseSkill() as {
      metadata: { routing: { examples: { positive: string[]; negative: string[] } } };
    };
    skill.metadata.routing.examples = { positive: ["one"], negative: ["one"] };
    await writeSkill(skillsDir, "warn-examples", skill);

    const output = await execFileAsync("node", [validatorScript, "--skills-dir", skillsDir]);
    expect(output.stdout).toContain("Warnings");
    expect(output.stdout).toContain("examples.positive");
  });

  it("fails in strict warning mode when warnings exist", async () => {
    const skillsDir = await makeTempSkillsDir();
    const skill = baseSkill() as {
      metadata: { routing: { examples: { positive: string[]; negative: string[] } } };
    };
    skill.metadata.routing.examples = { positive: ["one"], negative: ["one"] };
    await writeSkill(skillsDir, "strict-warn", skill);

    await expect(
      execFileAsync("node", [validatorScript, "--skills-dir", skillsDir, "--strict-warnings"]),
    ).rejects.toThrow();
  });
});
