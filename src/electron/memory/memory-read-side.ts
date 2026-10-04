/**
 * Read-side wiring of the memory engine: keeps the synchronous consumers that cannot read
 * `memory_items` on their hot path consistent with it. PersonalityManager's user name and
 * response style are mirrors of `memory_items`, never a source of facts.
 *
 * - **Preferred name (PROMPT-7).** `preferred_name` is one subject in `memory_items`;
 *   `set_user_name` writes it as `user_stated`, which outranks inferred names, and a later
 *   statement of equal trust supersedes. PersonalityManager's `userName` (read by the
 *   identity prompt and greetings) is set from the active item after every write, so a new
 *   profile fact can no longer revert the name to the onboarding value.
 * - **Response style.** The `response_style` item is the style fact; its structured value
 *   (`source_ref.style`) is applied to PersonalityManager's live style after every write,
 *   whether AdaptiveStyleEngine inferred it, the user set it in Settings or with
 *   `set_response_style`. AdaptiveStyleEngine must not adapt when the user chose a style
 *   (an item held as `user_stated` / `user_confirmed`); the engine is synchronous, so that
 *   answer is cached here and refreshed after writes.
 */
import { PersonalityManager } from "../settings/personality-manager";
import { sanitizeStoredPreferredName } from "../utils/preferred-name";
import { createLogger } from "../utils/logger";
import { MemoryWriter, type MemoryItemsChange } from "./MemoryWriter";
import {
  MEMORY_LANE_STORES,
  preferredNameCandidate,
  responseStyleCandidate,
} from "./memory-items-lanes";
import type { ResponseStylePreferences } from "../../shared/types";
import type { ListMemoryItemsRequest, MemoryItem } from "./memory-items-types";

const logger = createLogger("MemoryReadSide");

export interface MemoryReadSidePort {
  list(request: ListMemoryItemsRequest): Promise<MemoryItem[]>;
  findById?(id: string): Promise<MemoryItem | undefined>;
}

export interface MemoryReadSideDeps {
  getUserName?: () => string | undefined;
  setUserName?: (name: string) => void;
  getResponseStyle?: () => Partial<ResponseStylePreferences> | undefined;
  setResponseStyle?: (style: Partial<ResponseStylePreferences>) => void;
}

const EXPLICIT_STYLE_SOURCES = new Set(["user_stated", "user_confirmed"]);

let explicitResponseStyle = false;
let readSideActive = false;

/**
 * True while the read side runs (installed by the memory engine after the startup lane
 * migration): PersonalityManager's user name and style follow `memory_items`.
 */
export function isMemoryReadSideActive(): boolean {
  return readSideActive;
}

/** True when the user chose a response style explicitly (cached; see module comment). */
export function hasExplicitResponseStyle(): boolean {
  return explicitResponseStyle;
}

/** Tests and the Memory Hub reset path. */
export function setExplicitResponseStyleState(value: boolean): void {
  explicitResponseStyle = value;
}

async function activeGlobalSubject(
  port: MemoryReadSidePort,
  subjectKey: string,
): Promise<MemoryItem | null> {
  const items = await port.list({
    workspaceId: null,
    scope: "global",
    subjectKey,
    statuses: ["active"],
    includePrivate: true,
    limit: 1,
  });
  return items[0] ?? null;
}

export async function refreshExplicitResponseStyle(port: MemoryReadSidePort): Promise<boolean> {
  const item = await activeGlobalSubject(port, "response_style");
  explicitResponseStyle = !!item && EXPLICIT_STYLE_SOURCES.has(item.source);
  return explicitResponseStyle;
}

const RESPONSE_STYLE_DIMENSIONS = [
  "responseLength",
  "explanationDepth",
  "emojiUsage",
  "codeCommentStyle",
] as const;

type StyleLike = Partial<Record<(typeof RESPONSE_STYLE_DIMENSIONS)[number], unknown>>;

function sameResponseStyle(a: StyleLike | null | undefined, b: StyleLike | null | undefined): boolean {
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
 * record the new style as a `user_stated` `response_style` item, so AdaptiveStyleEngine
 * stops adapting over it (as after `set_response_style`). Nothing is recorded when:
 * - the save leaves the stored style unchanged;
 * - the form's `baseline` equals the saved style (the user did not touch it; a stale copy
 *   is undone so the adapted style stays);
 * - without a baseline, the save exactly reverts the engine's latest adaptation (a stale
 *   form copy; the engine may adapt again).
 * No-op without a MemoryWriter (node daemon, CLI, before initialization).
 */
export function withSettingsResponseStyleMirror<T>(
  save: () => T,
  options: SettingsResponseStyleMirrorOptions = {},
): T {
  if (!MemoryWriter.get()) return save();
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
  MemoryWriter.writeInBackground(
    responseStyleCandidate(after, {
      source: "user_stated",
      store: MEMORY_LANE_STORES.personality,
      reason: "settings",
    }),
    "settings_response_style",
  );
  return result;
}

const STYLE_VALUES: Record<(typeof RESPONSE_STYLE_DIMENSIONS)[number], ReadonlySet<string>> = {
  responseLength: new Set(["terse", "balanced", "detailed"]),
  explanationDepth: new Set(["expert", "balanced", "teaching"]),
  emojiUsage: new Set(["none", "minimal", "moderate", "expressive"]),
  codeCommentStyle: new Set(["minimal", "moderate", "verbose"]),
};

