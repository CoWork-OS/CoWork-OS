import { describe, expect, it } from "vitest";

import { reconcileAnswerCitations, type AnswerCitationSource } from "../answer-citations";
import { CitationTracker } from "../CitationTracker";

const MS = "https://support.microsoft.com/en-us/teams/meetings";
const ZOOM = "https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=";
const MEET = "https://support.google.com/meet/answer";

const URLS = {
  teamsDownload: `${MS}/start-stop-and-download-live-transcripts-in-microsoft-teams-meetings`,
  teamsTownHall: `${MS}/manage-town-hall-recordings-in-microsoft-teams`,
  teamsTroubleshoot: `${MS}/i-can-t-transcribe-a-meeting-in-microsoft-teams`,
  teamsAccess: `${MS}/customize-who-can-access-a-recording-or-transcript-in-microsoft-teams`,
  teamsOptions: `${MS}/meeting-options-in-microsoft-teams`,
  teamsRecordings: `${MS}/play-share-and-download-meeting-recordings-in-microsoft-teams`,
  teamsRecap: `${MS}/recap-in-microsoft-teams`,
  zoomDownload: `${ZOOM}KB0057886`,
  zoomEnable: `${ZOOM}KB0065911`,
  zoomTranscription: `${ZOOM}KB0064927`,
  meetTranscripts: `${MEET}/12849897?hl=en`,
  meetPremium: `${MEET}/12387350?hl=en`,
};

/** The task's source registry, numbered in discovery order as in the live run. */
const REGISTRY: AnswerCitationSource[] = [
  { index: 1, url: URLS.teamsDownload, title: "Teams: download transcripts" },
  { index: 2, url: URLS.teamsTownHall, title: "Teams: town hall recordings" },
  { index: 5, url: URLS.teamsTroubleshoot, title: "Teams: troubleshoot transcription" },
  { index: 6, url: URLS.teamsAccess, title: "Teams: customize access" },
  { index: 7, url: URLS.teamsOptions, title: "Teams: meeting options" },
  { index: 8, url: URLS.teamsRecordings, title: "Teams: meeting recordings" },
  { index: 9, url: URLS.teamsRecap, title: "Teams: recap" },
  { index: 21, url: URLS.zoomDownload, title: "Zoom: download transcript" },
  { index: 24, url: URLS.zoomEnable, title: "Zoom: enable transcription" },
  { index: 25, url: URLS.zoomTranscription, title: "Zoom: audio transcription" },
  { index: 31, url: URLS.meetTranscripts, title: "Google Meet: transcripts" },
  { index: 32, url: URLS.meetPremium, title: "Google Meet: premium features" },
];

/**
 * Shape of the live answer: anchored table cells use registry numbers, the
 * remaining markers use the answer's own 1..9 list, and two Zoom claims cite
 * Microsoft pages under both numberings.
 */
const LIVE_ANSWER = [
  "# Transcript exports",
  "",
  "| Platform | How to get it | Prerequisites | Limitations |",
  "|---|---|---|---|",
  `| **Microsoft Teams** | Download from the recap. [Download live transcripts](${URLS.teamsDownload}) [1] | Recap covers recorded or transcribed meetings. [Recap in Teams](${URLS.teamsRecap}) [9] | Policies can block transcription. [Troubleshoot](${URLS.teamsTroubleshoot}) [5] |`,
  `| **Zoom** | Download from the cloud recording. [Downloading transcript](${URLS.zoomDownload}) | Requires cloud recording; Zoom's prerequisites apply. [6, 7] | No cloud recording means no transcript. [6, 7] |`,
  `| **Google Meet** | Meet saves a Docs file to Drive. [Use Transcripts](${URLS.meetTranscripts}) | Edition-dependent. [Premium features](${URLS.meetPremium}) | Access depends on Drive sharing. [8, 9] |`,
  "",
  "## Practical differences",
  "",
  "- **File options:** Teams offers `.docx` and `.vtt`; Zoom offers a download; Google Meet saves a Docs file. [1, 2, 8]",
  "- **Most recording-dependent:** Zoom's export is tied to cloud recordings. [6, 7]",
  "- **Storage:** Google Meet saves to the organizer's Drive. [8]",
  "- **Licensing:** Google's edition page is clearest; Microsoft and Zoom need policy checks. [5, 6, 9]",
  "",
  "## Official sources",
  "",
  `1. [Microsoft Teams: Download live transcripts](${URLS.teamsDownload})`,
  `2. [Zoom: Downloading transcript](${URLS.zoomDownload})`,
  `3. [Zoom: Audio transcription](${URLS.zoomTranscription})`,
  `4. [Zoom: Enable transcription](${URLS.zoomEnable})`,
  `5. [Microsoft Teams: Troubleshoot](${URLS.teamsTroubleshoot})`,
  `6. [Microsoft Teams: Customize access](${URLS.teamsAccess})`,
  `7. [Microsoft Teams: Recap](${URLS.teamsRecap})`,
  `8. [Google Meet: Use Transcripts](${URLS.meetTranscripts})`,
  `9. [Google Meet: Premium features](${URLS.meetPremium})`,
  "",
  "**Scope note:** Plans change.",
].join("\n");

