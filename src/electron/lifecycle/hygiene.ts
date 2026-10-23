import type {
  HygieneFlag,
  HygieneItem,
  HygieneReport,
  LifecycleKind,
  LifecycleMeta,
  LifecycleRef,
} from "../../shared/types";

/**
 * Hygiene for generated software (agent-first roadmap WP9): which skills, playbook entries,
 * automations, triggers and rules nobody uses, nobody owns, or depend on something gone. It only
 * proposes; retiring is the user's decision, and nothing is deleted.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const HYGIENE_UNUSED_WARN_DAYS = 60;
export const HYGIENE_UNUSED_RETIRE_DAYS = 90;

/**
 * Kinds that run or apply on their own, where nobody being responsible is worth showing.
 * Playbook entries and rules are memory written from tasks; their owner is not tracked.
 */
const OWNER_EXPECTED: ReadonlySet<LifecycleKind> = new Set(["skill", "automation", "trigger"]);

/** One item as its own store describes it, before lifecycle metadata is applied. */
export interface HygieneSourceItem {
  kind: LifecycleKind;
  id: string;
  name: string;
  workspaceId?: string;
  /** An owner the item's own store records (a skill's author, a rule the user stated). */
  owner?: string;
  createdAt?: number;
  /** Use the item's own store keeps (cron runs, trigger fires, rule recalls). */
  lastUsedAt?: number;
  useCount?: number;
  /** Automations: the next scheduled run, when one is scheduled. */
  nextRunAt?: number;
  /** Dependencies the store implies (the workspace an automation runs in). */
  dependsOn?: LifecycleRef[];
}

const keyOf = (ref: { kind: string; id: string }) => `${ref.kind}:${ref.id}`;

function mergeRefs(...lists: Array<LifecycleRef[] | undefined>): LifecycleRef[] {
  const seen = new Set<string>();
  const out: LifecycleRef[] = [];
  for (const list of lists) {
    for (const ref of list ?? []) {
      if (seen.has(keyOf(ref))) continue;
      seen.add(keyOf(ref));
      out.push(ref);
    }
  }
  return out;
}

function latest(...values: Array<number | undefined>): number | undefined {
  const known = values.filter((value): value is number => typeof value === "number" && value > 0);
  return known.length > 0 ? Math.max(...known) : undefined;
}

/**
 * The Hygiene report: every item that is unused for 60 or 90 days, has no owner (for kinds that
 * run on their own), depends on something missing or retired, or is a rule unused for 90 days
 * that names no failure it prevents. Retired items are left out. An automation with a next
 * scheduled run is judged by that run, so a rarely scheduled job is never "unused".
 */
export function projectHygiene(input: {
  items: HygieneSourceItem[];
  meta: LifecycleMeta[];
  workspaceIds: ReadonlySet<string>;
  now: number;
  /** Also list items with no flag, so their owner or evidence can be set. */
  includeAll?: boolean;
}): HygieneReport {
  const metaByKey = new Map(input.meta.map((meta) => [keyOf(meta), meta]));
  const live = input.items.filter((item) => metaByKey.get(keyOf(item))?.retiredAt === undefined);
  const liveKeys = new Set(live.map(keyOf));

  const items: HygieneItem[] = [];
  for (const item of live) {
    const meta = metaByKey.get(keyOf(item));
    const owner = meta?.owner ?? item.owner;
    const lastUsedAt = latest(item.lastUsedAt, meta?.lastUsedAt);
    const dependsOn = mergeRefs(item.dependsOn, meta?.dependsOn);
    const brokenDependencies = dependsOn.filter((ref) =>
      ref.kind === "workspace" ? !input.workspaceIds.has(ref.id) : !liveKeys.has(keyOf(ref)),
    );
    const scheduled =
      item.kind === "automation" &&
      typeof item.nextRunAt === "number" &&
      item.nextRunAt > input.now;
    const since = latest(lastUsedAt, meta?.keptAt, item.createdAt);
    const idleDays =
      !scheduled && since !== undefined
        ? Math.max(0, Math.floor((input.now - since) / DAY_MS))
        : undefined;

    const flags: HygieneFlag[] = [];
    if (idleDays !== undefined && idleDays >= HYGIENE_UNUSED_RETIRE_DAYS) flags.push("unused_90");
    else if (idleDays !== undefined && idleDays >= HYGIENE_UNUSED_WARN_DAYS)
      flags.push("unused_60");
    if (!owner && OWNER_EXPECTED.has(item.kind)) flags.push("ownerless");
    if (brokenDependencies.length > 0) flags.push("broken_dependency");
    if (
      item.kind === "rule" &&
      !meta?.evidence &&
      idleDays !== undefined &&
      idleDays >= HYGIENE_UNUSED_RETIRE_DAYS
    ) {
      flags.push("rule_without_evidence");
    }
    if (flags.length === 0 && !input.includeAll) continue;

    items.push({
      kind: item.kind,
      id: item.id,
      name: item.name,
      ...(item.workspaceId ? { workspaceId: item.workspaceId } : {}),
      ...(owner ? { owner } : {}),
      ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
      useCount: (item.useCount ?? 0) + (meta?.useCount ?? 0),
      ...(scheduled ? { nextRunAt: item.nextRunAt } : {}),
      ...(idleDays !== undefined ? { idleDays } : {}),
      dependsOn,
      brokenDependencies,
      ...(meta?.protects ? { protects: meta.protects } : {}),
      ...(meta?.evidence ? { evidence: meta.evidence } : {}),
      flags,
    });
  }

  // Broken and long-unused first, then by idle time.
  const weight = (item: HygieneItem) =>
    (item.flags.includes("broken_dependency") ? 4 : 0) +
    (item.flags.includes("unused_90") ? 2 : 0) +
    (item.flags.includes("unused_60") ? 1 : 0);
  items.sort((a, b) => weight(b) - weight(a) || (b.idleDays ?? 0) - (a.idleDays ?? 0));
  return { generatedAt: input.now, items, checked: input.items.length };
}
