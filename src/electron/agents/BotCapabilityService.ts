import {
  botCapabilitiesRequestSchema,
  type BotCapabilitySummary,
} from "../../shared/bot-capabilities";
import type { AccessApprovalPolicy } from "../../shared/access-profiles";
import type { BotResponsibility } from "../../shared/bot-responsibility";
import type {
  AgentRole,
  BotWorkPage,
  BotWorkQuery,
  IntegrationMentionOption,
} from "../../shared/types";
import { createLogger } from "../utils/logger";
import {
  buildBotCapabilitySummary,
  type BotCapabilityChannel,
  type BotCapabilityMcpServer,
} from "./bot-capability-summary";

const logger = createLogger("BotCapabilityService");

/** The highest page size the bot work view accepts; enough to find the next scheduled run. */
const SCHEDULED_LIMIT = 100;

export interface BotCapabilityServiceDeps {
  findRole(id: string): AgentRole | undefined | Promise<AgentRole | undefined>;
  workspaceExists(id: string): boolean | Promise<boolean>;
  listBotWork(query: BotWorkQuery): Promise<BotWorkPage>;
  listResponsibilities(scope: {
    workspaceId: string;
    agentRoleId: string;
  }): Promise<BotResponsibility[]>;
  listServices(): Promise<IntegrationMentionOption[]>;
  listChannels(): Promise<BotCapabilityChannel[]>;
  mcpSettings(): { prefix: string; servers: BotCapabilityMcpServer[] };
  memoryCount(botId: string): Promise<{ available: boolean; saved: number }>;
  recallPastChats(): boolean;
  /** The bot's "May do alone" label and the approval policy a chat you start resolves to. */
  access(role: AgentRole): { label: string; approvalInChats: AccessApprovalPolicy | undefined };
  /** Whether runs nobody started by hand use its own desktop's work folder. */
  desktopWorkFolder(role: AgentRole): boolean;
}

/** Read-only: describing a bot starts nothing and changes nothing. */
export class BotCapabilityService {
  constructor(private deps: BotCapabilityServiceDeps) {}

  async describe(raw: unknown): Promise<BotCapabilitySummary> {
    const request = botCapabilitiesRequestSchema.parse(raw);
    const role = await this.deps.findRole(request.agentRoleId);
    if (!role) throw new Error("Bot not found");
    if (!(await this.deps.workspaceExists(request.workspaceId))) {
      throw new Error("Workspace not found");
    }
    const scope = { workspaceId: request.workspaceId, agentRoleId: role.id };
    const [services, channels, page, responsibilities, memory] = await Promise.all([
      this.settle("services", () => this.deps.listServices()),
      this.settle("channels", () => this.deps.listChannels()),
      this.settle("scheduled work", () =>
        this.deps.listBotWork({ ...scope, view: "scheduled", limit: SCHEDULED_LIMIT }),
      ),
      this.settle("responsibilities", () => this.deps.listResponsibilities(scope)),
      this.settle("memory", () => this.deps.memoryCount(role.id)),
    ]);
    const mcp = (await this.settle("connectors", () => this.deps.mcpSettings())) ?? {
      prefix: "mcp_",
      servers: [],
    };
    const access = await this.settle("access", () => this.deps.access(role));
    const recallPastChats = await this.settle("recall", () => this.deps.recallPastChats());
    const desktopWorkFolder = await this.settle("desktop folder", () =>
      this.deps.desktopWorkFolder(role),
    );
    return buildBotCapabilitySummary({
      workspaceId: request.workspaceId,
      role,
      desktopWorkFolder: desktopWorkFolder ?? false,
      mcp,
      services: services && channels !== undefined ? services : undefined,
      channels,
      schedules: page && responsibilities ? { page, responsibilities } : undefined,
      memory,
      recallPastChats,
      access,
    });
  }

  /** One section's read; a failure leaves that section out instead of failing the card. */
  private async settle<T>(label: string, read: () => T | Promise<T>): Promise<T | undefined> {
    try {
      return await read();
    } catch (error) {
      logger.warn(`Could not read ${label} for the bot capability card`, error);
      return undefined;
    }
  }
}