function sourceList(text: string): Map<number, string> {
  const list = new Map<number, string>();
  const start = text.indexOf("## Official sources");
  for (const match of text.slice(start).matchAll(/^- \[(\d+)\] \[[^\]]*\]\(([^)]+)\)/gm)) {
    list.set(Number(match[1]), match[2]);
  }
  return list;
}

function lineContaining(text: string, needle: string): string {
  return text.split("\n").find((line) => line.includes(needle)) || "";
}

describe("reconcileAnswerCitations", () => {
  it("puts inline markers and the source list on one numbering", () => {
    const result = reconcileAnswerCitations(LIVE_ANSWER, REGISTRY);
    const list = sourceList(result.text);

    expect(result.changed).toBe(true);
    expect(result.bibliographyRewritten).toBe(true);
    expect([...list.keys()]).toEqual([1, 5, 6, 9, 21, 24, 25, 31, 32]);
    expect(list.get(9)).toBe(URLS.teamsRecap);
    expect(list.get(21)).toBe(URLS.zoomDownload);
    expect(list.get(31)).toBe(URLS.meetTranscripts);

    // Every remaining inline number is an entry in the final list.
    const body = result.text.slice(0, result.text.indexOf("## Official sources"));
    for (const marker of body.matchAll(/\[(\d+(?:, \d+)*)\](?!\()/g)) {
      for (const value of marker[1].split(", ")) {
        expect(list.has(Number(value))).toBe(true);
      }
    }
  });

  it("keeps the identity of a marker placed right after a direct link", () => {
    const result = reconcileAnswerCitations(LIVE_ANSWER, REGISTRY);
    const teamsRow = lineContaining(result.text, "**Microsoft Teams**");

    expect(teamsRow).toContain(`[Recap in Teams](${URLS.teamsRecap}) [9]`);
    expect(teamsRow).toContain(`[Download live transcripts](${URLS.teamsDownload}) [1]`);
    expect(teamsRow).toContain(`[Troubleshoot](${URLS.teamsTroubleshoot}) [5]`);
    expect(sourceList(result.text).get(9)).toBe(URLS.teamsRecap);
  });

  it("reads unanchored markers against the answer's own list", () => {
    const result = reconcileAnswerCitations(LIVE_ANSWER, REGISTRY);

    expect(lineContaining(result.text, "**Google Meet**")).toContain("Drive sharing. [31, 32] |");
    expect(lineContaining(result.text, "**File options:**")).toMatch(/\[1, 21, 31\]$/);
    expect(lineContaining(result.text, "**Storage:**")).toMatch(/Drive\. \[31\]$/);
    expect(lineContaining(result.text, "**Licensing:**")).toMatch(/checks\. \[5, 6, 32\]$/);
  });

  it("removes and reports citations of another compared vendor's pages", () => {
    const result = reconcileAnswerCitations(LIVE_ANSWER, REGISTRY);
    const zoomRow = lineContaining(result.text, "**Zoom**");

    expect(zoomRow).not.toMatch(/\[\d/);
    expect(zoomRow).toContain(`[Downloading transcript](${URLS.zoomDownload})`);
    expect(zoomRow).toContain("Zoom's prerequisites apply. |");
    expect(lineContaining(result.text, "Most recording-dependent")).toMatch(/cloud recordings\.$/);
    expect(result.dropped).toHaveLength(6);
    expect(result.dropped.every((entry) => entry.reason === "misattributed")).toBe(true);
  });

  it("leaves direct Markdown links untouched", () => {
    const result = reconcileAnswerCitations(LIVE_ANSWER, REGISTRY);
    const links = (text: string) => [...text.matchAll(/\[[^\]]+\]\((https?:[^)]+)\)/g)].length;

    for (const url of Object.values(URLS)) {
      if (LIVE_ANSWER.includes(`(${url})`)) expect(result.text).toContain(`(${url})`);
    }
    expect(links(result.text)).toBe(links(LIVE_ANSWER));
  });

  it("is idempotent", () => {
    const first = reconcileAnswerCitations(LIVE_ANSWER, REGISTRY);
    const second = reconcileAnswerCitations(first.text, REGISTRY);

    expect(second.changed).toBe(false);
    expect(second.text).toBe(first.text);
    expect(second.dropped).toEqual([]);
  });

  it("does not change an answer whose list already uses registry numbers", () => {
    const answer = [
      `Teams downloads are .docx or .vtt [1]. Zoom transcripts need cloud recording [25].`,
      "",
      "## Sources",
      `- [1] [Teams](${URLS.teamsDownload})`,
      `- [25] [Zoom](${URLS.zoomTranscription})`,
    ].join("\n");

    expect(reconcileAnswerCitations(answer, REGISTRY)).toMatchObject({
      changed: false,
      text: answer,
    });
  });

  it("validates registry numbers when the answer has no source list", () => {
    const answer = "Teams supports .vtt [1]. Unknown claim [44]. Mixed [1, 44].";
    const result = reconcileAnswerCitations(answer, REGISTRY);

    expect(result.text).toBe("Teams supports .vtt [1]. Unknown claim. Mixed [1].");
    expect(result.dropped).toEqual([
      { marker: "[44]", number: 44, reason: "unknown_source" },
      { marker: "[1, 44]", number: 44, reason: "unknown_source" },
    ]);
  });

  it("uses the answer's own numbering when there is no registry", () => {
    const answer = [
      `Recap covers recorded meetings. [Recap](${URLS.teamsRecap}) [2]`,
      "Downloads are .docx [1]. Missing [7].",
      "",
      "References:",
      `1. [Download](${URLS.teamsDownload})`,
      `2. [Recap](${URLS.teamsRecap})`,
    ].join("\n");

    const result = reconcileAnswerCitations(answer, []);

    expect(result.text).toBe(
      [
        `Recap covers recorded meetings. [Recap](${URLS.teamsRecap}) [2]`,
        "Downloads are .docx [1]. Missing.",
        "",
        "References:",
        `1. [Download](${URLS.teamsDownload})`,
        `2. [Recap](${URLS.teamsRecap})`,
      ].join("\n"),
    );
  });

  it("adds cited registry sources missing from the answer's list", () => {
    const answer = [
      `Zoom needs cloud recording [25]. Teams has a recap [1].`,
      "",
      "## Sources",
      `1. [Teams download](${URLS.teamsDownload})`,
    ].join("\n");

    const result = reconcileAnswerCitations(answer, REGISTRY);

    expect(result.text).toContain("Zoom needs cloud recording [25]. Teams has a recap [1].");
    expect(sourceList(result.text.replace("## Sources", "## Official sources"))).toEqual(
      new Map([
        [1, URLS.teamsDownload],
        [25, URLS.zoomTranscription],
      ]),
    );
  });

  it("ignores code, reference links and bracketed text that is not a citation", () => {
    const answer = [
      "Use `items[1]` or arr[2] and see [the guide][1].",
      "```",
      "values[3] = [4]",
      "```",
      "Teams [1].",
    ].join("\n");

    const result = reconcileAnswerCitations(answer, REGISTRY);
    expect(result.text).toBe(answer);
  });

  it("leaves the answer alone when its source list cannot be identified", () => {
    const answer = ["Claim [1].", "", "## Sources", "1. A book without a link"].join("\n");
    expect(reconcileAnswerCitations(answer, REGISTRY).changed).toBe(false);
  });
});

