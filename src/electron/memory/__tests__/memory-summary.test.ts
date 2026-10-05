import { describe, expect, it } from "vitest";
import { chronicleObservationToMemoryContent } from "../../chronicle/ChronicleProvenance";
import { createLocalEmbedding, cosineSimilarity } from "../local-embedding";
import { MemoryObservationStore } from "../memory-observation-sql";
import {
  buildDeterministicSummary,
  informativeMemoryText,
  legacyDeterministicSummary,
  memoryEmbeddingText,
} from "../memory-summary";

// Audit DATA-5: summaries, embeddings and observation text came from the first line, so
// producers with a constant first line produced identical rows.

const SESSION_PREAMBLE =
  "This session is being continued from earlier context that was compacted due to token limits. " +
  "A previous agent produced the structured summary below to hand off the work. " +
  "Use this to build on the work that has already been done and avoid duplicating effort.";

function chronicle(appName: string, windowTitle: string, text: string): string {
  return chronicleObservationToMemoryContent({
    appName,
    windowTitle,
    localTextSnippet: text,
  } as Parameters<typeof chronicleObservationToMemoryContent>[0]);
}

describe("buildDeterministicSummary", () => {
  it("skips the Chronicle provenance line and joins the field lines", () => {
    const a = buildDeterministicSummary(chronicle("Slack", "#releases", "ship at 5"));
    const b = buildDeterministicSummary(chronicle("Slack", "#design", "new logo"));
    expect(a).toBe("App: Slack · Window: #releases · Observed text (untrusted): ship at 5");
    expect(a).not.toBe(b);
    expect(a).not.toContain("Chronicle observation");
  });

  it("skips the compaction preamble and generic section labels", () => {
    const content = [
      SESSION_PREAMBLE,
      "",
      "## Primary Request and Intent",
      "1. **Primary Request and Intent**: Migrate the billing exporter to the queue.",
    ].join("\n");
    expect(buildDeterministicSummary(content)).toBe("Migrate the billing exporter to the queue.");
  });

  it("skips import headers, legacy tags and the prompt-recall marker", () => {
    expect(
      buildDeterministicSummary(
        '[cowork:prompt_recall=ignore]\n[Imported from ChatGPT — "Trip"]\nPrefers aisle seats',
      ),
    ).toBe("Prefers aisle seats");
    expect(buildDeterministicSummary("[core-trace:abc][scope:workspace:w] Uses pnpm")).toBe(
      "Uses pnpm",
    );
  });

  it("skips the pre-compaction flush header and tool-result labels", () => {
    expect(
      buildDeterministicSummary(
        "Pre-compaction memory flush (2026-10-05T10:00:00Z)\nContext: release prep\n\nDone.",
      ),
    ).toBe("release prep");
    expect(buildDeterministicSummary("Tool result for read_file:\nThe config sets port 8080")).toBe(
      "The config sets port 8080",
    );
  });

  it("prefers prose over code and keeps prose that ends with a colon", () => {
    expect(buildDeterministicSummary("```ts\nconst a = 1;\n```\nSet the flag")).toBe(
      "Set the flag",
    );
    expect(buildDeterministicSummary("```\nnpm run build\n```")).toBe("npm run build");
    expect(
      buildDeterministicSummary("The build failed because of the following two errors:\n- E1"),
    ).toBe("The build failed because of the following two errors:");
  });

  it("falls back to the first line when every line is a skipped preamble", () => {
    expect(buildDeterministicSummary("[redacted]")).toBe("[redacted]");
    expect(buildDeterministicSummary("Highlights:")).toBe("Highlights:");
    expect(buildDeterministicSummary("")).toBe("");
  });

  it("caps the summary at 220 characters", () => {
    const summary = buildDeterministicSummary(`Header line ${"x".repeat(400)}`);
    expect(summary.length).toBe(220);
    expect(summary.endsWith("...")).toBe(true);
  });

  it("differs from the legacy first-line rule only where a preamble was skipped", () => {
    expect(legacyDeterministicSummary("Plain note\nmore")).toBe("Plain note");
    expect(buildDeterministicSummary("Plain note\nmore")).toBe("Plain note");
    expect(legacyDeterministicSummary(chronicle("A", "B", "C"))).toBe(
      "Chronicle observation from the user's local screen context.",
    );
  });
});

describe("memoryEmbeddingText", () => {
  it("includes the body, so rows sharing a first line get different vectors", () => {
    const a = chronicle("Slack", "#releases", "the release ships friday after the security review");
    const b = chronicle("Figma", "Logo v2", "brand colors approved by marketing team");
    const textA = memoryEmbeddingText(buildDeterministicSummary(a), a);
    const textB = memoryEmbeddingText(buildDeterministicSummary(b), b);
    expect(textA).toContain("security review");
    expect(textA).not.toContain("Chronicle observation from");
    const similarity = cosineSimilarity(createLocalEmbedding(textA), createLocalEmbedding(textB));
    expect(similarity).toBeLessThan(0.9);
  });

  it("does not repeat a summary the body starts with, and strips import headers", () => {
    expect(memoryEmbeddingText("Uses pnpm", "Uses pnpm\nfor every package")).toBe(
      "Uses pnpm\nfor every package",
    );
    expect(memoryEmbeddingText(undefined, '[Imported from X — "t"]\nLikes tea')).toBe("Likes tea");
  });

  it("is bounded", () => {
    expect(memoryEmbeddingText("s", "y".repeat(20000)).length).toBe(12000);
  });
});

describe("observation text from content", () => {
  it("derives title, narrative and facts from the informative content", () => {
    const content = chronicle("Slack", "#releases", "the release ships friday");
    const observation = MemoryObservationStore.buildMetadataFor({
      id: "m1",
      workspaceId: "w1",
      type: "screen_context",
      content,
      summary: buildDeterministicSummary(content),
      tokens: 10,
      isCompressed: true,
      isPrivate: true,
      createdAt: 1,
      updatedAt: 1,
    });
    expect(observation.title).toContain("App: Slack");
    expect(observation.narrative).toContain("Window: #releases");
    expect(observation.narrative).not.toContain("Chronicle observation from");
    expect(observation.facts.join(" ")).toContain("the release ships friday");
    expect(informativeMemoryText(content)).not.toContain("Treat screen-derived text");
  });

  it("uses the content when there is no summary", () => {
    const observation = MemoryObservationStore.buildMetadataFor({
      id: "m2",
      workspaceId: "w1",
      type: "summary",
      content: `${SESSION_PREAMBLE}\n\nRefactored the exporter. Added retries.`,
      tokens: 10,
      isCompressed: false,
      isPrivate: false,
      createdAt: 1,
      updatedAt: 1,
    });
    expect(observation.title).toBe("Refactored the exporter.");
    expect(observation.facts).toEqual(["Refactored the exporter.", "Added retries."]);
  });
});
