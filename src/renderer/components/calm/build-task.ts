import type { Task } from "../../../shared/types";
import { BUILD_PROMPT_MARKER } from "../../../shared/build-task";
import type { AccessProfileDefinition } from "../../../shared/access-profiles";

/**
 * Appended to every prompt started from the Build view. It steers the agent
 * toward a self-contained web app it verifies with the sandboxed page preview
 * (the app shows the user a live preview on its own). It is also how a task is
 * recognised for older tasks without persisted taskOrigin metadata.
 */
export const BUILD_INSTRUCTIONS =
  "Build this as a self-contained interactive web app (HTML, CSS and JavaScript, no external libraries or network requests) and keep it clean and usable by non-developers. " +
  "When a version is ready, check it with the preview_web_page tool instead of a browser: confirm there are no console errors and click through the main interactions. Fix what you find, then summarise what you built.";

export const GUEST_BUILD_INSTRUCTIONS =
  "Build this as a self-contained interactive web app (HTML, CSS and JavaScript, no external libraries or network requests) and keep it clean and usable by non-developers. " +
  "Create the files in the task computer. When a version is ready, serve it on guest loopback (127.0.0.1) and use the guest browser tools to inspect the page and click through the main interactions. " +
  "Fix what you find, export the selected result files before finishing, then summarise what you built. The host page-preview tool cannot access guest files or guest loopback.";

/** Fresh computers currently expose coarse network authority, never per-domain consent. */
export function getBuildComputerPolicyIssue(
  computer: "host" | "bot-desktop" | "cua",
  profile: AccessProfileDefinition,
): string | null {
  if (computer === "host") return null;
  return profile.network !== "enabled" || (profile.domainRules?.length ?? 0) > 0
    ? "Fresh task computers require an access profile with network enabled and no domain rules. Choose a compatible Access profile before starting."
    : null;
}

/** What builds started before the preview tool existed were sent with. */
const LEGACY_BUILD_INSTRUCTIONS =
  "Build this as a self-contained interactive web app (HTML, CSS and JavaScript) and open a live preview when it is ready. Keep it clean and usable by non-developers.";

/** Opening shared by current and legacy build instructions. */
const BUILD_INSTRUCTIONS_OPENING = BUILD_PROMPT_MARKER;

export function isBuildPrompt(text: string | null | undefined): boolean {
  return (
    typeof text === "string" &&
    (text.includes(BUILD_INSTRUCTIONS) ||
      text.includes(GUEST_BUILD_INSTRUCTIONS) ||
      text.includes(LEGACY_BUILD_INSTRUCTIONS))
  );
}

export function isBuildTask(
  task:
    | Pick<Task, "prompt" | "rawPrompt" | "userPrompt" | "sidebarPromptPreview" | "agentConfig">
    | null
    | undefined,
): boolean {
  if (!task) return false;
  if (task.agentConfig?.taskOrigin === "build") return true;
  if ([task.rawPrompt, task.userPrompt, task.prompt].some(isBuildPrompt)) return true;
  // Sidebar task rows carry an empty prompt and a preview cut at 1024 chars, which
  // can cut the instructions off after the user's text; their shared opening is enough.
  return (
    typeof task.sidebarPromptPreview === "string" &&
    task.sidebarPromptPreview.includes(BUILD_INSTRUCTIONS_OPENING)
  );
}

/** The prompt as the user wrote it, without the build steering text. */
export function stripBuildInstructions(text: string): string {
  if (!isBuildPrompt(text)) return text;
  return text
    .split(BUILD_INSTRUCTIONS)
    .join("")
    .split(GUEST_BUILD_INSTRUCTIONS)
    .join("")
    .split(LEGACY_BUILD_INSTRUCTIONS)
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