describe("CitationTracker.reconcileAnswer", () => {
  it("registers pages the answer cites by URL so they get a stable index", () => {
    const tracker = new CitationTracker("task-1");
    tracker.addFromSearch([{ title: "Teams download", url: URLS.teamsDownload }]);
    const answer = [
      `Recap covers recorded meetings. [Recap](${URLS.teamsRecap}) [4]`,
      "",
      "## Sources",
      `1. [Teams download](${URLS.teamsDownload})`,
    ].join("\n");

    const result = tracker.reconcileAnswer(answer);

    expect(result.text).toContain(`[Recap](${URLS.teamsRecap}) [2]`);
    expect(result.text).toContain(`- [2] [Recap](${URLS.teamsRecap})`);
    expect(tracker.getCitations()[1]).toMatchObject({
      index: 2,
      url: URLS.teamsRecap,
      sourceTool: "answer_link",
    });
    expect(tracker.reconcileAnswer(result.text).changed).toBe(false);
  });

  it("keeps a searched page in a capped prompt list once it is fetched", () => {
    const tracker = new CitationTracker("task-1");
    tracker.addFromSearch(
      Array.from({ length: 5 }, (_, i) => ({ title: `Result ${i + 1}`, url: `https://s${i}.com` })),
    );
    tracker.addFromFetch("https://s4.com", "https://s4.com");

    const formatted = tracker.formatForPrompt({ maxSources: 2 });

    expect(tracker.count).toBe(5);
    expect(formatted).toContain("[5] Result 5");
    expect(formatted).toContain("[1] Result 1");
    expect(formatted).toMatch(/do not renumber the list from 1/);
  });
});
