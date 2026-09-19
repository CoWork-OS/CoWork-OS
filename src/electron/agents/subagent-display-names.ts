import type { AgentCapability, AgentRole, WorkerRoleKind } from "../../shared/types";
import { WORKER_ROLE_CALLSIGN, type SubagentCallsign } from "../../shared/subagent-presentation";

type SubagentNameInput = {
  role?: Pick<AgentRole, "capabilities" | "displayName" | "name">;
  workerRole?: WorkerRoleKind;
  index: number;
};

const CAPABILITY_CALLSIGN: Array<{
  capabilities: AgentCapability[];
  label: SubagentCallsign;
}> = [
  { capabilities: ["code", "ops"], label: "builder" },
  { capabilities: ["test", "review", "security"], label: "inspector" },
  { capabilities: ["research", "analyze"], label: "explorer" },
  { capabilities: ["plan", "product", "manage"], label: "planner" },
  { capabilities: ["design"], label: "designer" },
  { capabilities: ["write", "document", "communicate", "market"], label: "writer" },
];

const SUBAGENT_NAME_POOL = [
  "Anansi",
  "Apollo",
  "Ares",
  "Arjuna",
  "Arthur",
  "Athena",
  "Atlas",
  "Baldr",
  "Bastet",
  "Beowulf",
  "Brigid",
  "Circe",
  "Diana",
  "Enkidu",
  "Freya",
  "Frigg",
  "Hades",
  "Hector",
  "Hera",
  "Hermes",
  "Horus",
  "Inanna",
  "Ishtar",
  "Janus",
  "Jason",
  "Juno",
  "Kaguya",
  "Karna",
  "Loki",
  "Lugh",
  "Marduk",
  "Mars",
  "Maui",
  "Mazu",
  "Medea",
  "Medusa",
  "Merlin",
  "Nezha",
  "Odin",
  "Ogun",
  "Osiris",
  "Pele",
  "Perun",
  "Rama",
  "Ra",
  "Rostam",
  "Sif",
  "Sigurd",
  "Skadi",
  "Thor",
  "Tiamat",
  "Venus",
  "Veles",
  "Wukong",
  "Yemoja",
  "Zeus",
  "Aeneas",
  "Ariadne",
  "Finn",
  "Gawain",
  "Lancelot",
  "Minerva",
  "Nimue",
  "Odysseus",
  "Orpheus",
  "Raijin",
  "Tristan",
  "Tyr",
  "Vishnu",
];

function deriveRoleLabel(input: SubagentNameInput): SubagentCallsign {
  const capabilities = input.role?.capabilities || [];
  for (const entry of CAPABILITY_CALLSIGN) {
    if (entry.capabilities.some((capability) => capabilities.includes(capability))) {
      return entry.label;
    }
  }
  if (input.workerRole) {
    return WORKER_ROLE_CALLSIGN[input.workerRole];
  }
  return "agent";
}

export function buildSubagentDisplayName(input: SubagentNameInput): string {
  const index = Number.isFinite(input.index) ? Math.max(0, Math.floor(input.index)) : 0;
  const baseName = SUBAGENT_NAME_POOL[index % SUBAGENT_NAME_POOL.length];
  const cycle = Math.floor(index / SUBAGENT_NAME_POOL.length);
  const name = cycle > 0 ? `${baseName} ${cycle + 1}` : baseName;
  return `${name} (${deriveRoleLabel(input)})`;
}
