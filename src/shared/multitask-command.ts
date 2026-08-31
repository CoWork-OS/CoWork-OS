export const MULTITASK_DEFAULT_LANE_COUNT = 4;
export const MULTITASK_MIN_LANE_COUNT = 2;
export const MULTITASK_MAX_LANE_COUNT = 8;

export type MultitaskAssignmentMode = "auto_split";

export interface ParsedMultitaskCommand {
  isMultitask: boolean;
  valid: boolean;
  prompt: string;
  laneCount: number;
  assignmentMode: MultitaskAssignmentMode;
  error?: string;
}

function clampLaneCount(value: number): number {
  if (!Number.isFinite(value)) return MULTITASK_DEFAULT_LANE_COUNT;
  return Math.max(MULTITASK_MIN_LANE_COUNT, Math.min(MULTITASK_MAX_LANE_COUNT, Math.floor(value)));
}

export function parseMultitaskCommand(text: string): ParsedMultitaskCommand {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!/^\/multitask(?:\s|$)/i.test(raw)) {
    return {
      isMultitask: false,
      valid: false,
      prompt: raw,
      laneCount: MULTITASK_DEFAULT_LANE_COUNT,
      assignmentMode: "auto_split",
    };
  }

  const match = raw.match(/^\/multitask(?:\s+(\d+))?(?:\s+([\s\S]*))?$/i);
  const laneCount = clampLaneCount(
    match?.[1] ? Number.parseInt(match[1], 10) : MULTITASK_DEFAULT_LANE_COUNT,
  );
  const prompt = (match?.[2] || "").trim();
  if (!prompt) {
    return {
      isMultitask: true,
      valid: false,
      prompt: "",
      laneCount,
      assignmentMode: "auto_split",
      error: "Add a request after /multitask.",
    };
  }

  return {
    isMultitask: true,
    valid: true,
    prompt,
    laneCount,
    assignmentMode: "auto_split",
  };
}

export function findMultitaskCommand(
  prompt: string,
  title?: string,
): ParsedMultitaskCommand | null {
  const promptParsed = parseMultitaskCommand(prompt);
  if (promptParsed.isMultitask) return promptParsed;
  if (title) {
    const titleParsed = parseMultitaskCommand(title);
    if (titleParsed.isMultitask) return titleParsed;
  }
  return null;
}
