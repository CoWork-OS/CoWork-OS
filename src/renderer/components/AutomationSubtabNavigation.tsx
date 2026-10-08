import { Box, Clock, Link, ListOrdered, Sparkles, Zap } from "lucide-react";

export type AutomationSettingsSubTab =
  | "routines"
  | "queue"
  | "subconscious"
  | "scheduled"
  | "hooks"
  | "triggers";

export const AUTOMATION_SUBTAB_METHOD_REQUIREMENTS: Record<AutomationSettingsSubTab, string[]> = {
  routines: [
    "listRoutines",
    "listWorkspaces",
    "getRoutineWorkflowCapabilities",
    "createRoutine",
    "updateRoutine",
    "removeRoutine",
    "runRoutineNow",
  ],
  queue: ["getQueueSettings", "saveQueueSettings"],
  subconscious: [
    "getSubconsciousSettings",
    "getSubconsciousBrain",
    "getSubconsciousTargetDetail",
    "saveSubconsciousSettings",
    "runSubconsciousNow",
    "refreshSubconsciousTargets",
    "dismissSubconsciousTarget",
    "resetSubconsciousHistory",
  ],
  scheduled: [
    "getCronStatus",
    "listCronJobs",
    "listWorkspaces",
    "onCronEvent",
    "getCronRunHistory",
    "updateCronJob",
    "removeCronJob",
    "runCronJob",
    "clearCronRunHistory",
    "getGatewayChannels",
    "getGatewayChats",
    "addCronJob",
    "sendGatewayTestMessage",
  ],
  hooks: [
    "getHooksSettings",
    "getHooksStatus",
    "getGmailHooksStatus",
    "enableHooks",
    "disableHooks",
    "regenerateHookToken",
    "configureGmailHooks",
    "saveHooksSettings",
    "startGmailWatcher",
    "stopGmailWatcher",
  ],
  triggers: ["listTriggers", "addTrigger", "updateTrigger", "removeTrigger", "getTriggerHistory"],
};

const AUTOMATION_SUBTABS: Array<{
  key: AutomationSettingsSubTab;
  label: string;
  icon: typeof Box;
}> = [
  { key: "routines", label: "Routines", icon: Box },
  { key: "queue", label: "Task Queue", icon: ListOrdered },
  { key: "subconscious", label: "Workflow Intelligence", icon: Sparkles },
  { key: "scheduled", label: "Scheduled Tasks", icon: Clock },
  { key: "hooks", label: "Webhooks", icon: Link },
  { key: "triggers", label: "Event Triggers", icon: Zap },
];

export interface AutomationSubtabAvailability {
  available: boolean;
  message: string;
}

export function getAutomationSubtabAvailability(
  tab: AutomationSettingsSubTab,
  isBrowserHost: boolean,
  hasMethods: (...methods: string[]) => boolean,
): AutomationSubtabAvailability {
  if (!isBrowserHost || hasMethods(...AUTOMATION_SUBTAB_METHOD_REQUIREMENTS[tab])) {
    return { available: true, message: "" };
  }
  return {
    available: false,
    message: `${AUTOMATION_SUBTABS.find((item) => item.key === tab)!.label} is unavailable on this browser host. Open the desktop app to use it.`,
  };
}

export function getInitialAutomationSubtab(
  requested: string,
  isBrowserHost: boolean,
  hasMethods: (...methods: string[]) => boolean,
): AutomationSettingsSubTab {
  const candidate = AUTOMATION_SUBTABS.find((tab) => tab.key === requested)?.key;
  if (
    candidate &&
    getAutomationSubtabAvailability(candidate, isBrowserHost, hasMethods).available
  ) {
    return candidate;
  }
  if (getAutomationSubtabAvailability("routines", isBrowserHost, hasMethods).available) {
    return "routines";
  }
  return (
    AUTOMATION_SUBTABS.find(
      (tab) => getAutomationSubtabAvailability(tab.key, isBrowserHost, hasMethods).available,
    )?.key ?? "routines"
  );
}

export function AutomationSubtabNavigation({
  activeTab,
  isBrowserHost,
  hasMethods,
  onSelect,
}: {
  activeTab: AutomationSettingsSubTab;
  isBrowserHost: boolean;
  hasMethods: (...methods: string[]) => boolean;
  onSelect: (tab: AutomationSettingsSubTab) => void;
}) {
  const unavailable = AUTOMATION_SUBTABS.filter(
    ({ key }) => !getAutomationSubtabAvailability(key, isBrowserHost, hasMethods).available,
  );

  return (
    <>
      <div className="more-channels-tabs">
        {AUTOMATION_SUBTABS.map(({ key, label, icon: Icon }) => {
          const availability = getAutomationSubtabAvailability(key, isBrowserHost, hasMethods);
          return (
            <button
              key={key}
              type="button"
              className={`more-channels-tab ${activeTab === key ? "active" : ""}`}
              onClick={() => onSelect(key)}
              disabled={!availability.available}
              title={availability.message || undefined}
            >
              <Icon size={16} />
              <span>{label}</span>
            </button>
          );
        })}
      </div>
      {unavailable.length > 0 && (
        <p className="settings-description" role="status">
          On this browser host, these automation sections require the desktop app:{" "}
          {unavailable.map((tab) => tab.label).join(", ")}.
        </p>
      )}
    </>
  );
}
