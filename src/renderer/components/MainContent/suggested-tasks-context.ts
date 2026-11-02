import { createContext } from "react";
import type { TaskProposalsState } from "../../hooks/useTaskProposals";
import type { SuggestedTaskOptionsContext } from "./SuggestedTaskOptionsPopover";

/**
 * What the transcript's suggestion cards read. A context, not row props: transcript rows are
 * cached by their event signature, and a card must still follow its proposals' status.
 */
export interface SuggestedTasksContextValue {
  state: TaskProposalsState;
  optionsContext: SuggestedTaskOptionsContext;
  onOpenTask?: (taskId: string) => void;
}

export const SuggestedTasksContext = createContext<SuggestedTasksContextValue | null>(null);
