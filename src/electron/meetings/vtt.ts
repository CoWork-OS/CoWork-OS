export interface TranscriptCue {
  start: string;
  end: string;
  speaker?: string;
  text: string;
}

const TIMING_RE = /^(\d{1,2}:)?\d{2}:\d{2}[.,]\d{3}\s+-->\s+((\d{1,2}:)?\d{2}:\d{2}[.,]\d{3})/;
const VOICE_RE = /^<v\s+([^>]+)>([\s\S]*?)(?:<\/v>)?$/;

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function stripTags(text: string): string {
  return text.replace(/<\/?[^>]+>/g, "");
}

/**
 * Parse WebVTT as produced by Teams (`<v Speaker Name>text</v>`) and Meet
 * exports. Consecutive cues from the same speaker are merged.
 */
export function parseWebVtt(vtt: string): TranscriptCue[] {
  const lines = vtt
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const cues: TranscriptCue[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    const timing = TIMING_RE.exec(line);
    if (!timing) {
      i += 1;
      continue;
    }
    const [start, end] = line.split(/\s+-->\s+/).map((value) => value.split(/\s+/)[0]);
    i += 1;
    const body: string[] = [];
    while (i < lines.length && lines[i].trim() !== "") {
      body.push(lines[i].trim());
      i += 1;
    }
    let speaker: string | undefined;
    const joined = body.join(" ");
    const voice = VOICE_RE.exec(joined);
    let text = joined;
    if (voice) {
      speaker = decodeEntities(voice[1].trim());
      text = voice[2];
    }
    text = decodeEntities(stripTags(text)).replace(/\s+/g, " ").trim();
    if (!text) continue;
    const previous = cues[cues.length - 1];
    if (previous && previous.speaker === speaker) {
      previous.text = `${previous.text} ${text}`;
      previous.end = end;
    } else {
      cues.push({ start, end, speaker, text });
    }
  }
  return cues;
}

function shortTimestamp(value: string): string {
  const [clock] = value.replace(",", ".").split(".");
  const parts = clock.split(":");
  const [h, m, s] = parts.length === 3 ? parts : ["0", ...parts];
  return Number(h) > 0 ? `${Number(h)}:${m}:${s}` : `${m}:${s}`;
}

export interface MeetingMarkdownInput {
  title: string;
  provider: string;
  organizer?: string;
  startTime?: string;
  endTime?: string;
  joinUrl?: string;
  sourceLinks?: Array<{ label: string; url: string }>;
  attendees?: string[];
  recordings?: Array<{ id: string; createdDateTime?: string }>;
  cues: TranscriptCue[];
  retrievedAt: string;
}

function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_[\]#|<>])/g, "\\$1");
}

export function renderMeetingMarkdown(input: MeetingMarkdownInput): string {
  const lines = [`# ${escapeMarkdown(input.title)}`, ""];
  const meta: Array<[string, string | undefined]> = [
    ["Source", input.provider],
    ["Organizer", input.organizer],
    ["Start", input.startTime],
    ["End", input.endTime],
    ["Join link", input.joinUrl],
    ["Retrieved", input.retrievedAt],
  ];
  for (const [label, value] of meta) {
    if (value)
      lines.push(`- **${label}:** ${label === "Join link" ? value : escapeMarkdown(value)}`);
  }
  if (input.attendees?.length) {
    lines.push(`- **Participants:** ${input.attendees.map(escapeMarkdown).join(", ")}`);
  }
  for (const link of input.sourceLinks || []) {
    lines.push(`- **${escapeMarkdown(link.label)}:** ${link.url}`);
  }
  if (input.recordings?.length) {
    lines.push(
      `- **Recordings:** ${input.recordings.length} available (not downloaded; fetch from CoWork when needed)`,
    );
  }
  lines.push("", "## Transcript", "");
  if (input.cues.length === 0) {
    lines.push("_The transcript was empty._");
  }
  for (const cue of input.cues) {
    const who = cue.speaker ? `**${escapeMarkdown(cue.speaker)}**` : "**Unknown speaker**";
    lines.push(`${who} \`${shortTimestamp(cue.start)}\`  `, escapeMarkdown(cue.text), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
