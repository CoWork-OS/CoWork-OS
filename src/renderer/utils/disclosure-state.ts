export type DisclosureIntent = "auto" | "expanded" | "collapsed";
export type DisclosureScope = "group" | "activity";

export interface DisclosureIntentState {
  groups: Record<string, DisclosureIntent>;
  activities: Record<string, DisclosureIntent>;
}

export type DisclosureIntentAction =
  | {
      type: "set";
      scope: DisclosureScope;
      id: string;
      intent: DisclosureIntent;
    }
  | {
      type: "toggle";
      scope: DisclosureScope;
      id: string;
      isCurrent?: boolean;
    }
  | { type: "restore"; state: DisclosureIntentState }
  | { type: "reset" };

export const EMPTY_DISCLOSURE_INTENT_STATE: DisclosureIntentState = {
  groups: {},
  activities: {},
};

const MAX_DISCLOSURES_PER_SCOPE = 2_000;

function scopeKey(scope: DisclosureScope): keyof DisclosureIntentState {
  return scope === "group" ? "groups" : "activities";
}

function withBoundedEntry(
  entries: Record<string, DisclosureIntent>,
  id: string,
  intent: DisclosureIntent,
): Record<string, DisclosureIntent> {
  const next = { ...entries };
  delete next[id];
  next[id] = intent;
  const keys = Object.keys(next);
  if (keys.length <= MAX_DISCLOSURES_PER_SCOPE) return next;
  for (const staleId of keys.slice(0, keys.length - MAX_DISCLOSURES_PER_SCOPE)) {
    delete next[staleId];
  }
  return next;
}

export function resolveDisclosureExpanded(args: {
  intent?: DisclosureIntent;
  isCurrent?: boolean;
}): boolean {
  if (args.intent === "expanded") return true;
  if (args.intent === "collapsed") return false;
  return args.isCurrent === true;
}

export function disclosureIntentReducer(
  state: DisclosureIntentState,
  action: DisclosureIntentAction,
): DisclosureIntentState {
  if (action.type === "reset") return EMPTY_DISCLOSURE_INTENT_STATE;
  if (action.type === "restore") {
    return {
      groups: { ...action.state.groups },
      activities: { ...action.state.activities },
    };
  }

  const key = scopeKey(action.scope);
  const currentIntent = state[key][action.id] ?? "auto";
  const nextIntent =
    action.type === "set"
      ? action.intent
      : resolveDisclosureExpanded({ intent: currentIntent, isCurrent: action.isCurrent })
        ? "collapsed"
        : "expanded";
  return {
    ...state,
    [key]: withBoundedEntry(state[key], action.id, nextIntent),
  };
}

export function getDisclosureIntent(
  state: DisclosureIntentState,
  scope: DisclosureScope,
  id: string,
): DisclosureIntent {
  return state[scopeKey(scope)][id] ?? "auto";
}