/** The structured style of a `response_style` item (`source_ref.style`), valid values only. */
export function responseStyleFromItem(
  item: Pick<MemoryItem, "sourceRef">,
): Partial<ResponseStylePreferences> | null {
  const raw = item.sourceRef.style;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const style: Record<string, string> = {};
  for (const key of RESPONSE_STYLE_DIMENSIONS) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === "string" && STYLE_VALUES[key].has(value)) style[key] = value;
  }
  return Object.keys(style).length > 0 ? (style as Partial<ResponseStylePreferences>) : null;
}

/**
 * Apply the active `response_style` item to PersonalityManager. Items without a
 * structured style (copied from the retired adaptive-style lane) leave the style alone.
 */
export async function syncResponseStyleFromMemory(
  port: MemoryReadSidePort,
  deps: MemoryReadSideDeps = {},
): Promise<Partial<ResponseStylePreferences> | null> {
  const item = await activeGlobalSubject(port, "response_style");
  const style = item ? responseStyleFromItem(item) : null;
  if (!style) return null;
  const current = (deps.getResponseStyle ?? currentResponseStyle)();
  const merged = { ...current, ...style };
  if (!sameResponseStyle(current, merged)) {
    (deps.setResponseStyle ?? ((next) => PersonalityManager.setResponseStyle(next)))(style);
  }
  return style;
}

/** The name in a `preferred_name` item (`Preferred name: Alice` → `Alice`). */
export function preferredNameFromItem(item: Pick<MemoryItem, "content">): string | null {
  const raw = String(item.content || "").replace(/^\s*preferred name\s*:\s*/i, "");
  return sanitizeStoredPreferredName(raw) ?? null;
}

/**
 * Set PersonalityManager's user name from the active `preferred_name` item. With no active
 * item, the name is cleared only when `clearedIds` shows the item was just deleted (a real
 * forget); otherwise a name that predates the migration is left alone.
 */
export async function syncPreferredNameFromMemory(
  port: MemoryReadSidePort,
  deps: MemoryReadSideDeps = {},
  clearedIds: string[] = [],
): Promise<string | null> {
  const getUserName = deps.getUserName ?? (() => PersonalityManager.getUserName());
  const setUserName = deps.setUserName ?? ((name: string) => PersonalityManager.setUserName(name));
  const item = await activeGlobalSubject(port, "preferred_name");
  const current = getUserName() ?? "";
  if (item) {
    const name = preferredNameFromItem(item);
    if (name && name !== current) setUserName(name);
    return name;
  }
  if (current && clearedIds.length > 0 && port.findById) {
    for (const id of clearedIds) {
      const cleared = await port.findById(id);
      if (cleared?.subjectKey === "preferred_name" && cleared.scope === "global") {
        setUserName("");
        return null;
      }
    }
  }
  return null;
}

/**
 * One-time reconciliation after the lane migration: before it, PersonalityManager's name
 * was the live value (set_user_name and the profile sync both wrote it), while the
 * migration may have picked an older onboarding name by trust. Adopt the live name as
 * `user_stated` when the two differ, so the migration never reverts it.
 */
export async function reconcilePreferredName(
  writer: Pick<MemoryWriter, "ingest">,
  port: MemoryReadSidePort,
  deps: MemoryReadSideDeps = {},
): Promise<boolean> {
  const current = sanitizeStoredPreferredName(
    (deps.getUserName ?? (() => PersonalityManager.getUserName()))(),
  );
  if (!current) return false;
  const item = await activeGlobalSubject(port, "preferred_name");
  if (item && preferredNameFromItem(item) === current) return false;
  const candidate = preferredNameCandidate(current, { source: "user_stated" });
  if (!candidate) return false;
  const result = await writer.ingest(candidate);
  return result.status === "written";
}

export interface MemoryReadSideHandle {
  dispose(): void;
  /** Run a sync pass now (after the lane migration finishes). */
  refresh(): Promise<void>;
  /** Resolves when no sync pass is running (tests, shutdown). */
  idle(): Promise<void>;
}

/**
 * Subscribe the read-side syncs to MemoryWriter changes and run them once now. The memory
 * engine installs it after the startup lane migration (`memory-engine-bootstrap.ts`), so
 * the syncs never run from a half-copied store. Refreshes are coalesced: a change during
 * a pass schedules one more pass.
 */
export function installMemoryReadSide(
  writer: MemoryWriter,
  deps: MemoryReadSideDeps = {},
): MemoryReadSideHandle {
  const port: MemoryReadSidePort = writer.repository;
  let running: Promise<void> | null = null;
  let pendingCleared: string[] = [];
  let dirty = false;
  let reconciled = false;
  readSideActive = true;

  const run = (): Promise<void> => {
    if (running) {
      dirty = true;
      return running;
    }
    running = (async () => {
      do {
        dirty = false;
        const cleared = pendingCleared;
        pendingCleared = [];
        try {
          if (!reconciled) {
            reconciled = true;
            // The reconciling write notifies listeners, which schedules the sync pass.
            await reconcilePreferredName(writer, port, deps);
          }
          await refreshExplicitResponseStyle(port);
          await syncResponseStyleFromMemory(port, deps);
          await syncPreferredNameFromMemory(port, deps, cleared);
        } catch (error) {
          logger.warn("Memory read-side sync failed:", error);
        }
      } while (dirty);
    })().finally(() => {
      running = null;
    });
    return running;
  };

  const unsubscribe = MemoryWriter.onChange((change: MemoryItemsChange) => {
    if (change.kind === "status") pendingCleared.push(...change.itemIds);
    void run();
  });
  void run();
  return {
    dispose: () => {
      unsubscribe();
      readSideActive = false;
    },
    refresh: () => run(),
    idle: async () => {
      while (running) await running;
    },
  };
}
