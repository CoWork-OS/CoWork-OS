import { serviceRepositoryFacade } from "../database/service-statements";
import type { TeamsConversationReferenceStore } from "./TeamsConversationReferenceStore";
export const TeamsConversationReferenceRepository = serviceRepositoryFacade<
  TeamsConversationReferenceStore,
  "initialize" | "policy" | "put" | "get"
>("teamsReference_", ["initialize", "policy", "put", "get"]);
