import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

function makeTempVault(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-llm-wiki-"));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function runReport(vaultPath: string): Any {
  const scriptPath = path.join(
    process.cwd(),
    "resources/skills/llm-wiki/scripts/wiki-graph-report.mjs",
  );
  const output = execFileSync("node", [scriptPath, "--vault", vaultPath, "--format", "json"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  return JSON.parse(output);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("llm-wiki graph report", () => {
  it("flags ambiguous basename links instead of misattributing them", () => {
    const vault = makeTempVault();
    writeFile(
      path.join(vault, "entities/grpo.md"),
      `---
title: GRPO Entity
created: 2026-04-07
updated: 2026-04-07
type: entity
tags: [rl]
sources: [raw/articles/a.md]
---
[[queries/test]] [[concepts/grpo]]
`,
    );
    writeFile(
      path.join(vault, "concepts/grpo.md"),
      `---
title: GRPO Concept
created: 2026-04-07
updated: 2026-04-07
type: concept
tags: [rl]
sources: [raw/articles/b.md]
---
[[queries/test]] [[entities/grpo]]
`,
    );
    writeFile(
      path.join(vault, "queries/test.md"),
      `---
title: Test
created: 2026-04-07
updated: 2026-04-07
type: query
tags: [rl]
sources: [raw/articles/c.md]
---
[[grpo]] [[grpo]]
`,
    );

    const report = runReport(vault);
    expect(report.stats.ambiguousLinkCount).toBe(2);
    expect(report.ambiguousLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "queries/test.md",
          target: "grpo",
        }),
      ]),
    );
    expect(report.topConnected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ page: "entities/grpo.md", inboundLinks: 1 }),
        expect.objectContaining({ page: "concepts/grpo.md", inboundLinks: 1 }),
      ]),
    );
  });

  it("requires two distinct resolved outbound targets", () => {
    const vault = makeTempVault();
    writeFile(
      path.join(vault, "entities/grpo.md"),
      `---
title: GRPO
created: 2026-04-07
updated: 2026-04-07
type: entity
tags: [rl]
sources: [raw/articles/a.md]
---
[[nemo-rl]] [[nemo-rl]]
`,
    );
    writeFile(
      path.join(vault, "entities/nemo-rl.md"),
      `---
title: NeMo RL
created: 2026-04-07
updated: 2026-04-07
type: entity
tags: [rl]
sources: [raw/articles/b.md]
---
[[grpo]] [[grpo]]
`,
    );

    const report = runReport(vault);
    expect(report.stats.weakOutboundCount).toBe(2);
    expect(report.weakOutbound).toEqual(
      expect.arrayContaining(["entities/grpo.md", "entities/nemo-rl.md"]),
    );
  });

  it("parses CRLF frontmatter and enforces status as a required field", () => {
    const vault = makeTempVault();
    writeFile(
      path.join(vault, "entities/crlf-page.md"),
      [
        "---",
        "title: CRLF Page",
        "created: 2026-04-07",
        "updated: 2026-04-07",
        "type: entity",
        "tags: [rl]",
        "sources: [raw/articles/a.md]",
        "---",
        "[[other-page]]",
      ].join("\r\n"),
    );
    writeFile(
      path.join(vault, "entities/other-page.md"),
      `---
title: Other Page
created: 2026-04-07
updated: 2026-04-07
type: entity
tags: [rl]
status: active
sources: [raw/articles/b.md]
---
[[crlf-page]] [[crlf-page]]
`,
    );

    const report = runReport(vault);
    expect(report.frontmatterIssues).toEqual([
      {
        page: "entities/crlf-page.md",
        missing: ["status"],
      },
    ]);
  });

  it("surfaces bridge pages, cross-section links, and suggested questions", () => {
    const vault = makeTempVault();
    writeFile(
      path.join(vault, "concepts/grpo.md"),
      `---
title: GRPO
created: 2026-04-07
updated: 2026-04-07
type: concept
tags: [rl]
status: active
sources: [raw/articles/a.md]
---
[[entities/nemo-rl]] [[projects/open-instruct]] [[queries/grpo-adoption]]
`,
    );
    writeFile(
      path.join(vault, "entities/nemo-rl.md"),
      `---
title: NeMo RL
created: 2026-04-07
updated: 2026-04-07
type: entity
tags: [rl]
status: active
sources: [raw/articles/b.md]
---
[[concepts/grpo]] [[queries/grpo-adoption]]
`,
    );
    writeFile(
      path.join(vault, "projects/open-instruct.md"),
      `---
title: Open Instruct
created: 2026-04-07
updated: 2026-04-07
type: project
tags: [rl]
status: active
sources: [raw/articles/c.md]
---
[[concepts/grpo]] [[queries/grpo-adoption]]
`,
    );
    writeFile(
      path.join(vault, "queries/grpo-adoption.md"),
      `---
title: GRPO Adoption
created: 2026-04-07
updated: 2026-04-07
type: query
tags: [rl]
status: active
sources: [raw/articles/d.md]
---
[[concepts/grpo]] [[entities/nemo-rl]]
`,
    );

    const report = runReport(vault);
    expect(report.stats.bridgePageCount).toBeGreaterThan(0);
    expect(report.bridgePages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          page: "concepts/grpo.md",
          title: "GRPO",
        }),
      ]),
    );
    expect(report.stats.surprisingConnectionCount).toBeGreaterThan(0);
    expect(report.surprisingConnections.some((entry: Any) => entry.sourceTitle === "GRPO")).toBe(
      true,
    );
    expect(report.suggestedQuestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "bridge_page",
        }),
      ]),
    );
  });
});
