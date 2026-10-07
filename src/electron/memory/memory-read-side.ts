/**
 * Response style choices from Settings (docs/memory-repo-phase3-design.md §4).
 *
 * PersonalityManager is the source of truth of the user's name and response style; nothing
 * mirrors them from `memory_items` any more. A style the user chooses (in Settings or with
 * `set_response_style`) sets PersonalityManager's `responseStyleExplicit` flag, and
 * AdaptiveStyleEngine never adapts while it is set. A Settings save only counts as a choice
 * when the user actually changed the style: a stale form copy that undoes the engine's
 * latest adaptation is recognised and ignored.
 */
import { PersonalityManager } from "../settings/personality-manager";
import { createLogger } from "../utils/logger";
import type { ResponseStylePreferences } from "../../shared/types";

const logger = createLogger("MemoryReadSide");

const RESPONSE_STYLE_DIMENSIONS = [
  "responseLength",
  "explanationDepth",
  "emojiUsage",
  "codeCommentStyle",
] as const;

type StyleLike = Partial<Record<(typeof RESPONSE_STYLE_DIMENSIONS)[number], unknown>>;

function sameResponseStyle(
  a: StyleLike | null | undefined,
  b: StyleLike | null | undefined,
): boolean {
  return RESPONSE_STYLE_DIMENSIONS.every((key) => (a?.[key] ?? null) === (b?.[key] ?? null));
}

function currentResponseStyle(): Partial<ResponseStylePreferences> | undefined {
  try {
    return PersonalityManager.loadSettings().responseStyle;
  } catch {
    return undefined;
  }
}

/** One applied style adaptation (AdaptiveStyleEngine's history record). */
export interface ResponseStyleAdaptation {
  dimension: string;
  fromValue: string;
  toValue: string;
}

let adaptationSource: (() => ResponseStyleAdaptation[]) | null = null;

/**
 * AdaptiveStyleEngine registers its adaptation history here (a provider rather than an
 * import, because the engine already imports this module).
 */
export function setResponseStyleAdaptationSource(
  source: (() => ResponseStyleAdaptation[]) | null,
): void {
  adaptationSource = source;
}

function loadAdaptationHistory(): ResponseStyleAdaptation[] {
  try {
    return adaptationSource?.() ?? [];
  } catch {
    return [];
  }
}

/**
 * True when the change from `before` to `after` exactly undoes the engine's latest
 * adaptation of every changed dimension: the signature of a settings form saving a copy
 * it loaded before the engine adapted. Such a save is not a style the user chose.
 */
export function isRevertOfStyleAdaptation(
  before: Partial<ResponseStylePreferences> | undefined,
  after: Partial<ResponseStylePreferences> | undefined,
  history: ResponseStyleAdaptation[],
): boolean {
  const changed = RESPONSE_STYLE_DIMENSIONS.filter(
    (key) => (before?.[key] ?? null) !== (after?.[key] ?? null),
  );
  if (changed.length === 0) return false;
  return changed.every((key) => {
    const latest = [...history].reverse().find((record) => record.dimension === key);
    return (
      !!latest &&
      latest.toValue === String(before?.[key] ?? "") &&
      latest.fromValue === String(after?.[key] ?? "")
    );
  });
}

export interface SettingsResponseStyleMirrorOptions {
  /**
   * The response style the settings form loaded (its "etag"). When the saved style equals
   * it, the user did not change the style in the form: nothing is recorded, and a style the
   * engine adapted after the form loaded is kept rather than reverted by the stale copy.
   */
  baseline?: StyleLike | null;
  /** Adaptation history override (tests); defaults to the registered engine source. */
  adaptationHistory?: ResponseStyleAdaptation[];
}

/**
 * Run a Settings save of the personality and, when the user changed the response style,
 * mark it explicit in PersonalityManager, so AdaptiveStyleEngine stops adapting over it
 * (as after `set_response_style`). Nothing is marked when:
 * - the save leaves the stored style unchanged;
 * - the form's `baseline` equals the saved style (the user did not touch it; a stale copy
 *   is undone so the adapted style stays);
 * - without a baseline, the save exactly reverts the engine's latest adaptation (a stale
 *   form copy; the engine may adapt again).
 */
export function withSettingsResponseStyleMirror<T>(
  save: () => T,
  options: SettingsResponseStyleMirrorOptions = {},
): T {
  const before = currentResponseStyle();
  const result = save();
  const after = currentResponseStyle();
  if (!after || sameResponseStyle(before, after)) return result;
  if (options.baseline) {
    if (sameResponseStyle(options.baseline, after)) {
      // The form's style is the one it loaded: restore the newer stored style.
      if (before) {
        try {
          PersonalityManager.setResponseStyle(before);
        } catch (error) {
          logger.warn("Could not keep the adapted response style after a stale save:", error);
        }
      }
      return result;
    }
  } else if (
    isRevertOfStyleAdaptation(before, after, options.adaptationHistory ?? loadAdaptationHistory())
  ) {
    return result;
  }
  try {
    PersonalityManager.setResponseStyleExplicit(true);
  } catch (error) {
    logger.warn("Could not record the chosen response style:", error);
  }
  return result;
}
